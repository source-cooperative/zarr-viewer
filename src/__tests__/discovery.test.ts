import { describe, expect, it } from "vitest";
import {
  childGroupPaths,
  finestPixelSizeOf,
  type PyramidSource,
} from "../zarr/profiles/multiscale-grid/discovery";

describe("childGroupPaths", () => {
  it("returns only depth-1 group paths (single segment)", () => {
    const contents = [
      { path: "/", kind: "group" as const },
      { path: "/10m", kind: "group" as const },
      { path: "/30m", kind: "group" as const },
      { path: "/10m/2x", kind: "group" as const }, // depth 2 — excluded
      { path: "/10m/crop_type", kind: "array" as const }, // array — excluded
    ];
    expect(childGroupPaths(contents)).toEqual(["10m", "30m"]);
  });

  it("is empty for a flat store with no child groups", () => {
    expect(childGroupPaths([{ path: "/temperature", kind: "array" }])).toEqual([]);
  });
});

describe("finestPixelSizeOf + finest-first sort", () => {
  const src = (prefix: string, scale: number | null): PyramidSource => ({
    prefix,
    label: prefix,
    layout: scale === null
      ? null
      : ({ levels: [{ asset: ".", "spatial:transform": [scale, 0, 0, 0, -scale, 0], "spatial:shape": [10, 10] }], dims: ["y", "x"], crs: { code: "EPSG:5070" } } as PyramidSource["layout"]),
    datasets: scale === null ? ["1x"] : null,
    crsCode: "EPSG:5070",
    crsWkt: null,
  });

  it("reads the finest level's pixel size, or Infinity for CF sources", () => {
    expect(finestPixelSizeOf(src("10m", 10))).toBe(10);
    expect(finestPixelSizeOf(src("cf", null))).toBe(Number.POSITIVE_INFINITY);
  });

  it("sorts native/finest first, CF last", () => {
    const sorted = [src("30m", 30), src("cf", null), src("10m", 10)]
      .sort((a, b) => finestPixelSizeOf(a) - finestPixelSizeOf(b))
      .map((s) => s.prefix);
    expect(sorted).toEqual(["10m", "30m", "cf"]);
  });
});
