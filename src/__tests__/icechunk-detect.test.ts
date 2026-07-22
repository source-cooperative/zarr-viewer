import { afterEach, describe, expect, it, vi } from "vitest";
import { hasIcechunkRepoConfig } from "../zarr/load-zarr";

const BASE = "https://example.com/some-repo";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("hasIcechunkRepoConfig", () => {
  it("detects a repo whose host rejects HEAD but serves GET /repo (issue #62)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (init?.method === "HEAD") throw new Error("Method Not Allowed");
        if (url === `${BASE}/repo`) return new Response(null, { status: 200 });
        return new Response(null, { status: 404 });
      }),
    );
    expect(await hasIcechunkRepoConfig(BASE)).toBe(true);
  });

  it("falls back to the branch ref pointer when /repo is missing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url === `${BASE}/refs/branch.main/ref.json`) {
          return new Response(null, { status: 200 });
        }
        return new Response(null, { status: 404 });
      }),
    );
    expect(await hasIcechunkRepoConfig(BASE)).toBe(true);
  });

  it("returns false for a plain Zarr store (both probes miss)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 404 })),
    );
    expect(await hasIcechunkRepoConfig(BASE)).toBe(false);
  });

  it("returns false on network/CORS failure rather than throwing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("Failed to fetch");
      }),
    );
    await expect(hasIcechunkRepoConfig(BASE)).resolves.toBe(false);
  });
});
