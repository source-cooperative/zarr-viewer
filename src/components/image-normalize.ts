/** Map raw intensities to a packed grayscale RGBA buffer (R=G=B=intensity,
 * A=255) via a linear display window. When no usable window is supplied
 * (missing, or `end <= start`), scans the data for its min/max instead.
 * Non-finite samples clamp to the window floor. Returns the raw bytes — the
 * caller wraps them in `ImageData` (a canvas API absent in jsdom), keeping this
 * pure and testable. */
export function toGrayscaleRgba(
  data: ArrayLike<number>,
  width: number,
  height: number,
  winStart?: number,
  winEnd?: number,
): Uint8ClampedArray<ArrayBuffer> {
  const n = width * height;
  const { lo, span } = resolveWindow(data, n, winStart, winEnd);
  const rgba = new Uint8ClampedArray(n * 4);
  for (let i = 0; i < n; i++) {
    const v = (Number(data[i]) - lo) / span;
    const byte = v <= 0 ? 0 : v >= 1 ? 255 : Math.round(v * 255);
    const o = i * 4;
    rgba[o] = byte;
    rgba[o + 1] = byte;
    rgba[o + 2] = byte;
    rgba[o + 3] = 255;
  }
  return rgba;
}

/** Pick the low bound + span for normalization: prefer an explicit, valid
 * window; otherwise derive it from the data extent (defaulting to [0,1] when
 * the data is empty/constant/non-finite). */
export function resolveWindow(
  data: ArrayLike<number>,
  n: number,
  winStart?: number,
  winEnd?: number,
): { lo: number; span: number } {
  if (winStart !== undefined && winEnd !== undefined && winEnd > winStart) {
    return { lo: winStart, span: winEnd - winStart };
  }
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < n; i++) {
    const v = Number(data[i]);
    if (!Number.isFinite(v)) continue;
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi <= lo) {
    return { lo: 0, span: 1 };
  }
  return { lo, span: hi - lo };
}
