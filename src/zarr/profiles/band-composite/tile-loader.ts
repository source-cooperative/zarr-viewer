import type { MinimalTileData } from "@developmentseed/deck.gl-raster";
import type { GetTileDataOptions } from "@developmentseed/deck.gl-zarr";
import type { Texture } from "@luma.gl/core";
import * as zarr from "zarrita";
import { createLogger } from "../../../log";
import { tileLoadEnd, tileLoadStart } from "../../../render/tile-activity";
import { reportTileError, reportTileResult } from "../../tile-error";
const log = createLogger("tiles");

export type BandCompositeTileData = MinimalTileData & {
  /** r8sint Texture2DArray; depth = number of bands in the array. Layer `i` = band `i`. */
  texture: Texture;
};

/** Tile loader for band-composite: slice one spatial tile × all bands (year
 * is pinned by `selection`), then upload the int8 data as an r8sint
 * Texture2DArray. Zarrita's row-major `[band, y, x]` layout matches the
 * Texture2DArray's layer-major storage one-for-one — no transpose.
 * Multiple zarr chunks along the band axis are fetched and concatenated
 * automatically by zarrita before upload. */
export async function getBandCompositeTileData(
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
      // Surface persistent (non-abort) tile failures; rethrow so deck.gl
      // leaves a gap rather than rendering stale data.
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
      `Band-composite tile expected 3D [band,H,W]; got [${chunk.shape.join(",")}]`,
    );
  }
  const numBands = chunk.shape[0]!;
  if (numBands > 256) {
    throw new Error(
      `Band-composite tile has ${numBands} bands; exceeds WebGL2 Texture2DArray layer limit of 256`,
    );
  }
  if (chunk.shape[1] !== height || chunk.shape[2] !== width) {
    throw new Error(
      `Band-composite tile shape mismatch: expected [${numBands},${height},${width}], got [${chunk.shape.join(",")}]`,
    );
  }

  const texture = device.createTexture({
    dimension: "2d-array",
    format: "r8sint",
    width,
    height,
    depth: numBands,
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
}
