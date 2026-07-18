# Instant-slider Playback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a podcast-style play/pause + speed transport to the "Data · instant" live texture-array slider so the viewer can animate a forecast dimension forward (looping), at 0.5×/1×/2×/4×.

**Architecture:** Playback state (playing / speed / animated frame index) lives in React state in `App` — NOT the URL — driven by a `setInterval`. During playback the map layer, the live slider, and the hover readout read an "effective" profile state whose live-dim index is the animated frame. The index is committed back to the URL only on pause/seek. A new profile method `getPlayableDim` tells the profile-agnostic `App` which dim (and how many frames) is animatable.

**Tech Stack:** React 19, TypeScript, Vitest + @testing-library/react (jsdom), Vite.

## Global Constraints

- Run all tooling against the zarr-viewer package explicitly: `pnpm -C /Users/tylere/Documents/GitHub/source-cooperative/zarr-viewer …` (the shell's cwd is a different repo).
- Speed presets: `[0.5, 1, 2, 4]`, default `1`. Base rate `BASE_FPS = 4` → frame interval `1000 / (BASE_FPS * speed)` ms.
- End-of-sequence behavior: **loop** (`(index + 1) % size`).
- Playback is session-local: never written to the URL; never auto-starts on load.
- Scope: the single "live" texture-array dim only. Do not touch cached/fetch sliders.
- TDD, one focused file per responsibility, commit per task.

---

### Task 1: Pure playback helpers

**Files:**
- Create: `src/state/playback.ts`
- Test: `src/__tests__/playback.test.ts`

**Interfaces:**
- Produces: `SPEEDS: readonly number[]`, `BASE_FPS: number`, `DEFAULT_SPEED: number`, `nextFrame(index: number, size: number): number`, `frameIntervalMs(speed: number): number`, `nextSpeed(speed: number): number`.

- [ ] **Step 1: Write the failing test**

Create `src/__tests__/playback.test.ts`:
```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm -C /Users/tylere/Documents/GitHub/source-cooperative/zarr-viewer exec vitest run src/__tests__/playback.test.ts`
Expected: FAIL — cannot resolve `../state/playback`.

- [ ] **Step 3: Write minimal implementation**

Create `src/state/playback.ts`:
```ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm -C /Users/tylere/Documents/GitHub/source-cooperative/zarr-viewer exec vitest run src/__tests__/playback.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git -C /Users/tylere/Documents/GitHub/source-cooperative/zarr-viewer add src/state/playback.ts src/__tests__/playback.test.ts
git -C /Users/tylere/Documents/GitHub/source-cooperative/zarr-viewer commit -m "feat(playback): pure frame/speed helpers"
```

---

### Task 2: `usePlayback` hook

**Files:**
- Create: `src/state/usePlayback.ts`
- Test: `src/__tests__/usePlayback.test.tsx`

**Interfaces:**
- Consumes: `frameIntervalMs`, `nextFrame`, `nextSpeed`, `DEFAULT_SPEED` (Task 1).
- Produces:
  ```ts
  export type Playable = { name: string; size: number };
  export type Playback = {
    playing: boolean;
    speed: number;
    index: number;
    toggle: () => void;
    cycleSpeed: () => void;
    seekTo: (index: number) => void;
  };
  export function usePlayback(
    playable: Playable | null,
    currentIndex: number,
    onCommit: (index: number) => void,
  ): Playback;
  ```

- [ ] **Step 1: Write the failing test**

Create `src/__tests__/usePlayback.test.tsx`:
```tsx
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
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm -C /Users/tylere/Documents/GitHub/source-cooperative/zarr-viewer exec vitest run src/__tests__/usePlayback.test.tsx`
Expected: FAIL — cannot resolve `../state/usePlayback`.

- [ ] **Step 3: Write minimal implementation**

Create `src/state/usePlayback.ts`:
```ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm -C /Users/tylere/Documents/GitHub/source-cooperative/zarr-viewer exec vitest run src/__tests__/usePlayback.test.tsx`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git -C /Users/tylere/Documents/GitHub/source-cooperative/zarr-viewer add src/state/usePlayback.ts src/__tests__/usePlayback.test.tsx
git -C /Users/tylere/Documents/GitHub/source-cooperative/zarr-viewer commit -m "feat(playback): usePlayback hook (timer, loop, speed, commit-on-pause)"
```

---

### Task 3: Profile contract — `getPlayableDim` + `playback` control prop

**Files:**
- Modify: `src/zarr/profile.ts` (add `playback` to `ProfileControlsProps`; add `getPlayableDim` to `ZarrProfile`)
- Modify: `src/zarr/profiles/scalar-grid/profile.ts` (implement `getPlayableDim`)
- Test: `src/__tests__/get-playable-dim.test.ts`

**Interfaces:**
- Consumes: `Playback` shape (Task 2) — but to avoid a state→zarr import cycle, `ProfileControlsProps.playback` is declared structurally inline (see code).
- Produces: `ZarrProfile.getPlayableDim?(ctx, state) => { name: string; size: number } | null`; `ProfileControlsProps.playback?`.

- [ ] **Step 1: Write the failing test**

Create `src/__tests__/get-playable-dim.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { scalarGridProfile } from "../zarr/profiles/scalar-grid/profile";
import type {
  ScalarGridContext,
  ScalarGridState,
} from "../zarr/profiles/scalar-grid/types";

// Minimal ctx/state — getPlayableDim only reads variables + state.variable.
function ctxWith(
  textureDim: { name: string; window: number } | null,
  size: number,
): ScalarGridContext {
  return {
    variables: [
      {
        name: "t2m",
        group: "",
        longName: null,
        units: null,
        fillValue: null,
        scaleFactor: 1,
        addOffset: 0,
        dims: [{ name: "lead_time", size }],
        textureDim,
        memoryDims: [],
      },
    ],
  } as unknown as ScalarGridContext;
}
const state = { variable: "t2m", dimIndices: {} } as ScalarGridState;

describe("scalarGridProfile.getPlayableDim", () => {
  it("returns the texture dim with its size", () => {
    const ctx = ctxWith({ name: "lead_time", window: 49 }, 49);
    expect(scalarGridProfile.getPlayableDim!(ctx, state)).toEqual({
      name: "lead_time",
      size: 49,
    });
  });

  it("returns null when there is no texture dim", () => {
    expect(scalarGridProfile.getPlayableDim!(ctxWith(null, 49), state)).toBeNull();
  });

  it("returns null for a single-frame dim (nothing to animate)", () => {
    const ctx = ctxWith({ name: "lead_time", window: 1 }, 1);
    expect(scalarGridProfile.getPlayableDim!(ctx, state)).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm -C /Users/tylere/Documents/GitHub/source-cooperative/zarr-viewer exec vitest run src/__tests__/get-playable-dim.test.ts`
Expected: FAIL — `getPlayableDim` is undefined (`scalarGridProfile.getPlayableDim!` throws / property missing).

- [ ] **Step 3a: Add the contract to `src/zarr/profile.ts`**

In `ProfileControlsProps<Ctx, S>` (after the `group?: ControlGroup;` field), add:
```ts
  /** Playback transport for the profile's "live" (instant) dim, populated by
   * the chassis only for the "instant" bucket when a dim is animatable. */
  playback?: {
    playing: boolean;
    speed: number;
    toggle: () => void;
    cycleSpeed: () => void;
    seekTo: (index: number) => void;
  } | null;
```

In `ZarrProfile<S, Ctx>` (alongside the other optional methods, e.g. near `sampleValue`), add:
```ts
  /** The profile's animatable "live" dim for the current state — a texture-array
   * dim scrubbed as a GPU uniform — or null when nothing is animatable. Lets the
   * profile-agnostic chassis drive the playback transport. */
  getPlayableDim?: (ctx: Ctx, state: S) => { name: string; size: number } | null;
```

- [ ] **Step 3b: Implement it in `src/zarr/profiles/scalar-grid/profile.ts`**

Inside the `scalarGridProfile` object literal (add a method next to `sampleValue`):
```ts
  getPlayableDim(ctx, state) {
    const v = ctx.variables.find((x) => x.name === state.variable);
    if (!v?.textureDim) return null;
    const dim = v.dims.find((d) => d.name === v.textureDim!.name);
    if (!dim || dim.size <= 1) return null;
    return { name: dim.name, size: dim.size };
  },
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm -C /Users/tylere/Documents/GitHub/source-cooperative/zarr-viewer exec vitest run src/__tests__/get-playable-dim.test.ts`
Expected: PASS (3 tests). Also run `pnpm -C /Users/tylere/Documents/GitHub/source-cooperative/zarr-viewer exec tsc -b` — expected: no errors (projected-grid inherits `getPlayableDim` via its `...scalarGridProfile` spread; no change needed there).

- [ ] **Step 5: Commit**

```bash
git -C /Users/tylere/Documents/GitHub/source-cooperative/zarr-viewer add src/zarr/profile.ts src/zarr/profiles/scalar-grid/profile.ts src/__tests__/get-playable-dim.test.ts
git -C /Users/tylere/Documents/GitHub/source-cooperative/zarr-viewer commit -m "feat(playback): getPlayableDim contract + scalar-grid impl"
```

---

### Task 4: `PlaybackSlider` component

**Files:**
- Create: `src/components/PlaybackSlider.tsx`
- Test: `src/__tests__/PlaybackSlider.test.tsx`

**Interfaces:**
- Consumes: `StepperRange` (`src/components/StepperRange.tsx`), `tintLabelStyle` (`src/zarr/dim-colors.ts`).
- Produces: `PlaybackSlider` (default-styled transport). Props:
  ```ts
  { label: string; value: number; min: number; max: number;
    playing: boolean; speed: number;
    onToggle: () => void; onCycleSpeed: () => void; onSeek: (next: number) => void;
    formatValue: (v: number) => string; tint?: string }
  ```

- [ ] **Step 1: Write the failing test**

Create `src/__tests__/PlaybackSlider.test.tsx`:
```tsx
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { PlaybackSlider } from "../components/PlaybackSlider";

function setup(over: Partial<React.ComponentProps<typeof PlaybackSlider>> = {}) {
  const props = {
    label: "lead_time (live)",
    value: 1,
    min: 0,
    max: 4,
    playing: false,
    speed: 1,
    onToggle: vi.fn(),
    onCycleSpeed: vi.fn(),
    onSeek: vi.fn(),
    formatValue: (v: number) => `t+${v}h`,
    ...over,
  };
  render(<PlaybackSlider {...props} />);
  return props;
}

describe("PlaybackSlider", () => {
  it("shows the label and formatted value", () => {
    setup();
    expect(screen.getByText("lead_time (live)")).toBeInTheDocument();
    expect(screen.getByText("t+1h")).toBeInTheDocument();
  });

  it("play button calls onToggle and reflects state in its label", () => {
    const props = setup({ playing: false });
    const btn = screen.getByRole("button", { name: "Play" });
    fireEvent.click(btn);
    expect(props.onToggle).toHaveBeenCalledOnce();
  });

  it("shows a Pause label while playing", () => {
    setup({ playing: true });
    expect(screen.getByRole("button", { name: "Pause" })).toBeInTheDocument();
  });

  it("speed chip shows the multiplier and cycles on click", () => {
    const props = setup({ speed: 2 });
    const chip = screen.getByRole("button", { name: /speed/i });
    expect(chip).toHaveTextContent("2×");
    fireEvent.click(chip);
    expect(props.onCycleSpeed).toHaveBeenCalledOnce();
  });

  it("dragging the range calls onSeek", () => {
    const props = setup();
    fireEvent.change(screen.getByRole("slider"), { target: { value: "3" } });
    expect(props.onSeek).toHaveBeenCalledWith(3);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm -C /Users/tylere/Documents/GitHub/source-cooperative/zarr-viewer exec vitest run src/__tests__/PlaybackSlider.test.tsx`
Expected: FAIL — cannot resolve `../components/PlaybackSlider`.

- [ ] **Step 3: Write minimal implementation**

Create `src/components/PlaybackSlider.tsx`:
```tsx
import { StepperRange } from "./StepperRange";
import { tintLabelStyle } from "../zarr/dim-colors";

type Props = {
  label: string;
  value: number;
  min: number;
  max: number;
  playing: boolean;
  speed: number;
  onToggle: () => void;
  onCycleSpeed: () => void;
  onSeek: (next: number) => void;
  formatValue: (v: number) => string;
  tint?: string;
};

/** The "live" texture-array dim scrubber with a podcast-style transport:
 * play/pause + a tap-to-cycle speed chip above the existing StepperRange.
 * Seeking (drag or step) pauses playback and commits the frame (via onSeek). */
export function PlaybackSlider({
  label,
  value,
  min,
  max,
  playing,
  speed,
  onToggle,
  onCycleSpeed,
  onSeek,
  formatValue,
  tint,
}: Props) {
  return (
    <label style={tintLabelStyle(tint)}>
      <span
        className="field-label"
        style={{ display: "flex", justifyContent: "space-between" }}
      >
        <span>{label}</span>
        <span className="mono" style={{ textTransform: "none" }}>
          {formatValue(value)}
        </span>
      </span>
      <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4 }}>
        <button
          type="button"
          className="step-btn"
          aria-label={playing ? "Pause" : "Play"}
          aria-pressed={playing}
          onClick={onToggle}
        >
          {playing ? <PauseIcon /> : <PlayIcon />}
        </button>
        <button
          type="button"
          className="mono"
          aria-label={`Playback speed ${speed}×`}
          onClick={onCycleSpeed}
          style={{
            fontSize: 12,
            padding: "2px 8px",
            border: "1px solid var(--border, #444)",
            borderRadius: 4,
            background: "transparent",
            color: "inherit",
            cursor: "pointer",
            minWidth: 40,
          }}
        >
          {speed}×
        </button>
      </div>
      <StepperRange value={value} min={min} max={max} onChange={onSeek} />
    </label>
  );
}

function PlayIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <polygon points="6 4 20 12 6 20 6 4" />
    </svg>
  );
}

function PauseIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <rect x="6" y="4" width="4" height="16" />
      <rect x="14" y="4" width="4" height="16" />
    </svg>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm -C /Users/tylere/Documents/GitHub/source-cooperative/zarr-viewer exec vitest run src/__tests__/PlaybackSlider.test.tsx`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git -C /Users/tylere/Documents/GitHub/source-cooperative/zarr-viewer add src/components/PlaybackSlider.tsx src/__tests__/PlaybackSlider.test.tsx
git -C /Users/tylere/Documents/GitHub/source-cooperative/zarr-viewer commit -m "feat(playback): PlaybackSlider transport component"
```

---

### Task 5: Wire the scalar-grid controls to render `PlaybackSlider`

**Files:**
- Modify: `src/zarr/profiles/scalar-grid/controls.tsx`
- Test: `src/__tests__/scalar-grid-instant-controls.test.tsx`

**Interfaces:**
- Consumes: `ProfileControlsProps.playback` (Task 3), `PlaybackSlider` (Task 4).
- Produces: no new exports — the instant bucket's "live" slider becomes a `PlaybackSlider` when `playback` is provided (falls back to `LiveSlider` otherwise).

- [ ] **Step 1: Write the failing test**

Create `src/__tests__/scalar-grid-instant-controls.test.tsx`:
```tsx
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ScalarGridControls } from "../zarr/profiles/scalar-grid/controls";
import type {
  ScalarGridContext,
  ScalarGridState,
} from "../zarr/profiles/scalar-grid/types";

const ctx = {
  variables: [
    {
      name: "t2m",
      group: "",
      longName: null,
      units: null,
      fillValue: null,
      scaleFactor: 1,
      addOffset: 0,
      dims: [{ name: "lead_time", size: 49 }],
      textureDim: { name: "lead_time", window: 49 },
      memoryDims: [],
    },
  ],
  dimLabel: {},
} as unknown as ScalarGridContext;
const state = { variable: "t2m", dimIndices: { lead_time: 3 } } as ScalarGridState;

describe("ScalarGridControls (instant bucket)", () => {
  it("renders a play transport for the live dim when playback is provided", () => {
    const playback = {
      playing: false,
      speed: 1,
      toggle: vi.fn(),
      cycleSpeed: vi.fn(),
      seekTo: vi.fn(),
    };
    render(
      <ScalarGridControls
        ctx={ctx}
        state={state}
        update={vi.fn()}
        group="instant"
        playback={playback}
        chassisState={{} as never}
        chassisUpdate={vi.fn()}
        autoStats={null}
        onFlyTo={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Play" }));
    expect(playback.toggle).toHaveBeenCalledOnce();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm -C /Users/tylere/Documents/GitHub/source-cooperative/zarr-viewer exec vitest run src/__tests__/scalar-grid-instant-controls.test.tsx`
Expected: FAIL — no "Play" button (the live slider is still a plain `LiveSlider`).

- [ ] **Step 3: Modify `controls.tsx`**

3a. Add the import at the top:
```tsx
import { PlaybackSlider } from "../../../components/PlaybackSlider";
```

3b. Destructure `playback` in the component signature:
```tsx
export function ScalarGridControls({
  ctx,
  state,
  update,
  group,
  playback,
}: ProfileControlsProps<ScalarGridContext, ScalarGridState>) {
```

3c. In `sliderFor`, replace the entire `if (mode === "live") { … }` block with:
```tsx
    if (mode === "live") {
      // "(live)" when the whole dim is GPU-resident; "(live · N/win)" when only
      // a window of N frames is loaded at a time (crossing a window refetches).
      const liveLabel =
        texDim && texDim.window < dim.size
          ? `${dim.name} (live · ${texDim.window}/win)`
          : `${dim.name} (live)`;
      // When the chassis provides a playback transport (an animatable dim),
      // render the play/pause + speed controls; else the plain live slider.
      if (playback) {
        return (
          <PlaybackSlider
            key={dim.name}
            label={liveLabel}
            value={value}
            min={0}
            max={Math.max(0, dim.size - 1)}
            playing={playback.playing}
            speed={playback.speed}
            onToggle={playback.toggle}
            onCycleSpeed={playback.cycleSpeed}
            onSeek={playback.seekTo}
            formatValue={format}
            tint={tint}
          />
        );
      }
      return (
        <LiveSlider
          key={dim.name}
          label={liveLabel}
          value={value}
          min={0}
          max={Math.max(0, dim.size - 1)}
          onChange={onChange}
          formatValue={format}
          tint={tint}
        />
      );
    }
```
(Leave `LiveSlider`, the "cached"/"fetch" branch, and everything else unchanged.)

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm -C /Users/tylere/Documents/GitHub/source-cooperative/zarr-viewer exec vitest run src/__tests__/scalar-grid-instant-controls.test.tsx`
Expected: PASS (1 test).

- [ ] **Step 5: Commit**

```bash
git -C /Users/tylere/Documents/GitHub/source-cooperative/zarr-viewer add src/zarr/profiles/scalar-grid/controls.tsx src/__tests__/scalar-grid-instant-controls.test.tsx
git -C /Users/tylere/Documents/GitHub/source-cooperative/zarr-viewer commit -m "feat(playback): render PlaybackSlider for the live dim"
```

---

### Task 6: App wiring — drive playback + effective state

**Files:**
- Modify: `src/App.tsx`

**Interfaces:**
- Consumes: `usePlayback`, `Playable` (Task 2); `getPlayableDim` (Task 3); `ProfileControlsProps.playback` (Task 3).
- Produces: no new exports. This task connects the pieces: computes the playable dim, runs `usePlayback`, and threads an "effective" profile state (with the animated frame) into the layer, the hover sampler, and the profile Controls, plus passes the `playback` object to the instant Controls.

> This is an integration task in a large component; its deliverable is verified by typecheck/build + the existing suite (no new unit test — App is not unit-rendered).

- [ ] **Step 1: Add the import**

Near the other `./state/…` imports (e.g. after `import { useViewerState } from "./state/useViewerState";`):
```tsx
import { usePlayback } from "./state/usePlayback";
```

- [ ] **Step 2: Compute the playable dim, commit callback, playback, and effective state**

Immediately AFTER the `updateProfileState` `useCallback` (it ends `[profile, profileState, updateParams],` then `);`), add:
```tsx
  // ---- Instant-slider playback -------------------------------------------
  // Which dim (if any) can be animated for the current profile/variable.
  const playable = useMemo(
    () =>
      profile?.getPlayableDim && profileCtx && profileState
        ? profile.getPlayableDim(profileCtx, profileState)
        : null,
    [profile, profileCtx, profileState],
  );
  // The current (URL-backed) frame index of that dim — seeds playback.
  const playableIndex =
    playable && profileState ? (profileState.dimIndices[playable.name] ?? 0) : 0;
  // Commit the shown frame to the URL (on pause / seek).
  const commitPlaybackFrame = useCallback(
    (i: number) => {
      if (!playable || !profileState) return;
      updateProfileState({
        dimIndices: { ...profileState.dimIndices, [playable.name]: i },
      });
    },
    [playable, profileState, updateProfileState],
  );
  const playback = usePlayback(playable, playableIndex, commitPlaybackFrame);
  // Profile state with the animated frame substituted while playing. Everything
  // that shows the "current frame" (layer, live slider, hover) reads this.
  const effectiveProfileState = useMemo(() => {
    if (!profileState || !playback.playing || !playable) return profileState;
    return {
      ...profileState,
      dimIndices: {
        ...profileState.dimIndices,
        [playable.name]: playback.index,
      },
    };
  }, [profileState, playback.playing, playback.index, playable]);
```

- [ ] **Step 3: Feed the animated frame into the map layer**

In the `layer` `useMemo` (`profile.buildLayer({ … })`), change `state: profileState,` to:
```tsx
      state: effectiveProfileState ?? profileState,
```
and in that memo's dependency array, replace `profileState,` with `effectiveProfileState,`.

- [ ] **Step 4: Feed the animated frame into the hover readout**

In the pointer-sample callback, change the `profile.sampleValue(profileCtx, profileState, pt.lng, pt.lat)` call to use `effectiveProfileState`:
```tsx
      const res = profile.sampleValue(
        profileCtx,
        effectiveProfileState ?? profileState,
        pt.lng,
        pt.lat,
      );
```
and add `effectiveProfileState` to that `useCallback`'s dependency array (the one currently ending `[profile, profileCtx, profileState],`).

- [ ] **Step 5: Pass effective state + playback into the profile Controls**

In the `<ControlsPanel … />` render, each of the three `profile.Controls({ … })` calls currently passes `state: profileState,`. Change all three to `state: effectiveProfileState ?? profileState,`. On the **instant** call only, also add `playback,`:
```tsx
          profileInstantSlot={profile.Controls({
            ctx: profileCtx,
            state: effectiveProfileState ?? profileState,
            update: updateProfileState,
            chassisState: state,
            chassisUpdate: update,
            autoStats,
            onFlyTo: handleFlyTo,
            group: "instant",
            playback,
          })}
```
(Leave the `fetch` and `styling` calls without `playback`; just swap their `state`.)

- [ ] **Step 6: Typecheck, build, and run the full suite**

Run: `pnpm -C /Users/tylere/Documents/GitHub/source-cooperative/zarr-viewer build`
Expected: exit 0 (tsc + vite build clean).

Run: `pnpm -C /Users/tylere/Documents/GitHub/source-cooperative/zarr-viewer exec vitest run`
Expected: all tests pass (existing suite + the 4 new test files).

- [ ] **Step 7: Commit**

```bash
git -C /Users/tylere/Documents/GitHub/source-cooperative/zarr-viewer add src/App.tsx
git -C /Users/tylere/Documents/GitHub/source-cooperative/zarr-viewer commit -m "feat(playback): wire playback + effective frame into App"
```

---

### Task 7: Manual end-to-end verification

**Files:** none (verification only).

- [ ] **Step 1: Start the dev server**

Run: `pnpm -C /Users/tylere/Documents/GitHub/source-cooperative/zarr-viewer dev`

- [ ] **Step 2: Verify against a store with a live dim**

Open the app; load the **ECMWF IFS ENS — 2 m Temperature** example (its `lead_time` is the live dim; the **NOAA HRRR** forecast also works). In the "Data · instant" group:
- A ▶ play button + a `1×` speed chip appear above the `lead_time (live)` slider.
- Press play → the temperature field animates forward and **loops** at the last lead time; the slider handle and the value badge (e.g. `t+12h`) advance with it.
- Click the speed chip → cycles `1× → 2× → 4× → 0.5× → 1×`; the animation rate changes accordingly.
- The **URL does not flicker** per frame while playing.
- Drag or step the slider → playback **pauses**, and the URL's `dim.lead_time` updates to the shown frame.
- Switch the **variable** (or load a different store) → playback stops; a store with no live dim (e.g. a single-time variable) shows **no** transport.

- [ ] **Step 3: Confirm the spec's acceptance criteria are met, then stop the dev server.**

---

## Self-Review

**Spec coverage:**
- Play/pause + speed transport on the live slider → Tasks 4, 5, 6. ✓
- Live texture-array dim only → `getPlayableDim` (Task 3) + controls gate (Task 5). ✓
- Loop at end → `nextFrame` (Task 1), timer (Task 2). ✓
- Speeds 0.5/1/2/4, default 1×, tap-to-cycle → `SPEEDS`/`nextSpeed` (Task 1), chip (Task 4). ✓
- App-owned state, no per-frame URL writes; commit on pause/seek → Task 2 (`onCommit`) + Task 6 (`commitPlaybackFrame`, `effectiveProfileState`). ✓
- Layer + slider + hover all reflect the animated frame → Task 6 steps 3–5. ✓
- `size ≤ 1` / no texture dim → no transport → Task 3. ✓
- Variable/store switch stops playback → Task 2 (`key` effect). ✓
- Speed/playing session-local (not URL) → Task 2 (local state; nothing serialized). ✓
- Testing (unit helpers, hook, component, wiring build) → Tasks 1–6; manual e2e → Task 7. ✓

**Placeholder scan:** none — every step has concrete code/commands.

**Type consistency:** `Playable = {name,size}` and `Playback` (Task 2) match `usePlayback`'s use in Task 6; `getPlayableDim` return `{name,size}` (Task 3) matches `Playable`; `ProfileControlsProps.playback` shape (Task 3) matches the object passed in Task 6 and consumed in Task 5. `seekTo`/`toggle`/`cycleSpeed` names consistent across Tasks 2, 4, 5, 6.
