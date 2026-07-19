import { describe, expect, it } from "vitest";
import { imageOrthographicProfile } from "./profile";
import type { ImageOrthographicState } from "./types";

const baseState: ImageOrthographicState = {
  channel: 0,
  indices: {},
  colormap: "gray",
  gamma: 1,
  rescale: null,
  maskBelow: false,
  maskAbove: false,
};

describe("image-orthographic mask URL params", () => {
  it("parses mask_below / mask_above independently", () => {
    const below = imageOrthographicProfile.parseUrlParams(
      new URLSearchParams("mask_below=1"),
    );
    expect(below.maskBelow).toBe(true);
    expect(below.maskAbove).toBeUndefined();

    const above = imageOrthographicProfile.parseUrlParams(
      new URLSearchParams("mask_above=1"),
    );
    expect(above.maskAbove).toBe(true);
    expect(above.maskBelow).toBeUndefined();
  });

  it("leaves both unset when the params are absent", () => {
    const out = imageOrthographicProfile.parseUrlParams(new URLSearchParams());
    expect(out.maskBelow).toBeUndefined();
    expect(out.maskAbove).toBeUndefined();
  });

  it("serializes each flag to its own param, clearing when off", () => {
    const on = imageOrthographicProfile.serializeUrlParams({
      ...baseState,
      maskBelow: true,
      maskAbove: false,
    });
    expect(on.mask_below).toBe("1");
    expect(on.mask_above).toBeNull();

    const off = imageOrthographicProfile.serializeUrlParams({
      ...baseState,
      maskBelow: false,
      maskAbove: true,
    });
    expect(off.mask_below).toBeNull();
    expect(off.mask_above).toBe("1");
  });
});
