import * as zarr from "zarrita";

/** A store variable uses a compression codec the viewer can't decode in the
 * browser (e.g. Blosc2 — there is no JavaScript/WASM Blosc2 decoder). The store
 * opens fine, but its chunks can't be decompressed, so tiles never render.
 * Thrown from a profile's `prepare()` so it surfaces as a clear toast instead of
 * a silent "tiles loading slowly" notice. */
export class UnsupportedCodecError extends Error {
  readonly codecId: string;
  constructor(codecId: string) {
    super(`Unsupported codec: ${codecId}`);
    this.name = "UnsupportedCodecError";
    this.codecId = codecId;
  }
}

type RawArrayMeta = {
  // v2 (`.zarray`)
  compressor?: { id?: unknown } | null;
  filters?: ReadonlyArray<{ id?: unknown } | null> | null;
  // v3 (`zarr.json`)
  codecs?: ReadonlyArray<{
    name?: unknown;
    configuration?: { codecs?: ReadonlyArray<{ name?: unknown }> };
  }>;
};

/** Zarr v3 codecs that zarrita implements natively (they aren't numcodecs
 * entries, so they're absent from `registry`). Treated as always supported;
 * only genuine compression codecs are registry-checked. */
const V3_STRUCTURAL_CODECS = new Set([
  "bytes",
  "transpose",
  "sharding_indexed",
  "crc32c",
  "vlen-utf8",
  "vlen-bytes",
]);

const isSupportedV3Codec = (name: string): boolean =>
  V3_STRUCTURAL_CODECS.has(name) || zarr.registry.has(name);

/** The first codec the viewer can't decode, or null if all are supported.
 * v2: `compressor` + `filters` ids are numcodecs entries, checked against the
 * registry. v3: codec `name`s (recursing one level into a `sharding_indexed`
 * codec's inner pipeline), allowing zarrita's native structural codecs. */
function firstUnsupportedCodec(meta: RawArrayMeta): string | null {
  const bad = (v: unknown): string | null =>
    typeof v === "string" && v && !zarr.registry.has(v) ? v : null;

  // Zarr v2
  if (meta.compressor && typeof meta.compressor === "object") {
    const id = bad(meta.compressor.id);
    if (id) return id;
  }
  for (const f of meta.filters ?? []) {
    const id = bad(f?.id);
    if (id) return id;
  }
  // Zarr v3
  for (const c of meta.codecs ?? []) {
    if (typeof c?.name === "string" && c.name && !isSupportedV3Codec(c.name)) {
      return c.name;
    }
    for (const ic of c?.configuration?.codecs ?? []) {
      if (typeof ic?.name === "string" && ic.name && !isSupportedV3Codec(ic.name)) {
        return ic.name;
      }
    }
  }
  return null;
}

async function readArrayMeta(
  store: zarr.Readable,
  path: string,
): Promise<RawArrayMeta | null> {
  const clean = path.replace(/^\/+|\/+$/g, "");
  // v3 root metadata first, then v2. `store.get` returns undefined on a miss.
  for (const key of [`/${clean}/zarr.json`, `/${clean}/.zarray`]) {
    let raw: Uint8Array | undefined;
    try {
      raw = await store.get(key as `/${string}`);
    } catch {
      raw = undefined;
    }
    if (raw) {
      try {
        return JSON.parse(new TextDecoder().decode(raw)) as RawArrayMeta;
      } catch {
        return null;
      }
    }
  }
  return null;
}

/** Throw {@link UnsupportedCodecError} if the array at `path` uses any codec the
 * bundled zarrita/numcodecs registry can't decode (checked against
 * `zarr.registry`, so it stays in sync with what actually decodes — no
 * hand-maintained allowlist). No-op if the metadata can't be read (fail-open —
 * never block a store we couldn't inspect). */
export async function assertCodecsSupported(
  store: zarr.Readable,
  path: string,
): Promise<void> {
  const meta = await readArrayMeta(store, path);
  if (!meta) return;
  const unsupported = firstUnsupportedCodec(meta);
  if (unsupported) throw new UnsupportedCodecError(unsupported);
}
