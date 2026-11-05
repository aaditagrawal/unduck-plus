import { performance } from "node:perf_hooks";
import { readFile, writeFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";

const [baseline, candidate, serveFile, output = "/tmp/unduck-plus-performance.json"] =
  process.argv.slice(2);
if (!serveFile)
  throw new Error("Usage: bun benchmark.mjs BASELINE_ROOT CANDIDATE_ROOT SERVE_MAIN [OUTPUT]");
const samples = Number(process.env.SAMPLES ?? 7);
const phase = process.env.BENCH_PHASE ?? "all";
const stats = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    median: sorted[Math.floor(sorted.length / 2)],
    min: sorted[0],
    max: sorted.at(-1),
    samples: values,
  };
};
const result = {
  runtime: {
    bun: Bun.version,
    node: Bun.spawnSync(["node", "--version"]).stdout.toString().trim(),
  },
  baseline,
  candidate,
  samples,
  phase,
  workerLimits: Object.fromEntries(
    ["GOMAXPROCS", "RAYON_NUM_THREADS", "UV_THREADPOOL_SIZE"].map((key) => [key, process.env[key]]),
  ),
  loadStart: (await readFile("/proc/loadavg", "utf8")).trim(),
  build: {},
  startup: {},
  http: {},
};
async function build(root) {
  const start = performance.now();
  const child = Bun.spawn([process.execPath, "run", "build"], {
    cwd: root,
    stdout: "ignore",
    stderr: "pipe",
  });
  const error = await new Response(child.stderr).text();
  if (await child.exited) throw new Error(error);
  return performance.now() - start;
}
if (phase === "all" || phase === "build") {
  await build(baseline);
  await build(candidate);
  const times = { baseline: [], candidate: [] };
  for (let round = 0; round < samples; round++) {
    for (const name of round % 2 ? ["candidate", "baseline"] : ["baseline", "candidate"]) {
      const elapsed = await build(name === "baseline" ? baseline : candidate);
      times[name].push(elapsed);
      console.error(`Build ${round + 1}/${samples} ${name}: ${elapsed.toFixed(1)} ms`);
    }
  }
  for (const name of Object.keys(times)) result.build[name] = stats(times[name]);
  await writeFile(output, JSON.stringify(result, null, 2));
}
if (phase === "build") process.exit(0);
const basePort = 23650;
let sequence = 0;
const serversToStop = new Set();
async function stop(server) {
  server.child.kill("SIGKILL");
  await server.child.exited;
  serversToStop.delete(server);
}
for (const signal of ["SIGINT", "SIGTERM"])
  process.once(signal, async () => {
    await Promise.all([...serversToStop].map(stop));
    process.exit(130);
  });
async function start(kind) {
  const port = basePort + sequence++;
  const args =
    kind === "candidate"
      ? [process.execPath, resolve(candidate, "scripts/server.mjs"), resolve(candidate, "dist")]
      : [
          kind === "serve-node" ? "node" : process.execPath,
          serveFile,
          resolve(candidate, "dist"),
          "-s",
          "-p",
          String(port),
          "--no-clipboard",
          "--no-port-switching",
        ];
  const before = performance.now();
  const child = Bun.spawn(args, {
    cwd: candidate,
    env: { ...process.env, PORT: String(port), HOST: "127.0.0.1", NO_UPDATE_CHECK: "1" },
    stdout: "ignore",
    stderr: "pipe",
  });
  const url = `http://127.0.0.1:${port}`;
  const server = { child, url };
  serversToStop.add(server);
  for (let i = 0; i < 6000; i++) {
    try {
      const response = await fetch(url);
      await response.arrayBuffer();
      if (response.ok) {
        server.elapsed = performance.now() - before;
        return server;
      }
    } catch {}
    await Bun.sleep(5);
  }
  await stop(server);
  throw new Error(`Server did not start: ${kind}`);
}
const kinds = ["serve-node", "serve-bun", "candidate"];
for (const kind of kinds) {
  const s = await start(kind);
  await stop(s);
}
const starts = Object.fromEntries(kinds.map((k) => [k, []]));
for (let round = 0; round < samples; round++)
  for (const kind of round % 2 ? [...kinds].reverse() : kinds) {
    const s = await start(kind);
    starts[kind].push(s.elapsed);
    await stop(s);
  }
