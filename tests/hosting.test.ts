import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { brotliDecompressSync, inflateSync } from "node:zlib";
import { build } from "../scripts/build.mjs";
import { createHandler } from "../scripts/server.mjs";

const directory = await mkdtemp(resolve(tmpdir(), "searchlock-test-"));
const result = await build({ outdir: directory });
const handler = await createHandler(directory);
afterAll(() => rm(directory, { recursive: true, force: true }));
const request = (path: string, init?: RequestInit) =>
  handler(new Request(`http://localhost${path}`, init));

describe("owned build", () => {
  test("emits hashed modules, a JSON.parse catalogue, deferred CSS and full precache", async () => {
    const html = await readFile(resolve(directory, "index.html"), "utf8");
    const entry = await readFile(result.entry, "utf8");
    expect(entry).toContain("JSON.parse(");
    expect(entry).toContain("import(");
    expect(entry).not.toContain("style.href");
    expect(html).not.toContain("stylesheet");
    expect(html).not.toContain("/src/");
    expect(html).toContain("manifest.webmanifest");
    const worker = await readFile(resolve(directory, "sw.js"), "utf8");
    for (const file of result.files.filter((name) => name !== "sw.js"))
      expect(worker).toContain(`/${file}`);
    expect(worker).not.toContain("importScripts");
    expect(worker).not.toContain("workbox.core");
  });

  test("repeated builds produce the same release and file references", async () => {
    const second = await mkdtemp(resolve(tmpdir(), "searchlock-repeat-"));
    try {
      expect((await build({ outdir: second })).version).toBe(result.version);
    } finally {
      await rm(second, { recursive: true, force: true });
    }
  });
});

describe("static HTTP contract", () => {
  test("serves HTML query navigation and extensionless SPA routes", async () => {
    for (const path of ["/", "/?q=cats", "/nested/route?q=cats"]) {
      const response = request(path);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("text/html");
      expect(await response.text()).toContain("SearchLock");
    }
    expect(request("/missing.js").status).toBe(404);
    expect(request("/nested.html", { headers: { "sec-fetch-mode": "navigate" } }).status).toBe(200);
    expect(request("/asset-map.json").status).toBe(404);
    expect(request("/", { method: "POST" }).status).toBe(405);
  });

  test("HEAD, validators and gzip preserve representations", async () => {
    const response = request("/index.html");
    const text = await response.text();
    const head = request("/index.html", { method: "HEAD" });
    expect(await head.text()).toBe("");
    expect(head.headers.get("content-length")).toBe(String(Buffer.byteLength(text)));
    for (const headers of [
      { "if-none-match": response.headers.get("etag")! },
      { "if-modified-since": response.headers.get("last-modified")! },
    ])
      expect(request("/index.html", { headers }).status).toBe(304);
    const compressed = request("/index.html", { headers: { "accept-encoding": "gzip" } });
    expect(compressed.headers.get("content-encoding")).toBe("gzip");
    expect(compressed.headers.get("etag")).not.toBe(response.headers.get("etag"));
    expect(
      request("/index.html", {
        headers: { "accept-encoding": "gzip", "if-none-match": compressed.headers.get("etag")! },
      }).status,
    ).toBe(304);
    expect(new TextDecoder().decode(Bun.gunzipSync(await compressed.arrayBuffer()))).toBe(text);
    expect(
      request("/index.html", { headers: { "accept-encoding": "gzip;q=0" } }).headers.has(
        "content-encoding",
      ),
    ).toBe(false);
  });

  test("Brotli and deflate preserve bytes and honor encoding preferences", async () => {
    const original = await request("/index.html").text();
    for (const [encoding, decode] of [
      ["br", brotliDecompressSync],
      ["deflate", inflateSync],
    ] as const) {
      const response = request("/index.html", { headers: { "accept-encoding": encoding } });
      expect(response.headers.get("content-encoding")).toBe(encoding);
      expect(decode(Buffer.from(await response.arrayBuffer())).toString()).toBe(original);
    }
    for (const [accept, expected] of [
      ["br, gzip, deflate", "br"],
      ["br;q=0, gzip;q=0.5", "gzip"],
      ["gzip;q=0, *;q=0.5", "br"],
      ["gzip;q=0.5, identity;q=1", null],
    ])
      expect(
        request("/index.html", { headers: { "accept-encoding": accept! } }).headers.get(
          "content-encoding",
        ),
      ).toBe(expected);
  });

  test("ranges and If-Range honor byte boundaries", async () => {
    const text = await request("/index.html").text();
    const range = request("/index.html", { headers: { range: "bytes=0-9" } });
    expect(range.status).toBe(206);
    expect(await range.text()).toBe(text.slice(0, 10));
    expect(await request("/index.html", { headers: { range: "bytes=-8" } }).text()).toBe(
      text.slice(-8),
    );
    expect(request("/index.html", { headers: { range: "bytes=99999999-" } }).status).toBe(416);
    expect(
      request("/index.html", { headers: { range: "bytes=0-1", "if-range": '"old"' } }).status,
    ).toBe(200);
  });

  test("malformed paths and traversal cannot expose unlisted files", async () => {
    for (const path of ["/%ZZ", "/%2e%2e%2fpackage.json", "/%00", "/foo%5cbar"])
      expect(request(path).status).toBe(400);
    await writeFile(resolve(directory, "private.txt"), "secret");
    expect(request("/private.txt").status).toBe(404);
    const outside = await mkdtemp(resolve(tmpdir(), "searchlock-outside-"));
    try {
      await writeFile(resolve(outside, "secret"), "secret");
      await symlink(resolve(outside, "secret"), resolve(directory, "escape"));
      await writeFile(resolve(directory, "asset-map.json"), '["escape"]');
      await expect(createHandler(directory)).rejects.toThrow("outside build directory");
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});
