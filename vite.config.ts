import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { sentryVitePlugin } from "@sentry/vite-plugin";

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

// Upload source maps to Sentry only when an auth token is present (CI). Local
// `pnpm build` skips upload, and the plugin deletes the emitted `.map` files
// after upload so they aren't published to the public GitHub Pages site. The
// `/zarr-viewer/` base path needs no special handling — the plugin matches maps
// by injected debug IDs, not URL paths.
const sentrySourceMaps = process.env.SENTRY_AUTH_TOKEN
  ? [
      sentryVitePlugin({
        org: process.env.SENTRY_ORG,
        project: process.env.SENTRY_PROJECT,
        authToken: process.env.SENTRY_AUTH_TOKEN,
        telemetry: false,
        release: { name: process.env.VITE_SENTRY_RELEASE },
        sourcemaps: { filesToDeleteAfterUpload: ["./dist/**/*.map"] },
      }),
    ]
  : [];

export default defineConfig(() => ({
  // GitHub Pages serves from a `/zarr-viewer/` subpath; the Pages workflow
  // sets BASE_PATH accordingly. Root-served hosts (Vercel, local dev) leave it
  // unset and get `/`.
  base: process.env.BASE_PATH ?? "/",
  // Emit source maps so Sentry can de-minify production stack traces; the
  // sentry plugin deletes them from dist after upload (see sentrySourceMaps).
  build: { sourcemap: true },
  plugins: [react(), ...sentrySourceMaps],
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
