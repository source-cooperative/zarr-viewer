# Instant-slider playback (play / pause / speed)

## Context

The "Data · instant" control group renders one smooth **"live" slider** — the
texture-array dimension (`textureDim`) of the active variable (e.g. a forecast
`lead_time`, `step`, or vertical `level`). It scrubs as a GPU shader uniform, so
frame-to-frame changes are instant (no fetch) as long as they stay within the
preloaded window. Today the user must drag it by hand.

This feature adds a **podcast-style transport** to that live slider: a play/pause
button and a tap-to-cycle speed chip, so the viewer can watch the data animate
forward (e.g. a forecast evolving over its lead times) without manual scrubbing.

Scope is deliberately narrow (YAGNI): the **live texture-array slider only**;
cached memory-dim sliders and the fetch-bucket sliders are unchanged.

## Decisions (from brainstorming)

- **What animates:** the single "live" texture-array slider only.
- **End behavior:** loop (`… → last → first → …`) until paused.
- **Speed presets:** `0.5× 1× 2× 4×`, default `1×`, where `1× ≈ 4 fps`
  (frame interval `= 1000 / (4 × speed)` ms → 500 / 250 / 125 / 62.5 ms).
- **Speed control:** a compact chip that cycles the presets on tap (podcast style).
- **Persistence:** playback is session-local — neither the playing flag nor the
  speed is written to the URL; a shared link never auto-plays.

## Key constraint & chosen approach

The live slider's frame index is stored in the **URL** (`?dim.<name>=N`,
`ScalarGridState.dimIndices`); each change re-serializes profile state and calls
`history.replaceState`. Driving that at 4–16 fps would flicker the address bar
and re-serialize every frame.

**Chosen — App-owned playback state (no URL writes per frame).** The frame index
during playback lives in React state in `App`. A timer advances it; the map
layer, the live slider, and the hover readout all read this **effective index**.
Only on **pause or a manual scrub/step** is the index committed back to the URL,
so shared links / reloads land on the frame shown when playback stopped.

*Rejected:* writing every frame to the URL (address-bar flicker, per-frame
serialization).

## Components & data flow

### 1. Profile contract — `getPlayableDim`
Add an optional method to `ZarrProfile` (`src/zarr/profile.ts`):
```ts
getPlayableDim?: (ctx: Ctx, state: S) => { name: string; size: number } | null;
```
- `scalar-grid` (`src/zarr/profiles/scalar-grid/profile.ts`) returns the active
  variable's `textureDim` as `{ name, size }` when `size > 1`, else `null`.
- `projected-grid` inherits it (it spreads `scalarGridProfile`).
- All other profiles leave it undefined (→ no transport).

This keeps `App` profile-agnostic: it asks the active profile "what, if anything,
can be played, and how many frames?"

### 2. Playback state — `usePlayback` hook (App-level)
New `src/state/usePlayback.ts` (sits with `useViewerState.ts`; there is no shared
`hooks/` dir):
```ts
usePlayback(playable: { name: string; size: number } | null): {
  playing: boolean;
  speed: number;              // one of SPEEDS
  index: number;              // current animated frame (0..size-1)
  toggle: () => void;         // play/pause
  cycleSpeed: () => void;     // tap to advance preset
  seekTo: (index: number) => void;  // manual scrub → pauses + sets index
}
```
- `SPEEDS = [0.5, 1, 2, 4]`, `BASE_FPS = 4`.
- While `playing`, a `setInterval(… , 1000 / (BASE_FPS * speed))` advances
  `index` with `nextFrame(index, size)` (pure helper: `(index + 1) % size`).
  The interval is recreated when `speed` or `playing` changes and cleared on
  unmount.
- When `playable` becomes `null` or its `name`/`size` changes (variable or store
  switch), playback **stops** and `index` resets to the current dim index.
- `index` seeds from the current URL dim index when playback starts (so play
  continues from where the slider is).

