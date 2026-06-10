import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  _resetInstalledForTesting,
  _resetTileHealthForTesting,
  installConsoleAbortFilter,
  isAbortError,
  reportTileError,
  reportTileResult,
  subscribeTileHealth,
} from "../zarr/tile-error";

// The install flag is module-scoped so production code can't double-wrap.
// Reset before each test so each test sees a fresh wrapper.
beforeEach(() => _resetInstalledForTesting());

describe("isAbortError", () => {
  it("recognizes DOMException AbortError", () => {
    const err = new DOMException("aborted", "AbortError");
    expect(isAbortError(err)).toBe(true);
  });

  it("recognizes any error with name AbortError", () => {
    const err = Object.assign(new Error("x"), { name: "AbortError" });
    expect(isAbortError(err)).toBe(true);
  });

  it("returns false for unrelated errors", () => {
    expect(isAbortError(new Error("boom"))).toBe(false);
    expect(isAbortError(null)).toBe(false);
    expect(isAbortError("string")).toBe(false);
  });
});

describe("installConsoleAbortFilter", () => {
  it("swallows AbortError but forwards real errors", () => {
    const original = console.error;
    const calls: unknown[][] = [];
    console.error = (...args: unknown[]) => calls.push(args);
    try {
      installConsoleAbortFilter();
      // first call: AbortError → swallowed
      console.error(new DOMException("aborted", "AbortError"));
      expect(calls.length).toBe(0);
      // second call: real error → forwarded
      const real = new Error("boom");
      console.error(real);
      expect(calls).toEqual([[real]]);
    } finally {
      console.error = original;
    }
  });

  it("is idempotent (double-install doesn't double-wrap)", () => {
    const original = console.error;
    try {
      installConsoleAbortFilter();
      const afterFirst = console.error;
      installConsoleAbortFilter();
      expect(console.error).toBe(afterFirst);
    } finally {
      console.error = original;
    }
  });

  it("passes multi-arg calls through unchanged", () => {
    const original = console.error;
    const calls: unknown[][] = [];
    console.error = (...args: unknown[]) => calls.push(args);
    try {
      installConsoleAbortFilter();
      // Multi-arg call (e.g. console.error("label", err)) is forwarded even
      // if one of the args is an AbortError, so we don't lose context.
      const err = new DOMException("aborted", "AbortError");
      console.error("label", err);
      expect(calls).toEqual([["label", err]]);
      vi.fn();
    } finally {
      console.error = original;
    }
  });

  it("does not swallow the logger's prefixed 2-arg error output", () => {
    // createLogger.error emits `console.error("[zarr:ns]", err)` — a 2-arg call,
    // so the single-arg AbortError filter must not drop it.
    const original = console.error;
    const calls: unknown[][] = [];
    console.error = (...args: unknown[]) => calls.push(args);
    try {
      installConsoleAbortFilter();
      const err = new Error("boom");
      console.error("[zarr:app]", "prepare failed", err);
      expect(calls).toEqual([["[zarr:app]", "prepare failed", err]]);
    } finally {
      console.error = original;
    }
  });

  it("swallows the luma.gl 'Binding sampler not set' warning", () => {
    const original = console.warn;
    const calls: unknown[][] = [];
    console.warn = (...args: unknown[]) => calls.push(args);
    try {
      installConsoleAbortFilter();
      console.warn(
        "luma.gl: Binding sampler not set: Not found in shader layout.",
      );
      expect(calls.length).toBe(0);
    } finally {
      console.warn = original;
    }
  });

  it("forwards unrelated warnings", () => {
    const original = console.warn;
    const calls: unknown[][] = [];
    console.warn = (...args: unknown[]) => calls.push(args);
    try {
      installConsoleAbortFilter();
      console.warn("something else entirely");
      expect(calls).toEqual([["something else entirely"]]);
    } finally {
      console.warn = original;
    }
  });
});

describe("tile health", () => {
  beforeEach(() => _resetTileHealthForTesting());

  it("flips to degraded after consecutive non-abort failures (threshold 4)", () => {
    const seen: boolean[] = [];
    subscribeTileHealth((d) => seen.push(d));
    for (let i = 0; i < 3; i++) reportTileError(new Error("boom"));
    expect(seen).toEqual([]); // below threshold, no transition
    reportTileError(new Error("boom")); // 4th → degraded
    expect(seen).toEqual([true]);
  });

  it("ignores AbortErrors (routine pruning never trips it)", () => {
    const seen: boolean[] = [];
    subscribeTileHealth((d) => seen.push(d));
    for (let i = 0; i < 10; i++) {
      reportTileError(new DOMException("aborted", "AbortError"));
    }
    expect(seen).toEqual([]);
  });

  it("a success resets the streak and clears degraded", () => {
    const seen: boolean[] = [];
    subscribeTileHealth((d) => seen.push(d));
    for (let i = 0; i < 4; i++) reportTileError(new Error("boom"));
    expect(seen).toEqual([true]);
    reportTileResult(true); // recovery
    expect(seen).toEqual([true, false]);
    // Streak was reset: three more failures stay below threshold.
    for (let i = 0; i < 3; i++) reportTileError(new Error("boom"));
    expect(seen).toEqual([true, false]);
  });

  it("only notifies on transitions, not every event", () => {
    const seen: boolean[] = [];
    subscribeTileHealth((d) => seen.push(d));
    for (let i = 0; i < 6; i++) reportTileError(new Error("boom"));
    expect(seen).toEqual([true]); // one transition despite 6 failures
  });
});
