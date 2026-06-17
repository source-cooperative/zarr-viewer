import { afterEach, describe, expect, it } from "vitest";
import {
  _resetSampleSource,
  MAX_BYTES_PER_KEY,
  MAX_KEYS,
  readSampleValue,
  registerSampleTile,
  type SampleTile,
} from "../render/sample-source";

afterEach(() => _resetSampleSource());

/** A tile whose value is `row*100 + col` (frame added when given). */
function tile(
  rowStart: number,
  colStart: number,
  height: number,
  width: number,
): SampleTile {
  return {
    rowStart,
    colStart,
    height,
    width,
    valueAt: (lr, lc, frame) => (rowStart + lr) * 100 + (colStart + lc) + frame,
  };
}

/** Register a 1×1 tile at array (row, col) under `key` with the given bytes. */
function reg(key: string, row: number, col: number, bytes = 16): void {
  registerSampleTile(key, col, row, 0, tile(row, col, 1, 1), bytes);
}

describe("sample-source registry", () => {
  it("reads a value inside a registered tile (local→array offset)", () => {
    registerSampleTile("k", 0, 0, 0, tile(0, 0, 4, 4), 64);
    expect(readSampleValue("k", 2, 3, 0)).toBe(203);
  });

  it("returns null outside the tile bounds", () => {
    registerSampleTile("k", 0, 0, 0, tile(0, 0, 4, 4), 64);
    expect(readSampleValue("k", 4, 0, 0)).toBeNull(); // row past height
    expect(readSampleValue("k", 0, 4, 0)).toBeNull(); // col past width
    expect(readSampleValue("k", -1, 0, 0)).toBeNull();
  });

  it("offsets by the tile's rowStart/colStart", () => {
    registerSampleTile("k", 1, 2, 0, tile(10, 20, 5, 5), 100); // rows 10-14, cols 20-24
    expect(readSampleValue("k", 12, 22, 0)).toBe(1222);
    expect(readSampleValue("k", 9, 22, 0)).toBeNull();
  });

  it("passes the frame through to valueAt", () => {
    registerSampleTile("k", 0, 0, 0, tile(0, 0, 2, 2), 16);
    expect(readSampleValue("k", 0, 0, 7)).toBe(7);
  });

  it("passes NaN (fill) straight through", () => {
    registerSampleTile(
      "k",
      0,
      0,
      0,
      { rowStart: 0, colStart: 0, height: 1, width: 1, valueAt: () => Number.NaN },
      16,
    );
    expect(readSampleValue("k", 0, 0, 0)).toBeNaN();
  });

  it("returns null for an unknown key", () => {
    expect(readSampleValue("missing", 0, 0, 0)).toBeNull();
  });

  it("keeps multiple tiles under one key (panning)", () => {
    registerSampleTile("k", 0, 0, 0, tile(0, 0, 4, 4), 64);
    registerSampleTile("k", 1, 0, 0, tile(0, 4, 4, 4), 64); // cols 4-7
    expect(readSampleValue("k", 1, 1, 0)).toBe(101);
    expect(readSampleValue("k", 1, 5, 0)).toBe(105);
  });

  // --- Regression: the bug this rework fixes ---

  it("keeps a whole plane of tiles for one key (no fixed count cap)", () => {
    // A coarse global shard tiles into hundreds of small tiles. The old fixed
    // 64-tile cap evicted most, so the tooltip worked only over the last-loaded
    // ones. Now all stay readable while under the byte budget.
    const n = 600;
    for (let i = 0; i < n; i++) reg("k", i, 0, 16);
    for (let i = 0; i < n; i++) expect(readSampleValue("k", i, 0, 0)).toBe(i * 100);
  });

  it("retains a prior selection after switching keys and back", () => {
    // A key switch must NOT wipe other buckets (the old behavior): a late tile
    // from a superseded selection could erase the active one, and flipping a
    // dim back should be instant.
    reg("a", 0, 0);
    reg("b", 0, 0);
    expect(readSampleValue("a", 0, 0, 0)).toBe(0); // still there
    expect(readSampleValue("b", 0, 0, 0)).toBe(0);
  });

  it("drops the least-recently-used selection past MAX_KEYS", () => {
    for (let i = 0; i < MAX_KEYS + 1; i++) reg(`key${i}`, 0, 0);
    expect(readSampleValue("key0", 0, 0, 0)).toBeNull(); // oldest evicted
    for (let i = 1; i <= MAX_KEYS; i++) {
      expect(readSampleValue(`key${i}`, 0, 0, 0)).toBe(0);
    }
  });

  it("a read refreshes a key so background registrations don't evict it", () => {
    reg("active", 5, 0);
    // Fill the rest of the key budget with other selections, reading "active"
    // between each so it stays most-recently-used.
    for (let i = 0; i < MAX_KEYS + 2; i++) {
      reg(`bg${i}`, 0, 0);
      expect(readSampleValue("active", 5, 0, 0)).toBe(500); // survives
    }
  });

  it("evicts least-recently-registered tiles past the per-key byte budget", () => {
    const big = MAX_BYTES_PER_KEY; // two of these exceed the budget
    reg("k", 0, 0, big);
    reg("k", 1, 0, big);
    expect(readSampleValue("k", 0, 0, 0)).toBeNull(); // oldest evicted
    expect(readSampleValue("k", 1, 0, 0)).toBe(100); // newest kept
  });
});
