import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { createRequire } from "node:module";

const _require = createRequire(import.meta.url);

/**
 * When icechunk-js is installed from a GitHub tarball the compiled dist/ may
 * be absent (it is .gitignore'd) OR present but unresolvable by Rolldown (e.g.
 * the package exports field uses conditions Rolldown doesn't satisfy). Always
 * alias to the TypeScript source so Rolldown/Oxc can bundle it directly with
 * native TS support — no esbuild step required, and dist/ issues are bypassed
 * entirely.
 *
 * Returns null only when no TypeScript source entry is found (e.g. a proper
 * npm-registry install with a pre-built dist/ and no src/ in the tarball).
 */
function findIcechunkSourceEntry(): string | null {
  try {
    const pkgDir = dirname(_require.resolve("icechunk-js/package.json"));

    // Prefer TypeScript source unconditionally — bypasses dist/ resolution
    // issues regardless of whether prepare ran on Vercel.
    const candidates = [
      "src/index.ts",
      "src/index.mts",
      "src/main.ts",
      "index.ts",
      "lib/index.ts",
    ];
    return candidates.map((f) => resolve(pkgDir, f)).find(existsSync) ?? null;
  } catch {
    return null;
  }
}

const icechunkSourceEntry = findIcechunkSourceEntry();

export default defineConfig(() => ({
  // GitHub Pages serves from a `/geozarr-viewer/` subpath; the Pages workflow
  // sets BASE_PATH accordingly. Root-served hosts (Vercel, local dev) leave it
  // unset and get `/`.
  base: process.env.BASE_PATH ?? "/",
  plugins: [react()],
  ...(icechunkSourceEntry && {
    resolve: { alias: { "icechunk-js": icechunkSourceEntry } },
  }),
  worker: { format: "es" as const },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test-setup.ts"],
  },
}));
