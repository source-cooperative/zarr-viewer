import { describe, expect, it } from "vitest";
import {
  geographicBounds,
  mercatorBounds,
  projectedBounds,
} from "../zarr/data-bounds";

describe("geographicBounds (degrees)", () => {
  it("builds W/S/E/N from a north-first (descending-lat) affine", () => {
    // 400 lon × 200 lat, 0.25° step, top-left at (-10, 50), lat descending.
    const b = geographicBounds([0.25, 0, -10, 0, -0.25, 50], [200, 400]);
    expect(b).not.toBeNull();
    // west, south, east, north
    expect(b![0]).toBeCloseTo(-10, 6); // west
    expect(b![1]).toBeCloseTo(0, 6); // south = 50 - 0.25*200
    expect(b![2]).toBeCloseTo(90, 6); // east = -10 + 0.25*400
    expect(b![3]).toBeCloseTo(50, 6); // north
  });

  it("returns null on a malformed transform/shape", () => {
    expect(geographicBounds([0.25, 0, -10], [200, 400])).toBeNull();
    expect(geographicBounds([0, 0, -10, 0, -0.25, 50], [200, 400])).toBeNull(); // stepX 0
    expect(geographicBounds([0.25, 0, -10, 0, -0.25, 50], [0, 400])).toBeNull(); // height 0
  });
});

describe("mercatorBounds (EPSG:3857 metres)", () => {
  it("inverts the full web-mercator world to ~[-180,-85.05,180,85.05]", () => {
    const M = 20037508.342789244; // half the 3857 world span
    // One-cell affine spanning the whole 3857 extent, north-first.
    const b = mercatorBounds([2 * M, 0, -M, 0, -2 * M, M], [1, 1]);
    expect(b).not.toBeNull();
    expect(b![0]).toBeCloseTo(-180, 4); // west
    expect(b![1]).toBeCloseTo(-85.051129, 4); // south
    expect(b![2]).toBeCloseTo(180, 4); // east
    expect(b![3]).toBeCloseTo(85.051129, 4); // north
  });
});

// A GRIB-sphere Lambert Conformal Conic like NOAA HRRR (CONUS 3 km).
const HRRR_LCC_WKT = `PROJCS["unnamed",GEOGCS["Coordinate System imported from GRIB file",DATUM["unnamed",SPHEROID["Sphere",6371229,0]],PRIMEM["Greenwich",0],UNIT["degree",0.0174532925199433]],PROJECTION["Lambert_Conformal_Conic_2SP"],PARAMETER["latitude_of_origin",38.5],PARAMETER["central_meridian",-97.5],PARAMETER["standard_parallel_1",38.5],PARAMETER["standard_parallel_2",38.5],PARAMETER["false_easting",0],PARAMETER["false_northing",0],UNIT["metre",1]]`;

describe("projectedBounds (WKT2 reprojection)", () => {
  it("reprojects an HRRR-style LCC CONUS extent to a plausible lng/lat bbox", () => {
    // ~1799×1059 cells at 3 km, top-left origin, y descending.
    const transform = [3000, 0, -2699020, 0, -3000, 1588806];
    const shape = [1059, 1799];
    const b = projectedBounds(transform, shape, HRRR_LCC_WKT);
    expect(b).not.toBeNull();
    const [w, s, e, n] = b!;
    expect([w, s, e, n].every(Number.isFinite)).toBe(true);
    // Ordered and inside the globe.
    expect(w).toBeLessThan(e);
    expect(s).toBeLessThan(n);
    expect(w).toBeGreaterThan(-180);
    expect(e).toBeLessThan(0); // CONUS is western hemisphere
    expect(s).toBeGreaterThan(10);
    expect(n).toBeLessThan(60);
    // Roughly CONUS: west of the Rockies to the eastern seaboard, ~Mexico to Canada.
    expect(w).toBeLessThan(-100);
    expect(e).toBeGreaterThan(-80);
    expect(s).toBeLessThan(30);
    expect(n).toBeGreaterThan(45);
  });

  it("returns null on an empty or unparseable WKT", () => {
    const transform = [3000, 0, -2699020, 0, -3000, 1588806];
    const shape = [1059, 1799];
    expect(projectedBounds(transform, shape, "")).toBeNull();
    expect(projectedBounds(transform, shape, "not a wkt string")).toBeNull();
  });
});
