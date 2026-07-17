import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig(() => ({
  // GitHub Pages serves from a `/zarr-viewer/` subpath; the Pages workflow
  // sets BASE_PATH accordingly. Root-served hosts (Vercel, local dev) leave it
  // unset and get `/`.
  base: process.env.BASE_PATH ?? "/",
  plugins: [react()],
  worker: { format: "es" as const },
  // The gribberish GRIB2 codec ships as a napi-rs WASI bundle that loads its
  // `.wasm` and spawns a module worker via `new URL(..., import.meta.url)` and
  // top-level await. Pre-bundling (esbuild) rewrites those URLs and breaks the
  // asset/worker resolution, so exclude both packages and let Vite serve them
  // as native ESM. It's loaded lazily (dynamic import from the codec), so this
  // only affects the GRIB code path.
  optimizeDeps: {
    exclude: ["@mattnucc/gribberish", "@mattnucc/gribberish-wasm32-wasi"],
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test-setup.ts"],
  },
}));
