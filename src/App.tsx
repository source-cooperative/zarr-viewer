import type { MapboxOverlayProps } from "@deck.gl/mapbox";
import { MapboxOverlay } from "@deck.gl/mapbox";
import {
  createColormapTexture,
  decodeColormapSprite,
} from "@developmentseed/deck.gl-raster/gpu-modules";
import colormapsPngUrl from "@developmentseed/deck.gl-raster/gpu-modules/colormaps.png";
import type { Device, Texture } from "@luma.gl/core";
import "maplibre-gl/dist/maplibre-gl.css";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type * as zarr from "zarrita";
import type { MapRef } from "react-map-gl/maplibre";
import { Map as MaplibreMap, Marker, useControl } from "react-map-gl/maplibre";
import { resolveBasemap } from "./basemaps";
import { ControlsPanel } from "./components/ControlsPanel";
import { EmptyState } from "./components/EmptyState";
import { ImageViewer } from "./components/ImageViewer";
import type {
  ImageOrthographicContext,
  ImageOrthographicState,
} from "./zarr/profiles/image-orthographic/types";
import { formatNumber } from "./components/RangeSlider";
import { FullscreenButton } from "./components/FullscreenButton";
import { GeolocateButton } from "./components/GeolocateButton";
import { pixelMatchZoom } from "./zarr/native-zoom";
import { ArrayOverview, StructureSection } from "./components/StructurePanel";
import { humanizeError, Toast } from "./components/Toast";
import { ZoomHint } from "./components/ZoomHint";
import { createLogger } from "./log";
import { PyramidBadge } from "./components/PyramidBadge";
import { installKeepMinZoomTiles } from "./render/keep-min-zoom-tiles";
import * as tileActivity from "./render/tile-activity";
import type { AutoStats } from "./render/stats";
import { subscribeTileHealth } from "./zarr/tile-error";
import { detectProfile, normalizeStoreUrl } from "./source";
import {
  asIcechunk,
  listIcechunkSnapshots,
  type IcechunkInfo,
  type IcechunkSnapshot,
} from "./zarr/load-zarr";
import { MultiscaleStoreError } from "./zarr/multiscale";
import { ProjectedGridStoreError } from "./zarr/projected";
import { OmeZarrStoreError } from "./zarr/profiles/image-orthographic/ome";
import { getProfile } from "./zarr/profiles";
import {
  buildExampleLoadPatch,
  type ExampleLoadRequest,
} from "./state/load-example";
import { mergeProfileState } from "./state/merge-profile-state";
import { useViewerState } from "./state/useViewerState";
import { usePlayback } from "./state/usePlayback";
import type { AnyZarrProfile, ProfileBaseContext } from "./zarr/profile";
import {
  fetchCodecSummary,
  type CodecSummary,
  type StructureProfileSummary,
} from "./zarr/structure";

const log = createLogger("app");

// Keep already-loaded tiles painted when zoomed out past a layer's minZoom
// (deck.gl-zarr would otherwise blank the map below the threshold).
installKeepMinZoomTiles();

const darkMql = window.matchMedia("(prefers-color-scheme: dark)");
const subscribeColorScheme = (cb: () => void) => {
  darkMql.addEventListener("change", cb);
  return () => darkMql.removeEventListener("change", cb);
};
const getColorSchemeSnapshot = () => darkMql.matches;
const usePrefersDark = () =>
  useSyncExternalStore(subscribeColorScheme, getColorSchemeSnapshot, () => false);

function DeckGLOverlay(
  props: MapboxOverlayProps & { onDeviceInitialized?: (d: Device) => void },
) {
  const overlay = useControl<MapboxOverlay>(() => new MapboxOverlay(props));
  overlay.setProps(props);
  return null;
}

// "Zoom to your location" target zoom: match the dataset's native resolution
// (pixelMatchZoom), clamped to this range; the fallback is used when the
// profile exposes no native resolution.
const GEOLOCATE_MIN_ZOOM = 2;
const GEOLOCATE_MAX_ZOOM = 20;
const GEOLOCATE_FALLBACK_ZOOM = 11;

