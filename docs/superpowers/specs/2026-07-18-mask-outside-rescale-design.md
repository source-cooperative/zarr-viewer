# Mask tiles outside the rescale range

**Issue:** [#54 — Add ability to mask tiles based on data value](https://github.com/source-cooperative/zarr-viewer/issues/54)
**Date:** 2026-07-18
**Status:** Approved design

## Summary

Add an optional mode that makes pixels whose data value falls **outside** the
active rescale window fully transparent, instead of clamping them to the
colormap's end colors (the current behavior). The feature is a boolean toggle,
**off by default**, so existing shared URLs render identically.

## Motivation

Today the rescale step clamps out-of-range values:

```glsl
// src/render/shader-modules.ts — PerBandLinearRescale
color.rgb = clamp((color.rgb - rescaleMin) / max(rescaleMax - rescaleMin, 1e-9), 0.0, 1.0);
```

Values below `rescaleMin` paint the colormap's low color and values above
`rescaleMax` paint the high color, so out-of-range areas are indistinguishable
from legitimately extreme in-range areas. Masking lets the user restrict the
display to a value band and let the basemap show through everywhere else.

## Behavior

- **Toggle:** a boolean, surfaced in the UI and in the URL. Off by default.
- **When on:** a pixel is discarded (rendered fully transparent, basemap shows
  through) when its data value `v` satisfies `v < lo || v > hi`, where
  `[lo, hi]` is the **resolved rescale window** (see below). Boundaries are
  inclusive — `lo <= v <= hi` is kept.
- **When off:** unchanged — out-of-range values clamp as they do today.

### Resolved window (bounds source)

The mask reuses the **exact same window the rescale step uses**, via the
existing `resolveRescale` logic
(`src/render/single-band-pipeline.ts:92-100`):

1. If the user has set an explicit `rescale` tuple, use it.
2. Otherwise fall back to the auto 2–98% percentile window from `AutoStats`.
3. If neither is available (no stats yet), there is no window — the mask
   emits nothing (nothing is masked), matching the rescale step's own guard.

This keeps mask and rescale bounds perfectly consistent: the visible band is
always exactly the colormapped band.

## Scope

In scope (all paths that use a single-value rescale window):

- **GPU single-band — scalar-grid** (`src/zarr/profiles/scalar-grid`)
- **GPU single-band — multiscale-grid** (`src/zarr/profiles/multiscale-grid`)
- **GPU texture-array** (scrubbable frames, `src/render/texture-array-pipeline.ts`)
- **CPU image path** — image-orthographic / OME-Zarr
  (`src/components/ImageViewer.tsx`, `src/components/image-normalize.ts`)

Out of scope:

- **band-composite** — an RGB composite with a separate per-band
  `rescaleMin`/`rescaleMax`. "Outside the rescale range" has no single-value
  meaning for a three-channel composite, so it is intentionally excluded.

## Design

Approach: a dedicated discard-based shader module inserted **before** the
rescale module, mirroring the codebase's existing masking idiom
(`FilterNaN`, `FilterNoDataVal`). Masking must happen before rescale because
rescale clamps — after it, the out-of-range information is already lost.

### 1. State & URL

`src/state/types.ts` — add to `ViewerState`:

```ts
/** When true, discard (make transparent) pixels whose value is outside the
 *  resolved rescale window instead of clamping them. Display-only. */
maskOutsideRescale: boolean;
```

`ViewerStateUpdate` already covers it via `Partial<ViewerState>`.

`src/state/useViewerState.ts` — parse/serialize mirroring `stretch`/`opacity`:

- Parse: read URL param `mask`; `mask=1` → `true`, absent/anything else →
  `false`.
- Serialize: when `true`, `p.set("mask", "1")`; when `false`, delete the param
  (keeps default-off URLs clean).
- Default in the initial state read: `false`.

### 2. GPU shader module

`src/render/shader-modules.ts` — new module:

```glsl
// MaskOutsideRange
uniform float maskMin;
uniform float maskMax;
// in DECKGL_FILTER_COLOR:
if (color.r < maskMin || color.r > maskMax) discard;
```

Follow the existing `RasterModule` shape used by `PerBandLinearRescale` /
`FilterNaN` in that file (same uniform-plumbing / hook conventions).

### 3. GPU pipeline wiring

Both builders resolve the window, then — when
`state.maskOutsideRescale && window != null` — push the mask module
**immediately before** the rescale module, feeding the same scaled bounds:

- `src/render/single-band-pipeline.ts` — insert before the
  `PerBandLinearRescale` push (~`:145-163`). Bounds:
  `maskMin = lo / data.sampleScale`, `maskMax = hi / data.sampleScale`
  (identical scaling to rescale).
- `src/render/texture-array-pipeline.ts` — insert before the `LinearRescale`
  push (~`:410-415`), same resolved window.

Add `maskOutsideRescale` to the render-state types:

- `SingleBandRenderState` (`single-band-pipeline.ts:47-56`)
- `TextureArrayRenderState` (`texture-array-pipeline.ts:362-369`)

### 4. Profile wiring

Thread `chassisState.maskOutsideRescale` into the render state built by each
profile, and add `maskOutsideRescale` to the `updateTriggers` arrays so
toggling forces a re-render:

- `src/zarr/profiles/scalar-grid/profile.ts` (single-band + texture-array
  build sites and their `updateTriggers`)
- `src/zarr/profiles/multiscale-grid/profile.ts` (same)

### 5. CPU image path

`src/components/image-normalize.ts` — `styleToRgba` currently writes
`rgba[o+3] = 255` unconditionally. Add a `maskOutside` parameter; when true and
the normalized value `t` is outside `[0, 1]` (i.e. outside the window before
clamping), write `rgba[o+3] = 0` instead. Preserve current behavior when the
flag is false.

`src/components/ImageViewer.tsx` — read `state.maskOutsideRescale` and pass it
into `styleToRgba` (alongside the existing `resolveRescale` usage at
`:305-309`).

### 6. UI

Add a checkbox **"Mask values outside range"** to the Styling `ControlGroup`
in `src/components/ControlsPanel.tsx`, directly below `RescaleEditor`
(~`:144`), rendered under the same `showSingleBandControls` gate. It writes
`update({ maskOutsideRescale: next })`.

For the CPU image profile, add the equivalent checkbox to
`src/zarr/profiles/image-orthographic/controls.tsx` near its rescale slider
(~`:138-179`).

## Testing

- **GPU pipeline builders** (`single-band-pipeline`, `texture-array-pipeline`):
  assert the `MaskOutsideRange` module is present/absent and carries the
  correct `maskMin`/`maskMax` (scaled by `sampleScale`) across cases:
  1. mask off → module absent
  2. mask on + explicit rescale → module present, bounds = explicit window
  3. mask on + no explicit rescale but stats present → bounds = auto percentile
  4. mask on + no stats/window → module absent (nothing masked)
- **CPU** (`styleToRgba`): alpha is `0` for out-of-range samples and `255` for
  in-range samples when `maskOutside` is true; always `255` when false.
- **URL round-trip** (`useViewerState`): `mask=1` ⇄ `maskOutsideRescale: true`;
  absent param → `false`; serializing `false` removes the param.

## Non-goals

- No change to how the rescale window is chosen or edited.
- No new mask *modes* (e.g. mask-inside, custom thresholds independent of
  rescale) — a single boolean tied to the rescale window only. Can be
  revisited if needed.
- No band-composite support.
