import { afterEach, expect, test } from "vitest";
import { log } from "@luma.gl/core";
import {
  _resetLumaLogFilterForTesting,
  installLumaLogFilter,
} from "../render/luma-log-filter";

// luma's `log` is a global singleton; save/restore its `warn` so wrapping it
// here doesn't leak into other tests.
type WarnFn = (message?: unknown, ...args: unknown[]) => unknown;
const lumaLog = log as unknown as { warn: WarnFn };
const originalWarn = lumaLog.warn;

afterEach(() => {
  lumaLog.warn = originalWarn;
  _resetLumaLogFilterForTesting();
});

test("installLumaLogFilter drops the sampler warning, passes others through", () => {
  const calls: unknown[][] = [];
  // Install our filter on top of a spy so we can observe what it forwards.
  lumaLog.warn = (...args: unknown[]) => {
    calls.push(args);
    return () => {};
  };
  installLumaLogFilter();

  // The suppressed message must not reach the underlying warn, and must still
  // return a callable (luma invokes `log.warn(msg)()`).
  const deferred = lumaLog.warn(
    "luma.gl: Binding sampler not set: Not found in shader layout.",
  );
  expect(typeof deferred).toBe("function");
  (deferred as () => void)();
  expect(calls).toHaveLength(0);

  // Unrelated warnings pass through untouched.
  lumaLog.warn("some other luma warning");
  expect(calls).toHaveLength(1);
  expect(String(calls[0]![0])).toContain("some other");
});
