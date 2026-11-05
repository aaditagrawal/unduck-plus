import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const project = fileURLToPath(new URL("../", import.meta.url));
const digest = (content) => createHash("sha256").update(content).digest("hex").slice(0, 16);

export async function build({ outdir = resolve(project, "dist"), development = false } = {}) {
  outdir = resolve(outdir);
  await rm(outdir, { recursive: true, force: true });
  await mkdir(resolve(outdir, "assets"), { recursive: true });
  const css = await readFile(resolve(project, "src/global.css"));
  const cssPath = development ? "__dev_style.css" : `assets/global-${digest(css)}.css`;
  await writeFile(resolve(outdir, cssPath), css);
  const result = await Bun.build({
    entrypoints: [resolve(project, "src/main.ts")],
    outdir,
    target: "browser",
    format: "esm",
    splitting: true,
    minify: !development,
    define: { stylesheetPath: JSON.stringify(`/${cssPath}`) },
    naming: "assets/[name]-[hash].[ext]",
    plugins: [
      {
        name: "app-assets",
        setup(builder) {
          builder.onLoad({ filter: /bangs\.json$/ }, async ({ path }) => ({
            contents: `export default JSON.parse(${JSON.stringify(await readFile(path, "utf8"))});`,
            loader: "js",
          }));
          builder.onLoad({ filter: /global\.css$/ }, () => ({
            contents: `const style = document.createElement("link"); style.rel = "stylesheet"; style.href = "/${cssPath}"; await new Promise((resolve, reject) => { style.onload = resolve; style.onerror = reject; document.head.append(style); });`,
            loader: "js",
          }));
        },
      },
    ],
  });
  if (!result.success) throw new AggregateError(result.logs, "Client build failed");
  const entry = result.outputs.find((output) => output.kind === "entry-point");
  if (!entry) throw new Error("Missing client entrypoint");
  const outputName = (path) => relative(outdir, path).replaceAll("\\", "/");
  const files = [...result.outputs.map((output) => outputName(output.path)), cssPath];
  await Promise.all(
    (await readdir(resolve(project, "public"))).map(async (name) => {
      await writeFile(resolve(outdir, name), await readFile(resolve(project, "public", name)));
      files.push(name);
    }),
  );
  await writeFile(
    resolve(outdir, "manifest.webmanifest"),
    JSON.stringify({
      name: "SearchLock",
      short_name: "SearchLock",
      description: "A better default search engine (with bangs, and better defaults!)",
      start_url: "/",
      display: "standalone",
      background_color: "#131313",
      theme_color: "#131313",
      icons: [{ src: "/search.svg", sizes: "any", type: "image/svg+xml", purpose: "any" }],
    }),
  );
  files.push("manifest.webmanifest");
  const template = await readFile(resolve(project, "index.html"), "utf8");
  files.sort();
  const worker = await readFile(resolve(project, "scripts/service-worker.js"), "utf8");
  const buildSource = await readFile(fileURLToPath(import.meta.url));
  const version = digest(
    Buffer.concat([
      Buffer.from(template),
      Buffer.from(worker),
      buildSource,
      Buffer.from(JSON.stringify(files)),
      ...(await Promise.all(files.map((name) => readFile(resolve(outdir, name))))),
    ]),
  );
  const registration = development
    ? `<script data-version="${version}">${await readFile(resolve(project, "scripts/dev-client.js"), "utf8")}</script>`
    : `<script>if ('serviceWorker' in navigator) { const report = () => navigator.serviceWorker.controller?.postMessage({type:'CLIENT_VERSION',version:'${version}'}); navigator.serviceWorker.addEventListener('controllerchange',report); window.addEventListener('load', () => { navigator.serviceWorker.register('/sw.js').then(() => navigator.serviceWorker.ready).then(report).catch(console.error); }); }</script>`;
  const html = template
    .replace("/src/main.ts", `/${outputName(entry.path)}`)
    .replace("</head>", '<link rel="manifest" href="/manifest.webmanifest" /></head>')
    .replace("</body>", `${registration}</body>`);
  await writeFile(resolve(outdir, "index.html"), html);
  files.push("index.html");
  await writeFile(
    resolve(outdir, "sw.js"),
    `const VERSION = ${JSON.stringify(version)};\nconst PRECACHE = ${JSON.stringify(files.map((name) => `/${name}`))};\n${worker}`,
  );
  files.push("sw.js");
  await writeFile(resolve(outdir, "asset-map.json"), JSON.stringify(files));
  return { outdir, files, version, entry: entry.path };
}

if (import.meta.main) {
  await build();
  console.log("Built dist with Bun and the offline worker.");
}
