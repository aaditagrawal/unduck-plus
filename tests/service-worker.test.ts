import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const source = readFileSync(new URL("../scripts/service-worker.js", import.meta.url), "utf8");
const origin = "https://search.test/";

type WorkerEvent = {
  request?: { method: string; mode: string; url: string };
  data?: { type: string; version: string };
  source?: { id: string };
  waitUntil: (promise: Promise<void>) => void;
  respondWith: (promise: Promise<Response>) => void;
};
const key = (request: string | Request) => (typeof request === "string" ? request : request.url);

function worker(failInstall = false) {
  const handlers = new Map<string, (event: WorkerEvent) => void>();
  const stores = new Map<string, Map<string, Response>>();
  let clients = [{ id: "old-tab", url: origin }];
  let skipped = false;
  let claimed = false;
  let network = 0;
  const caches = {
    keys: async () => [...stores.keys()],
    delete: async (name: string) => stores.delete(name),
    open: async (name: string) => {
      if (!stores.has(name)) stores.set(name, new Map());
      const store = stores.get(name)!;
      return {
        addAll: async (requests: Request[]) => {
          if (failInstall) throw new Error("network interrupted");
          for (const request of requests) store.set(key(request), new Response(key(request)));
        },
        match: async (request: Request | string) => store.get(key(request))?.clone(),
      };
    },
  };
  class WorkerRequest extends Request {
    constructor(url: string, init?: RequestInit) {
      super(new URL(url, origin), init);
    }
  }
  runInNewContext(
    `const VERSION = "new"; const PRECACHE = ["/index.html", "/main-new.js"];\n${source}`,
    {
      Request: WorkerRequest,
      URL,
      caches,
      fetch: async () => {
        network++;
        return new Response("network");
      },
      self: {
        registration: { scope: origin },
        addEventListener: (name: string, handler: (event: WorkerEvent) => void) =>
          handlers.set(name, handler),
        skipWaiting: async () => {
          skipped = true;
        },
        clients: {
          matchAll: async () => clients,
          claim: async () => {
            claimed = true;
          },
        },
      },
    },
  );
  const dispatch = (name: string, data: Partial<WorkerEvent> = {}) => {
    let promise: Promise<Response | void> | undefined;
    handlers.get(name)!({
      ...data,
      waitUntil: (value: Promise<void>) => {
        promise = value;
      },
      respondWith: (value: Promise<Response>) => {
        promise = value;
      },
    });
    return promise;
  };
  return {
    stores,
    dispatch,
    clients: (value: typeof clients) => {
      clients = value;
    },
    skipped: () => skipped,
    claimed: () => claimed,
    network: () => network,
  };
}

describe("offline worker", () => {
  test("only activates after the complete app is cached", async () => {
    const app = worker();
    await app.dispatch("install");
    expect(app.skipped()).toBe(true);
    expect(app.stores.get("searchlock-new")?.size).toBe(2);
    await app.dispatch("activate");
    expect(app.claimed()).toBe(true);
  });

  test("failed installs remove the partial cache and preserve the active release", async () => {
    const app = worker(true);
    app.stores.set("searchlock-old", new Map());
    await expect(app.dispatch("install")).rejects.toThrow("network interrupted");
    expect(app.stores.has("searchlock-new")).toBe(false);
    expect(app.stores.has("searchlock-old")).toBe(true);
    expect(app.skipped()).toBe(false);
  });

  test("offline navigation ignores search queries and old tabs can fetch their chunks", async () => {
    const app = worker();
    await app.dispatch("install");
    app.stores.set(
      "searchlock-old",
      new Map([[`${origin}old-chunk.js`, new Response("old chunk")]]),
    );
    const navigation = await app.dispatch("fetch", {
      request: { method: "GET", mode: "navigate", url: `${origin}?q=cats` },
    });
    if (!(navigation instanceof Response)) throw new Error("Expected cached navigation");
    expect(await navigation.text()).toBe(`${origin}index.html`);
    const chunk = await app.dispatch("fetch", { request: new Request(`${origin}old-chunk.js`) });
    if (!(chunk instanceof Response)) throw new Error("Expected cached chunk");
    expect(await chunk.text()).toBe("old chunk");
    expect(app.network()).toBe(0);
    expect(app.dispatch("fetch", { request: new Request("https://other.test/") })).toBeUndefined();
  });

  test("cleanup waits for old tabs, migrates Workbox and leaves other apps alone", async () => {
    const app = worker();
    for (const name of [
      "searchlock-old",
      `workbox-precache-v2-${origin}`,
      "unrelated",
      "workbox-precache-v2-https://search.test/other/",
    ])
      app.stores.set(name, new Map());
    await app.dispatch("install");
    await app.dispatch("activate");
    expect(app.stores.has("searchlock-old")).toBe(true);
    app.clients([{ id: "new-tab", url: origin }]);
    await app.dispatch("message", {
      source: { id: "new-tab" },
      data: { type: "CLIENT_VERSION", version: "new" },
    });
    expect(app.stores.has("searchlock-old")).toBe(false);
    expect(app.stores.has(`workbox-precache-v2-${origin}`)).toBe(false);
    expect(app.stores.has("unrelated")).toBe(true);
    expect(app.stores.has("workbox-precache-v2-https://search.test/other/")).toBe(true);
    expect(app.stores.has("searchlock-new")).toBe(true);
  });
});
