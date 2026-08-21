import { createLogger } from "./log";
import type { AnyZarrProfile } from "./zarr/profile";
import { DEFAULT_PROFILE, getProfile } from "./zarr/profiles";

const log = createLogger("source");

/** Pick the active profile for a (url, explicit-override) pair. Profiles are
 * capability-based (not URL-matched), so an explicit `?p=` id wins; otherwise
 * any store with a `url` falls back to the default `scalar-grid` profile
 * (single-band → colormap). `null` only when there's no url. */
export function detectProfile(
  url: string | null,
  explicit: string | null,
): AnyZarrProfile | null {
  if (explicit) {
    const found = getProfile(explicit);
    if (found) {
      log.info(`profile "${found.id}" (explicit ?p=${explicit})`);
      return found;
    }
  }
  if (!url) return null;
  log.info(`profile "${DEFAULT_PROFILE.id}" (default)`);
  return DEFAULT_PROFILE;
}

/** Normalize a pasted store URL.
 *
 * Two common pitfalls people hit on source.coop datasets:
 *   1. They paste the catalog host (`source.coop/<path>`) — that returns the
 *      Next.js HTML, not the zarr bytes. The byte-serving host is
 *      `data.source.coop`.
 *   2. They include the explicit metadata key (`…/zarr.json` or
 *      `…/.zmetadata`). zarrita's `FetchStore` appends that itself, so
 *      passing it through doubles the suffix and 404s.
 */
export function normalizeStoreUrl(raw: string): string {
  let url = raw.trim();
  url = url.replace(/\/(zarr\.json|\.zmetadata)\/?$/, "");
  url = url.replace(/^(https?:\/\/)source\.coop\//, "$1data.source.coop/");
  if (url !== raw.trim()) log.debug(`normalized url: ${raw.trim()} → ${url}`);
  return url;
}

/** Schemes a store URL may use. Everything the viewer does with `?url=` is an
 * HTTP read (`fetch`, zarrita's `FetchStore`, icechunk's `HttpStorage`), so
 * these are the only two that can ever resolve to a store. */
const SUPPORTED_PROTOCOLS = new Set(["http:", "https:"]);

/** Message shown when {@link isSupportedStoreUrl} rejects a store URL. */
export const UNSUPPORTED_URL_MESSAGE =
  "That doesn't look like a store URL the viewer can open. Paste a full " +
  "http:// or https:// URL pointing at the store root.";

/** Whether `raw` is a store URL the viewer will open.
 *
 * A tripwire, not a security boundary: `?url=` is fully attacker-controlled via
 * a shared link, and today every sink it reaches is safe (an HTTP `fetch`, or
 * escaped React text). This keeps it that way by refusing anything that isn't
 * an absolute http(s) URL *before* it reaches a sink, so a future change that
 * routes the value somewhere scheme-sensitive — an `<a href>`, an `<img src>`,
 * an iframe — can't silently turn a `javascript:`/`data:` payload into script
 * execution.
 *
 * Rejecting scheme-less input (`data.source.coop/x`, `/x`, `//host/x`) is also
 * a correctness fix: the URL constructor those values feed resolves them
 * against the page origin, so they became same-origin requests that 404'd with
 * a confusing "no Zarr store found" instead of naming the real problem. */
export function isSupportedStoreUrl(raw: string): boolean {
  try {
    // Absolute-only: no `base` argument, so a relative/scheme-less input throws
    // rather than being resolved against the page.
    return SUPPORTED_PROTOCOLS.has(new URL(raw.trim()).protocol);
  } catch {
    return false; // unparseable → not a URL we can open
  }
}
