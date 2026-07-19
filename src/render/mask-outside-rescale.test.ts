import { describe, expect, it } from "vitest";
import type { Texture } from "@luma.gl/core";
import { buildSingleBandRenderTile } from "./single-band-pipeline";
import {
  MASK_NO_LOWER,
  MASK_NO_UPPER,
  MaskOutsideRange,
  PerBandLinearRescale,
} from "./shader-modules";
import type { MultiBandTileData } from "./shared-textures";
import { autoStatsFromGlobal, buildBandStats, type AutoStats } from "./stats";
import { LinearRescale } from "@developmentseed/deck.gl-raster/gpu-modules";
import {
  buildTextureArrayRenderTile,
  type TextureArrayTileData,
} from "./texture-array-pipeline";

const fakeTexture = {} as unknown as Texture;

function singleBandData(sampleScale: number): MultiBandTileData {
  return {
    bands: new Map([["1", { texture: fakeTexture, uvTransform: [0, 0, 1, 1] }]]),
    width: 1,
    height: 1,
    byteLength: 4,
    nodata: null,
    sampleScale,
  };
}

const baseState = {
  colormap: "viridis",
  gamma: 1,
  stretch: "linear" as const,
  nodata: null,
  maskBelow: false,
  maskAbove: false,
};

// Each pipeline module is `{ module, props? }`; find by reference equality.
type Mod = { module: unknown; props?: Record<string, unknown> };

describe("single-band pipeline: mask below/above rescale", () => {
  it("omits the mask module when neither maskBelow nor maskAbove is set", () => {
    const renderTile = buildSingleBandRenderTile(
      { ...baseState, rescale: [10, 20] },
      fakeTexture,
      null,
    );
    const { renderPipeline } = renderTile(singleBandData(1));
    expect(
      (renderPipeline as Mod[]).some((m) => m.module === MaskOutsideRange),
    ).toBe(false);
  });

  it("masks both sides immediately before rescale when both are set", () => {
    const renderTile = buildSingleBandRenderTile(
      { ...baseState, rescale: [10, 20], maskBelow: true, maskAbove: true },
      fakeTexture,
      null,
    );
    const pipe = renderTile(singleBandData(1)).renderPipeline as Mod[];
    const maskIdx = pipe.findIndex((m) => m.module === MaskOutsideRange);
    const rescaleIdx = pipe.findIndex((m) => m.module === PerBandLinearRescale);
    expect(maskIdx).toBeGreaterThanOrEqual(0);
    expect(maskIdx + 1).toBe(rescaleIdx);
    expect(pipe[maskIdx]!.props).toEqual({ maskMin: 10, maskMax: 20 });
  });

  it("masks only below: high side uses the no-upper sentinel", () => {
    const renderTile = buildSingleBandRenderTile(
      { ...baseState, rescale: [10, 20], maskBelow: true },
      fakeTexture,
      null,
    );
    const pipe = renderTile(singleBandData(1)).renderPipeline as Mod[];
    const mask = pipe.find((m) => m.module === MaskOutsideRange);
    expect(mask!.props).toEqual({ maskMin: 10, maskMax: MASK_NO_UPPER });
  });

  it("masks only above: low side uses the no-lower sentinel", () => {
    const renderTile = buildSingleBandRenderTile(
      { ...baseState, rescale: [10, 20], maskAbove: true },
      fakeTexture,
      null,
    );
    const pipe = renderTile(singleBandData(1)).renderPipeline as Mod[];
    const mask = pipe.find((m) => m.module === MaskOutsideRange);
    expect(mask!.props).toEqual({ maskMin: MASK_NO_LOWER, maskMax: 20 });
  });

  it("divides mask bounds by sampleScale for r8unorm textures", () => {
    const renderTile = buildSingleBandRenderTile(
      { ...baseState, rescale: [0, 255], maskBelow: true, maskAbove: true },
      fakeTexture,
      null,
    );
    const pipe = renderTile(singleBandData(255)).renderPipeline as Mod[];
    const mask = pipe.find((m) => m.module === MaskOutsideRange);
    expect(mask!.props).toEqual({ maskMin: 0, maskMax: 1 });
  });

  it("does not mask when no window resolves (no rescale, no stats)", () => {
    const renderTile = buildSingleBandRenderTile(
      { ...baseState, rescale: null, maskBelow: true, maskAbove: true },
      fakeTexture,
      null,
    );
    const pipe = renderTile(singleBandData(1)).renderPipeline as Mod[];
    expect(pipe.some((m) => m.module === MaskOutsideRange)).toBe(false);
  });

  it("uses the auto percentile window when no explicit rescale is set", () => {
    const stats = buildBandStats(
      Float32Array.from({ length: 100 }, (_, i) => i),
      null,
    );
    const autoStats: AutoStats = autoStatsFromGlobal(stats!);
    const renderTile = buildSingleBandRenderTile(
      { ...baseState, rescale: null, maskBelow: true, maskAbove: true },
      fakeTexture,
      autoStats,
    );
    const pipe = renderTile(singleBandData(1)).renderPipeline as Mod[];
    const mask = pipe.find((m) => m.module === MaskOutsideRange);
    const rescale = pipe.find((m) => m.module === PerBandLinearRescale);
    expect(mask).toBeDefined();
    // Mask bounds == the resolved rescale window (same [lo, hi]).
    const rescaleMin = (rescale!.props!.rescaleMin as number[])[0];
    const rescaleMax = (rescale!.props!.rescaleMax as number[])[0];
    expect(mask!.props!.maskMin).toBe(rescaleMin);
    expect(mask!.props!.maskMax).toBe(rescaleMax);
  });
});

