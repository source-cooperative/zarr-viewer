import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createLogger,
  isLevelEnabled,
  resolveInitialLevel,
  setLogLevel,
} from "../log";

describe("createLogger levels", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let infoSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it("gates debug/info below the active level; error/warn still emit", () => {
    setLogLevel("warn");
    const log = createLogger("test");
    log.debug("d");
    log.info("i");
    log.warn("w");
    log.error("e");
    expect(logSpy).not.toHaveBeenCalled(); // debug → console.log
    expect(infoSpy).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });

  it("emits with a [zarr:<ns>] prefix and passes data through", () => {
    setLogLevel("debug");
    const log = createLogger("store");
    const data = { a: 1 };
    log.debug("hello", data);
    expect(logSpy).toHaveBeenCalledWith("[zarr:store]", "hello", data);
    log.info("hi", 2, 3);
    expect(infoSpy).toHaveBeenCalledWith("[zarr:store]", "hi", 2, 3);
  });

  it("silent suppresses every level", () => {
    setLogLevel("silent");
    const log = createLogger("x");
    log.error("e");
    log.warn("w");
    expect(errorSpy).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("isEnabled reflects the active level", () => {
    setLogLevel("info");
    expect(isLevelEnabled("info")).toBe(true);
    expect(isLevelEnabled("debug")).toBe(false);
    expect(isLevelEnabled("error")).toBe(true);
  });

  it("time() logs elapsed only when its level is enabled", () => {
    setLogLevel("debug");
    const log = createLogger("t");
    log.time("op")();
    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(logSpy.mock.calls[0]![1]).toMatch(/op took \d+ms/);

    logSpy.mockClear();
    setLogLevel("warn");
    log.time("op2")(); // disabled → no-op
    expect(logSpy).not.toHaveBeenCalled();
  });
});

describe("resolveInitialLevel precedence", () => {
  afterEach(() => {
    window.localStorage.clear();
    window.history.replaceState({}, "", "/");
  });

  it("URL ?log= wins and persists to localStorage", () => {
    window.localStorage.clear();
    window.history.replaceState({}, "", "/?log=debug");
    expect(resolveInitialLevel()).toBe("debug");
    expect(window.localStorage.getItem("zarr:log")).toBe("debug");
  });

  it("falls back to localStorage when there is no URL param", () => {
    window.history.replaceState({}, "", "/");
    window.localStorage.setItem("zarr:log", "error");
    expect(resolveInitialLevel()).toBe("error");
  });

  it("ignores an invalid ?log= value (falls through to the default)", () => {
    window.localStorage.clear();
    window.history.replaceState({}, "", "/?log=bogus");
    expect(["info", "warn"]).toContain(resolveInitialLevel());
  });
});
