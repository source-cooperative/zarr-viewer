import * as zarr from "zarrita";

/** Milliseconds per CF time unit. Integer factors keep absolute-time math exact
 * (a millisecond epoch like GFS's would lose precision via a seconds factor). */
const MS_PER: Record<string, number> = {
  millisecond: 1, milliseconds: 1, msec: 1, msecs: 1, ms: 1,
  second: 1000, seconds: 1000, sec: 1000, s: 1000,
  minute: 60_000, minutes: 60_000, min: 60_000,
  hour: 3_600_000, hours: 3_600_000, hr: 3_600_000, h: 3_600_000,
  day: 86_400_000, days: 86_400_000, d: 86_400_000,
};

/** Parse a CF reference-time epoch to ms. A reference time without an explicit
 * timezone is UTC by convention, but JS `Date.parse` treats a date-*time* with
 * no zone as *local*; append `Z` in that case so labels don't shift with the
 * viewer's timezone. (A date-only string already parses as UTC.) */
function parseEpochMs(epoch: string): number {
  let s = epoch.trim().replace(" ", "T");
  const hasTz = /[zZ]$|[+-]\d{2}:?\d{2}$/.test(s);
  if (!hasTz && s.includes("T")) s += "Z";
  return Date.parse(s);
}

/** Build an `idx → label` formatter from a coordinate array's values and CF
 * `units`:
 *   - `"<unit> since <epoch>"` → absolute datetime (e.g. forecast init time)
 *   - bare `"milliseconds".."days"` → relative duration (`"+N h"`)
 *   - numeric coord with other units → `"value unit"` (e.g. pressure level)
 *   - no units / unparseable → the index (`"i / N"`).
 * Pure: takes the already-read values, so it's unit-testable. */
export function makeCfDimLabel(
  units: string | null,
  values: ArrayLike<number>,
  size: number,
): (idx: number) => string {
  const indexLabel = (i: number) => `${i} / ${Math.max(0, size - 1)}`;
  if (!units) {
    // No units: show the raw value when we have a COMPLETE coordinate whose
    // values carry information beyond their position (e.g. horizon years
    // 2030/2055/2085). A partial array (fewer values than the dim) or a plain
    // 0..n-1 index coordinate stays as the index.
    const complete = values.length === size;
    const informative =
      complete &&
      Array.from({ length: size }, (_, i) => Number(values[i])).some(
        (v, i) => Number.isFinite(v) && v !== i,
      );
    if (!informative) return indexLabel;
    return (i) => {
      const v = values[i];
      return v == null ? indexLabel(i) : String(v);
    };
  }

  // "<unit> since <epoch>" → absolute datetime.
  const since = /^\s*(\w+)\s+since\s+(.+?)\s*$/i.exec(units);
  if (since && MS_PER[since[1]!.toLowerCase()]) {
    const perUnitMs = MS_PER[since[1]!.toLowerCase()]!;
    const epochMs = parseEpochMs(since[2]!);
    if (Number.isFinite(epochMs)) {
      return (i) => {
        const v = values[i];
        if (v == null) return indexLabel(i);
        const iso = new Date(epochMs + v * perUnitMs).toISOString();
        return `${iso.slice(0, 10)} ${iso.slice(11, 16)}Z`;
      };
    }
  }

  // Bare duration → "+N h" (rendered in the coarsest whole unit ≤ value).
  const bare = MS_PER[units.trim().toLowerCase()];
  if (bare) {
    return (i) => {
      const v = values[i];
      if (v == null) return indexLabel(i);
      const ms = v * bare;
      if (ms % 86_400_000 === 0 && ms !== 0) return `+${ms / 86_400_000} d`;
      if (ms % 3_600_000 === 0) return `+${ms / 3_600_000} h`;
      if (ms % 60_000 === 0) return `+${ms / 60_000} min`;
      if (ms % 1000 === 0) return `+${ms / 1000} s`;
      return `+${ms} ms`;
    };
  }

  // Numeric coord with unknown units (e.g. pressure level) → "value unit".
  return (i) => {
    const v = values[i];
    return v == null ? indexLabel(i) : `${v} ${units}`;
  };
}

/** Decode a `fixed_length_utf32` buffer into strings. Each value occupies
 * `lengthBytes` bytes as little-endian UTF-32 code units, zero-padded; trailing
 * NULs are trimmed. Pure (no I/O) for unit testing. */
