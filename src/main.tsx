import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import * as Sentry from "@sentry/react";
import "maplibre-gl/dist/maplibre-gl.css";
import "./styles.css";
import App from "./App";
import { createLogger, getLogLevel } from "./log";
import { installConsoleAbortFilter } from "./zarr/tile-error";
import { installLumaLogFilter } from "./render/luma-log-filter";
import { installFloat16Polyfill } from "./zarr/float16-polyfill";
import { installGribberishCodec } from "./zarr/install-gribberish-codec";

// Error monitoring. Stays inert when VITE_SENTRY_DSN is unset (local dev, tests),
// so nothing is sent unless a DSN is injected at build time. The AbortErrors that
// tile-error.ts filters from the console are unhandled at the global level, so
// drop them here too to avoid Sentry noise.
if (import.meta.env.VITE_SENTRY_DSN) {
  Sentry.init({
    dsn: import.meta.env.VITE_SENTRY_DSN,
    environment: import.meta.env.MODE,
    release: import.meta.env.VITE_SENTRY_RELEASE,
    ignoreErrors: [/AbortError/],
  });
}

installFloat16Polyfill();
installGribberishCodec();
installConsoleAbortFilter();
installLumaLogFilter();
createLogger("app").info(
  `starting (log level "${getLogLevel()}" — set ?log=debug for more)`,
);

function ErrorFallback() {
  return (
    <div style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center", padding: 16 }}>
      <div className="panel" style={{ padding: 24, width: "min(420px, 100%)", display: "grid", gap: 12 }}>
        <h2 style={{ margin: 0, fontWeight: 600, fontSize: 20 }}>Something went wrong</h2>
        <span style={{ color: "var(--text-muted)", fontSize: 13 }}>
          The viewer hit an unexpected error and has been notified. Reloading may help.
        </span>
        <button type="button" className="primary" onClick={() => location.reload()}>
          Reload
        </button>
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Sentry.ErrorBoundary fallback={<ErrorFallback />}>
      <App />
    </Sentry.ErrorBoundary>
  </StrictMode>,
);
