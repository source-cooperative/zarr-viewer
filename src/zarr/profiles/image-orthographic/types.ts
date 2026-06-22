import type * as zarr from "zarrita";
import type { ProfileBaseContext } from "../../profile";

/** One axis from an OME-Zarr `multiscales[].axes` entry. `type` is
 * `"space"` | `"channel"` | `"time"` | (others); `unit` is optional. */
export type OmeAxis = {
  name: string;
  type: string;
  unit?: string;
};

/** A pyramid level: the array path (relative to the multiscale group) and its
 * per-axis scale (from `coordinateTransformations`). Finest level first. */
export type OmeLevel = {
  path: string;
  scale: number[];
};

/** A channel description from OME-Zarr `omero.channels`. `start`/`end` are the
 * suggested intensity display window; `label` names the channel. */
export type OmeChannel = {
  label: string;
  /** 6-digit hex (e.g. "00FF00"), no leading "#". May be empty. */
  color: string;
  start: number;
  end: number;
  active: boolean;
};

export type ImageOrthographicContext = ProfileBaseContext & {
  url: string;
  /** Root group (for the Structure panel). For a bioformats2raw layout this
   * is the wrapper above the multiscale series group. */
  group: zarr.Group<zarr.Readable>;
  /** Path from the root to the multiscale image group (e.g. "0" for a
   * bioformats2raw series, or "" when multiscales live at the root). */
  seriesPath: string;
  /** Axes in array order (matches `coarseArray.shape`). */
  axes: OmeAxis[];
  /** Index into `axes` of the channel axis, or null if none. */
  channelAxisIndex: number | null;
  /** Indices into `axes` of the (y, x) spatial pair. */
  spatialAxes: { yIndex: number; xIndex: number };
  /** Non-spatial, non-channel axes (time / z). MVP pins these to index 0. */
  otherAxes: { name: string; axisIndex: number; size: number }[];
  /** From `omero.channels`; empty when the store has no omero block. */
  channels: OmeChannel[];
  channelCount: number;
  /** Coarsest pyramid level — opened and rendered whole in the MVP. */
  coarseArray: zarr.Array<zarr.DataType, zarr.Readable>;
  /** Spatial size of the coarse level, in pixels. */
  width: number;
  height: number;
  /** Full pyramid (finest-first), kept for the Structure panel / Stage 2. */
  levels: OmeLevel[];
  /** Array path of the coarse level, relative to the root group. */
  coarseVariablePath: string;
};

export type ImageOrthographicState = {
  /** Selected channel index (0-based). */
  channel: number;
};