export function decodeFixedLengthUtf32(
  buf: Uint8Array,
  lengthBytes: number,
): string[] {
  if (lengthBytes < 4 || lengthBytes % 4 !== 0) return [];
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const unitsPerRec = lengthBytes / 4;
  const count = Math.floor(buf.byteLength / lengthBytes);
  const out: string[] = [];
  for (let r = 0; r < count; r++) {
    let s = "";
    for (let j = 0; j < unitsPerRec; j++) {
      const cp = dv.getUint32(r * lengthBytes + j * 4, true);
      if (cp === 0) break; // NUL pad → end of this record
      s += String.fromCodePoint(cp);
    }
    out.push(s);
  }
  return out;
}

/** Read a 1-D string coordinate array's values, for the `fixed_length_utf32`
 * dtype that zarrita 0.7 can't open (its dtype parser expects a string, so
 * `zarr.open.v3` throws). Decodes the single chunk by hand: read the raw
 * metadata + chunk via the store, zstd-decompress when present (the `bytes`
 * codec is identity for fixed-length records), then split into UTF-32 records.
 * Returns null for any non-string / unsupported / multi-chunk layout. */
async function readStringCoord(
  loc: zarr.Location<zarr.Readable>,
): Promise<string[] | null> {
  const store = loc.store;
  const base = loc.path as `/${string}`;
  const metaBytes = await store.get(`${base}/zarr.json`);
  if (!metaBytes) return null;
  const meta = JSON.parse(new TextDecoder().decode(metaBytes)) as {
    data_type?: { name?: string; configuration?: { length_bytes?: number } };
    codecs?: { name?: string }[];
    chunk_grid?: { configuration?: { chunk_shape?: number[] } };
    shape?: number[];
    chunk_key_encoding?: { configuration?: { separator?: string } };
  };
  if (meta.data_type?.name !== "fixed_length_utf32") return null;
  const lengthBytes = meta.data_type.configuration?.length_bytes;
  if (!lengthBytes || lengthBytes % 4 !== 0) return null;
  // Only the single-chunk case (the chunk spans the whole 1-D coord) is read.
  const chunkLen = meta.chunk_grid?.configuration?.chunk_shape?.[0];
  if (chunkLen !== meta.shape?.[0]) return null;
  const sep = meta.chunk_key_encoding?.configuration?.separator ?? "/";
  let bytes = await store.get(`${base}/c${sep}0` as `/${string}`);
  if (!bytes) return null;
  // Decode the codec chain (reverse order): only `zstd` needs work here.
  if ((meta.codecs ?? []).some((c) => c.name === "zstd")) {
    const Zstd = (await import("numcodecs/zstd")).default;
    bytes = await Zstd.fromConfig({ id: "zstd" }).decode(bytes);
  }
  return decodeFixedLengthUtf32(bytes, lengthBytes);
}

/** Format a non-spatial dimension's index into a human label by decoding its
 * coordinate array's CF `units`. Reads the (small, 1-D) coord array once, then
 * delegates to {@link makeCfDimLabel}. For string-typed coords that zarrita
 * can't open (`fixed_length_utf32`, e.g. CCIWR's season/ssp/gcm/ghm), falls
 * back to a manual decode so categorical dims show real labels. Falls back to
 * the index on any error. */
export async function buildDimLabel(
  group: zarr.Group<zarr.Readable>,
  dimName: string,
  size: number,
): Promise<(idx: number) => string> {
  const indexLabel = (i: number) => `${i} / ${Math.max(0, size - 1)}`;
  const loc = group.resolve(dimName);
  try {
    const arr = await zarr.open.v3(loc, { kind: "array" });
    const units = typeof arr.attrs.units === "string" ? arr.attrs.units : null;
    const chunk = await zarr.get(arr as zarr.Array<zarr.DataType, zarr.Readable>);
    const raw = chunk.data as ArrayLike<number | bigint>;
    const values = Array.from({ length: raw.length }, (_, i) => Number(raw[i]));
    return makeCfDimLabel(units, values, size);
  } catch {
    // zarrita couldn't open it — most likely a string dtype. Try a manual
    // decode of categorical labels; otherwise the index.
    try {
      const labels = await readStringCoord(loc);
      if (labels && labels.length > 0) {
        return (i) => labels[i] ?? indexLabel(i);
      }
    } catch {
      // fall through to the index
    }
    return indexLabel;
  }
}
