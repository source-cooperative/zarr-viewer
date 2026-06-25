import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { existsSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { createRequire } from "node:module";

const _require = createRequire(import.meta.url);

/**
 * Vite plugin: resolves `icechunk-js` when the package is installed from a
 * GitHub tarball and its `dist/` wasn't produced (prepare script didn't run or
 * doesn't exist). Falls back to bundling the TypeScript source on-the-fly with
 * esbuild (which ships with Vite).
 */
function icechunkFallbackPlugin() {
  const VIRTUAL_ID = "\0icechunk-js-virtual";

  type Resolution =
    | { kind: "normal" }
    | { kind: "source"; entry: string }
    | { kind: "missing" };

  let resolution: Resolution | undefined;

  function probe(): Resolution {
    if (resolution !== undefined) return resolution;

    let pkgDir: string;
    try {
      pkgDir = dirname(_require.resolve("icechunk-js/package.json"));
    } catch {
      return (resolution = { kind: "missing" });
    }

    const pkg = JSON.parse(
      readFileSync(resolve(pkgDir, "package.json"), "utf8"),
    ) as {
      main?: string;
      module?: string;
      exports?: unknown;
    };

    // Determine the declared main entry from exports / main / module fields.
    let mainEntry: string | undefined;
    const exp = pkg.exports;
    if (typeof exp === "string") {
      mainEntry = exp;
    } else if (exp !== null && typeof exp === "object") {
      const dot = (exp as Record<string, unknown>)["."];
      if (typeof dot === "string") {
        mainEntry = dot;
      } else if (dot !== null && typeof dot === "object") {
        const d = dot as Record<string, string>;
        mainEntry = d["import"] ?? d["default"] ?? d["browser"] ?? d["module"];
      }
    }
    mainEntry ??= pkg.module ?? pkg.main ?? "index.js";

    if (existsSync(resolve(pkgDir, mainEntry))) {
      return (resolution = { kind: "normal" });
    }

    // dist/ is absent — locate the TypeScript source entry.
    const candidates = [
      "src/index.ts",
      "src/index.mts",
      "index.ts",
      "lib/index.ts",
    ];
    const entry = candidates
      .map((f) => resolve(pkgDir, f))
      .find((f) => existsSync(f));

    return (resolution = entry
      ? { kind: "source", entry }
      : { kind: "missing" });
  }

  return {
    name: "vite-plugin-icechunk-fallback",
    enforce: "pre" as const,

    resolveId(id: string) {
      if (id !== "icechunk-js") return null;
      const r = probe();
      return r.kind === "source" ? VIRTUAL_ID : null;
    },

    async load(id: string) {
      if (id !== VIRTUAL_ID) return null;
      const r = probe();
      if (r.kind !== "source") return null;

      // esbuild ships with Vite — use _require to avoid needing it as a direct
      // devDependency (pnpm strict isolation prevents `import("esbuild")` from
      // resolving types when esbuild is only a transitive dep).
      const esbuild = _require("esbuild");
      const result = await esbuild.build({
        entryPoints: [r.entry],
        write: false,
        format: "esm",
        bundle: true,
        packages: "external",
        platform: "browser",
        target: "es2020",
        logLevel: "warning",
      });

      return result.outputFiles[0]?.text ?? "";
    },
  };
}

export default defineConfig(() => ({
  // GitHub Pages serves from a `/geozarr-viewer/` subpath; the Pages workflow
  // sets BASE_PATH accordingly. Root-served hosts (Vercel, local dev) leave it
  // unset and get `/`.
  base: process.env.BASE_PATH ?? "/",
  plugins: [icechunkFallbackPlugin(), react()],
  worker: { format: "es" as const },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test-setup.ts"],
  },
}));
