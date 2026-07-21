# Zoom-to-your-location button

**Issue:** [#63 — Add a button for zooming to your location](https://github.com/source-cooperative/zarr-viewer/issues/63)
**Date:** 2026-07-21
**Status:** Approved design

## Summary

A small map button that, on click, uses the browser Geolocation API to fly the
map to the user's current location — zoomed so the dataset's native pixels
approximately match screen pixels — and drops a marker there. A custom themed
button matching the app's existing on-map controls (not MapLibre's native
`GeolocateControl`).

## Behavior

- One-shot: click → request location → `flyTo(user, nativeZoom)` and mark the
  spot with a "you are here" dot. No live tracking, no accuracy circle.
- **Native-resolution zoom:** the target zoom is where one data pixel ≈ one
  screen pixel at the user's latitude (`pixelMatchZoom`), so fine datasets zoom
  in and coarse ones don't over-zoom. Clamped to `[2, 20]`; a fixed city zoom
  (11) is the fallback when the profile exposes no native resolution.
- The marker persists until the store (`state.url`) changes.
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

## Native-resolution zoom

`src/zarr/native-zoom.ts` (pure, tested): `pixelMatchZoom(res, latitude)` maps
a `NativeResolution` (`{kind: "degrees" | "ground-meters" | "mercator-meters",
value}`) to the MapLibre zoom where data px ≈ screen px. A new profile hook
`nativeResolution(ctx, state) → NativeResolution | null` supplies it:
scalar-grid (degrees from the spatial affine), projected-grid override (ground
metres), multiscale-grid (finest-level mercator metres, or degrees for a
geographic CRS). `App.handleGeolocate` computes the clamped zoom and passes it
to `handleFlyTo`.

## Marker

`react-map-gl`'s `<Marker>` renders a `.geolocate-dot` (blue dot, white ring)
at `geolocated` while it's set; `App` clears `geolocated` on `state.url` change.

## Non-goals

- No live tracking / accuracy circle (that's the built-in control's territory).
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
