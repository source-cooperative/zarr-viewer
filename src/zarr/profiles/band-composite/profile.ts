import { ZarrLayer } from "@developmentseed/deck.gl-zarr";
import * as zarr from "zarrita";
import { LOCATIONS } from "../../../locations";
import { KEEP_MIN_ZOOM_EXTENT } from "../../../render/keep-min-zoom-tiles";
import { spatialTileSize } from "../../chunk-size";
import { asConsolidated, openV3Group } from "../../load-zarr";
import type { ZarrProfile } from "../../profile";
import { fetchBandLabels } from "./band-labels";
import { MIN_ZOOM } from "./constants";
import { BandCompositeControls } from "./controls";
import { makeRgbRenderTile } from "./render-tile";
import { getBandCompositeTileData } from "./tile-loader";
import type { BandCompositeContext, BandCompositeState } from "./types";

/** Find a renderable multi-band variable: an int8 array `[time?, band, y, x]`
 * whose band axis (the dim before the spatial pair) has ≥ 3 entries.
 *
 * Priority:
 *  1. Explicit `hint` path (from the `?var=` URL param).
 *  2. Path matching the UTM zone that covers `LOCATIONS[0]`'s longitude —
 *     avoids picking an arbitrary zone from alphabetically-first ordering on
 *     multi-zone stores (e.g. OLMo).
 *  3. First matching array from consolidated metadata enumeration. */
async function findBandVariable(
  group: zarr.Group<zarr.Readable>,
  hint?: string,
): Promise<{ name: string; arr: zarr.Array<"int8", zarr.Readable> }> {
  const store = asConsolidated(group.store);
  const names = store
    ? store.contents().filter((e) => e.kind === "array").map((e) => e.path.replace(/^\/+/, ""))
    : ["embeddings"];

  const isValidBandArray = (
    arr: zarr.Array<zarr.DataType, zarr.Readable>,
  ): arr is zarr.Array<"int8", zarr.Readable> => {
    const nd = arr.shape.length;
    return nd >= 3 && (arr.shape[nd - 3] ?? 0) >= 3 && arr.is("int8");
  };

  const tryOpen = async (path: string) => {
    try {
      const arr = await zarr.open(group.resolve(path), { kind: "array" });
      return isValidBandArray(arr) ? { name: path, arr } : null;
    } catch {
      return null;
    }
  };

  // 1. Explicit hint
  if (hint) {
    const result = await tryOpen(hint);
    if (result) return result;
  }

  // 2. UTM zone matching LOCATIONS[0]'s longitude (for multi-zone stores)
  const loc = LOCATIONS[0];
  if (loc) {
    const zoneNum = Math.floor((loc.longitude + 180) / 6) + 1;
    const zonePadded = String(zoneNum).padStart(2, "0");
    const utmCandidate = names.find(
      (n) => n.includes(`utm${zonePadded}/`) || n === `utm${zonePadded}`,
    );
    if (utmCandidate) {
      const result = await tryOpen(utmCandidate);
      if (result) return result;
    }
  }

  // 3. Enumerate
  for (const path of names) {
    if (!path) continue;
    const result = await tryOpen(path);
    if (result) return result;
  }
  throw new Error(
    "RGB band composite: no int8 multi-band variable found (expected `[time?, band, y, x]` with ≥3 bands).",
  );
}

