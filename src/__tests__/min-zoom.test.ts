import { describe, expect, it } from "vitest";
import { bytesPerElement } from "../zarr/chunk-size";
import { deriveMinZoom } from "../zarr/profiles/scalar-grid/profile";

/** Metres per degree of longitude at the equator — converts a grid's
 * degrees/px resolution into the metres/px `deriveMinZoom` expects. */
const M_PER_DEG = 40_075_017 / 360;

describe("bytesPerElement", () => {
  it("maps zarr dtypes to byte widths", () => {
    expect(bytesPerElement("float16")).toBe(2);
    expect(bytesPerElement("float32")).toBe(4);
    expect(bytesPerElement("float64")).toBe(8);
    expect(bytesPerElement("int8")).toBe(1);
    expect(bytesPerElement("uint8")).toBe(1);
    expect(bytesPerElement("int16")).toBe(2);
    expect(bytesPerElement("int32")).toBe(4);
    expect(bytesPerElement("bool")).toBe(4); // sub-byte → fallback
    expect(bytesPerElement("weird")).toBe(4); // unknown → fallback
  });
});

describe("deriveMinZoom (fetch-budget gate)", () => {
  it("guards non-positive resolution", () => {
    expect(deriveMinZoom(0, 256, 256, 4)).toBe(0);
    expect(deriveMinZoom(-5, 256, 256, 4)).toBe(0);
  });

  it("coarse grids render near the world view (matches the old floor)", () => {
    // GFS 0.25° float16, 256 chunks → ~z1
    expect(deriveMinZoom(0.25 * M_PER_DEG, 256, 256, 2)).toBe(1);
    // SILAM 0.2° float16 → ~z1
    expect(deriveMinZoom(0.2 * M_PER_DEG, 256, 256, 2)).toBe(1);
    // 0.1° float32 → ~z2
    expect(deriveMinZoom(0.1 * M_PER_DEG, 256, 256, 4)).toBe(2);
  });

  it("FTW-like 10 m float32 gates at ~z12 (documented anchor)", () => {
    expect(deriveMinZoom(10, 256, 256, 4)).toBe(12);
    expect(deriveMinZoom(10, 512, 512, 4)).toBe(12);
  });

  it("pathologically tiny chunks gate harder via the request budget", () => {
    // Same 10 m grid; 64-px chunks straddle far more chunks per viewport, so
    // the request budget pushes the floor above the resolution-only value.
    const tiny = deriveMinZoom(10, 64, 64, 4);
    const typical = deriveMinZoom(10, 256, 256, 4);
    expect(tiny).toBeGreaterThan(typical);
    expect(tiny).toBe(14);
  });

  it("one giant chunk renders at the resolution floor (zoom can't shrink a single-chunk fetch)", () => {
    // 10 m grid, single 50000² chunk: requests stay at 1 for any zoom, so the
    // gate collapses to the resolution floor (≈ FTW's z12) rather than gating
    // to never-render — zooming can't reduce a whole-chunk pull.
    expect(deriveMinZoom(10, 50_000, 50_000, 4)).toBe(12);
  });

  it("int8 gates one level looser than float32 when bytes bind", () => {
    // Large chunks keep requests at 1 for both, so the byte budget decides.
    const i8 = deriveMinZoom(10, 1024, 1024, 1);
    const f32 = deriveMinZoom(10, 1024, 1024, 4);
    expect(f32 - i8).toBe(1);
    expect(i8).toBe(11);
    expect(f32).toBe(12);
  });

  it("CarbonPlan's hostile 6000x4500 float32 chunks render (not disabled)", () => {
    // Real store: ~34 m/px CONUS grid, one chunk ≈ 108 MB. Renders at ~z10
    // (one level looser than the old z11) — the byte gate is the pure-viewport
    // term, so the huge chunk doesn't push it to never-render.
    expect(deriveMinZoom(34.3, 4500, 6000, 4)).toBe(10);
  });

  it("a single-chunk-plane store within budget renders at world view (z0)", () => {
    // EEPS: 0.02° float16 whole-plane chunk (18000×6501×2 ≈ 234 MB). One tile
    // total — zooming loads nothing new — so the per-zoom byte gate is dropped
    // and it renders at z0 instead of the old ~z3 "zoom in to load tiles".
    expect(
      deriveMinZoom(0.02 * M_PER_DEG, 18000, 6501, 2, 18000, 6501),
    ).toBe(0);
  });

  it("an over-budget single plane still gates to its resolution floor", () => {
    // 10 m, single 50000² float32 chunk ≈ 10 GB ≫ budget: too big to auto-load
    // at world view, so it falls through to the gate and defers the fetch —
    // same result as the shapeless call.
    expect(deriveMinZoom(10, 50_000, 50_000, 4, 50_000, 50_000)).toBe(12);
    expect(deriveMinZoom(10, 50_000, 50_000, 4, 50_000, 50_000)).toBe(
      deriveMinZoom(10, 50_000, 50_000, 4),
    );
  });

  it("a multi-chunk store is unaffected by passing shape", () => {
    // Chunked along latitude (chunkH < shapeH) → many tiles, not one plane, so
    // the single-plane short-circuit must not fire: same gate as shapeless.
    expect(deriveMinZoom(10, 256, 256, 4, 256, 4096)).toBe(
      deriveMinZoom(10, 256, 256, 4),
    );
  });

  it("a global single-chunk plane renders at z0 regardless of bundled frames", () => {
    // SILAM: 0.2° float16 whole-plane chunk that bundles 120 `step` frames
    // (chunks [1,120,897,1800]). The full chunk is ~387 MB, but it's global and
    // a single spatial chunk — zooming can't reduce the fetch, so it must render
    // at world view, NOT behind a "zoom in to load tiles" hint. The gate judges
    // the spatial plane (~3.2 MB), so the bundled step count doesn't matter.
    expect(deriveMinZoom(0.2 * M_PER_DEG, 1800, 897, 2, 1800, 897)).toBe(0);
  });

  it("a single plane with a huge spatial footprint still defers", () => {
    // 10 m, single 50000² float32 chunk ≈ 10 GB of *spatial* data — too big to
    // auto-load at world view, so it gates to its resolution floor (unchanged).
    expect(deriveMinZoom(10, 50_000, 50_000, 4, 50_000, 50_000)).toBe(12);
  });

  it("bundled frames do NOT raise the gate for multi-chunk-spatial stores", () => {
    // Zoom can't reduce the bundled-dim overhead (same bytes per chunk regardless
    // of zoom level), so including them in the byte budget over-restricts datasets
    // like MRMS (648 time steps/chunk, 100×100 spatial). The request budget
    // already captures what zoom can actually fix.
    expect(deriveMinZoom(10, 256, 256, 4)).toBe(12);
    // MRMS-like: 1 km, 100×100 chunks → request-bound at z7
    expect(deriveMinZoom(0.01 * M_PER_DEG, 100, 100, 4)).toBe(7);
  });

  it("Meta CHM multiscale coarsest level (64x) gates to a memory-safe floor", () => {
    // The multiscale-grid profile applies the gate to the COARSEST level (it has
    // no coarser overview, so zooming out clamps to it). 64x: ~76.437 m/px,
    // 512² chunks, uint8, 524288² shape (multi-chunk → per-zoom loop, no
    // single-plane short-circuit). z8 needs ⌈d/512⌉²=25 chunks/viewport (>16
    // budget); z9 needs 9 → floor lands at z9, bounding the zoomed-out fetch.
    const z = deriveMinZoom(76.437, 512, 512, bytesPerElement("uint8"), 524288, 524288);
    expect(z).toBe(9);
  });
});
