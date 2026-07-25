import { describe, expect, it } from "vitest";
import { parseMultiscaleDatasets, parseMultiscaleLayout } from "../zarr/multiscale";

// The routing predicate scalar-grid.prepare uses to throw MultiscaleStoreError.
// Kept in lockstep with profile.ts line ~576.
const isMultiscale = (attrs: unknown) =>
  Boolean(parseMultiscaleDatasets(attrs) || parseMultiscaleLayout(attrs));

describe("multiscale routing predicate", () => {
  it("detects a native layout pyramid (issue #68)", () => {
    expect(isMultiscale({
      "spatial:dimensions": ["latitude", "longitude"],
      "proj:code": "EPSG:4326",
      multiscales: { layout: [{ asset: "0", "spatial:transform": [0.05,0,-180,0,-0.05,90], "spatial:shape": [3600,7200] }] },
    })).toBe(true);
  });
  it("still detects a legacy datasets pyramid", () => {
    expect(isMultiscale({ multiscales: [{ datasets: [{ path: "1x" }] }] })).toBe(true);
  });
  it("is false for a plain store", () => {
    expect(isMultiscale({ "spatial:transform": [1,0,0,0,1,0] })).toBe(false);
  });
});
