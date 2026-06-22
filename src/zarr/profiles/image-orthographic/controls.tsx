import { StepperRange } from "../../../components/StepperRange";
import type { ProfileControlsProps } from "../../profile";
import type { ImageOrthographicContext, ImageOrthographicState } from "./types";

export function ImageOrthographicControls({
  ctx,
  state,
  update,
  group,
}: ProfileControlsProps<ImageOrthographicContext, ImageOrthographicState>) {
  // Channel pick re-reads pixel data → "fetch" bucket. No styling/instant
  // controls yet (rescale uses the omero window; z/t come in Stage 2).
  if (group !== "fetch") return null;
  if (ctx.channelCount <= 1) return null;

  const labelText =
    ctx.channels[state.channel]?.label ?? `channel ${state.channel}`;
  return (
    <label style={{ display: "grid", gap: 2 }}>
      <span
        className="field-label"
        style={{ display: "flex", justifyContent: "space-between" }}
      >
        <span>Channel</span>
        <span className="mono" style={{ textTransform: "none" }}>
          {state.channel} · {labelText}
        </span>
      </span>
      <StepperRange
        value={state.channel}
        min={0}
        max={Math.max(0, ctx.channelCount - 1)}
        onChange={(v) => update({ channel: v })}
      />
    </label>
  );
}
