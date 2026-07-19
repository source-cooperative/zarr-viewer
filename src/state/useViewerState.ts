import { useCallback, useMemo, useSyncExternalStore } from "react";
import type {
  Basemap,
  PanelState,
  Stretch,
  ViewerState,
  ViewerStateUpdate,
} from "./types";

const VALID_BASEMAPS: Basemap[] = ["auto", "light", "dark", "satellite", "off"];
const VALID_PANEL: PanelState[] = ["open", "closed"];
const VALID_STRETCH: Stretch[] = ["linear", "log", "sqrt"];

const parseRescale = (raw: string | null): [number, number] | null => {
  if (!raw) return null;
  const halves = raw.split(",");
  if (halves.length !== 2) return null;
  const a = Number(halves[0]);
  const b = Number(halves[1]);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return [a, b];
};

const parseOpacity = (raw: string | null): number => {
  if (raw === null || raw === "") return 1;
  const n = Number(raw);
  if (!Number.isFinite(n)) return 1;
  return Math.min(1, Math.max(0, n));
};

const parseGamma = (raw: string | null): number => {
  if (raw === null || raw === "") return 1;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 1;
  return n;
};

const parseMinZoomOverride = (raw: string | null): number | null => {
  if (raw === null || raw === "") return null;
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  return Math.max(0, n);
};

/** Parse the three view URL params (`lng`, `lat`, `zoom`) into a tuple.
 * Returns null unless all three are present, finite, and the latitude is
 * inside [-90, 90]. The three values are only meaningful together, so a
 * partial set is treated as "no view". */
const parseView = (
  lngRaw: string | null,
  latRaw: string | null,
  zoomRaw: string | null,
): [number, number, number] | null => {
  if (lngRaw === null || latRaw === null || zoomRaw === null) return null;
  const lng = Number(lngRaw);
  const lat = Number(latRaw);
  const zoom = Number(zoomRaw);
  if (
    !Number.isFinite(lng) ||
    !Number.isFinite(lat) ||
    !Number.isFinite(zoom) ||
    lat < -90 ||
    lat > 90
  ) {
    return null;
  }
  return [lng, lat, zoom];
};

const formatViewNumber = (n: number, decimals: number): string => {
  // Trim trailing zeros and a trailing "." so common values stay short.
  return Number(n.toFixed(decimals)).toString();
};

export function parseViewerState(p: URLSearchParams): ViewerState {
  const basemapRaw = p.get("basemap");
  return {
    url: p.get("url"),
    opacity: parseOpacity(p.get("opacity")),
    basemap: VALID_BASEMAPS.includes(basemapRaw as Basemap)
      ? (basemapRaw as Basemap)
      : "auto",
    panel: VALID_PANEL.includes(p.get("panel") as PanelState)
      ? (p.get("panel") as PanelState)
      : "closed",
    panelStructure: VALID_PANEL.includes(p.get("structure") as PanelState)
      ? (p.get("structure") as PanelState)
      : "closed",
    gamma: parseGamma(p.get("gamma")),
    stretch: VALID_STRETCH.includes(p.get("stretch") as Stretch)
      ? (p.get("stretch") as Stretch)
      : "linear",
    colormap: p.get("colormap"),
    rescale: parseRescale(p.get("rescale")),
    maskBelow: p.get("mask_below") === "1",
    maskAbove: p.get("mask_above") === "1",
    labelsAbove: p.get("labels") !== "below",
    profileId: p.get("p"),
    branch: p.get("branch"),
    snapshot: p.get("snapshot"),
    view: parseView(p.get("lng"), p.get("lat"), p.get("zoom")),
    minZoomOverride: parseMinZoomOverride(p.get("min_zoom")),
  };
}

/** Apply a `ViewerStateUpdate` patch to the URL params object. Setting a
 * field to `null` clears it; setting to a non-default value writes it. */
