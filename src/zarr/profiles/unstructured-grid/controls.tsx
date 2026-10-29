import { DebouncedSlider } from "../../../components/DebouncedSlider";
import { dimTint } from "../../dim-colors";
import type { ProfileControlsProps } from "../../profile";
import type { UnstructuredGridContext, UnstructuredGridState } from "./types";
import { defaultUnstructuredDimIndices } from "./types";

export function UnstructuredGridControls({
  ctx,
  state,
  update,
  group,
}: ProfileControlsProps<UnstructuredGridContext, UnstructuredGridState>) {
  if (group === "instant" || group === "styling") return null;

  const activeVar = ctx.variables.find((v) => v.name === state.variable);
  const tintOrder = (activeVar?.dims ?? []).map((d) => d.name);

  return (
    <div style={{ display: "grid", gap: 10 }}>
      <label style={{ display: "grid", gap: 4 }}>
        <span className="field-label">Variable</span>
        <select
          value={state.variable}
          onChange={(e) => {
            const next = ctx.variables.find((v) => v.name === e.target.value);
            update({
              variable: e.target.value,
              dimIndices: next ? defaultUnstructuredDimIndices(next) : {},
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
      {(activeVar?.dims ?? []).map((dim) => {
        const value = state.dimIndices[dim.name] ?? 0;
        const format =
          ctx.dimLabel[dim.name] ?? ((v: number) => `${v} / ${dim.size - 1}`);
        const tint = dimTint(dim.name, tintOrder);
        return (
          <DebouncedSlider
            key={dim.name}
            label={dim.name}
            value={value}
            min={0}
            max={Math.max(0, dim.size - 1)}
            onCommit={(v) =>
              update({ dimIndices: { ...state.dimIndices, [dim.name]: v } })
            }
            formatValue={format}
            tint={tint}
          />
        );
      })}
    </div>
  );
}
