import { expect, test } from "vitest";
import * as zarr from "zarrita";
import { installFloat16Polyfill } from "../zarr/float16-polyfill";
import { installGribberishCodec } from "../zarr/install-gribberish-codec";
import { normalizeStoreUrl } from "../source";
import { openV3Group } from "../zarr/load-zarr";

installFloat16Polyfill();
installGribberishCodec();

const URL_HRRR = normalizeStoreUrl(
  "https://source.coop/dynamical/noaa-hrrr-forecast-48-hour-virtual/v0.5.0.icechunk",
);

// End-to-end: the gribberish codec, registered in zarr.registry, must let
// zarr.get run the full pipeline (gribberish array_to_bytes -> scale_offset
// K->degC) on a real HRRR temperature_2m chunk.
test("zarr.get decodes an HRRR temperature_2m plane via the gribberish pipeline", {
  timeout: 300_000,
}, async () => {
  const opened = await openV3Group(URL_HRRR, { consolidated: true });
  const arr = await zarr.open.v3(opened.group.resolve("temperature_2m"), {
    kind: "array",
  });
  expect(arr.shape).toEqual([11706, 49, 1059, 1799]);
  expect(arr.dtype).toBe("float64");

  // First init_time / lead_time, full CONUS plane -> [1059, 1799].
  const plane = await zarr.get(arr, [0, 0, null, null]);
  expect(plane.shape).toEqual([1059, 1799]);

  const data = plane.data as Float64Array;
  let min = Infinity;
  let max = -Infinity;
  let finite = 0;
  for (const v of data) {
    if (Number.isFinite(v)) {
      finite++;
      if (v < min) min = v;
      if (v > max) max = v;
    }
  }
  // eslint-disable-next-line no-console
  console.log("GRIBBERISH_PIPELINE stats:", { finite, min, max });
  expect(finite).toBeGreaterThan(0);
  // After scale_offset (offset -273.15), values are degrees Celsius over CONUS.
  expect(min).toBeGreaterThan(-60);
  expect(max).toBeLessThan(60);
  // Sanity: this chunk earlier decoded to 270.9..308.5 K => -2.2..35.4 degC.
  expect(min).toBeLessThan(10);
  expect(max).toBeGreaterThan(20);
});
