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

/** Cap per key — roughly one viewport of chunks. Bounds the map size (records
 * are tiny; the big arrays they reference are bounded elsewhere). */
const MAX_TILES_PER_KEY = 64;

type Bucket = Map<string, SampleTile>; // tileKey -> tile (insertion order = LRU)
const registry = new Map<string, Bucket>(); // sampleKey -> bucket
let activeKey: string | null = null;

const tileKey = (x: number, y: number, z: number) => `${x},${y},${z}`;

/**
 * Register a decoded tile under `sampleKey`. Switching the active key drops
 * every other bucket — once the selection changes, stale tiles can never be
 * read again (the profile reads only the current key).
 */
export function registerSampleTile(
  sampleKey: string,
  x: number,
  y: number,
  z: number,
  tile: SampleTile,
): void {
  if (sampleKey !== activeKey) {
    registry.clear();
    activeKey = sampleKey;
  }
  let bucket = registry.get(sampleKey);
  if (!bucket) {
    bucket = new Map();
    registry.set(sampleKey, bucket);
  }
  const k = tileKey(x, y, z);
  bucket.delete(k); // refresh recency
  bucket.set(k, tile);
  while (bucket.size > MAX_TILES_PER_KEY) {
    const oldest = bucket.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    bucket.delete(oldest);
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
  for (const t of bucket.values()) {
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
  activeKey = null;
}
