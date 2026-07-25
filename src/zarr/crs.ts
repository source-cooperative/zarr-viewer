/** Resolve a GeoZarr CRS ({@link resolveCrsConverters}) into proj4 forward/inverse
 * converters between the source CRS and lng/lat, resolved ONCE (async) during a
 * profile's `prepare` so the profile's synchronous geo-math (data bounds, hover
 * sample, native resolution, auto-stats patch) can reproject without being async.
 *
 * The tile RENDER path resolves its own CRS inside `@developmentseed/deck.gl-zarr`;
 * this is the parallel resolution the PROFILE needs for the surrounding geo-math,
 * which `deck.gl-zarr` doesn't expose. */

import proj4 from "proj4";
import { epsgResolver, parseWkt } from "@developmentseed/proj";
import { createLogger } from "../log";

const log = createLogger("crs");

/** Geographic (lng/lat) EPSG codes for which the source coords ARE lng/lat, so
 * the converters are the identity (no proj4, no network). WGS84 / NAD83 / ETRS89. */
const GEOGRAPHIC = /4326|4269|4258/;

export type CrsConverters = {
  code: string | null;
  wkt2: string | null;
  /** True for a geographic CRS — `toLngLat`/`fromLngLat` are the identity. */
  geographic: boolean;
  /** Source CRS `(x, y)` → `[lng, lat]` degrees. */
  toLngLat: (x: number, y: number) => [number, number];
  /** `[lng, lat]` degrees → source CRS `(x, y)`. */
  fromLngLat: (lng: number, lat: number) => [number, number];
};

/** Resolve `{ code?, wkt2? }` into {@link CrsConverters}. Prefers the OFFLINE
 * paths, in order:
 *   1. geographic `code` (4326/4269/4258) → identity converters (no I/O).
 *   2. `wkt2` present → proj4 via `parseWkt` (offline).
 *   3. `code` only → `epsgResolver(n)`, which fetches `https://epsg.io/<n>.json`
 *      (NETWORKED — the same lookup `ZarrLayer` already performs for tile
 *      reprojection, so it is not a new dependency).
 * Returns `null` on any missing input or resolve/parse failure, so callers
 * degrade gracefully (manual rescale, skipped fly-in) instead of crashing. */
export async function resolveCrsConverters(opts: {
  code?: string | null;
  wkt2?: string | null;
}): Promise<CrsConverters | null> {
  const code = opts.code ?? null;
  const wkt2 = opts.wkt2 ?? null;

  const identity = (x: number, y: number): [number, number] => [x, y];
  if (code && GEOGRAPHIC.test(code)) {
    return { code, wkt2, geographic: true, toLngLat: identity, fromLngLat: identity };
  }

  try {
    // proj4 source def from WKT (offline) or an epsg.io PROJJSON lookup (network).
    let def: unknown;
    if (wkt2) {
      def = parseWkt(wkt2);
    } else if (code) {
      const n = Number.parseInt(code.split(":").pop() ?? "", 10);
      if (!Number.isFinite(n)) return null;
      def = await epsgResolver(n);
    } else {
      return null;
    }
    // proj4's typings don't cover a wkt-parser/PROJJSON def object — the render
    // layer does the same cast. `forward`/`inverse(..., false)` keep native
    // [x, y] order (matching data-bounds.ts / the ZarrLayer reprojection path).
    const converter = proj4(def as Parameters<typeof proj4>[0], "EPSG:4326");
    const toLngLat = (x: number, y: number): [number, number] =>
      converter.forward([x, y], false) as [number, number];
    const fromLngLat = (lng: number, lat: number): [number, number] =>
      converter.inverse([lng, lat], false) as [number, number];
    return { code, wkt2, geographic: false, toLngLat, fromLngLat };
  } catch (err) {
    log.debug("resolveCrsConverters failed", { code, wkt2, err });
    return null;
  }
}
