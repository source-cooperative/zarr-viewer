#!/usr/bin/env node
/**
 * Build icechunk-js after pnpm install.
 *
 * icechunk-js is pinned to a GitHub commit tarball. The tarball ships only
 * git-tracked source — the compiled dist/ is .gitignore'd and must be built
 * explicitly. This script runs as the project's postinstall hook and compiles
 * icechunk-js if its dist/ is absent.
 */
import { execSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";

const _require = createRequire(import.meta.url);

function getIcechunkDir() {
  // Follow the node_modules/icechunk-js symlink first — this works with
  // pnpm's virtual store and bypasses any exports-field restrictions that
  // would make _require.resolve("icechunk-js/package.json") throw.
  const symlink = resolve(process.cwd(), "node_modules", "icechunk-js");
  if (existsSync(symlink)) {
    try {
      return realpathSync(symlink);
    } catch {
      /* ignore — fall through */
    }
  }
  // Fallback for classic (non-pnpm) layouts.
  try {
    return dirname(_require.resolve("icechunk-js/package.json"));
  } catch {
    /* package.json not accessible via exports field */
  }
  return null;
}

const pkgDir = getIcechunkDir();
if (!pkgDir) {
  console.log("[build-icechunk] icechunk-js not found in node_modules, skipping.");
  process.exit(0);
}

const pkgJsonPath = resolve(pkgDir, "package.json");
const pkg = JSON.parse(readFileSync(pkgJsonPath, "utf-8"));
const version = pkg.version ?? "(unknown)";

// Determine the declared dist entry from the package manifest.
const distEntry =
  pkg.exports?.["."]?.import ??
  pkg.exports?.["."]?.require ??
  pkg.module ??
  pkg.main;

if (distEntry && existsSync(resolve(pkgDir, distEntry))) {
  console.log(
    `[build-icechunk] icechunk-js@${version} dist already present, skipping build.`,
  );
  process.exit(0);
}

if (!pkg.scripts?.build) {
  console.log(
    `[build-icechunk] icechunk-js@${version} has no build script, skipping.`,
  );
  process.exit(0);
}

console.log(`[build-icechunk] Building icechunk-js@${version} (${pkgDir})…`);
try {
  execSync("npm run build", { cwd: pkgDir, stdio: "inherit" });
  console.log("[build-icechunk] icechunk-js built successfully.");
} catch (err) {
  // Non-fatal: the Vite alias fallback in vite.config.ts will try to resolve
  // the TypeScript source directly if dist/ is still absent after this.
  console.warn(
    "[build-icechunk] icechunk-js build failed:",
    err.message ?? err,
  );
  console.warn(
    "[build-icechunk] Continuing — Vite will attempt TypeScript source aliasing.",
  );
}
