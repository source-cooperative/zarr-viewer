/**
 * Map a dataset's native pixel resolution to the MapLibre zoom at which one
 * data pixel ≈ one screen (CSS) pixel — so "zoom to your location" lands at the
 * dataset's own resolution rather than an arbitrary fixed zoom. Pure + testable
 * (cf. `deriveMinZoom`).
 *
 * MapLibre uses 512 px tiles, so at zoom `z` the ground resolution at latitude
 * φ is `HALF·cos(φ) / 2^z` metres/CSS-pixel, where `HALF = 2πR/512`. Setting
 * that equal to the data's ground resolution and solving for `z` gives the
 * pixel-match zoom. cos(φ) cancels for geographic/mercator data (their
 * resolution scales with latitude the same way the map does) but not for a
 * fixed ground-metre (projected) resolution.
 */

/** The dataset's native resolution, tagged by the units it's expressed in. */
export type NativeResolution =
  /** Geographic lat/lon grid: degrees per pixel (the |lon step|). */
  | { kind: "degrees"; value: number }
  /** Projected CRS: ground metres per pixel (constant across latitude). */
  | { kind: "ground-meters"; value: number }
  /** EPSG:3857 grid: mercator metres per pixel (finest level). */
  | { kind: "mercator-meters"; value: number };

const R = 6378137; // WGS84 semi-major axis
/** Ground metres per MapLibre pixel at zoom 0, equator (2πR / 512-px tiles). */
const HALF = (2 * Math.PI * R) / 512;
const M_PER_DEG = (Math.PI / 180) * R;

/** MapLibre zoom at which the dataset's native pixels ≈ screen pixels at the
 * given latitude. Larger for finer data, smaller for coarser. Returns `NaN`
 * for a non-positive resolution. */
export function pixelMatchZoom(
  res: NativeResolution,
  latitudeDeg: number,
): number {
  if (!(res.value > 0)) return NaN;
  const cos = Math.max(0.01, Math.cos((latitudeDeg * Math.PI) / 180));
  // Ground metres per data pixel at this latitude.
  let groundMpp: number;
  switch (res.kind) {
    case "degrees":
      groundMpp = res.value * M_PER_DEG * cos;
      break;
    case "mercator-meters":
      groundMpp = res.value * cos;
      break;
    default:
      groundMpp = res.value; // ground-meters
  }
  // Map ground m/px at zoom z, lat φ = HALF·cos/2^z; set equal to groundMpp.
  return Math.log2((HALF * cos) / groundMpp);
}
