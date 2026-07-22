import * as zarr from "zarrita";
import { createLogger } from "../../../log";
import { ReportingZarrLayer } from "../../../render/reporting-zarr-layer";
import { buildSingleBandRenderTile } from "../../../render/single-band-pipeline";
import type { MultiBandTileData } from "../../../render/shared-textures";
import { autoStatsFromGlobal, buildBandStats } from "../../../render/stats";
import { readSampleValue } from "../../../render/sample-source";
import { KEEP_MIN_ZOOM_EXTENT } from "../../../render/keep-min-zoom-tiles";
import { bytesPerElement } from "../../chunk-size";
import {
  buildGeoZarrMetadata,
  buildLayoutGeoZarrMetadata,
  geoTransformToSpatial,
  parseMultiscaleDatasets,
  parseMultiscaleLayout,
} from "../../multiscale";
import { openV3Group, type OpenedStore } from "../../load-zarr";
import type { ZarrProfile } from "../../profile";
import { geographicBounds, mercatorBounds } from "../../data-bounds";
import { deriveMinZoom, spatialPair } from "../scalar-grid/profile";
import { buildDimLabel } from "../scalar-grid/cf-coords";
import { makeScalarGridTileLoader } from "../scalar-grid/tile-loader";
import { MultiscaleGridControls } from "./controls";
import {
  defaultDimIndices,
  type MultiscaleGridContext,
  type MultiscaleGridState,
  type MultiscaleGridVariable,
} from "./types";

const log = createLogger("profile");

/** Name of the data array inside each `<scale>/` level group. CF/rioxarray
 * multiscale stores name it after the variable; Meta CHM uses `chm`. We pick
 * the single array child that isn't the CF `spatial_ref` grid-mapping aux. */
function pickLevelArrayName(
  contents: { path: string; kind: "array" | "group" }[],
  scale: string,
): string | null {
  const prefix = `${scale}/`;
  const arrays = contents
    .filter((e) => e.kind === "array")
    .map((e) => e.path.replace(/^\/+/, ""))
    .filter((p) => p.startsWith(prefix) && !p.slice(prefix.length).includes("/"))
    .map((p) => p.slice(prefix.length));
  const data = arrays.find((n) => n !== "spatial_ref");
  return data ?? null;
}

const R = 6378137; // WGS84 semi-major axis (EPSG:3857 sphere radius)
const mercX = (lng: number) => R * (lng * Math.PI) / 180;
const mercY = (lat: number) =>
  R * Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));

/** True when `code` is a geographic (lat/lon degrees) EPSG CRS, vs. a
 * projected (metric, e.g. EPSG:3857 mercator) one. Shared by every place in
 * this profile that needs to pick between a degrees-native affine and a
 * mercX/mercY-projected one. */
function isGeographicCrs(code: string | null): boolean {
  return code != null && /4326|4269|4258/.test(code);
}

const COORD_AUX = new Set(["spatial_ref", "latitude", "longitude", "lat", "lon", "x", "y", "time"]);

/** Enumerate renderable data variables in a pyramid's finest level group.
 * A data variable is an array whose trailing two dims are the lat/lon spatial
 * pair (via {@link spatialPair}); coordinate/aux arrays are excluded. Returns
 * the array names + their leading (non-spatial) dims. */
async function enumerateLayoutVariables(
  group: zarr.Group<zarr.Readable>,
  finestLevel: string,
  contents: { path: string; kind: "array" | "group" }[],
): Promise<{ name: string; arr: zarr.Array<zarr.DataType, zarr.Readable>; dims: { name: string; size: number }[] }[]> {
  const prefix = `${finestLevel}/`;
  const names = contents
    .filter((e) => e.kind === "array")
    .map((e) => e.path.replace(/^\/+/, ""))
    .filter((p) => p.startsWith(prefix) && !p.slice(prefix.length).includes("/"))
    .map((p) => p.slice(prefix.length))
    .filter((n) => !COORD_AUX.has(n));
  const out: { name: string; arr: zarr.Array<zarr.DataType, zarr.Readable>; dims: { name: string; size: number }[] }[] = [];
  for (const name of names) {
    const arr = await zarr.open(group.resolve(`${finestLevel}/${name}`), { kind: "array" });
    const dimNames = arr.dimensionNames;
    if (!spatialPair(dimNames)) continue; // not a spatial data variable
    const lead = (dimNames ?? []).slice(0, arr.shape.length - 2);
    const dims = lead.map((dn, i) => ({ name: String(dn), size: arr.shape[i]! }));
    out.push({ name, arr, dims });
  }
  return out;
}

