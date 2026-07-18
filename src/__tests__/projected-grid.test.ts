import { expect, test } from "vitest";
import { installFloat16Polyfill } from "../zarr/float16-polyfill";
import { installGribberishCodec } from "../zarr/install-gribberish-codec";
import { normalizeStoreUrl } from "../source";
import { scalarGridProfile } from "../zarr/profiles/scalar-grid/profile";
import { projectedGridProfile } from "../zarr/profiles/projected-grid/profile";
import { ProjectedGridStoreError } from "../zarr/projected";

installFloat16Polyfill();
installGribberishCodec();

const URL_HRRR = normalizeStoreUrl(
  "https://source.coop/dynamical/noaa-hrrr-forecast-48-hour-virtual/v0.5.0.icechunk",
);

// The materialized/time-optimized counterpart: plain Zarr, sharded
// (blosc, no gribberish), same Lambert Conformal grid.
const URL_HRRR_NONVIRTUAL = normalizeStoreUrl(
  "https://source.coop/dynamical/noaa-hrrr-forecast-48-hour/v0.1.0.zarr",
);

const signal = () => new AbortController().signal;

test("scalar-grid hands off HRRR (projected Lambert grid) to projected-grid", {
  timeout: 300_000,
}, async () => {
  await expect(scalarGridProfile.prepare(URL_HRRR, signal())).rejects.toBeInstanceOf(
    ProjectedGridStoreError,
  );
});

test("projected-grid prepare emits Lambert Conformal WKT metadata", {
  timeout: 300_000,
}, async () => {
  const ctx = await projectedGridProfile.prepare(URL_HRRR, signal());
  const attrs = ctx.spatialAttrs as {
    "spatial:shape": [number, number];
    "spatial:dimensions": [string, string];
    "spatial:transform": number[];
    "proj:wkt2": string;
  };
  expect(attrs["spatial:shape"]).toEqual([1059, 1799]);
  expect(attrs["spatial:dimensions"]).toEqual(["y", "x"]);
  // GeoTransform -2699020.14 3000 0 1588193.85 0 -3000 -> [px,rx,ox,ry,py,oy].
  expect(attrs["spatial:transform"][0]).toBeCloseTo(3000, 0);
  expect(attrs["spatial:transform"][4]).toBeCloseTo(-3000, 0);
  expect(attrs["proj:wkt2"]).toContain("Lambert_Conformal_Conic");
  expect(ctx.metadataSource).toBe("store-native");
  expect(ctx.variables.some((v) => v.name === "temperature_2m")).toBe(true);

  // Default variable pick + initial state (reused scalar-grid logic) lands on
  // a preferred variable and gives it dim sliders (init_time, lead_time).
  const state = projectedGridProfile.initialState(ctx);
  expect(state.variable).toBe("temperature_2m");
  expect(Object.keys(state.dimIndices).sort()).toEqual(["init_time", "lead_time"]);

  // Hover sampling is intentionally disabled for projected grids.
  expect(projectedGridProfile.sampleValue?.(ctx, state, -96, 38)).toBeNull();
});

test("projected-grid prepares the sharded non-virtual HRRR Zarr (shard-aware gate)", {
  timeout: 300_000,
}, async () => {
  // scalar-grid hands it off (same Lambert grid) even though it's a plain Zarr.
  await expect(
    scalarGridProfile.prepare(URL_HRRR_NONVIRTUAL, signal()),
  ).rejects.toBeInstanceOf(ProjectedGridStoreError);

  const ctx = await projectedGridProfile.prepare(URL_HRRR_NONVIRTUAL, signal());
  const attrs = ctx.spatialAttrs as { "proj:wkt2": string };
  expect(attrs["proj:wkt2"]).toContain("Lambert_Conformal_Conic");
  expect(ctx.variables.some((v) => v.name === "temperature_2m")).toBe(true);
  // The outer shard [.,.,1060,1800] spans the plane, so the gate must be 0 (a
  // world/CONUS view renders) — not mis-gated by the small 265×300 inner chunk.
  expect(ctx.minRenderZoom).toBe(0);
});
