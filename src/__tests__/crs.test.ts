import { describe, expect, it } from "vitest";
import { resolveCrsConverters } from "../zarr/crs";

// A GRIB-sphere Lambert Conformal Conic (NOAA HRRR) — a genuine projected CRS,
// resolved OFFLINE from WKT (no epsg.io network).
const HRRR_LCC_WKT = `PROJCS["unnamed",GEOGCS["Coordinate System imported from GRIB file",DATUM["unnamed",SPHEROID["Sphere",6371229,0]],PRIMEM["Greenwich",0],UNIT["degree",0.0174532925199433]],PROJECTION["Lambert_Conformal_Conic_2SP"],PARAMETER["latitude_of_origin",38.5],PARAMETER["central_meridian",-97.5],PARAMETER["standard_parallel_1",38.5],PARAMETER["standard_parallel_2",38.5],PARAMETER["false_easting",0],PARAMETER["false_northing",0],UNIT["metre",1]]`;

describe("resolveCrsConverters", () => {
  it("returns identity converters for a geographic code (no network)", async () => {
    const c = await resolveCrsConverters({ code: "EPSG:4326" });
    expect(c).not.toBeNull();
    expect(c!.geographic).toBe(true);
    expect(c!.toLngLat(-93.5, 42)).toEqual([-93.5, 42]);
    expect(c!.fromLngLat(-93.5, 42)).toEqual([-93.5, 42]);
  });

  it("round-trips a CONUS point through a projected WKT (offline)", async () => {
    const c = await resolveCrsConverters({ wkt2: HRRR_LCC_WKT });
    expect(c).not.toBeNull();
    expect(c!.geographic).toBe(false);
    const [x, y] = c!.fromLngLat(-95, 40); // Kansas
    // Near the projection origin (central meridian -97.5, lat origin 38.5),
    // so easting/northing are modest metre magnitudes.
    expect(Number.isFinite(x) && Number.isFinite(y)).toBe(true);
    const [lng, lat] = c!.toLngLat(x, y);
    expect(lng).toBeCloseTo(-95, 3);
    expect(lat).toBeCloseTo(40, 3);
  });

  it("returns null when nothing is provided or WKT is unparseable", async () => {
    expect(await resolveCrsConverters({})).toBeNull();
    expect(await resolveCrsConverters({ wkt2: "not a wkt" })).toBeNull();
    expect(await resolveCrsConverters({ code: "BOGUS" })).toBeNull();
  });
});
