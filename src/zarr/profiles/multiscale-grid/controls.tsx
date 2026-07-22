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
