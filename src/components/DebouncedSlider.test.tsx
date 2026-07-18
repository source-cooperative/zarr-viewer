import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { DebouncedSlider } from "./DebouncedSlider";

describe("DebouncedSlider", () => {
  it("does not nest its controls in a <label> (avoids click double-firing in webviews)", () => {
    // Same anti-pattern as PlaybackSlider: a <label> wrapping a StepperRange
    // associates with the first step <button> and double-fires clicks in some
    // embedded Chromium webviews. The scrubber must be a plain group.
    render(
      <DebouncedSlider label="time" value={2} min={0} max={5} onCommit={() => {}} />,
    );
    expect(screen.getByRole("slider").closest("label")).toBeNull();
    expect(
      screen.getByRole("button", { name: "Step back" }).closest("label"),
    ).toBeNull();
    expect(
      screen.getByRole("button", { name: "Step forward" }).closest("label"),
    ).toBeNull();
  });
});