export default function App() {
  const mapRef = useRef<MapRef>(null);
  // Store URL the intro fly-in has already played for, so it runs once per load
  // (a variable switch doesn't replay it). See the intro effect below (#42).
  const introRanForUrl = useRef<string | null>(null);
  const { state, update, params, updateParams } = useViewerState();
  const prefersDark = usePrefersDark();
  const [device, setDevice] = useState<Device | null>(null);
  const [colormapTexture, setColormapTexture] = useState<Texture | null>(null);
  const [profileCtx, setProfileCtx] = useState<ProfileBaseContext | null>(null);
  const [node, setNode] = useState<
    zarr.Array<zarr.DataType, zarr.Readable> | zarr.Group<zarr.Readable> | null
  >(null);
  const [autoStats, setAutoStats] = useState<AutoStats | null>(null);
  const [codecSummary, setCodecSummary] = useState<CodecSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Resolved Icechunk ref info for the current store (null for plain Zarr).
  const [icechunk, setIcechunk] = useState<IcechunkInfo | null>(null);
  // True when tiles are repeatedly failing to load (non-abort). Drives a
  // non-blocking "loading slowly" notice; reset when a tile next succeeds or
  // the user dismisses it.
  const [tilesDegraded, setTilesDegraded] = useState(false);
  const [tileNoticeDismissed, setTileNoticeDismissed] = useState(false);
  const [firstSymbolId, setFirstSymbolId] = useState<string | undefined>();
  // True while a programmatic flyTo animation is in flight. The layer
  // `useMemo` returns null when set, so tiles aren't requested for the
  // animation's intermediate viewports — only for the final settled view.
  const [isAnimatingView, setIsAnimatingView] = useState(false);
  // Live map zoom, used only to drive the zoom-in hint (kept out of chassis
  // `state` so it never re-triggers layer construction). Updated on `zoom`
  // events, including the programmatic initial flyTo. `mapSettled` gates the
  // hint until the camera first comes to rest, so it doesn't flash during
  // that flyTo from the default z2 world view; a URL with an explicit view
  // is "settled" from the start.
  const [viewZoom, setViewZoom] = useState<number>(() => state.view?.[2] ?? 2);
  const [mapSettled, setMapSettled] = useState<boolean>(() => !!state.view);
  // Geolocated point (from the "zoom to your location" button), marked on the
  // map until the store changes.
  const [geolocated, setGeolocated] = useState<{
    longitude: number;
    latitude: number;
  } | null>(null);

  // Hover-value tooltip. The cursor read is rAF-throttled (one re-render per
  // frame); `hover` is local state and is NOT a layer dep, so it never rebuilds
  // the layer.
  const [hover, setHover] = useState<{
    x: number;
    y: number;
    lines: string[];
  } | null>(null);
  const hoverRaf = useRef<number | null>(null);
  const hoverPt = useRef<{
    lng: number;
    lat: number;
    px: number;
    py: number;
  } | null>(null);

  useEffect(() => {
    setFirstSymbolId(undefined);
  }, [state.basemap]);

  // Profile selection. Default = scalar-grid; if its prepare throws
  // `MultiscaleStoreError` (a multiscale pyramid), the prepare effect below
  // records the switch in `autoProfile`, keyed to the url so a stale value
  // never leaks onto a different store.
  const [autoProfile, setAutoProfile] = useState<{ url: string; id: string } | null>(
    null,
  );
  const profile: AnyZarrProfile | null = useMemo(() => {
    if (state.profileId) return detectProfile(state.url, state.profileId);
    if (!state.url) return null;
    if (autoProfile && autoProfile.url === state.url) {
      return getProfile(autoProfile.id);
    }
    return detectProfile(state.url, null); // scalar-grid default
  }, [state.url, state.profileId, autoProfile]);

  // Re-derive profile state on every render from URL params (defaults
  // come from profile.initialState; URL overrides win).
  const profileState = useMemo(() => {
    if (!profile || !profileCtx) return null;
    const base = profile.initialState(profileCtx);
    const overrides = profile.parseUrlParams(params);
    return mergeProfileState(base, overrides);
  }, [profile, profileCtx, params]);

  const updateProfileState = useCallback(
    (patch: Record<string, unknown>) => {
      if (!profile || !profileState) return;
      const merged = { ...profileState, ...patch };
      updateParams(profile.serializeUrlParams(merged));
    },
    [profile, profileState, updateParams],
  );

  // ---- Instant-slider playback -------------------------------------------
  // Which dim (if any) can be animated for the current profile/variable.
  const playable = useMemo(
    () =>
      profile?.getPlayableDim && profileCtx && profileState
        ? profile.getPlayableDim(profileCtx, profileState)
        : null,
    [profile, profileCtx, profileState],
  );
  // The current (URL-backed) frame index of that dim — seeds playback.
  const playableIndex =
    playable && profileState ? (profileState.dimIndices[playable.name] ?? 0) : 0;
  // Commit the shown frame to the URL (on pause / seek).
  const commitPlaybackFrame = useCallback(
    (i: number) => {
      if (!playable || !profileState) return;
      updateProfileState({
        dimIndices: { ...profileState.dimIndices, [playable.name]: i },
      });
    },
    [playable, profileState, updateProfileState],
  );
  const playback = usePlayback(playable, playableIndex, commitPlaybackFrame);
  // Profile state with the animated frame substituted while playing. Everything
  // that shows the "current frame" (layer, live slider, hover) reads this.
  const effectiveProfileState = useMemo(() => {
    if (!profileState || !playback.playing || !playable) return profileState;
    return {
      ...profileState,
      dimIndices: {
        ...profileState.dimIndices,
        [playable.name]: Math.min(playback.index, Math.max(0, playable.size - 1)),
      },
    };
  }, [profileState, playback.playing, playback.index, playable]);

  const handleHoverMove = useCallback(
    (e: { lngLat: { lng: number; lat: number }; point: { x: number; y: number } }) => {
      if (!profile?.sampleValue || !profileCtx || !profileState) return;
      hoverPt.current = {
        lng: e.lngLat.lng,
        lat: e.lngLat.lat,
        px: e.point.x,
        py: e.point.y,
      };
      if (hoverRaf.current != null) return;
      hoverRaf.current = requestAnimationFrame(() => {
        hoverRaf.current = null;
        const pt = hoverPt.current;
        if (!pt || !profile?.sampleValue || !profileCtx || !profileState) {
          setHover(null);
          return;
        }
        const res = profile.sampleValue(
          profileCtx,
          effectiveProfileState ?? profileState,
          pt.lng,
          pt.lat,
        );
        if (!res) {
          setHover(null);
          return;
        }
        const valueText =
          res.value === null
            ? "no data"
            : `${formatNumber(res.value)}${res.units ? ` ${res.units}` : ""}`;
        setHover({
          x: pt.px,
          y: pt.py,
          lines: [
            res.label,
            valueText,
            `${pt.lat.toFixed(3)}, ${pt.lng.toFixed(3)}`,
          ],
        });
      });
    },
    [profile, profileCtx, profileState, effectiveProfileState],
  );

  const handleHoverOut = useCallback(() => {
    if (hoverRaf.current != null) {
      cancelAnimationFrame(hoverRaf.current);
      hoverRaf.current = null;
    }
    hoverPt.current = null;
    setHover(null);
  }, []);

  // Cancel any pending rAF on unmount.
  useEffect(() => {
    return () => {
      if (hoverRaf.current != null) cancelAnimationFrame(hoverRaf.current);
    };
  }, []);

  // Open store + prepare profile context whenever (url, profile) changes.
  useEffect(() => {
    setProfileCtx(null);
    setNode(null);
    setAutoStats(null);
    setError(null);
    setIcechunk(null);
    if (!state.url || !profile) return;
    const ctrl = new AbortController();
    log.info(`load: profile "${profile.id}" url=${state.url}`);
    (async () => {
      try {
        const ctx = await profile.prepare(state.url!, ctrl.signal, {
          branch: state.branch,
          snapshot: state.snapshot,
        });
        if (ctrl.signal.aborted) return;
        log.info("profile context ready");
        setProfileCtx(ctx);
        // Surface the resolved Icechunk ref info (branch/snapshot/branches) for
        // the chassis selectors. `group.store` carries the attached info for
        // any profile; null for plain-Zarr stores (selectors stay hidden).
        setIcechunk(asIcechunk(ctx.group.store));
        // Skip the profile's auto-fit when the URL has explicit view
        // params — the user's view wins.
        if (state.view) return;
        // When the intro fly-in is active it owns the opening camera.
        if (state.intro != null) return;
        const bounds = profile.initialBounds?.(ctx);
        if (bounds) {
          mapRef.current?.fitBounds(
            [
              [bounds[0], bounds[1]],
              [bounds[2], bounds[3]],
            ],
            { padding: 40, duration: 600 },
          );
        }
      } catch (err) {
        if (ctrl.signal.aborted) return;
        if (err instanceof MultiscaleStoreError) {
          // The default profile detected a multiscale pyramid → switch to the
          // multiscale-grid profile (which re-runs prepare). No error toast.
          if (!state.profileId && state.url) {
            log.info("switching to multiscale-grid profile");
            setAutoProfile({ url: state.url, id: "multiscale-grid" });
          }
          return;
        }
        if (err instanceof OmeZarrStoreError) {
          // The default profile detected an OME-Zarr image → switch to the
          // image-orthographic profile (which re-runs prepare). No error toast.
          if (!state.profileId && state.url) {
            log.info("switching to image-orthographic profile");
            setAutoProfile({ url: state.url, id: "image-orthographic" });
          }
          return;
        }
        if (err instanceof ProjectedGridStoreError) {
          // The default profile detected a projected (e.g. Lambert Conformal)
          // grid → switch to the projected-grid profile (which re-runs
          // prepare). No error toast.
          if (!state.profileId && state.url) {
            log.info("switching to projected-grid profile");
            setAutoProfile({ url: state.url, id: "projected-grid" });
          }
          return;
        }
        log.error("profile.prepare failed", err);
        setError(humanizeError(err));
      }
    })();
    return () => ctrl.abort();
    // state.view is read above but intentionally excluded from deps:
    // user-driven view updates must not retrigger a fitBounds.
    // state.branch/state.snapshot ARE deps: changing a ref re-opens the store.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.url, profile, state.branch, state.snapshot]);

  // Lazily load the selected branch's recent snapshot history for the snapshot
  // selector — kept off the store-open hot path (most loads never need it).
  const [snapshots, setSnapshots] = useState<IcechunkSnapshot[] | null>(null);
  useEffect(() => {
    setSnapshots(null);
    if (!icechunk || !state.url) return;
    let cancelled = false;
    listIcechunkSnapshots(state.url, icechunk.branch).then((list) => {
      if (!cancelled) setSnapshots(list);
    });
    return () => {
      cancelled = true;
    };
  }, [state.url, icechunk]);

  // After ctx is ready and the URL didn't pin a view, fly to the
  // profile's preferred initial view (e.g. AEF's location preset).
  useEffect(() => {
    if (!profile || !profileCtx || !profileState) return;
    if (state.view) return;
    // When the intro fly-in is active it owns the opening camera.
    if (state.intro != null) return;
    const view = profile.initialView?.(profileCtx, profileState);
    if (view) {
      mapRef.current?.flyTo({
        center: [view.longitude, view.latitude],
        zoom: view.zoom,
        duration: 600,
      });
    }
    // Only fire on profile/ctx change, not on every state tick. state.view
    // is read for gating but excluded — see above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile?.id, profileCtx]);

  // Optional intro fly-in (`?intro=<seconds>`, issue #42): once per store load,
  // and only when no explicit `?lng/lat/zoom` view is set, animate from the
  // world view to the dataset's extent. Extent profiles supply a lng/lat bbox
  // via `dataBounds` (→ fitBounds); band-composite falls back to its location
  // preset (`initialView` → flyTo). No target → graceful no-op. `isAnimatingView`
  // suppresses tile loads for the intermediate viewports; App.onMoveEnd clears
  // it on the programmatic moveend. Programmatic moves never write the URL.
  useEffect(() => {
    if (state.intro == null || state.view) return;
    if (!profile || !profileCtx || !profileState) return;
    if (introRanForUrl.current === state.url) return;
    const map = mapRef.current;
    if (!map) return;
    const durationMs = state.intro * 1000;
    const bounds = profile.dataBounds?.(profileCtx, profileState) ?? null;
    if (bounds) {
      introRanForUrl.current = state.url;
      setIsAnimatingView(true);
      map.fitBounds(
        [
          [bounds[0], bounds[1]],
          [bounds[2], bounds[3]],
        ],
        { padding: 40, duration: durationMs },
      );
      return;
    }
    const view = profile.initialView?.(profileCtx, profileState) ?? null;
    if (view) {
      introRanForUrl.current = state.url;
      setIsAnimatingView(true);
      map.flyTo({
        center: [view.longitude, view.latitude],
        zoom: view.zoom,
        duration: durationMs,
      });
    }
    // state.view gates only; introRanForUrl guards single-fire per store.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.intro, state.url, profile?.id, profileCtx, profileState]);

  // Stable string keys for the profile-provided dep lists. Spreading the
  // arrays directly into a `useEffect` dep array would change the array
  // *length* whenever the profile / dep shape changes, which React
  // forbids. Serializing collapses them to a single primitive key.
  const resolveNodeDepsKey =
    profile && profileState
      ? JSON.stringify(profile.resolveNodeDeps?.(profileState) ?? [])
      : "";
  const statsDepsKey =
    profile && profileState
      ? JSON.stringify(
          profile.statsDeps?.(profileState) ??
            profile.resolveNodeDeps?.(profileState) ??
            [],
        )
      : "";

  // Resolve the layer's `node` (group or pre-opened array).
  useEffect(() => {
    if (!profile || !profileCtx || !profileState) {
      setNode(null);
      return;
    }
    if (!profile.resolveNode) {
      setNode(profileCtx.group);
      return;
    }
    const ctrl = new AbortController();
    (async () => {
      try {
        const resolved = await profile.resolveNode!(
          profileCtx,
          profileState,
          ctrl.signal,
        );
        if (!ctrl.signal.aborted) setNode(resolved);
      } catch (err) {
        if (ctrl.signal.aborted) return;
        log.error("profile.resolveNode failed", err);
        setError(humanizeError(err));
      }
    })();
    return () => ctrl.abort();
    // profileState is read inside the effect; the deps that should
    // re-trigger it are captured by `resolveNodeDepsKey`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile, profileCtx, resolveNodeDepsKey]);

  // Compute auto-stats per profile.
  useEffect(() => {
    if (!profile?.computeAutoStats || !profileCtx || !profileState) return;
    const ctrl = new AbortController();
    setAutoStats(null);
    (async () => {
      try {
        const stats = await profile.computeAutoStats!({
          ctx: profileCtx,
          state: profileState,
          signal: ctrl.signal,
        });
        if (!ctrl.signal.aborted) {
          const g = stats?.global;
          log.debug(
            g
              ? `autoStats range [${g.min}, ${g.max}]`
              : "autoStats: none (no finite samples)",
          );
          setAutoStats(stats);
        }
      } catch (err) {
        if (ctrl.signal.aborted) return;
        log.warn("computeAutoStats failed", err);
      }
    })();
    return () => ctrl.abort();
    // Profiles narrow `statsDeps` (e.g. FTW returns `[time, band]`) so
    // stats recompute only on those changes, not on every dim-slider tick.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile, profileCtx, statsDepsKey]);

  // Surface repeated (non-abort) tile-load failures as a non-blocking notice.
  // The counter ignores AbortErrors, so routine pan/zoom pruning never trips
  // it; a successful tile clears it (and re-arms the dismissable notice).
  useEffect(() => {
    return subscribeTileHealth((degraded) => {
      log.info(degraded ? "tiles degraded (repeated failures)" : "tiles recovered");
      setTilesDegraded(degraded);
      if (!degraded) setTileNoticeDismissed(false);
    });
  }, []);

  // Decode + upload the colormap sprite once the device is ready (only
  // needed for single-band/colormapped profiles).
  useEffect(() => {
    if (!device || !profile?.needsColormap) return;
    let cancelled = false;
    (async () => {
      const resp = await fetch(colormapsPngUrl);
      const bytes = await resp.arrayBuffer();
      const image = await decodeColormapSprite(bytes);
      if (cancelled) return;
      setColormapTexture(createColormapTexture(device, image));
    })();
    return () => {
      cancelled = true;
    };
  }, [device, profile?.needsColormap]);

  // Profile's read-only structure summary (drives the Structure panel).
  // Recomputed on every render — it's a pure pick of fields already in
  // state. Cheap.
  const structureSummary: StructureProfileSummary | null = useMemo(() => {
    if (!profile || !profileCtx || !profileState) return null;
    return profile.getStructure(profileCtx, profileState);
  }, [profile, profileCtx, profileState]);

  // Read the primary variable's codec / sharding info for the Structure panel
  // from the opened store (content-addressed; Icechunk-safe — see issue #51).
  useEffect(() => {
    const store = profileCtx?.group.store ?? null;
    if (!store || !structureSummary) {
      setCodecSummary(null);
      return;
    }
    const primary = structureSummary.variables[0];
    const ctrl = new AbortController();
    setCodecSummary(null);
    (async () => {
      const summary = await fetchCodecSummary(store, primary.path, ctrl.signal);
      if (!ctrl.signal.aborted) setCodecSummary(summary);
    })();
    return () => ctrl.abort();
    // Keyed on the store (via profileCtx) + primary path; both stable across
    // same-value renders.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profileCtx, structureSummary?.variables[0]?.path]);

  const layer = useMemo(() => {
    // Suppress layer construction while a flyTo is in flight so deck.gl
    // doesn't request tiles for the animation's intermediate viewports.
    // Cleared on the underlying Map's `moveend` (see `handleFlyTo`).
    if (isAnimatingView) return null;
    if (!profile || !profileCtx || !profileState) return null;
    return profile.buildLayer({
      ctx: profileCtx,
      state: effectiveProfileState ?? profileState,
      chassisState: state,
      device,
      colormapTexture,
      autoStats,
      basemapBeforeId:
        state.labelsAbove &&
        state.basemap !== "satellite" &&
        state.basemap !== "off"
          ? firstSymbolId
          : undefined,
      node,
    });
  }, [
    isAnimatingView,
    profile,
    profileCtx,
    effectiveProfileState,
    state,
    device,
    colormapTexture,
    autoStats,
    firstSymbolId,
    node,
  ]);

  const handleFlyTo = useCallback(
    (longitude: number, latitude: number, zoom: number) => {
      const map = mapRef.current;
      if (!map) return;
      // Gate the layer; the React `onMoveEnd` handler below clears the
      // flag when the animation settles. (`map.once("moveend", ...)`
      // doesn't reliably bubble through react-map-gl's MapRef proxy,
      // so we use the React event prop, which is supported.)
      setIsAnimatingView(true);
      map.flyTo({ center: [longitude, latitude], zoom, duration: 600 });
    },
    [],
  );

  // "Zoom to your location": fly to the geolocated point at the zoom where the
  // dataset's native pixels ≈ screen pixels (#63), and mark the spot.
  const handleGeolocate = useCallback(
    (longitude: number, latitude: number) => {
      const res =
        profile && profileCtx && profileState
          ? (profile.nativeResolution?.(profileCtx, profileState) ?? null)
          : null;
      const native = res ? pixelMatchZoom(res, latitude) : NaN;
      const zoom = Number.isFinite(native)
        ? Math.min(GEOLOCATE_MAX_ZOOM, Math.max(GEOLOCATE_MIN_ZOOM, native))
        : GEOLOCATE_FALLBACK_ZOOM;
      handleFlyTo(longitude, latitude, zoom);
      setGeolocated({ longitude, latitude });
    },
    [profile, profileCtx, profileState, handleFlyTo],
  );

  // Drop the location marker when the store changes.
  useEffect(() => {
    setGeolocated(null);
  }, [state.url]);

  const handleLoad = useCallback(
    (request: ExampleLoadRequest) => {
      // Current URL params win over example defaults (so a shared link
      // round-trips), then example defaults fill gaps, then the chassis
      // render fields reset. See `buildExampleLoadPatch`.
      const cur = new URLSearchParams(window.location.search);
      const patch = buildExampleLoadPatch(cur, {
        url: normalizeStoreUrl(request.url),
        params: request.params,
      });
      // Update the URL first so EmptyState dismisses and `state.url` is
      // set; the layer would otherwise mount mid-animation, but the
      // `isAnimatingView` gate handles that.
      updateParams(patch);
      // Then animate to the destination — the gate ensures tiles only
      // load once the camera settles.
      if (
        typeof patch.lng === "string" &&
        typeof patch.lat === "string" &&
        typeof patch.zoom === "string"
      ) {
        const lng = Number(patch.lng);
        const lat = Number(patch.lat);
        const zoom = Number(patch.zoom);
        if (
          Number.isFinite(lng) &&
          Number.isFinite(lat) &&
          Number.isFinite(zoom)
        ) {
          handleFlyTo(lng, lat, zoom);
        }
      }
    },
    [updateParams, handleFlyTo],
  );

  useEffect(() => {
    document.documentElement.classList.toggle("theme-dark", prefersDark);
  }, [prefersDark]);

  // Tell the pyramid badge how many levels this store has (null = single-level/
  // non-multiscale → no level shown). Reset on store/profile change.
  useEffect(() => {
    if (!profile || !profileCtx) {
      tileActivity.reset();
      return;
    }
    tileActivity.setPyramid(
      profile.pyramidLevelCount?.(profileCtx) ?? null,
      profile.pyramidLevelDownsamples?.(profileCtx) ?? null,
    );
    return () => tileActivity.reset();
  }, [profile, profileCtx]);

  const activity = useSyncExternalStore(
    tileActivity.subscribe,
    tileActivity.getSnapshot,
  );

  const showSingleBandControls = profile?.needsColormap ?? false;
  // Non-geographic image profiles (OrthographicView host) hide map-only
  // chassis controls (basemap, location presets, GeoZarr metadata).
  const geographic = profile?.host !== "image";

  return (
    <div style={{ position: "relative", width: "100%", height: "100%" }}>
      {profile?.host === "image" ? (
        profileCtx && profileState ? (
          <ImageViewer
            ctx={profileCtx as ImageOrthographicContext}
            state={profileState as ImageOrthographicState}
            opacity={state.opacity}
            autoStats={autoStats}
          />
        ) : null
      ) : (
      <MaplibreMap
        ref={mapRef}
        initialViewState={
          state.view
            ? {
                longitude: state.view[0],
                latitude: state.view[1],
                zoom: state.view[2],
              }
            : { longitude: 0, latitude: 20, zoom: 2 }
        }
        mapStyle={resolveBasemap(state.basemap, prefersDark)}
        onStyleData={(e) => {
          const layers = e.target.getStyle()?.layers ?? [];
          const next = layers.find((l) => l.type === "symbol")?.id;
          setFirstSymbolId((prev) => (prev === next ? prev : next));
        }}
        onZoom={(e) => {
          // Drive the zoom-in hint. Skip no-op updates (round to 0.1) so a
          // zoom gesture doesn't re-render every frame.
          const z = e.viewState.zoom;
          setViewZoom((prev) =>
            Math.round(prev * 10) === Math.round(z * 10) ? prev : z,
          );
        }}
        onMoveEnd={(e) => {
          setMapSettled(true);
          const isProgrammatic = !e.originalEvent;
          if (isProgrammatic) {
            // Programmatic move (flyTo / fitBounds). Clear the
            // animation gate so the layer can mount at the settled
            // viewport. Don't write to URL — only user-driven moves do.
            setIsAnimatingView(false);
            return;
          }
          const c = e.target.getCenter();
          const z = e.target.getZoom();
          update({ view: [c.lng, c.lat, z] });
        }}
        onMouseMove={handleHoverMove}
        onMouseOut={handleHoverOut}
      >
        <DeckGLOverlay
          layers={layer ? [layer] : []}
          interleaved
          // Deck writes `cursor` inline on the shared canvas container on every
          // pointer move (default grab/grabbing), which overrides any CSS — so
          // the crosshair must be set here. Grabbing still shows while panning.
          getCursor={({ isDragging }) => (isDragging ? "grabbing" : "crosshair")}
          onDeviceInitialized={setDevice}
        />
        {geolocated && (
          <Marker
            longitude={geolocated.longitude}
            latitude={geolocated.latitude}
          >
            <div className="geolocate-dot" aria-label="Your location" />
          </Marker>
        )}
      </MaplibreMap>
      )}

      {profile && profileCtx && profileState && (
        <ControlsPanel
          state={state}
          update={update}
          showSingleBandControls={showSingleBandControls}
          geographic={geographic}
          autoStats={autoStats}
          icechunk={icechunk}
          snapshots={snapshots}
          profileFetchSlot={profile.Controls({
            ctx: profileCtx,
            state: effectiveProfileState ?? profileState,
            update: updateProfileState,
            chassisState: state,
            chassisUpdate: update,
            autoStats,
            onFlyTo: handleFlyTo,
            group: "fetch",
          })}
          profileInstantSlot={profile.Controls({
            ctx: profileCtx,
            state: effectiveProfileState ?? profileState,
            update: updateProfileState,
            chassisState: state,
            chassisUpdate: update,
            autoStats,
            onFlyTo: handleFlyTo,
            group: "instant",
            playback: playable ? playback : null,
          })}
          profileStyleSlot={profile.Controls({
            ctx: profileCtx,
            state: effectiveProfileState ?? profileState,
            update: updateProfileState,
            chassisState: state,
            chassisUpdate: update,
            autoStats,
            onFlyTo: handleFlyTo,
            group: "styling",
          })}
          overviewSlot={
            structureSummary ? (
              <ArrayOverview structure={structureSummary} node={node} />
            ) : null
          }
          structureSlot={
            structureSummary ? (
              <StructureSection
                state={state}
                update={update}
                group={profileCtx.group}
                node={node}
                structure={structureSummary}
                codecs={codecSummary}
                geographic={geographic}
              />
            ) : null
          }
        />
      )}

      {(() => {
        // Per-store min-zoom (scalar-grid derives it from resolution) overrides
        // the profile's static value for the zoom-in hint; an explicit
        // `?min_zoom=` URL override wins over both.
        const minZoom =
          state.minZoomOverride ??
          (profileCtx?.minRenderZoom ?? profile?.minRenderZoom);
        return (
          mapSettled &&
          profileCtx != null &&
          minZoom != null &&
          viewZoom < minZoom && (
            <ZoomHint current={viewZoom} threshold={minZoom} />
          )
        );
      })()}

      <PyramidBadge
        level={activity.level}
        levelCount={activity.levelCount}
        downsample={activity.downsample}
        loading={activity.inFlight > 0}
      />

      {hover && (
        <div
          style={{
            position: "absolute",
            left: hover.x + 14,
            top: hover.y + 14,
            zIndex: 16,
            pointerEvents: "none",
            maxWidth: 280,
          }}
        >
          <div
            className="panel mono"
            style={{
              padding: "4px 8px",
              fontSize: 11,
              lineHeight: 1.4,
              whiteSpace: "nowrap",
            }}
          >
            {hover.lines.map((line, i) => (
              <div
                key={i}
                style={
                  i === hover.lines.length - 1
                    ? { color: "var(--text-muted)" }
                    : undefined
                }
              >
                {line}
              </div>
            ))}
          </div>
        </div>
      )}

      <Toast message={error} onDismiss={() => setError(null)} />

      {/* Non-fatal notice; the red error toast (above) takes precedence. */}
      <Toast
        intent="warn"
        message={
          tilesDegraded && !tileNoticeDismissed && !error
            ? "Tiles are loading slowly or failing — your connection may be slow."
            : null
        }
        onDismiss={() => setTileNoticeDismissed(true)}
      />

      <FullscreenButton />

      {/* Geolocate is map-only (meaningless in the pixel-space image profile).
          Fly-to is programmatic → not written to the URL. */}
      {geographic && (
        <GeolocateButton onLocate={handleGeolocate} onError={setError} />
      )}

      {!state.url && <EmptyState onSubmit={handleLoad} />}
    </div>
  );
}
