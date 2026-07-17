/** Support for single-level **projected** grids — data on a projected CRS
 * (e.g. NOAA HRRR's Lambert Conformal Conic grid) georeferenced by a CF
 * `spatial_ref` grid-mapping array (`crs_wkt` + GDAL `GeoTransform`), with 1-D
 * projected `y`/`x` coordinates in metres and latitude/longitude present only as
 * 2-D arrays.
 *
 * The scalar-grid profile can't render these: it would misread the projected
 * `y`/`x` metres as degrees. Instead it detects such a store and hands off to
 * the `projected-grid` profile, which emits GeoZarr `proj:wkt2` metadata so
 * `@developmentseed/deck.gl-zarr` (proj4) reprojects on the fly. Pure/IO helpers
 * live here so they can be unit-tested and shared.
 */
import * as zarr from "zarrita";

/** Thrown by the scalar-grid profile's `prepare` when it detects a projected
 * grid, signalling the chassis to switch to the `projected-grid` profile.
 * Mirrors {@link MultiscaleStoreError}. */
export class ProjectedGridStoreError extends Error {
  constructor() {
    super("projected grid store — use the projected-grid profile");
    this.name = "ProjectedGridStoreError";
  }
}

export type ProjectedGrid = {
  /** WKT2 CRS string from the `spatial_ref` array (its `crs_wkt`). */
  crsWkt: string;
  /** CF `grid_mapping_name` (e.g. `lambert_conformal_conic`), or null. */
  gridMappingName: string | null;
  /** GDAL `GeoTransform` `[ox, px, rx, oy, ry, py]`. */
  geoTransform: number[];
};

/** GDAL `GeoTransform` `[ox, px, rx, oy, ry, py]` → developmentseed GeoZarr
 * `spatial:transform` `[px, rx, ox, ry, py, oy]`. (Same mapping the
 * multiscale-grid profile uses; inlined here to keep this module standalone.) */
export function geoTransformToSpatial(
  gt: readonly number[],
): [number, number, number, number, number, number] {
  const [ox, px, rx, oy, ry, py] = gt;
  return [px ?? 1, rx ?? 0, ox ?? 0, ry ?? 0, py ?? -1, oy ?? 0];
}

function joinPath(group: string, leaf: string): string {
  return group ? `${group}/${leaf}` : leaf;
}

/** Read the CF `spatial_ref` grid-mapping array under `groupPath` and return its
 * **projected** georeferencing, or null when it's absent, geographic
 * (`latitude_longitude`), or malformed. A non-null result means the store
 * should render through the projected-grid profile. */
export async function readProjectedSpatialRef(
  group: zarr.Group<zarr.Readable>,
  groupPath: string,
): Promise<ProjectedGrid | null> {
  let sr: zarr.Array<zarr.DataType, zarr.Readable>;
  try {
    sr = await zarr.open(group.resolve(joinPath(groupPath, "spatial_ref")), {
      kind: "array",
    });
  } catch {
    return null; // no grid-mapping aux array
  }
  const a = sr.attrs as Record<string, unknown>;
  const crsWkt =
    typeof a.crs_wkt === "string"
      ? a.crs_wkt
      : typeof a.spatial_ref === "string"
        ? a.spatial_ref
        : "";
  if (!crsWkt) return null;
  const gridMappingName =
    typeof a.grid_mapping_name === "string" ? a.grid_mapping_name : null;
  // A geographic grid-mapping (or an unlabeled one) is not a projected store —
  // let the scalar-grid lat/lon path handle it. Require an explicit projected
  // grid_mapping_name so we never mis-handle a plain lat/lon grid.
  if (
    gridMappingName === null ||
    gridMappingName === "latitude_longitude" ||
    gridMappingName === "rotated_latitude_longitude"
  ) {
    return null;
  }
  const geoTransform = String(a.GeoTransform ?? "")
    .trim()
    .split(/\s+/)
    .map(Number);
  if (geoTransform.length < 6 || geoTransform.some((n) => !Number.isFinite(n))) {
    return null;
  }
  return { crsWkt, gridMappingName, geoTransform };
}
