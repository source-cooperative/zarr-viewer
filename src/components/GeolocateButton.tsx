import { useState } from "react";

/** City / neighborhood zoom to land on when the user's location is found —
 * useful regardless of the current zoom. */
const GEOLOCATE_ZOOM = 11;

/** A map button that flies to the user's current location (browser Geolocation
 * API). One-shot: it centers the map once per click, with no live tracking or
 * marker. Errors surface through `onError` (the app's toast). Styled to match
 * the app's other on-map buttons (`FullscreenButton`). */
export function GeolocateButton({
  onLocate,
  onError,
}: {
  onLocate: (longitude: number, latitude: number, zoom: number) => void;
  onError: (message: string) => void;
}) {
  const [busy, setBusy] = useState(false);

  const locate = () => {
    if (typeof navigator === "undefined" || !navigator.geolocation) {
      onError("Geolocation isn't available in this browser.");
      return;
    }
    setBusy(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setBusy(false);
        onLocate(pos.coords.longitude, pos.coords.latitude, GEOLOCATE_ZOOM);
      },
      (err) => {
        setBusy(false);
        onError(geolocationErrorMessage(err));
      },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 },
    );
  };

  return (
    <button
      type="button"
      aria-label="Zoom to your location"
      title="Zoom to your location"
      onClick={locate}
      disabled={busy}
      className="map-icon-button"
      style={{ position: "absolute", bottom: 60, right: 16, zIndex: 4 }}
    >
      {busy ? <SpinnerIcon /> : <LocateIcon />}
    </button>
  );
}

function geolocationErrorMessage(err: GeolocationPositionError): string {
  switch (err.code) {
    case err.PERMISSION_DENIED:
      return "Location permission denied.";
    case err.POSITION_UNAVAILABLE:
      return "Your location is unavailable.";
    case err.TIMEOUT:
      return "Location request timed out.";
    default:
      return "Couldn't get your location.";
  }
}

/** GPS-style crosshair: a center circle with four ticks. */
function LocateIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      aria-hidden
    >
      <circle cx="12" cy="12" r="4" />
      <line x1="12" y1="2" x2="12" y2="5" />
      <line x1="12" y1="19" x2="12" y2="22" />
      <line x1="2" y1="12" x2="5" y2="12" />
      <line x1="19" y1="12" x2="22" y2="12" />
    </svg>
  );
}

/** A spinning arc shown while the location request is in flight. */
function SpinnerIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      aria-hidden
      style={{ animation: "spin 0.8s linear infinite" }}
    >
      <circle cx="12" cy="12" r="9" strokeOpacity="0.25" />
      <path d="M21 12a9 9 0 0 0-9-9" />
    </svg>
  );
}
