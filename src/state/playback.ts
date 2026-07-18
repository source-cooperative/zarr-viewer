/** Playback speed presets (multipliers) for the instant-slider transport. */
export const SPEEDS = [0.5, 1, 2, 4] as const;
export const DEFAULT_SPEED = 1;
/** Frames per second at 1× — a 48-frame forecast plays in ~12 s at 1×. */
export const BASE_FPS = 4;

/** Advance one frame, looping back to 0 at the end. `size` is the dim length. */
export function nextFrame(index: number, size: number): number {
  if (size <= 0) return 0;
  return (index + 1) % size;
}

/** Timer interval for a given speed multiplier. */
export function frameIntervalMs(speed: number): number {
  return 1000 / (BASE_FPS * speed);
}

/** The next speed preset (wraps); unknown speeds fall to the first preset. */
export function nextSpeed(speed: number): number {
  const i = SPEEDS.indexOf(speed as (typeof SPEEDS)[number]);
  return SPEEDS[(i + 1) % SPEEDS.length]!;
}
