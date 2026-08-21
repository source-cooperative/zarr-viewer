import { describe, expect, it } from "vitest";
import {
  detectProfile,
  isSupportedStoreUrl,
  normalizeStoreUrl,
} from "../source";
import { EXAMPLES } from "../data/examples";

describe("detectProfile", () => {
  it("defaults any store to scalar-grid", () => {
    expect(
      detectProfile(
        "https://data.source.coop/dynamical/ecmwf-ifs-ens-forecast-15-day-0-25-degree/v0.1.0.zarr",
        null,
      )?.id,
    ).toBe("scalar-grid");
    expect(
      detectProfile("https://example.com/random.zarr", null)?.id,
    ).toBe("scalar-grid");
  });

  it("returns null for null url", () => {
    expect(detectProfile(null, null)).toBeNull();
  });

  it("honors explicit ?p= override", () => {
    const p = detectProfile(
      "https://data.source.coop/tge-labs/aef-mosaic",
      "band-composite",
    );
    expect(p?.id).toBe("band-composite");
  });

  it("falls back to default for an invalid explicit override", () => {
    const p = detectProfile("https://example.com/random.zarr", "bogus");
    expect(p?.id).toBe("scalar-grid");
  });
});

describe("normalizeStoreUrl", () => {
  it("strips a trailing /zarr.json", () => {
    expect(
      normalizeStoreUrl("https://data.source.coop/tge-labs/aef-mosaic/zarr.json"),
    ).toBe("https://data.source.coop/tge-labs/aef-mosaic");
  });

  it("strips a trailing /.zmetadata", () => {
    expect(
      normalizeStoreUrl("https://example.com/x/.zmetadata"),
    ).toBe("https://example.com/x");
  });

  it("rewrites source.coop to data.source.coop", () => {
    expect(
      normalizeStoreUrl("https://source.coop/tge-labs/aef-mosaic"),
    ).toBe("https://data.source.coop/tge-labs/aef-mosaic");
  });

  it("does both at once for the user's pasted URL", () => {
    expect(
      normalizeStoreUrl("https://source.coop/tge-labs/aef-mosaic/zarr.json"),
    ).toBe("https://data.source.coop/tge-labs/aef-mosaic");
  });

  it("leaves an already-normalized data.source.coop URL unchanged", () => {
    const url = "https://data.source.coop/some-account/some-dataset/v1.zarr";
    expect(normalizeStoreUrl(url)).toBe(url);
  });

  it("trims whitespace", () => {
    expect(normalizeStoreUrl("  https://example.com/x  ")).toBe(
      "https://example.com/x",
    );
  });

  it("leaves a non-http(s) URL untouched (rejection is isSupportedStoreUrl's job)", () => {
    expect(normalizeStoreUrl("javascript:alert(1)")).toBe("javascript:alert(1)");
  });
});

describe("isSupportedStoreUrl", () => {
  it("accepts https and http", () => {
    expect(isSupportedStoreUrl("https://data.source.coop/a/b.zarr")).toBe(true);
    expect(isSupportedStoreUrl("http://localhost:8080/a.zarr")).toBe(true);
  });

  it("is case-insensitive about the scheme", () => {
    expect(isSupportedStoreUrl("HTTPS://data.source.coop/a.zarr")).toBe(true);
  });

  it("tolerates surrounding whitespace, like normalizeStoreUrl", () => {
    expect(isSupportedStoreUrl("  https://example.com/x.zarr  ")).toBe(true);
  });

  it("rejects javascript: URLs", () => {
    expect(isSupportedStoreUrl("javascript:alert(1)")).toBe(false);
    // Leading whitespace + mixed case is the classic filter-bypass shape.
    expect(isSupportedStoreUrl("  JaVaScRiPt:alert(1)")).toBe(false);
  });

  it("rejects other non-fetchable or credential-bearing schemes", () => {
    expect(isSupportedStoreUrl("data:text/html,<script>alert(1)</script>")).toBe(
      false,
    );
    expect(isSupportedStoreUrl("blob:https://example.com/abc")).toBe(false);
    expect(isSupportedStoreUrl("file:///etc/passwd")).toBe(false);
    expect(isSupportedStoreUrl("ftp://example.com/x.zarr")).toBe(false);
    expect(isSupportedStoreUrl("s3://bucket/key.zarr")).toBe(false);
  });

  it("rejects scheme-less input rather than letting it become a same-origin fetch", () => {
    expect(isSupportedStoreUrl("data.source.coop/a/b.zarr")).toBe(false);
    expect(isSupportedStoreUrl("/a/b.zarr")).toBe(false);
    expect(isSupportedStoreUrl("//data.source.coop/a/b.zarr")).toBe(false);
  });

  it("rejects empty input", () => {
    expect(isSupportedStoreUrl("")).toBe(false);
    expect(isSupportedStoreUrl("   ")).toBe(false);
  });

  it("accepts every bundled example URL", () => {
    for (const ex of EXAMPLES) {
      expect(isSupportedStoreUrl(ex.url), ex.url).toBe(true);
      expect(isSupportedStoreUrl(normalizeStoreUrl(ex.url)), ex.url).toBe(true);
    }
  });
});
