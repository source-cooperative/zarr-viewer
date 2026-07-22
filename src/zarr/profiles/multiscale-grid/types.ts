import type * as zarr from "zarrita";
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
  /** Per-variable deck.gl-zarr metadata (asset = "<level>/<name>"). */
  metadata: GeoZarrMetadata;
};

export type MultiscaleGridContext = ProfileBaseContext & {
  store: zarr.Readable;
  /** Renderable variables (≥1). Single-variable stores (e.g. Meta CHM) have one. */
  variables: MultiscaleGridVariable[];
  /** Number of pyramid levels. */
  levelCount: number;
  /** Downsample factor per level (displayIndex order: index 0 = coarsest). */
  levelDownsamples: number[];
  /** `proj:code` when the CRS is an EPSG code (display + geographic gate); else null. */
  crsCode: string | null;
  /** Coarsest level's data array of the DEFAULT variable + its layout transform,
   * used to sample a representative patch for the auto-rescale. */
  coarsestArray: zarr.Array<zarr.DataType, zarr.Readable>;
  coarsestTransform: readonly number[];
  /** Per-dim label formatter (`idx → string`), CF-decoded from the coord array. */
  dimLabel: Record<string, (idx: number) => string>;
  /** Lowest map zoom to load coarsest-level tiles (0 = no gate, e.g. geographic). */
  minRenderZoom: number;
};

export type MultiscaleGridState = {
  variable: string;
  /** Selected index per non-spatial dim name (e.g. `{ time: 4 }`). */
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
