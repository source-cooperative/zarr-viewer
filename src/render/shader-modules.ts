type RescaleProps = { rescaleMin: [number, number, number]; rescaleMax: [number, number, number] };
type GammaProps = { gamma: number };
type LogStretchProps = { strength: number };
type MaskProps = { maskMin: number; maskMax: number };

/** Discards pixels whose red channel is NaN. */
export const FilterNaN = {
  name: "filterNaN",
  inject: {
    "fs:DECKGL_FILTER_COLOR": `
  if (isnan(color.r)) {
    discard;
  }
`,
  },
} as const;

/** Sentinel bound for {@link MaskOutsideRange} when one side of the mask is
 * disabled — a value no real sample reaches, so that side never discards.
 * Roughly ±FLT_MAX. Lets one module express below-only, above-only, or both. */
export const MASK_NO_LOWER = -3.4e38;
export const MASK_NO_UPPER = 3.4e38;

/** Discards pixels whose red channel is outside [maskMin, maskMax]. Insert
 * BEFORE the rescale/clamp step so it sees raw sample values (in GPU-sample
 * units). Boundaries are inclusive. Pass {@link MASK_NO_LOWER}/{@link
 * MASK_NO_UPPER} for a side that should not mask. */
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

/** Per-channel linear rescale. Same as the shipped `LinearRescale` but vec3. */
export const PerBandLinearRescale = {
  name: "perBandRescale",
  fs: `uniform perBandRescaleUniforms {
  vec3 rescaleMin;
  vec3 rescaleMax;
} perBandRescale;
`,
  inject: {
    "fs:DECKGL_FILTER_COLOR": `
  color.rgb = clamp(
    (color.rgb - perBandRescale.rescaleMin) /
      max(perBandRescale.rescaleMax - perBandRescale.rescaleMin, vec3(1e-9)),
    0.0, 1.0);
`,
  },
  uniformTypes: {
    rescaleMin: "vec3<f32>",
    rescaleMax: "vec3<f32>",
  },
  getUniforms: (props: Partial<RescaleProps>) => ({
    rescaleMin: props.rescaleMin ?? [0, 0, 0],
    rescaleMax: props.rescaleMax ?? [1, 1, 1],
  }),
} as const;

export const Gamma = {
  name: "gammaModule",
  fs: `uniform gammaModuleUniforms {
  float gammaValue;
} gammaModule;
`,
  inject: {
    "fs:DECKGL_FILTER_COLOR": `
  color.rgb = pow(clamp(color.rgb, 0.0, 1.0), vec3(1.0 / max(gammaModule.gammaValue, 0.0001)));
`,
  },
  uniformTypes: {
    gammaValue: "f32",
  },
  getUniforms: (props: Partial<GammaProps>) => ({
    gammaValue: props.gamma ?? 1.0,
  }),
} as const;

export const SqrtStretch = {
  name: "sqrtStretch",
  inject: {
    "fs:DECKGL_FILTER_COLOR": `
  color.rgb = sqrt(clamp(color.rgb, 0.0, 1.0));
`,
  },
} as const;

export const LogStretch = {
  name: "logStretch",
  fs: `uniform logStretchUniforms {
  float strength;
} logStretch;
`,
  inject: {
    "fs:DECKGL_FILTER_COLOR": `
  {
    float k = max(logStretch.strength, 0.0001);
    vec3 x = clamp(color.rgb, 0.0, 1.0);
    color.rgb = log(1.0 + k * x) / log(1.0 + k);
  }
`,
  },
  uniformTypes: {
    strength: "f32",
  },
  getUniforms: (props: Partial<LogStretchProps>) => ({
    strength: props.strength ?? 99,
  }),
} as const;
