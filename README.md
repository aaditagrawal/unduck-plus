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
