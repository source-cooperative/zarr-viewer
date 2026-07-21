import { describe, expect, it } from "vitest";
import { pixelMatchZoom } from "../zarr/native-zoom";

describe("pixelMatchZoom", () => {
  it("gives a higher zoom for finer data", () => {
    const coarse = pixelMatchZoom({ kind: "degrees", value: 0.25 }, 0);
    const fine = pixelMatchZoom({ kind: "degrees", value: 0.0001 }, 0);
    expect(fine).toBeGreaterThan(coarse);
    // ~0.25° global grid ≈ z1.5; ~11 m (0.0001°) ≈ z13.
    expect(coarse).toBeCloseTo(1.49, 1);
    expect(fine).toBeCloseTo(12.78, 1);
  });

  it("is latitude-independent for geographic (degrees) data", () => {
    const at0 = pixelMatchZoom({ kind: "degrees", value: 0.01 }, 0);
    const at60 = pixelMatchZoom({ kind: "degrees", value: 0.01 }, 60);
    expect(at60).toBeCloseTo(at0, 5);
  });

  it("is latitude-independent for mercator-metre data", () => {
    const at0 = pixelMatchZoom({ kind: "mercator-meters", value: 10 }, 0);
    const at55 = pixelMatchZoom({ kind: "mercator-meters", value: 10 }, 55);
    expect(at55).toBeCloseTo(at0, 5);
    expect(at0).toBeCloseTo(12.93, 1); // ~10 m finest level
  });

  it("zooms in toward the poles for fixed ground-metre (projected) data", () => {
    // HRRR-like 3 km ground resolution: coarse near the equator, and higher
    // zoom at higher latitude (map ground m/px shrinks with cos φ).
    const at0 = pixelMatchZoom({ kind: "ground-meters", value: 3000 }, 0);
    const at40 = pixelMatchZoom({ kind: "ground-meters", value: 3000 }, 40);
    expect(at0).toBeCloseTo(4.71, 1);
    expect(at40).toBeLessThan(at0); // 40°N over CONUS → a touch more zoomed out
    expect(at40).toBeCloseTo(4.32, 1);
  });

  it("returns NaN for a non-positive resolution", () => {
    expect(pixelMatchZoom({ kind: "ground-meters", value: 0 }, 10)).toBeNaN();
  });
});
