// vite.config.ts
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import wasm from "vite-plugin-wasm";
import topLevelAwait from "vite-plugin-top-level-await";
import cssInjectedByJsPlugin from "vite-plugin-css-injected-by-js";
import tailwindcss from "@tailwindcss/vite";
import externals from "@inkandswitch/patchwork-bootloader/externals";

export default defineConfig({
  base: "./",
  plugins: [topLevelAwait(), wasm(), react(), tailwindcss(), cssInjectedByJsPlugin()],
  build: {
    rollupOptions: {
      external: externals,
      input: "./src/index.ts",
      output: {
        format: "es",
        entryFileNames: "[name].js",
        chunkFileNames: "assets/[name]-[hash].js",
        assetFileNames: "assets/[name][extname]",
      },
      preserveEntrySignatures: "strict",
    },
  },
  worker: {
    format: "es",
    plugins: () => [wasm()],
  },
});
