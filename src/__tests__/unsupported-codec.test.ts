import { describe, it, expect } from "vitest";
import type * as zarr from "zarrita";
import {
  assertCodecsSupported,
  UnsupportedCodecError,
} from "../zarr/unsupported-codec";
import { humanizeError } from "../components/Toast";

const enc = (obj: unknown) => new TextEncoder().encode(JSON.stringify(obj));

/** Minimal `zarr.Readable` whose `get` returns metadata bytes for known keys. */
function fakeStore(files: Record<string, unknown>): zarr.Readable {
  return {
    get: async (key: string) => (key in files ? enc(files[key]) : undefined),
  } as unknown as zarr.Readable;
}

describe("assertCodecsSupported", () => {
  it("throws (naming the codec) for a Zarr v2 blosc2 compressor", async () => {
    const store = fakeStore({
      "/temp/.zarray": { zarr_format: 2, compressor: { id: "blosc2", cname: "zstd" }, filters: null },
    });
    await expect(assertCodecsSupported(store, "temp")).rejects.toBeInstanceOf(
      UnsupportedCodecError,
    );
    await expect(assertCodecsSupported(store, "temp")).rejects.toMatchObject({
      codecId: "blosc2",
    });
  });

  it("accepts a Zarr v2 blosc (v1) compressor", async () => {
    const store = fakeStore({ "/temp/.zarray": { compressor: { id: "blosc" }, filters: null } });
    await expect(assertCodecsSupported(store, "temp")).resolves.toBeUndefined();
  });

  it("accepts an uncompressed Zarr v2 array (compressor null)", async () => {
    const store = fakeStore({ "/temp/.zarray": { compressor: null, filters: null } });
    await expect(assertCodecsSupported(store, "temp")).resolves.toBeUndefined();
  });

  it("throws for an unsupported Zarr v2 filter", async () => {
    const store = fakeStore({
      "/temp/.zarray": { compressor: { id: "blosc" }, filters: [{ id: "totally-made-up" }] },
    });
    await expect(assertCodecsSupported(store, "temp")).rejects.toMatchObject({
      codecId: "totally-made-up",
    });
  });

  it("accepts a Zarr v3 pipeline of supported codecs", async () => {
    const store = fakeStore({
      "/temp/zarr.json": { zarr_format: 3, node_type: "array", codecs: [{ name: "bytes" }, { name: "blosc" }] },
    });
    await expect(assertCodecsSupported(store, "temp")).resolves.toBeUndefined();
  });

  it("throws for a blosc2 codec nested inside a v3 sharding_indexed codec", async () => {
    const store = fakeStore({
      "/temp/zarr.json": {
        codecs: [
          { name: "sharding_indexed", configuration: { codecs: [{ name: "bytes" }, { name: "blosc2" }] } },
        ],
      },
    });
    await expect(assertCodecsSupported(store, "temp")).rejects.toMatchObject({
      codecId: "blosc2",
    });
  });

  it("is a no-op when the metadata can't be read (fail-open)", async () => {
    await expect(assertCodecsSupported(fakeStore({}), "temp")).resolves.toBeUndefined();
  });
});

describe("humanizeError (unsupported codec)", () => {
  it("names the codec and explains it can't be decoded", () => {
    const msg = humanizeError(new UnsupportedCodecError("blosc2"));
    expect(msg).toContain("blosc2");
    expect(msg.toLowerCase()).toContain("decode");
  });
});
