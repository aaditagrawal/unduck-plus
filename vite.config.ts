import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  build: {
    minify: "oxc",
  },
  plugins: [
    VitePWA({
      registerType: "autoUpdate",
    }),
  ],
});
