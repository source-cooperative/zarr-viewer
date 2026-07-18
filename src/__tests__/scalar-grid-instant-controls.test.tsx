import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ScalarGridControls } from "../zarr/profiles/scalar-grid/controls";
import type {
  ScalarGridContext,
  ScalarGridState,
} from "../zarr/profiles/scalar-grid/types";

const ctx = {
  variables: [
    {
      name: "t2m",
      group: "",
      longName: null,
      units: null,
      fillValue: null,
      scaleFactor: 1,
      addOffset: 0,
      dims: [{ name: "lead_time", size: 49 }],
      textureDim: { name: "lead_time", window: 49 },
      memoryDims: [],
    },
  ],
  dimLabel: {},
} as unknown as ScalarGridContext;
const state = { variable: "t2m", dimIndices: { lead_time: 3 } } as ScalarGridState;

describe("ScalarGridControls (instant bucket)", () => {
  it("renders a play transport for the live dim when playback is provided", () => {
    const playback = {
      playing: false,
      speed: 1,
      toggle: vi.fn(),
      cycleSpeed: vi.fn(),
      seekTo: vi.fn(),
    };
    render(
      <ScalarGridControls
        ctx={ctx}
        state={state}
        update={vi.fn()}
        group="instant"
        playback={playback}
        chassisState={{} as never}
        chassisUpdate={vi.fn()}
        autoStats={null}
        onFlyTo={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Play" }));
    expect(playback.toggle).toHaveBeenCalledOnce();
  });
});
