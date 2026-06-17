import { describe, expect, it } from "vitest";
import {
  defaultDimIndices,
  type ScalarGridVariable,
} from "../zarr/profiles/scalar-grid/types";

/** Build a minimal variable with the given non-spatial dims; `defaultDimIndices`
 * only reads `dims`. */
function variable(dims: { name: string; size: number }[]): ScalarGridVariable {
  return {
    name: "v",
    group: "",
    longName: null,
    units: null,
    fillValue: null,
    scaleFactor: 1,
    addOffset: 0,
    dims,
    textureDim: null,
    memoryDims: [],
  };
}

describe("defaultDimIndices", () => {
  it("defaults a forecast-initialization dim to the most recent (SEAS5 spi3)", () => {
    // Regression: SEAS5 `spi3[lead, member, init, lat, lon]` defaulted `init`
    // to 0 — an early, near-empty initialization (SPI-3 undefined before 3
    // months of history) — rendering a value-0 border. The latest init has
    // real data and is the right default.
    const out = defaultDimIndices(
      variable([
        { name: "lead", size: 6 },
        { name: "member", size: 51 },
        { name: "init", size: 544 },
      ]),
    );
    expect(out).toEqual({ lead: 0, member: 0, init: 543 });
  });

  it("defaults time-like dims to the last index, others to 0", () => {
    const out = defaultDimIndices(
      variable([
        { name: "time", size: 10 },
        { name: "lead_time", size: 4 },
        { name: "reference_time", size: 7 },
        { name: "level", size: 3 },
      ]),
    );
    expect(out).toEqual({
      time: 9,
      lead_time: 3,
      reference_time: 6,
      level: 0,
    });
  });

  it("handles a single-element dim without going negative", () => {
    const out = defaultDimIndices(variable([{ name: "init", size: 1 }]));
    expect(out).toEqual({ init: 0 });
  });
});
