export type Basemap = "auto" | "light" | "dark" | "satellite" | "off";

export type PanelState = "open" | "closed";

/** Curve applied to a rescaled [0, 1] sample before gamma / colormap. */
export type Stretch = "linear" | "log" | "sqrt";

/** Chassis-level viewer state. URL-driven, shared across profiles.
 * Profile-specific state (variable, dim indices, band picks) lives in URL
 * params parsed/serialized by the active profile. */
export type ViewerState = {
  url: string | null;
  opacity: number;
  basemap: Basemap;
  panel: PanelState;
  /** Whether the Structure (store introspection) panel is open. Mirrors
   * `panel` but for the top-left store-info panel. */
  panelStructure: PanelState;
  gamma: number;
  stretch: Stretch;
  colormap: string | null;
  rescale: [number, number] | null;
  labelsAbove: boolean;
  /** Explicit profile id override (`?p=`). Inferred from `url` when null. */
  profileId: string | null;
  /** Initial map view from the URL, as `[longitude, latitude, zoom]`.
   * When present, overrides profile-supplied initialBounds / initialView.
   * Re-serialized on every user-initiated map move. */
  view: [number, number, number] | null;
  /** URL override (`?min_zoom=`) for the active profile/store's derived
   * minimum render zoom. When set, replaces the computed `minRenderZoom` for
   * both the zoom-in hint and the layer's tile-loading floor — lets a shared
   * link force tiles to load below the auto-derived (fetch-budget) floor. */
  minZoomOverride: number | null;
};

export type ViewerStateUpdate = Partial<ViewerState>;
