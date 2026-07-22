/** Translate CF/rioxarray multiscale-pyramid stores (e.g. Meta CHM v2) into the
 * developmentseed GeoZarr `metadata` shape that `@developmentseed/deck.gl-zarr`'s
 * `ZarrLayer` consumes natively (multiscale overviews + on-the-fly reprojection).
 *
 * Such stores nest data at `<scale>/<var>` (e.g. `1x/chm`…`64x/chm`), carry a
 * `multiscales` attr on the root group, and georeference via a CF `spatial_ref`
 * aux array (`crs_wkt` + GDAL `GeoTransform`) rather than 1-D coordinate arrays.
 * This module is pure (no I/O) so it can be unit-tested against the real parser. */

/** A pyramid level's georeferencing, gathered by the profile from the store. */
export type MultiscaleLevelInput = {
  /** Path of the data array relative to the root group, e.g. `"1x/chm"`. */
  asset: string;
  /** GDAL `GeoTransform`: `[originX, pixelW, rowRotation, originY, colRotation, pixelH]`. */
  geoTransform: readonly number[];
  /** Array spatial shape `[height, width]`. */
  shape: readonly [number, number];
};

/** The (subset of the) GeoZarr metadata object `parseGeoZarrMetadata` needs. */
export type GeoZarrMetadata = {
  "spatial:dimensions": [string, string];
  "proj:wkt2": string;
  multiscales: {
    layout: {
      asset: string;
      "spatial:transform": [number, number, number, number, number, number];
      "spatial:shape": [number, number];
    }[];
  };
};

/** Thrown by the default (scalar-grid) profile's `prepare` when it detects a
 * multiscale pyramid, signalling the chassis to switch to the `multiscale-grid`
 * profile. Keeps normal loads on the fast path (no upfront detection open). */
export class MultiscaleStoreError extends Error {
  constructor() {
    super("multiscale store — use the multiscale-grid profile");
    this.name = "MultiscaleStoreError";
  }
}

/** Read the multiscale dataset paths (coarsest→finest, the store's natural
 * order) from a root group's attrs, or null when the store isn't a multiscale
 * pyramid. Handles the CF/rioxarray `multiscales: [{ datasets: [{ path }] }]`
 * convention used by Meta CHM and xarray-multiscale writers. */
export function parseMultiscaleDatasets(rootAttrs: unknown): string[] | null {
  if (typeof rootAttrs !== "object" || rootAttrs === null) return null;
  const ms = (rootAttrs as { multiscales?: unknown }).multiscales;
  if (!Array.isArray(ms) || ms.length === 0) return null;
  const datasets = (ms[0] as { datasets?: unknown }).datasets;
  if (!Array.isArray(datasets) || datasets.length === 0) return null;
  const paths = datasets
    .map((d) => (typeof d?.path === "string" ? d.path : null))
    .filter((p): p is string => p !== null);
  return paths.length > 0 ? paths : null;
}

export type MultiscaleLayoutLevel = {
  asset: string;
  "spatial:transform": [number, number, number, number, number, number];
  "spatial:shape": [number, number];
};
export type MultiscaleLayout = {
  levels: MultiscaleLayoutLevel[];
  dims: [string, string];
  crs: { code?: string; wkt2?: string };
};

function asAffine6(v: unknown): [number, number, number, number, number, number] | null {
  if (!Array.isArray(v) || v.length !== 6 || v.some((n) => typeof n !== "number")) return null;
  return v as [number, number, number, number, number, number];
}
function asShape2(v: unknown): [number, number] | null {
  if (!Array.isArray(v) || v.length !== 2 || v.some((n) => typeof n !== "number")) return null;
  return [v[0] as number, v[1] as number];
}

/** Read the `zarr-conventions/multiscales` v1 `{ layout: [...] }` object schema
 * (distinct from the legacy CF `[{ datasets }]` array handled by
 * {@link parseMultiscaleDatasets}). Returns levels FINEST-FIRST (store order),
 * the spatial dim pair, and the CRS, or null when the store isn't this schema
 * or a layout item lacks a per-level transform/shape. */
export function parseMultiscaleLayout(rootAttrs: unknown): MultiscaleLayout | null {
  if (typeof rootAttrs !== "object" || rootAttrs === null) return null;
  const a = rootAttrs as Record<string, unknown>;
  const ms = a.multiscales;
  // Must be the OBJECT form { layout: [...] } — the legacy datasets form is an array.
  if (typeof ms !== "object" || ms === null || Array.isArray(ms)) return null;
  const layout = (ms as { layout?: unknown }).layout;
  if (!Array.isArray(layout) || layout.length === 0) return null;

  const levels: MultiscaleLayoutLevel[] = [];
  for (const item of layout) {
    if (typeof item !== "object" || item === null) return null;
    const it = item as Record<string, unknown>;
    const asset = it.asset;
    const transform = asAffine6(it["spatial:transform"]);
    const shape = asShape2(it["spatial:shape"]);
    if (typeof asset !== "string" || !transform || !shape) return null;
    levels.push({ asset, "spatial:transform": transform, "spatial:shape": shape });
  }

  const dimsRaw = a["spatial:dimensions"];
  if (!Array.isArray(dimsRaw) || dimsRaw.length < 2) return null;
  const dims: [string, string] = [
    String(dimsRaw[dimsRaw.length - 2]),
    String(dimsRaw[dimsRaw.length - 1]),
  ];

  const crs: { code?: string; wkt2?: string } = {};
  if (typeof a["proj:code"] === "string") crs.code = a["proj:code"];
  else if (typeof a["proj:wkt2"] === "string") crs.wkt2 = a["proj:wkt2"];
  else return null;

  return { levels, dims, crs };
}

/** GDAL `GeoTransform` `[ox, px, rx, oy, ry, py]` → developmentseed
 * `spatial:transform` `[px, rx, ox, ry, py, oy]` (scaleX, 0, translateX,
 * 0, scaleY, translateY). */
function geoTransformToSpatial(
  gt: readonly number[],
): [number, number, number, number, number, number] {
  const [ox, px, rx, oy, ry, py] = gt;
  return [px ?? 1, rx ?? 0, ox ?? 0, ry ?? 0, py ?? -1, oy ?? 0];
}

/** Build the GeoZarr `metadata` object for `ZarrLayer` from per-level
 * georeferencing + a WKT2 CRS string. `levels` is given coarsest→finest (the
 * store's order); the GeoZarr `layout` is emitted **finest-first**, as
 * `parseGeoZarrMetadata` expects. Uses `proj:wkt2` (the store's embedded
 * `crs_wkt`) so the CRS resolves offline. */
export function buildGeoZarrMetadata(opts: {
  /** Levels coarsest→finest (store order). */
  levels: readonly MultiscaleLevelInput[];
  crsWkt: string;
  /** Spatial dim names, default `["y", "x"]`. */
  dims?: [string, string];
}): GeoZarrMetadata {
  const finestFirst = [...opts.levels].reverse();
  return {
    "spatial:dimensions": opts.dims ?? ["y", "x"],
    "proj:wkt2": opts.crsWkt,
    multiscales: {
      layout: finestFirst.map((lvl) => ({
        asset: lvl.asset,
        "spatial:transform": geoTransformToSpatial(lvl.geoTransform),
        "spatial:shape": [lvl.shape[0], lvl.shape[1]],
      })),
    },
  };
}