function numAttr(v: unknown): number | null {
  const n = typeof v === "string" ? Number(v) : (v as number);
  return typeof n === "number" && Number.isFinite(n) ? n : null;
}

/** Native `zarr-conventions/multiscales` `{ layout }` schema branch — one or
 * more variables, each present at every pyramid level as `<level>/<var>`. */
async function prepareLayout(
  url: string,
  opened: OpenedStore,
  contents: { path: string; kind: "array" | "group" }[],
  layout: NonNullable<ReturnType<typeof parseMultiscaleLayout>>,
  signal: AbortSignal,
): Promise<MultiscaleGridContext> {
  // layout.levels is finest-first; level group path = asset ("0".."3").
  const finest = layout.levels[0]!.asset;
  const coarsest = layout.levels[layout.levels.length - 1]!.asset;
  const found = await enumerateLayoutVariables(opened.group, finest, contents);
  if (found.length === 0) {
    throw new Error("Multiscale layout store: no lat/lon data variables found in the finest level.");
  }

  const variables: MultiscaleGridVariable[] = found.map((f) => ({
    name: f.name,
    longName: typeof f.arr.attrs.long_name === "string" ? f.arr.attrs.long_name : null,
    units: typeof f.arr.attrs.units === "string" ? f.arr.attrs.units : null,
    dtype: f.arr.dtype,
    fillValue: numAttr(f.arr.attrs._FillValue),
    dims: f.dims,
    metadata: buildLayoutGeoZarrMetadata({ layout, variable: f.name }),
  }));

  // CF dim labels for each non-spatial dim (coord array lives in the finest level group).
  const dimLabel: Record<string, (idx: number) => string> = {};
  for (const v of variables) {
    for (const d of v.dims) {
      if (signal.aborted) break;
      if (!dimLabel[d.name]) dimLabel[d.name] = await buildDimLabel(opened.group, `${finest}/${d.name}`, d.size);
    }
  }

  // Coarsest-level array of the default variable, for auto-stats sampling.
  const defaultVar = variables.find((v) => v.name === "NDVI") ?? variables[0]!;
  const coarsestArray = await zarr.open(opened.group.resolve(`${coarsest}/${defaultVar.name}`), { kind: "array" });
  const coarsestTransform = layout.levels[layout.levels.length - 1]!["spatial:transform"];

  const crsCode = layout.crs.code ?? null;
  // Downsample per level (coarsest-first) from the finest pixel size.
  const finestScaleX = Math.abs(layout.levels[0]!["spatial:transform"][0]);
  const levelDownsamples = [...layout.levels].reverse().map((l) =>
    finestScaleX > 0 ? Math.round(Math.abs(l["spatial:transform"][0]) / finestScaleX) : 1,
  );
  // Geographic layout grids render at z0; a projected layout would need a
  // metric gate (future work).
  const minRenderZoom = 0;

  log.info(
    `prepared multiscale-layout ${variables.length} var(s) ${layout.levels.length} levels, ` +
      `crs=${crsCode ?? "wkt"}, default="${defaultVar.name}", minRenderZoom=${minRenderZoom}`,
  );

  return {
    url,
    group: opened.group,
    store: opened.store,
    variables,
    levelCount: layout.levels.length,
    levelDownsamples,
    crsCode,
    coarsestArray,
    coarsestTransform,
    dimLabel,
    minRenderZoom,
  };
}

