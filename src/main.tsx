import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "maplibre-gl/dist/maplibre-gl.css";
import "./styles.css";
import App from "./App";
import { createLogger, getLogLevel } from "./log";
import { installConsoleAbortFilter } from "./zarr/tile-error";
import { installFloat16Polyfill } from "./zarr/float16-polyfill";
import { installGribberishCodec } from "./zarr/install-gribberish-codec";

installFloat16Polyfill();
installGribberishCodec();
installConsoleAbortFilter();
createLogger("app").info(
  `starting (log level "${getLogLevel()}" — set ?log=debug for more)`,
);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
