import { afterEach, describe, expect, it } from "vitest";
import {
  _resetSampleSource,
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

describe("sample-source registry", () => {
  it("reads a value inside a registered tile (local→array offset)", () => {
    registerSampleTile("k", 0, 0, 0, tile(0, 0, 4, 4));
    expect(readSampleValue("k", 2, 3, 0)).toBe(203);
  });

  it("returns null outside the tile bounds", () => {
    registerSampleTile("k", 0, 0, 0, tile(0, 0, 4, 4));
    expect(readSampleValue("k", 4, 0, 0)).toBeNull(); // row past height
    expect(readSampleValue("k", 0, 4, 0)).toBeNull(); // col past width
    expect(readSampleValue("k", -1, 0, 0)).toBeNull();
  });

  it("offsets by the tile's rowStart/colStart", () => {
    registerSampleTile("k", 1, 2, 0, tile(10, 20, 5, 5)); // covers rows 10-14, cols 20-24
    expect(readSampleValue("k", 12, 22, 0)).toBe(1222);
    expect(readSampleValue("k", 9, 22, 0)).toBeNull();
  });

  it("passes the frame through to valueAt", () => {
    registerSampleTile("k", 0, 0, 0, tile(0, 0, 2, 2));
    expect(readSampleValue("k", 0, 0, 7)).toBe(7);
  });

  it("passes NaN (fill) straight through", () => {
    registerSampleTile("k", 0, 0, 0, {
      rowStart: 0,
      colStart: 0,
      height: 1,
      width: 1,
      valueAt: () => Number.NaN,
    });
    expect(readSampleValue("k", 0, 0, 0)).toBeNaN();
  });

  it("drops stale keys when the active key changes", () => {
    registerSampleTile("old", 0, 0, 0, tile(0, 0, 2, 2));
    expect(readSampleValue("old", 0, 0, 0)).toBe(0);
    registerSampleTile("new", 0, 0, 0, tile(0, 0, 2, 2));
    expect(readSampleValue("old", 0, 0, 0)).toBeNull(); // cleared
    expect(readSampleValue("new", 0, 0, 0)).toBe(0);
  });

  it("returns null for an unknown key", () => {
    expect(readSampleValue("missing", 0, 0, 0)).toBeNull();
  });

  it("keeps multiple tiles under one key (panning)", () => {
    registerSampleTile("k", 0, 0, 0, tile(0, 0, 4, 4));
    registerSampleTile("k", 1, 0, 0, tile(0, 4, 4, 4)); // cols 4-7
    expect(readSampleValue("k", 1, 1, 0)).toBe(101);
    expect(readSampleValue("k", 1, 5, 0)).toBe(105);
  });
});
