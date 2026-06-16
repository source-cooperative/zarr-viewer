import { describe, expect, it } from "vitest";
import * as zarr from "zarrita";
import type { AsyncReadable } from "zarrita";
import {
  enumerateVariables,
  shardSpatialShape,
} from "../zarr/profiles/scalar-grid/profile";

// A v3 array metadata node (the inline shape stored under a store's
// consolidated_metadata). Last two `dims` are the spatial pair.
function arrayMeta(dims: string[], shape: number[], dataType = "float32") {
  return {
    zarr_format: 3,
    node_type: "array",
    shape,
    data_type: dataType,
    chunk_grid: {
      name: "regular",
      configuration: { chunk_shape: shape.map(() => 1) },
    },
    chunk_key_encoding: { name: "default", configuration: { separator: "/" } },
    codecs: [{ name: "bytes", configuration: { endian: "little" } }],
    fill_value: 0,
    attributes: {},
    dimension_names: dims,
  };
}

function groupMeta(description = "") {
  return { zarr_format: 3, node_type: "group", attributes: { description } };
}

/** A read-only store serving a single consolidated root `zarr.json`. zarrita's
 * `withConsolidatedMetadata` reads only `/zarr.json` and serves every child
 * node from the inline blob, and `enumerateVariables` touches metadata only —
 * so no chunk bytes are ever requested. Mirrors the CCIWR layout: data arrays
 * live in subgroups (`RC/qtot`) with sibling coord arrays. */
function consolidatedStore(): AsyncReadable {
  const metadata: Record<string, unknown> = {
    RC: groupMeta("Relative change (%)"),
    "RC/qtot": arrayMeta(
      ["ghm", "gcm", "ssp", "horizon", "season", "lat", "lon"],
      [4, 5, 3, 3, 5, 4, 8],
    ),
    "RC/evap_total": arrayMeta(
      ["ghm", "gcm", "ssp", "horizon", "season", "lat", "lon"],
      [4, 5, 3, 3, 5, 4, 8],
    ),
    "RC/lat": arrayMeta(["lat"], [4], "float64"),
    "RC/lon": arrayMeta(["lon"], [8], "float64"),
    "RC/season": arrayMeta(["season"], [5], "int64"),
  };
  const root = {
    zarr_format: 3,
    node_type: "group",
    attributes: {},
    consolidated_metadata: { kind: "inline", must_understand: false, metadata },
  };
  const bytes = new TextEncoder().encode(JSON.stringify(root));
  return {
    async get(key: string) {
      return key === "/zarr.json" ? bytes : undefined;
    },
  };
}

describe("enumerateVariables — nested subgroups", () => {
  it("walks the consolidated hierarchy and records each variable's group", async () => {
    const store = await zarr.withConsolidatedMetadata(consolidatedStore(), {
      format: "v3",
    });
    const group = await zarr.open.v3(store, { kind: "group" });
    const arrays = new Map<string, zarr.Array<zarr.DataType, zarr.Readable>>();
    const vars = await enumerateVariables(
      group,
      new AbortController().signal,
      arrays,
    );

    // Both nested data arrays are found; coord arrays (RC/lat, RC/lon,
    // RC/season) and the RC group are skipped (no lat/lon pair / non-numeric).
    expect(vars.map((v) => v.name).sort()).toEqual([
      "RC/evap_total",
      "RC/qtot",
    ]);
    const qtot = vars.find((v) => v.name === "RC/qtot")!;
    expect(qtot.group).toBe("RC");
    // Leading (non-spatial) dims drive the per-dim selectors.
    expect(qtot.dims.map((d) => d.name)).toEqual([
      "ghm",
      "gcm",
      "ssp",
      "horizon",
      "season",
    ]);
    // The opened array is cached under the full path for reuse by resolveNode.
    expect(arrays.has("RC/qtot")).toBe(true);
  });
});

describe("shardSpatialShape", () => {
  const shardedMeta = (outer: number[]) => ({
    chunk_grid: { name: "regular", configuration: { chunk_shape: outer } },
    codecs: [
      {
        name: "sharding_indexed",
        configuration: { chunk_shape: outer.map(() => 20) },
      },
    ],
  });

  it("returns the outer shard's spatial shape for a sharded array", () => {
    // CCIWR RC/qtot: whole 360×720 plane is one shard of 20×20 sub-chunks.
    expect(shardSpatialShape(shardedMeta([4, 5, 1, 1, 1, 360, 720]))).toEqual([
      360, 720,
    ]);
  });

  it("returns null for an unsharded array (caller keeps inner chunks)", () => {
    expect(
      shardSpatialShape({
        chunk_grid: { configuration: { chunk_shape: [256, 256] } },
        codecs: [{ name: "bytes", configuration: { endian: "little" } }],
      }),
    ).toBeNull();
  });

  it("returns null on malformed / missing metadata", () => {
    expect(shardSpatialShape(null)).toBeNull();
    expect(shardSpatialShape({ codecs: [{ name: "sharding_indexed" }] })).toBeNull();
  });
});
