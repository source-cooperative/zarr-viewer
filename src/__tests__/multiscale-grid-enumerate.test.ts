import { describe, expect, it } from "vitest";
import * as zarr from "zarrita";
import type { AsyncReadable } from "zarrita";
import { enumerateLayoutVariables } from "../zarr/profiles/multiscale-grid/profile";

// A v3 array metadata node (the inline shape stored under consolidated_metadata).
function arrayMeta(dims: string[], shape: number[], dataType: unknown = "float32") {
  return {
    zarr_format: 3,
    node_type: "array",
    shape,
    data_type: dataType,
    chunk_grid: { name: "regular", configuration: { chunk_shape: shape.map(() => 1) } },
    chunk_key_encoding: { name: "default", configuration: { separator: "/" } },
    codecs: [{ name: "bytes", configuration: { endian: "little" } }],
    fill_value: 0,
    attributes: {},
    dimension_names: dims,
  };
}

function contentsOf(metadata: Record<string, unknown>) {
  return Object.entries(metadata).map(([path, m]) => ({
    path: `/${path}`,
    kind: (m as { node_type: string }).node_type === "array" ? ("array" as const) : ("group" as const),
  }));
}

/** In-memory consolidated store serving one root `zarr.json` whose inline
 * `consolidated_metadata` holds every node. Mirrors the FTW global-predictions
 * store: a root-level ("." finest) pyramid whose data array is `variables`
 * ([time,band,y,x]) alongside CF coord/aux arrays. */
function rootPyramidStore(extra: Record<string, unknown> = {}): {
  store: AsyncReadable;
  contents: { path: string; kind: "array" | "group" }[];
} {
  const metadata: Record<string, unknown> = {
    variables: arrayMeta(["time", "band", "y", "x"], [2, 3, 4, 8]),
    spatial_ref: arrayMeta([], []),
    time: arrayMeta(["time"], [2], "int64"),
    x: arrayMeta(["x"], [8], "float64"),
    y: arrayMeta(["y"], [4], "float64"),
    // a coarser level group + its arrays (enumerate only touches the finest)
    "2x": { zarr_format: 3, node_type: "group", attributes: {} },
    "2x/variables": arrayMeta(["time", "band", "y", "x"], [2, 3, 2, 4]),
    ...extra,
  };
  const root = {
    zarr_format: 3,
    node_type: "group",
    attributes: {},
    consolidated_metadata: { kind: "inline", must_understand: false, metadata },
  };
  const bytes = new TextEncoder().encode(JSON.stringify(root));
  return {
    store: {
      async get(key: string) {
        return key === "/zarr.json" ? bytes : undefined;
      },
    },
    contents: contentsOf(metadata),
  };
}

describe("enumerateLayoutVariables — root-level ('.') pyramid", () => {
  it("finds the root-level data variable and its leading dims", async () => {
    const { store: raw, contents } = rootPyramidStore();
    const store = await zarr.withConsolidatedMetadata(raw, { format: "v3" });
    const group = await zarr.open.v3(store, { kind: "group" });

    // finestGroupPath "" = the pyramid is rooted at the store root (asset ".").
    const found = await enumerateLayoutVariables(group, "", contents);

    expect(found.map((f) => f.name)).toEqual(["variables"]);
    expect(found[0]!.dims).toEqual([
      { name: "time", size: 2 },
      { name: "band", size: 3 },
    ]);
  });

  it("skips arrays whose dtype zarrita can't open (e.g. fixed_length_utf32 `band`)", async () => {
    // The real FTW store carries a `band` coordinate array of dtype
    // fixed_length_utf32, which zarrita 0.7.3 throws on at open. It must be
    // skipped, not abort the whole enumeration.
    const { store: raw, contents } = rootPyramidStore({
      band: arrayMeta(["band"], [3], {
        name: "fixed_length_utf32",
        configuration: { length_bytes: 80 },
      }),
    });
    const store = await zarr.withConsolidatedMetadata(raw, { format: "v3" });
    const group = await zarr.open.v3(store, { kind: "group" });

    const found = await enumerateLayoutVariables(group, "", contents);

    expect(found.map((f) => f.name)).toEqual(["variables"]);
  });
});
