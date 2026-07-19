import { useEffect, useState } from "react";
import { StepperRange } from "./StepperRange";
import { tintLabelStyle } from "../zarr/dim-colors";

const COMMIT_DELAY_MS = 200;

type Props = {
  label: string;
  /** Committed value (from URL state). */
  value: number;
  min: number;
  max: number;
  /** Called with the debounced value when the user pauses for COMMIT_DELAY_MS. */
  onCommit: (next: number) => void;
  /** Formatter for the right-aligned value badge. */
  formatValue?: (v: number) => string;
  /** Optional subtle background tint pairing this slider with its row in the
   * Dimensions table (see {@link dimTint}). */
  tint?: string;
};

/**
 * A range slider that updates a local "draft" value continuously while
 * the user drags but only commits to `onCommit` after a short idle delay.
 * Use it for state changes that trigger expensive work (e.g. layer
 * re-creation + tile refetches). Sliders whose changes are cheap (e.g.
 * shader uniforms) should use a plain `<input type="range">` instead.
 */
export function DebouncedSlider({
  label,
  value,
  min,
  max,
  onCommit,
  formatValue,
  tint,
}: Props) {
  const [draft, setDraft] = useState(value);

  // Sync draft when the committed value changes from outside (URL load,
  // example pick, etc.).
  useEffect(() => {
    setDraft(value);
  }, [value]);

  // Debounced commit: schedule one commit COMMIT_DELAY_MS after the last
  // draft change. New drafts within the window cancel the prior commit.
  useEffect(() => {
    if (draft === value) return;
    const t = setTimeout(() => onCommit(draft), COMMIT_DELAY_MS);
    return () => clearTimeout(t);
  }, [draft, value, onCommit]);

  const display = formatValue ? formatValue(draft) : String(draft);
  // Group, not a <label>: a <label> would associate with StepperRange's first
  // button and double-fire its clicks in some embedded webviews (see
  // PlaybackSlider for the full explanation).
  return (
    <div role="group" aria-label={label} style={tintLabelStyle(tint)}>
      <span
        className="field-label"
        style={{ display: "flex", justifyContent: "space-between" }}
      >
        <span>{label}</span>
        <span className="mono" style={{ textTransform: "none" }}>
          {display}
        </span>
      </span>
      <StepperRange value={draft} min={min} max={max} onChange={setDraft} />
    </div>
  );
}