for (const kind of kinds) result.startup[kind] = stats(starts[kind]);
const files = await readdir(resolve(candidate, "dist/assets"));
let entry;
for (const file of files) {
  if (
    file.endsWith(".js") &&
    (await Bun.file(resolve(candidate, "dist/assets", file)).size) > 500000
  )
    entry = `/assets/${file}`;
}
if (!entry) throw new Error("Missing large catalogue entry");
const workloads = [
  {
    name: "html-identity-c8",
    path: "/?q=cats",
    headers: { "Accept-Encoding": "identity" },
    count: 240,
    concurrency: 8,
  },
  {
    name: "icon-identity-c8",
    path: "/clipboard.svg",
    headers: { "Accept-Encoding": "identity" },
    count: 240,
    concurrency: 8,
  },
  {
    name: "catalogue-identity-c4",
    path: entry,
    headers: { "Accept-Encoding": "identity" },
    count: 60,
    concurrency: 4,
  },
  {
    name: "catalogue-gzip-c4",
    path: entry,
    headers: { "Accept-Encoding": "gzip" },
    count: 60,
    concurrency: 4,
  },
  {
    name: "catalogue-range-c8",
    path: entry,
    headers: { "Accept-Encoding": "identity", Range: "bytes=0-1023" },
    count: 240,
    concurrency: 8,
  },
  {
    name: "catalogue-head-c8",
    path: entry,
    method: "HEAD",
    headers: { "Accept-Encoding": "identity" },
    count: 240,
    concurrency: 8,
  },
  {
    name: "invalid-encoding-c8",
    path: "/%ZZ",
    headers: { "Accept-Encoding": "identity" },
    count: 240,
    concurrency: 8,
  },
];
for (const encoding of ["br", "deflate"])
  workloads.push({
    name: `catalogue-${encoding}-c4`,
    path: entry,
    headers: { "Accept-Encoding": encoding },
    count: 60,
    concurrency: 4,
  });
const servers = {};
async function workload(server, work, count = work.count) {
  let next = 0;
  const latencies = [];
  const start = performance.now();
  await Promise.all(
    Array.from({ length: work.concurrency }, async () => {
      while (next++ < count) {
        const before = performance.now();
        const response = await fetch(server.url + work.path, {
          method: work.method ?? "GET",
          headers: work.headers,
        });
        await response.arrayBuffer();
        latencies.push(performance.now() - before);
      }
    }),
  );
  return { ms: performance.now() - start, requests: count, latency: stats(latencies) };
}
try {
  for (const kind of kinds) servers[kind] = await start(kind);
  for (const work of workloads) {
    // Check equivalent responses outside the timed loop, including rejected inputs.
    const responses = await Promise.all(
      kinds.map(async (kind) => {
        const response = await fetch(servers[kind].url + work.path, {
          method: work.method ?? "GET",
          headers: work.headers,
        });
        return { status: response.status, body: Buffer.from(await response.arrayBuffer()) };
      }),
    );
    const expected = work.name.startsWith("invalid-") ? 400 : work.headers.Range ? 206 : 200;
    if (
      responses.some((response) => response.status !== expected) ||
      (!work.name.startsWith("invalid-") &&
        responses.some((response) => !response.body.equals(responses[0].body)))
    )
      throw new Error(`Unequal HTTP behavior for ${work.name}: ${responses.map((r) => r.status)}`);
    const rounds = Object.fromEntries(kinds.map((k) => [k, []]));
    for (const kind of kinds) await workload(servers[kind], work, 16);
    for (let round = 0; round < samples; round++)
      for (const kind of round % 2 ? [...kinds].reverse() : kinds)
        rounds[kind].push(await workload(servers[kind], work));
    result.http[work.name] = {
      workload: work,
      ...Object.fromEntries(
        kinds.map((kind) => [
          kind,
          {
            elapsed: stats(rounds[kind].map((r) => r.ms)),
            latencyMedian: stats(rounds[kind].map((r) => r.latency.median)),
            latencyMax: Math.max(...rounds[kind].map((r) => r.latency.max)),
          },
        ]),
      ),
    };
  }
} finally {
  for (const server of serversToStop) await stop(server);
}
result.loadEnd = (await readFile("/proc/loadavg", "utf8")).trim();
await writeFile(output, JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
