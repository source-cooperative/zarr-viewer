import type { AsyncReadable } from "zarrita";
import { defineStoreExtension, isZarritaError } from "zarrita";
import { createLogger } from "../log";
import { isAbortError } from "./tile-error";

const log = createLogger("retry");

/** Parse an HTTP status code out of an error message. Recognizes both
 * icechunk's `"HTTP 503 … for <url>"` and zarrita FetchStore's
 * `"Unexpected response status 503 …"`. The bare 4xx/5xx fallback only runs
 * when no `HTTP`-tagged code is present; callers gate it behind the
 * zarrita-error / abort checks so a stray status-shaped number in an
 * unrelated message can't reach here. */
export function parseHttpStatus(message: string): number | null {
  const tagged = /\bHTTP\s+(\d{3})\b/i.exec(message);
  if (tagged) return Number(tagged[1]);
  const status = /\bstatus\s+(\d{3})\b/i.exec(message);
  if (status) return Number(status[1]);
  const bare = /\b([45]\d\d)\b/.exec(message);
  return bare ? Number(bare[1]) : null;
}

/** A status worth retrying: rate-limit (429) or any server error (5xx). */
function statusIsTransient(status: number): boolean {
  return status === 429 || status >= 500;
}

const TRANSIENT_MESSAGE_HINTS: readonly string[] = [
  "failed to fetch",
  "network error",
  "networkerror",
  "load failed", // Safari's "Failed to fetch" wording
  "timeout",
  "timed out",
  "econnreset",
  "terminated", // undici aborted/closed socket
  "short read", // withRangeCoalescing partial response on a dropped connection
];

/** Whether an error is worth retrying: a transient network/server failure
 * rather than a permanent one.
 *
 * NOT transient (fail fast): aborts (reuse {@link isAbortError}); any
 * zarrita structured error (missing node, bad metadata, unsupported codec /
 * dtype, bad selection — none fix on retry); icechunk `NotFoundError`; and
 * HTTP 4xx other than 429.
 *
 * Transient (retry): fetch/network failures (`TypeError`, "failed to fetch",
 * timeouts, dropped sockets), icechunk `StorageError`, and HTTP 429 / 5xx. */
export function isTransientError(err: unknown): boolean {
  if (isAbortError(err)) return false;
  if (
    isZarritaError(
      err,
      "NotFoundError",
      "InvalidMetadataError",
      "InvalidSelectionError",
      "UnknownCodecError",
      "UnsupportedError",
      "CodecPipelineError",
    )
  ) {
    return false;
  }
  const name =
    err && typeof err === "object"
      ? (err as { name?: unknown }).name
      : undefined;
  // icechunk maps a 404 to its own NotFoundError (distinct from zarrita's).
  if (name === "NotFoundError") return false;
  const message =
    err instanceof Error ? err.message : typeof err === "string" ? err : "";
  // icechunk surfaces non-2xx and network failures as StorageError; classify
  // by the embedded status when present, else treat as a network blip.
  if (name === "StorageError") {
    const status = parseHttpStatus(message);
    return status === null ? true : statusIsTransient(status);
  }
  const status = parseHttpStatus(message);
  if (status !== null) return statusIsTransient(status);
  if (err instanceof TypeError) return true; // fetch() network failure
  const lower = message.toLowerCase();
  return TRANSIENT_MESSAGE_HINTS.some((hint) => lower.includes(hint));
}

export type RetryOptions = {
  /** Total attempts including the first (so 4 = 1 try + 3 retries). */
  maxAttempts?: number;
  /** Base backoff before the first retry, in ms. */
  baseDelayMs?: number;
  /** Multiplier applied per retry. */
  factor?: number;
  /** Upper bound on a single backoff, in ms. */
  maxDelayMs?: number;
};

const DEFAULTS: Required<RetryOptions> = {
  maxAttempts: 4,
  baseDelayMs: 300,
  factor: 2,
  maxDelayMs: 8000,
};

function abortError(signal: AbortSignal): unknown {
  const reason = signal.reason;
  if (reason && typeof reason === "object" && (reason as { name?: unknown }).name)
    return reason;
  return new DOMException("Aborted", "AbortError");
}

/** Full-jitter exponential backoff: a random delay in `[0, capped exp]`. */
function backoffDelay(retryIndex: number, cfg: Required<RetryOptions>): number {
  const exp = Math.min(cfg.maxDelayMs, cfg.baseDelayMs * cfg.factor ** retryIndex);
  return Math.random() * exp;
}

/** Resolve after `ms`, or reject with an AbortError if `signal` fires first. */
function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError(signal));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError(signal!));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Run `fn`, retrying transient failures with backoff. Aborts (via `signal`)
 * and permanent errors short-circuit immediately; the original error is
 * rethrown once attempts are exhausted so downstream classification (e.g.
 * `humanizeError`) still sees the real cause. */
async function retry<T>(
  fn: () => Promise<T>,
  signal: AbortSignal | undefined,
  cfg: Required<RetryOptions>,
  key: string,
): Promise<T> {
  let attempts = 0;
  for (;;) {
    if (signal?.aborted) throw abortError(signal);
    try {
      return await fn();
    } catch (err) {
      attempts++;
      if (isAbortError(err)) throw err;
      if (!isTransientError(err)) throw err;
      if (attempts >= cfg.maxAttempts) {
        log.debug(
          `gave up on ${key} after ${attempts} attempt(s)`,
          err instanceof Error ? err.message : err,
        );
        throw err;
      }
      const delay = backoffDelay(attempts - 1, cfg);
      log.debug(
        `retry ${key} (attempt ${attempts}/${cfg.maxAttempts}) in ${Math.round(delay)}ms`,
        err instanceof Error ? err.message : err,
      );
      await sleep(delay, signal);
    }
  }
}

/** Wrap a zarr store so `get`/`getRange` retry transient network/server
 * failures with exponential backoff. Built on zarrita's store-extension
 * proxy, so it overrides only those two methods and delegates everything
 * else (incl. an Icechunk store's `listNodes`/`session`/`contents` and the
 * attached `icechunk` info) to the inner store. Per-call `AbortSignal`s are
 * threaded through, so aborts stop retries at once. */
export const withRetry = defineStoreExtension(
  (store: AsyncReadable, opts: RetryOptions = {}) => {
    const cfg: Required<RetryOptions> = { ...DEFAULTS, ...opts };
    const boundGet = store.get.bind(store);
    const overrides: Partial<AsyncReadable> = {
      get: ((key, options) =>
        retry(
          () => boundGet(key, options),
          options?.signal,
          cfg,
          key,
        )) as AsyncReadable["get"],
    };
    if (store.getRange) {
      const boundGetRange = store.getRange.bind(store);
      overrides.getRange = ((key, range, options) =>
        retry(
          () => boundGetRange(key, range, options),
          options?.signal,
          cfg,
          key,
        )) as NonNullable<AsyncReadable["getRange"]>;
    }
    return overrides;
  },
);
