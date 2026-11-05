// Node-targeted Playwright tooling, supplied externally instead of adding an app dependency.
// node scripts/benchmark-browser.mjs BASELINE_DIST CANDIDATE_DIST PLAYWRIGHT_MODULE
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { readFile, readdir, stat } from "node:fs/promises";
import { extname, resolve } from "node:path";

const [baselineDirectory, candidateDirectory, playwrightModule] = process.argv.slice(2);
if (!baselineDirectory || !candidateDirectory || !playwrightModule)
  throw new Error("Pass baseline dist, candidate dist and an installed Playwright module path.");
const { chromium } = createRequire(import.meta.url)(resolve(playwrightModule));
const types = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".webmanifest": "application/manifest+json",
};
async function snapshot(directory) {
  const files = new Map();
  await Promise.all(
    (await readdir(directory, { recursive: true })).map(async (name) => {
      const path = resolve(directory, name);
      if ((await stat(path)).isFile())
        files.set(`/${name}`, {
          body: await readFile(path),
          type: types[extname(name)] ?? "application/octet-stream",
        });
    }),
  );
  return files;
}
const outputs = {
  baseline: await snapshot(baselineDirectory),
  candidate: await snapshot(candidateDirectory),
};
let active = "baseline";
const server = createServer({ maxHeaderSize: 65536 }, (request, response) => {
  const path = new URL(request.url, "http://localhost").pathname;
  const file = outputs[active].get(path === "/" ? "/index.html" : path);
  response.writeHead(file ? 200 : 404, {
    "Content-Type": file?.type ?? "text/plain",
    "Cache-Control": "no-cache",
  });
  response.end(file?.body);
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const origin = `http://127.0.0.1:${server.address().port}`;
let browser;
const stop = async () => {
  await browser?.close();
  server.close();
  process.exit(130);
};
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
browser = await chromium.launch({
  executablePath: process.env.CHROME ?? "/usr/bin/google-chrome",
  headless: true,
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});
const timings = { baseline: [], candidate: [] };
const checks = [];
const controlled = (page) =>
  page.evaluate(async () => {
    await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller)
      await new Promise((done) =>
        navigator.serviceWorker.addEventListener("controllerchange", done, { once: true }),
      );
  });
const homepageReady = (page) =>
  page.waitForFunction(() => document.querySelector("h1") && document.styleSheets.length > 0);
try {
  // One discarded warmup, then five paired rounds, alternating order.
  for (let round = -1; round < Number(process.env.ROUNDS ?? 5); round++) {
    for (const name of round % 2 ? ["candidate", "baseline"] : ["baseline", "candidate"]) {
      active = name;
      const context = await browser.newContext();
      const page = await context.newPage();
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(origin);
      await homepageReady(page);
      const homepage = await page.evaluate(() => performance.now());
      await controlled(page);
      const install = await page.evaluate(() => performance.now());
      await context.setOffline(true);
      await page.reload();
      await homepageReady(page);
      const offline = await page.evaluate(() => performance.now());
      const cacheFetch = await page.evaluate(async () => {
        const started = performance.now();
        for (let i = 0; i < 40; i++) await (await fetch("/clipboard.svg")).arrayBuffer();
        return (performance.now() - started) / 40;
      });
      if (errors.length) throw new Error(`${name}: ${errors.join(", ")}`);
      if (round >= 0) timings[name].push({ homepage, install, offline, cacheFetch });
      await context.close();
      console.error(`Browser round ${round}: ${name} complete`);
    }
  }
  checks.push(
    "Fresh installs, styled lazy homepage, complete offline reloads and cached icon fetches passed for both outputs.",
  );
  // Measure actual emitted redirect code in fresh contexts, with external services intercepted.
  const redirects = { baseline: [], candidate: [] };
  for (let round = 0; round < 5; round++)
    for (const name of round % 2 ? ["candidate", "baseline"] : ["baseline", "candidate"]) {
      active = name;
      const context = await browser.newContext({ serviceWorkers: "block" });
      await context.route("https://google.com/**", (route) =>
        route.fulfill({
          status: 200,
          contentType: "text/html",
          body: "<title>destination</title>",
        }),
      );
      for (const query of ["cats", "path/to/item & café", "猫/".repeat(2048)]) {
        const page = await context.newPage();
        const requests = [];
        page.on("request", (request) => requests.push(request.url()));
        const started = performance.now();
        await page.goto(`${origin}/?q=${encodeURIComponent(query)}`);
        await page.waitForURL(
          `https://google.com/search?q=${encodeURIComponent(query).replace(/%2F/g, "/")}`,
        );
        redirects[name].push({ queryLength: query.length, duration: performance.now() - started });
        if (requests.some((url) => /(?:page-|chunk-|\.css)/.test(url)))
          throw new Error("Redirect fetched homepage assets");
        await page.close();
      }
      await context.close();
      console.error(`Redirect round ${round}: ${name} complete`);
    }
  checks.push(
    "Emitted redirects preserved Unicode, slash encoding and long queries without fetching homepage/CSS assets.",
  );
  active = "baseline";
  const context = await browser.newContext();
  const old = await context.newPage();
  await old.goto(origin);
  await controlled(old);
  const oldCaches = await old.evaluate(() => caches.keys());
  active = "candidate";
  await old.evaluate(async () => {
    const registration = await navigator.serviceWorker.getRegistration();
    await registration.update();
    if (registration.installing)
      await new Promise((done, reject) => {
        const worker = registration.installing;
        worker.addEventListener("statechange", () => {
          if (worker.state === "activated") done();
          if (worker.state === "redundant") reject(new Error("Update failed"));
        });
      });
  });
  const during = await old.evaluate(() => caches.keys());
  if (!oldCaches.every((name) => during.includes(name)))
    throw new Error("Deleted Workbox caches while old tab remained");
  const current = await context.newPage();
  await current.goto(origin);
  await homepageReady(current);
  const oldChunk = [...outputs.baseline.keys()].find((name) => /\/page-.*\.js$/.test(name));
  await context.setOffline(true);
  if (
    !oldChunk ||
    (await old.evaluate(async (path) => (await fetch(path)).status, oldChunk)) !== 200
  )
    throw new Error("Old hashed lazy chunk unavailable offline after migration");
  await old.close();
  await current.reload();
  await homepageReady(current);
  await current.waitForFunction(
    async () => !(await caches.keys()).some((name) => name.startsWith("workbox-precache-")),
  );
  await context.close();
  checks.push(
    "Workbox migration retained old tabs and hashed chunks offline, then cleaned old caches after the old tab closed and the current page reloaded.",
  );
  const summarize = (values) => {
    const sorted = values.toSorted((a, b) => a - b);
    return {
      median: sorted[Math.floor(sorted.length / 2)],
      min: sorted[0],
      max: sorted.at(-1),
      samples: sorted.length,
    };
  };
  const summary = {};
  for (const name of ["baseline", "candidate"]) {
    summary[name] = Object.fromEntries(
      ["homepage", "install", "offline", "cacheFetch"].map((key) => [
        key,
        summarize(timings[name].map((sample) => sample[key])),
      ]),
    );
    summary[name].redirects = Object.fromEntries(
      [4, 19, 4096].map((length) => [
        length,
        summarize(
          redirects[name]
            .filter((sample) => sample.queryLength === length)
            .map((sample) => sample.duration),
        ),
      ]),
    );
  }
  console.log(
    JSON.stringify(
      {
        environment: {
          node: process.version,
          chromium: browser.version(),
          platform: process.platform,
          arch: process.arch,
        },
        methodology:
          "Same Node static snapshot server, fresh Chromium contexts, discarded warmup and alternating rounds; milliseconds; no destination network. HTTP/server performance measured separately.",
        checks,
        summary,
        timings,
        redirects,
      },
      null,
      2,
    ),
  );
} finally {
  await browser.close();
  server.close();
}
