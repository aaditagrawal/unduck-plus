import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { brotliCompressSync, constants, deflateSync, gzipSync } from "node:zlib";

const types = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".webmanifest": "application/manifest+json",
};

function encodingFor(header, asset) {
  const qualities = new Map();
  for (const part of (header ?? "").split(",")) {
    const [name, parameter] = part
      .trim()
      .toLowerCase()
      .split(/\s*;\s*/);
    const quality =
      parameter === undefined
        ? 1
        : /^q=(?:0(?:\.\d+)?|1(?:\.0+)?)$/.test(parameter)
          ? Number(parameter.slice(2))
          : 0;
    qualities.set(name, quality);
  }
  return Object.keys(asset.encoded)
    .map((name) => ({ name, quality: qualities.get(name) ?? qualities.get("*") ?? 0 }))
    .sort((a, b) => b.quality - a.quality)
    .find(
      ({ name, quality }) =>
        quality > 0 &&
        quality >= (qualities.get("identity") ?? 0) &&
        asset.encoded[name].length < asset.body.length,
    )?.name;
}

// Read only build-listed files into an immutable snapshot. Requests never open paths.
export async function createHandler(directory, { compress = true } = {}) {
  const root = await realpath(directory);
  const assets = new Map();
  await Promise.all(
    JSON.parse(await readFile(resolve(root, "asset-map.json"), "utf8")).map(async (name) => {
      const path = await realpath(resolve(root, name));
      if (!path.startsWith(`${root}${sep}`))
        throw new Error(`Asset outside build directory: ${name}`);
      const [body, info] = await Promise.all([readFile(path), stat(path)]);
      const modified = new Date(Math.floor(info.mtimeMs / 1000) * 1000);
      assets.set(`/${name}`, {
        body,
        encoded: compress
          ? {
              br: brotliCompressSync(body, { params: { [constants.BROTLI_PARAM_QUALITY]: 4 } }),
              gzip: gzipSync(body),
              deflate: deflateSync(body),
            }
          : {},
        modified,
        etag: `"${createHash("sha256").update(body).digest("hex")}"`,
        type: types[extname(name)] ?? "application/octet-stream",
      });
    }),
  );
  return (request) => {
    if (request.method !== "GET" && request.method !== "HEAD")
      return new Response(null, { status: 405, headers: { Allow: "GET, HEAD" } });
    let path;
    try {
      path = decodeURIComponent(new URL(request.url).pathname);
    } catch {
      return new Response(null, { status: 400 });
    }
    if (path.includes("\\") || path.includes("\0") || path.split("/").includes(".."))
      return new Response(null, { status: 400 });
    if (path === "/asset-map.json") return new Response(null, { status: 404 });
    const asset =
      assets.get(path === "/" ? "/index.html" : path) ??
      (!extname(path) ||
      request.headers.get("sec-fetch-mode") === "navigate" ||
      request.headers.get("accept")?.includes("text/html")
        ? assets.get("/index.html")
        : undefined);
    if (!asset) return new Response(null, { status: 404 });
    const headers = new Headers({
      "Content-Type": asset.type,
      "Cache-Control": "no-cache",
      "Last-Modified": asset.modified.toUTCString(),
      ETag: asset.etag,
      "Accept-Ranges": "bytes",
      "X-Content-Type-Options": "nosniff",
      Vary: "Accept-Encoding",
    });
    const range = request.headers.get("range");
    const compressed = !range && encodingFor(request.headers.get("accept-encoding"), asset);
    if (compressed) {
      headers.set("ETag", `${asset.etag.slice(0, -1)}-${compressed}"`);
      headers.set("Content-Encoding", compressed);
    }
    const match = request.headers.get("if-none-match");
    if (
      match
        ? match
            .split(",")
            .some(
              (tag) => tag.trim().replace(/^W\//, "") === headers.get("ETag") || tag.trim() === "*",
            )
        : Date.parse(request.headers.get("if-modified-since") ?? "") >= asset.modified.getTime()
    )
      return new Response(null, { status: 304, headers });
    let body = asset.body;
    let status = 200;
    const ifRange = request.headers.get("if-range");
    if (
      range &&
      (!ifRange || ifRange === asset.etag || Date.parse(ifRange) >= asset.modified.getTime())
    ) {
      const parts = /^bytes=(\d*)-(\d*)$/.exec(range);
      if (parts && (parts[1] || parts[2])) {
        const start = parts[1] ? Number(parts[1]) : Math.max(0, body.length - Number(parts[2]));
        const end =
          parts[1] && parts[2] ? Math.min(body.length - 1, Number(parts[2])) : body.length - 1;
        if (start >= body.length || start > end || (!parts[1] && Number(parts[2]) === 0)) {
          headers.set("Content-Range", `bytes */${body.length}`);
          return new Response(null, { status: 416, headers });
        }
        headers.set("Content-Range", `bytes ${start}-${end}/${body.length}`);
        body = body.subarray(start, end + 1);
        status = 206;
      }
    }
    if (compressed) {
      body = asset.encoded[compressed];
    }
    headers.set("Content-Length", String(body.length));
    return new Response(request.method === "HEAD" ? null : body, { status, headers });
  };
}

if (import.meta.main) {
  const handler = await createHandler(resolve(process.argv[2] ?? "dist"));
  const server = Bun.serve({
    hostname: process.env.HOST ?? "0.0.0.0",
    port: Number(process.env.PORT ?? 3000),
    fetch: handler,
  });
  console.log(`Serving dist on port ${server.port}`);
}
