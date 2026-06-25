import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { createRequire } from "node:module";

const _require = createRequire(import.meta.url);

/**
 * Locate the icechunk-js package directory.
 *
 * Uses two strategies so it works with both pnpm's virtual store (where the
 * package.json may not be reachable via _require.resolve due to exports field
 * restrictions) and classic layouts.
 */
function findIcechunkDir(): string | null {
  // Strategy 1: follow node_modules/icechunk-js symlink (pnpm-friendly).
  const symlink = resolve(process.cwd(), "node_modules", "icechunk-js");
  if (existsSync(symlink)) {
    try {
      return realpathSync(symlink);
    } catch {
      /* symlink resolution failed — fall through */
    }
  }
  // Strategy 2: _require.resolve (classic / non-pnpm layouts).
  try {
    return dirname(_require.resolve("icechunk-js/package.json"));
  } catch {
    /* ignore */
  }
  return null;
}

/**
 * Return an absolute path to alias "icechunk-js" in Vite's Rolldown bundler,
 * or null if no alias is needed (dist is present and resolvable normally).
 *
 * icechunk-js ships from a GitHub commit tarball without a pre-built dist/.
 * scripts/build-icechunk.mjs (run via postinstall) tries to build it; if that
 * succeeds, the dist entry will exist here and we return null. If the dist is
 * still absent, we alias to the TypeScript source so Vite/Oxc can bundle it
 * directly without a separate compile step.
 */
function findIcechunkSourceEntry(): string | null {
  try {
    const pkgDir = findIcechunkDir();
    if (!pkgDir) return null;

    // Read the package manifest to locate the declared dist entry.
    const pkgJsonPath = resolve(pkgDir, "package.json");
    if (existsSync(pkgJsonPath)) {
      const pkg = JSON.parse(readFileSync(pkgJsonPath, "utf-8"));
      const distEntry =
        pkg.exports?.["."]?.import ??
        pkg.exports?.["."]?.require ??
        pkg.module ??
        pkg.main;
      if (distEntry && existsSync(resolve(pkgDir, distEntry))) {
        // dist is present — Rolldown resolves the package normally, no alias.
        return null;
      }
    }

    // dist is absent — alias to the TypeScript source so Vite/Oxc can handle it.
    const dirs = ["src", "source", "lib", "typescript", "ts", ""];
    const entries = ["index.ts", "index.mts", "main.ts", "mod.ts"];
    for (const dir of dirs) {
      const base = dir ? resolve(pkgDir, dir) : pkgDir;
      if (!existsSync(base)) continue;
      for (const entry of entries) {
        const p = resolve(base, entry);
        if (existsSync(p)) return p;
      }
    }

    return null;
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
