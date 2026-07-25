import type * as zarr from "zarrita";
import type { CrsConverters } from "../../crs";
import type { GeoZarrMetadata } from "../../multiscale";
import type { ProfileBaseContext } from "../../profile";

export type MultiscaleGridDim = { name: string; size: number };

/** A renderable data variable present at every pyramid level. */
export type MultiscaleGridVariable = {
  name: string;
  longName: string | null;
  units: string | null;
  dtype: string;
  fillValue: number | null;
  /** Leading non-spatial dims (everything before the trailing lat/lon pair). */
  dims: MultiscaleGridDim[];
  /** Per-variable deck.gl-zarr metadata (full asset paths, resolved against the
   * store root — includes the pyramid's subgroup prefix for nested stores). */
  metadata: GeoZarrMetadata;
};

/** One multiscale pyramid in a store, rooted at the store root (`prefix: ""`) or
 * a child group (`prefix: "10m"`). A nested store (e.g. the USDA CDL, which has
 * `/10m` and `/30m` products) carries one `Pyramid` per product group. */
export type Pyramid = {
  /** "" for the store root, else the child group path (e.g. "10m"). */
  prefix: string;
  /** Display label for the pyramid picker (the prefix, or "root"). */
  label: string;
  /** Renderable variables (≥1) present at every level of this pyramid. */
  variables: MultiscaleGridVariable[];
  /** Number of pyramid levels. */
  levelCount: number;
  /** Downsample factor per level (displayIndex order: index 0 = coarsest). */
  levelDownsamples: number[];
  /** `proj:code` when the CRS is an EPSG code (drives the geographic/3857 fast
   * paths); else null. */
  crsCode: string | null;
  /** Resolved proj4 converters for the profile's geo-math (bounds / hover /
   * auto-stats) under an arbitrary projected CRS, or null when unresolved (the
   * tile render still reprojects; the geo-math degrades gracefully). */
  crs: CrsConverters | null;
  /** Coarsest level's array of the DEFAULT variable + its (affine-order)
   * transform, used to sample a representative patch for the auto-rescale. */
  coarsestArray: zarr.Array<zarr.DataType, zarr.Readable>;
  coarsestTransform: readonly number[];
  /** Per-dim label formatter (`idx → string`), CF-decoded from the coord array. */
  dimLabel: Record<string, (idx: number) => string>;
  /** Lowest map zoom to load coarsest-level tiles (0 = no gate, e.g. geographic). */
  minRenderZoom: number;
};

export type MultiscaleGridContext = ProfileBaseContext & {
  store: zarr.Readable;
  /** All pyramids in the store (≥1). Nested stores have several (one per
   * product group); single-pyramid stores have exactly one. */
  pyramids: Pyramid[];
};

export type MultiscaleGridState = {
  /** Selected pyramid prefix ("" for the root pyramid). */
  pyramid: string;
  variable: string;
  /** Selected index per non-spatial dim name (e.g. `{ year: 4 }`). */
  dimIndices: Record<string, number>;
};

/** Default index per non-spatial dim: latest frame for time-like dims, else 0. */
export function defaultDimIndices(v: MultiscaleGridVariable): Record<string, number> {
  const out: Record<string, number> = {};
  for (const d of v.dims) {
    out[d.name] = /time|init|reference|analysis/i.test(d.name) ? Math.max(0, d.size - 1) : 0;
  }
  return out;
}

/** The pyramid the current state selects, falling back to the first (finest)
 * when the state's prefix doesn't match (e.g. a stale URL param). */
export function selectedPyramid(
  ctx: MultiscaleGridContext,
  state: { pyramid: string },
): Pyramid {
  return ctx.pyramids.find((p) => p.prefix === state.pyramid) ?? ctx.pyramids[0]!;
}
