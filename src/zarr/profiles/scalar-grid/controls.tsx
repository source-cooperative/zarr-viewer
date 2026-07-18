import { DebouncedSlider } from "../../../components/DebouncedSlider";
import { PlaybackSlider } from "../../../components/PlaybackSlider";
import { StepperRange } from "../../../components/StepperRange";
import { dimTint, tintLabelStyle } from "../../dim-colors";
import type { ProfileControlsProps } from "../../profile";
import { defaultDimIndices, type ScalarGridContext, type ScalarGridState } from "./types";

export function ScalarGridControls({
  ctx,
  state,
  update,
  group,
  playback,
}: ProfileControlsProps<ScalarGridContext, ScalarGridState>) {
  const activeVar = ctx.variables.find((v) => v.name === state.variable);
  const texDim = activeVar?.textureDim ?? null;
  // Fully-packed dims that ride along in the cached chunk: scrubbing one
  // re-slices + re-uploads (no fetch/decode), so they belong with the instant
  // (texture) dim rather than the re-read dims.
  const memNames = new Set(activeVar?.memoryDims.map((d) => d.name) ?? []);
  // Full ordered list of this variable's non-spatial dims — the same order the
  // Dimensions table uses — so each dim gets a distinct tint that matches its
  // table row (see dimTint).
  const tintOrder = (activeVar?.dims ?? []).map((d) => d.name);

  const sliderFor = (
    dim: { name: string; size: number },
    mode: "live" | "cached" | "fetch",
  ) => {
    const value = state.dimIndices[dim.name] ?? 0;
    const onChange = (v: number) =>
      update({ dimIndices: { ...state.dimIndices, [dim.name]: v } });
    // CF-decoded label (date / duration / value) when available, else index.
    const format =
      ctx.dimLabel[dim.name] ?? ((v: number) => `${v} / ${dim.size - 1}`);
    // Pair the slider with its Dimensions-table row via a shared per-dim tint.
    const tint = dimTint(dim.name, tintOrder);
    if (mode === "live") {
      // "(live)" when the whole dim is GPU-resident; "(live · N/win)" when only
      // a window of N frames is loaded at a time (crossing a window refetches).
      const liveLabel =
        texDim && texDim.window < dim.size
          ? `${dim.name} (live · ${texDim.window}/win)`
          : `${dim.name} (live)`;
      // When the chassis provides a playback transport (an animatable dim),
      // render the play/pause + speed controls; else the plain live slider.
      if (playback) {
        return (
          <PlaybackSlider
            key={dim.name}
            label={liveLabel}
            value={value}
            min={0}
            max={Math.max(0, dim.size - 1)}
            playing={playback.playing}
            speed={playback.speed}
            onToggle={playback.toggle}
            onCycleSpeed={playback.cycleSpeed}
            onSeek={playback.seekTo}
            formatValue={format}
            tint={tint}
          />
        );
      }
      return (
        <LiveSlider
          key={dim.name}
          label={liveLabel}
          value={value}
          min={0}
          max={Math.max(0, dim.size - 1)}
          onChange={onChange}
          formatValue={format}
          tint={tint}
        />
      );
    }
    // "cached": already in the fetched chunk → re-slice on commit (no refetch).
    // "fetch": a genuine re-read on commit.
    return (
      <DebouncedSlider
        key={dim.name}
        label={mode === "cached" ? `${dim.name} (cached)` : dim.name}
        value={value}
        min={0}
        max={Math.max(0, dim.size - 1)}
        onCommit={onChange}
        formatValue={format}
        tint={tint}
      />
    );
  };

  if (group === "styling") return null;

  // Instant bucket: the texture-array dim (free shader uniform) plus the
  // fully-packed memory dims (cheap in-memory slice + re-upload, no refetch).
  if (group === "instant") {
    const dims = (activeVar?.dims ?? []).filter(
      (d) => d.name === texDim?.name || memNames.has(d.name),
    );
    if (dims.length === 0) return null;
    return (
      <div style={{ display: "grid", gap: 10 }}>
        {dims.map((d) =>
          sliderFor(d, d.name === texDim?.name ? "live" : "cached"),
        )}
      </div>
    );
  }

  // Fetch bucket: variable picker + every non-texture dim (each refetches).
  return (
    <div style={{ display: "grid", gap: 10 }}>
      <label style={{ display: "grid", gap: 4 }}>
        <span className="field-label">Variable</span>
        <select
          value={state.variable}
          onChange={(e) => {
            const next = ctx.variables.find((v) => v.name === e.target.value);
            // Reset dim indices to sensible defaults for the new variable —
            // its dim set (and sizes) may differ from the current one.
            update({
              variable: e.target.value,
              dimIndices: next ? defaultDimIndices(next) : {},
            });
          }}
        >
          {ctx.variables.map((v) => (
            <option key={v.name} value={v.name}>
              {v.longName ? `${v.name} — ${v.longName}` : v.name}
            </option>
          ))}
        </select>
        {activeVar?.units && (
          <span className="mono" style={{ color: "var(--text-muted)" }}>
            units: {activeVar.units}
          </span>
        )}
      </label>
      {activeVar?.dims
        .filter((dim) => dim.name !== texDim?.name && !memNames.has(dim.name))
        .map((dim) => sliderFor(dim, "fetch"))}
    </div>
  );
}

/** Controlled slider with no debounce — every change fires `onChange`. Use
 * for the texture-array dim, which updates a shader uniform (no refetch). */
function LiveSlider({
  label,
  value,
  min,
  max,
  onChange,
  formatValue,
  tint,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  onChange: (next: number) => void;
  formatValue: (v: number) => string;
  tint?: string;
}) {
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
          {formatValue(value)}
        </span>
      </span>
      <StepperRange value={value} min={min} max={max} onChange={onChange} />
    </div>
  );
}
