import { describe, expect, it } from "vitest";
import {
  buildGeoZarrMetadata,
  parseMultiscaleDatasets,
  parseMultiscaleLayout,
} from "../zarr/multiscale";

describe("parseMultiscaleDatasets", () => {
  it("reads dataset paths (coarsest→finest) from the CF/rioxarray convention", () => {
    const attrs = {
      multiscales: [
        {
          name: "chm",
          datasets: [
            { path: "64x", downscale_factor: 64 },
            { path: "32x", downscale_factor: 32 },
            { path: "1x", downscale_factor: 1 },
          ],
          type: "average",
        },
      ],
    };
    expect(parseMultiscaleDatasets(attrs)).toEqual(["64x", "32x", "1x"]);
  });

  it("returns null when there is no multiscales attr", () => {
    expect(parseMultiscaleDatasets({})).toBeNull();
    expect(parseMultiscaleDatasets({ multiscales: [] })).toBeNull();
    expect(parseMultiscaleDatasets({ multiscales: [{ datasets: [] }] })).toBeNull();
    expect(parseMultiscaleDatasets(null)).toBeNull();
    expect(parseMultiscaleDatasets("nope")).toBeNull();
  });
});

describe("buildGeoZarrMetadata", () => {
  // Two-level toy pyramid, coarsest→finest (store order).
  const levels = [
    {
      asset: "2x/chm",
      // GDAL GeoTransform [ox, px, rx, oy, ry, py]
      geoTransform: [-20037508.34, 2.388, 0, 20037508.34, 0, -2.388],
      shape: [256, 256] as [number, number],
    },
    {
      asset: "1x/chm",
      geoTransform: [-20037508.34, 1.194, 0, 20037508.34, 0, -1.194],
      shape: [512, 512] as [number, number],
    },
  ];

  it("emits the layout finest-first (reverse of store order)", () => {
    const meta = buildGeoZarrMetadata({ levels, crsWkt: "WKT" });
    expect(meta.multiscales.layout.map((l) => l.asset)).toEqual([
      "1x/chm",
      "2x/chm",
    ]);
  });

  it("reorders GDAL GeoTransform → spatial:transform [px,rx,ox,ry,py,oy]", () => {
    const meta = buildGeoZarrMetadata({ levels, crsWkt: "WKT" });
    // finest (1x) is first now
    expect(meta.multiscales.layout[0]!["spatial:transform"]).toEqual([
      1.194, 0, -20037508.34, 0, -1.194, 20037508.34,
    ]);
    expect(meta.multiscales.layout[0]!["spatial:shape"]).toEqual([512, 512]);
  });

  it("sets proj:wkt2 and default y/x dims", () => {
    const meta = buildGeoZarrMetadata({ levels, crsWkt: "MY_WKT" });
    expect(meta["proj:wkt2"]).toBe("MY_WKT");
    expect(meta["spatial:dimensions"]).toEqual(["y", "x"]);
  });

  it("allows overriding the spatial dim names", () => {
    const meta = buildGeoZarrMetadata({
      levels,
      crsWkt: "WKT",
      dims: ["latitude", "longitude"],
    });
    expect(meta["spatial:dimensions"]).toEqual(["latitude", "longitude"]);
  });
});

describe("parseMultiscaleLayout", () => {
  const layoutAttrs = {
    "spatial:dimensions": ["latitude", "longitude"],
    "proj:code": "EPSG:4326",
    multiscales: {
      layout: [
        { asset: "0", "spatial:transform": [0.05, 0, -180, 0, -0.05, 90], "spatial:shape": [3600, 7200] },
        { asset: "1", "spatial:transform": [0.1, 0, -180, 0, -0.1, 90], "spatial:shape": [1800, 3600] },
      ],
    },
  };

  it("reads finest-first levels, dims, and proj:code CRS", () => {
    const out = parseMultiscaleLayout(layoutAttrs)!;
    expect(out.levels.map((l) => l.asset)).toEqual(["0", "1"]);
    expect(out.levels[0]!["spatial:shape"]).toEqual([3600, 7200]);
    expect(out.dims).toEqual(["latitude", "longitude"]);
    expect(out.crs).toEqual({ code: "EPSG:4326" });
  });

  it("reads a proj:wkt2 CRS when no proj:code", () => {
    const out = parseMultiscaleLayout({ ...layoutAttrs, "proj:code": undefined, "proj:wkt2": "WKT" })!;
    expect(out.crs).toEqual({ wkt2: "WKT" });
  });

  it("returns null for the legacy datasets array, OME, and plain stores", () => {
    expect(parseMultiscaleLayout({ multiscales: [{ datasets: [{ path: "1x" }] }] })).toBeNull();
    expect(parseMultiscaleLayout({ multiscales: { layout: [] } })).toBeNull();
    expect(parseMultiscaleLayout({})).toBeNull();
    expect(parseMultiscaleLayout(null)).toBeNull();
  });

  it("returns null when a layout item is missing transform/shape", () => {
    expect(parseMultiscaleLayout({
      "spatial:dimensions": ["latitude", "longitude"],
      "proj:code": "EPSG:4326",
      multiscales: { layout: [{ asset: "0" }] },
    })).toBeNull();
  });
});
