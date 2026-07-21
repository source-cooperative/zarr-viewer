import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GeolocateButton } from "./GeolocateButton";

/** Install a mock `navigator.geolocation` and return its `getCurrentPosition`
 * spy. Pass `null` to simulate a browser with no Geolocation API. */
function mockGeolocation(
  impl: Geolocation["getCurrentPosition"] | null,
): ReturnType<typeof vi.fn> {
  const getCurrentPosition = impl ? vi.fn(impl) : vi.fn();
  Object.defineProperty(navigator, "geolocation", {
    value: impl ? { getCurrentPosition } : undefined,
    configurable: true,
  });
  return getCurrentPosition;
}

afterEach(() => {
  Object.defineProperty(navigator, "geolocation", {
    value: undefined,
    configurable: true,
  });
});

const btn = () => screen.getByRole("button", { name: /location/i });

describe("GeolocateButton", () => {
  it("flies to the geolocated point at a city zoom on success", () => {
    mockGeolocation((success) =>
      success({
        coords: { longitude: -122.4, latitude: 37.77 },
      } as GeolocationPosition),
    );
    const onLocate = vi.fn();
    render(<GeolocateButton onLocate={onLocate} onError={vi.fn()} />);
    fireEvent.click(btn());
    expect(onLocate).toHaveBeenCalledTimes(1);
    const [lng, lat, zoom] = onLocate.mock.calls[0]!;
    expect(lng).toBe(-122.4);
    expect(lat).toBe(37.77);
    expect(zoom).toBeGreaterThanOrEqual(8); // city-level
  });

  it("reports a permission-denied error and re-enables the button", () => {
    mockGeolocation((_success, error) =>
      error?.({
        code: 1,
        PERMISSION_DENIED: 1,
        POSITION_UNAVAILABLE: 2,
        TIMEOUT: 3,
      } as GeolocationPositionError),
    );
    const onError = vi.fn();
    render(<GeolocateButton onLocate={vi.fn()} onError={onError} />);
    fireEvent.click(btn());
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]![0]).toMatch(/permission/i);
    expect(btn()).not.toBeDisabled(); // recovered after the error
  });

  it("errors gracefully when the Geolocation API is unavailable", () => {
    mockGeolocation(null);
    const onError = vi.fn();
    const onLocate = vi.fn();
    render(<GeolocateButton onLocate={onLocate} onError={onError} />);
    fireEvent.click(btn());
    expect(onLocate).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]![0]).toMatch(/available/i);
  });

  it("disables the button while a request is in flight", () => {
    // Never resolve — the request stays pending.
    mockGeolocation(() => {});
    render(<GeolocateButton onLocate={vi.fn()} onError={vi.fn()} />);
    expect(btn()).not.toBeDisabled();
    fireEvent.click(btn());
    expect(btn()).toBeDisabled();
  });
});