export const bandCompositeProfile: ZarrProfile<BandCompositeState, BandCompositeContext> = {
  id: "band-composite",
  label: "RGB band composite",
  needsColormap: false,
  // No overviews: the layer only renders at/above MIN_ZOOM (see
  // constants.ts). Below it the chassis shows a zoom-in hint instead of a
  // blank map.
  minRenderZoom: MIN_ZOOM,

  getStructure: (ctx) => ({
    zarrVersion: "v3",
    variables: [{ path: ctx.variable }],
    // Store ships GeoZarr-compliant root attrs; we pass them through
    // unchanged as the layer's `metadata` prop.
    metadataSource: "store-native",
    metadata: ctx.rootAttrs,
  }),

  // The band variable is opened in prepare(); expose it here so App.tsx's
  // `node` state holds the Array (not the parent Group). Lets the Structure
  // panel show shape/dtype/chunks/fillValue.
  resolveNode: async (ctx) => ctx.embeddings,

  async prepare(url, _signal, open = {}) {
    const { variable: variableHint, ...storeOpen } = open;
    const opened = await openV3Group(url, { consolidated: true, ...storeOpen });
    const { name, arr: embeddings } = await findBandVariable(opened.group, variableHint);
    const bandLabels = await fetchBandLabels(opened.group);
    const nd = embeddings.shape.length;
    // Leading (non-band, non-spatial) axis is the time/year dim, if any.
    const yearCount = nd >= 4 ? (embeddings.shape[0] ?? 0) : 1;
    const bandCount = embeddings.shape[nd - 3] ?? 0;
    // For nested variables (e.g. utm12/embeddings), the root group carries
    // store-wide attrs that may not be GeoZarr-compliant for a single tile
    // region. Use the parent group's attrs instead — they carry the
    // zone-specific spatial:transform/proj:code that ZarrLayer needs.
    let rootAttrs: unknown = opened.group.attrs;
    const parentPath = name.includes("/")
      ? name.split("/").slice(0, -1).join("/")
      : null;
    if (parentPath) {
      try {
        const parentGroup = await zarr.open(
          opened.group.resolve(parentPath),
          { kind: "group" },
        );
        rootAttrs = parentGroup.attrs;
      } catch {
        // parent group not openable — fall back to root attrs
      }
    }
    return {
      url,
      variable: name,
      group: opened.group,
      embeddings,
      rootAttrs,
      bandLabels,
      yearCount,
      bandCount,
    };
  },

  initialState(ctx) {
    return {
      // Default to the latest available year (2025 = index 8 in upstream).
      year: Math.max(0, ctx.yearCount - 1),
      rBand: 0,
      gBand: 16,
      bBand: 32,
      rescaleMin: -0.3,
      rescaleMax: 0.3,
    };
  },

  parseUrlParams(p) {
    const out: Partial<BandCompositeState> = {};
    const y = p.get("y");
    if (y !== null && Number.isFinite(Number(y))) out.year = Number(y);
    const r = p.get("r");
    if (r !== null && Number.isFinite(Number(r)))
      out.rBand = clampBand(Number(r));
    const g = p.get("g");
    if (g !== null && Number.isFinite(Number(g)))
      out.gBand = clampBand(Number(g));
    const b = p.get("b");
    if (b !== null && Number.isFinite(Number(b)))
      out.bBand = clampBand(Number(b));
    const rmin = p.get("rmin");
    if (rmin !== null && Number.isFinite(Number(rmin)))
      out.rescaleMin = Number(rmin);
    const rmax = p.get("rmax");
    if (rmax !== null && Number.isFinite(Number(rmax)))
      out.rescaleMax = Number(rmax);
    return out;
  },

  serializeUrlParams(s) {
    return {
      y: String(s.year),
      r: String(s.rBand),
      g: String(s.gBand),
      b: String(s.bBand),
      rmin: String(s.rescaleMin),
      rmax: String(s.rescaleMax),
    };
  },

  // No `initialBounds`; AEF is global but has no overviews. Land at the
  // first preset location at ~native zoom (MIN_ZOOM + 2 ≈ z14) so first
  // paint is crisp and light (~55 MB) rather than the heavy wide z12 view.
  // MIN_ZOOM still lets users zoom out two levels for context. The chassis
  // Location dropdown handles further navigation.
  initialView() {
    const loc = LOCATIONS[0]!;
    return {
      longitude: loc.longitude,
      latitude: loc.latitude,
      zoom: MIN_ZOOM + 2,
    };
  },

  Controls: BandCompositeControls,

  buildLayer({ ctx, state, chassisState, basemapBeforeId }) {
    const renderTile = makeRgbRenderTile({
      rBandIdx: state.rBand,
      gBandIdx: state.gBand,
      bBandIdx: state.bBand,
      rescaleMin: state.rescaleMin,
      rescaleMax: state.rescaleMax,
    });
    return new ZarrLayer<zarr.Readable, "int8", import("./tile-loader").BandCompositeTileData>({
      id: `band-composite-${state.year}`,
      node: ctx.embeddings,
      metadata: ctx.rootAttrs,
      // Assumes the band variable's dims are `[time, band, y, x]` (the only
      // band-composite source so far); `band: null` loads all bands.
      selection: { time: state.year, band: null },
      getTileData: getBandCompositeTileData,
      renderTile,
      // Align tile grid with the embeddings array's spatial chunk shape.
      tileSize: spatialTileSize(ctx.embeddings),
      minZoom: chassisState.minZoomOverride ?? MIN_ZOOM,
      // Required (with the getTileIndices patch) to keep already-loaded tiles
      // painted below minZoom: a non-null extent disables TileLayer's own
      // below-minZoom hide gate. See keep-min-zoom-tiles.ts.
      extent: KEEP_MIN_ZOOM_EXTENT,
      maxRequests: 20,
      // Each tile near native zoom is ~3 MB (one inner 256² chunk). A
      // roomy cache stops overlapping/adjacent tiles from re-fetching the
      // same shard data as the viewport pans.
      maxCacheSize: 64,
      opacity: chassisState.opacity,
      updateTriggers: {
        renderTile: [
          state.rBand,
          state.gBand,
          state.bBand,
          state.rescaleMin,
          state.rescaleMax,
        ],
      },
      // beforeId is injected by @deck.gl/mapbox; ZarrLayerProps doesn't
      // expose it, so attach via a wider cast.
      ...({ beforeId: basemapBeforeId } as Record<string, unknown>),
    });
  },
};

function clampBand(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(255, Math.floor(n)));
}
