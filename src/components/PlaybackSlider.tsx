import { StepperRange } from "./StepperRange";
import { tintLabelStyle } from "../zarr/dim-colors";

type Props = {
  label: string;
  value: number;
  min: number;
  max: number;
  playing: boolean;
  speed: number;
  onToggle: () => void;
  onCycleSpeed: () => void;
  onSeek: (next: number) => void;
  formatValue: (v: number) => string;
  tint?: string;
};

/** The "live" texture-array dim scrubber with a podcast-style transport:
 * play/pause + a tap-to-cycle speed chip above the existing StepperRange.
 * Seeking (drag or step) pauses playback and commits the frame (via onSeek). */
export function PlaybackSlider({
  label,
  value,
  min,
  max,
  playing,
  speed,
  onToggle,
  onCycleSpeed,
  onSeek,
  formatValue,
  tint,
}: Props) {
  // NOTE: this is a <div role="group">, not a <label>. A <label> would
  // implicitly associate with its first labelable descendant (the Play button)
  // and some embedded webviews (e.g. Cursor's preview) then double-fire that
  // button's click via the label — toggling play on then off, so Play appears
  // to do nothing. A group has no such click-forwarding.
  return (
    <div role="group" aria-label={label} style={tintLabelStyle(tint)}>
      <span
        className="field-label"
        style={{ display: "flex", justifyContent: "space-between" }}
      >
        <span>{label}</span>
        <span className="mono" style={{ textTransform: "none" }}>
          {formatValue(value)}
        </span>
      </span>
      <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4 }}>
        <button
          type="button"
          className="step-btn"
          aria-label={playing ? "Pause" : "Play"}
          aria-pressed={playing}
          onClick={onToggle}
        >
          {playing ? <PauseIcon /> : <PlayIcon />}
        </button>
        <button
          type="button"
          className="mono"
          aria-label={`Playback speed ${speed}×`}
          onClick={onCycleSpeed}
          style={{
            fontSize: 12,
            padding: "2px 8px",
            border: "1px solid var(--border, #444)",
            borderRadius: 4,
            background: "transparent",
            color: "inherit",
            cursor: "pointer",
            minWidth: 40,
          }}
        >
          {speed}×
        </button>
      </div>
      <StepperRange value={value} min={min} max={max} onChange={onSeek} />
    </div>
  );
}

function PlayIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <polygon points="6 4 20 12 6 20 6 4" />
    </svg>
  );
}

function PauseIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <rect x="6" y="4" width="4" height="16" />
      <rect x="14" y="4" width="4" height="16" />
    </svg>
  );
}
