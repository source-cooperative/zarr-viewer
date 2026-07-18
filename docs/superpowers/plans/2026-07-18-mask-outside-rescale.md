# Mask Tiles Outside Rescale Range — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an optional "mask values outside the rescale range" mode that makes out-of-range pixels fully transparent instead of clamping them to the colormap's end colors.

**Architecture:** A new discard-based GPU shader module (`MaskOutsideRange`) inserted *before* the rescale/clamp step in both single-band pipelines, plus an alpha branch in the CPU image path. The toggle is off by default. GPU paths key off the chassis rescale window (chassis state field); the image profile keys off its own profile-local rescale window (profile state field). Both use the URL key `mask`.

**Tech Stack:** TypeScript, React 19, deck.gl 9 + `@developmentseed/deck.gl-raster` GPU modules, luma.gl, Vitest (jsdom).

Spec: [docs/superpowers/specs/2026-07-18-mask-outside-rescale-design.md](../specs/2026-07-18-mask-outside-rescale-design.md)

## Global Constraints

- **Off by default.** No `mask` URL param → masking disabled → identical render to today.
- **Mask reuses the exact resolved rescale window.** Explicit rescale if set, else the auto 2–98% percentile fallback. When no window resolves, emit no mask module (nothing masked).
- **Boundaries inclusive.** Discard `v < lo || v > hi`; keep `lo <= v <= hi`.
- **Mask module must precede the rescale module** in every pipeline (rescale clamps, destroying out-of-range info).
- **Do not shell out to `grep`/`find`/`cat`/`head`.** Use Read/Explore. Test runner: `pnpm test` (`vitest run`). Build/typecheck: `pnpm build` (`tsc -b && vite build`).
- **Out of scope:** `band-composite` profile.

---

### Task 1: Chassis mask state field + URL parsing

**Files:**
- Modify: `src/state/types.ts` (add field to `ViewerState`)
- Modify: `src/state/useViewerState.ts` (parse + serialize `mask`)
- Test: `src/__tests__/state.test.ts` (parse assertions)

**Interfaces:**
- Produces: `ViewerState.maskOutsideRescale: boolean` (default `false`); URL key `mask` (`"1"` when on, absent when off).

- [ ] **Step 1: Write the failing tests**

In `src/__tests__/state.test.ts`, add to the existing `"returns sensible defaults for empty params"` test (after the `expect(s.snapshot).toBeNull();` line):

```ts
    expect(s.maskOutsideRescale).toBe(false);
```

Then add a new test after that `it(...)` block:

```ts
  it("parses the mask flag (mask=1 → true; absent/0 → false)", () => {
    expect(
      parseViewerState(new URLSearchParams("mask=1")).maskOutsideRescale,
    ).toBe(true);
    expect(
      parseViewerState(new URLSearchParams()).maskOutsideRescale,
    ).toBe(false);
    expect(
      parseViewerState(new URLSearchParams("mask=0")).maskOutsideRescale,
    ).toBe(false);
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test -- state`
Expected: FAIL — `maskOutsideRescale` does not exist on the parsed state (type error / `undefined`).

- [ ] **Step 3: Add the state field**

In `src/state/types.ts`, add inside the `ViewerState` type (after the `rescale` line at `:22`):

```ts
  /** When true, discard (make transparent) pixels whose value is outside the
   * resolved rescale window instead of clamping them. Display-only. Applies to
   * the GPU (map) render paths; the image profile has its own flag. */
  maskOutsideRescale: boolean;
```

- [ ] **Step 4: Parse and serialize the `mask` param**

In `src/state/useViewerState.ts`, inside `parseViewerState` (in the returned object, after the `rescale:` line at `:94`), add:

```ts
    maskOutsideRescale: p.get("mask") === "1",
```

Then in `applyChassisPatch`, after the `rescale` block (after `:142`), add:

