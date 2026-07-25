/** Discover multiscale pyramids in a store — on the store ROOT and/or on DEPTH-1
 * CHILD groups (nested pyramids, e.g. the USDA CDL store's `/10m` and `/30m`
 * products). The pure parsers live in `../../multiscale`; the I/O (opening child
 * groups + their `spatial_ref`) lives here, next to the profile that uses it. */

import * as zarr from "zarrita";
import { createLogger } from "../../../log";
import type { OpenedStore } from "../../load-zarr";
import {
  attrsHaveMultiscale,
  type MultiscaleLayout,
  parseMultiscaleDatasets,
  parseMultiscaleLayout,
} from "../../multiscale";

const log = createLogger("profile");

export type PyramidSource = {
  /** "" for the store root, else the child group path (e.g. "10m"). */
  prefix: string;
  /** Display label. */
  label: string;
  /** Parsed native `{layout}`, or null for the legacy CF `{datasets}` form. */
  layout: MultiscaleLayout | null;
  /** Legacy CF dataset paths (coarsest→finest), or null for the layout form. */
  datasets: string[] | null;
  /** `proj:code` for this pyramid (from the layout or the group's `crs` attr). */
  crsCode: string | null;
  /** `crs_wkt` from `<prefix>/spatial_ref` — preferred for offline CRS resolution. */
  crsWkt: string | null;
};

/** Depth-1 child group paths (single path segment) from a consolidated
 * `contents()` listing. Pure; shared with the scalar-grid nested-detection probe. */
export function childGroupPaths(
  contents: { path: string; kind: "array" | "group" }[],
): string[] {
  return contents
    .filter((e) => e.kind === "group")
    .map((e) => e.path.replace(/^\/+/, ""))
    .filter((p) => p !== "" && !p.includes("/"));
}

/** Finest-level pixel size for ordering (native/finest product first). Layout
 * sources use `|layout.levels[0]["spatial:transform"][0]|`; CF sources (no
 * per-level transform without extra I/O) sort last. Pure. */
export function finestPixelSizeOf(src: PyramidSource): number {
  const t = src.layout?.levels[0]?.["spatial:transform"]?.[0];
  return typeof t === "number" && Number.isFinite(t) && t !== 0
    ? Math.abs(t)
    : Number.POSITIVE_INFINITY;
}

/** Read `<prefix>/spatial_ref`'s `crs_wkt` (offline CRS), or null when absent. */
async function readCrsWkt(
  root: zarr.Group<zarr.Readable>,
  prefix: string,
): Promise<string | null> {
  const path = prefix ? `${prefix}/spatial_ref` : "spatial_ref";
  try {
    const sr = await zarr.open(root.resolve(path), { kind: "array" });
    const a = sr.attrs as Record<string, unknown>;
    if (typeof a.crs_wkt === "string" && a.crs_wkt) return a.crs_wkt;
    if (typeof a.spatial_ref === "string" && a.spatial_ref) return a.spatial_ref;
  } catch {
    // no spatial_ref array under this pyramid
  }
  return null;
}

/** CRS code from a group's own attrs — GeoZarr `proj:code` or a bare `crs`
 * `"EPSG:####"` (the CDL product groups use `crs`). */
function groupCrsCode(attrs: unknown): string | null {
  const a = attrs as Record<string, unknown>;
  if (typeof a["proj:code"] === "string") return a["proj:code"];
  if (typeof a.crs === "string" && /^[A-Za-z]+:\d+$/.test(a.crs)) return a.crs;
  return null;
}

async function buildSource(
  root: zarr.Group<zarr.Readable>,
  prefix: string,
  attrs: unknown,
): Promise<PyramidSource> {
  const layout = parseMultiscaleLayout(attrs);
  const datasets = layout ? null : parseMultiscaleDatasets(attrs);
  const crsCode = layout?.crs.code ?? groupCrsCode(attrs);
  const crsWkt = layout?.crs.wkt2 ?? (await readCrsWkt(root, prefix));
  return { prefix, label: prefix || "root", layout, datasets, crsCode, crsWkt };
}

/** Find every multiscale pyramid in the store: the root group if it carries a
 * `multiscales` attr, plus any depth-1 child group that does. Sorted finest-first
 * so the native product defaults first. Cost is bounded: a plain store has no
 * child groups (nothing opened); consolidated/icechunk child opens are cached
 * metadata reads. Returns `[]` when nothing is a pyramid. */
export async function discoverPyramids(
  opened: OpenedStore,
  contents: { path: string; kind: "array" | "group" }[],
  signal: AbortSignal,
): Promise<PyramidSource[]> {
  const sources: PyramidSource[] = [];
  if (attrsHaveMultiscale(opened.group.attrs)) {
    sources.push(await buildSource(opened.group, "", opened.group.attrs));
  }
  for (const g of childGroupPaths(contents)) {
    if (signal.aborted) break;
    let child: zarr.Group<zarr.Readable>;
    try {
      child = await zarr.open(opened.group.resolve(g), { kind: "group" });
    } catch (err) {
      log.debug(`discoverPyramids: could not open child group "${g}"`, err);
      continue;
    }
    if (attrsHaveMultiscale(child.attrs)) {
      sources.push(await buildSource(opened.group, g, child.attrs));
    }
  }
  sources.sort((a, b) => finestPixelSizeOf(a) - finestPixelSizeOf(b));
  return sources;
}
