# Zoom-to-your-location button

**Issue:** [#63 — Add a button for zooming to your location](https://github.com/source-cooperative/zarr-viewer/issues/63)
**Date:** 2026-07-21
**Status:** Approved design

## Summary

A small map button that, on click, uses the browser Geolocation API to fly the
map to the user's current location at a city-level zoom. A custom themed button
matching the app's existing on-map controls (not MapLibre's native
`GeolocateControl`).

## Behavior

- One-shot: click → request location → `flyTo(user, zoom ≈ 11)`. No live
  tracking, no accuracy circle, no persistent marker.
- While the request is pending the button is disabled and shows a spinner.
- Errors (permission denied, unavailable, timeout, or no Geolocation API)
  surface via the app's existing red error `Toast`.
- The fly-to is a programmatic camera move, so — like every other programmatic
  move — it does **not** write the user's coordinates into the shareable URL
  (a privacy plus) and it reuses the `isAnimatingView` tile-suppression gate.
- Shown only on the geographic map (`geographic = profile.host !== "image"`);
  hidden for the pixel-space image profile, where geolocation is meaningless.

## Design

### 1. `src/components/GeolocateButton.tsx` (new)

Mirrors `FullscreenButton`: a `<button className="map-icon-button">` with an
inline SVG, absolutely positioned bottom-right, stacked above the fullscreen
button (`bottom: 60, right: 16, zIndex: 4`).

```tsx
const GEOLOCATE_ZOOM = 11;

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
  // <button className="map-icon-button" disabled={busy} aria-label="Zoom to your location">
  //   {busy ? <SpinnerIcon /> : <LocateIcon />}
}
```

`geolocationErrorMessage(err)` maps `err.code` → `PERMISSION_DENIED` →
"Location permission denied.", `POSITION_UNAVAILABLE` → "Your location is
unavailable.", `TIMEOUT` → "Location request timed out.", else "Couldn't get
your location." `LocateIcon` is a GPS-crosshair (center circle + 4 ticks);
`SpinnerIcon` is an arc that spins via a `spin` keyframe.

### 2. `src/App.tsx`

Render next to `FullscreenButton`, gated on `geographic`, wired to the existing
helpers:

```tsx
{geographic && (
  <GeolocateButton onLocate={handleFlyTo} onError={setError} />
)}
```

`handleFlyTo(lng, lat, zoom)` already exists (sets `isAnimatingView`, `flyTo`
600 ms); `setError` drives the red `Toast`. No other App changes.

### 3. `src/styles.css`

Two small additions (the app has no `.map-icon-button:disabled` or spin
keyframe yet):

```css
.map-icon-button:disabled { opacity: 0.6; cursor: progress; }
@keyframes spin { to { transform: rotate(360deg); } }
```

## Non-goals

- No live tracking / accuracy circle / marker (that's the built-in control's
  territory; out of scope for "a button that zooms to your location").
- No persisting the located view to the URL.

## Testing

- `src/components/GeolocateButton.test.tsx` (new), mocking `navigator.geolocation`:
  - click → `getCurrentPosition` called; success → `onLocate(lng, lat, 11)`.
  - error callback → `onError` with the mapped message; button re-enabled.
  - missing Geolocation API → `onError("Geolocation isn't available…")`, no throw.
  - button is `disabled` while a request is in flight.
- `pnpm test` green + `pnpm build` clean. The App wiring (one gated line) and
  the actual fly-to are covered by `tsc` + a manual browser smoke check
  (click → permission prompt → map flies to location; deny → red toast).