```ts
  if (patch.maskOutsideRescale !== undefined) {
    if (patch.maskOutsideRescale) p.set("mask", "1");
    else p.delete("mask");
  }
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm test -- state`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/state/types.ts src/state/useViewerState.ts src/__tests__/state.test.ts
git commit -m "feat(mask): add maskOutsideRescale chassis state + URL param (#54)"
```

---

### Task 2: `MaskOutsideRange` shader module + single-band pipeline wiring

**Files:**
- Modify: `src/render/shader-modules.ts` (new `MaskOutsideRange` module)
- Modify: `src/render/single-band-pipeline.ts` (add field to `SingleBandRenderState`, import + insert module)
- Test: `src/render/mask-outside-rescale.test.ts` (new file — single-band cases)

**Interfaces:**
- Consumes: `MultiBandTileData` (`src/render/shared-textures.ts`), `AutoStats`/`buildBandStats`/`autoStatsFromGlobal` (`src/render/stats.ts`).
- Produces: `MaskOutsideRange` shader module (uniforms `maskMin: number`, `maskMax: number`); `SingleBandRenderState` gains `maskOutsideRescale: boolean`.

- [ ] **Step 1: Write the failing test**

Create `src/render/mask-outside-rescale.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { Texture } from "@luma.gl/core";
import { buildSingleBandRenderTile } from "./single-band-pipeline";
import { MaskOutsideRange, PerBandLinearRescale } from "./shader-modules";
import type { MultiBandTileData } from "./shared-textures";
import { autoStatsFromGlobal, buildBandStats, type AutoStats } from "./stats";

const fakeTexture = {} as unknown as Texture;

function singleBandData(sampleScale: number): MultiBandTileData {
  return {
    bands: new Map([["1", { texture: fakeTexture, uvTransform: [0, 0, 1, 1] }]]),
    width: 1,
    height: 1,
    byteLength: 4,
    nodata: null,
    sampleScale,
  };
}

const baseState = {
  colormap: "viridis",
  gamma: 1,
  stretch: "linear" as const,
  nodata: null,
};

// Each pipeline module is `{ module, props? }`; find by reference equality.
type Mod = { module: unknown; props?: Record<string, unknown> };

