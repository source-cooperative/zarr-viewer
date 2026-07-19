import { useEffect, useState } from "react";


/** Compact display for a numeric value: 4 significant figures, switching to
 * exponential for very small/large magnitudes. */
export function formatNumber(v: number): string {
  if (!Number.isFinite(v)) return "—";
  const a = Math.abs(v);
  if (a !== 0 && (a < 0.001 || a >= 100_000)) return v.toExponential(2);
  return String(Number(v.toPrecision(4)));
}

/** An editable number box that lets the user type freely (including partial
 * input like "-" or "1.") without the controlled value clobbering the text
 * mid-edit: it owns its text while focused and re-syncs to `value` (slider
 * drag, external change) only when blurred. Emits each valid numeric edit. */
function NumberBox({
  value,
  ariaLabel,
  align,
  onEdit,
}: {
  value: number;
  ariaLabel: string;
  align: "left" | "right";
  onEdit: (n: number) => void;
}) {
  const [text, setText] = useState(() => formatNumber(value));
  const [focused, setFocused] = useState(false);

  useEffect(() => {
    if (!focused) setText(formatNumber(value));
  }, [value, focused]);

  return (
    <input
      type="number"
      step="any"
      aria-label={ariaLabel}
      value={text}
      style={{ textAlign: align, fontSize: 12 }}
      onFocus={() => setFocused(true)}
      onBlur={() => {
        setFocused(false);
        setText(formatNumber(value));
      }}
      onChange={(e) => {
        const raw = e.target.value;
        setText(raw);
        if (raw === "") return;
        const n = Number(raw);
        if (Number.isFinite(n)) onEdit(n);
      }}
    />
  );
}

type Props = {
  /** Preferred track bounds (widened locally to include the handles). */
  min: number;
  max: number;
  /** Committed `[low, high]` (from state). */
  value: [number, number];
  /** Called with `[low, high]` on every change. */
  onCommit: (next: [number, number]) => void;
};

/**
 * A dual-handle range slider with editable min/max number boxes. Drags and
 * typed edits update a local draft (so handles + boxes move continuously) and
 * commit to `onCommit` immediately on every change. The handles can't cross
 * (each is clamped to the other), and the lower handle is raised above the
 * upper one in its top half so it stays grabbable when both sit near `max`.
 *
 * The track auto-widens: an edit (or value) outside the passed `[min, max]`
 * pushes that endpoint out so the handle stays on-track.
 */
export function RangeSlider({ min, max, value, onCommit }: Props) {
  const [vlo, vhi] = value;
  const [draft, setDraft] = useState<[number, number]>(value);

  // Re-sync the draft when the committed value changes from outside (reset,
  // URL load, example pick, new autoStats).
  useEffect(() => {
    setDraft([vlo, vhi]);
  }, [vlo, vhi]);

  const [lo, hi] = draft;
  // Widen the track to include the handles when an edit pushes one past the
  // passed bounds (the requirement: typing beyond the slider extends it).
  const trackMin = Math.min(min, lo, hi);
  const trackMax = Math.max(max, lo, hi);
  const span = trackMax - trackMin || 1;
  const loPct = ((lo - trackMin) / span) * 100;
  const hiPct = ((hi - trackMin) / span) * 100;
  const mid = (trackMin + trackMax) / 2;

  // Commit only on a real user edit — updating the draft AND emitting in the
  // same handler. Committing from an effect keyed on `value` instead would
  // also fire when `value` changes from outside (e.g. a rescale reset lands
  // the autoStats fallback), pushing the stale draft back and ping-ponging
  // `value` into an infinite update loop (issue #57).
  const setLo = (n: number) => {
    const next: [number, number] = [Math.min(n, hi), hi];
    setDraft(next);
    onCommit(next);
  };
  const setHi = (n: number) => {
    const next: [number, number] = [lo, Math.max(n, lo)];
    setDraft(next);
    onCommit(next);
  };

  return (
    <div style={{ display: "grid", gap: 4 }}>
      <div className="range-slider">
        <div className="range-slider-track" />
        <div
          className="range-slider-fill"
          style={{ left: `${loPct}%`, right: `${100 - hiPct}%` }}
        />
        <input
          type="range"
          className="range-slider-input"
          aria-label="rescale-min-handle"
          min={trackMin}
          max={trackMax}
          step="any"
          value={lo}
          // Keep the lower handle grabbable when both handles sit near max.
          style={{ zIndex: lo > mid ? 5 : 3 }}
          onChange={(e) => setLo(Number(e.target.value))}
        />
        <input
          type="range"
          className="range-slider-input"
          aria-label="rescale-max-handle"
          min={trackMin}
          max={trackMax}
          step="any"
          value={hi}
          style={{ zIndex: 4 }}
          onChange={(e) => setHi(Number(e.target.value))}
        />
      </div>
      <div style={{ display: "grid", gap: 4, gridTemplateColumns: "1fr 1fr" }}>
        <NumberBox
          value={lo}
          ariaLabel="rescale-min"
          align="left"
          onEdit={setLo}
        />
        <NumberBox
          value={hi}
          ariaLabel="rescale-max"
          align="right"
          onEdit={setHi}
        />
      </div>
    </div>
  );
}
