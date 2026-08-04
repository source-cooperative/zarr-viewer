import { describe, expect, it } from "vitest";
import {
  attrsHaveMultiscale,
  buildGeoZarrMetadata,
  buildLayoutGeoZarrMetadata,
  parseMultiscaleDatasets,
  parseMultiscaleDatasetsLayout,
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

describe("parseMultiscaleDatasetsLayout", () => {
  // The FTW global-predictions store: a GeoZarr-style pyramid expressed in the
  // legacy CF `datasets` ARRAY key, but each dataset carries per-level
  // `spatial:transform` + `spatial:shape` (like a layout level). Finest is the
  // pyramid root, `path: "."`.
  const ftwAttrs = {
    "spatial:dimensions": ["y", "x"],
    "proj:code": "EPSG:4326",
    multiscales: [
      {
        tile_matrix_set: "WGS84Quad",
        resampling_method: "average",
        datasets: [
          { path: ".", factor: 1, crs: "EPSG:4326", "spatial:transform": [8.9e-5, 0, -180, 0, -8.9e-5, 83.7], "spatial:shape": [1566049, 4007517] },
          { path: "2x", factor: 2, crs: "EPSG:4326", "spatial:transform": [1.79e-4, 0, -180, 0, -1.79e-4, 83.7], "spatial:shape": [783025, 2003759] },
        ],
      },
    ],
  };

  it("converts an enriched CF datasets array (per-level transform+shape) to a layout", () => {
    const out = parseMultiscaleDatasetsLayout(ftwAttrs)!;
    expect(out.levels.map((l) => l.asset)).toEqual([".", "2x"]);
    expect(out.levels[0]!["spatial:shape"]).toEqual([1566049, 4007517]);
    expect(out.levels[0]!["spatial:transform"]).toEqual([8.9e-5, 0, -180, 0, -8.9e-5, 83.7]);
    expect(out.dims).toEqual(["y", "x"]);
    expect(out.crs).toEqual({ code: "EPSG:4326" });
  });

  it("orders levels finest-first (smallest pixel) regardless of stored order", () => {
    const coarsestFirst = {
      ...ftwAttrs,
      multiscales: [{ datasets: [...ftwAttrs.multiscales[0]!.datasets].reverse() }],
    };
    const out = parseMultiscaleDatasetsLayout(coarsestFirst)!;
    expect(out.levels.map((l) => l.asset)).toEqual([".", "2x"]);
  });

  it("returns null for the bare CF datasets form (no per-level transform) → CF branch", () => {
    expect(
      parseMultiscaleDatasetsLayout({ multiscales: [{ datasets: [{ path: "1x" }, { path: "2x" }] }] }),
    ).toBeNull();
  });

  it("returns null for the native {layout} object form and plain/empty/null", () => {
    expect(parseMultiscaleDatasetsLayout({ multiscales: { layout: [{ asset: "0" }] } })).toBeNull();
    expect(parseMultiscaleDatasetsLayout({})).toBeNull();
    expect(parseMultiscaleDatasetsLayout({ multiscales: [] })).toBeNull();
    expect(parseMultiscaleDatasetsLayout(null)).toBeNull();
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

describe("buildLayoutGeoZarrMetadata", () => {
  const layout = parseMultiscaleLayout({
    "spatial:dimensions": ["latitude", "longitude"],
    "proj:code": "EPSG:4326",
    multiscales: {
      layout: [
        { asset: "0", "spatial:transform": [0.05, 0, -180, 0, -0.05, 90], "spatial:shape": [3600, 7200] },
        { asset: "1", "spatial:transform": [0.1, 0, -180, 0, -0.1, 90], "spatial:shape": [1800, 3600] },
      ],
    },
  })!;

  it("rewrites asset to <level>/<var>, keeps finest-first order + transforms", () => {
    const meta = buildLayoutGeoZarrMetadata({ layout, variable: "NDVI" });
    expect(meta.multiscales.layout.map((l) => l.asset)).toEqual(["0/NDVI", "1/NDVI"]);
    expect(meta.multiscales.layout[0]!["spatial:shape"]).toEqual([3600, 7200]);
    expect(meta.multiscales.layout[0]!["spatial:transform"]).toEqual([0.05, 0, -180, 0, -0.05, 90]);
  });

  it("emits proj:code + spatial:dimensions from the layout", () => {
    const meta = buildLayoutGeoZarrMetadata({ layout, variable: "NDVI" });
    expect(meta["proj:code"]).toBe("EPSG:4326");
    expect(meta["proj:wkt2"]).toBeUndefined();
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

  it("returns null for malformed root/level fields", () => {
    const base = {
      "spatial:dimensions": ["latitude", "longitude"],
      "proj:code": "EPSG:4326",
      multiscales: { layout: [{ asset: "0", "spatial:transform": [0.05,0,-180,0,-0.05,90], "spatial:shape": [3600,7200] }] },
    };
    // non-string dimension name
    expect(parseMultiscaleLayout({ ...base, "spatial:dimensions": [1, "longitude"] })).toBeNull();
    // non-integer / non-finite shape
    expect(parseMultiscaleLayout({ ...base, multiscales: { layout: [{ asset: "0", "spatial:transform": [0.05,0,-180,0,-0.05,90], "spatial:shape": [3600.5, 7200] }] } })).toBeNull();
    // non-finite transform
    expect(parseMultiscaleLayout({ ...base, multiscales: { layout: [{ asset: "0", "spatial:transform": [0.05,0,-180,0,-0.05,Infinity], "spatial:shape": [3600,7200] }] } })).toBeNull();
    // empty-string CRS with no wkt2
    expect(parseMultiscaleLayout({ ...base, "proj:code": "" })).toBeNull();
  });
});

describe("buildLayoutGeoZarrMetadata — subgroupPrefix + asset '.'", () => {
  // A CDL-style pyramid rooted at a child group: finest level is the group
  // itself (asset "."), coarser levels are downsample-factor subgroups.
  const layout = parseMultiscaleLayout({
    "spatial:dimensions": ["y", "x"],
    "proj:code": "EPSG:5070",
    multiscales: {
      layout: [
        { asset: ".", "spatial:transform": [10, 0, -2356095, 0, -10, 3172605], "spatial:shape": [316295, 480509] },
        { asset: "2x", "spatial:transform": [20, 0, -2356095, 0, -20, 3172605], "spatial:shape": [158148, 240255] },
      ],
    },
  })!;

  it("prefixes assets with the subgroup and maps '.' to the group root", () => {
    const meta = buildLayoutGeoZarrMetadata({ layout, variable: "crop_type", subgroupPrefix: "10m" });
    expect(meta.multiscales.layout.map((l) => l.asset)).toEqual([
      "10m/crop_type",
      "10m/2x/crop_type",
    ]);
    expect(meta["proj:code"]).toBe("EPSG:5070");
  });

  it("keeps the store-root behavior when no prefix is given", () => {
    const rootLayout = parseMultiscaleLayout({
      "spatial:dimensions": ["latitude", "longitude"],
      "proj:code": "EPSG:4326",
      multiscales: { layout: [{ asset: "0", "spatial:transform": [0.05,0,-180,0,-0.05,90], "spatial:shape": [3600,7200] }] },
    })!;
    const meta = buildLayoutGeoZarrMetadata({ layout: rootLayout, variable: "NDVI" });
    expect(meta.multiscales.layout.map((l) => l.asset)).toEqual(["0/NDVI"]);
  });
});

describe("attrsHaveMultiscale", () => {
  it("is true for the native {layout} form", () => {
    expect(attrsHaveMultiscale({
      "spatial:dimensions": ["y", "x"],
      "proj:code": "EPSG:5070",
      multiscales: { layout: [{ asset: ".", "spatial:transform": [10,0,0,0,-10,0], "spatial:shape": [10, 10] }] },
    })).toBe(true);
  });
  it("is true for the legacy CF {datasets} form", () => {
    expect(attrsHaveMultiscale({ multiscales: [{ datasets: [{ path: "1x" }] }] })).toBe(true);
  });
  it("is false for a plain group / OME-ish / empty / null", () => {
    expect(attrsHaveMultiscale({ "spatial:transform": [1,0,0,0,1,0] })).toBe(false);
    expect(attrsHaveMultiscale({ multiscales: { layout: [] } })).toBe(false);
    expect(attrsHaveMultiscale({})).toBe(false);
    expect(attrsHaveMultiscale(null)).toBe(false);
  });
});
