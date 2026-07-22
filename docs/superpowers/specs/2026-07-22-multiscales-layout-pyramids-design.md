# Support GeoZarr `multiscales.layout` pyramids in `multiscale-grid`

**Issue:** [#68](https://github.com/source-cooperative/zarr-viewer/issues/68)
**Date:** 2026-07-22
**Status:** Approved (design)

## Problem

Multiscale pyramids declared with the **`zarr-conventions/multiscales` v1** schema —
`multiscales: { layout: [{ asset, "spatial:transform", "spatial:shape" }] }` — are not
recognized by the viewer's profile router. They fall through to the default
`scalar-grid` profile, which enumerates each pyramid *level* as a separate "variable"
and then feeds deck.gl-zarr an inconsistent input (a single pre-opened array + multi-level
metadata). The basemap renders but no data tiles appear; the console shows
`NotFoundError: Not found: v2 array` from `ZarrLayer._parseZarr`.

Reproduction: `?url=https://r2-pub.openscicomp.io/ndvi-cdr-pyramid-v2` (from #62). Icechunk
detection (fixed in #67) now works, but rendering does not.

### Root cause

The viewer's pyramid detector [`parseMultiscaleDatasets`](../../../src/zarr/multiscale.ts)
only recognizes the **legacy CF/rioxarray** schema, where `multiscales` is an *array* of
`{ datasets: [{ path }] }`. This store's `multiscales` is an *object* `{ layout: [...] }`,
so the detector returns `null`, `scalar-grid.prepare` never throws `MultiscaleStoreError`,
and the app never switches to `multiscale-grid`.

Meanwhile deck.gl-zarr's own `parseGeoZarrMetadata` *does* understand `layout`, so once
scalar-grid hands it the store metadata it finds 4 levels and tries to re-open each via
`group.resolve(asset)` against a single array node → the v2 error.

### Verified store facts (`ndvi-cdr-pyramid-v2`)

- Root group `multiscales.layout` is **finest-first**: `asset` `"0"`(3600×7200) … `"3"`(450×900).
- `asset` values (`"0"…"3"`) are **level *groups***; the data array lives *inside* each
  (`/0/NDVI`). Each level group also holds `latitude`, `longitude`, `time`, `spatial_ref`.
- `/0/spatial_ref` attrs are **empty `{}`** — no GDAL `GeoTransform`, no `crs_wkt`.
  Georeferencing lives entirely in `layout[].spatial:transform`/`spatial:shape` + root
  `proj:code: EPSG:4326` and `spatial:dimensions: ["latitude","longitude"]`.
- `NDVI` is **3-D** `[time=5, latitude=3600, longitude=7200]`, chunks `[1, 240, 249]` —
  the `time` axis has chunk size 1, so it is a *genuinely-pinned* (fetch-on-scrub) dim,
  not a texture-array/memory dim.
- `time` is CF-encoded (`days since 1981-01-01`, gregorian), 5 steps.

## Non-goals (YAGNI)

- No playback/animation transport for the time dim (plain slider only).
- No texture-array free-scrub pipeline (time chunk size is 1 → refetch on scrub is correct).
- The existing CF/Meta-CHM code path keeps its exact current behavior.

## Approach

Extend the **`multiscale-grid`** profile to handle a second store shape (native GeoZarr
`{layout}` pyramid, georeferenced by the layout + root `proj:code`/`proj:wkt2`, with an
optional non-spatial dimension), and generalize it from single-variable to multi-variable
with a variable picker. Chosen over a new profile / extending scalar-grid because pyramids
conceptually belong in `multiscale-grid` and it already owns the deck.gl-zarr multiscale wiring.

## Components

### 1. Detection & routing — `src/zarr/multiscale.ts`

- Add a parser for the `{layout}` object schema that returns level asset paths in
  **coarsest→finest** order (store layout is finest-first → reverse), to match the order the
  existing `datasets` parser and `multiscale-grid.prepare` expect.
- Keep `parseMultiscaleDatasets` handling the legacy `[{datasets}]` array schema. A small
  dispatcher (`parseMultiscaleLayout` / unified entry) tries the layout object first, then
  the datasets array; returns `null` when neither matches.
- `scalar-grid.prepare` already throws `MultiscaleStoreError` on a hit
  (`src/zarr/profiles/scalar-grid/profile.ts:576`), auto-switching to `multiscale-grid`.
  Verify the OME-Zarr guard just above does **not** mis-catch a `{layout}` object (OME uses an
  *array* `multiscales` with `axes` — structurally distinct).

### 2. Two-path metadata build — `multiscale-grid/profile.ts` `prepare`

- Branch on which schema matched.
  - **CF path (existing):** unchanged — `spatial_ref` GeoTransform + `crs_wkt` →
    `buildGeoZarrMetadata`.
  - **Layout path (new):** read the store's `multiscales.layout` directly. Per level group,
    use the enumerated data-variable name; emit metadata with `asset = "<levelGroup>/<var>"`
    carrying each level's native `spatial:transform`/`spatial:shape`. CRS from root
    `proj:code` (e.g. `EPSG:4326`) or `proj:wkt2`.
- **CRS emit:** `buildGeoZarrMetadata` currently emits only `proj:wkt2`; add a `proj:code`
  variant. Verify against the installed `@developmentseed/geozarr` that `parseGeoZarrMetadata`
  maps `proj:code` → `crs.code` and deck.gl-zarr's `parseCrs` resolves it via `epsgResolver`.
- **Relax 2-D-only** (`profile.ts:92-97`): accept N-D arrays; identify the two spatial dims
  (trailing pair / `spatial:dimensions`) and the leading non-spatial dims.

### 3. Multi-variable enumeration & picker

- **Data variable** = an array in a level group whose trailing dims are the spatial pair
  (ndim ≥ 2). Exclude coordinate/aux arrays (`latitude`, `longitude`, `time`, `spatial_ref`,
  other 1-D coords). Two data arrays in a level group → two variables; this store → one.
- Enumerate variable names from the finest level group; assume each is present at every level.
  If a variable is missing at some level, drop it and `log`, don't fail the store.
- Each variable carries `name`, non-spatial `dims: {name,size}[]`, `units`, `longName`,
  `dtype`. Per-level `spatial:transform`/`spatial:shape` are shared across variables, so each
  variable's metadata reuses them with `asset = "<level>/<var>"`.
- Metadata becomes **per-variable**: context holds a `Record<string, GeoZarrMetadata>` (or
  builds on switch). `buildLayer` selects `ctx.metadata[state.variable]`; switching variable
  changes the layer's `metadata` prop → deck.gl-zarr re-parses and re-opens that variable's
  levels. The CF/Meta-CHM path expresses `chm` as a one-element variable list (behavior identical).

### 4. Time-axis slider (simple pinned-index model)

- `MultiscaleGridContext` gains `dims`/variable dim info + `dimLabel` (CF-decoded via existing
  `buildDimLabel`).
- `MultiscaleGridState`: `Record<string,never>` → `{ variable: string; dimIndices: Record<string,number> }`.
- `initialState` picks a default variable (scalar-grid's `PREFERRED_VARIABLES` → first) and
  default dim indices (time → latest, mirroring `defaultDimIndices`).
- `parseUrlParams`/`serializeUrlParams` handle `var=` **and** `dim.<name>=` (shareable URLs,
  matching scalar-grid; supports the reporter's `?var=NDVI&t=3`-style intent).
- `buildLayer` passes `selection: { <nonSpatialDim>: idx }` and includes `dimIndices` in
  `updateTriggers.renderTile` so scrubbing refetches. deck.gl-zarr builds the per-dim
  `sliceSpec` from `selection` natively.
- `MultiscaleGridControls` gains a **Variable** dropdown (shown only when >1 variable) above a
  `DebouncedSlider` per non-spatial dim (fetch mode, CF labels), keeping the pyramid note.
  Switching variables resets dim indices to that variable's defaults.

### 5. Stats & sampling

- `computeAutoStats` and `sampleValue` pin the non-spatial dims at the current index (both
  currently assume 2-D).
- `resolveNodeDeps`/`statsDeps` include `[state.variable]` (+ dim indices where they affect the read).

## Testing (test-first)

Unit (pure, no I/O — matches existing `multiscale.test.ts` style):
1. Layout parser: recognizes `{layout}` (returns coarsest→finest), still handles legacy
   `datasets`, returns `null` for OME/plain/empty.
2. Metadata build from a `{layout}` fixture → correct `asset` paths, `spatial:transform`,
   and `proj:code` CRS.
3. Multi-variable enumeration: two data vars in a level group → two variables; coord/aux
   arrays excluded; single-variable and CHM-compat cases.
4. N-D spatial-dim identification + `selection` construction for `[time,lat,lon]`.

End-to-end (acceptance for #68):
- Drive the dev server against `ndvi-cdr-pyramid-v2`; confirm tiles render, the variable
  picker shows `NDVI`, and moving the time slider re-fetches. Use the browser/verify skill.

## Risks

- **CF-path regression:** mitigated by branching early in `prepare` and keeping the CF branch
  byte-for-byte; the CHM-compat unit test guards it.
- **deck.gl-zarr `proj:code` support:** must be verified against the installed package before
  relying on it; fall back to emitting `proj:wkt2` if `proj:code` isn't consumed.
- **Variable consistency across levels:** defensively drop+log a variable absent at some level
  rather than failing the whole store.
