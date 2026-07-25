import { DebouncedSlider } from "../../../components/DebouncedSlider";
import type { ProfileControlsProps } from "../../profile";
import {
  defaultDimIndices,
  type MultiscaleGridContext,
  type MultiscaleGridState,
  type Pyramid,
  selectedPyramid,
} from "./types";

/** Default variable for a pyramid: prefer NDVI, else the first. Mirrors the
 * profile's `initialState` so switching pyramids lands on a sensible variable. */
function defaultVarOf(p: Pyramid): string {
  return p.variables.find((v) => v.name === "NDVI")?.name ?? p.variables[0]!.name;
}

export function MultiscaleGridControls({
  ctx, state, update, group,
}: ProfileControlsProps<MultiscaleGridContext, MultiscaleGridState>) {
  if (group === "instant") return null;
  const p = selectedPyramid(ctx, state);
  const activeVar = p.variables.find((v) => v.name === state.variable);

  if (group === "styling") {
    return (
      <div className="field-label" style={{ textTransform: "none" }}>
        <span className="mono" style={{ color: "var(--text-muted)" }}>
          {p.prefix ? `${p.label} · ` : ""}
          {state.variable} · {p.levelCount}-level pyramid · {p.crsCode ?? "projected"}
        </span>
      </div>
    );
  }

  // "fetch" bucket: pyramid picker (when >1) + variable picker (when >1) + a
  // slider per non-spatial dim of the active variable.
  return (
    <div style={{ display: "grid", gap: 10 }}>
      {ctx.pyramids.length > 1 && (
        <label style={{ display: "grid", gap: 4 }}>
          <span className="field-label">Resolution</span>
          <select
            value={state.pyramid}
            onChange={(e) => {
              const nextP = ctx.pyramids.find((x) => x.prefix === e.target.value);
              if (!nextP) return;
              const variable = defaultVarOf(nextP);
              const nv = nextP.variables.find((v) => v.name === variable)!;
              update({ pyramid: e.target.value, variable, dimIndices: defaultDimIndices(nv) });
            }}
          >
            {ctx.pyramids.map((py) => (
              <option key={py.prefix} value={py.prefix}>
                {py.label}
              </option>
            ))}
          </select>
        </label>
      )}
      {p.variables.length > 1 && (
        <label style={{ display: "grid", gap: 4 }}>
          <span className="field-label">Variable</span>
          <select
            value={state.variable}
            onChange={(e) => {
              const next = p.variables.find((v) => v.name === e.target.value);
              update({ variable: e.target.value, dimIndices: next ? defaultDimIndices(next) : {} });
            }}
          >
            {p.variables.map((v) => (
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
        const format = p.dimLabel[dim.name] ?? ((v: number) => `${v} / ${dim.size - 1}`);
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
