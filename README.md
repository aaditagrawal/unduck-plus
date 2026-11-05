# Unduck

DuckDuckGo's bang redirects are too slow. Add the following URL as a custom search engine to your browser. Enables all of DuckDuckGo's bangs to work, but much faster.

```
https://sea.sys256.com?q=%s
```

## How is it that much faster?

DuckDuckGo does their redirects server side. Their DNS is...not always great. Result is that it often takes ages.

I solved this by doing all of the work client side. Once you've gone to https://sea.sys256.com once, the JS is all cached and will never need to be downloaded again. Your device does the redirects, not me.

(the above was written by Theo.)

Changes by Aadit:

- Removed Theo's analytics tracking.
- Added Perplexity and Kagi as providers.
- Made it self hosting ready.
- Compacted the bang list into an O(1) lookup map and made the whole app precache, so redirects work fully offline.

## Editing bangs

The bang list lives in `data/bangs.ts` (custom overrides go at the top; first occurrence of a trigger wins). After editing it, regenerate the compact map the app actually ships:

```
bun run generate:bangs
```

This rewrites `src/bangs.json`, which is committed to the repo.

## Building and hosting

Use Bun to install and run the project:

```
bun install --frozen-lockfile
bun run dev
```

Development updates CSS in place and reloads connected browsers after changes to source, HTML and public assets. It does not register a service worker. Use a fresh browser profile or unregister an existing production worker when developing on the same origin.

`bun run build` typechecks and bundles with Bun, then writes the manifest, offline worker and asset allowlist to `dist`. `bun run preview` serves that output on port 3000. Set `PORT` and `HOST` to override the listener. The Docker runtime uses the same server and installs no packages.

The worker precaches the full app before activating. During updates, old caches remain available until all open tabs use the current release, so lazy chunks in older tabs keep working. Search destinations still require their own network access.

## Comparing replacements

Prepare an external fixture from commit `ec6c58be42dd4fc6ab2763dc81296af81f931e80` with `git archive`, install its frozen lock with Bun, and install `serve@14.2.6` in a separate temporary directory. `bun scripts/benchmark.mjs BASELINE_ROOT CANDIDATE_ROOT SERVE_MAIN OUTPUT_JSON` compares builds, server startup and HTTP workloads. Set `SAMPLES` to change the paired sample count or `BENCH_PHASE` to `build` or `http` to run a subset.

Browser fixtures use an externally installed Playwright module and Chrome, without adding application dependencies. Run `node scripts/benchmark-browser.mjs BASELINE_DIST CANDIDATE_DIST PLAYWRIGHT_MODULE` for offline, update and redirect checks, or `node scripts/benchmark-dev.mjs BASELINE_ROOT CANDIDATE_ROOT PLAYWRIGHT_MODULE` for development startup, CSS updates and HTML reloads. Both accept `ROUNDS` and `CHROME` overrides and print JSON measurements.
