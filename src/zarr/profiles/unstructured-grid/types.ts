import type * as zarr from "zarrita";
import type { ProfileBaseContext } from "../../profile";

export type UnstructuredGridDim = {
  name: string;
  size: number;
};

export type UnstructuredGridVariable = {
  name: string;
  longName: string | null;
  units: string | null;
  fillValue: number | null;
  /** CF packing: decoded = raw * scaleFactor + addOffset. */
  scaleFactor: number;
  addOffset: number;
  /** Leading non-spatial dims (before the grid-point dim), in order. */
  dims: UnstructuredGridDim[];
  /** Name of the 1D grid-point dimension (e.g. "values", "cell"). */
  gridDim: string;
};

/** Opaque slice data returned by resolveNode. Cast to zarr.Group for the type
 * system; detected in buildLayer via the `__ungrid` sentinel. */
export type UnstructuredSlice = {
  __ungrid: true;
  values: Float32Array;
};

export type UnstructuredGridContext = ProfileBaseContext & {
  variables: UnstructuredGridVariable[];
  arrays: Map<string, zarr.Array<zarr.DataType, zarr.Readable>>;
  /** [lon0, lat0, lon1, lat1, ...] in EPSG:4326 degrees. Length = nPoints * 2. */
  positions: Float32Array;
  nPoints: number;
  dimLabel: Record<string, (idx: number) => string>;
};

export type UnstructuredGridState = {
  variable: string;
  dimIndices: Record<string, number>;
};

function defaultsToLatest(name: string): boolean {
  return /time|init|reference|analysis/i.test(name);
}

export function defaultUnstructuredDimIndices(
  v: UnstructuredGridVariable,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const dim of v.dims) {
    out[dim.name] = defaultsToLatest(dim.name) ? Math.max(0, dim.size - 1) : 0;
  }
  return out;
}
