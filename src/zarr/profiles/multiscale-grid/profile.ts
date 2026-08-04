import * as zarr from "zarrita";
import { createLogger } from "../../../log";
import { ReportingZarrLayer } from "../../../render/reporting-zarr-layer";
import { buildSingleBandRenderTile } from "../../../render/single-band-pipeline";
import type { MultiBandTileData } from "../../../render/shared-textures";
import { autoStatsFromGlobal, buildBandStats } from "../../../render/stats";
import { readSampleValue } from "../../../render/sample-source";
import { KEEP_MIN_ZOOM_EXTENT } from "../../../render/keep-min-zoom-tiles";
import { bytesPerElement } from "../../chunk-size";
import { resolveCrsConverters } from "../../crs";
import {
  buildGeoZarrMetadata,
  buildLayoutGeoZarrMetadata,
  geoTransformToSpatial,
} from "../../multiscale";
import { openV3Group, type OpenedStore } from "../../load-zarr";
import type { ZarrProfile } from "../../profile";
import type { LngLatBounds } from "../../data-bounds";
import { boundsFromProjection, geographicBounds, mercatorBounds } from "../../data-bounds";
import { deriveMinZoom, spatialPair } from "../scalar-grid/profile";
import { buildDimLabel } from "../scalar-grid/cf-coords";
import { makeScalarGridTileLoader } from "../scalar-grid/tile-loader";
import { MultiscaleGridControls } from "./controls";
import { discoverPyramids, type PyramidSource } from "./discovery";
import {
  defaultDimIndices,
  type MultiscaleGridContext,
  type MultiscaleGridState,
  type MultiscaleGridVariable,
  type Pyramid,
  selectedPyramid,
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
 * projected (metric) one. */
function isGeographicCrs(code: string | null): boolean {
  return code != null && /4326|4269|4258/.test(code);
}

/** Map a lng/lat point into a pyramid's source-CRS `(x, y)` for the affine
 * inversions in `sampleValue`/`computeAutoStats`. Geographic → identity; 3857 →
 * closed-form web-mercator (offline fast path); any other projected CRS → the
 * resolved proj4 converters. Returns null when a projected CRS can't be
 * resolved. */
function lngLatToSourceCrs(p: Pyramid, lng: number, lat: number): [number, number] | null {
  if (isGeographicCrs(p.crsCode)) return [lng, lat];
  if (p.crsCode === "EPSG:3857") return [mercX(lng), mercY(lat)];
  return p.crs ? p.crs.fromLngLat(lng, lat) : null;
}

/** Lng/lat extent of a pyramid's default variable (finest level), or null.
 * Used to open the camera on the data (regional stores like the CONUS CDL would
 * otherwise open at world extent, below the coarsest level's zoom gate → blank
 * until the user zooms in). */
function defaultVarBounds(p: Pyramid): LngLatBounds | null {
  const v = p.variables.find((x) => x.name === "NDVI") ?? p.variables[0];
  const layout = v?.metadata.multiscales.layout[0];
  return layout ? levelBounds(p, layout["spatial:transform"], layout["spatial:shape"]) : null;
}

/** Lng/lat bbox of a level's affine + shape, dispatched on the pyramid CRS:
 * geographic (degrees) / 3857 (closed-form mercator) / arbitrary projected
 * (`boundsFromProjection` via the resolved converters). */
function levelBounds(
  p: Pyramid,
  transform: readonly number[],
  shape: readonly number[],
): LngLatBounds | null {
  if (isGeographicCrs(p.crsCode)) return geographicBounds(transform, shape);
  if (p.crsCode === "EPSG:3857") return mercatorBounds(transform, shape);
  return p.crs ? boundsFromProjection(transform, shape, p.crs.toLngLat) : null;
}

const COORD_AUX = new Set(["spatial_ref", "latitude", "longitude", "lat", "lon", "x", "y", "time"]);

/** Path of a level's data array, matching {@link buildLayoutGeoZarrMetadata}'s
 * asset construction: `[prefix, asset ("." → ""), variable]` joined. */
function levelVarPath(prefix: string, asset: string, variable: string): string {
  return [prefix, asset === "." ? "" : asset, variable].filter(Boolean).join("/");
}

/** Group path of a level (no variable): `[prefix, asset ("." → "")]` joined. */
function levelGroupPath(prefix: string, asset: string): string {
  return [prefix, asset === "." ? "" : asset].filter(Boolean).join("/");
}

/** Enumerate renderable data variables in a pyramid's finest level group.
 * A data variable is an array whose trailing two dims are the lat/lon spatial
 * pair (via {@link spatialPair}); coordinate/aux arrays are excluded. Returns
 * the array names + their leading (non-spatial) dims. `finestGroupPath` is the
 * finest level's full group path (e.g. "0" at root, or "10m" for a nested
 * pyramid whose finest asset is "."). */
export async function enumerateLayoutVariables(
  group: zarr.Group<zarr.Readable>,
  finestGroupPath: string,
  contents: { path: string; kind: "array" | "group" }[],
): Promise<{ name: string; arr: zarr.Array<zarr.DataType, zarr.Readable>; dims: { name: string; size: number }[] }[]> {
  // `finestGroupPath === ""` means the pyramid is rooted at the store root
  // (finest asset "."), so its arrays are the root-level nodes (no "/"). A
  // non-empty path scopes to `<path>/<name>` children.
  const isRoot = finestGroupPath === "";
  const prefix = `${finestGroupPath}/`;
  const names = contents
    .filter((e) => e.kind === "array")
    .map((e) => e.path.replace(/^\/+/, ""))
    .filter((p) =>
      isRoot
        ? !p.includes("/")
        : p.startsWith(prefix) && !p.slice(prefix.length).includes("/"),
    )
    .map((p) => (isRoot ? p : p.slice(prefix.length)))
    .filter((n) => !COORD_AUX.has(n));
  const out: { name: string; arr: zarr.Array<zarr.DataType, zarr.Readable>; dims: { name: string; size: number }[] }[] = [];
  for (const name of names) {
    const path = isRoot ? name : `${finestGroupPath}/${name}`;
    let arr: zarr.Array<zarr.DataType, zarr.Readable>;
    try {
      arr = await zarr.open(group.resolve(path), { kind: "array" });
    } catch (err) {
      // A non-data node zarrita can't open (e.g. the FTW store's `band`
      // fixed_length_utf32 coord array) must not abort enumeration.
      log.debug(`enumerateLayoutVariables: skip "${path}" (open failed)`, err);
      continue;
    }
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
 * more variables, each present at every pyramid level as `<prefix>/<level>/<var>`.
 * `src.prefix` roots the pyramid at a child group ("" = store root). */
async function prepareLayoutPyramid(
  opened: OpenedStore,
  contents: { path: string; kind: "array" | "group" }[],
  src: PyramidSource,
  signal: AbortSignal,
): Promise<Pyramid> {
  const layout = src.layout!; // caller guarantees a layout source
  const finestGroup = levelGroupPath(src.prefix, layout.levels[0]!.asset);
  const coarsestAsset = layout.levels[layout.levels.length - 1]!.asset;
  const found = await enumerateLayoutVariables(opened.group, finestGroup, contents);
  if (found.length === 0) {
    throw new Error(`Multiscale layout pyramid "${src.label}": no lat/lon data variables in the finest level.`);
  }

  const variables: MultiscaleGridVariable[] = found.map((f) => ({
    name: f.name,
    longName: typeof f.arr.attrs.long_name === "string" ? f.arr.attrs.long_name : null,
    units: typeof f.arr.attrs.units === "string" ? f.arr.attrs.units : null,
    dtype: f.arr.dtype,
    fillValue: numAttr(f.arr.attrs._FillValue),
    dims: f.dims,
    metadata: buildLayoutGeoZarrMetadata({ layout, variable: f.name, subgroupPrefix: src.prefix }),
  }));

  // CF dim labels for each non-spatial dim (coord array lives in the finest level group).
  const dimLabel: Record<string, (idx: number) => string> = {};
  for (const v of variables) {
    for (const d of v.dims) {
      if (signal.aborted) break;
      if (!dimLabel[d.name]) {
        // finestGroup "" (a "."-rooted pyramid) → coord array is at the root.
        const coordPath = finestGroup ? `${finestGroup}/${d.name}` : d.name;
        dimLabel[d.name] = await buildDimLabel(opened.group, coordPath, d.size);
      }
    }
  }

  // Coarsest-level array of the default variable, for auto-stats sampling.
  const defaultVar = variables.find((v) => v.name === "NDVI") ?? variables[0]!;
  const coarsestArray = await zarr.open(
    opened.group.resolve(levelVarPath(src.prefix, coarsestAsset, defaultVar.name)),
    { kind: "array" },
  );
  const coarsestTransform = layout.levels[layout.levels.length - 1]!["spatial:transform"];

  const crsCode = src.crsCode;
  const crs = await resolveCrsConverters({ code: src.crsCode, wkt2: src.crsWkt });

  // Downsample per level (coarsest-first) from the finest pixel size.
  const finestScaleX = Math.abs(layout.levels[0]!["spatial:transform"][0]);
  const levelDownsamples = [...layout.levels].reverse().map((l) =>
    finestScaleX > 0 ? Math.round(Math.abs(l["spatial:transform"][0]) / finestScaleX) : 1,
  );
  // Memory gate on the coarsest level. Geographic (degrees) → skip the gate.
  // A projected CRS's affine is in metres (EPSG:5070/3857), which deriveMinZoom
  // expects — the coarsest transform's [0] is the pixel size in CRS units.
  const cn = coarsestArray.chunks.length;
  const minRenderZoom = isGeographicCrs(crsCode)
    ? 0
    : deriveMinZoom(
        Math.abs((coarsestTransform[0] as number) ?? 0),
        coarsestArray.chunks[cn - 1] ?? 512,
        coarsestArray.chunks[cn - 2] ?? 512,
        bytesPerElement(coarsestArray.dtype),
        coarsestArray.shape[coarsestArray.shape.length - 1],
        coarsestArray.shape[coarsestArray.shape.length - 2],
      );

  log.info(
    `prepared layout pyramid "${src.label}" ${variables.length} var(s) ${layout.levels.length} levels, ` +
      `crs=${crsCode ?? "wkt"}, default="${defaultVar.name}", minRenderZoom=${minRenderZoom}`,
  );

  return {
    prefix: src.prefix,
    label: src.label,
    variables,
    levelCount: layout.levels.length,
    levelDownsamples,
    crsCode,
    crs,
    coarsestArray,
    coarsestTransform,
    dimLabel,
    minRenderZoom,
  };
}

/** Legacy CF/rioxarray `multiscales:[{datasets}]` schema branch (e.g. Meta
 * CHM v2) — a single 2-D `[y,x]` variable, georeferenced via a `spatial_ref`
 * aux array (`crs_wkt` + GDAL `GeoTransform`) at each level. Only the store root
 * is supported for this schema today (nested-CF pyramids are a follow-up). */
async function prepareCfPyramid(
  opened: OpenedStore,
  contents: { path: string; kind: "array" | "group" }[],
  src: PyramidSource,
  signal: AbortSignal,
): Promise<Pyramid> {
  if (src.prefix !== "") {
    throw new Error(
      "Nested CF/rioxarray multiscale pyramids (multiscales on a child group with the " +
        "`datasets` schema) are not yet supported.",
    );
  }
  const datasets = src.datasets!; // coarsest→finest; caller guarantees a datasets source

  const levels: { asset: string; geoTransform: number[]; shape: [number, number] }[] = [];
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
    const chm = await zarr.open(opened.group.resolve(`${scale}/${arrName}`), { kind: "array" });
    const sr = await zarr.open(opened.group.resolve(`${scale}/spatial_ref`), { kind: "array" });
    const nd = chm.shape.length;
    if (nd !== 2) {
      throw new Error(
        `Multiscale store: only 2-D [y,x] variables are supported (got ${nd}-D "${scale}/${arrName}").`,
      );
    }
    const gt = String(sr.attrs.GeoTransform ?? "").trim().split(/\s+/).map(Number);
    if (gt.length < 6 || gt.some((n) => !Number.isFinite(n))) {
      throw new Error(`Multiscale store: invalid GeoTransform on "${scale}/spatial_ref".`);
    }
    levels.push({ asset: `${scale}/${arrName}`, geoTransform: gt, shape: [chm.shape[0]!, chm.shape[1]!] });
    if (typeof sr.attrs.crs_wkt === "string") crsWkt = sr.attrs.crs_wkt;
    if (typeof sr.attrs["proj:code"] === "string") crsCode = sr.attrs["proj:code"];
    if (i === 0) {
      coarsestArray = chm;
      coarsestGeoTransform = gt;
    }
    if (i === datasets.length - 1) {
      variable = arrName;
      dtype = chm.dtype;
      units = typeof chm.attrs.units === "string" ? chm.attrs.units : null;
      longName = typeof chm.attrs.long_name === "string" ? chm.attrs.long_name : null;
      finestPixelMeters = Math.abs(gt[1]!);
      const dn = chm.dimensionNames;
      if (Array.isArray(dn) && dn.length === 2 && dn.every((d) => typeof d === "string")) {
        dims = [dn[0] as string, dn[1] as string];
      }
    }
  }
  if (!crsWkt) {
    throw new Error("Multiscale store: no `crs_wkt` found in `spatial_ref` (can't resolve CRS).");
  }
  const metadata = buildGeoZarrMetadata({ levels, crsWkt, dims });
  const levelDownsamples = finestPixelMeters > 0
    ? levels.map((l) => Math.round(Math.abs(l.geoTransform[1]!) / finestPixelMeters))
    : levels.map((_, i) => Math.round(Math.pow(2, levels.length - 1 - i)));
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
  const crs = await resolveCrsConverters({ code: crsCode, wkt2: crsWkt });
  log.info(
    `prepared CF pyramid "${variable}" ${dtype} ${datasets.length} levels, ` +
      `${finestPixelMeters.toFixed(2)} m/px native, crs=${crsCode ?? "wkt"}, minRenderZoom=${minRenderZoom}`,
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
    prefix: "",
    label: "root",
    variables: [oneVar],
    levelCount: datasets.length,
    levelDownsamples,
    crsCode,
    crs,
    coarsestArray: coarse,
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

    const sources = await discoverPyramids(opened, contents, signal);
    if (sources.length === 0) {
      throw new Error("Not a multiscale store (no `multiscales` attr on the root or any child group).");
    }
    const pyramids: Pyramid[] = [];
    for (const src of sources) {
      if (signal.aborted) throw new Error("aborted");
      pyramids.push(
        src.layout
          ? await prepareLayoutPyramid(opened, contents, src, signal)
          : await prepareCfPyramid(opened, contents, src, signal),
      );
    }
    done();
    return { url, group: opened.group, store: opened.store, pyramids };
  },

  initialState(ctx) {
    const p = ctx.pyramids[0]!; // finest-first → native/finest product
    const preferred = ["NDVI"];
    const variable =
      preferred.find((n) => p.variables.some((v) => v.name === n)) ?? p.variables[0]!.name;
    const v = p.variables.find((x) => x.name === variable)!;
    return { pyramid: p.prefix, variable, dimIndices: defaultDimIndices(v) };
  },
  parseUrlParams(p) {
    const out: Partial<MultiscaleGridState> = {};
    const pyr = p.get("pyramid");
    if (pyr) out.pyramid = pyr;
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
    // Omit `pyramid` for the root ("") pyramid so single-pyramid store URLs stay clean.
    const out: Record<string, string | null> = { pyramid: s.pyramid || null, var: s.variable };
    for (const [name, idx] of Object.entries(s.dimIndices)) out[`dim.${name}`] = String(idx);
    return out;
  },
  // Open on the data extent (finest level of the finest pyramid) so a regional
  // store (e.g. CONUS CDL) lands zoomed to its data — above the coarsest level's
  // load gate — rather than at world view where the pyramid gate blanks it.
  // Global stores' data bounds ≈ world, so their opening view is unchanged.
  initialBounds: (ctx) =>
    defaultVarBounds(ctx.pyramids[0]!) ?? [-180, -85.0511, 180, 85.0511],

  // Data extent (any level covers the same area) for the intro fly-in. Dispatched
  // on the selected pyramid's CRS: geographic (degrees) / EPSG:3857 (closed form)
  // / arbitrary projected (proj4 reprojection of the densified footprint).
  dataBounds: (ctx, state) => {
    const p = selectedPyramid(ctx, state);
    const v = p.variables.find((x) => x.name === state.variable) ?? p.variables[0];
    const layout = v?.metadata.multiscales.layout[0];
    if (!layout) return null;
    return levelBounds(p, layout["spatial:transform"], layout["spatial:shape"]);
  },

  // Native resolution from the finest level (layout[0]): degrees for geographic,
  // EPSG:3857 mercator metres for 3857, else ground metres (any projected CRS).
  nativeResolution: (ctx, state) => {
    const p = selectedPyramid(ctx, state);
    const v = p.variables.find((x) => x.name === state.variable) ?? p.variables[0];
    const step = Math.abs(v?.metadata.multiscales.layout[0]?.["spatial:transform"]?.[0] ?? 0);
    if (!(step > 0)) return null;
    if (isGeographicCrs(p.crsCode)) return { kind: "degrees", value: step };
    if (p.crsCode === "EPSG:3857") return { kind: "mercator-meters", value: step };
    return { kind: "ground-meters", value: step };
  },

  Controls: MultiscaleGridControls,

  resolveNode: async (ctx) => ctx.group,
  resolveNodeDeps: (s) => [s.pyramid, s.variable],
  statsDeps: (s) => [s.pyramid, s.variable],

  buildLayer({ ctx, state, chassisState, colormapTexture, autoStats, basemapBeforeId, node }) {
    if (!node || !colormapTexture) return null;
    const p = selectedPyramid(ctx, state);
    const v = p.variables.find((x) => x.name === state.variable);
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
    // Sample key is namespaced by pyramid + variable so /10m and /30m (or two
    // variables) never collide in the hover-tooltip sample registry.
    const sampleKey = (z: number) => `${state.pyramid}:${state.variable}:z${z}`;
    return new ReportingZarrLayer<zarr.Readable, zarr.DataType, MultiBandTileData>({
      id: `multiscale-grid-${state.pyramid}-${state.variable}-${pinnedKey}`,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      node: node as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      metadata: v.metadata as any,
      selection,
      getTileData: makeScalarGridTileLoader({ fillValue: v.fillValue, sampleKeyForZ: sampleKey }),
      renderTile,
      opacity: chassisState.opacity,
      // Stop fetching new tiles when zoomed out past the coarsest level's
      // budget floor; the non-null extent keeps already-loaded tiles painted.
      minZoom: chassisState.minZoomOverride ?? p.minRenderZoom,
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

  async computeAutoStats({ ctx, state, signal }) {
    // Sample a representative patch of the selected pyramid's coarsest level of
    // its DEFAULT variable. Seed at the data-extent centre (reprojected through
    // the pyramid CRS), except keep the Amazon vegetated seed for a ~world-
    // spanning geographic store (the global NDVI reference), whose centre is
    // ocean. Any leading (non-spatial) dims are pinned to index 0 (2-D patch).
    const p = selectedPyramid(ctx, state);
    const arr = p.coarsestArray;
    const nd = arr.shape.length;
    const h = arr.shape[nd - 2]!;
    const w = arr.shape[nd - 1]!;
    const ph = Math.min(arr.chunks[nd - 2] ?? h, h);
    const pw = Math.min(arr.chunks[nd - 1] ?? w, w);
    const t = p.coarsestTransform;
    const [px, , ox, , py, oy] = t;

    const b = levelBounds(p, t, [h, w]);
    let seedLng = -62;
    let seedLat = -4; // Amazon default (world-spanning / unknown extent → vegetated land)
    if (b && b[2] - b[0] <= 300) {
      seedLng = (b[0] + b[2]) / 2;
      seedLat = (b[1] + b[3]) / 2;
    }
    const src = lngLatToSourceCrs(p, seedLng, seedLat) ?? [mercX(seedLng), mercY(seedLat)];
    const centerCol = (src[0] - (ox ?? 0)) / (px || 1);
    const centerRow = (src[1] - (oy ?? 0)) / (py || -1);
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
      chunk = await zarr.get(arr as zarr.Array<zarr.NumberDataType, zarr.Readable>, sliceSpec, { signal });
    } catch (err) {
      // The sample patch may sit on an unreadable/missing chunk. Degrade
      // gracefully — the rescale falls back to its manual default.
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
    const p = selectedPyramid(ctx, state);
    const v = p.variables.find((x) => x.name === state.variable);
    if (!v) return null;
    const src = lngLatToSourceCrs(p, lng, lat);
    if (!src) return null;
    const [sx, sy] = src;
    const layouts = v.metadata.multiscales.layout; // finest-first (layout[0] = finest)
    const N = layouts.length;
    // deck.gl z=0 = coarsest (layout[N-1]), z=N-1 = finest (layout[0]).
    // Try finest first; fall back to coarser levels where a finer tile isn't loaded.
    for (let z = N - 1; z >= 0; z--) {
      const layout = layouts[N - 1 - z];
      if (!layout) continue;
      const t = layout["spatial:transform"]; // [scaleX, 0, originX, 0, scaleY, originY]
      const shape = layout["spatial:shape"]; // [height, width]
      const col = Math.floor((sx - t[2]) / t[0]);
      const row = Math.floor((sy - t[5]) / t[4]);
      if (col < 0 || col >= shape[1] || row < 0 || row >= shape[0]) continue;
      const value = readSampleValue(`${state.pyramid}:${state.variable}:z${z}`, row, col, 0);
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

  pyramidLevelCount: (ctx, state) => selectedPyramid(ctx, state).levelCount,
  pyramidLevelDownsamples: (ctx, state) => selectedPyramid(ctx, state).levelDownsamples,

  getStructure: (ctx, state) => {
    const p = selectedPyramid(ctx, state);
    const v = p.variables.find((x) => x.name === state.variable) ?? p.variables[0]!;
    // The metadata's layout is finest-first, so layout[0].asset is the primary
    // (finest) array path for this variable in either schema.
    const finestAsset = v.metadata.multiscales.layout[0]?.asset ?? v.name;
    return {
      zarrVersion: "v3",
      variables: [{ path: finestAsset, role: "finest" }],
      metadataSource: "synthesized",
      metadata: v.metadata,
    };
  },
};
