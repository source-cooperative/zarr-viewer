import type { MinimalTileData } from "@developmentseed/deck.gl-raster";
import type { GetTileDataOptions } from "@developmentseed/deck.gl-zarr";
import type { Texture } from "@luma.gl/core";
import * as zarr from "zarrita";
import { createLogger } from "../../../log";
import { registerSampleTile } from "../../../render/sample-source";
import { tileLoadEnd, tileLoadStart } from "../../../render/tile-activity";
import { reportTileError, reportTileResult } from "../../tile-error";
import { NUM_BANDS } from "./constants";

const log = createLogger("tiles");

export type BandCompositeTileData = MinimalTileData & {
  /** r8sint Texture2DArray; depth = NUM_BANDS. Layer `i` = band `i`. */
  texture: Texture;
};

/** Stable sampleKey for a given year index — shared between the tile loader
 * (registration) and the profile's sampleValue (read). */
export function bandCompositeSampleKey(year: number): string {
  return `band-composite:${year}`;
}

/** Tile loader factory for AEF: slice one spatial chunk × all 64 bands (year
 * is pinned by `selection`), upload the int8 data as an r8sint Texture2DArray,
 * and optionally register the decoded tile for hover-tooltip reads.
 *
 * Zarrita's row-major `[band, y, x]` layout matches the Texture2DArray's
 * layer-major storage one-for-one — no transpose. */
export function makeBandCompositeTileLoader(opts: {
  /** When set, register each decoded tile under this key so sampleValue can
   * read R/G/B values at hover time (see render/sample-source). */
  sampleKey?: string;
}) {
  return async function getBandCompositeTileData(
    arr: zarr.Array<"int8", zarr.Readable>,
    options: GetTileDataOptions,
  ): Promise<BandCompositeTileData> {
    const { device, sliceSpec, width, height, signal } = options;
    const t0 = log.isEnabled("debug") ? performance.now() : 0;
    tileLoadStart(options.z + 1);
    const chunk = await (async () => {
      try {
        return await zarr.get(arr, sliceSpec, { signal });
      } catch (err) {
        tileLoadEnd();
        reportTileError(err);
        log.debug(`tile ${options.x},${options.y},${options.z} failed`, err);
        throw err;
      }
    })();
    tileLoadEnd();
    reportTileResult(true);
    const { data } = chunk;
    if (log.isEnabled("debug")) {
      log.debug(
        `tile ${options.x},${options.y},${options.z} ${data.byteLength}B in ${Math.round(performance.now() - t0)}ms`,
      );
    }

    if (chunk.shape.length !== 3) {
      throw new Error(
        `AEF tile expected 3D [band,H,W]; got [${chunk.shape.join(",")}]`,
      );
    }
    if (chunk.shape[0] !== NUM_BANDS) {
      throw new Error(
        `AEF tile expected depth=${NUM_BANDS} bands; got ${chunk.shape[0]}`,
      );
    }
    if (chunk.shape[1] !== height || chunk.shape[2] !== width) {
      throw new Error(
        `AEF tile shape mismatch: expected [${NUM_BANDS},${height},${width}], got [${chunk.shape.join(",")}]`,
      );
    }

    if (opts.sampleKey) {
      // sliceSpec has the time dim pinned out, leaving [band, y, x].
      // Index [1] = y-slice, [2] = x-slice.
      const nd = sliceSpec.length;
      const rowStart = (sliceSpec[nd - 2] as zarr.Slice)?.start ?? 0;
      const colStart = (sliceSpec[nd - 1] as zarr.Slice)?.start ?? 0;
      const raw = data as Int8Array;
      const frameLen = height * width;
      registerSampleTile(
        opts.sampleKey,
        options.x,
        options.y,
        options.z,
        {
          rowStart,
          colStart,
          height,
          width,
          valueAt: (lr, lc, bandIdx) => {
            const v = raw[bandIdx * frameLen + lr * width + lc];
            return v === undefined ? Number.NaN : Number(v);
          },
        },
        raw.byteLength,
      );
    }

    const texture = device.createTexture({
      dimension: "2d-array",
      format: "r8sint",
      width,
      height,
      depth: NUM_BANDS,
      mipLevels: 1,
      data,
      sampler: {
        minFilter: "nearest",
        magFilter: "nearest",
        addressModeU: "clamp-to-edge",
        addressModeV: "clamp-to-edge",
      },
    });

    return { texture, width, height, byteLength: data.byteLength };
  };
}

/** Convenience export for callers that don't need hover tooltip support. */
export const getBandCompositeTileData = makeBandCompositeTileLoader({});
