# Intro zoom: animate from the world view to the dataset extent

**Issue:** [#42 — Have the map zoom in upon initialization (optional)](https://github.com/source-cooperative/zarr-viewer/issues/42)
**Date:** 2026-07-19
**Status:** Approved design

## Summary

An **optional** intro animation that, on first load, flies the map from the
world view in to the dataset's geographic extent. Controlled by a URL
parameter, **off by default**. Purely cosmetic — it changes only the opening
camera animation, not what renders.

## Behavior

- **`?intro=<seconds>`** enables it:
  - `?intro=1` → on, with a **default duration** (`DEFAULT_INTRO_SECONDS`, 2.5s).
    `1` is the "on" token, matching the app's `=1` boolean-param convention.
  - `?intro=<n>` for any positive number other than `1` → on, `n` seconds
    (clamped to `[0.3, 20]`).
  - Absent / non-positive / non-numeric → off.
- On enable, and only when there is **no `?lng/lat/zoom` view in the URL** (an
  explicit shared camera always wins), the map starts at its default world
  view and animates to the dataset target.
- The target per profile:
  - Extent profiles (scalar-grid geographic, projected-grid, multiscale-grid):
    the data's lng/lat bounding box → `fitBounds`.
  - band-composite: its existing `initialView` location preset (`LOCATIONS[0]`)
    → `flyTo`. No preset → no-op.
  - Anything with no computable target → graceful no-op.
- Runs **once per store load** (a variable switch does not replay it).
- Programmatic camera moves never write the URL (existing behavior,
  `App.onMoveEnd` skips `e.originalEvent == null`), so the animation is
  URL-safe and does not spam `view`.

## Non-goals

- No UI control — URL-only, per the issue.
- No change to default (intro-off) load behavior.
- image-orthographic (OME-Zarr, non-map `OrthographicView`) is out of scope —
  it already fits the image on load.

## Design

### 1. State & URL

`src/state/types.ts` — add to `ViewerState`:

```ts
/** Intro fly-in duration in seconds, or `null` when disabled. When set (and
 *  no explicit `view` is present), the map animates from the world view to the
 *  dataset extent on first load. URL: `?intro=<seconds>` (`?intro=1` = on at
 *  the default duration). Display-only. */
intro: number | null;
```

`src/state/useViewerState.ts`:

- A dedicated parser (mirroring `parseMinZoomOverride`):

```ts
const DEFAULT_INTRO_SECONDS = 2.5;
const parseIntro = (raw: string | null): number | null => {
  if (raw === null || raw === "") return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return null;
  if (n === 1) return DEFAULT_INTRO_SECONDS; // "1" = on, default duration
  return Math.min(20, Math.max(0.3, n));
};
```

- Wire into `parseViewerState`: `intro: parseIntro(p.get("intro"))`.
- Serialize in `applyChassisPatch` (uniform with other params; never patched by
  the UI in practice, so a user's `?intro=…` persists untouched):

```ts
if (patch.intro !== undefined) {
  if (patch.intro === null) p.delete("intro");
  else p.set("intro", String(patch.intro));
}
```

### 2. Pure extent helpers

New `src/zarr/data-bounds.ts` — extent math as exported pure functions (the
codebase convention, like `deriveMinZoom`). All return
`[west, south, east, north]` in lng/lat, or `null`.

```ts
export type LngLatBounds = [number, number, number, number];

/** GeoZarr affine `[stepX,0,originX,0,stepY,originY]` + shape `[height,width]`
 *  already in DEGREES → lng/lat bbox (scalar-grid geographic). */
export function geographicBounds(
  transform: readonly number[],
  shape: readonly number[],
): LngLatBounds | null;

/** Same affine but in EPSG:3857 METRES → lng/lat bbox via the closed-form
 *  mercator inverse (multiscale-grid). */
export function mercatorBounds(
  transform: readonly number[],
  shape: readonly number[],
): LngLatBounds | null;

/** Affine in a projected CRS (metres) + its WKT2 → lng/lat bbox, reprojecting
 *  the (densified) footprint via `@developmentseed/proj` (`parseWkt`) + proj4
 *  + `transformBounds`. Returns null on any parse/transform failure. */
export function projectedBounds(
  transform: readonly number[],
  shape: readonly number[],
  wkt2: string,
): LngLatBounds | null;
```

Corner derivation shared by all three: from `transform` `[sx,0,ox,0,sy,oy]` and
`shape` `[height,width]`, the four source-CRS corners are `ox … ox+sx*width`
(x) and `oy … oy+sy*height` (y); `sy` is typically negative (north-first), so
normalize to min/max before use. `geographicBounds` uses them directly;
`mercatorBounds` inverts each via `lng = x/R·180/π`, `lat =
(2·atan(exp(y/R)) − π/2)·180/π` (`R = 6378137`); `projectedBounds` feeds the
min/max corners to `transformBounds(project, left, bottom, right, top,
{ densifyPts })` where `project(x,y) = proj4(parseWkt(wkt2), "EPSG:4326",
[x,y])`, so curved projected edges (LCC) are captured, not just the 4 corners.

### 3. Profile hook `dataBounds`

`src/zarr/profile.ts` — add to `ZarrProfile`:

```ts
/** The dataset's geographic extent as `[west,south,east,north]` (lng/lat), or
 *  null when it has no map extent (global composites, image profile). Used by
 *  the optional intro fly-in (issue #42). Distinct from `initialBounds` (which
 *  is the default opening camera and stays world-sized). */
dataBounds?: (ctx: any, state: any) => LngLatBounds | null;
```

Implementations:

- **scalar-grid** (`scalar-grid/profile.ts`): read `ctx.spatialAttrs`
  (`spatial:transform` degrees, `spatial:shape`) → `geographicBounds`. Guard on
  `proj:code === "EPSG:4326"` (only the geographic case; projected overrides).
- **projected-grid** (`projected-grid/profile.ts`): **override** — read
  `ctx.spatialAttrs` (`spatial:transform` metres, `spatial:shape`, `proj:wkt2`)
  → `projectedBounds`.
- **multiscale-grid** (`multiscale-grid/profile.ts`): read a layout entry's
  EPSG:3857 `spatial:transform`/`spatial:shape` → `mercatorBounds`.
- **band-composite / image-orthographic**: none (undefined). band-composite's
  intro target comes from its existing `initialView` instead (see §4).

### 4. App intro effect

`src/App.tsx` — a new effect, and a guard on the two existing initial-camera
effects.

New effect (runs once per store load via a ref keyed on `state.url`):

```ts
const introRanForUrl = useRef<string | null>(null);
useEffect(() => {
  if (state.intro == null || state.view) return;       // opt-in; URL view wins
  if (!profile || !profileCtx || !profileState) return; // store ready
  if (introRanForUrl.current === state.url) return;      // once per store
  const map = mapRef.current;
  if (!map) return;
  const durationMs = state.intro * 1000;
  const bounds = profile.dataBounds?.(profileCtx, profileState) ?? null;
  if (bounds) {
    introRanForUrl.current = state.url;
    setIsAnimatingView(true);
    map.fitBounds([[bounds[0], bounds[1]], [bounds[2], bounds[3]]], {
      padding: 40,
      duration: durationMs,
    });
    return;
  }
  const view = profile.initialView?.(profileCtx, profileState) ?? null;
  if (view) {
    introRanForUrl.current = state.url;
    setIsAnimatingView(true);
    map.flyTo({
      center: [view.longitude, view.latitude],
      zoom: view.zoom,
      duration: durationMs,
    });
  }
}, [state.intro, state.view, state.url, profile, profileCtx, profileState]);
```

Guard the existing `initialBounds` fitBounds effect and `initialView` flyTo
effect: add `if (state.intro != null && !state.view) return;` at the top of
each, so the intro effect solely owns the opening camera when it's active.

`setIsAnimatingView(true)` reuses the existing tile-load-suppression gate;
`App.onMoveEnd` already clears it on the programmatic `moveend`.

## Testing

- `src/__tests__/data-bounds.test.ts` (new): `geographicBounds` (degrees,
  descending-lat sign), `mercatorBounds` (a known 3857 box → lng/lat, e.g. the
  web-mercator world edges ≈ ±85.051°), and `projectedBounds` on a real LCC
  (HRRR-style) WKT2 + CONUS metre extent → a plausible CONUS lng/lat bbox
  (assert ranges, and that densification widens beyond the naive 4-corner
  bbox). `null`-return cases (bad transform/shape, unparseable WKT2).
- `src/__tests__/state.test.ts`: `intro` parse — `intro=1` → 2.5; `intro=4` →
  4; `intro=0`/`intro=abc`/absent → null; clamping (`intro=99` → 20).
- The fly-in animation and the App effect wiring have no headless map/GL
  harness, so they're covered by `tsc` + a manual browser smoke check:
  `?intro=1` on a regional lat/lon store, on the HRRR projected store, on a
  multiscale store, and on the AEF band-composite store (flies to its location
  preset); confirm each animates world→target once, `?intro` with an explicit
  `?lng/lat/zoom` does nothing, and no `intro`/no target is a clean no-op.
