import { describe, expect, it } from "vitest";
import {
  decodeFixedLengthUtf32,
  makeCfDimLabel,
} from "../zarr/profiles/scalar-grid/cf-coords";

/** Encode strings as a `fixed_length_utf32` buffer (NUL-padded UTF-32LE) for
 * the decoder tests, mirroring how zarr-python writes the dtype. */
function encodeFixedLengthUtf32(values: string[], lengthBytes: number): Uint8Array {
  const buf = new Uint8Array(values.length * lengthBytes);
  const dv = new DataView(buf.buffer);
  values.forEach((s, r) => {
    const cps = Array.from(s);
    cps.forEach((ch, j) => {
      dv.setUint32(r * lengthBytes + j * 4, ch.codePointAt(0)!, true);
    });
  });
  return buf;
}

describe("makeCfDimLabel", () => {
  it("formats GFS milliseconds-since-epoch as a date/time", () => {
    // The reported GFS value: 1701536400000 ms since 1970 = 2023-12-02 17:00Z.
    const label = makeCfDimLabel(
      "milliseconds since 1970-01-01",
      [1701536400000],
      1,
    );
    expect(label(0)).toBe("2023-12-02 17:00Z");
  });

  it("keeps millisecond-epoch math exact (no off-by-one minute)", () => {
    // A value landing exactly on a minute boundary must not round down to the
    // previous minute via float error.
    const label = makeCfDimLabel("milliseconds since 1970-01-01T00:00:00", [60_000], 1);
    expect(label(0)).toBe("1970-01-01 00:01Z");
  });

  it("still formats seconds/hours/days since epoch", () => {
    expect(makeCfDimLabel("seconds since 1970-01-01", [0], 1)(0)).toBe(
      "1970-01-01 00:00Z",
    );
    expect(
      makeCfDimLabel("hours since 2020-01-01 00:00:00", [24], 1)(0),
    ).toBe("2020-01-02 00:00Z");
    expect(makeCfDimLabel("days since 2000-01-01", [1], 1)(0)).toBe(
      "2000-01-02 00:00Z",
    );
  });

  it("formats bare durations in the coarsest whole unit", () => {
    expect(makeCfDimLabel("hours", [6], 1)(0)).toBe("+6 h");
    expect(makeCfDimLabel("seconds", [86400], 1)(0)).toBe("+1 d");
    expect(makeCfDimLabel("minutes", [90], 1)(0)).toBe("+90 min");
    expect(makeCfDimLabel("milliseconds", [500], 1)(0)).toBe("+500 ms");
    expect(makeCfDimLabel("milliseconds", [1000], 1)(0)).toBe("+1 s");
  });

  it("falls back to value+unit for unknown numeric units", () => {
    expect(makeCfDimLabel("hPa", [500], 1)(0)).toBe("500 hPa");
  });

  it("falls back to the index for a partial unit-less coord", () => {
    // Only one value for a size-5 dim → not a complete coordinate, so index.
    expect(makeCfDimLabel(null, [42], 5)(0)).toBe("0 / 4");
  });

  it("shows the value for a complete, informative unit-less coord", () => {
    // CCIWR horizon: int64 years 2030/2055/2085, no units.
    const label = makeCfDimLabel(null, [2030, 2055, 2085], 3);
    expect([label(0), label(1), label(2)]).toEqual(["2030", "2055", "2085"]);
  });

  it("keeps the index for a plain 0..n-1 unit-less coord", () => {
    // Values equal their position carry no extra info → index label.
    expect(makeCfDimLabel(null, [0, 1, 2], 3)(1)).toBe("1 / 2");
  });

  it("falls back to the index for an unparseable epoch", () => {
    expect(makeCfDimLabel("hours since not-a-date", [3], 3)(1)).toBe("1 / 2");
  });
});

describe("decodeFixedLengthUtf32", () => {
  it("decodes NUL-padded UTF-32LE records (CCIWR season, 24 bytes)", () => {
    const values = ["yearly", "DJF", "MAM", "JJA", "SON"];
    const buf = encodeFixedLengthUtf32(values, 24);
    expect(decodeFixedLengthUtf32(buf, 24)).toEqual(values);
  });

  it("decodes longer records (gcm model names, 52 bytes)", () => {
    const values = ["gfdl-esm4", "ipsl-cm6a-lr", "ukesm1-0-ll"];
    expect(decodeFixedLengthUtf32(encodeFixedLengthUtf32(values, 52), 52)).toEqual(
      values,
    );
  });

  it("returns [] for an invalid record width", () => {
    expect(decodeFixedLengthUtf32(new Uint8Array(10), 0)).toEqual([]);
    expect(decodeFixedLengthUtf32(new Uint8Array(10), 6)).toEqual([]); // not /4
  });
});
