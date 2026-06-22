import { describe, expect, it } from "vitest";
import { resolveWindow, toGrayscaleRgba } from "./image-normalize";

describe("resolveWindow", () => {
  it("uses an explicit valid window", () => {
    expect(resolveWindow([0, 0], 2, 100, 300)).toEqual({ lo: 100, span: 200 });
  });

  it("derives min/max when the window is missing", () => {
    expect(resolveWindow([10, 50, 30], 3)).toEqual({ lo: 10, span: 40 });
  });

  it("derives min/max when end <= start (degenerate window)", () => {
    expect(resolveWindow([4, 8], 2, 8, 8)).toEqual({ lo: 4, span: 4 });
  });

  it("falls back to [0,1] for constant or empty data", () => {
    expect(resolveWindow([7, 7, 7], 3)).toEqual({ lo: 0, span: 1 });
    expect(resolveWindow([], 0)).toEqual({ lo: 0, span: 1 });
  });

  it("ignores non-finite samples when scanning", () => {
    expect(resolveWindow([NaN, 20, 60, Infinity], 4)).toEqual({
      lo: 20,
      span: 40,
    });
  });
});

describe("toGrayscaleRgba", () => {
  it("maps window endpoints to 0 and 255 and writes opaque RGBA", () => {
    // 2×1 image, window [0,100]: 0 → 0, 100 → 255.
    const rgba = toGrayscaleRgba([0, 100], 2, 1, 0, 100);
    expect(rgba).toHaveLength(8);
    expect(Array.from(rgba)).toEqual([0, 0, 0, 255, 255, 255, 255, 255]);
  });

  it("clamps values outside the window", () => {
    const rgba = toGrayscaleRgba([-50, 200], 2, 1, 0, 100);
    expect(rgba[0]).toBe(0); // below floor → 0
    expect(rgba[4]).toBe(255); // above ceiling → 255
  });

  it("maps the window midpoint to ~128", () => {
    const rgba = toGrayscaleRgba([50], 1, 1, 0, 100);
    expect(rgba[0]).toBe(128);
  });
});
