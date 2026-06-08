import type { Device, Texture, TextureFormat } from "@luma.gl/core";

/** UV transform vec4 = (offsetX, offsetY, scaleX, scaleY). Identity since
 * we never reproject within a tile. */
type UvTransform = [number, number, number, number];
const IDENTITY_UV: UvTransform = [0, 0, 1, 1];

/** Per-tile data fed to the shared single-band render pipeline. */
export type MultiBandTileData = {
  /** One r-channel texture per band, keyed by 1-based index as a string
   * (so it can flow into `buildCompositeBandsProps`). */
  bands: Map<string, { texture: Texture; uvTransform: UvTransform }>;
  width: number;
  height: number;
  byteLength: number;
  nodata: number | null;
  /** Source-unit → GPU-sample-unit divisor. r8unorm → 255; r32float → 1. */
  sampleScale: number;
};

/** Standard TypedArrays accepted by `buildMultiBandTile`. */
type AcceptableArray =
  | Uint8Array
  | Uint8ClampedArray
  | Int8Array
  | Uint16Array
  | Int16Array
  | Uint32Array
  | Int32Array
  | Float32Array
  | Float64Array;

/** Best-effort GPU-texture cleanup. `RasterTileLayer` doesn't surface
 * `onTileUnload`, so we register the textures with a `FinalizationRegistry`
 * which fires shortly after deck.gl evicts the tile data. Bounds the leak
 * rather than eliminating it. */
const tileFinalizer =
  typeof FinalizationRegistry !== "undefined"
    ? new FinalizationRegistry<Texture[]>((textures) => {
        for (const t of textures) {
          try {
            t.destroy();
          } catch {
            // best-effort
          }
        }
      })
    : null;

function singleBandFormat(data: AcceptableArray): TextureFormat {
  if (data instanceof Uint8Array || data instanceof Uint8ClampedArray) {
    return "r8unorm";
  }
  return "r32float";
}

function sampleScaleForFormat(format: TextureFormat): number {
  return format === "r8unorm" ? 255 : 1;
}

/** Cast non-Float32 source data to Float32 for upload into `r32float`
 * textures. `r8unorm` passes Uint8Array straight through. */
function coerceForFormat(
  array: AcceptableArray,
  format: TextureFormat,
): AcceptableArray {
  if (format !== "r32float") return array;
  if (array instanceof Float32Array) return array;
  return Float32Array.from(array);
}

/** WebGL2 guarantees `MAX_TEXTURE_SIZE` ≥ 2048; real GPUs report 8192–16384.
 * Used only if the device doesn't expose its limit. */
const FALLBACK_MAX_TEXTURE_DIM = 8192;

function maxTextureDim(device: Device): number {
  const lim = (device.limits as { maxTextureDimension2D?: number } | undefined)
    ?.maxTextureDimension2D;
  return typeof lim === "number" && lim > 0 ? lim : FALLBACK_MAX_TEXTURE_DIM;
}

/** Decimate a single-band plane to fit `maxDim` on each axis (nearest/stride
 * downsample), returning the original array untouched when it already fits.
 *
 * Display-only and lossy: a store whose spatial plane exceeds the GPU's max 2D
 * texture size (e.g. an 18000-wide global 0.02° grid on a device capped at
 * 16384) would otherwise fail `createTexture` and render as all-zero. The
 * texture still spans the same geographic extent (tiles use identity UV) and
 * the full-resolution hover sample is registered separately by the tile
 * loader, so geo-referencing and tooltip values are unaffected — only the
 * rendered raster loses detail. */
export function decimateToMaxDim(
  data: AcceptableArray,
  width: number,
  height: number,
  maxDim: number,
): { data: AcceptableArray; width: number; height: number } {
  if (width <= maxDim && height <= maxDim) return { data, width, height };
  const factor = Math.ceil(Math.max(width, height) / maxDim);
  const w = Math.ceil(width / factor);
  const h = Math.ceil(height / factor);
  const out = new (data.constructor as new (n: number) => AcceptableArray)(
    w * h,
  );
  for (let r = 0; r < h; r++) {
    const srcRow = Math.min(r * factor, height - 1) * width;
    const dstRow = r * w;
    for (let c = 0; c < w; c++) {
      out[dstRow + c] = data[srcRow + Math.min(c * factor, width - 1)]!;
    }
  }
  return { data: out, width: w, height: h };
}

export type BandInput = { key: string; data: AcceptableArray };

/** Build a `MultiBandTileData` from one or more single-band typed arrays.
 * Each band becomes an r-channel texture keyed by `band.key`. */
export function buildMultiBandTile(
  device: Device,
  bands: readonly BandInput[],
  width: number,
  height: number,
  nodata: number | null,
): MultiBandTileData {
  const out = new Map<string, { texture: Texture; uvTransform: UvTransform }>();
  let totalBytes = 0;
  let sampleScale = 1;
  const maxDim = maxTextureDim(device);
  for (const { key, data: raw } of bands) {
    const format = singleBandFormat(raw);
    const coerced = coerceForFormat(raw, format);
    // Planes wider/taller than the GPU's max texture size must be decimated
    // or the upload silently fails and the tile renders all-zero (identity UV
    // keeps the smaller texture spanning the full tile extent).
    const fit = decimateToMaxDim(coerced, width, height, maxDim);
    sampleScale = sampleScaleForFormat(format);
    const texture = device.createTexture({
      data: fit.data,
      format,
      width: fit.width,
      height: fit.height,
    });
    out.set(key, { texture, uvTransform: IDENTITY_UV });
    totalBytes += fit.width * fit.height * fit.data.BYTES_PER_ELEMENT;
  }
  const result: MultiBandTileData = {
    bands: out,
    width,
    height,
    byteLength: totalBytes,
    nodata,
    sampleScale,
  };
  if (tileFinalizer && out.size > 0) {
    tileFinalizer.register(
      result,
      Array.from(out.values(), (v) => v.texture),
    );
  }
  return result;
}
