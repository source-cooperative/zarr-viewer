# Mask tiles outside the rescale range

**Issue:** [#54 — Add ability to mask tiles based on data value](https://github.com/source-cooperative/zarr-viewer/issues/54)
**Date:** 2026-07-18
**Status:** Approved design

> **Amendment (2026-07-18):** the single "mask outside range" toggle was split
> into **two independent controls** — *mask below* and *mask above* the window —
> per follow-up feedback. The single boolean `maskOutsideRescale` became two
> booleans `maskBelow` / `maskAbove` (chassis `ViewerState` and image-profile
> state); the URL key `mask` became `mask_below` / `mask_above`; and the one
> GPU shader module is reused for both by passing a sentinel bound
> (`MASK_NO_LOWER` / `MASK_NO_UPPER`) for whichever side is disabled. Ticking
> both reproduces the original "outside" behavior described below. Everything
> else in this doc still holds; read `maskOutsideRescale` as "either flag".

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

The GPU paths (scalar-grid, multiscale-grid, texture-array) use the
**chassis** rescale (`ViewerState.rescale`), so their mask flag is a chassis
field. The image-orthographic profile keeps its **own** profile-local rescale
(`ImageOrthographicState.rescale`, URL params `rmin`/`rmax`), so its mask flag
is a profile-local field (see §5). Both use the URL key `mask` — the same
deliberate key-sharing the image profile already uses for `colormap`/`gamma`,
and safe because only one profile is active and each path only writes the key
from its own UI.

`src/state/types.ts` — add to `ViewerState`:

```ts
/** When true, discard (make transparent) pixels whose value is outside the
 *  resolved rescale window instead of clamping them. Display-only. Applies to
 *  the GPU (map) render paths; the image profile has its own flag. */
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

### 5. CPU image path (profile-local)

The image path uses its own profile-local rescale, so the flag lives on the
profile state, not the chassis.

`src/zarr/profiles/image-orthographic/types.ts` — add
`maskOutsideRescale: boolean` to `ImageOrthographicState`.

`src/zarr/profiles/image-orthographic/profile.ts`:

- `initialState`: `maskOutsideRescale: false`.
- `parseUrlParams`: `if (p.get("mask") === "1") out.maskOutsideRescale = true;`
- `serializeUrlParams`: `mask: s.maskOutsideRescale ? "1" : null`.

`src/components/image-normalize.ts` — `styleToRgba` currently writes
`rgba[o+3] = 255` unconditionally. Add a trailing `maskOutside = false`
parameter; when true and the pre-clamp normalized value `t` is outside
`[0, 1]` (i.e. `t < 0 || t > 1`), write `rgba[o+3] = 0` instead. Preserve
current behavior when the flag is false. Detect out-of-range from `t` **before**
the existing `t = t <= 0 ? 0 : t >= 1 ? 1 : t;` clamp.

`src/components/ImageViewer.tsx` — read `state.maskOutsideRescale` (profile
state), add it to the `useMemo` deps, and pass it as the trailing arg to
`styleToRgba` (call site `:310`).

### 6. UI

Add a checkbox **"Mask values outside range"** to the Styling `ControlGroup`
in `src/components/ControlsPanel.tsx`, directly below `RescaleEditor`
(~`:144`), rendered under the same `showSingleBandControls` gate. It writes
`update({ maskOutsideRescale: next })`.

For the CPU image profile, add the equivalent checkbox to the `"styling"`
group in `src/zarr/profiles/image-orthographic/controls.tsx`, below its
`RescaleControl`, writing `update({ maskOutsideRescale: next })` (profile
`update`).

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
- **Chassis URL parse** (`parseViewerState`): `mask=1` → `true`; absent → `false`;
  `mask=0` → `false`. (Matches `state.test.ts`, which tests parsing only — the
  serializer `applyChassisPatch` is module-private.)
- **Image profile URL round-trip** (`imageOrthographicProfile`):
  `parseUrlParams("mask=1").maskOutsideRescale === true`; absent → `undefined`;
  `serializeUrlParams({..., maskOutsideRescale: true}).mask === "1"`; `false` →
  `null`.

UI wiring (the two checkboxes, `ImageViewer` threading, profile `updateTriggers`)
is verified by `tsc -b` (build) plus a manual browser smoke check, mirroring the
codebase's lack of a lightweight render harness for `ControlsPanel` / `buildLayer`.

## Non-goals

- No change to how the rescale window is chosen or edited.
- No new mask *modes* (e.g. mask-inside, custom thresholds independent of
  rescale) — a single boolean tied to the rescale window only. Can be
  revisited if needed.
- No band-composite support.