function applyChassisPatch(p: URLSearchParams, patch: ViewerStateUpdate): void {
  if (patch.url !== undefined) {
    if (patch.url) p.set("url", patch.url);
    else p.delete("url");
  }
  if (patch.opacity !== undefined) {
    if (patch.opacity === 1) p.delete("opacity");
    else p.set("opacity", String(patch.opacity));
  }
  if (patch.basemap !== undefined) {
    if (patch.basemap === "auto") p.delete("basemap");
    else p.set("basemap", patch.basemap);
  }
  if (patch.panel !== undefined) {
    if (patch.panel === "closed") p.delete("panel");
    else p.set("panel", patch.panel);
  }
  if (patch.panelStructure !== undefined) {
    if (patch.panelStructure === "closed") p.delete("structure");
    else p.set("structure", patch.panelStructure);
  }
  if (patch.gamma !== undefined) {
    if (patch.gamma === 1) p.delete("gamma");
    else p.set("gamma", String(patch.gamma));
  }
  if (patch.stretch !== undefined) {
    if (patch.stretch === "linear") p.delete("stretch");
    else p.set("stretch", patch.stretch);
  }
  if (patch.colormap !== undefined) {
    if (patch.colormap) p.set("colormap", patch.colormap);
    else p.delete("colormap");
  }
  if (patch.rescale !== undefined) {
    if (patch.rescale) p.set("rescale", patch.rescale.join(","));
    else p.delete("rescale");
  }
  if (patch.maskBelow !== undefined) {
    if (patch.maskBelow) p.set("mask_below", "1");
    else p.delete("mask_below");
  }
  if (patch.maskAbove !== undefined) {
    if (patch.maskAbove) p.set("mask_above", "1");
    else p.delete("mask_above");
  }
  if (patch.labelsAbove !== undefined) {
    if (patch.labelsAbove) p.delete("labels");
    else p.set("labels", "below");
  }
  if (patch.profileId !== undefined) {
    if (patch.profileId) p.set("p", patch.profileId);
    else p.delete("p");
  }
  if (patch.branch !== undefined) {
    if (patch.branch) p.set("branch", patch.branch);
    else p.delete("branch");
  }
  if (patch.snapshot !== undefined) {
    if (patch.snapshot) p.set("snapshot", patch.snapshot);
    else p.delete("snapshot");
  }
  if (patch.view !== undefined) {
    if (patch.view) {
      p.set("lng", formatViewNumber(patch.view[0], 6));
      p.set("lat", formatViewNumber(patch.view[1], 6));
      p.set("zoom", formatViewNumber(patch.view[2], 2));
    } else {
      p.delete("lng");
      p.delete("lat");
      p.delete("zoom");
    }
  }
  if (patch.minZoomOverride !== undefined) {
    if (patch.minZoomOverride === null) p.delete("min_zoom");
    else p.set("min_zoom", String(patch.minZoomOverride));
  }
}

const STATE_CHANGE_EVENT = "zarr-viewer-state-change";

const subscribe = (cb: () => void) => {
  window.addEventListener("popstate", cb);
  window.addEventListener(STATE_CHANGE_EVENT, cb);
  return () => {
    window.removeEventListener("popstate", cb);
    window.removeEventListener(STATE_CHANGE_EVENT, cb);
  };
};

const getSnapshot = () => window.location.search;

/** Mutate the URL with the given chassis patch and/or raw profile-param
 * patch (`null` clears, `undefined` leaves alone). Replaces history state
 * and notifies subscribers. */
function applyToUrl(
  chassisPatch: ViewerStateUpdate,
  rawPatch: Record<string, string | null | undefined>,
) {
  const p = new URLSearchParams(window.location.search);
  applyChassisPatch(p, chassisPatch);
  for (const [k, v] of Object.entries(rawPatch)) {
    if (v === undefined) continue;
    if (v === null) p.delete(k);
    else p.set(k, v);
  }
  const qs = p.toString();
  const url = qs ? `${window.location.pathname}?${qs}` : window.location.pathname;
  window.history.replaceState(null, "", url);
  window.dispatchEvent(new Event(STATE_CHANGE_EVENT));
}

export type UseViewerStateResult = {
  state: ViewerState;
  /** Update one or more chassis fields. */
  update: (patch: ViewerStateUpdate) => void;
  /** Live URL params (snapshot — recomputed on each render). */
  params: URLSearchParams;
  /** Set/clear arbitrary URL params (used by profile-specific UI). */
  updateParams: (patch: Record<string, string | null | undefined>) => void;
};

export function useViewerState(): UseViewerStateResult {
  const search = useSyncExternalStore(subscribe, getSnapshot, () => "");
  const params = useMemo(() => new URLSearchParams(search), [search]);
  const state = useMemo(() => parseViewerState(params), [params]);

  const update = useCallback((patch: ViewerStateUpdate) => {
    applyToUrl(patch, {});
  }, []);
  const updateParams = useCallback(
    (patch: Record<string, string | null | undefined>) => {
      applyToUrl({}, patch);
    },
    [],
  );

  return { state, update, params, updateParams };
}
