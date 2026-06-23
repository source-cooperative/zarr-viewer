import type { CSSProperties } from "react";

/** Subtle per-dimension background tints. A dimension gets the *same* tint in
 * the Dimensions table and in its data slider, so you can see at a glance which
 * slider scrubs which dimension. x/y (spatial) dims are intentionally left
 * untinted — they're rendered to the map, not scrubbed, so they have no slider
 * to pair with.
 *
 * The colors are semi-transparent so they read as a faint wash over both the
 * light and the dark panel surface without needing theme-specific values. */
const DIM_TINTS = [
  "rgba(59, 130, 246, 0.14)", // blue
  "rgba(245, 158, 11, 0.18)", // amber
  "rgba(34, 197, 94, 0.16)", // green
  "rgba(168, 85, 247, 0.16)", // purple
  "rgba(236, 72, 153, 0.15)", // pink
  "rgba(20, 184, 166, 0.18)", // teal
  "rgba(249, 115, 22, 0.16)", // orange
] as const;

/** Tint for a dimension, by its position in `order` — the full ordered list of
 * tinted (non-spatial) dim names. The table and every slider pass the same
 * `order`, so a dim lands on the same color in both, and neighbouring dims get
 * *distinct* palette entries rather than colliding the way a name hash can.
 *
 * Falls back to hashing the name when the dim isn't in `order` (or no order is
 * given) so a stray dim still gets a stable, if not guaranteed-unique, color. */
export function dimTint(name: string, order?: readonly string[]): string {
  const idx = order?.indexOf(name) ?? -1;
  if (idx >= 0) return DIM_TINTS[idx % DIM_TINTS.length];
  let h = 0;
  for (let i = 0; i < name.length; i++) {
    h = (h * 31 + name.charCodeAt(i)) | 0;
  }
  return DIM_TINTS[Math.abs(h) % DIM_TINTS.length];
}

/** Style for a dimension slider's wrapping `<label>`: the shared grid layout
 * plus, when a `tint` is given, a padded rounded panel in that color so the
 * slider visually matches its row in the Dimensions table. Untinted sliders
 * (no paired dim, e.g. x/y-free profiles) keep the bare layout. */
export function tintLabelStyle(tint?: string): CSSProperties {
  const base: CSSProperties = { display: "grid", gap: 2 };
  if (!tint) return base;
  return {
    ...base,
    background: tint,
    borderRadius: 6,
    padding: "6px 8px",
  };
}
