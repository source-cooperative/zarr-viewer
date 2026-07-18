import type { Example } from "../data/examples";

export type ExampleLoadRequest = Pick<Example, "url" | "params">;

/** Chassis fields cleared when switching to a new source unless the
 * example explicitly provides them. Mirrors what `applyChassisPatch`
 * treats as defaults: `colormap` empty, `rescale` unset, `gamma` 1,
 * `stretch` linear. */
const PROFILE_AGNOSTIC_RESET_KEYS = [
  "colormap",
  "rescale",
  "gamma",
  "stretch",
] as const;

const RESET_KEY_SET: ReadonlySet<string> = new Set(PROFILE_AGNOSTIC_RESET_KEYS);

/** Build a URL-param patch for loading an example.
 *
 * Precedence (high → low):
 *   1. The current URL — anything already in the address bar wins.
 *   2. The example's `params` defaults — fill the remaining gaps.
 *   3. Profile-agnostic reset — clears chassis render fields that
 *      shouldn't carry over across a source switch.
 *
 * `url` is always set to the example's URL. */
export function buildExampleLoadPatch(
  current: URLSearchParams,
  request: ExampleLoadRequest,
): Record<string, string | null> {
  const patch: Record<string, string | null> = { url: request.url };
  const defaults = request.params ?? {};

  // Icechunk ref selection is store-specific — never carry a stale branch/
  // snapshot across a source switch (a ref from one repo is meaningless in
  // another). Cleared here; an example may re-pin one via `params` below.
  patch.branch = null;
  patch.snapshot = null;

  // Reset keys: clear unless the example explicitly provides one (which
  // then gets applied below). Skip if the user already has the key.
  for (const key of PROFILE_AGNOSTIC_RESET_KEYS) {
    if (current.has(key)) continue;
    patch[key] = key in defaults ? defaults[key]! : null;
  }

  // Other example defaults fill gaps the user's URL leaves open.
  for (const [k, v] of Object.entries(defaults)) {
    if (RESET_KEY_SET.has(k)) continue; // already handled
    if (current.has(k)) continue;
    patch[k] = v;
  }

  return patch;
}
