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
  UnstructuredGridStoreError,
  detectUnstructuredVariable,
} from "./detect";
import {
  defaultUnstructuredDimIndices,
  type UnstructuredGridContext,
  type UnstructuredGridState,
  type UnstructuredGridVariable,
  type UnstructuredSlice,
} from "./types";

export { UnstructuredGridStoreError, detectUnstructuredVariable };

const log = createLogger("unstructured-grid");

function sliceKey(state: UnstructuredGridState): string {
  const dims = Object.keys(state.dimIndices)
    .sort()
    .map((k) => `${k}=${state.dimIndices[k]}`)
    .join(",");
  return `${state.variable}|${dims}`;
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
  needsCpuLut: true,

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

    // Await the default colormap LUT so the first buildLayer call has it.
    await loadColormapLut("viridis").catch((e) =>
      log.warn("failed to load colormap LUT", e),
    );

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
      sliceMap: new Map(),
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
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < raw.length; i++) {
      const v = Number(raw[i]);
      const decoded =
        varMeta.fillValue !== null && v === varMeta.fillValue
          ? Number.NaN
          : v * varMeta.scaleFactor + varMeta.addOffset;
      values[i] = decoded;
      if (Number.isFinite(decoded)) {
        if (decoded < lo) lo = decoded;
        if (decoded > hi) hi = decoded;
      }
    }
    // Store decoded values in context so sampleValue can read them without
    // depending on buildLayer side-effects.
    ctx.sliceMap.set(sliceKey(state), values);
    log.debug(
      `decode: raw[0]=${Number(raw[0])} fillValue=${varMeta.fillValue} ` +
      (Number.isFinite(lo)
        ? `range=[${lo.toFixed(4)}, ${hi.toFixed(4)}]`
        : "range=none (all fill/NaN)"),
    );
    const fallbackRange: [number, number] | null = Number.isFinite(lo)
      ? [lo, hi]
      : null;
    const slice: UnstructuredSlice = { __ungrid: true, values, fallbackRange };
    return slice as unknown as zarr.Group<zarr.Readable>;
  },

  resolveNodeDeps: (state) => [
    state.variable,
    ...Object.keys(state.dimIndices)
      .sort()
      .map((k) => `${k}=${state.dimIndices[k]}`),
  ],

  // Include dim indices so the range is recomputed when the time index changes.
  statsDeps: (state) => [
    state.variable,
    ...Object.keys(state.dimIndices)
      .sort()
      .map((k) => `${k}=${state.dimIndices[k]}`),
  ],

  buildLayer({ ctx, state, chassisState, autoStats, basemapBeforeId, node }) {
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

    // Resolve the display range: explicit rescale wins; then autoStats
    // percentile range; then the inline min/max computed in resolveNode as a
    // fallback so points appear immediately even before computeAutoStats
    // returns. Only return null when there are literally no valid values.
    const rMin =
      chassisState.rescale?.[0] ??
      autoRange?.min ??
      slice.fallbackRange?.[0];
    const rMax =
      chassisState.rescale?.[1] ??
      autoRange?.max ??
      slice.fallbackRange?.[1];
    if (rMin == null || rMax == null) return null;
    const range = Math.max(rMax - rMin, 1e-9);
    const maskBelow = chassisState.maskBelow;
    const maskAbove = chassisState.maskAbove;

    // Cache colors on the slice object — reuse when colormap/range/masks
    // haven't changed (e.g. only opacity changed), avoiding 542K iterations
    // and a GPU buffer re-upload.
    const colorKey = `${colormap}|${rMin}|${rMax}|${maskBelow}|${maskAbove}|${lut !== null}`;
    let colors: Uint8Array;
    if (slice.cachedColors?.key === colorKey) {
      colors = slice.cachedColors.colors;
    } else {
      const { values } = slice;
      const nPoints = ctx.nPoints;
      colors = new Uint8Array(nPoints * 4);
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
      slice.cachedColors = { key: colorKey, colors };
    }

    return new ScatterplotLayer({
      id: `unstructured-grid-${state.variable}`,
      ...({ beforeId: basemapBeforeId } as Record<string, unknown>),
      // data.attributes is required for getPosition: the instancePositions
      // attribute uses fp64 high/low encoding that only the attribute manager
      // handles when going through data.attributes (not via prop binary spec).
      // data.attributes also takes precedence over constant fallback props,
      // so we omit those fallback props to let the binary color buffer be used.
      data: {
        length: ctx.nPoints,
        attributes: {
          getPosition: { value: ctx.positions, size: 2 },
          getFillColor: { value: colors, size: 4 },
        },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any,
      getRadius: 15000,
      radiusUnits: "meters",
      radiusMinPixels: 1,
      radiusMaxPixels: 15,
      stroked: false,
      opacity: chassisState.opacity,
    });
  },

  sampleValue(ctx, state, lng, lat) {
    const varMeta = ctx.variables.find((v) => v.name === state.variable);
    if (!varMeta) return null;
    const values = ctx.sliceMap.get(sliceKey(state));
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
    // Load the full grid slice (not just the first chunk) so the stats
    // represent the whole globe, not only the northernmost band (N320 is
    // ordered by latitude). Also apply scale/offset so the range is in
    // physical units, matching the decoded values in resolveNode.
    const sliceSpec: (number | zarr.Slice | null)[] = [
      ...varMeta.dims.map((d) => state.dimIndices[d.name] ?? 0),
      null,
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
        varMeta.fillValue !== null && v === varMeta.fillValue
          ? Number.NaN
          : v * varMeta.scaleFactor + varMeta.addOffset;
    }
    const stats = buildBandStats(decoded, null);
    return stats ? autoStatsFromGlobal(stats) : null;
  },
};
