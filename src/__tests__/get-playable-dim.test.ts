import { describe, expect, it } from "vitest";
import { scalarGridProfile } from "../zarr/profiles/scalar-grid/profile";
import type {
  ScalarGridContext,
  ScalarGridState,
} from "../zarr/profiles/scalar-grid/types";

// Minimal ctx/state — getPlayableDim only reads variables + state.variable.
function ctxWith(
  textureDim: { name: string; window: number } | null,
  size: number,
): ScalarGridContext {
  return {
    variables: [
      {
        name: "t2m",
        group: "",
        longName: null,
        units: null,
        fillValue: null,
        scaleFactor: 1,
        addOffset: 0,
        dims: [{ name: "lead_time", size }],
        textureDim,
        memoryDims: [],
      },
    ],
  } as unknown as ScalarGridContext;
}
const state = { variable: "t2m", dimIndices: {} } as ScalarGridState;

describe("scalarGridProfile.getPlayableDim", () => {
  it("returns the texture dim with its size", () => {
    const ctx = ctxWith({ name: "lead_time", window: 49 }, 49);
    expect(scalarGridProfile.getPlayableDim!(ctx, state)).toEqual({
      name: "lead_time",
      size: 49,
    });
  });

  it("returns null when there is no texture dim", () => {
    expect(scalarGridProfile.getPlayableDim!(ctxWith(null, 49), state)).toBeNull();
  });

  it("returns null for a single-frame dim (nothing to animate)", () => {
    const ctx = ctxWith({ name: "lead_time", window: 1 }, 1);
    expect(scalarGridProfile.getPlayableDim!(ctx, state)).toBeNull();
  });
});
