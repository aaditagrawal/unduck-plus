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
