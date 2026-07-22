# GeoZarr `multiscales.layout` Pyramid Support — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render `zarr-conventions/multiscales` v1 `{layout}` pyramids (e.g. `ndvi-cdr-pyramid-v2`) in the `multiscale-grid` profile, with a variable picker and a time slider.

**Architecture:** Add pure parser/builder helpers for the `{layout}` schema in `multiscale.ts`; route such stores to `multiscale-grid` (scalar-grid already auto-switches on `MultiscaleStoreError`); give `multiscale-grid.prepare` a second branch that reads the store's native layout + `proj:code`/`proj:wkt2` and enumerates N-D data variables; expose a per-variable metadata + time-slider in state/controls. The existing CF/Meta-CHM branch is untouched.

**Tech Stack:** TypeScript, React, zarrita, `@developmentseed/deck.gl-zarr` (+ `@developmentseed/geozarr` for `parseGeoZarrMetadata`), vitest.

## Global Constraints

- deck.gl-zarr `parseGeoZarrMetadata` consumes: `multiscales.layout[].asset` (must be the **array** path), per-item `spatial:transform` + `spatial:shape`, top-level `spatial:dimensions` (accepts `latitude`/`longitude`, case-insensitive), and CRS via `proj:code` (regex `^[A-Z]+:[0-9]+$`) **or** `proj:wkt2`. `LayoutItemSchema` is `.passthrough()` (extra keys OK). Verified in `node_modules/.pnpm/@developmentseed+geozarr@0.6.1/.../dist/parse.js` + `schemas.js`.
- deck.gl-zarr `ZarrLayer` reuses a pre-opened array only when `meta.levels.length === 1`; for multi-level it re-opens each `group.resolve(asset)` as an array. So we pass **the root group** as `node` and synthesized metadata whose `asset` = `"<levelGroup>/<var>"`.
- `multiscales.layout` order is **finest-first** in the metadata handed to deck.gl-zarr (matches store order).
- The store's `time` axis has chunk size 1 → pinned/fetch-on-scrub dim (no texture-array pipeline).
- Keep the CF/Meta-CHM `prepare` branch behavior byte-for-byte.
- Reference store facts (`ndvi-cdr-pyramid-v2`): levels `/0`(3600×7200)…`/3`(450×900), finest-first; data var `NDVI [time=5, latitude=3600, longitude=7200]`; `proj:code: EPSG:4326`; `spatial:dimensions: ["latitude","longitude"]`; `/N/spatial_ref` attrs empty.

---

### Task 1: `parseMultiscaleLayout` — recognize the `{layout}` schema

**Files:**
- Modify: `src/zarr/multiscale.ts`
- Test: `src/__tests__/multiscale.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type MultiscaleLayoutLevel = {
    /** Level GROUP path, e.g. "0". */
    asset: string;
    "spatial:transform": [number, number, number, number, number, number];
    "spatial:shape": [number, number];
  };
  export type MultiscaleLayout = {
    /** Levels FINEST-FIRST (store order). */
    levels: MultiscaleLayoutLevel[];
    /** Spatial dim names (2), from root `spatial:dimensions`. */
    dims: [string, string];
    /** CRS: exactly one of code/wkt2, from root proj:* attrs. */
    crs: { code?: string; wkt2?: string };
  };
  export function parseMultiscaleLayout(rootAttrs: unknown): MultiscaleLayout | null;
  ```

- [ ] **Step 1: Write the failing test**

Add to `src/__tests__/multiscale.test.ts`:

```ts
import { parseMultiscaleLayout } from "../zarr/multiscale";

describe("parseMultiscaleLayout", () => {
  const layoutAttrs = {
    "spatial:dimensions": ["latitude", "longitude"],
    "proj:code": "EPSG:4326",
    multiscales: {
      layout: [
        { asset: "0", "spatial:transform": [0.05, 0, -180, 0, -0.05, 90], "spatial:shape": [3600, 7200] },
        { asset: "1", "spatial:transform": [0.1, 0, -180, 0, -0.1, 90], "spatial:shape": [1800, 3600] },
      ],
    },
  };

  it("reads finest-first levels, dims, and proj:code CRS", () => {
    const out = parseMultiscaleLayout(layoutAttrs)!;
    expect(out.levels.map((l) => l.asset)).toEqual(["0", "1"]);
    expect(out.levels[0]!["spatial:shape"]).toEqual([3600, 7200]);
    expect(out.dims).toEqual(["latitude", "longitude"]);
    expect(out.crs).toEqual({ code: "EPSG:4326" });
  });

  it("reads a proj:wkt2 CRS when no proj:code", () => {
    const out = parseMultiscaleLayout({ ...layoutAttrs, "proj:code": undefined, "proj:wkt2": "WKT" })!;
    expect(out.crs).toEqual({ wkt2: "WKT" });
  });

  it("returns null for the legacy datasets array, OME, and plain stores", () => {
    expect(parseMultiscaleLayout({ multiscales: [{ datasets: [{ path: "1x" }] }] })).toBeNull();
    expect(parseMultiscaleLayout({ multiscales: { layout: [] } })).toBeNull();
    expect(parseMultiscaleLayout({})).toBeNull();
    expect(parseMultiscaleLayout(null)).toBeNull();
  });

  it("returns null when a layout item is missing transform/shape", () => {
    expect(parseMultiscaleLayout({
      "spatial:dimensions": ["latitude", "longitude"],
      "proj:code": "EPSG:4326",
      multiscales: { layout: [{ asset: "0" }] },
    })).toBeNull();
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `pnpm --dir . exec vitest run src/__tests__/multiscale.test.ts -t parseMultiscaleLayout`
Expected: FAIL — `parseMultiscaleLayout is not a function`.

- [ ] **Step 3: Implement `parseMultiscaleLayout` in `src/zarr/multiscale.ts`**

Add after `parseMultiscaleDatasets`:

```ts
export type MultiscaleLayoutLevel = {
  asset: string;
  "spatial:transform": [number, number, number, number, number, number];
  "spatial:shape": [number, number];
};
export type MultiscaleLayout = {
  levels: MultiscaleLayoutLevel[];
  dims: [string, string];
  crs: { code?: string; wkt2?: string };
};

