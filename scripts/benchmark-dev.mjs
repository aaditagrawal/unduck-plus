// External fixtures and Playwright keep baseline packages out of the application.
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { cp, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { once } from "node:events";
const [baseline, candidate, playwright] = process.argv.slice(2);
if (!playwright)
  throw Error("Pass baseline root, candidate root and external Playwright module path");
const { chromium } = createRequire(import.meta.url)(resolve(playwright));
const directory = await mkdtemp(resolve(tmpdir(), "searchlock-dev-bench-"));
const roots = {
  baseline: resolve(directory, "baseline"),
  candidate: resolve(directory, "candidate"),
};
const children = new Set();
let browser;
async function stopChild(child) {
  if (child.exitCode === null && child.signalCode === null) {
    const exited = once(child, "exit");
    child.kill("SIGKILL");
    await exited;
  }
  children.delete(child);
}
async function cleanup() {
  await browser?.close();
  await Promise.all([...children].map(stopChild));
  await rm(directory, { recursive: true, force: true });
}
for (const signal of ["SIGINT", "SIGTERM"])
  process.once(signal, async () => {
    await cleanup();
    process.exit(130);
  });
const summarize = (values) => {
  const sorted = values.toSorted((a, b) => a - b);
  return {
    median: sorted[Math.floor(sorted.length / 2)],
    min: sorted[0],
    max: sorted.at(-1),
    samples: values.length,
  };
};
try {
  for (const name of ["baseline", "candidate"]) {
    const source = name === "baseline" ? baseline : candidate;
    for (const file of [
      "src",
      "public",
      "index.html",
      "package.json",
      "tsconfig.json",
      name === "baseline" ? "vite.config.ts" : "scripts",
    ])
      await cp(resolve(source, file), resolve(roots[name], file), { recursive: true });
    if (name === "baseline")
      await symlink(resolve(baseline, "node_modules"), resolve(roots[name], "node_modules"), "dir");
  }
  browser = await chromium.launch({
    executablePath: process.env.CHROME ?? "/usr/bin/google-chrome",
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  const results = {
    baseline: { startup: [], css: [], cssAtomic: [], html: [] },
    candidate: { startup: [], css: [], cssAtomic: [], html: [] },
  };
  const rounds = Number(process.env.ROUNDS ?? 5);
  for (let round = -1; round < rounds; round++)
    for (const name of round % 2 ? ["candidate", "baseline"] : ["baseline", "candidate"]) {
      const socket = createServer();
      socket.listen(0, "127.0.0.1");
      await once(socket, "listening");
      const port = socket.address().port;
      await new Promise((done) => socket.close(done));
      const root = roots[name];
      const args =
        name === "baseline"
          ? [
              "node",
              resolve(root, "node_modules/vite/bin/vite.js"),
              "--host",
              "127.0.0.1",
              "--port",
              String(port),
              "--strictPort",
            ]
          : [process.env.BUN ?? "bun", "scripts/dev.mjs"];
      const started = performance.now();
      const child = spawn(args[0], args.slice(1), {
        cwd: root,
        env: { ...process.env, PORT: String(port), HOST: "127.0.0.1" },
        stdio: ["ignore", "ignore", "pipe"],
      });
      children.add(child);
      let errors = "";
      child.stderr.on("data", (chunk) => (errors += chunk));
      const url = `http://127.0.0.1:${port}`;
      const context = await browser.newContext();
      try {
        let ready = false;
        for (let attempt = 0; attempt < 1000; attempt++) {
          try {
            const response = await fetch(url);
            await response.arrayBuffer();
            if (response.ok) {
              ready = true;
              break;
            }
          } catch {}
          await new Promise((done) => setTimeout(done, 5));
        }
        if (!ready) throw Error(`Dev server failed: ${name} ${errors}`);
        const page = await context.newPage();
        await page.goto(url);
        await page.waitForFunction(
          () => document.querySelector("h1") && document.styleSheets.length > 0,
        );
        const startup = performance.now() - started;
        await page.locator("input").focus();
        await page.evaluate(() => (window.devFocusToken = "preserved"));
        const cssPath = resolve(root, "src/global.css");
        const css = await readFile(cssPath, "utf8");
        const cssTimes = {};
        for (const atomic of [false, true]) {
          // Let the preceding watcher/HMR event batch drain between editor saves.
          // This wait is outside edit-to-applied timing and identical for both servers.
          if (atomic) await new Promise((done) => setTimeout(done, 100));
          const color = `rgb(${round + (atomic ? 121 : 21)}, 37, 53)`;
          await page.evaluate((expected) => {
            window.cssApplied = new Promise((done) => {
              const check = () => {
                if (getComputedStyle(document.body).color === expected) {
                  observer.disconnect();
                  document.head.removeEventListener("load", check, true);
                  done();
                }
              };
              const observer = new MutationObserver(check);
              document.head.addEventListener("load", check, true);
              observer.observe(document.head, {
                subtree: true,
                childList: true,
                characterData: true,
                attributes: true,
              });
            });
          }, color);
          console.error(`Dev round ${round}: ${name} CSS ${atomic ? "atomic" : "plain"} starting`);
          const cssStarted = performance.now();
          await writeFile(
            atomic ? resolve(root, "src/next.css") : cssPath,
            css + `\nbody { color: ${color}; }\n`,
          );
          if (atomic) await rename(resolve(root, "src/next.css"), cssPath);
          await Promise.race([
            page.evaluate(() => window.cssApplied),
            new Promise((_, reject) => {
              const timer = setTimeout(
                () =>
                  reject(
                    Error(`CSS update timed out: round=${round} variant=${name} atomic=${atomic}`),
                  ),
                10000,
              );
              timer.unref();
            }),
          ]);
          cssTimes[atomic ? "cssAtomic" : "css"] = performance.now() - cssStarted;
          if (
            !(await page.evaluate(
              () => window.devFocusToken === "preserved" && document.activeElement.matches("input"),
            ))
          )
            throw Error("CSS update lost page state or focus");
        }
        const htmlPath = resolve(root, "index.html");
        const html = await readFile(htmlPath, "utf8");
        const title = `Dev benchmark ${round}`;
        const htmlStarted = performance.now();
        await writeFile(htmlPath, html.replace(/<title>.*?<\/title>/, `<title>${title}</title>`));
        await page.waitForFunction((expected) => document.title === expected, title);
        const htmlElapsed = performance.now() - htmlStarted;
        if (round >= 0) {
          results[name].startup.push(startup);
          for (const key of ["css", "cssAtomic"]) results[name][key].push(cssTimes[key]);
          results[name].html.push(htmlElapsed);
        }
        // Restore fixture content before the next server launch, without timing cleanup.
        await context.close();
        await stopChild(child);
        await writeFile(cssPath, css);
        await writeFile(htmlPath, html);
        console.error(`Dev round ${round}: ${name} complete`);
      } finally {
        await context.close();
        if (children.has(child)) await stopChild(child);
      }
    }
  console.log(
    JSON.stringify(
      {
        environment: { node: process.version, chromium: browser.version() },
        methodology:
          "Fresh dev processes, same Chromium, one warmup, alternating rounds; process-to-styled-homepage and edit-to-applied-CSS/reloaded-HTML milliseconds. CSS updates assert focus and page state survive.",
        results,
        summary: Object.fromEntries(
          Object.entries(results).map(([name, work]) => [
            name,
            Object.fromEntries(
              Object.entries(work).map(([key, values]) => [key, summarize(values)]),
            ),
          ]),
        ),
      },
      null,
      2,
    ),
  );
} finally {
  await cleanup();
}
