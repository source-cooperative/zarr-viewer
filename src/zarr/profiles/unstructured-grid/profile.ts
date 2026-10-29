import { ScatterplotLayer } from "@deck.gl/layers";
import * as zarr from "zarrita";
import { autoStatsFromGlobal, buildBandStats } from "../../../render/stats";
import { createLogger } from "../../../log";
import { asConsolidated, openV3Group } from "../../load-zarr";
import { attrsHaveMultiscale, MultiscaleStoreError } from "../../multiscale";
import { OmeZarrStoreError, isOmeZarrAttrs } from "../image-orthographic/ome";
import { buildDimLabel } from "../scalar-grid/cf-coords";
import type { ZarrProfile } from "../../profile";
import { getColormapLut, loadColormapLut } from "../../../components/colormap-lut";
import { UnstructuredGridControls } from "./controls";
import {
  defaultUnstructuredDimIndices,
  type UnstructuredGridContext,
  type UnstructuredGridState,
  type UnstructuredGridVariable,
  type UnstructuredSlice,
} from "./types";

const log = createLogger("unstructured-grid");

const LAT_NAMES = ["latitude", "lat"];
const LON_NAMES = ["longitude", "lon"];

/** Thrown by the scalar-grid profile's `prepare` when it detects an
 * unstructured grid (CF `coordinates` → 1-D lat/lon arrays), signalling the
 * chassis to switch to the `unstructured-grid` profile. */
export class UnstructuredGridStoreError extends Error {
  constructor() {
    super("unstructured grid store — use the unstructured-grid profile");
    this.name = "UnstructuredGridStoreError";
  }
}

// Module-level slice cache: maps sliceKey → decoded Float32Array.
// Populated in buildLayer; consumed in sampleValue. LRU-capped at 4 entries.
const sliceCache = new Map<string, Float32Array>();
const MAX_SLICE_KEYS = 4;

function sliceKey(state: UnstructuredGridState): string {
  const dims = Object.keys(state.dimIndices)
    .sort()
    .map((k) => `${k}=${state.dimIndices[k]}`)
    .join(",");
  return `${state.variable}|${dims}`;
}

function storeSlice(key: string, values: Float32Array): void {
  if (sliceCache.has(key)) return;
  if (sliceCache.size >= MAX_SLICE_KEYS) {
    const oldest = sliceCache.keys().next().value as string | undefined;
    if (oldest !== undefined) sliceCache.delete(oldest);
  }
  sliceCache.set(key, values);
}

/** Check if any array in `paths` has a CF `coordinates` attribute pointing to
 * 1-D lat/lon arrays of the correct size. Returns the first match's metadata,
 * or null when nothing qualifies. */
export async function detectUnstructuredVariable(
  group: zarr.Group<zarr.Readable>,
  paths: string[],
  signal: AbortSignal,
): Promise<{
  path: string;
  latName: string;
  lonName: string;
  gridDimSize: number;
} | null> {
  for (const path of paths) {
    if (signal.aborted) return null;
    let arr: zarr.Array<zarr.DataType, zarr.Readable>;
    try {
      arr = await zarr.open(group.resolve(path), { kind: "array" });
    } catch {
      continue;
    }
    const coords = arr.attrs.coordinates;
    if (typeof coords !== "string") continue;
    const names = coords.trim().split(/\s+/);
    const latName = names.find((n) => LAT_NAMES.includes(n));
    const lonName = names.find((n) => LON_NAMES.includes(n));
    if (!latName || !lonName) continue;
    const gridDimSize = arr.shape[arr.shape.length - 1];
    if (!gridDimSize) continue;
    try {
      const [la, lo] = await Promise.all([
        zarr.open(group.resolve(latName), { kind: "array" }),
        zarr.open(group.resolve(lonName), { kind: "array" }),
      ]);
      if (
        la.shape.length === 1 &&
        la.shape[0] === gridDimSize &&
        lo.shape.length === 1 &&
        lo.shape[0] === gridDimSize
      ) {
        return { path, latName, lonName, gridDimSize };
      }
    } catch {
      continue;
    }
  }
  return null;
}

