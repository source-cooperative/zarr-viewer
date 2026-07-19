/**
 * Pure helpers that turn a GeoZarr spatial affine + shape into the dataset's
 * geographic extent (`[west, south, east, north]` in lng/lat), for the optional
 * intro fly-in (issue #42). Kept free of React/deck so they can be unit-tested
 * in isolation, matching the codebase convention (cf. `deriveMinZoom`).
 *
 * The affine is GeoZarr `spatial:transform` = `[stepX, 0, originX, 0, stepY,
 * originY]`; `spatial:shape` = `[height, width]`. `stepY` is typically negative
 * (rows run north→south), so corners are normalized to min/max before use.
 */

import proj4 from "proj4";
import { parseWkt, transformBounds } from "@developmentseed/proj";

/** `[west, south, east, north]` in lng/lat degrees. */
export type LngLatBounds = [number, number, number, number];

/** WGS84 semi-major axis — the EPSG:3857 sphere radius. */
const R = 6378137;

type Corners = { minX: number; minY: number; maxX: number; maxY: number };

/** Source-CRS min/max corners from a GeoZarr affine + shape, or `null` when the
 * transform/shape is malformed (missing, zero step, non-positive size). */
function corners(
  transform: readonly number[],
  shape: readonly number[],
): Corners | null {
  if (!Array.isArray(transform) || !Array.isArray(shape)) return null;
  if (transform.length < 6 || shape.length < 2) return null;
  const stepX = transform[0]!;
  const originX = transform[2]!;
  const stepY = transform[4]!;
  const originY = transform[5]!;
  const height = shape[0]!;
  const width = shape[1]!;
  if (!Number.isFinite(stepX) || !Number.isFinite(stepY) || !stepX || !stepY) {
    return null;
  }
  if (!(width > 0) || !(height > 0)) return null;
  const x0 = originX;
  const x1 = originX + stepX * width;
  const y0 = originY;
  const y1 = originY + stepY * height;
  return {
    minX: Math.min(x0, x1),
    maxX: Math.max(x0, x1),
    minY: Math.min(y0, y1),
    maxY: Math.max(y0, y1),
  };
}

/** Affine already in DEGREES (EPSG:4326, geographic scalar-grid) → lng/lat
 * bbox. */
export function geographicBounds(
  transform: readonly number[],
  shape: readonly number[],
): LngLatBounds | null {
  const c = corners(transform, shape);
  if (!c) return null;
  return [c.minX, c.minY, c.maxX, c.maxY];
}

const mercToLng = (x: number): number => (x / R) * (180 / Math.PI);
const mercToLat = (y: number): number =>
  (2 * Math.atan(Math.exp(y / R)) - Math.PI / 2) * (180 / Math.PI);

/** Affine in EPSG:3857 METRES (multiscale-grid) → lng/lat bbox via the
 * closed-form web-mercator inverse. */
export function mercatorBounds(
  transform: readonly number[],
  shape: readonly number[],
): LngLatBounds | null {
  const c = corners(transform, shape);
  if (!c) return null;
  return [
    mercToLng(c.minX),
    mercToLat(c.minY),
    mercToLng(c.maxX),
    mercToLat(c.maxY),
  ];
}

/** Affine in a projected CRS (metres) + its WKT2 → lng/lat bbox. Reprojects the
 * densified footprint (so curved projected edges, e.g. Lambert Conformal Conic,
 * are captured — not just the four corners) via the same proj4/`parseWkt` path
 * the render layer uses. Returns `null` on any parse/transform failure. */
export function projectedBounds(
  transform: readonly number[],
  shape: readonly number[],
  wkt2: string,
): LngLatBounds | null {
  const c = corners(transform, shape);
  if (!c || !wkt2) return null;
  try {
    // `parseWkt` yields a wkt-parser def object; proj4's typings don't cover it
    // (the render layer does the same cast). `.forward(..., false)` keeps native
    // [x, y] order and returns [lng, lat]. Same path the ZarrLayer reprojects on.
    const converter = proj4(
      parseWkt(wkt2) as unknown as Parameters<typeof proj4>[0],
      "EPSG:4326",
    );
    const project = (x: number, y: number): [number, number] =>
      converter.forward([x, y], false) as [number, number];
    const [w, s, e, n] = transformBounds(
      project,
      c.minX,
      c.minY,
      c.maxX,
      c.maxY,
      { densifyPts: 21 },
    );
    if (![w, s, e, n].every(Number.isFinite)) return null;
    return [w, s, e, n];
  } catch {
    return null;
  }
}
