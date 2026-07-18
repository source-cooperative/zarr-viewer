import { describe, expect, it } from "vitest";
import { buildExampleLoadPatch } from "../state/load-example";

describe("buildExampleLoadPatch", () => {
  it("always sets the example URL", () => {
    const patch = buildExampleLoadPatch(new URLSearchParams(), {
      url: "https://example.com/data.zarr",
    });
    expect(patch.url).toBe("https://example.com/data.zarr");
  });

  it("clears a stale Icechunk branch/snapshot when switching sources", () => {
    const current = new URLSearchParams("branch=dev&snapshot=ABC123");
    const patch = buildExampleLoadPatch(current, {
      url: "https://example.com/other.icechunk",
    });
    // Ref selection is store-specific — must not carry across a source switch.
    expect(patch.branch).toBeNull();
    expect(patch.snapshot).toBeNull();
  });

  it("applies example defaults when the current URL has no overlap", () => {
    const patch = buildExampleLoadPatch(new URLSearchParams(), {
      url: "https://example.com/data.zarr",
      params: { lng: "-122.45", lat: "37.77", zoom: "13" },
    });
    expect(patch.lng).toBe("-122.45");
    expect(patch.lat).toBe("37.77");
    expect(patch.zoom).toBe("13");
  });

  it("preserves current URL params over example defaults", () => {
    const current = new URLSearchParams("lng=10&lat=20&zoom=5");
    const patch = buildExampleLoadPatch(current, {
      url: "https://example.com/data.zarr",
      params: { lng: "-122.45", lat: "37.77", zoom: "13" },
    });
    // Patch doesn't touch keys already in the URL.
    expect(patch.lng).toBeUndefined();
    expect(patch.lat).toBeUndefined();
    expect(patch.zoom).toBeUndefined();
  });

  it("clears the profile-agnostic reset keys when neither side provides them", () => {
    const patch = buildExampleLoadPatch(new URLSearchParams(), {
      url: "https://example.com/data.zarr",
    });
    expect(patch.colormap).toBeNull();
    expect(patch.rescale).toBeNull();
    expect(patch.gamma).toBeNull();
    expect(patch.stretch).toBeNull();
  });

  it("keeps the user's reset-key value when present", () => {
    const current = new URLSearchParams("colormap=plasma&gamma=1.8");
    const patch = buildExampleLoadPatch(current, {
      url: "https://example.com/data.zarr",
      params: { colormap: "turbo" }, // example defaults are skipped here
    });
    expect(patch.colormap).toBeUndefined();
    expect(patch.gamma).toBeUndefined();
    expect(patch.rescale).toBeNull();
    expect(patch.stretch).toBeNull();
  });

  it("applies example reset-key defaults when the user has none", () => {
    const patch = buildExampleLoadPatch(new URLSearchParams(), {
      url: "https://example.com/data.zarr",
      params: { colormap: "turbo", gamma: "1.5" },
    });
    expect(patch.colormap).toBe("turbo");
    expect(patch.gamma).toBe("1.5");
    expect(patch.rescale).toBeNull();
    expect(patch.stretch).toBeNull();
  });

  it("mixes correctly: user wins, example fills gaps, reset clears the rest", () => {
    const current = new URLSearchParams("lng=10&colormap=plasma");
    const patch = buildExampleLoadPatch(current, {
      url: "https://example.com/data.zarr",
      params: { lng: "-122", lat: "37", zoom: "13", colormap: "turbo" },
    });
    expect(patch.url).toBe("https://example.com/data.zarr");
    expect(patch.lng).toBeUndefined(); // user kept
    expect(patch.lat).toBe("37"); // example fills
    expect(patch.zoom).toBe("13"); // example fills
    expect(patch.colormap).toBeUndefined(); // user kept
    expect(patch.gamma).toBeNull(); // reset
    expect(patch.rescale).toBeNull();
    expect(patch.stretch).toBeNull();
  });
});
