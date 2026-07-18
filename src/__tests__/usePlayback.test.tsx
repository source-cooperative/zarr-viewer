import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { usePlayback, type Playable } from "../state/usePlayback";

const DIM: Playable = { name: "lead_time", size: 3 };

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("usePlayback", () => {
  it("toggles play and advances + loops on the timer", () => {
    const commit = vi.fn();
    const { result } = renderHook(() => usePlayback(DIM, 0, commit));

    expect(result.current.playing).toBe(false);
    act(() => result.current.toggle());
    expect(result.current.playing).toBe(true);

    // 1x → 250ms/frame. Three ticks: 0→1→2→0 (loop).
    act(() => vi.advanceTimersByTime(250));
    expect(result.current.index).toBe(1);
    act(() => vi.advanceTimersByTime(500));
    expect(result.current.index).toBe(0);
  });

  it("cycleSpeed advances the preset", () => {
    const { result } = renderHook(() => usePlayback(DIM, 0, vi.fn()));
    expect(result.current.speed).toBe(1);
    act(() => result.current.cycleSpeed());
    expect(result.current.speed).toBe(2);
  });

  it("pausing commits the current frame", () => {
    const commit = vi.fn();
    const { result } = renderHook(() => usePlayback(DIM, 0, commit));
    act(() => result.current.toggle()); // play
    act(() => vi.advanceTimersByTime(250)); // index → 1
    act(() => result.current.toggle()); // pause
    expect(result.current.playing).toBe(false);
    expect(commit).toHaveBeenLastCalledWith(1);
  });

  it("seekTo pauses and commits the sought frame", () => {
    const commit = vi.fn();
    const { result } = renderHook(() => usePlayback(DIM, 0, commit));
    act(() => result.current.toggle()); // play
    act(() => result.current.seekTo(2));
    expect(result.current.playing).toBe(false);
    expect(result.current.index).toBe(2);
    expect(commit).toHaveBeenLastCalledWith(2);
  });

  it("stops playing when the playable dim changes", () => {
    const { result, rerender } = renderHook(
      ({ p }: { p: Playable | null }) => usePlayback(p, 0, vi.fn()),
      { initialProps: { p: DIM } },
    );
    act(() => result.current.toggle());
    expect(result.current.playing).toBe(true);
    rerender({ p: { name: "step", size: 5 } });
    expect(result.current.playing).toBe(false);
  });

  it("stops playing when the playable dim vanishes", () => {
    const { result, rerender } = renderHook(
      ({ p }: { p: Playable | null }) => usePlayback(p, 0, vi.fn()),
      { initialProps: { p: DIM } },
    );
    act(() => result.current.toggle());
    expect(result.current.playing).toBe(true);
    rerender({ p: null });
    expect(result.current.playing).toBe(false);
  });
});
