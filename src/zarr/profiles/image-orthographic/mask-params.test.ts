import { describe, expect, it } from "vitest";
import { imageOrthographicProfile } from "./profile";
import type { ImageOrthographicState } from "./types";

const baseState: ImageOrthographicState = {
  channel: 0,
  indices: {},
  colormap: "gray",
  gamma: 1,
  rescale: null,
  maskOutsideRescale: false,
};

describe("image-orthographic mask URL param", () => {
  it("parses mask=1 into maskOutsideRescale: true", () => {
    expect(
      imageOrthographicProfile.parseUrlParams(new URLSearchParams("mask=1"))
        .maskOutsideRescale,
    ).toBe(true);
  });

  it("leaves maskOutsideRescale unset when the param is absent", () => {
    expect(
      imageOrthographicProfile.parseUrlParams(new URLSearchParams())
        .maskOutsideRescale,
    ).toBeUndefined();
  });

  it("serializes mask=1 when on and clears it when off", () => {
    expect(
      imageOrthographicProfile.serializeUrlParams({
        ...baseState,
        maskOutsideRescale: true,
      }).mask,
    ).toBe("1");
    expect(
      imageOrthographicProfile.serializeUrlParams({
        ...baseState,
        maskOutsideRescale: false,
      }).mask,
    ).toBeNull();
  });
});
