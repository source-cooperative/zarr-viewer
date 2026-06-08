import type { Viewport } from "@deck.gl/core";
import { RasterTileset2D } from "@developmentseed/deck.gl-raster";

/**
 * Keep the lowest-zoom tiles painted when the viewport zooms out past a layer's
 * `minZoom`, instead of blanking the map. We want to *stop loading* new tiles
 * when zoomed out but *keep showing* the ones already loaded.
 *
 * Two deck.gl gates blank the map below `minZoom`, and BOTH must be defeated:
 *
 * 1. `RasterTileset2D.getTileIndices` (deck.gl-zarr) returns an EMPTY list once
 *    `viewport.zoom < minZoom` — it deliberately couples "don't fetch" with
 *    "don't render". `installKeepMinZoomTiles()` wraps it so that below `minZoom`
 *    it returns the previously-selected tiles' indices instead of `[]`.
 *    Re-selecting cached indices triggers no fetch (deck.gl's `_getTile` only
 *    loads an index that isn't already cached), so the last good view stays
 *    selected/visible with zero new requests.
 *
 * 2. `TileLayer.renderLayers` independently discards all rendered sub-layers
 *    when `minZoom != null && !extent && zoom < minZoom`. The `!extent` term is
 *    the escape hatch: set ANY non-null `extent` on the layer and this gate
 *    never fires. {@link KEEP_MIN_ZOOM_EXTENT} is that flag — pass it as the
 *    layer's `extent`. (RasterTileset2D ignores the extent's *value* for tile
 *    selection, so the bounds only need to be truthy; world bounds are used for
 *    honesty.)
 *
 * The patch is a prototype wrap because `RasterTileLayer` hard-wires its
 * `TilesetClass` internally (no prop or subclass hook) and the methods that
 * build it are `private`. Idempotent; call once at startup.
 */

/**
 * Pass as a ZarrLayer's `extent` to disable `TileLayer.renderLayers`' below-
 * `minZoom` hide gate (it only fires when `extent` is null). Required alongside
 * {@link installKeepMinZoomTiles} — see this module's docs. World bounds in
 * `[west, south, east, north]`; latitude clamped to the Web-Mercator limit.
 */
export const KEEP_MIN_ZOOM_EXTENT: [number, number, number, number] = [
  -180, -85.051129, 180, 85.051129,
];

type TileIndex = { x: number; y: number; z: number };

type GetTileIndices = (opts: {
  viewport: Viewport;
  minZoom?: number;
  [key: string]: unknown;
}) => TileIndex[];

/** Marker so re-imports / HMR don't double-wrap the prototype. */
const FLAG = "__zarrViewerKeepMinZoomTiles";

export function installKeepMinZoomTiles(): void {
  const proto = RasterTileset2D.prototype as unknown as Record<string, unknown> & {
    getTileIndices: GetTileIndices;
  };
  if (proto[FLAG]) return;

  const original = proto.getTileIndices;
  const patched: GetTileIndices = function (
    this: { _selectedTiles?: { index: TileIndex }[] | null },
    opts,
  ) {
    const { viewport, minZoom } = opts;
    if (typeof minZoom === "number" && viewport.zoom < minZoom) {
      // Below the load threshold: freeze on the last selection so already-loaded
      // tiles stay visible and nothing new is fetched. Empty when nothing has
      // loaded yet (e.g. first paint already zoomed out).
      const selected = this._selectedTiles;
      return selected ? selected.map((t) => t.index) : [];
    }
    return original.call(this, opts);
  };

  proto.getTileIndices = patched;
  proto[FLAG] = true;
}