/** Legacy CF/rioxarray `multiscales:[{datasets}]` schema branch (e.g. Meta
 * CHM v2) — a single 2-D `[y,x]` variable, georeferenced via a `spatial_ref`
 * aux array (`crs_wkt` + GDAL `GeoTransform`) at each level. */
async function prepareCf(
  url: string,
  opened: OpenedStore,
  contents: { path: string; kind: "array" | "group" }[],
  signal: AbortSignal,
): Promise<MultiscaleGridContext> {
  const datasets = parseMultiscaleDatasets(opened.group.attrs); // coarsest→finest
  if (!datasets) {
    throw new Error("Not a multiscale store (no `multiscales` root attr).");
  }

  const levels: {
    asset: string;
    geoTransform: number[];
    shape: [number, number];
  }[] = [];
  let crsWkt = "";
  let crsCode: string | null = null;
  let dtype = "";
  let units: string | null = null;
  let longName: string | null = null;
  let variable = "chm";
  let coarsestArray: zarr.Array<zarr.DataType, zarr.Readable> | null = null;
  let coarsestGeoTransform: number[] = [];
  let finestPixelMeters = 0;
  let dims: [string, string] = ["y", "x"];

  for (let i = 0; i < datasets.length; i++) {
    if (signal.aborted) throw new Error("aborted");
    const scale = datasets[i]!;
    const arrName = pickLevelArrayName(contents, scale) ?? "chm";
    const chm = await zarr.open(
      opened.group.resolve(`${scale}/${arrName}`),
      { kind: "array" },
    );
    const sr = await zarr.open(
      opened.group.resolve(`${scale}/spatial_ref`),
      { kind: "array" },
    );
    const nd = chm.shape.length;
    if (nd !== 2) {
      throw new Error(
        `Multiscale store: only 2-D [y,x] variables are supported (got ${nd}-D "${scale}/${arrName}").`,
      );
    }
    const gt = String(sr.attrs.GeoTransform ?? "")
      .trim()
      .split(/\s+/)
      .map(Number);
    if (gt.length < 6 || gt.some((n) => !Number.isFinite(n))) {
      throw new Error(
        `Multiscale store: invalid GeoTransform on "${scale}/spatial_ref".`,
      );
    }
    levels.push({
      asset: `${scale}/${arrName}`,
      geoTransform: gt,
      shape: [chm.shape[0]!, chm.shape[1]!],
    });
    if (typeof sr.attrs.crs_wkt === "string") crsWkt = sr.attrs.crs_wkt;
    if (typeof sr.attrs["proj:code"] === "string")
      crsCode = sr.attrs["proj:code"];
    if (i === 0) {
      coarsestArray = chm;
      coarsestGeoTransform = gt;
    }
    if (i === datasets.length - 1) {
      variable = arrName;
      dtype = chm.dtype;
      units = typeof chm.attrs.units === "string" ? chm.attrs.units : null;
      longName =
        typeof chm.attrs.long_name === "string" ? chm.attrs.long_name : null;
      finestPixelMeters = Math.abs(gt[1]!);
      const dn = chm.dimensionNames;
      if (Array.isArray(dn) && dn.length === 2 && dn.every((d) => typeof d === "string")) {
        dims = [dn[0] as string, dn[1] as string];
      }
    }
  }
  if (!crsWkt) {
    throw new Error(
      "Multiscale store: no `crs_wkt` found in `spatial_ref` (can't resolve CRS).",
    );
  }
  const metadata = buildGeoZarrMetadata({ levels, crsWkt, dims });
  // Downsample factor for each level relative to the finest (coarsest-first,
  // matching displayIndex order). Round to nearest integer to avoid floating-
  // point drift (pixel sizes are typically exact power-of-2 multiples).
  const levelDownsamples = finestPixelMeters > 0
    ? levels.map((l) => Math.round(Math.abs(l.geoTransform[1]!) / finestPixelMeters))
    : levels.map((_, i) => Math.round(Math.pow(2, levels.length - 1 - i)));
  // Memory gate: the coarsest level has no coarser overview, so deck.gl clamps
  // to it when zoomed out and enumerates every viewport tile at its native
  // resolution (CHM: ~76 m/px, 512² chunks) — thousands continent-wide (~7 GB).
  // Gate LOADING (not rendering) below the zoom where a coarsest-level viewport
  // fill stays within the fetch budget; below it, already-loaded tiles freeze
  // (installKeepMinZoomTiles) and <ZoomHint> shows. The GeoTransform pixel size
  // is in the store's CRS units and deriveMinZoom expects metres — EPSG:3857
  // (this store) is metric, so use it directly; for a geographic CRS skip the
  // gate rather than mis-gate with a degrees value.
  const coarse = coarsestArray!;
  const cn = coarse.chunks.length;
  const minRenderZoom = isGeographicCrs(crsCode)
    ? 0
    : deriveMinZoom(
        Math.abs(coarsestGeoTransform[1] ?? 0),
        coarse.chunks[cn - 1] ?? 512,
        coarse.chunks[cn - 2] ?? 512,
        bytesPerElement(coarse.dtype),
        coarse.shape[cn - 1],
        coarse.shape[cn - 2],
      );
  log.info(
    `prepared multiscale "${variable}" ${dtype} ${datasets.length} levels, ` +
      `${finestPixelMeters.toFixed(2)} m/px native, crs=${crsCode ?? "wkt"}, ` +
      `minRenderZoom=${minRenderZoom}`,
  );
  const oneVar: MultiscaleGridVariable = {
    name: variable,
    longName,
    units,
    dtype,
    fillValue: null,
    dims: [],
    metadata,
  };
  return {
    url,
    group: opened.group,
    store: opened.store,
    variables: [oneVar],
    levelCount: datasets.length,
    levelDownsamples,
    crsCode,
    coarsestArray: coarsestArray!,
    coarsestTransform: geoTransformToSpatial(coarsestGeoTransform),
    dimLabel: {},
    minRenderZoom,
  };
}

