import type {
  RasterModule,
  RenderTileResult,
} from "@developmentseed/deck.gl-raster";
import {
  buildCompositeBandsProps,
  COLORMAP_INDEX,
  Colormap,
  CompositeBands,
  FilterNoDataVal,
} from "@developmentseed/deck.gl-raster/gpu-modules";
import type { Texture } from "@luma.gl/core";
import {
  FilterNaN,
  Gamma,
  LogStretch,
  MaskOutsideRange,
  PerBandLinearRescale,
  SqrtStretch,
} from "./shader-modules";
import {
  percentileFromHistogram,
  type AutoStats,
  type BandStats,
} from "./stats";
import type { MultiBandTileData } from "./shared-textures";
import type { Stretch } from "../state/types";

const RESCALE_EPSILON = 1e-9;
const DEFAULT_PERCENTILE_LO = 0.02;
const DEFAULT_PERCENTILE_HI = 0.98;

const safeRange = ([lo, hi]: [number, number]): [number, number] =>
  lo === hi ? [lo, lo + RESCALE_EPSILON] : [lo, hi];

function autoRangeFor(stats: BandStats): [number, number] {
  const hasBins = stats.histogram.some((b) => b > 0);
  if (!hasBins) return [stats.min, stats.max];
  return [
    percentileFromHistogram(stats, DEFAULT_PERCENTILE_LO),
    percentileFromHistogram(stats, DEFAULT_PERCENTILE_HI),
  ];
}

/** State the single-band pipeline cares about. Profile builds this from its
 * own state shape; chassis fields like `colormap`/`gamma`/`stretch` flow
 * through from `ViewerState`. */
export type SingleBandRenderState = {
  /** Resolved colormap name (e.g. "turbo", "viridis"). */
  colormap: string;
  /** Explicit user-set rescale window. Falls back to autoStats percentile. */
  rescale: [number, number] | null;
  gamma: number;
  stretch: Stretch;
  /** Explicit nodata override; `null` means use the tile's own nodata; `"off"` disables. */
  nodata: number | "off" | null;
  /** When true, discard pixels outside the resolved rescale window. */
  maskOutsideRescale: boolean;
};

function effectiveNodata(
  state: SingleBandRenderState,
  perTileNodata: number | null,
): number | null {
  if (state.nodata === "off") return null;
  if (typeof state.nodata === "number") return state.nodata;
  return perTileNodata;
}

function nodataModule(
  nodata: number,
  sampleScale: number,
): RasterModule | null {
  if (Number.isNaN(nodata)) {
    return { module: FilterNaN };
  }
  if (!Number.isFinite(nodata)) return null;
  return {
    module: FilterNoDataVal,
    props: { value: nodata / sampleScale },
  };
}

function pushAdjustments(state: SingleBandRenderState, pipeline: RasterModule[]): void {
  if (state.stretch === "log") {
    pipeline.push({ module: LogStretch, props: { strength: 99 } });
  } else if (state.stretch === "sqrt") {
    pipeline.push({ module: SqrtStretch });
  }
  if (state.gamma !== 1) {
    pipeline.push({ module: Gamma, props: { gamma: state.gamma } });
  }
}

function resolveRescale(
  state: SingleBandRenderState,
  autoStats: AutoStats | null,
): [number, number] | null {
  if (state.rescale) return safeRange(state.rescale);
  const band = autoStats?.global ?? null;
  if (!band) return null;
  return safeRange(autoRangeFor(band));
}

/** Render a single-band `MultiBandTileData` (one r-channel texture keyed
 * `"1"`) as a colormapped raster. Pipeline: CompositeBands → nodata filter
 * → per-band rescale → stretch → gamma → colormap. */
export function buildSingleBandRenderTile(
  state: SingleBandRenderState,
  colormapTexture: Texture,
  autoStats: AutoStats | null,
) {
  const name = state.colormap.toLowerCase();
  const colormapIndex =
    (COLORMAP_INDEX as Record<string, number>)[name] ?? COLORMAP_INDEX.viridis;

  return function renderTile(data: MultiBandTileData): RenderTileResult {
    if (data.bands.size === 0) return { renderPipeline: [] };
    const firstKey = data.bands.keys().next();
    if (firstKey.done) return { renderPipeline: [] };
    const band = firstKey.value;

    const compositeProps = buildCompositeBandsProps(
      { r: band, g: band, b: band },
      data.bands,
    );
    const pipeline: RasterModule[] = [
      { module: CompositeBands, props: compositeProps },
    ];

    const nodata = effectiveNodata(state, data.nodata);
    let explicitNodataModule: RasterModule | null = null;
    if (nodata !== null) {
      explicitNodataModule = nodataModule(nodata, data.sampleScale);
      if (explicitNodataModule) pipeline.push(explicitNodataModule);
    }

    const isFloatTexture = data.sampleScale === 1;
    const filterNaNAlreadyPushed = explicitNodataModule?.module === FilterNaN;
    if (
      isFloatTexture &&
      state.nodata !== "off" &&
      !filterNaNAlreadyPushed
    ) {
      pipeline.push({ module: FilterNaN });
    }

    const rescale = resolveRescale(state, autoStats);
    if (rescale) {
      const [lo, hi] = rescale;
      if (state.maskOutsideRescale) {
        pipeline.push({
          module: MaskOutsideRange,
          props: {
            maskMin: lo / data.sampleScale,
            maskMax: hi / data.sampleScale,
          },
        });
      }
      pipeline.push({
        module: PerBandLinearRescale,
        props: {
          rescaleMin: [
            lo / data.sampleScale,
            lo / data.sampleScale,
            lo / data.sampleScale,
          ],
          rescaleMax: [
            hi / data.sampleScale,
            hi / data.sampleScale,
            hi / data.sampleScale,
          ],
        },
      });
    }

    pushAdjustments(state, pipeline);

    pipeline.push({
      module: Colormap,
      props: { colormapTexture, colormapIndex, reversed: false },
    });

    return { renderPipeline: pipeline };
  };
}