### 3. Effective profile state (App)
`App` computes, via `useMemo`:
```ts
effectiveProfileState = playing && playable
  ? { ...profileState, dimIndices: { ...profileState.dimIndices, [playable.name]: index } }
  : profileState;
```
`effectiveProfileState` replaces `profileState` where the *current frame* matters:
- `profile.buildLayer({ … state: effectiveProfileState … })` → the layer's
  `frameIndex` uniform tracks playback (instant within a window; a window-boundary
  crossing re-uploads from the CPU cache — cheap, no network).
- `profile.Controls({ … state: effectiveProfileState … })` → the live slider
  position follows playback.
- the hover sampler (`profile.sampleValue`) uses `effectiveProfileState` so the
  readout matches the displayed frame.

`profileState` (URL-derived) is unchanged during playback; **on pause / seek**,
`usePlayback` calls the existing `updateProfileState({ dimIndices })` to commit
the shown index to the URL.

### 4. UI — `PlaybackSlider`
A new component (`src/components/PlaybackSlider.tsx`) that replaces the plain
`LiveSlider` for the texture dim inside `ScalarGridControls` ("instant" bucket):
```
lead_time (live)                     t+12h
[▶]  1×    ◀ ─────────●─────────── ▶
```
- **Play/pause button** → `toggle()`.
- **Speed chip** (shows e.g. `1×`) → `cycleSpeed()` on click.
- Reuses the existing **`StepperRange`** as the scrubber (keeps its ±1 step
  buttons). `onChange`/step → `seekTo(v)` (pauses + commits).
- Keeps the existing value badge (the `dimLabel` formatter, e.g. `t+12h`).

`ScalarGridControls` decides `PlaybackSlider` vs `LiveSlider`: use `PlaybackSlider`
only for the `textureDim` slider; the `memoryDims` "cached" sliders are untouched.
The playback props (`playing`, `speed`, `toggle`, `cycleSpeed`, current index)
reach the controls via a new optional `playback` field on `ProfileControlsProps`,
populated by `App`.

### 5. App wiring summary
- `const playable = profile?.getPlayableDim?.(profileCtx, profileState) ?? null;`
- `const playback = usePlayback(playable);`
- Build `effectiveProfileState` (§3); pass it to `buildLayer`, the three
  `Controls` bucket calls, and the hover sampler.
- Pass a `playback` object into `Controls` (for the instant bucket to render the
  transport).

## Edge cases
- **`size ≤ 1`** → `getPlayableDim` returns `null` → no transport, slider as today.
- **Window < size** (dim too large to fully preload) → boundary crossings during
  playback re-upload a window from the CPU cache. First pass over a not-yet-cached
  window may briefly stutter; acceptable for v1 (note: a "wait for load" gate is a
  possible future refinement).
- **Variable / store switch** → playback stops (§2).
- **Play then navigate the fetch/other sliders** → those still commit to the URL
  normally; playback keeps running on its own dim, driven by `index`.

## Testing / verification
- **Unit** (`vitest`): pure helpers — `nextFrame(index, size)` loop wrap;
  `frameIntervalMs(speed)` = `1000/(4·speed)`; `cycleSpeed` preset advance/wrap.
- **Component**: render `PlaybackSlider`; assert the play button toggles a
  `playing` state and the speed chip cycles `0.5→1→2→4→0.5` and shows the label.
- **Manual browser**: load an example with a live dim (ECMWF IFS ENS `lead_time`,
  or the HRRR forecast `lead_time`); press play → the field animates and loops;
  the speed chip changes the rate; dragging the slider pauses; the URL updates
  only on pause (no per-frame flicker); switching variable stops playback.
- **Suite/build**: `pnpm -C … exec vitest run` and `pnpm -C … build` green.

## Out of scope (possible future work)
- Ping-pong / reverse playback; a "wait for tiles" gate across window boundaries;
  persisting speed in the URL; animating cached memory-dim or fetch-bucket sliders.
