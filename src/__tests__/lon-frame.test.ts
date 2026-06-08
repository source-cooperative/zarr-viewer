import { describe, expect, it } from "vitest";
import { resolveLonFrame } from "../zarr/profiles/scalar-grid/profile";

/** Affine east edge: originLon + count*stepLon. Must not cross +180 on a
 * global grid, or deck.gl's raster→mercator mesh diverges and nothing draws. */
const eastEdge = (f: { originLon: number; stepLon: number }, count: number) =>
  f.originLon + f.stepLon * count;

describe("resolveLonFrame", () => {
  it("snaps a global -180..180 grid whose low-precision coords overshoot +180 (EEPS)", () => {
    // EEPS: 0.02° / 18000-cell global grid, but the stored longitudes are
    // low-precision so lon[1]-lon[0] = 0.02000427, drifting the last cell to
    // 180.0569 — a ~0.08° overshoot past the antimeridian. Without snapping,
    // isGlobal was false and the east edge crossed +180 → tiles failed to draw.
    const f = resolveLonFrame({
      lon0: -180,
      lon1: -179.97999572753906,
      lonLast: 180.0569,
      count: 18000,
    });
    expect(f.isGlobal).toBe(true);
    expect(f.rollLongitude).toBe(false);
    expect(f.originLon).toBe(-180);
    expect(f.stepLon).toBeCloseTo(0.02, 10);
    // The whole point: the extent is exactly [-180, 180], no antimeridian poke.
    expect(eastEdge(f, 18000)).toBeCloseTo(180, 6);
  });

  it("reframes a 0..360 grid (GFS) into -180..180 with a roll", () => {
    const f = resolveLonFrame({
      lon0: 0,
      lon1: 0.25,
      lonLast: 359.75,
      count: 1440,
    });
    expect(f.rollLongitude).toBe(true);
    expect(f.isGlobal).toBe(true);
    expect(f.originLon).toBe(-180);
    expect(f.stepLon).toBeCloseTo(0.25, 10);
    expect(eastEdge(f, 1440)).toBeCloseTo(180, 6);
  });

  it("snaps a clean global -180..180 grid (ECMWF 0.25°) to an exact extent", () => {
    const f = resolveLonFrame({
      lon0: -180,
      lon1: -179.75,
      lonLast: 179.75,
      count: 1440,
    });
    expect(f.isGlobal).toBe(true);
    expect(f.rollLongitude).toBe(false);
    expect(f.originLon).toBe(-180);
    expect(f.stepLon).toBeCloseTo(0.25, 10);
    expect(eastEdge(f, 1440)).toBeCloseTo(180, 6);
  });

  it("leaves a regional grid (FireSmoke) at its native origin/step", () => {
    const f = resolveLonFrame({
      lon0: -160,
      lon1: -159.9,
      lonLast: -50,
      count: 1100,
    });
    expect(f.isGlobal).toBe(false);
    expect(f.rollLongitude).toBe(false);
    expect(f.originLon).toBe(-160);
    expect(f.stepLon).toBeCloseTo(0.1, 10);
  });
});
