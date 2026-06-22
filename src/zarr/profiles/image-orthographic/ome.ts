import * as zarr from "zarrita";
import { createLogger } from "../../../log";
import type { OmeAxis, OmeChannel, OmeLevel } from "./types";

const log = createLogger("ome");

/** Minimal shape of the OME metadata block we read. Everything is optional /
 * cast loosely — stores vary, and we validate the parts we depend on. */
type OmeBlock = {
  multiscales?: {
    axes?: OmeAxis[];
    datasets?: { path: string; coordinateTransformations?: unknown[] }[];
  }[];
  omero?: { channels?: unknown[] };
  "bioformats2raw.layout"?: number;
};

function omeOf(group: zarr.Group<zarr.Readable>): OmeBlock | undefined {
  const attrs = group.attrs as Record<string, unknown>;
  const ome = attrs.ome;
  return typeof ome === "object" && ome !== null ? (ome as OmeBlock) : undefined;
}

/** Resolve the group that actually holds `multiscales`. For a bioformats2raw
 * layout the root is a wrapper whose images live under numbered series groups
 * (`0`, `1`, …); we descend into the first series. Returns the multiscale
 * group plus its path from the root (`""` when multiscales are at the root). */
async function resolveMultiscaleGroup(
  root: zarr.Group<zarr.Readable>,
  signal: AbortSignal,
): Promise<{ group: zarr.Group<zarr.Readable>; seriesPath: string }> {
  if (omeOf(root)?.multiscales?.length) {
    return { group: root, seriesPath: "" };
  }
  const layout = omeOf(root)?.["bioformats2raw.layout"];
  if (layout === 3) {
    // First image series. (Multi-series plates/wells would enumerate here;
    // the MVP renders series 0.)
    const series = await zarr.open.v3(root.resolve("0"), { kind: "group" });
    if (signal.aborted) throw new Error("aborted");
    if (omeOf(series)?.multiscales?.length) {
      return { group: series, seriesPath: "0" };
    }
  }
  throw new Error(
    "Not an OME-Zarr image: no `ome.multiscales` at the root or under series 0.",
  );
}

/** Pull the per-axis `scale` vector out of a dataset's coordinateTransformations
 * (OME requires exactly one `scale`; translation is optional and ignored). */
function scaleOf(transforms: unknown[] | undefined, ndim: number): number[] {
  if (Array.isArray(transforms)) {
    for (const t of transforms) {
      if (
        typeof t === "object" &&
        t !== null &&
        (t as { type?: string }).type === "scale" &&
        Array.isArray((t as { scale?: unknown }).scale)
      ) {
        return (t as { scale: number[] }).scale;
      }
    }
  }
  return new Array(ndim).fill(1);
}

function parseChannels(omero: { channels?: unknown[] } | undefined): OmeChannel[] {
  const raw = omero?.channels;
  if (!Array.isArray(raw)) return [];
  return raw.map((c, i): OmeChannel => {
    const o = (typeof c === "object" && c !== null ? c : {}) as Record<
      string,
      unknown
    >;
    const win = (
      typeof o.window === "object" && o.window !== null ? o.window : {}
    ) as Record<string, unknown>;
    const num = (v: unknown, fallback: number) =>
      typeof v === "number" && Number.isFinite(v) ? v : fallback;
    return {
      label: typeof o.label === "string" ? o.label : `channel ${i}`,
      color: typeof o.color === "string" ? o.color : "",
      start: num(win.start, num(win.min, 0)),
      end: num(win.end, num(win.max, 65535)),
      active: o.active !== false,
    };
  });
}

export type ParsedOme = {
  seriesPath: string;
  axes: OmeAxis[];
  channelAxisIndex: number | null;
  spatialAxes: { yIndex: number; xIndex: number };
  otherAxes: { name: string; axisIndex: number; size: number }[];
  channels: OmeChannel[];
  channelCount: number;
  levels: OmeLevel[];
  coarseArray: zarr.Array<zarr.DataType, zarr.Readable>;
  coarseVariablePath: string;
  width: number;
  height: number;
};

/** Parse an opened OME-Zarr root group into the facts the image profile needs,
 * opening the coarsest pyramid level so its shape is known. */
export async function parseOme(
  root: zarr.Group<zarr.Readable>,
  signal: AbortSignal,
): Promise<ParsedOme> {
  const { group, seriesPath } = await resolveMultiscaleGroup(root, signal);
  const ms = omeOf(group)!.multiscales![0]!;
  const axes = (ms.axes ?? []).map((a) => ({
    name: a.name,
    type: a.type,
    unit: a.unit,
  }));
  const datasets = ms.datasets ?? [];
  if (datasets.length === 0) throw new Error("OME-Zarr multiscale has no levels.");

  const levels: OmeLevel[] = datasets.map((d) => ({
    path: d.path,
    scale: scaleOf(d.coordinateTransformations, axes.length),
  }));
  // OME datasets are ordered finest-first; the last is the coarsest (smallest).
  const coarse = levels[levels.length - 1]!;
  const coarseArray = await zarr.open.v3(group.resolve(coarse.path), {
    kind: "array",
  });
  if (signal.aborted) throw new Error("aborted");

  // Spatial pair: the two axes typed "space", in order (y before x).
  const spaceIdx = axes
    .map((a, i) => ({ a, i }))
    .filter(({ a }) => a.type === "space")
    .map(({ i }) => i);
  if (spaceIdx.length < 2) {
    throw new Error(
      `OME-Zarr image needs two spatial axes; found ${spaceIdx.length}.`,
    );
  }
  const yIndex = spaceIdx[spaceIdx.length - 2]!;
  const xIndex = spaceIdx[spaceIdx.length - 1]!;

  const channelAxisIndex = axes.findIndex((a) => a.type === "channel");
  const channelCount =
    channelAxisIndex >= 0 ? (coarseArray.shape[channelAxisIndex] ?? 1) : 1;

  const otherAxes = axes
    .map((a, i) => ({ name: a.name, axisIndex: i, size: coarseArray.shape[i] ?? 1 }))
    .filter(({ axisIndex }) => axisIndex !== yIndex && axisIndex !== xIndex && axisIndex !== channelAxisIndex);

  const channels = parseChannels(omeOf(group)!.omero);

  log.info(
    `OME image: series="${seriesPath}" axes=[${axes.map((a) => a.name).join(",")}] ` +
      `levels=${levels.length} coarse=${coarse.path} ` +
      `${coarseArray.shape.join("×")} channels=${channelCount}`,
  );

  return {
    seriesPath,
    axes,
    channelAxisIndex: channelAxisIndex >= 0 ? channelAxisIndex : null,
    spatialAxes: { yIndex, xIndex },
    otherAxes,
    channels,
    channelCount,
    levels,
    coarseArray,
    coarseVariablePath: (seriesPath ? `${seriesPath}/` : "") + coarse.path,
    width: coarseArray.shape[xIndex] ?? 0,
    height: coarseArray.shape[yIndex] ?? 0,
  };
}
