import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// Cross-origin isolation so SharedArrayBuffer is available for the gribberish
// GRIB2 codec's threaded WASM. `credentialless` COEP (vs `require-corp`) lets
// the cross-origin basemap (CARTO/Esri) and data.source.coop fetches load
// without needing CORP headers on those responses. In production (GitHub Pages,
// which can't set headers) the same isolation is provided by the
// coi-serviceworker shim referenced in index.html.
const crossOriginIsolation = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "credentialless",
};

export default defineConfig(() => ({
  // GitHub Pages serves from a `/zarr-viewer/` subpath; the Pages workflow
  // sets BASE_PATH accordingly. Root-served hosts (Vercel, local dev) leave it
  // unset and get `/`.
  base: process.env.BASE_PATH ?? "/",
  plugins: [react()],
  worker: { format: "es" as const },
  server: { headers: crossOriginIsolation },
  preview: { headers: crossOriginIsolation },
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
