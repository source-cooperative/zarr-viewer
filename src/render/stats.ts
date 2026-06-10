export const HISTOGRAM_BINS = 128;

export type BandStats = {
  min: number;
  max: number;
  /** Bin counts evenly distributed over [min, max]. Length = HISTOGRAM_BINS. */
  histogram: number[];
};

export type AutoStats = {
  perBand: Map<number, BandStats> | null;
  global: BandStats | null;
};

/** Linear-interpolated percentile from a histogram. `p` is in [0, 1]. */
export function percentileFromHistogram(stats: BandStats, p: number): number {
  const total = stats.histogram.reduce((a, b) => a + b, 0);
  if (total === 0) return p < 0.5 ? stats.min : stats.max;
  const target = total * p;
  let acc = 0;
  const range = stats.max - stats.min;
  if (range <= 0) return stats.min;
  const binWidth = range / stats.histogram.length;
  for (let i = 0; i < stats.histogram.length; i++) {
    const count = stats.histogram[i] ?? 0;
    if (acc + count >= target) {
      const fraction = count > 0 ? (target - acc) / count : 0;
      return stats.min + (i + fraction) * binWidth;
    }
    acc += count;
  }
  return stats.max;
}

/** Two-pass min/max + histogram over an iterable of sample values: first to
 * find min/max (skipping nodata + non-finite), then to bin.
 *
 * Returns null ONLY when there are no valid samples. Constant data (all valid
 * values equal — e.g. a snow field that's 0 everywhere it was sampled) yields a
 * degenerate `min === max` stat with every count in the first bin, NOT null:
 * returning null there is indistinguishable from "no data" and permanently
 * locks the rescale UI on "Adjust once data statistics load." Consumers handle
 * the zero-width range (`percentileFromHistogram` returns the constant; the
 * rescale editor pads the slider bounds). */
export function buildBandStats(
  values: ArrayLike<number>,
  nodata: number | null,
): BandStats | null {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  let count = 0;
  for (let i = 0; i < values.length; i++) {
    const v = values[i] as number;
    if (nodata !== null && v === nodata) continue;
    if (!Number.isFinite(v)) continue;
    if (v < min) min = v;
    if (v > max) max = v;
    count++;
  }
  if (count === 0) return null;
  if (!(min < max)) {
    // Constant data: a valid but zero-width range. One filled bin keeps the
    // stat usable downstream instead of being mistaken for "no data".
    const histogram = new Array<number>(HISTOGRAM_BINS).fill(0);
    histogram[0] = count;
    return { min, max, histogram };
  }
  const histogram = new Array<number>(HISTOGRAM_BINS).fill(0);
  const scale = HISTOGRAM_BINS / (max - min);
  for (let i = 0; i < values.length; i++) {
    const v = values[i] as number;
    if (nodata !== null && v === nodata) continue;
    if (!Number.isFinite(v)) continue;
    let idx = Math.floor((v - min) * scale);
    if (idx < 0) idx = 0;
    if (idx >= HISTOGRAM_BINS) idx = HISTOGRAM_BINS - 1;
    histogram[idx]++;
  }
  return { min, max, histogram };
}

/** Wrap a `BandStats` as a single-band `AutoStats`. */
export function autoStatsFromGlobal(stats: BandStats): AutoStats {
  return {
    perBand: new Map([[1, stats]]),
    global: stats,
  };
}