export const multiscaleGridProfile: ZarrProfile<
  MultiscaleGridState,
  MultiscaleGridContext
> = {
  id: "multiscale-grid",
  label: "Multiscale grid (colormap)",
  needsColormap: true,

  async prepare(url, signal, open = {}) {
    const done = log.time("multiscale-grid prepare", "info");
    const opened = await openV3Group(url, { consolidated: true, ...open });
    const contents =
      (opened.store as { contents?: () => { path: string; kind: "array" | "group" }[] }).contents?.() ?? [];

    const layout = parseMultiscaleLayout(opened.group.attrs);
    const ctx = layout
      ? await prepareLayout(url, opened, contents, layout, signal)
      : await prepareCf(url, opened, contents, signal);
    done();
    return ctx;
  },

  initialState(ctx) {
    const preferred = ["NDVI"];
    const variable = preferred.find((p) => ctx.variables.some((v) => v.name === p))
      ?? ctx.variables[0]!.name;
    const v = ctx.variables.find((x) => x.name === variable)!;
    return { variable, dimIndices: defaultDimIndices(v) };
  },
  parseUrlParams(p) {
    const out: Partial<MultiscaleGridState> = {};
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
    for (const [name, idx] of Object.entries(s.dimIndices)) out[`dim.${name}`] = String(idx);
    return out;
  },
  initialBounds: () => [-180, -85.0511, 180, 85.0511],

  // Data extent (any level covers the same area) for the intro fly-in. The
  // layout transform is EPSG:3857 metres for a projected store; a geographic
  // CRS (e.g. the native-layout NDVI reference store) stores degrees.
  dataBounds: (ctx, state) => {
    const v = ctx.variables.find((x) => x.name === state.variable) ?? ctx.variables[0];
    const layout = v?.metadata.multiscales.layout[0];
    if (!layout) return null;
    const transform = layout["spatial:transform"];
    const shape = layout["spatial:shape"];
    return isGeographicCrs(ctx.crsCode)
      ? geographicBounds(transform, shape)
      : mercatorBounds(transform, shape);
  },

  // Native resolution from the finest level (layout[0]) — degrees for a
  // geographic CRS, else EPSG:3857 mercator metres.
  nativeResolution: (ctx, state) => {
    const v = ctx.variables.find((x) => x.name === state.variable) ?? ctx.variables[0];
    const layout = v?.metadata.multiscales.layout[0];
    const step = Math.abs(layout?.["spatial:transform"]?.[0] ?? 0);
    if (!(step > 0)) return null;
    return isGeographicCrs(ctx.crsCode)
      ? { kind: "degrees", value: step }
      : { kind: "mercator-meters", value: step };
  },

  Controls: MultiscaleGridControls,

  resolveNode: async (ctx) => ctx.group,
  resolveNodeDeps: (s) => [s.variable],
  statsDeps: (s) => [s.variable],

  buildLayer({ ctx, state, chassisState, colormapTexture, autoStats, basemapBeforeId, node }) {
    if (!node || !colormapTexture) return null;
    const v = ctx.variables.find((x) => x.name === state.variable);
    if (!v) return null;
    const selection: Record<string, number> = {};
    for (const d of v.dims) selection[d.name] = state.dimIndices[d.name] ?? 0;
    const renderTile = buildSingleBandRenderTile(
      {
        colormap: chassisState.colormap ?? "viridis",
        rescale: chassisState.rescale,
        gamma: chassisState.gamma,
        stretch: chassisState.stretch,
        maskBelow: chassisState.maskBelow,
        maskAbove: chassisState.maskAbove,
        nodata: null,
      },
      colormapTexture,
      autoStats,
    );
    const pinnedKey = Object.entries(selection).map(([k, i]) => `${k}=${i}`).join(",");
    return new ReportingZarrLayer<zarr.Readable, zarr.DataType, MultiBandTileData>({
      id: `multiscale-grid-${state.variable}-${pinnedKey}`,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      node: node as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      metadata: v.metadata as any,
      selection,
      getTileData: makeScalarGridTileLoader({
        fillValue: v.fillValue,
        sampleKeyForZ: (z) => `${state.variable}:z${z}`,
      }),
      renderTile,
      opacity: chassisState.opacity,
      // Stop fetching new tiles when zoomed out past the coarsest level's
      // budget floor; the non-null extent keeps already-loaded tiles painted
      // (vs. blanking) — see installKeepMinZoomTiles / scalar-grid.
      minZoom: chassisState.minZoomOverride ?? ctx.minRenderZoom,
      extent: KEEP_MIN_ZOOM_EXTENT,
      maxRequests: 20,
      maxCacheSize: 64,
      // beforeId is injected by @deck.gl/mapbox; attach via a wider cast.
      ...({ beforeId: basemapBeforeId } as Record<string, unknown>),
      updateTriggers: {
        renderTile: [
          chassisState.colormap,
          chassisState.rescale?.[0],
          chassisState.rescale?.[1],
          chassisState.gamma,
          chassisState.stretch,
          chassisState.maskBelow,
          chassisState.maskAbove,
          autoStats,
        ],
      },
    });
  },

  async computeAutoStats({ ctx, signal }) {
    // Sample a representative (vegetated) patch of the coarsest level of the
    // DEFAULT variable rather than the world centre (which is ocean): map an
    // Amazon lng/lat to the coarsest level's pixel grid via its layout
    // transform. Any leading (non-spatial) dims — e.g. a layout store's
    // `time` — are pinned to index 0 so the sliced patch stays 2-D.
    const arr = ctx.coarsestArray;
    const nd = arr.shape.length;
    const h = arr.shape[nd - 2]!;
    const w = arr.shape[nd - 1]!;
    const ph = Math.min(arr.chunks[nd - 2] ?? h, h);
    const pw = Math.min(arr.chunks[nd - 1] ?? w, w);
    const t = ctx.coarsestTransform;
    const [px, , ox, , py, oy] = t;
    const geographic = isGeographicCrs(ctx.crsCode);
    const [mx, my] = geographic ? [-62, -4] : [mercX(-62), mercY(-4)];
    const centerCol = (mx - (ox ?? 0)) / (px || 1);
    const centerRow = (my - (oy ?? 0)) / (py || -1);
    const clamp = (v: number, max: number) => Math.max(0, Math.min(max, v));
    const rowStart = clamp(Math.floor(centerRow - ph / 2), Math.max(0, h - ph));
    const colStart = clamp(Math.floor(centerCol - pw / 2), Math.max(0, w - pw));
    const sliceSpec: (number | zarr.Slice)[] = [
      ...(Array(Math.max(0, nd - 2)).fill(0) as number[]),
      zarr.slice(rowStart, rowStart + ph),
      zarr.slice(colStart, colStart + pw),
    ];
    let chunk: Awaited<ReturnType<typeof zarr.get>>;
    try {
      chunk = await zarr.get(
        arr as zarr.Array<zarr.NumberDataType, zarr.Readable>,
        sliceSpec,
        { signal },
      );
    } catch (err) {
      // The sample patch may sit on an unreadable/missing chunk (e.g. a store
      // whose data chunks icechunk-js can't resolve). Degrade gracefully —
      // the rescale falls back to its manual default.
      log.debug("computeAutoStats sample read failed", err);
      return null;
    }
    if (signal.aborted) return null;
    const raw = chunk.data as ArrayLike<number>;
    const decoded = new Float32Array(raw.length);
    for (let i = 0; i < raw.length; i++) decoded[i] = Number(raw[i]);
    const stats = buildBandStats(decoded, null);
    return stats ? autoStatsFromGlobal(stats) : null;
  },

  sampleValue(ctx, state, lng, lat) {
    const v = ctx.variables.find((x) => x.name === state.variable);
    if (!v) return null;
    const layouts = v.metadata.multiscales.layout; // finest-first (layout[0] = finest)
    const N = layouts.length;
    const geographic = isGeographicCrs(ctx.crsCode);
    const [mx, my] = geographic ? [lng, lat] : [mercX(lng), mercY(lat)];
    // deck.gl z=0 = coarsest (layout[N-1]), z=N-1 = finest (layout[0]).
    // Try finest level first — it has the most detail. Fall back to coarser
    // levels when a finer tile hasn't been loaded at the current hover point.
    for (let z = N - 1; z >= 0; z--) {
      const layoutIndex = N - 1 - z;
      const layout = layouts[layoutIndex];
      if (!layout) continue;
      const t = layout["spatial:transform"]; // [scaleX, 0, originX, 0, scaleY, originY]
      const shape = layout["spatial:shape"]; // [height, width]
      const col = Math.floor((mx - t[2]) / t[0]);
      const row = Math.floor((my - t[5]) / t[4]);
      if (col < 0 || col >= shape[1] || row < 0 || row >= shape[0]) continue;
      const value = readSampleValue(`${state.variable}:z${z}`, row, col, 0);
      if (value !== null) {
        return {
          label: v.longName ?? v.name,
          value: Number.isNaN(value) ? null : value,
          units: v.units,
        };
      }
    }
    return null;
  },

  pyramidLevelCount: (ctx) => ctx.levelCount,
  pyramidLevelDownsamples: (ctx) => ctx.levelDownsamples,

  getStructure: (ctx, state) => {
    const v = ctx.variables.find((x) => x.name === state.variable) ?? ctx.variables[0]!;
    // The metadata's layout is finest-first, so layout[0].asset is the
    // primary (finest) array path for this variable in either schema.
    const finestAsset = v.metadata.multiscales.layout[0]?.asset ?? v.name;
    return {
      zarrVersion: "v3",
      variables: [{ path: finestAsset, role: "finest" }],
      metadataSource: "synthesized",
      metadata: v.metadata,
    };
  },
};