function asAffine6(v: unknown): [number, number, number, number, number, number] | null {
  if (!Array.isArray(v) || v.length !== 6 || v.some((n) => typeof n !== "number")) return null;
  return v as [number, number, number, number, number, number];
}
function asShape2(v: unknown): [number, number] | null {
  if (!Array.isArray(v) || v.length !== 2 || v.some((n) => typeof n !== "number")) return null;
  return [v[0] as number, v[1] as number];
}

/** Read the `zarr-conventions/multiscales` v1 `{ layout: [...] }` object schema
 * (distinct from the legacy CF `[{ datasets }]` array handled by
 * {@link parseMultiscaleDatasets}). Returns levels FINEST-FIRST (store order),
 * the spatial dim pair, and the CRS, or null when the store isn't this schema
 * or a layout item lacks a per-level transform/shape. */
export function parseMultiscaleLayout(rootAttrs: unknown): MultiscaleLayout | null {
  if (typeof rootAttrs !== "object" || rootAttrs === null) return null;
  const a = rootAttrs as Record<string, unknown>;
  const ms = a.multiscales;
  // Must be the OBJECT form { layout: [...] } — the legacy datasets form is an array.
  if (typeof ms !== "object" || ms === null || Array.isArray(ms)) return null;
  const layout = (ms as { layout?: unknown }).layout;
  if (!Array.isArray(layout) || layout.length === 0) return null;

  const levels: MultiscaleLayoutLevel[] = [];
  for (const item of layout) {
    if (typeof item !== "object" || item === null) return null;
    const it = item as Record<string, unknown>;
    const asset = it.asset;
    const transform = asAffine6(it["spatial:transform"]);
    const shape = asShape2(it["spatial:shape"]);
    if (typeof asset !== "string" || !transform || !shape) return null;
    levels.push({ asset, "spatial:transform": transform, "spatial:shape": shape });
  }

  const dimsRaw = a["spatial:dimensions"];
  if (!Array.isArray(dimsRaw) || dimsRaw.length < 2) return null;
  const dims: [string, string] = [
    String(dimsRaw[dimsRaw.length - 2]),
    String(dimsRaw[dimsRaw.length - 1]),
  ];

  const crs: { code?: string; wkt2?: string } = {};
  if (typeof a["proj:code"] === "string") crs.code = a["proj:code"];
  else if (typeof a["proj:wkt2"] === "string") crs.wkt2 = a["proj:wkt2"];
  else return null;

  return { levels, dims, crs };
}
```

- [ ] **Step 4: Run tests — confirm pass**

Run: `pnpm --dir . exec vitest run src/__tests__/multiscale.test.ts`
Expected: PASS (existing `parseMultiscaleDatasets`/`buildGeoZarrMetadata` tests still green).

- [ ] **Step 5: Commit**

```bash
git add src/zarr/multiscale.ts src/__tests__/multiscale.test.ts
git commit -m "feat(multiscale): parse zarr-conventions multiscales layout schema (#68)"
```

---

### Task 2: `buildLayoutGeoZarrMetadata` — synthesize deck.gl-zarr metadata from a layout

**Files:**
- Modify: `src/zarr/multiscale.ts`
- Test: `src/__tests__/multiscale.test.ts`

**Interfaces:**
- Consumes: `MultiscaleLayout`, `MultiscaleLayoutLevel` (Task 1).
- Produces:
  ```ts
  // GeoZarrMetadata gains an optional proj:code alongside proj:wkt2:
  export type GeoZarrMetadata = {
    "spatial:dimensions": [string, string];
    "proj:wkt2"?: string;
    "proj:code"?: string;
    multiscales: { layout: { asset: string;
      "spatial:transform": [number, number, number, number, number, number];
      "spatial:shape": [number, number]; }[] };
  };
  export function buildLayoutGeoZarrMetadata(opts: {
    layout: MultiscaleLayout;   // levels finest-first
    variable: string;           // e.g. "NDVI"
  }): GeoZarrMetadata;
  ```

- [ ] **Step 1: Write the failing test**

Add to `src/__tests__/multiscale.test.ts`:

```ts
import { buildLayoutGeoZarrMetadata, parseMultiscaleLayout } from "../zarr/multiscale";

