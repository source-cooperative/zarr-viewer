import { describe, expect, it } from "vitest";
import { UnsupportedError } from "zarrita";
import { humanizeError } from "../components/Toast";

const named = (name: string, message = "") =>
  Object.assign(new Error(message), { name });

describe("humanizeError", () => {
  it("reports a slow/unstable connection for transient failures", () => {
    expect(humanizeError(new TypeError("Failed to fetch"))).toMatch(
      /slow or unstable/,
    );
    expect(
      humanizeError(named("StorageError", "HTTP 503 Service Unavailable for x")),
    ).toMatch(/slow or unstable/);
  });

  it("reports a genuine 404 as store-not-found", () => {
    expect(
      humanizeError(new Error("Unexpected response status 404 Not Found")),
    ).toMatch(/404/);
    expect(humanizeError(named("NotFoundError", "Object not found: /x"))).toMatch(
      /404/,
    );
  });

  it("calls out CORS when explicitly flagged", () => {
    expect(humanizeError(new Error("blocked by CORS policy"))).toMatch(/CORS/);
  });

  it("explains an unrenderable store", () => {
    expect(
      humanizeError(new Error("No regular lat/lon gridded variables found.")),
    ).toMatch(/can't render/);
    expect(humanizeError(new UnsupportedError("float16"))).toMatch(/can't render/);
  });

  it("falls back to a generic message otherwise", () => {
    expect(humanizeError(new Error("something totally unexpected"))).toMatch(
      /Could not load the Zarr store/,
    );
  });
});
