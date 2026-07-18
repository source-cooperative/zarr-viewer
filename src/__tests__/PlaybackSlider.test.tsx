import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { PlaybackSlider } from "../components/PlaybackSlider";

function setup(over: Partial<React.ComponentProps<typeof PlaybackSlider>> = {}) {
  const props = {
    label: "lead_time (live)",
    value: 1,
    min: 0,
    max: 4,
    playing: false,
    speed: 1,
    onToggle: vi.fn(),
    onCycleSpeed: vi.fn(),
    onSeek: vi.fn(),
    formatValue: (v: number) => `t+${v}h`,
    ...over,
  };
  render(<PlaybackSlider {...props} />);
  return props;
}

describe("PlaybackSlider", () => {
  it("shows the label and formatted value", () => {
    setup();
    expect(screen.getByText("lead_time (live)")).toBeInTheDocument();
    expect(screen.getByText("t+1h")).toBeInTheDocument();
  });

  it("play button calls onToggle and reflects state in its label", () => {
    const props = setup({ playing: false });
    const btn = screen.getByRole("button", { name: "Play" });
    fireEvent.click(btn);
    expect(props.onToggle).toHaveBeenCalledOnce();
  });

  it("shows a Pause label while playing", () => {
    setup({ playing: true });
    expect(screen.getByRole("button", { name: "Pause" })).toBeInTheDocument();
  });

  it("speed chip shows the multiplier and cycles on click", () => {
    const props = setup({ speed: 2 });
    const chip = screen.getByRole("button", { name: /speed/i });
    expect(chip).toHaveTextContent("2×");
    fireEvent.click(chip);
    expect(props.onCycleSpeed).toHaveBeenCalledOnce();
  });

  it("dragging the range calls onSeek", () => {
    const props = setup();
    fireEvent.change(screen.getByRole("slider"), { target: { value: "3" } });
    expect(props.onSeek).toHaveBeenCalledWith(3);
  });
});
