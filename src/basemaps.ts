import type { StyleSpecification } from "maplibre-gl";
import type { Basemap } from "./state/types";

const CARTO_LIGHT = "https://basemaps.cartocdn.com/gl/positron-gl-style/style.json";
const CARTO_DARK = "https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json";

const SATELLITE_STYLE: StyleSpecification = {
  version: 8,
  sources: {
    "esri-imagery": {
      type: "raster",
      tiles: [
        "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
      ],
      tileSize: 256,
      attribution:
        "Imagery © Esri, Maxar, Earthstar Geographics, CNES/Airbus DS, USDA, USGS, AeroGRID, IGN, GIS User Community",
    },
  },
  layers: [{ id: "esri-imagery", type: "raster", source: "esri-imagery" }],
};

const BLANK_STYLE: StyleSpecification = {
  version: 8,
  sources: {},
  layers: [
    {
      id: "background",
      type: "background",
      paint: { "background-color": "#1a1a1a" },
    },
  ],
};

export function resolveBasemap(
  choice: Basemap,
  prefersDark: boolean,
): string | StyleSpecification {
  switch (choice) {
    case "light":
      return CARTO_LIGHT;
    case "dark":
      return CARTO_DARK;
    case "satellite":
      return SATELLITE_STYLE;
    case "off":
      return BLANK_STYLE;
    case "auto":
      return prefersDark ? CARTO_DARK : CARTO_LIGHT;
  }
}

