import { describe, expect, it } from "vitest";
import type * as zarr from "zarrita";
import { pickTextureDim } from "../zarr/profiles/scalar-grid/profile";

/** Minimal fake array — `pickTextureDim` reads only these four fields. */
function fakeArr(opts: {
  dimensionNames: string[];
  shape: number[];
  chunks: number[];
  dtype?: string;
}): zarr.Array<zarr.DataType, zarr.Readable> {
  return {
    dimensionNames: opts.dimensionNames,
    shape: opts.shape,
    chunks: opts.chunks,
    dtype: opts.dtype ?? "float32",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

describe("pickTextureDim — texture + memory dims", () => {
  it("ECMWF: lead_time is the texture dim, ensemble_member a memory dim", () => {
    const { textureDim, memoryDims } = pickTextureDim(
      fakeArr({
        dimensionNames: [
          "init_time",
          "lead_time",
          "ensemble_member",
          "latitude",
          "longitude",
        ],
        shape: [807, 85, 51, 721, 1440],
        chunks: [1, 85, 51, 32, 32], // inner shard chunk
      }),
    );
    expect(textureDim).toEqual({ name: "lead_time", window: 85 });
    expect(memoryDims).toEqual([{ name: "ensemble_member", size: 51 }]);
    // init_time (chunk 1) is neither — it's a genuinely-pinned re-read dim.
  });

  it("a single fully-packed dim → texture dim, no memory dims", () => {
    const { textureDim, memoryDims } = pickTextureDim(
      fakeArr({
        dimensionNames: ["level", "lat", "lon"],
        shape: [13, 256, 256],
        chunks: [13, 256, 256],
      }),
    );
    expect(textureDim).toEqual({ name: "level", window: 13 });
    expect(memoryDims).toEqual([]);
  });

  it("two fully-packed dims → larger is texture, smaller is memory", () => {
    const { textureDim, memoryDims } = pickTextureDim(
      fakeArr({
        dimensionNames: ["member", "lead", "lat", "lon"],
        shape: [10, 40, 64, 64],
        chunks: [10, 40, 64, 64],
      }),
    );
    expect(textureDim?.name).toBe("lead"); // 40 > 10
    expect(memoryDims).toEqual([{ name: "member", size: 10 }]);
  });

  it("excludes a memory dim that would blow the retained-chunk budget; keeps a tiny one", () => {
    // tex=400 held in full at 64×64×4 = 6.5 MB; ×300 ≫ 128 MB (excluded),
    // ×2 = 13 MB (kept).
    const { textureDim, memoryDims } = pickTextureDim(
      fakeArr({
        dimensionNames: ["tex", "big", "tiny", "lat", "lon"],
        shape: [400, 300, 2, 64, 64],
        chunks: [400, 300, 2, 64, 64],
      }),
    );
    expect(textureDim?.name).toBe("tex"); // 400 is largest
    expect(memoryDims).toEqual([{ name: "tiny", size: 2 }]);
  });

  it("no fully-packed non-spatial dim → no texture/memory dims", () => {
    const { textureDim, memoryDims } = pickTextureDim(
      fakeArr({
        dimensionNames: ["time", "lat", "lon"],
        shape: [100, 256, 256],
        chunks: [1, 256, 256], // time not packed
      }),
    );
    expect(textureDim).toBeNull();
    expect(memoryDims).toEqual([]);
  });
});
