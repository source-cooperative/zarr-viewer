import { describe, expect, it } from "vitest";
import { parseViewerState } from "../state/useViewerState";

describe("parseViewerState", () => {
  it("returns sensible defaults for empty params", () => {
    const s = parseViewerState(new URLSearchParams());
    expect(s.url).toBeNull();
    expect(s.opacity).toBe(1);
    expect(s.basemap).toBe("auto");
    expect(s.panel).toBe("closed");
    expect(s.gamma).toBe(1);
    expect(s.stretch).toBe("linear");
    expect(s.colormap).toBeNull();
    expect(s.rescale).toBeNull();
    expect(s.labelsAbove).toBe(true);
    expect(s.profileId).toBeNull();
    expect(s.minZoomOverride).toBeNull();
  });

  it("clamps opacity into [0,1]", () => {
    expect(parseViewerState(new URLSearchParams("opacity=2")).opacity).toBe(1);
    expect(parseViewerState(new URLSearchParams("opacity=-1")).opacity).toBe(0);
  });

  it("parses rescale as two numbers", () => {
    expect(
      parseViewerState(new URLSearchParams("rescale=-40,50")).rescale,
    ).toEqual([-40, 50]);
  });

  it("ignores bad rescale strings", () => {
    expect(parseViewerState(new URLSearchParams("rescale=foo")).rescale).toBeNull();
    expect(parseViewerState(new URLSearchParams("rescale=1,2,3")).rescale).toBeNull();
  });

  it("rejects invalid enum values", () => {
    expect(
      parseViewerState(new URLSearchParams("basemap=spaceship")).basemap,
    ).toBe("auto");
    expect(parseViewerState(new URLSearchParams("stretch=cube")).stretch).toBe(
      "linear",
    );
  });

  it("parses lng/lat/zoom into a view tuple", () => {
    expect(
      parseViewerState(
        new URLSearchParams("lng=-122.45&lat=37.77&zoom=13"),
      ).view,
    ).toEqual([-122.45, 37.77, 13]);
  });

  it("treats latitude outside [-90, 90] as invalid", () => {
    expect(
      parseViewerState(new URLSearchParams("lng=0&lat=95&zoom=5")).view,
    ).toBeNull();
  });

  it("ignores non-numeric view params", () => {
    expect(
      parseViewerState(new URLSearchParams("lng=x&lat=37&zoom=5")).view,
    ).toBeNull();
  });

  it("ignores partial view params (all three or none)", () => {
    expect(
      parseViewerState(new URLSearchParams("lng=10&lat=20")).view,
    ).toBeNull();
    expect(parseViewerState(new URLSearchParams("zoom=5")).view).toBeNull();
  });

  it("parses minZoom as an override, clamped to non-negative", () => {
    expect(
      parseViewerState(new URLSearchParams("minZoom=5")).minZoomOverride,
    ).toBe(5);
    expect(
      parseViewerState(new URLSearchParams("minZoom=-3")).minZoomOverride,
    ).toBe(0);
    expect(
      parseViewerState(new URLSearchParams("minZoom=2.5")).minZoomOverride,
    ).toBe(2.5);
  });

  it("ignores a non-numeric minZoom", () => {
    expect(
      parseViewerState(new URLSearchParams("minZoom=foo")).minZoomOverride,
    ).toBeNull();
  });
});
