/** Leveled, namespaced console logging for diagnosing load/render issues.
 *
 * Enabled via `?log=<level>` (persisted to `localStorage["zarr:log"]`), then
 * `localStorage`, else `info` in dev / `warn` in production. Crank it up on the
 * deployed site with `?log=debug`, or at runtime via `window.zarrLog.setLevel`.
 *
 * Coexists with `installConsoleAbortFilter` (tile-error.ts): that only drops
 * single-arg `AbortError` on `console.error` and specific `console.warn`
 * substrings; our calls are multi-arg and prefixed, so they pass through. */

export type LogLevel = "silent" | "error" | "warn" | "info" | "debug";

const ORDER: Record<LogLevel, number> = {
  silent: 0,
  error: 1,
  warn: 2,
  info: 3,
  debug: 4,
};

const STORAGE_KEY = "zarr:log";

function isLogLevel(v: unknown): v is LogLevel {
  return typeof v === "string" && v in ORDER;
}

/** Resolve the active level once at import: URL `?log=` (persisted) >
 * localStorage > dev/prod default. All host access is guarded so this is safe
 * under jsdom / non-DOM. Exported for testing. */
export function resolveInitialLevel(): LogLevel {
  try {
    const fromUrl = new URLSearchParams(window.location.search).get("log");
    if (fromUrl !== null) {
      const lvl = fromUrl.toLowerCase();
      if (isLogLevel(lvl)) {
        try {
          window.localStorage.setItem(STORAGE_KEY, lvl);
        } catch {
          /* storage may be unavailable (private mode) */
        }
        return lvl;
      }
    }
  } catch {
    /* no window/URL */
  }
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (isLogLevel(stored)) return stored;
  } catch {
    /* no localStorage */
  }
  return import.meta.env.DEV ? "info" : "warn";
}

let currentLevel: LogLevel = resolveInitialLevel();

export function getLogLevel(): LogLevel {
  return currentLevel;
}

/** Override the active level at runtime (also exposed as `window.zarrLog`). */
export function setLogLevel(level: LogLevel): void {
  currentLevel = level;
}

export function isLevelEnabled(level: LogLevel): boolean {
  return ORDER[level] <= ORDER[currentLevel] && currentLevel !== "silent";
}

const CONSOLE: Record<
  Exclude<LogLevel, "silent">,
  (...args: unknown[]) => void
> = {
  // debug → console.debug is hidden under the "Verbose" devtools filter by
  // default; use console.log so enabling `?log=debug` always shows output.
  debug: (...a) => console.log(...a),
  info: (...a) => console.info(...a),
  warn: (...a) => console.warn(...a),
  error: (...a) => console.error(...a),
};

export type Logger = {
  error(message: string, ...data: unknown[]): void;
  warn(message: string, ...data: unknown[]): void;
  info(message: string, ...data: unknown[]): void;
  debug(message: string, ...data: unknown[]): void;
  /** Whether a level would emit — guard expensive payload building with this. */
  isEnabled(level: LogLevel): boolean;
  /** Start a timer; the returned `stop()` logs elapsed ms (no-op if disabled). */
  time(label: string, level?: Exclude<LogLevel, "silent">): () => void;
};

/** Create a namespaced logger. Output is prefixed `[zarr:<ns>]`. */
export function createLogger(ns: string): Logger {
  const prefix = `[zarr:${ns}]`;
  const emit =
    (level: Exclude<LogLevel, "silent">) =>
    (message: string, ...data: unknown[]) => {
      if (!isLevelEnabled(level)) return;
      CONSOLE[level](prefix, message, ...data);
    };
  return {
    error: emit("error"),
    warn: emit("warn"),
    info: emit("info"),
    debug: emit("debug"),
    isEnabled: isLevelEnabled,
    time(label, level: Exclude<LogLevel, "silent"> = "debug") {
      if (!isLevelEnabled(level)) return () => {};
      const start = performance.now();
      return () => {
        // Re-check in case the level changed mid-operation.
        if (!isLevelEnabled(level)) return;
        CONSOLE[level](prefix, `${label} took ${Math.round(performance.now() - start)}ms`);
      };
    },
  };
}

// Convenience runtime toggle from the browser console, e.g.
// `zarrLog.setLevel("debug")`.
try {
  (window as unknown as { zarrLog?: unknown }).zarrLog = {
    setLevel: setLogLevel,
    getLevel: getLogLevel,
  };
} catch {
  /* no window */
}