describe("texture-array pipeline: mask below/above rescale", () => {
  const baseTexState = {
    frameIndex: 0,
    colormap: "viridis",
    gamma: 1,
    stretch: "linear" as const,
    maskBelow: false,
    maskAbove: false,
  };
  // renderTile only reads `data.texture`; cast a minimal stub.
  const data = { texture: fakeTexture } as unknown as TextureArrayTileData;

  it("omits the mask module when neither side is set", () => {
    const renderTile = buildTextureArrayRenderTile(
      { ...baseTexState, rescale: [10, 20] },
      fakeTexture,
      null,
    );
    const pipe = renderTile(data).renderPipeline as Mod[];
    expect(pipe.some((m) => m.module === MaskOutsideRange)).toBe(false);
  });

  it("masks both sides immediately before rescale with raw bounds", () => {
    const renderTile = buildTextureArrayRenderTile(
      { ...baseTexState, rescale: [10, 20], maskBelow: true, maskAbove: true },
      fakeTexture,
      null,
    );
    const pipe = renderTile(data).renderPipeline as Mod[];
    const maskIdx = pipe.findIndex((m) => m.module === MaskOutsideRange);
    const rescaleIdx = pipe.findIndex((m) => m.module === LinearRescale);
    expect(maskIdx).toBeGreaterThanOrEqual(0);
    expect(maskIdx + 1).toBe(rescaleIdx);
    expect(pipe[maskIdx]!.props).toEqual({ maskMin: 10, maskMax: 20 });
  });

  it("masks only below / only above via the sentinels", () => {
    const below = buildTextureArrayRenderTile(
      { ...baseTexState, rescale: [10, 20], maskBelow: true },
      fakeTexture,
      null,
    )(data).renderPipeline as Mod[];
    expect(below.find((m) => m.module === MaskOutsideRange)!.props).toEqual({
      maskMin: 10,
      maskMax: MASK_NO_UPPER,
    });
    const above = buildTextureArrayRenderTile(
      { ...baseTexState, rescale: [10, 20], maskAbove: true },
      fakeTexture,
      null,
    )(data).renderPipeline as Mod[];
    expect(above.find((m) => m.module === MaskOutsideRange)!.props).toEqual({
      maskMin: MASK_NO_LOWER,
      maskMax: 20,
    });
  });

  it("does not mask when no window resolves", () => {
    const renderTile = buildTextureArrayRenderTile(
      { ...baseTexState, rescale: null, maskBelow: true, maskAbove: true },
      fakeTexture,
      null,
    );
    const pipe = renderTile(data).renderPipeline as Mod[];
    expect(pipe.some((m) => m.module === MaskOutsideRange)).toBe(false);
  });
});
