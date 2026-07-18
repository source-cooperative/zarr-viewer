import * as zarr from "zarrita";

let installed = false;

/**
 * Register the gribberish codec in zarrita's global codec registry. Idempotent;
 * call once at startup (next to {@link installFloat16Polyfill}).
 *
 * The loader dynamic-imports {@link GribberishCodec} — and thus the gribberish
 * WASM/native binding — only on the first GRIB chunk read, so non-GRIB stores
 * never pull in the (browser-side, cross-origin-isolation-requiring) WASM.
 */
export function installGribberishCodec(): void {
  if (installed) return;
  installed = true;
  (zarr.registry as Map<string, () => Promise<unknown>>).set(
    "gribberish",
    () => import("./gribberish-codec").then((m) => m.GribberishCodec),
  );
}
