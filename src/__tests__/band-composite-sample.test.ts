import { afterEach, describe, expect, it } from "vitest";
import {
  _resetSampleSource,
  registerSampleTile,
} from "../render/sample-source";
import { bandCompositeProfile } from "../zarr/profiles/band-composite/profile";
import { bandCompositeSampleKey } from "../zarr/profiles/band-composite/tile-loader";
import { NODATA_INT8, DEQUANT_DIVISOR } from "../zarr/profiles/band-composite/constants";
import type { BandCompositeContext, BandCompositeState } from "../zarr/profiles/band-composite/types";

afterEach(() => _resetSampleSource());

/** Build a minimal BandCompositeContext with a given spatial transform.
 * spatial:transform = [stepX, 0, originX, 0, stepY, originY]
 * The test grid: 1°/px, top-left at (lng=0, lat=10), size 10×10.
 * lng→col = floor((lng - 0) / 1) = floor(lng)
 * lat→row = floor((lat - 10) / -1) = floor(10 - lat)
 * e.g. lng=3, lat=7 → col=3, row=3
 */
function makeCtx(extra?: Partial<BandCompositeContext>): BandCompositeContext {
  const labels = Array.from({ length: 64 }, (_, i) => `PC${i}`);
  return {
    url: "test://",
    group: null as unknown as BandCompositeContext["group"],
    embeddings: null as unknown as BandCompositeContext["embeddings"],
    variable: "embeddings",
    rootAttrs: {
      "spatial:transform": [1, 0, 0, 0, -1, 10],
      "spatial:shape": [10, 10],
    },
    bandLabels: labels,
    yearCount: 1,
    bandCount: 64,
    ...extra,
  };
}

const baseState: BandCompositeState = {
  year: 0,
  rBand: 0,
  gBand: 16,
  bBand: 32,
  rescaleMin: -0.3,
  rescaleMax: 0.3,
};

function dequant(v: number): number {
  return Math.sign(v) * (v / DEQUANT_DIVISOR) ** 2;
}

/** Register a 1×1 tile at (row, col) under the default year-0 sampleKey.
 * bandValues: Map<bandIndex, rawInt8> for valueAt. */
function registerAt(row: number, col: number, bandValues: Map<number, number>, year = 0): void {
  registerSampleTile(
    bandCompositeSampleKey(year),
    col,
    row,
    0,
    {
      rowStart: row,
      colStart: col,
      height: 1,
      width: 1,
      valueAt: (_lr, _lc, frame) => bandValues.get(frame) ?? 0,
    },
    16,
  );
}

describe("bandCompositeProfile.sampleValue", () => {
  it("returns null when no tiles are registered at the queried position", () => {
    const ctx = makeCtx();
    expect(bandCompositeProfile.sampleValue!(ctx, baseState, 3, 7)).toBeNull();
  });

  it("returns null for coordinates outside the spatial bounds", () => {
    const ctx = makeCtx();
    // lat=10 → row=0, lat=0 → row=10 (out of bounds for a 10-row array)
    registerAt(0, 0, new Map([[0, 50], [16, 50], [32, 50]]));
    expect(bandCompositeProfile.sampleValue!(ctx, baseState, 0, 0.5)).toBeNull(); // lat=0.5 → row=9 but no tile there
    expect(bandCompositeProfile.sampleValue!(ctx, baseState, 0, 11)).toBeNull(); // lat=11 → row<0
  });

  it("returns valueLines with R/G/B dequantized values for loaded tiles", () => {
    const ctx = makeCtx();
    const rRaw = 64;
    const gRaw = -64;
    const bRaw = 127;
    registerAt(3, 3, new Map([[0, rRaw], [16, gRaw], [32, bRaw]]));

    // lng=3, lat=7 → col=3, row=3
    const result = bandCompositeProfile.sampleValue!(ctx, baseState, 3, 7);
    expect(result).not.toBeNull();
    expect(result!.valueLines).toHaveLength(3);
    // Each line should contain the dequantized value
    const rDeq = dequant(rRaw);
    const gDeq = dequant(gRaw);
    const bDeq = dequant(bRaw);
    expect(result!.valueLines![0]).toContain(rDeq.toFixed(4));
    expect(result!.valueLines![1]).toContain(gDeq.toFixed(4));
    expect(result!.valueLines![2]).toContain(bDeq.toFixed(4));
  });

  it("includes band labels in valueLines", () => {
    const ctx = makeCtx();
    registerAt(3, 3, new Map([[0, 64], [16, 64], [32, 64]]));
    const result = bandCompositeProfile.sampleValue!(ctx, baseState, 3, 7);
    expect(result!.valueLines![0]).toContain("PC0");
    expect(result!.valueLines![1]).toContain("PC16");
    expect(result!.valueLines![2]).toContain("PC32");
  });

  it("shows 'no data' for nodata pixels (int8 === NODATA_INT8)", () => {
    const ctx = makeCtx();
    registerAt(3, 3, new Map([[0, NODATA_INT8], [16, NODATA_INT8], [32, NODATA_INT8]]));
    const result = bandCompositeProfile.sampleValue!(ctx, baseState, 3, 7);
    expect(result!.valueLines![0]).toContain("no data");
    expect(result!.valueLines![1]).toContain("no data");
    expect(result!.valueLines![2]).toContain("no data");
  });

  it("uses the correct year-keyed sampleKey", () => {
    const ctx = makeCtx();
    const state1 = { ...baseState, year: 1 };
    // Register under year=1, query with year=1 → should hit
    registerAt(3, 3, new Map([[0, 50], [16, 50], [32, 50]]), 1);
    expect(bandCompositeProfile.sampleValue!(ctx, state1, 3, 7)).not.toBeNull();
    // Query with year=0 → should miss (different sampleKey)
    expect(bandCompositeProfile.sampleValue!(ctx, baseState, 3, 7)).toBeNull();
  });
});
