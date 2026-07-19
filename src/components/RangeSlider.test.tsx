import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { RangeSlider } from "./RangeSlider";

describe("RangeSlider", () => {
  it("commits on a user drag of a handle", () => {
    const onCommit = vi.fn();
    render(<RangeSlider min={0} max={100} value={[20, 35]} onCommit={onCommit} />);
    fireEvent.change(screen.getByLabelText("rescale-min-handle"), {
      target: { value: "25" },
    });
    expect(onCommit).toHaveBeenLastCalledWith([25, 35]);
  });

  it("does NOT commit when the value prop changes from outside (issue #57)", () => {
    // Reproduces the rescale-reset infinite loop: when the parent changes
    // `value` (e.g. reset → autoStats fallback), the slider must only re-sync
    // its draft, never call onCommit. Committing the stale draft back fights
    // the reset and ping-pongs value → React "Maximum update depth exceeded".
    const onCommit = vi.fn();
    const { rerender } = render(
      <RangeSlider min={0} max={100} value={[20, 35]} onCommit={onCommit} />,
    );
    onCommit.mockClear();
    // External change (reset lands the autoStats 2–98% fallback).
    rerender(
      <RangeSlider min={0} max={100} value={[10, 90]} onCommit={onCommit} />,
    );
    expect(onCommit).not.toHaveBeenCalled();
  });
});