describe("single-band pipeline: mask outside rescale", () => {
  it("omits the mask module when maskOutsideRescale is false", () => {
    const renderTile = buildSingleBandRenderTile(
      { ...baseState, rescale: [10, 20], maskOutsideRescale: false },
      fakeTexture,
      null,
    );
    const { renderPipeline } = renderTile(singleBandData(1));
    expect(
      (renderPipeline as Mod[]).some((m) => m.module === MaskOutsideRange),
    ).toBe(false);
  });

  it("inserts the mask module immediately before rescale", () => {
    const renderTile = buildSingleBandRenderTile(
      { ...baseState, rescale: [10, 20], maskOutsideRescale: true },
      fakeTexture,
      null,
    );
    const pipe = renderTile(singleBandData(1)).renderPipeline as Mod[];
    const maskIdx = pipe.findIndex((m) => m.module === MaskOutsideRange);
    const rescaleIdx = pipe.findIndex((m) => m.module === PerBandLinearRescale);
    expect(maskIdx).toBeGreaterThanOrEqual(0);
    expect(maskIdx + 1).toBe(rescaleIdx);
    expect(pipe[maskIdx]!.props).toEqual({ maskMin: 10, maskMax: 20 });
  });

  it("divides mask bounds by sampleScale for r8unorm textures", () => {
    const renderTile = buildSingleBandRenderTile(
      { ...baseState, rescale: [0, 255], maskOutsideRescale: true },
      fakeTexture,
      null,
    );
    const pipe = renderTile(singleBandData(255)).renderPipeline as Mod[];
    const mask = pipe.find((m) => m.module === MaskOutsideRange);
    expect(mask!.props).toEqual({ maskMin: 0, maskMax: 1 });
  });

  it("does not mask when no window resolves (no rescale, no stats)", () => {
    const renderTile = buildSingleBandRenderTile(
      { ...baseState, rescale: null, maskOutsideRescale: true },
      fakeTexture,
      null,
    );
    const pipe = renderTile(singleBandData(1)).renderPipeline as Mod[];
    expect(pipe.some((m) => m.module === MaskOutsideRange)).toBe(false);
  });

  it("uses the auto percentile window when no explicit rescale is set", () => {
    const stats = buildBandStats(
      Float32Array.from({ length: 100 }, (_, i) => i),
      null,
    );
    const autoStats: AutoStats = autoStatsFromGlobal(stats!);
    const renderTile = buildSingleBandRenderTile(
      { ...baseState, rescale: null, maskOutsideRescale: true },
      fakeTexture,
      autoStats,
    );
    const pipe = renderTile(singleBandData(1)).renderPipeline as Mod[];
    const mask = pipe.find((m) => m.module === MaskOutsideRange);
    const rescale = pipe.find((m) => m.module === PerBandLinearRescale);
    expect(mask).toBeDefined();
    // Mask bounds == the resolved rescale window (same [lo, hi]).
    const rescaleMin = (rescale!.props!.rescaleMin as number[])[0];
    const rescaleMax = (rescale!.props!.rescaleMax as number[])[0];
    expect(mask!.props!.maskMin).toBe(rescaleMin);
    expect(mask!.props!.maskMax).toBe(rescaleMax);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test -- mask-outside-rescale`
Expected: FAIL — `MaskOutsideRange` is not exported from `./shader-modules`, and `maskOutsideRescale` is not a valid `SingleBandRenderState` field.

- [ ] **Step 3: Add the `MaskOutsideRange` shader module**

In `src/render/shader-modules.ts`, add a props type near the top (after line 3):

```ts
type MaskProps = { maskMin: number; maskMax: number };
```

Then add the module (e.g. after `FilterNaN`, before `PerBandLinearRescale`):

```ts
/** Discards pixels whose red channel is outside [maskMin, maskMax]. Insert
 * BEFORE the rescale/clamp step so it sees raw sample values (in GPU-sample
 * units). Boundaries are inclusive. */
export const MaskOutsideRange = {
  name: "maskOutsideRange",
  fs: `uniform maskOutsideRangeUniforms {
  float maskMin;
  float maskMax;
} maskOutsideRange;
`,
  inject: {
    "fs:DECKGL_FILTER_COLOR": `
  if (color.r < maskOutsideRange.maskMin || color.r > maskOutsideRange.maskMax) {
    discard;
  }
`,
  },
  uniformTypes: {
    maskMin: "f32",
    maskMax: "f32",
  },
  getUniforms: (props: Partial<MaskProps>) => ({
    maskMin: props.maskMin ?? 0,
    maskMax: props.maskMax ?? 1,
  }),
} as const;
```

- [ ] **Step 4: Wire it into the single-band pipeline**

In `src/render/single-band-pipeline.ts`:

(a) Add `MaskOutsideRange` to the `./shader-modules` import block (`:13-19`):

```ts
import {
  FilterNaN,
  Gamma,
  LogStretch,
  MaskOutsideRange,
  PerBandLinearRescale,
  SqrtStretch,
} from "./shader-modules";
```

(b) Add the field to `SingleBandRenderState` (after `nodata` at `:55`):

```ts
  /** When true, discard pixels outside the resolved rescale window. */
  maskOutsideRescale: boolean;
```

(c) In `buildSingleBandRenderTile`'s `renderTile`, replace the rescale block (`:145-163`) — insert the mask push inside `if (rescale)`, before the `PerBandLinearRescale` push:

```ts
    const rescale = resolveRescale(state, autoStats);
    if (rescale) {
      const [lo, hi] = rescale;
      if (state.maskOutsideRescale) {
        pipeline.push({
          module: MaskOutsideRange,
          props: {
            maskMin: lo / data.sampleScale,
            maskMax: hi / data.sampleScale,
          },
        });
      }
      pipeline.push({
        module: PerBandLinearRescale,
        props: {
          rescaleMin: [
            lo / data.sampleScale,
            lo / data.sampleScale,
            lo / data.sampleScale,
          ],
          rescaleMax: [
            hi / data.sampleScale,
            hi / data.sampleScale,
            hi / data.sampleScale,
          ],
        },
      });
    }
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm test -- mask-outside-rescale`
Expected: PASS (5 single-band tests green)

- [ ] **Step 6: Commit**

```bash
git add src/render/shader-modules.ts src/render/single-band-pipeline.ts src/render/mask-outside-rescale.test.ts
git commit -m "feat(mask): MaskOutsideRange module + single-band pipeline wiring (#54)"
```

---

### Task 3: Texture-array pipeline wiring

**Files:**
- Modify: `src/render/texture-array-pipeline.ts` (add field to `TextureArrayRenderState`, import + insert module)
- Test: `src/render/mask-outside-rescale.test.ts` (append texture-array cases)

**Interfaces:**
- Consumes: `MaskOutsideRange` (Task 2), `LinearRescale` (package), `TextureArrayTileData`.
- Produces: `TextureArrayRenderState` gains `maskOutsideRescale: boolean`.

- [ ] **Step 1: Write the failing test**

Append to `src/render/mask-outside-rescale.test.ts` these imports at the top (add to existing import lines):

```ts
import { LinearRescale } from "@developmentseed/deck.gl-raster/gpu-modules";
import {
  buildTextureArrayRenderTile,
  type TextureArrayTileData,
} from "./texture-array-pipeline";
```

Then append a new `describe` block at the end of the file:

```ts
describe("texture-array pipeline: mask outside rescale", () => {
  const baseTexState = {
    frameIndex: 0,
    colormap: "viridis",
    gamma: 1,
    stretch: "linear" as const,
  };
  // renderTile only reads `data.texture`; cast a minimal stub.
  const data = { texture: fakeTexture } as unknown as TextureArrayTileData;

  it("omits the mask module when maskOutsideRescale is false", () => {
    const renderTile = buildTextureArrayRenderTile(
      { ...baseTexState, rescale: [10, 20], maskOutsideRescale: false },
      fakeTexture,
      null,
    );
    const pipe = renderTile(data).renderPipeline as Mod[];
    expect(pipe.some((m) => m.module === MaskOutsideRange)).toBe(false);
  });

  it("inserts the mask module immediately before rescale with raw bounds", () => {
    const renderTile = buildTextureArrayRenderTile(
      { ...baseTexState, rescale: [10, 20], maskOutsideRescale: true },
      fakeTexture,
      null,
    );
    const pipe = renderTile(data).renderPipeline as Mod[];
    const maskIdx = pipe.findIndex((m) => m.module === MaskOutsideRange);
    const rescaleIdx = pipe.findIndex((m) => m.module === LinearRescale);
    expect(maskIdx).toBeGreaterThanOrEqual(0);
    expect(maskIdx + 1).toBe(rescaleIdx);
    expect(pipe[maskIdx]!.props).toEqual({ maskMin: 10, maskMax: 20 });
  });

  it("does not mask when no window resolves", () => {
    const renderTile = buildTextureArrayRenderTile(
      { ...baseTexState, rescale: null, maskOutsideRescale: true },
      fakeTexture,
      null,
    );
    const pipe = renderTile(data).renderPipeline as Mod[];
    expect(pipe.some((m) => m.module === MaskOutsideRange)).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test -- mask-outside-rescale`
Expected: FAIL — `maskOutsideRescale` is not a valid `TextureArrayRenderState` field; mask module never inserted.

- [ ] **Step 3: Wire it into the texture-array pipeline**

In `src/render/texture-array-pipeline.ts`:

(a) Add `MaskOutsideRange` to the `./shader-modules` import (currently `import { Gamma, LogStretch, SqrtStretch } from "./shader-modules";`):

```ts
import { Gamma, LogStretch, MaskOutsideRange, SqrtStretch } from "./shader-modules";
```

(b) Add the field to `TextureArrayRenderState` (after `stretch` at `:368`):

```ts
  /** When true, discard pixels outside the resolved rescale window. */
  maskOutsideRescale: boolean;
```

(c) In `buildTextureArrayRenderTile`'s `renderTile`, replace the rescale block (`:410-415`):

```ts
    if (rescale) {
      if (state.maskOutsideRescale) {
        pipeline.push({
          module: MaskOutsideRange,
          props: { maskMin: rescale[0], maskMax: rescale[1] },
        });
      }
      pipeline.push({
        module: LinearRescale,
        props: { rescaleMin: rescale[0], rescaleMax: rescale[1] },
      });
    }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm test -- mask-outside-rescale`
Expected: PASS (all single-band + texture-array cases green)

- [ ] **Step 5: Commit**

```bash
git add src/render/texture-array-pipeline.ts src/render/mask-outside-rescale.test.ts
git commit -m "feat(mask): texture-array pipeline wiring (#54)"
```

---

### Task 4: GPU profile wiring (scalar-grid + multiscale-grid)

**Files:**
- Modify: `src/zarr/profiles/scalar-grid/profile.ts` (pass field into both render states + `updateTriggers`)
- Modify: `src/zarr/profiles/multiscale-grid/profile.ts` (pass field + `updateTriggers`)

**Interfaces:**
- Consumes: `chassisState.maskOutsideRescale` (Task 1); `SingleBandRenderState.maskOutsideRescale` / `TextureArrayRenderState.maskOutsideRescale` (Tasks 2–3).

No unit test: `buildLayer` constructs a live `ZarrLayer` (deck.gl runtime) and there is no existing harness for it. Verified by `tsc -b` (the render-state types now *require* the field, so a missing wire-up is a compile error) plus the manual smoke check in Task 8.

- [ ] **Step 1: Wire scalar-grid — texture-array render state**

In `src/zarr/profiles/scalar-grid/profile.ts`, in the `buildTextureArrayRenderTile` call (`:864-874`), add the field to the state object (after `stretch: chassisState.stretch,` at `:870`):

```ts
          maskOutsideRescale: chassisState.maskOutsideRescale,
```

And add it to that layer's `updateTriggers.renderTile` array (`:890-898`), after `chassisState.stretch,`:

```ts
            chassisState.maskOutsideRescale,
```

- [ ] **Step 2: Wire scalar-grid — single-band render state**

In the `buildSingleBandRenderTile` call (`:903-913`), add after `stretch: chassisState.stretch,` (`:908`):

```ts
        maskOutsideRescale: chassisState.maskOutsideRescale,
```

And in that layer's `updateTriggers.renderTile` array (`:925-933`), after `chassisState.stretch,`:

```ts
          chassisState.maskOutsideRescale,
```

- [ ] **Step 3: Wire multiscale-grid**

In `src/zarr/profiles/multiscale-grid/profile.ts`, in the `buildSingleBandRenderTile` call (`:204-214`), add after `stretch: chassisState.stretch,` (`:209`):

```ts
        maskOutsideRescale: chassisState.maskOutsideRescale,
```

And in the `updateTriggers.renderTile` array (`:237-245`), after `chassisState.stretch,`:

```ts
          chassisState.maskOutsideRescale,
```

- [ ] **Step 4: Typecheck / build**

Run: `pnpm build`
Expected: PASS (`tsc -b` clean — proves every single-band render-state construction now supplies `maskOutsideRescale`; a missed site would be a TS2741 "property missing" error).

- [ ] **Step 5: Commit**

```bash
git add src/zarr/profiles/scalar-grid/profile.ts src/zarr/profiles/multiscale-grid/profile.ts
git commit -m "feat(mask): thread maskOutsideRescale into GPU profiles + updateTriggers (#54)"
```

---

### Task 5: Chassis UI checkbox (ControlsPanel)

**Files:**
- Modify: `src/components/ControlsPanel.tsx` (checkbox under `RescaleEditor`, single-band block)

**Interfaces:**
- Consumes: `state.maskOutsideRescale` + `update` (already in scope in this component).

UI wiring verified by `tsc -b` + the manual smoke check in Task 8.

- [ ] **Step 1: Add the checkbox**

In `src/components/ControlsPanel.tsx`, immediately after the `<RescaleEditor ... />` element (`:144-148`), add:

```tsx
                <label
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                    cursor: "pointer",
                  }}
                >
                  <input
                    type="checkbox"
                    checked={state.maskOutsideRescale}
                    onChange={(e) =>
                      update({ maskOutsideRescale: e.target.checked })
                    }
                  />
                  <span
                    className="field-label"
                    style={{ textTransform: "none" }}
                  >
                    Mask values outside range
                  </span>
                </label>
```

- [ ] **Step 2: Typecheck / build**

Run: `pnpm build`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/components/ControlsPanel.tsx
git commit -m "feat(mask): chassis 'Mask values outside range' checkbox (#54)"
```

---

### Task 6: CPU image path — `styleToRgba` mask parameter

**Files:**
- Modify: `src/components/image-normalize.ts` (add `maskOutside` param + alpha branch)
- Test: `src/components/image-normalize.test.ts` (alpha assertions)

**Interfaces:**
- Produces: `styleToRgba(data, width, height, min, max, gamma, lut?, maskOutside = false)` — out-of-range pixels get alpha `0` when `maskOutside` is true.

- [ ] **Step 1: Write the failing tests**

Append to `src/components/image-normalize.test.ts` (inside the `describe("styleToRgba", ...)` block):

```ts
  it("masks out-of-range pixels (alpha 0) when maskOutside is true", () => {
    // window [0,100]: -50 below, 50 inside, 200 above.
    const rgba = styleToRgba([-50, 50, 200], 3, 1, 0, 100, 1, null, true);
    expect(rgba[3]).toBe(0); // below → transparent
    expect(rgba[7]).toBe(255); // inside → opaque
    expect(rgba[11]).toBe(0); // above → transparent
  });

  it("keeps window-boundary values opaque when masking", () => {
    // Exactly at min (0) and max (100) are inclusive → kept.
    const rgba = styleToRgba([0, 100], 2, 1, 0, 100, 1, null, true);
    expect(rgba[3]).toBe(255);
    expect(rgba[7]).toBe(255);
  });

  it("keeps all pixels opaque when maskOutside is false", () => {
    const rgba = styleToRgba([-50, 200], 2, 1, 0, 100, 1, null, false);
    expect(rgba[3]).toBe(255);
    expect(rgba[7]).toBe(255);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm test -- image-normalize`
Expected: FAIL — `styleToRgba` ignores the 8th arg; out-of-range pixels stay `255`.

- [ ] **Step 3: Implement the mask branch**

In `src/components/image-normalize.ts`:

(a) Add the parameter to the signature (after `lut?` at `:16`):

```ts
  lut?: Uint8Array | null,
  maskOutside = false,
): Uint8ClampedArray<ArrayBuffer> {
```

(b) In the loop, replace the two lines (`:24-25`):

```ts
    let t = (Number(data[i]) - min) / span;
    t = t <= 0 ? 0 : t >= 1 ? 1 : t;
```

with:

```ts
    const raw = (Number(data[i]) - min) / span;
    const outside = raw < 0 || raw > 1;
    let t = raw <= 0 ? 0 : raw >= 1 ? 1 : raw;
```

(c) Replace the alpha write (`:39`):

```ts
    rgba[o + 3] = 255;
```

with:

```ts
    rgba[o + 3] = maskOutside && outside ? 0 : 255;
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm test -- image-normalize`
Expected: PASS (new + existing cases green)

- [ ] **Step 5: Commit**

```bash
git add src/components/image-normalize.ts src/components/image-normalize.test.ts
git commit -m "feat(mask): styleToRgba maskOutside alpha branch (CPU path) (#54)"
```

---

### Task 7: Image profile mask field + URL round-trip

**Files:**
- Modify: `src/zarr/profiles/image-orthographic/types.ts` (add field to `ImageOrthographicState`)
- Modify: `src/zarr/profiles/image-orthographic/profile.ts` (`initialState`, `parseUrlParams`, `serializeUrlParams`)
- Test: `src/zarr/profiles/image-orthographic/mask-params.test.ts` (new file)

**Interfaces:**
- Produces: `ImageOrthographicState.maskOutsideRescale: boolean` (default `false`); profile URL key `mask` (`"1"` / cleared).

- [ ] **Step 1: Write the failing test**

Create `src/zarr/profiles/image-orthographic/mask-params.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { imageOrthographicProfile } from "./profile";
import type { ImageOrthographicState } from "./types";

const baseState: ImageOrthographicState = {
  channel: 0,
  indices: {},
  colormap: "gray",
  gamma: 1,
  rescale: null,
  maskOutsideRescale: false,
};

describe("image-orthographic mask URL param", () => {
  it("parses mask=1 into maskOutsideRescale: true", () => {
    expect(
      imageOrthographicProfile.parseUrlParams(new URLSearchParams("mask=1"))
        .maskOutsideRescale,
    ).toBe(true);
  });

  it("leaves maskOutsideRescale unset when the param is absent", () => {
    expect(
      imageOrthographicProfile.parseUrlParams(new URLSearchParams())
        .maskOutsideRescale,
    ).toBeUndefined();
  });

  it("serializes mask=1 when on and clears it when off", () => {
    expect(
      imageOrthographicProfile.serializeUrlParams({
        ...baseState,
        maskOutsideRescale: true,
      }).mask,
    ).toBe("1");
    expect(
      imageOrthographicProfile.serializeUrlParams({
        ...baseState,
        maskOutsideRescale: false,
      }).mask,
    ).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test -- mask-params`
Expected: FAIL — `maskOutsideRescale` is not on `ImageOrthographicState`; `serializeUrlParams` output has no `mask` key.

- [ ] **Step 3: Add the field**

In `src/zarr/profiles/image-orthographic/types.ts`, add to `ImageOrthographicState` (after the `rescale` field at `:84`):

```ts
  /** When true, discard (make transparent) pixels outside the rescale window
   * instead of clamping them. Default false. */
  maskOutsideRescale: boolean;
```

- [ ] **Step 4: Wire initialState / parse / serialize**

In `src/zarr/profiles/image-orthographic/profile.ts`:

(a) `initialState` return object (after `rescale: null,` at `:78`):

```ts
      maskOutsideRescale: false,
```

(b) `parseUrlParams`, before `return out;` (`:108`):

```ts
    if (p.get("mask") === "1") out.maskOutsideRescale = true;
```

(c) `serializeUrlParams`, add to the `out` object literal (after the `rmax:` line at `:118`):

```ts
      mask: s.maskOutsideRescale ? "1" : null,
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm test -- mask-params`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/zarr/profiles/image-orthographic/types.ts src/zarr/profiles/image-orthographic/profile.ts src/zarr/profiles/image-orthographic/mask-params.test.ts
git commit -m "feat(mask): image profile maskOutsideRescale state + URL round-trip (#54)"
```

---

### Task 8: Image path — `ImageViewer` threading + image controls checkbox

**Files:**
- Modify: `src/components/ImageViewer.tsx` (pass `state.maskOutsideRescale` to `styleToRgba`)
- Modify: `src/zarr/profiles/image-orthographic/controls.tsx` (checkbox in styling group)

**Interfaces:**
- Consumes: `styleToRgba(..., maskOutside)` (Task 6); `ImageOrthographicState.maskOutsideRescale` (Task 7).

Verified by `tsc -b` + the manual smoke check below.

- [ ] **Step 1: Thread the flag through ImageViewer**

In `src/components/ImageViewer.tsx`, update the `styleToRgba` call (`:310`):

```tsx
    const rgba = styleToRgba(
      current.raw,
      current.winW,
      current.winH,
      mn,
      mx,
      state.gamma,
      lut,
      state.maskOutsideRescale,
    );
```

And add `state.maskOutsideRescale` to the `useMemo` dependency array (`:312`):

```tsx
  }, [current, rmin, rmax, state.gamma, lut, autoStats, state.maskOutsideRescale]);
```

- [ ] **Step 2: Add the image controls checkbox**

In `src/zarr/profiles/image-orthographic/controls.tsx`, in the `group === "styling"` branch, immediately after the `<RescaleControl ... />` element, add:

```tsx
        <label
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            cursor: "pointer",
          }}
        >
          <input
            type="checkbox"
            checked={state.maskOutsideRescale}
            onChange={(e) => update({ maskOutsideRescale: e.target.checked })}
          />
          <span className="field-label" style={{ textTransform: "none" }}>
            Mask values outside range
          </span>
        </label>
```

- [ ] **Step 3: Typecheck / build**

Run: `pnpm build`
Expected: PASS

- [ ] **Step 4: Full test suite**

Run: `pnpm test`
Expected: PASS (all suites, including the new `mask-outside-rescale`, `image-normalize`, `mask-params`, and `state` cases).

- [ ] **Step 5: Manual smoke check**

Run: `pnpm dev`, then in the browser:
1. Open a single-band scalar-grid store (map profile). In the Styling panel, set a rescale window narrower than the data range, then toggle **Mask values outside range** on → pixels outside the window become transparent (basemap shows through); toggle off → they return to the colormap end colors. Confirm the URL gains/loses `&mask=1`, and that reloading the `mask=1` URL restores the masked view.
2. Open an OME-Zarr store (`?p=image-orthographic`). Repeat the toggle in its Styling panel → out-of-window pixels become transparent.

- [ ] **Step 6: Commit**

```bash
git add src/components/ImageViewer.tsx src/zarr/profiles/image-orthographic/controls.tsx
git commit -m "feat(mask): image viewer threading + image controls checkbox (#54)"
```

---

## Self-Review

**Spec coverage:**
- §1 chassis state & URL → Task 1. ✓
- §2 shader module → Task 2. ✓
- §3 GPU pipeline wiring (single-band + texture-array) → Tasks 2, 3. ✓
- §4 profile wiring + updateTriggers → Task 4. ✓
- §5 CPU image path (profile field, params, `styleToRgba`, `ImageViewer`) → Tasks 6, 7, 8. ✓
- §6 UI (chassis checkbox + image checkbox) → Tasks 5, 8. ✓
- Testing (pipeline module presence/props/order, CPU alpha, chassis parse, image round-trip) → Tasks 1, 2, 3, 6, 7. ✓
- Out of scope: band-composite — untouched. ✓

**Type consistency:** Field name `maskOutsideRescale` is identical across `ViewerState`, `SingleBandRenderState`, `TextureArrayRenderState`, and `ImageOrthographicState`. Shader module `MaskOutsideRange` with props `{ maskMin, maskMax }` is referenced identically in Tasks 2, 3 and both tests. `styleToRgba`'s new trailing `maskOutside` param matches between Task 6 (definition) and Task 8 (call).

**Placeholder scan:** No TBD/TODO; every code step shows complete code.
