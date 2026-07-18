import { log } from "@luma.gl/core";

let installed = false;

/** Suppress a specific benign luma.gl warning that otherwise floods the console.
 *
 * `@developmentseed/deck.gl-raster@0.6.1`'s `MeshTextureLayer` vendored a
 * fragment shader that dropped `uniform sampler2D sampler;`, but the inherited
 * `SimpleMeshLayer` still binds `sampler` (to an empty texture). luma then logs
 * `Binding sampler not set: Not found in shader layout.` on every draw of a
 * reprojecting raster tile — e.g. the projected-grid (HRRR Lambert Conformal)
 * or multiscale-grid layers, which regenerate their warp mesh each frame. The
 * raster still samples its data through the CompositeBands modules, so this is
 * purely cosmetic log noise.
 *
 * It can't be filtered via `console.warn`: probe.gl (luma's logger) captures the
 * original `console.warn` at import time (to bypass console monkeypatching), so
 * a `console.warn` override never sees it. Wrap luma's own `log.warn` instead —
 * it returns a deferred logger function, so the suppressed branch returns a
 * no-op callable to preserve the `log.warn(msg)()` call shape. */
export function installLumaLogFilter(): void {
  if (installed) return;
  installed = true;
  const lumaLog = log as unknown as {
    warn: (message?: unknown, ...args: unknown[]) => unknown;
  };
  const original = lumaLog.warn.bind(lumaLog);
  const noop = () => {};
  lumaLog.warn = (message?: unknown, ...args: unknown[]) =>
    typeof message === "string" && message.includes("Binding sampler not set")
      ? noop
      : original(message, ...args);
}

/** Reset the install guard. Test-only; not for production use. */
export function _resetLumaLogFilterForTesting(): void {
  installed = false;
}