async function enumerateVariables(
  group: zarr.Group<zarr.Readable>,
  paths: string[],
  latName: string,
  lonName: string,
  gridDimSize: number,
  signal: AbortSignal,
  arrays: Map<string, zarr.Array<zarr.DataType, zarr.Readable>>,
): Promise<UnstructuredGridVariable[]> {
  const out: UnstructuredGridVariable[] = [];
  for (const path of paths) {
    if (signal.aborted) break;
    if (path === latName || path === lonName) continue;
    let arr: zarr.Array<zarr.DataType, zarr.Readable>;
    try {
      const cached = arrays.get(path);
      if (cached) {
        arr = cached;
      } else {
        arr = await zarr.open(group.resolve(path), { kind: "array" });
        arrays.set(path, arr);
      }
    } catch {
      continue;
    }
    if (!/^(float|int|uint)/.test(arr.dtype)) continue;
    if (arr.shape[arr.shape.length - 1] !== gridDimSize) continue;
    const coords = arr.attrs.coordinates;
    if (typeof coords !== "string") continue;
    const names = coords.trim().split(/\s+/);
    if (!names.includes(latName) || !names.includes(lonName)) continue;
    const dims = arr.dimensionNames;
    const ndim = arr.shape.length;
    const leadingDims: UnstructuredGridVariable["dims"] = [];
    for (let i = 0; i < ndim - 1; i++) {
      const n =
        typeof dims?.[i] === "string" ? (dims[i] as string) : `dim${i}`;
      leadingDims.push({ name: n, size: arr.shape[i] ?? 0 });
    }
    const gridDim =
      typeof dims?.[ndim - 1] === "string"
        ? (dims[ndim - 1] as string)
        : "values";
    const a = arr.attrs;
    out.push({
      name: path,
      longName: typeof a.long_name === "string" ? a.long_name : null,
      units: typeof a.units === "string" ? a.units : null,
      fillValue:
        typeof a._FillValue === "number"
          ? a._FillValue
          : typeof a.missing_value === "number"
            ? a.missing_value
            : typeof arr.fillValue === "number"
              ? arr.fillValue
              : null,
      scaleFactor: typeof a.scale_factor === "number" ? a.scale_factor : 1,
      addOffset: typeof a.add_offset === "number" ? a.add_offset : 0,
      dims: leadingDims,
      gridDim,
    });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

const PREFERRED_VARS = ["t2m", "temperature_2m", "u10", "v10", "msl", "tp"];

function pickDefault(variables: UnstructuredGridVariable[]): string {
  for (const p of PREFERRED_VARS) {
    if (variables.find((v) => v.name === p)) return p;
  }
  return variables[0]!.name;
}

export const unstructuredGridProfile: ZarrProfile<
  UnstructuredGridState,
  UnstructuredGridContext
> = {
  id: "unstructured-grid",
  label: "Unstructured grid (scatter)",
  needsColormap: true,

  getStructure: (_ctx, state) => ({
    zarrVersion: "v3",
    variables: [{ path: state.variable }],
    metadataSource: "synthesized" as const,
    metadata: null,
  }),

  async prepare(url, signal, open = {}) {
    const done = log.time("unstructured-grid prepare", "info");
    const opened = await openV3Group(url, { consolidated: true, ...open });
    if (isOmeZarrAttrs(opened.group.attrs)) throw new OmeZarrStoreError();
    if (attrsHaveMultiscale(opened.group.attrs)) throw new MultiscaleStoreError();

    const consolidated = asConsolidated(opened.store);
    const paths: string[] = consolidated
      ? consolidated
          .contents()
          .filter((e) => e.kind === "array")
          .map((e) => e.path.replace(/^\/+/, ""))
      : ["t2m", "u10", "v10", "msl", "tp", "q", "z", "t", "u", "v", "w"];

    const detection = await detectUnstructuredVariable(
      opened.group,
      paths,
      signal,
    );
    if (!detection) {
      done();
      throw new Error(
        "No unstructured grid variables found. Expected arrays with a CF " +
          "`coordinates` attribute pointing to 1-D lat/lon arrays.",
      );
    }
    const { latName, lonName, gridDimSize } = detection;
    log.info(
      `detected unstructured grid: ${gridDimSize} points, lat=${latName}, lon=${lonName}`,
    );

    // Prime the colormap LUT cache in the background.
    loadColormapLut("viridis").catch(() => {});

    const arrays = new Map<string, zarr.Array<zarr.DataType, zarr.Readable>>();
    const variables = await enumerateVariables(
      opened.group,
      paths,
      latName,
      lonName,
      gridDimSize,
      signal,
      arrays,
    );
    if (variables.length === 0 || signal.aborted) {
      done();
      throw new Error(
        "No renderable variables found in unstructured grid store.",
      );
    }

    // Load lat/lon coordinate arrays → flat Float32Array [lon0, lat0, lon1, lat1, ...]
    const [latArr, lonArr] = await Promise.all([
      zarr.open(opened.group.resolve(latName), { kind: "array" }),
      zarr.open(opened.group.resolve(lonName), { kind: "array" }),
    ]);
    const [latChunk, lonChunk] = await Promise.all([
      zarr.get(latArr as zarr.Array<zarr.NumberDataType, zarr.Readable>),
      zarr.get(lonArr as zarr.Array<zarr.NumberDataType, zarr.Readable>),
    ]);
    const latData = latChunk.data as ArrayLike<number>;
    const lonData = lonChunk.data as ArrayLike<number>;
    const nPoints = gridDimSize;
    const positions = new Float32Array(nPoints * 2);
    for (let i = 0; i < nPoints; i++) {
      let lon = Number(lonData[i]);
      if (lon > 180) lon -= 360; // normalize 0..360 → -180..180
      positions[i * 2] = lon;
      positions[i * 2 + 1] = Number(latData[i]);
    }

    // Build CF dim-label formatters for all leading dims.
    const dimMeta = new Map<string, number>();
    for (const v of variables)
      for (const d of v.dims)
        if (!dimMeta.has(d.name)) dimMeta.set(d.name, d.size);
    const dimLabel: Record<string, (idx: number) => string> = {};
    for (const [name, size] of dimMeta) {
      if (signal.aborted) break;
      dimLabel[name] = await buildDimLabel(opened.group, name, size);
    }

    done();
    return {
      url,
      group: opened.group,
      variables,
      arrays,
      positions,
      nPoints,
      dimLabel,
    };
  },

  initialState(ctx) {
    const variable = pickDefault(ctx.variables);
    const v = ctx.variables.find((x) => x.name === variable)!;
    return { variable, dimIndices: defaultUnstructuredDimIndices(v) };
  },

  parseUrlParams(p) {
    const out: Partial<UnstructuredGridState> = {};
    const v = p.get("var");
    if (v) out.variable = v;
    const dimIndices: Record<string, number> = {};
    for (const [key, value] of p.entries()) {
      if (!key.startsWith("dim.")) continue;
      const n = Number(value);
      if (Number.isFinite(n)) dimIndices[key.slice(4)] = n;
    }
    if (Object.keys(dimIndices).length > 0) out.dimIndices = dimIndices;
    return out;
  },

  serializeUrlParams(s) {
    const out: Record<string, string | null> = { var: s.variable };
    for (const [name, idx] of Object.entries(s.dimIndices)) {
      out[`dim.${name}`] = String(idx);
    }
    return out;
  },

  initialBounds: () => [-180, -90, 180, 90],

  Controls: UnstructuredGridControls,

  async resolveNode(ctx, state, signal) {
    const varMeta = ctx.variables.find((v) => v.name === state.variable);
    if (!varMeta) throw new Error(`Variable "${state.variable}" not found`);
    const arr = ctx.arrays.get(state.variable)!;
    // Build a slice spec: one index per leading dim, null (=all) for the grid dim.
    const sliceSpec: (number | zarr.Slice | null)[] = [
      ...varMeta.dims.map((d) => state.dimIndices[d.name] ?? 0),
      null,
    ];
    log.debug(
      `load slice: ${state.variable} [${sliceSpec.map((s) => (s === null ? ":" : s)).join(",")}]`,
    );
    const chunk = await zarr.get(
      arr as zarr.Array<zarr.NumberDataType, zarr.Readable>,
      sliceSpec,
      { signal },
    );
    const raw = chunk.data as ArrayLike<number>;
    const values = new Float32Array(raw.length);
    for (let i = 0; i < raw.length; i++) {
      const v = Number(raw[i]);
      values[i] =
        varMeta.fillValue !== null && v === varMeta.fillValue
          ? Number.NaN
          : v * varMeta.scaleFactor + varMeta.addOffset;
    }
    const slice: UnstructuredSlice = { __ungrid: true, values };
    return slice as unknown as zarr.Group<zarr.Readable>;
  },

  resolveNodeDeps: (state) => [
    state.variable,
    ...Object.keys(state.dimIndices)
      .sort()
      .map((k) => `${k}=${state.dimIndices[k]}`),
  ],

  statsDeps: (state) => [state.variable],

  buildLayer({ ctx, state, chassisState, autoStats, node }) {
    if (!node) return null;
    // Detect our sentinel type (resolveNode casts UnstructuredSlice → Group).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const raw = node as any;
    if (!raw.__ungrid) return null;
    const slice = raw as UnstructuredSlice;

    const varMeta = ctx.variables.find((v) => v.name === state.variable);
    if (!varMeta) return null;

    const colormap = chassisState.colormap ?? "viridis";
    const lut = getColormapLut(colormap);
    const autoRange = autoStats?.global;
    const rMin = chassisState.rescale?.[0] ?? autoRange?.min ?? 0;
    const rMax = chassisState.rescale?.[1] ?? autoRange?.max ?? 1;
    const range = Math.max(rMax - rMin, 1e-9);
    const maskBelow = chassisState.maskBelow;
    const maskAbove = chassisState.maskAbove;

    const { values } = slice;
    const nPoints = ctx.nPoints;
    const colors = new Uint8Array(nPoints * 4);
    for (let i = 0; i < nPoints; i++) {
      const v = values[i]!;
      if (
        Number.isNaN(v) ||
        (maskBelow && v < rMin) ||
        (maskAbove && v > rMax)
      ) {
        // alpha stays 0 → transparent
        continue;
      }
      const t = Math.max(0, Math.min(1, (v - rMin) / range));
      const o = i * 4;
      if (lut) {
        const ci = Math.round(t * 255) * 4;
        colors[o] = lut[ci]!;
        colors[o + 1] = lut[ci + 1]!;
        colors[o + 2] = lut[ci + 2]!;
        colors[o + 3] = 255;
      } else {
        const g = Math.round(t * 255);
        colors[o] = g;
        colors[o + 1] = g;
        colors[o + 2] = g;
        colors[o + 3] = 255;
      }
    }

    storeSlice(sliceKey(state), values);

    return new ScatterplotLayer({
      id: `unstructured-grid-${state.variable}`,
      // Binary data attributes: positions from the cached Float32Array,
      // colors recomputed on every render (colormap/rescale changes are
      // detected via the useMemo deps in App.tsx that include chassisState).
      data: {
        length: nPoints,
        attributes: {
          getPosition: { value: ctx.positions, size: 2 },
          getFillColor: { value: colors, size: 4, normalized: false },
        },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any,
      getRadius: 15000,
      radiusUnits: "meters",
      radiusMinPixels: 1,
      radiusMaxPixels: 15,
      stroked: false,
      opacity: chassisState.opacity,
      getPosition: [0, 0] as [number, number],
      getFillColor: [128, 128, 128, 255] as [number, number, number, number],
    });
  },

  sampleValue(ctx, state, lng, lat) {
    const varMeta = ctx.variables.find((v) => v.name === state.variable);
    if (!varMeta) return null;
    const values = sliceCache.get(sliceKey(state));
    if (!values) return null;

    // O(n) nearest-neighbor scan — ~1 ms for 542 K points, acceptable.
    const pos = ctx.positions;
    let bestIdx = -1;
    let bestDist = Infinity;
    for (let i = 0; i < ctx.nPoints; i++) {
      const dLon = pos[i * 2]! - lng;
      const dLat = pos[i * 2 + 1]! - lat;
      const d = dLon * dLon + dLat * dLat;
      if (d < bestDist) {
        bestDist = d;
        bestIdx = i;
      }
    }
    if (bestIdx < 0) return null;
    const v = values[bestIdx]!;
    if (Number.isNaN(v)) {
      return {
        label: varMeta.longName ?? varMeta.name,
        value: null,
        units: varMeta.units,
      };
    }
    return {
      label: varMeta.longName ?? varMeta.name,
      value: v,
      units: varMeta.units,
    };
  },

  async computeAutoStats({ ctx, state, signal }) {
    const varMeta = ctx.variables.find((v) => v.name === state.variable);
    if (!varMeta) return null;
    const arr = ctx.arrays.get(state.variable);
    if (!arr) return null;
    const chunkSize = Math.min(
      arr.chunks[arr.chunks.length - 1] ?? ctx.nPoints,
      ctx.nPoints,
    );
    const sliceSpec: (number | zarr.Slice | null)[] = [
      ...varMeta.dims.map((d) => state.dimIndices[d.name] ?? 0),
      zarr.slice(0, chunkSize),
    ];
    const chunk = await zarr.get(
      arr as zarr.Array<zarr.NumberDataType, zarr.Readable>,
      sliceSpec,
      { signal },
    );
    if (signal.aborted) return null;
    const raw = chunk.data as ArrayLike<number>;
    const decoded = new Float32Array(raw.length);
    for (let i = 0; i < raw.length; i++) {
      const v = Number(raw[i]);
      decoded[i] =
        varMeta.fillValue !== null && v === varMeta.fillValue ? Number.NaN : v;
    }
    const stats = buildBandStats(decoded, null);
    return stats ? autoStatsFromGlobal(stats) : null;
  },
};
