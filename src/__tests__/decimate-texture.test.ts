import { describe, expect, it } from "vitest";
import { decimateToMaxDim } from "../render/shared-textures";

describe("decimateToMaxDim", () => {
  it("returns the array untouched when it already fits", () => {
    const data = Float32Array.from({ length: 4 * 3 }, (_, i) => i);
    const out = decimateToMaxDim(data, 4, 3, 8192);
    expect(out.data).toBe(data); // same reference, no copy
    expect(out.width).toBe(4);
    expect(out.height).toBe(3);
  });

  it("decimates a plane wider than the GPU max texture size to fit", () => {
    // EEPS: an 18000-wide global plane on a device capped at 16384.
    const out = decimateToMaxDim(new Float32Array(18000 * 6501), 18000, 6501, 16384);
    expect(Math.max(out.width, out.height)).toBeLessThanOrEqual(16384);
    // factor = ceil(18000/16384) = 2 → 9000 x 3251.
    expect(out.width).toBe(9000);
    expect(out.height).toBe(3251);
  });

  it("preserves real values via nearest sampling (not all-zero)", () => {
    // 4x2 plane, max dim 2 → factor 2 → 2x1. Nearest picks cols 0,2 of row 0.
    const data = Float32Array.from([1, 2, 3, 4, 5, 6, 7, 8]); // row0: 1..4, row1: 5..8
    const out = decimateToMaxDim(data, 4, 2, 2);
    expect(out.width).toBe(2);
    expect(out.height).toBe(1);
    expect(Array.from(out.data)).toEqual([1, 3]);
  });

  it("keeps the GPU texture within a low device limit (SwiftShader-like)", () => {
    const out = decimateToMaxDim(new Float32Array(18000 * 6501), 18000, 6501, 8192);
    expect(Math.max(out.width, out.height)).toBeLessThanOrEqual(8192);
  });
});
