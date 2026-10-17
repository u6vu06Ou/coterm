import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: {
        "@shared": resolve("src/shared"),
      },
    },
    build: {
      rollupOptions: {
        input: {
          index: resolve("src/main/index.ts"),
          // Forked as a plain Node ESM module (ELECTRON_RUN_AS_NODE=1) by
          // LivekitWorkerProcess; emitted as out/main/live-voice-worker.mjs.
          "live-voice-worker": resolve("src/main/voice/live/worker/entry.ts"),
          "search-index-worker": resolve("src/main/storage/search-index-worker.ts"),
        },
        output: {
          // The worker must be a real ESM file on disk so child_process.fork
          // can execute it; index stays cjs as before.
          entryFileNames: (chunk) => (
            chunk.name === "live-voice-worker" || chunk.name === "search-index-worker"
              ? "[name].mjs"
              : "[name].js"
          ),
        },
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: {
        "@shared": resolve("src/shared"),
      },
    },
    build: {
      rollupOptions: {
        input: resolve("src/preload/index.ts"),
        output: {
          format: "cjs",
          entryFileNames: "index.cjs",
        },
      },
    },
  },
  renderer: {
    root: "src/renderer",
    resolve: {
      alias: {
        "@renderer": resolve("src/renderer/src"),
        "@shared": resolve("src/shared"),
      },
    },
    plugins: [react()],
    build: {
      rollupOptions: {
        input: resolve("src/renderer/index.html"),
      },
    },
  },
});
