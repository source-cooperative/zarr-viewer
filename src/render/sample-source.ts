/**
 * In-memory registry of already-decoded tiles, so the hover tooltip can read a
 * data value at an array (row, col) synchronously — without re-fetching or
 * re-decoding (some stores have one chunk ≈ 100–600 MB). Both scalar-grid tile
 * loaders register the tile they just decoded; the profile's `sampleValue`
 * reads back. Records hold only *references* to data the loaders/`decodedChunkCache`
 * already keep, so this adds ~no memory.
 */

/** One registered tile: enough to read a CF-decoded value at a local cell. */
export type SampleTile = {
  /** Array row/col of local (0, 0) — the spatial slice `start`s. */
  rowStart: number;
  colStart: number;
  /** Local extent (matches the tile's `width`/`height`). */
  height: number;
  width: number;
  /** CF-decoded value at a local cell + frame. NaN for fill / out-of-range.
   * `frame` is ignored by single-frame (scalar) tiles. */
  valueAt: (localRow: number, localCol: number, frame: number) => number;
};

/** How many recent selections (`sampleKey`s) to retain. Keeping a few — rather
 * than wiping every other bucket on a key switch — means a late tile from a
 * superseded selection can't erase the active bucket, and flipping a dim back
 * is instant. The oldest key is dropped once this many are live. */
export const MAX_KEYS = 4;

/** Per-key memory budget. A coarse global grid stored as a single shard is
 * tiled by its (small) inner chunk, so one selection can span hundreds of tiles
 * — far past the old fixed count cap, which silently dropped most of the plane
 * (so the tooltip worked only over the last-loaded tiles). Bounding by bytes
 * keeps a whole coarse plane (tiles are tiny) while still capping a store whose
 * tiles are large. Mirrors {@link decodedChunkCache}'s byte-LRU. */
export const MAX_BYTES_PER_KEY = 128 * 1e6;

type Entry = { tile: SampleTile; bytes: number };
type Bucket = { tiles: Map<string, Entry>; bytes: number }; // tileKey -> entry (insertion order = LRU)
const registry = new Map<string, Bucket>(); // sampleKey -> bucket (insertion order = key LRU)

const tileKey = (x: number, y: number, z: number) => `${x},${y},${z}`;

/** Move `sampleKey` to the most-recently-used end of the key LRU. */
function touch(sampleKey: string, bucket: Bucket): void {
  registry.delete(sampleKey);
  registry.set(sampleKey, bucket);
}

/**
 * Register a decoded tile under `sampleKey`. `byteLength` is the size of the
 * data the tile's `valueAt` references, used to bound per-key memory. Within a
 * key, least-recently-registered tiles are evicted past {@link MAX_BYTES_PER_KEY};
 * across keys, the least-recently-used selection is dropped past {@link MAX_KEYS}.
 */
export function registerSampleTile(
  sampleKey: string,
  x: number,
  y: number,
  z: number,
  tile: SampleTile,
  byteLength: number,
): void {
  let bucket = registry.get(sampleKey);
  if (bucket) touch(sampleKey, bucket);
  else {
    bucket = { tiles: new Map(), bytes: 0 };
    registry.set(sampleKey, bucket);
  }
  const k = tileKey(x, y, z);
  const prev = bucket.tiles.get(k);
  if (prev) {
    bucket.tiles.delete(k); // refresh recency + drop old bytes
    bucket.bytes -= prev.bytes;
  }
  bucket.tiles.set(k, { tile, bytes: byteLength });
  bucket.bytes += byteLength;
  // Evict least-recently-used tiles past the per-key budget (keep ≥1 so a
  // single oversized tile still works).
  while (bucket.bytes > MAX_BYTES_PER_KEY && bucket.tiles.size > 1) {
    const oldest = bucket.tiles.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    bucket.bytes -= bucket.tiles.get(oldest)!.bytes;
    bucket.tiles.delete(oldest);
  }
  // Drop the least-recently-used whole selection past the key budget.
  while (registry.size > MAX_KEYS) {
    const oldestKey = registry.keys().next().value as string | undefined;
    if (oldestKey === undefined || oldestKey === sampleKey) break;
    registry.delete(oldestKey);
  }
}

/**
 * Read the value at array `(row, col)` for `sampleKey`, scanning the bucket for
 * the loaded tile that covers it. Returns `null` when no tile covers it
 * (zoomed-out gap, stale selection, edge). A fill cell returns `NaN`.
 */
export function readSampleValue(
  sampleKey: string,
  row: number,
  col: number,
  frame: number,
): number | null {
  const bucket = registry.get(sampleKey);
  if (!bucket) return null;
  // Refresh recency so the actively-hovered selection isn't aged out of the
  // key LRU by background registrations under other keys.
  touch(sampleKey, bucket);
  for (const { tile: t } of bucket.tiles.values()) {
    const lr = row - t.rowStart;
    const lc = col - t.colStart;
    if (lr >= 0 && lr < t.height && lc >= 0 && lc < t.width) {
      return t.valueAt(lr, lc, frame);
    }
  }
  return null;
}

/** Test seam: forget everything (so suites don't leak the module-level state). */
export function _resetSampleSource(): void {
  registry.clear();
}
