import { openV3Group } from "../../load-zarr";
import type { ZarrProfile } from "../../profile";
import { ImageOrthographicControls } from "./controls";
import { parseOme } from "./ome";
import type {
  ImageOrthographicContext,
  ImageOrthographicState,
} from "./types";

/** Non-geographic image profile for OME-Zarr bioimaging stores.
 *
 * Microscopy OME-Zarr has no CRS or lat/lon coords — it's pixel-space data
 * (typically `t,c,z,y,x` with channels). The geographic `scalar-grid` profile
 * rejects it, so this profile renders into a standalone deck.gl
 * `OrthographicView` instead of the MapLibre map (see {@link ImageViewer}).
 *
 * MVP scope: load the coarsest pyramid level whole and show one channel as a
 * grayscale BitmapLayer. Tiling, z/t scrubbing, and pixel-value hover are
 * Stage 2. Select with `?p=image-orthographic`. */
export const imageOrthographicProfile: ZarrProfile<
  ImageOrthographicState,
  ImageOrthographicContext
> = {
  id: "image-orthographic",
  label: "Image (OME-Zarr)",
  host: "image",
  needsColormap: false,

  async prepare(url, signal) {
    // OME-Zarr ships no consolidated metadata; open plain and descend.
    const opened = await openV3Group(url, { consolidated: false });
    const ome = await parseOme(opened.group, signal);
    return {
      url,
      group: opened.group,
      seriesPath: ome.seriesPath,
      axes: ome.axes,
      channelAxisIndex: ome.channelAxisIndex,
      spatialAxes: ome.spatialAxes,
      otherAxes: ome.otherAxes,
      channels: ome.channels,
      channelCount: ome.channelCount,
      coarseArray: ome.coarseArray,
      width: ome.width,
      height: ome.height,
      levels: ome.levels,
      coarseVariablePath: ome.coarseVariablePath,
    };
  },

  initialState(ctx) {
    // Default to the first omero-active channel, else channel 0.
    const firstActive = ctx.channels.findIndex((c) => c.active);
    return { channel: firstActive >= 0 ? firstActive : 0 };
  },

  parseUrlParams(p) {
    const out: Partial<ImageOrthographicState> = {};
    const c = p.get("c");
    if (c !== null && Number.isFinite(Number(c))) out.channel = Number(c);
    return out;
  },

  serializeUrlParams(s) {
    return { c: String(s.channel) };
  },

  Controls: ImageOrthographicControls,

  // Expose the opened coarse array as the chassis `node` so the Structure
  // panel shows its shape/dtype/chunks.
  resolveNode: async (ctx) => ctx.coarseArray,

  // Rendering happens in ImageViewer (OrthographicView), not via a deck.gl
  // layer in the map overlay.
  buildLayer: () => null,

  getStructure: (ctx) => ({
    zarrVersion: "v3",
    variables: [{ path: ctx.coarseVariablePath }],
    metadataSource: "store-native",
    metadata: { ome: (ctx.group.attrs as Record<string, unknown>).ome },
  }),
};
