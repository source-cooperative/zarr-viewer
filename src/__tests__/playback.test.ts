import { describe, expect, it } from "vitest";
import {
  BASE_FPS,
  DEFAULT_SPEED,
  frameIntervalMs,
  nextFrame,
  nextSpeed,
  SPEEDS,
} from "../state/playback";

describe("playback helpers", () => {
  it("exposes the agreed presets and base rate", () => {
    expect(SPEEDS).toEqual([0.5, 1, 2, 4]);
    expect(DEFAULT_SPEED).toBe(1);
    expect(BASE_FPS).toBe(4);
  });

  it("nextFrame advances and loops at the end", () => {
    expect(nextFrame(0, 3)).toBe(1);
    expect(nextFrame(1, 3)).toBe(2);
    expect(nextFrame(2, 3)).toBe(0); // loop
    expect(nextFrame(5, 1)).toBe(0); // single-frame dim
    expect(nextFrame(0, 0)).toBe(0); // empty guard
  });

  it("frameIntervalMs = 1000 / (4 * speed)", () => {
    expect(frameIntervalMs(0.5)).toBe(500);
    expect(frameIntervalMs(1)).toBe(250);
    expect(frameIntervalMs(2)).toBe(125);
    expect(frameIntervalMs(4)).toBe(62.5);
  });

  it("nextSpeed cycles the presets and wraps", () => {
    expect(nextSpeed(0.5)).toBe(1);
    expect(nextSpeed(1)).toBe(2);
    expect(nextSpeed(2)).toBe(4);
    expect(nextSpeed(4)).toBe(0.5); // wrap
    expect(nextSpeed(3)).toBe(0.5); // unknown → first
  });
});
