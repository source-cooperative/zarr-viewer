/**
 * Types + helpers for the Structure panel (Zarr-store introspection).
 *
 * Each profile knows its own metadata story (whether GeoZarr attrs are
 * store-native, hand-injected, or synthesized from coord arrays), so the
 * profile contributes a `StructureProfileSummary`. Everything else
 * (shape / dtype / chunks / fill value / attrs) is introspected by the
 * Structure panel directly from the opened `zarr.Array`, plus a one-shot
 * `fetchCodecSummary()` for sharding/compressor info (zarrita doesn't
 * expose codec details on the public `Array` surface).
 */

/** Where the GeoZarr-style attrs handed to `ZarrLayer.metadata` came from. */
export type GeoZarrMetadataSource =
  /** Already on the store at open time (AEF, FTW). */
  | "store-native"
  /** Hand-crafted constant injected because the store has no GeoZarr
   * attrs of its own. */
  | "injected"
  /** Built at prepare-time from coord arrays or other store metadata
   * (FireSmoke). */
  | "synthesized";

export type StructureVariable = {
  /** Path within the root group (e.g. `"temperature_2m"`, `"PM25_latest"`). */
  path: string;
  /** Optional human role for multi-array setups (`"red"` / `"green"` /
   * `"level 0"` / etc.). Renderer ignores when omitted. */
  role?: string;
};

export type StructureProfileSummary = {
  /** "v2" | "v3" — matches how the profile opened the store. All current
   * profiles use `zarr.open.v3` → `"v3"`. */
  zarrVersion: "v2" | "v3";
  /** One entry per array the profile considers part of this view. The
   * first entry is the primary one (drives the shape / dtype / codec
   * rows in the panel). Extras render as a sub-list. */
  variables: readonly [StructureVariable, ...StructureVariable[]];
  metadataSource: GeoZarrMetadataSource;
  /** The exact value handed to `ZarrLayer.metadata` (or `null` if the
   * layer reads attrs straight off the node). */
  metadata: unknown;
};

export type CodecSummary = {
  sharded: boolean;
  /** Sub-chunk shape from `sharding_indexed` codec, when present. */
  subChunkShape: readonly number[] | null;
  /** Display string like `"blosc(zstd, clevel=3, shuffle)"` or `"raw"`. */
  compressor: string | null;
};

/** Fetch and parse the primary array's metadata document, returning a
 * `CodecSummary` for the panel. Tries `zarr.json` (v3) first, falls back
 * to `.zarray` (v2). Returns `null` on any failure (404, JSON parse
 * error, abort) — the panel renders `"—"` for affected rows. */
export async function fetchCodecSummary(
  storeUrl: string,
  variablePath: string,
  signal: AbortSignal,
): Promise<CodecSummary | null> {
  const base = storeUrl.replace(/\/+$/, "");
  const path = variablePath.replace(/^\/+|\/+$/g, "");
  const v3Url = `${base}/${path}/zarr.json`;
  const v2Url = `${base}/${path}/.zarray`;

  const json = await fetchJson(v3Url, signal);
  if (json) return summarizeV3(json);
  if (signal.aborted) return null;

  const v2 = await fetchJson(v2Url, signal);
  if (v2) return summarizeV2(v2);
  return null;
}

async function fetchJson(
  url: string,
  signal: AbortSignal,
): Promise<unknown | null> {
  try {
    const resp = await fetch(url, { signal });
    if (!resp.ok) return null;
    return await resp.json();
  } catch {
    return null;
  }
}

/** Parse a Zarr v3 array's `zarr.json`. v3 codecs are a flat list under
 * `codecs[]`; sharding lives in a `sharding_indexed` codec with its own
 * inner `codecs[]` chain. */
function summarizeV3(json: unknown): CodecSummary | null {
  if (!isObject(json)) return null;
  if (json.node_type !== "array") return null;
  const codecs = Array.isArray(json.codecs) ? json.codecs : [];
  let sharded = false;
  let subChunkShape: readonly number[] | null = null;
  let innerCodecs: unknown[] = codecs;
  for (const c of codecs) {
    if (!isObject(c)) continue;
    if (c.name === "sharding_indexed") {
      sharded = true;
      const cfg = isObject(c.configuration) ? c.configuration : {};
      if (Array.isArray(cfg.chunk_shape)) {
        subChunkShape = cfg.chunk_shape.filter(
          (n): n is number => typeof n === "number",
        );
      }
      // Compressor lives in the *inner* codecs chain for sharded stores.
      if (Array.isArray(cfg.codecs)) innerCodecs = cfg.codecs;
    }
  }
  return {
    sharded,
    subChunkShape,
    compressor: describeCompressor(innerCodecs),
  };
}

/** Parse a Zarr v2 array's `.zarray`. Compressor is a single object
 * under `compressor` (or `null`). No sharding in v2. */
function summarizeV2(json: unknown): CodecSummary | null {
  if (!isObject(json)) return null;
  const compressor = json.compressor;
  if (compressor === null || compressor === undefined) {
    return { sharded: false, subChunkShape: null, compressor: "raw" };
  }
  if (!isObject(compressor)) return null;
  return {
    sharded: false,
    subChunkShape: null,
    compressor: formatCompressorObject(compressor),
  };
}

/** Build a one-line compressor string from a v3 inner-codec list. Skips
 * the `bytes` codec (always present, structural) and any unknown codecs
 * after the compressor — we only summarize the *primary* compressor. */
function describeCompressor(codecs: readonly unknown[]): string | null {
  for (const c of codecs) {
    if (!isObject(c)) continue;
    if (c.name === "bytes") continue; // endian / packing, not interesting
    return formatCompressorObject(c);
  }
  return "raw";
}

function formatCompressorObject(c: Record<string, unknown>): string {
  const name = typeof c.name === "string" ? c.name : typeof c.id === "string" ? c.id : "?";
  const cfg = isObject(c.configuration) ? c.configuration : c;
  // Pull the small set of fields commonly seen on blosc/zstd/gzip.
  const parts: string[] = [];
  if (typeof cfg.cname === "string") parts.push(cfg.cname);
  if (typeof cfg.clevel === "number") parts.push(`clevel=${cfg.clevel}`);
  if (typeof cfg.shuffle !== "undefined") {
    parts.push(`shuffle=${cfg.shuffle}`);
  }
  if (parts.length === 0) return name;
  return `${name}(${parts.join(", ")})`;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
