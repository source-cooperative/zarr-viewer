import { RasterTileset2D } from "@developmentseed/deck.gl-raster";
import { beforeAll, describe, expect, it } from "vitest";
import { installKeepMinZoomTiles } from "../render/keep-min-zoom-tiles";

/** Sentinel the patched method should delegate to when AT/above the threshold. */
const ABOVE_THRESHOLD = [{ x: 7, y: 7, z: 7 }];

// Replace the real (descriptor-driven) getTileIndices with a sentinel BEFORE
// installing, so the wrapper closes over the sentinel and we can assert
// delegation without constructing a full tileset descriptor.
beforeAll(() => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (RasterTileset2D.prototype as any).getTileIndices = () => ABOVE_THRESHOLD;
  installKeepMinZoomTiles();
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const getTileIndices = (self: any, viewportZoom: number, minZoom?: number) =>
  RasterTileset2D.prototype.getTileIndices.call(self, {
    viewport: { zoom: viewportZoom },
    minZoom,
    zRange: null,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);

describe("keep-min-zoom-tiles", () => {
  it("freezes on the last selection when zoomed out past minZoom", () => {
    const selected = [{ index: { x: 1, y: 0, z: 0 } }, { index: { x: 2, y: 0, z: 0 } }];
    const result = getTileIndices({ _selectedTiles: selected }, 0.5, 2);
    // Returns the previously-selected indices (not []), so cached tiles stay
    // visible and nothing new is fetched.
    expect(result).toEqual([
      { x: 1, y: 0, z: 0 },
      { x: 2, y: 0, z: 0 },
    ]);
  });

  it("returns [] below minZoom when nothing has loaded yet", () => {
    expect(getTileIndices({ _selectedTiles: null }, 0.5, 2)).toEqual([]);
    expect(getTileIndices({}, 0.5, 2)).toEqual([]);
  });

  it("delegates to the original traversal at or above minZoom", () => {
    expect(getTileIndices({ _selectedTiles: [] }, 5, 2)).toBe(ABOVE_THRESHOLD);
    // At exactly minZoom it is not "below", so it delegates too.
    expect(getTileIndices({ _selectedTiles: [] }, 2, 2)).toBe(ABOVE_THRESHOLD);
  });

  it("delegates when no minZoom is set", () => {
    expect(getTileIndices({ _selectedTiles: null }, 0, undefined)).toBe(
      ABOVE_THRESHOLD,
    );
  });

  it("is idempotent (does not double-wrap)", () => {
    const once = RasterTileset2D.prototype.getTileIndices;
    installKeepMinZoomTiles();
    expect(RasterTileset2D.prototype.getTileIndices).toBe(once);
  });
});