describe("buildLayoutGeoZarrMetadata", () => {
  const layout = parseMultiscaleLayout({
    "spatial:dimensions": ["latitude", "longitude"],
    "proj:code": "EPSG:4326",
    multiscales: {
      layout: [
        { asset: "0", "spatial:transform": [0.05, 0, -180, 0, -0.05, 90], "spatial:shape": [3600, 7200] },
        { asset: "1", "spatial:transform": [0.1, 0, -180, 0, -0.1, 90], "spatial:shape": [1800, 3600] },
      ],
    },
  })!;

  it("rewrites asset to <level>/<var>, keeps finest-first order + transforms", () => {
    const meta = buildLayoutGeoZarrMetadata({ layout, variable: "NDVI" });
    expect(meta.multiscales.layout.map((l) => l.asset)).toEqual(["0/NDVI", "1/NDVI"]);
    expect(meta.multiscales.layout[0]!["spatial:shape"]).toEqual([3600, 7200]);
    expect(meta.multiscales.layout[0]!["spatial:transform"]).toEqual([0.05, 0, -180, 0, -0.05, 90]);
  });

  it("emits proj:code + spatial:dimensions from the layout", () => {
    const meta = buildLayoutGeoZarrMetadata({ layout, variable: "NDVI" });
    expect(meta["proj:code"]).toBe("EPSG:4326");
    expect(meta["proj:wkt2"]).toBeUndefined();
    expect(meta["spatial:dimensions"]).toEqual(["latitude", "longitude"]);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `pnpm --dir . exec vitest run src/__tests__/multiscale.test.ts -t buildLayoutGeoZarrMetadata`
Expected: FAIL — `buildLayoutGeoZarrMetadata is not a function`.

- [ ] **Step 3: Implement it (and widen `GeoZarrMetadata`)**

In `src/zarr/multiscale.ts`, change the `GeoZarrMetadata` type so CRS is optional either-or:

```ts
export type GeoZarrMetadata = {
  "spatial:dimensions": [string, string];
  "proj:wkt2"?: string;
  "proj:code"?: string;
  multiscales: {
    layout: {
      asset: string;
      "spatial:transform": [number, number, number, number, number, number];
      "spatial:shape": [number, number];
    }[];
  };
};
```

`buildGeoZarrMetadata` (the existing CF builder) already sets `"proj:wkt2"`; with the field now optional that still type-checks. Append:

```ts
/** Build deck.gl-zarr metadata from a native `zarr-conventions/multiscales`
 * layout for one data variable. The store's `layout[].asset` names the level
 * GROUP (e.g. "0"); deck.gl-zarr opens `asset` as an ARRAY, so rewrite it to
 * "<level>/<variable>" (e.g. "0/NDVI"). Levels stay finest-first. */
export function buildLayoutGeoZarrMetadata(opts: {
  layout: MultiscaleLayout;
  variable: string;
}): GeoZarrMetadata {
  const { layout, variable } = opts;
  const crs = layout.crs.code ? { "proj:code": layout.crs.code } : { "proj:wkt2": layout.crs.wkt2 };
  return {
    "spatial:dimensions": layout.dims,
    ...crs,
    multiscales: {
      layout: layout.levels.map((lvl) => ({
        asset: `${lvl.asset}/${variable}`,
        "spatial:transform": lvl["spatial:transform"],
        "spatial:shape": lvl["spatial:shape"],
      })),
    },
  };
}
```

- [ ] **Step 4: Run tests — confirm pass**

Run: `pnpm --dir . exec vitest run src/__tests__/multiscale.test.ts`
Expected: PASS (all `multiscale.test.ts` describe blocks green).

- [ ] **Step 5: Type-check (the widened `GeoZarrMetadata` touches `multiscale-grid`)**

Run: `pnpm --dir . exec tsc -b`
Expected: exit 0. (`buildGeoZarrMetadata` still compiles; `multiscale-grid` consumers unaffected — `proj:wkt2` is now optional but still present in CF output.)

- [ ] **Step 6: Commit**

```bash
git add src/zarr/multiscale.ts src/__tests__/multiscale.test.ts
git commit -m "feat(multiscale): build deck.gl-zarr metadata from a native layout (#68)"
```

---

### Task 3: Route `{layout}` stores to `multiscale-grid`, and export `spatialPair`

**Files:**
- Modify: `src/zarr/profiles/scalar-grid/profile.ts` (import + `MultiscaleStoreError` guard at line 576; export `spatialPair`)
- Test: `src/__tests__/scalar-grid-route.test.ts` (new)

**Interfaces:**
- Consumes: `parseMultiscaleLayout` (Task 1).
- Produces: `export function spatialPair(dims): { lat: string; lon: string } | null;` (re-exported for Task 5).

- [ ] **Step 1: Write the failing test**

Create `src/__tests__/scalar-grid-route.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { parseMultiscaleDatasets, parseMultiscaleLayout } from "../zarr/multiscale";

// The routing predicate scalar-grid.prepare uses to throw MultiscaleStoreError.
// Kept in lockstep with profile.ts line ~576.
const isMultiscale = (attrs: unknown) =>
  Boolean(parseMultiscaleDatasets(attrs) || parseMultiscaleLayout(attrs));

describe("multiscale routing predicate", () => {
  it("detects a native layout pyramid (issue #68)", () => {
    expect(isMultiscale({
      "spatial:dimensions": ["latitude", "longitude"],
      "proj:code": "EPSG:4326",
      multiscales: { layout: [{ asset: "0", "spatial:transform": [0.05,0,-180,0,-0.05,90], "spatial:shape": [3600,7200] }] },
    })).toBe(true);
  });
  it("still detects a legacy datasets pyramid", () => {
    expect(isMultiscale({ multiscales: [{ datasets: [{ path: "1x" }] }] })).toBe(true);
  });
  it("is false for a plain store", () => {
    expect(isMultiscale({ "spatial:transform": [1,0,0,0,1,0] })).toBe(false);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `pnpm --dir . exec vitest run src/__tests__/scalar-grid-route.test.ts`
Expected: FAIL — `parseMultiscaleLayout` import resolves (Task 1) but this test file is new; run to confirm it passes only after Step 3 wiring. (If it already passes on the predicate alone, that's fine — Step 3 wires the same predicate into the profile and exports `spatialPair`.)

- [ ] **Step 3: Wire the predicate + export `spatialPair` in `src/zarr/profiles/scalar-grid/profile.ts`**

Update the import (line ~20):

```ts
import { MultiscaleStoreError, parseMultiscaleDatasets, parseMultiscaleLayout } from "../../multiscale";
```

Replace the guard at line 576:

```ts
    if (parseMultiscaleDatasets(opened.group.attrs) || parseMultiscaleLayout(opened.group.attrs))
      throw new MultiscaleStoreError();
```

Export `spatialPair` (line ~79) by adding `export`:

```ts
export function spatialPair(
  dims: readonly (string | null)[] | undefined,
): { lat: string; lon: string } | null {
```

- [ ] **Step 4: Run tests — confirm pass + no regressions**

Run: `pnpm --dir . exec vitest run src/__tests__/scalar-grid-route.test.ts src/__tests__/structure.test.ts`
Expected: PASS. (structure.test.ts guards the OME-vs-legacy-multiscales distinction; confirm the `{layout}` object doesn't disturb it.)

- [ ] **Step 5: Commit**

```bash
git add src/zarr/profiles/scalar-grid/profile.ts src/__tests__/scalar-grid-route.test.ts
git commit -m "feat(scalar-grid): route native-layout pyramids to multiscale-grid (#68)"
```

---

### Task 4: `multiscale-grid` types — variables, dims, and time state

**Files:**
- Modify: `src/zarr/profiles/multiscale-grid/types.ts`

**Interfaces:**
- Produces:
  ```ts
  export type MultiscaleGridDim = { name: string; size: number };
  export type MultiscaleGridVariable = {
    name: string;              // e.g. "NDVI"
    longName: string | null;
    units: string | null;
    dtype: string;
    fillValue: number | null;
    dims: MultiscaleGridDim[]; // leading non-spatial dims (may be empty, e.g. CHM)
    metadata: GeoZarrMetadata; // per-variable deck.gl-zarr metadata (asset = <level>/<name>)
  };
  // Context gains `variables` + `dimLabel`; keeps existing CF-path fields.
  // State becomes { variable: string; dimIndices: Record<string, number> }.
  ```

- [ ] **Step 1: Update `src/zarr/profiles/multiscale-grid/types.ts`**

Replace the file's variable/state parts (keep the imports + existing CF context fields) with:

```ts
import type * as zarr from "zarrita";
import type { GeoZarrMetadata } from "../../multiscale";
import type { ProfileBaseContext } from "../../profile";

export type MultiscaleGridDim = { name: string; size: number };

/** A renderable data variable present at every pyramid level. */
export type MultiscaleGridVariable = {
  name: string;
  longName: string | null;
  units: string | null;
  dtype: string;
  fillValue: number | null;
  /** Leading non-spatial dims (everything before the trailing lat/lon pair). */
  dims: MultiscaleGridDim[];
  /** Per-variable deck.gl-zarr metadata (asset = "<level>/<name>"). */
  metadata: GeoZarrMetadata;
};

export type MultiscaleGridContext = ProfileBaseContext & {
  store: zarr.Readable;
  /** Renderable variables (≥1). Single-variable stores (e.g. Meta CHM) have one. */
  variables: MultiscaleGridVariable[];
  /** Number of pyramid levels. */
  levelCount: number;
  /** Downsample factor per level (displayIndex order: index 0 = coarsest). */
  levelDownsamples: number[];
  /** `proj:code` when the CRS is an EPSG code (display + geographic gate); else null. */
  crsCode: string | null;
  /** Coarsest level's data array of the DEFAULT variable + its layout transform,
   * used to sample a representative patch for the auto-rescale. */
  coarsestArray: zarr.Array<zarr.DataType, zarr.Readable>;
  coarsestTransform: readonly number[];
  /** Per-dim label formatter (`idx → string`), CF-decoded from the coord array. */
  dimLabel: Record<string, (idx: number) => string>;
  /** Lowest map zoom to load coarsest-level tiles (0 = no gate, e.g. geographic). */
  minRenderZoom: number;
};

export type MultiscaleGridState = {
  variable: string;
  /** Selected index per non-spatial dim name (e.g. `{ time: 4 }`). */
  dimIndices: Record<string, number>;
};

/** Default index per non-spatial dim: latest frame for time-like dims, else 0. */
export function defaultDimIndices(v: MultiscaleGridVariable): Record<string, number> {
  const out: Record<string, number> = {};
  for (const d of v.dims) {
    out[d.name] = /time|init|reference|analysis/i.test(d.name) ? Math.max(0, d.size - 1) : 0;
  }
  return out;
}
```

Note: this removes the CF-only fields `metadata`, `dtype`, `units`, `longName`, `variable`, `finestPixelMeters`, `coarsestGeoTransform`, `primaryPath` from context. Task 5 rewrites `prepare` (both branches) to populate the new shape, so those fields move onto `variables[]`.

- [ ] **Step 2: Type-check (expected to FAIL until Task 5/6/7 land)**

Run: `pnpm --dir . exec tsc -b`
Expected: FAIL in `multiscale-grid/profile.ts` and `controls.tsx` (they still reference the old context shape). This is the intended red state; Tasks 5–7 make it green. Do **not** commit a broken tsc — this task is committed together with Task 5 (they share the type contract).

- [ ] **Step 3: (No commit yet — proceed to Task 5.)**

---

### Task 5: `multiscale-grid.prepare` — layout branch + variable enumeration

**Files:**
- Modify: `src/zarr/profiles/multiscale-grid/profile.ts`

**Interfaces:**
- Consumes: `parseMultiscaleLayout`, `buildLayoutGeoZarrMetadata` (Tasks 1–2), `parseMultiscaleDatasets`/`buildGeoZarrMetadata` (existing CF), `spatialPair` (Task 3), `buildDimLabel` from `../scalar-grid/cf-coords`, `deriveMinZoom` from `../scalar-grid/profile`.
- Produces: a `MultiscaleGridContext` (Task 4) from either schema.

- [ ] **Step 1: Add imports**

At the top of `src/zarr/profiles/multiscale-grid/profile.ts`:

```ts
import { buildGeoZarrMetadata, buildLayoutGeoZarrMetadata, parseMultiscaleDatasets, parseMultiscaleLayout } from "../../multiscale";
import { deriveMinZoom, spatialPair } from "../scalar-grid/profile";
import { buildDimLabel } from "../scalar-grid/cf-coords";
import { bytesPerElement } from "../../chunk-size";
import { defaultDimIndices, type MultiscaleGridVariable } from "./types";
```

(Remove any now-unused imports flagged by tsc.)

- [ ] **Step 2: Add an enumeration helper (layout path) above the profile object**

```ts
const COORD_AUX = new Set(["spatial_ref", "latitude", "longitude", "lat", "lon", "x", "y", "time"]);

/** Enumerate renderable data variables in a pyramid's finest level group.
 * A data variable is an array whose trailing two dims are the lat/lon spatial
 * pair (via {@link spatialPair}); coordinate/aux arrays are excluded. Returns
 * the array names + their leading (non-spatial) dims. */
async function enumerateLayoutVariables(
  group: zarr.Group<zarr.Readable>,
  finestLevel: string,
  contents: { path: string; kind: "array" | "group" }[],
): Promise<{ name: string; arr: zarr.Array<zarr.DataType, zarr.Readable>; dims: { name: string; size: number }[] }[]> {
  const prefix = `${finestLevel}/`;
  const names = contents
    .filter((e) => e.kind === "array")
    .map((e) => e.path.replace(/^\/+/, ""))
    .filter((p) => p.startsWith(prefix) && !p.slice(prefix.length).includes("/"))
    .map((p) => p.slice(prefix.length))
    .filter((n) => !COORD_AUX.has(n));
  const out: { name: string; arr: zarr.Array<zarr.DataType, zarr.Readable>; dims: { name: string; size: number }[] }[] = [];
  for (const name of names) {
    const arr = await zarr.open(group.resolve(`${finestLevel}/${name}`), { kind: "array" });
    const dimNames = arr.dimensionNames;
    if (!spatialPair(dimNames)) continue; // not a spatial data variable
    const lead = (dimNames ?? []).slice(0, arr.shape.length - 2);
    const dims = lead.map((dn, i) => ({ name: String(dn), size: arr.shape[i]! }));
    out.push({ name, arr, dims });
  }
  return out;
}

function numAttr(v: unknown): number | null {
  const n = typeof v === "string" ? Number(v) : (v as number);
  return typeof n === "number" && Number.isFinite(n) ? n : null;
}
```

- [ ] **Step 3: Rewrite `prepare` to branch on schema**

Replace the entire `async prepare(...)` body. The CF branch is factored into `prepareCf` (the current logic, adapted to the new context shape — one variable); the new layout branch is `prepareLayout`. Skeleton:

```ts
  async prepare(url, signal, open = {}) {
    const done = log.time("multiscale-grid prepare", "info");
    const opened = await openV3Group(url, { consolidated: true, ...open });
    const contents =
      (opened.store as { contents?: () => { path: string; kind: "array" | "group" }[] }).contents?.() ?? [];

    const layout = parseMultiscaleLayout(opened.group.attrs);
    const ctx = layout
      ? await prepareLayout(url, opened, contents, layout, signal)
      : await prepareCf(url, opened, contents, signal);
    done();
    return ctx;
  },
```

`prepareLayout` (new — full implementation):

```ts
async function prepareLayout(
  url: string,
  opened: Awaited<ReturnType<typeof openV3Group>>,
  contents: { path: string; kind: "array" | "group" }[],
  layout: NonNullable<ReturnType<typeof parseMultiscaleLayout>>,
  signal: AbortSignal,
): Promise<MultiscaleGridContext> {
  // layout.levels is finest-first; level group path = asset ("0".."3").
  const finest = layout.levels[0]!.asset;
  const coarsest = layout.levels[layout.levels.length - 1]!.asset;
  const found = await enumerateLayoutVariables(opened.group, finest, contents);
  if (found.length === 0) {
    throw new Error("Multiscale layout store: no lat/lon data variables found in the finest level.");
  }

  const variables: MultiscaleGridVariable[] = found.map((f) => ({
    name: f.name,
    longName: typeof f.arr.attrs.long_name === "string" ? f.arr.attrs.long_name : null,
    units: typeof f.arr.attrs.units === "string" ? f.arr.attrs.units : null,
    dtype: f.arr.dtype,
    fillValue: numAttr(f.arr.attrs._FillValue),
    dims: f.dims,
    metadata: buildLayoutGeoZarrMetadata({ layout, variable: f.name }),
  }));

  // CF dim labels for each non-spatial dim (coord array lives in the finest level group).
  const dimLabel: Record<string, (idx: number) => string> = {};
  for (const v of variables) {
    for (const d of v.dims) {
      if (signal.aborted) break;
      if (!dimLabel[d.name]) dimLabel[d.name] = await buildDimLabel(opened.group, `${finest}/${d.name}`, d.size);
    }
  }

  // Coarsest-level array of the default variable, for auto-stats sampling.
  const defaultVar = variables.find((v) => v.name === "NDVI") ?? variables[0]!;
  const coarsestArray = await zarr.open(opened.group.resolve(`${coarsest}/${defaultVar.name}`), { kind: "array" });
  const coarsestTransform = layout.levels[layout.levels.length - 1]!["spatial:transform"];

  const crsCode = layout.crs.code ?? null;
  const isGeographic = crsCode != null && /4326|4269|4258/.test(crsCode);
  // Downsample per level (coarsest-first) from the finest pixel size.
  const finestScaleX = Math.abs(layout.levels[0]!["spatial:transform"][0]);
  const levelDownsamples = [...layout.levels].reverse().map((l) =>
    finestScaleX > 0 ? Math.round(Math.abs(l["spatial:transform"][0]) / finestScaleX) : 1,
  );
  // Geographic grids render at z0; a projected layout would need a metric gate,
  // but the layout transform units are the CRS units — skip the gate for now.
  const minRenderZoom = 0;

  log.info(
    `prepared multiscale-layout ${variables.length} var(s) ${layout.levels.length} levels, ` +
      `crs=${crsCode ?? "wkt"}, default="${defaultVar.name}", minRenderZoom=${minRenderZoom}`,
  );

  return {
    url,
    group: opened.group,
    store: opened.store,
    variables,
    levelCount: layout.levels.length,
    levelDownsamples,
    crsCode,
    coarsestArray,
    coarsestTransform,
    dimLabel,
    minRenderZoom,
  };
  void isGeographic; // (kept for parity; minRenderZoom is 0 for geographic today)
}
```

`prepareCf` — move the current `prepare` body here, adapted so its single variable becomes `variables: [oneVar]` with an empty `dims: []` and `metadata: buildGeoZarrMetadata(...)`, and populate `coarsestArray`/`coarsestTransform` (rename from `coarsestGeoTransform`)/`crsCode`/`levelCount`/`levelDownsamples`/`minRenderZoom`/`dimLabel: {}`. Keep every existing CF read (GeoTransform, crs_wkt, 2-D check) intact. (The engineer copies the existing lines from git history; the only reshaping is packing the single variable into the `variables` array and renaming context fields.)

- [ ] **Step 4: Type-check**

Run: `pnpm --dir . exec tsc -b`
Expected: exit 0 once Tasks 6 & 7 are also applied. If doing tasks strictly in order, tsc will still flag `buildLayer`/`Controls`/other methods that read the old context — proceed to Task 6.

- [ ] **Step 5: (No commit yet — context is consumed by Tasks 6–7; commit at end of Task 6.)**

---

### Task 6: `multiscale-grid` layer/state/stats — per-variable + time selection

**Files:**
- Modify: `src/zarr/profiles/multiscale-grid/profile.ts`

**Interfaces:**
- Consumes: `MultiscaleGridContext`/`MultiscaleGridState`/`defaultDimIndices` (Task 4).

- [ ] **Step 1: Rewrite the profile's non-`prepare` methods**

Replace `initialState`/`parseUrlParams`/`serializeUrlParams`/`resolveNode*`/`statsDeps`/`buildLayer`/`computeAutoStats`/`sampleValue`/`getStructure`/`pyramidLevel*` to key off `state.variable` + `state.dimIndices`:

```ts
  initialState(ctx) {
    const preferred = ["NDVI"];
    const variable = preferred.find((p) => ctx.variables.some((v) => v.name === p))
      ?? ctx.variables[0]!.name;
    const v = ctx.variables.find((x) => x.name === variable)!;
    return { variable, dimIndices: defaultDimIndices(v) };
  },
  parseUrlParams(p) {
    const out: Partial<MultiscaleGridState> = {};
    const v = p.get("var");
    if (v) out.variable = v;
    const dimIndices: Record<string, number> = {};
    for (const [key, value] of p.entries()) {
      if (!key.startsWith("dim.")) continue;
      const n = Number(value);
      if (Number.isFinite(n)) dimIndices[key.slice(4)] = n;
    }
    if (Object.keys(dimIndices).length > 0) out.dimIndices = dimIndices;
    return out;
  },
  serializeUrlParams(s) {
    const out: Record<string, string | null> = { var: s.variable };
    for (const [name, idx] of Object.entries(s.dimIndices)) out[`dim.${name}`] = String(idx);
    return out;
  },

  resolveNode: async (ctx) => ctx.group,
  resolveNodeDeps: (s) => [s.variable],
  statsDeps: (s) => [s.variable],
```

`buildLayer` (metadata + selection now vary by state):

```ts
  buildLayer({ ctx, state, chassisState, colormapTexture, autoStats, basemapBeforeId, node }) {
    if (!node || !colormapTexture) return null;
    const v = ctx.variables.find((x) => x.name === state.variable);
    if (!v) return null;
    const selection: Record<string, number> = {};
    for (const d of v.dims) selection[d.name] = state.dimIndices[d.name] ?? 0;
    const renderTile = buildSingleBandRenderTile(
      {
        colormap: chassisState.colormap ?? "viridis",
        rescale: chassisState.rescale,
        gamma: chassisState.gamma,
        stretch: chassisState.stretch,
        maskBelow: chassisState.maskBelow,
        maskAbove: chassisState.maskAbove,
        nodata: null,
      },
      colormapTexture,
      autoStats,
    );
    const pinnedKey = Object.entries(selection).map(([k, i]) => `${k}=${i}`).join(",");
    return new ReportingZarrLayer<zarr.Readable, zarr.DataType, MultiBandTileData>({
      id: `multiscale-grid-${state.variable}-${pinnedKey}`,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      node: node as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      metadata: v.metadata as any,
      selection,
      getTileData: makeScalarGridTileLoader({
        fillValue: v.fillValue,
        sampleKeyForZ: (z) => `${state.variable}:z${z}`,
      }),
      renderTile,
      opacity: chassisState.opacity,
      minZoom: chassisState.minZoomOverride ?? ctx.minRenderZoom,
      extent: KEEP_MIN_ZOOM_EXTENT,
      maxRequests: 20,
      maxCacheSize: 64,
      ...({ beforeId: basemapBeforeId } as Record<string, unknown>),
      updateTriggers: {
        renderTile: [
          chassisState.colormap, chassisState.rescale?.[0], chassisState.rescale?.[1],
          chassisState.gamma, chassisState.stretch, chassisState.maskBelow,
          chassisState.maskAbove, autoStats,
        ],
      },
    });
  },
```

`computeAutoStats` — pin the non-spatial dims of the default variable when reading the coarsest patch. Adapt the existing Amazon-patch sampler: build a `sliceSpec` over `coarsestArray.dimensionNames`, using `zarr.slice` for the trailing lat/lon and the current dim index (default 0 / latest) for leading dims. `sampleValue` — reuse the existing level-walk, but read the value key `${state.variable}:z${z}` and use each level's `spatial:transform` from `v.metadata.multiscales.layout`. `getStructure` returns `{ zarrVersion: "v3", variables: [{ path: \`\${finest}/\${state.variable}\`, role: "finest" }], metadataSource: "synthesized", metadata: v.metadata }`. `pyramidLevelCount`/`Downsamples` read `ctx.levelCount`/`ctx.levelDownsamples`.

- [ ] **Step 2: Type-check**

Run: `pnpm --dir . exec tsc -b`
Expected: exit 0 after Task 7 (Controls). If Controls not yet done, only `controls.tsx` errors remain.

- [ ] **Step 3: Run the full unit suite (no regressions)**

Run: `pnpm --dir . test`
Expected: all prior tests pass (314 + the new multiscale/route tests).

- [ ] **Step 4: Commit Tasks 4–6 together**

```bash
git add src/zarr/profiles/multiscale-grid/types.ts src/zarr/profiles/multiscale-grid/profile.ts
git commit -m "feat(multiscale-grid): native layout branch + per-variable time selection (#68)"
```

---

### Task 7: `multiscale-grid` Controls — variable picker + time slider

**Files:**
- Modify: `src/zarr/profiles/multiscale-grid/controls.tsx`

- [ ] **Step 1: Rewrite `MultiscaleGridControls`**

```tsx
import { DebouncedSlider } from "../../../components/DebouncedSlider";
import type { ProfileControlsProps } from "../../profile";
import { defaultDimIndices, type MultiscaleGridContext, type MultiscaleGridState } from "./types";

export function MultiscaleGridControls({
  ctx, state, update, group,
}: ProfileControlsProps<MultiscaleGridContext, MultiscaleGridState>) {
  if (group === "instant") return null;
  const activeVar = ctx.variables.find((v) => v.name === state.variable);

  if (group === "styling") {
    return (
      <div className="field-label" style={{ textTransform: "none" }}>
        <span className="mono" style={{ color: "var(--text-muted)" }}>
          {state.variable} · {ctx.levelCount}-level pyramid · {ctx.crsCode ?? "projected"}
        </span>
      </div>
    );
  }

  // "fetch" bucket: variable picker (when >1) + a slider per non-spatial dim.
  return (
    <div style={{ display: "grid", gap: 10 }}>
      {ctx.variables.length > 1 && (
        <label style={{ display: "grid", gap: 4 }}>
          <span className="field-label">Variable</span>
          <select
            value={state.variable}
            onChange={(e) => {
              const next = ctx.variables.find((v) => v.name === e.target.value);
              update({ variable: e.target.value, dimIndices: next ? defaultDimIndices(next) : {} });
            }}
          >
            {ctx.variables.map((v) => (
              <option key={v.name} value={v.name}>
                {v.longName ? `${v.name} — ${v.longName}` : v.name}
              </option>
            ))}
          </select>
          {activeVar?.units && (
            <span className="mono" style={{ color: "var(--text-muted)" }}>units: {activeVar.units}</span>
          )}
        </label>
      )}
      {(activeVar?.dims ?? []).map((dim) => {
        const value = state.dimIndices[dim.name] ?? 0;
        const format = ctx.dimLabel[dim.name] ?? ((v: number) => `${v} / ${dim.size - 1}`);
        return (
          <DebouncedSlider
            key={dim.name}
            label={dim.name}
            value={value}
            min={0}
            max={Math.max(0, dim.size - 1)}
            onCommit={(v) => update({ dimIndices: { ...state.dimIndices, [dim.name]: v } })}
            formatValue={format}
          />
        );
      })}
    </div>
  );
}
```

- [ ] **Step 2: Type-check + build**

Run: `pnpm --dir . exec tsc -b && pnpm --dir . run build`
Expected: exit 0 (build succeeds).

- [ ] **Step 3: Commit**

```bash
git add src/zarr/profiles/multiscale-grid/controls.tsx
git commit -m "feat(multiscale-grid): variable picker + time slider controls (#68)"
```

---

### Task 8: End-to-end verification (acceptance for #68)

**Files:** none (verification only).

- [ ] **Step 1: Start the dev server**

Run (background): `pnpm --dir . dev` → note the `http://localhost:5173/` URL.

- [ ] **Step 2: Load the reference store and observe**

Open `http://localhost:5173/?url=https%3A%2F%2Fr2-pub.openscicomp.io%2Fndvi-cdr-pyramid-v2` (use the browser/`verify` skill to drive it). Confirm from the console + canvas:
- log shows `switching to multiscale-grid profile` then `prepared multiscale-layout 1 var(s) 4 levels ... default="NDVI"`;
- **NDVI tiles render** over the basemap (no `Not found: v2 array`);
- the Options panel shows a **time** slider; moving it triggers a refetch and the map updates;
- the pyramid badge shows 4 levels; hover tooltip reads NDVI values.

- [ ] **Step 3: Regression spot-check a CF/Meta-CHM pyramid**

Load a known Meta-CHM-style store (CF `datasets` convention) and confirm it still renders (the `prepareCf` branch). If no URL is handy, at minimum confirm `src/__tests__/*` (incl. any CHM-shaped `multiscale.test.ts` cases) are green via `pnpm --dir . test`.

- [ ] **Step 4: Update the issue + finish the branch**

Comment on #68 with the result (works / any follow-ups), then use `superpowers:finishing-a-development-branch` to open the PR.

---

## Self-Review

**Spec coverage:**
- Detection/routing (spec §1) → Tasks 1, 3. ✅
- Two-path metadata build incl. `proj:code` + N-D relaxation (spec §2) → Tasks 2, 5. ✅
- Multi-variable enumeration & picker (spec §3) → Tasks 4, 5, 7. ✅
- Time-axis slider (spec §4) → Tasks 4, 6, 7. ✅
- Stats & sampling N-D pinning (spec §5) → Task 6. ✅
- Testing: unit (Tasks 1–3) + end-to-end (Task 8). ✅
- Risks: CF-path regression (Task 5 keeps `prepareCf` intact + Task 8 §3 spot-check); `proj:code` support (verified in Global Constraints); variable consistency (enumerate from finest, Task 5). ✅

**Placeholder scan:** No TBD/TODO. The only "copy the existing lines" instruction is `prepareCf` in Task 5 — deliberate (move current CF logic verbatim, reshape output), not a missing spec.

**Type consistency:** `MultiscaleGridContext` fields (`variables`, `coarsestArray`, `coarsestTransform`, `crsCode`, `levelCount`, `levelDownsamples`, `dimLabel`, `minRenderZoom`) defined in Task 4 and populated in Task 5, consumed in Tasks 6–7. `MultiscaleGridState` (`variable`, `dimIndices`) consistent across Tasks 4/6/7. `GeoZarrMetadata` widened once (Task 2) and used by both builders. `spatialPair` exported (Task 3), imported (Task 5).

**Known cross-task tsc red state:** Tasks 4–7 share one type contract; tsc only returns to green after Task 7. Commits are grouped accordingly (Tasks 4–6 together, Task 7 separately after build passes).
