import { watch } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { build, project } from "./build.mjs";
import { createHandler } from "./server.mjs";

let handler;
let version;
let css = await readFile(resolve(project, "src/global.css"), "utf8");
const listeners = new Set();
let sourceFiles;
let failed = false;
const publish = (message) => {
  for (const send of listeners) send(message);
};
async function rebuild() {
  css = await readFile(resolve(project, "src/global.css"), "utf8");
  let result;
  try {
    result = await build({ development: true });
  } catch (error) {
    failed = true;
    throw error;
  }
  handler = await createHandler(result.outdir, { compress: false });
  version = result.version;
  sourceFiles = new Set(await readdir(resolve(project, "src"), { recursive: true }));
  failed = false;
  publish({ version });
  console.log("Rebuilt. Connected browsers will reload.");
}
await rebuild();
const server = Bun.serve({
  hostname: process.env.HOST ?? "0.0.0.0",
  port: Number(process.env.PORT ?? 5173),
  idleTimeout: 0,
  fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/__dev_style.css")
      return new Response(css, {
        headers: { "Content-Type": "text/css", "Cache-Control": "no-store" },
      });
    if (path !== "/__dev_events") return handler(request);
    let send;
    return new Response(
      new ReadableStream({
        start(controller) {
          send = (message) =>
            controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(message)}\n\n`));
          listeners.add(send);
          send({ version, css });
        },
        cancel() {
          listeners.delete(send);
        },
      }),
      { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-store" } },
    );
  },
});
let pending = Promise.resolve();
let timer;
function scheduleRebuild() {
  clearTimeout(timer);
  timer = setTimeout(() => {
    pending = pending.then(rebuild).catch(console.error);
  }, 1);
}
watch(resolve(project, "src"), { recursive: true }, (_event, filename) => {
  // Atomic-save temporary files are not inputs to the current build.
  if (!sourceFiles.has(filename) && !failed) return;
  if (filename !== "global.css") return scheduleRebuild();
  pending = pending
    .then(async () => {
      css = await readFile(resolve(project, "src/global.css"), "utf8");
      publish({ css });
    })
    .catch(console.error);
});
watch(resolve(project, "public"), { recursive: true }, scheduleRebuild);
// Watch the parent so atomic-save editors can replace the HTML file's inode.
watch(project, (_event, filename) => {
  if (filename === "index.html") scheduleRebuild();
});

// Readiness includes the watchers: editors may save immediately after startup.
console.log(`Development server on port ${server.port}`);
