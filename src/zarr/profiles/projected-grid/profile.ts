/** Renders a single-level **projected** grid (e.g. NOAA HRRR, Lambert Conformal
 * Conic) by emitting GeoZarr `proj:wkt2` metadata that `@developmentseed/deck.gl-zarr`
 * reprojects on the fly via proj4.
 *
 * It is the scalar-grid profile with one difference: instead of synthesizing a
 * lat/lon grid from 1-D coordinate arrays, `prepare` reads the store's CF
 * `spatial_ref` (crs_wkt + GDAL GeoTransform) and hands the WKT2 CRS to the
 * layer. Everything downstream (variable enumeration, dim sliders, tile loader,
 * colormap render pipeline, auto-stats) is reused unchanged — the only other
 * override is `sampleValue`, disabled because the reused geographic affine
 * inversion doesn't apply to a projected CRS. Reached via the
 * `ProjectedGridStoreError` handoff from the scalar-grid profile.
 */
import type { ZarrProfile } from "../../profile";
import { bytesPerElement } from "../../chunk-size";
import { assertCodecsSupported } from "../../unsupported-codec";
import { openV3Group } from "../../load-zarr";
import { geoTransformToSpatial, readProjectedSpatialRef } from "../../projected";
import { createLogger } from "../../../log";
import { buildDimLabel } from "../scalar-grid/cf-coords";
import {
  deriveMinZoom,
  enumerateVariables,
  scalarGridProfile,
  shardSpatialShape,
} from "../scalar-grid/profile";
import type {
  ScalarGridContext,
  ScalarGridState,
} from "../scalar-grid/types";
import type * as zarr from "zarrita";

const log = createLogger("profile");

export const projectedGridProfile: ZarrProfile<
  ScalarGridState,
  ScalarGridContext
> = {
  ...scalarGridProfile,
  id: "projected-grid",
  label: "Projected grid (colormap)",

  async prepare(url, signal) {
    const done = log.time("projected-grid prepare", "info");
    const opened = await openV3Group(url, { consolidated: true });
    const arrays = new Map<
      string,
      zarr.Array<zarr.DataType, zarr.Readable>
    >();
    const variables = await enumerateVariables(opened.group, signal, arrays);
    if (variables.length === 0) {
      throw new Error(
        "Projected-grid profile: no renderable y/x gridded variables found.",
      );
    }
    const first = variables[0]!;
    const firstArr = arrays.get(first.name)!;
    await assertCodecsSupported(opened.store, first.name);

    const projected = await readProjectedSpatialRef(opened.group, first.group);
    if (!projected) {
      throw new Error(
        "Projected-grid profile: no projected `spatial_ref` (crs_wkt + " +
          "GeoTransform) found — this store isn't a projected grid.",
      );
    }
    const nd = firstArr.shape.length;
    const height = firstArr.shape[nd - 2] ?? 0;
    const width = firstArr.shape[nd - 1] ?? 0;
    const dimNames = firstArr.dimensionNames ?? [];
    const yName = (dimNames[nd - 2] as string) ?? "y";
    const xName = (dimNames[nd - 1] as string) ?? "x";
    const transform = geoTransformToSpatial(projected.geoTransform);

    // Single-resolution GeoZarr metadata (top-level transform/shape, not a
    // multiscale layout) so ZarrLayer uses the pre-opened array as its one
    // level — matching how the scalar-grid buildLayer feeds `node`. `proj:wkt2`
    // carries the store's Lambert Conformal WKT for offline CRS resolution.
    const spatialAttrs = {
      "spatial:dimensions": [yName, xName],
      "spatial:transform": transform,
      "spatial:shape": [height, width],
      "proj:wkt2": projected.crsWkt,
    };

    // Projected transforms are already in metres, so the pixel width is the
    // ground resolution directly (no degrees→metres conversion).
    const metersPerPx = Math.abs(transform[0]);
    // For a sharded array (e.g. the materialized/time-optimized HRRR Zarr,
    // sharded [1,49,1060,1800]), the atomic fetch is the OUTER shard, not the
    // inner sub-chunk, so gate on the shard when it spans the whole plane —
    // otherwise the small inner chunk mis-gates the store to a high zoom and it
    // renders blank at world/CONUS view. Mirrors the scalar-grid gate.
    let chunkH = firstArr.chunks[nd - 2] ?? 256;
    let chunkW = firstArr.chunks[nd - 1] ?? 256;
    try {
      const raw = await opened.store.get(
        `/${first.name}/zarr.json` as `/${string}`,
      );
      const shard = raw
        ? shardSpatialShape(JSON.parse(new TextDecoder().decode(raw)))
        : null;
      if (shard && shard[0] >= height && shard[1] >= width) {
        [chunkH, chunkW] = shard;
      }
    } catch {
      // keep inner chunk
    }
    const bundledChunkEls = firstArr.chunks
      .slice(0, nd - 2)
      .reduce((a, b) => a * b, 1);
    const minRenderZoom = deriveMinZoom(
      metersPerPx,
      chunkW,
      chunkH,
      bytesPerElement(firstArr.dtype),
      width,
      height,
      bundledChunkEls,
    );

    // CF labels for every non-spatial dim (dates / durations / index), keyed by
    // bare dim name, resolved from the subgroup that holds each coord array.
    const dimMeta = new Map<string, { size: number; group: string }>();
    for (const v of variables)
      for (const d of v.dims)
        if (!dimMeta.has(d.name))
          dimMeta.set(d.name, { size: d.size, group: v.group });
    const dimLabel: Record<string, (idx: number) => string> = {};
    for (const [name, { size, group }] of dimMeta) {
      if (signal.aborted) break;
      dimLabel[name] = await buildDimLabel(
        opened.group,
        group ? `${group}/${name}` : name,
        size,
      );
    }

    log.info(
      `prepared projected "${first.name}" ${firstArr.dtype} ` +
        `[${firstArr.shape.join(",")}] ${projected.gridMappingName ?? "wkt"}, ` +
        `metersPerPx=${Math.round(metersPerPx)}, minRenderZoom=${minRenderZoom}`,
    );
    done();
    return {
      url,
      group: opened.group,
      store: opened.store,
      variables,
      arrays,
      spatialAttrs,
      metadataSource: "store-native",
      rollLongitude: false,
      minRenderZoom,
      dimLabel,
    };
  },

  // The reused scalar-grid `sampleValue` inverts a geographic (lat/lon) affine,
  // which doesn't hold for a projected CRS — disable the hover readout rather
  // than report values from the wrong location. (A future version could proj4
  // the cursor lng/lat into the projected grid.)
  sampleValue: () => null,

  getStructure: (ctx, state: ScalarGridState) => ({
    zarrVersion: "v3",
    variables: [{ path: state.variable }],
    metadataSource: ctx.metadataSource,
    metadata: ctx.spatialAttrs,
  }),
};
