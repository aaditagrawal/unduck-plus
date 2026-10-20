import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  build: {
    minify: "oxc",
  },
  json: {
    // Ship the bangs map as a JSON.parse'd string: much faster for the
    // engine to parse than a megabyte-scale object literal.
    stringify: true,
  },
  plugins: [
    VitePWA({
      registerType: "autoUpdate",
      // Inline the SW registration instead of fetching registerSW.js.
      injectRegister: "inline",
      manifest: {
        name: "SearchLock",
        short_name: "SearchLock",
        description: "A better default search engine (with bangs, and better defaults!)",
        start_url: "/",
        display: "standalone",
        background_color: "#131313",
        theme_color: "#131313",
        icons: [
          {
            src: "/search.svg",
            sizes: "any",
            type: "image/svg+xml",
            purpose: "any",
          },
        ],
      },
      workbox: {
        // Precache everything the app can ever request, so redirects work
        // fully offline (including the lazy homepage chunk and icons).
        globPatterns: ["**/*.{js,css,html,svg,webmanifest}"],
        // Serve the precached shell for any navigation, including ?q=...
        // searches, without touching the network.
        navigateFallback: "index.html",
        maximumFileSizeToCacheInBytes: 4 * 1024 * 1024,
        cleanupOutdatedCaches: true,
        clientsClaim: true,
        skipWaiting: true,
      },
    }),
  ],
});
