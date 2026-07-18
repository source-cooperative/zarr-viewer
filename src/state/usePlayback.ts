import { useCallback, useEffect, useRef, useState } from "react";
import {
  DEFAULT_SPEED,
  frameIntervalMs,
  nextFrame,
  nextSpeed,
} from "./playback";

export type Playable = { name: string; size: number };

export type Playback = {
  playing: boolean;
  speed: number;
  index: number;
  toggle: () => void;
  cycleSpeed: () => void;
  seekTo: (index: number) => void;
};

/** Owns play/pause + speed + the animated frame index for one "live" dim.
 *
 * `currentIndex` seeds playback when it starts (so it continues from where the
 * slider is). `onCommit` writes the shown frame back to the URL on pause/seek —
 * during playback nothing is committed (see the design spec). */
export function usePlayback(
  playable: Playable | null,
  currentIndex: number,
  onCommit: (index: number) => void,
): Playback {
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState<number>(DEFAULT_SPEED);
  const [index, setIndex] = useState(currentIndex);

  // Always call the latest commit callback / read the latest frame without
  // re-arming the timer effect.
  const commitRef = useRef(onCommit);
  commitRef.current = onCommit;
  const indexRef = useRef(index);
  indexRef.current = index;

  // Stop (drop back to manual) whenever the animatable dim changes or vanishes.
  const key = playable ? `${playable.name}:${playable.size}` : null;
  useEffect(() => {
    setPlaying(false);
  }, [key]);

  // Frame timer: advance + loop while playing.
  useEffect(() => {
    if (!playing || !playable) return;
    const id = setInterval(() => {
      setIndex((prev) => nextFrame(prev, playable.size));
    }, frameIntervalMs(speed));
    return () => clearInterval(id);
  }, [playing, speed, playable?.name, playable?.size]);

  const toggle = useCallback(() => {
    if (!playable) return;
    setPlaying((was) => {
      if (was) {
        commitRef.current(indexRef.current); // pausing → commit current frame
        return false;
      }
      setIndex(currentIndex); // starting → continue from the slider
      return true;
    });
  }, [playable, currentIndex]);

  const cycleSpeed = useCallback(() => setSpeed((s) => nextSpeed(s)), []);

  const seekTo = useCallback((i: number) => {
    setPlaying(false);
    setIndex(i);
    commitRef.current(i);
  }, []);

  return { playing, speed, index, toggle, cycleSpeed, seekTo };
}
