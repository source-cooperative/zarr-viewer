import { describe, expect, it } from "vitest";
import {
  buildWindowFloat32,
  leadingStrides,
  planeOffset,
} from "../render/texture-array-pipeline";

describe("leadingStrides / planeOffset", () => {
  it("computes row-major leading strides ([tex, mem] over H×W)", () => {
    // shape [2, 3, H, W], frameLen = H*W. Last leading axis stride = frameLen.
    expect(leadingStrides([2, 3], 10)).toEqual([30, 10]);
  });

  it("planeOffset sums index*stride over the leading axes", () => {
    // [2,3] leading, frameLen 10: offset of (tex=1, mem=2) = 1*30 + 2*10 = 50.
    expect(planeOffset([2, 3], [1, 2], 10)).toBe(50);
  });
});

describe("buildWindowFloat32", () => {
  it("single leading axis reproduces the [depth, H, W] window (regression)", () => {
    // raw = 0..11 as [3, 2, 2]; full window, no roll/CF.
    const raw = Float32Array.from({ length: 12 }, (_, i) => i);
    const out = buildWindowFloat32(raw, [3], 0, [0], 2, 2, 0, 3, null, false, 1, 0);
    expect(Array.from(out)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  });

  it("slices a memory dim (tex axis 0, mem axis 1) at its index", () => {
    // [tex=2, mem=3, H=1, W=1], raw[t*3 + m]. Pin mem=1 → frames t=0,1 → [1,4].
    const raw = Float32Array.from({ length: 6 }, (_, i) => i);
    const out = buildWindowFloat32(raw, [2, 3], 0, [0, 1], 1, 1, 0, 2, null, false, 1, 0);
    expect(Array.from(out)).toEqual([1, 4]);
  });

  it("handles the texture dim NOT at axis 0 (mem axis 0, tex axis 1)", () => {
    // [mem=3, tex=2, H=1, W=1], raw[m*2 + t]. Pin mem=2 → frames t=0,1 → [4,5].
    const raw = Float32Array.from({ length: 6 }, (_, i) => i);
    const out = buildWindowFloat32(raw, [3, 2], 1, [2, 0], 1, 1, 0, 2, null, false, 1, 0);
    expect(Array.from(out)).toEqual([4, 5]);
  });

  it("rolls columns by half-width for a 0..360 grid", () => {
    // [1, H=1, W=2], raw=[10,20], roll → columns swapped → [20,10].
    const raw = Float32Array.from([10, 20]);
    const out = buildWindowFloat32(raw, [1], 0, [0], 1, 2, 0, 1, null, true, 1, 0);
    expect(Array.from(out)).toEqual([20, 10]);
  });

  it("applies fill→NaN and scale/offset CF packing", () => {
    // [2, H=1, W=1], raw=[5,3]; fill=5 → NaN, else v*2+1.
    const raw = Float32Array.from([5, 3]);
    const out = buildWindowFloat32(raw, [2], 0, [0], 1, 1, 0, 2, 5, false, 2, 1);
    expect(out[0]).toBeNaN();
    expect(out[1]).toBe(7);
  });
});
