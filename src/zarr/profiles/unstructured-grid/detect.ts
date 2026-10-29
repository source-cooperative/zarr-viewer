import * as zarr from "zarrita";

const LAT_NAMES = ["latitude", "lat"];
const LON_NAMES = ["longitude", "lon"];

/** Thrown by the scalar-grid profile's `prepare` when it detects an
 * unstructured grid (CF `coordinates` → 1-D lat/lon arrays), signalling the
 * chassis to switch to the `unstructured-grid` profile. */
export class UnstructuredGridStoreError extends Error {
  constructor() {
    super("unstructured grid store — use the unstructured-grid profile");
    this.name = "UnstructuredGridStoreError";
  }
}

/** Check if any array in `paths` has a CF `coordinates` attribute pointing to
 * 1-D lat/lon arrays of the correct size. Returns the first match's metadata,
 * or null when nothing qualifies. */
export async function detectUnstructuredVariable(
  group: zarr.Group<zarr.Readable>,
  paths: string[],
  signal: AbortSignal,
): Promise<{
  path: string;
  latName: string;
  lonName: string;
  gridDimSize: number;
} | null> {
  for (const path of paths) {
    if (signal.aborted) return null;
    let arr: zarr.Array<zarr.DataType, zarr.Readable>;
    try {
      arr = await zarr.open(group.resolve(path), { kind: "array" });
    } catch {
      continue;
    }
    const coords = arr.attrs.coordinates;
    if (typeof coords !== "string") continue;
    const names = coords.trim().split(/\s+/);
    const latName = names.find((n) => LAT_NAMES.includes(n));
    const lonName = names.find((n) => LON_NAMES.includes(n));
    if (!latName || !lonName) continue;
    const gridDimSize = arr.shape[arr.shape.length - 1];
    if (!gridDimSize) continue;
    try {
      const [la, lo] = await Promise.all([
        zarr.open(group.resolve(latName), { kind: "array" }),
        zarr.open(group.resolve(lonName), { kind: "array" }),
      ]);
      if (
        la.shape.length === 1 &&
        la.shape[0] === gridDimSize &&
        lo.shape.length === 1 &&
        lo.shape[0] === gridDimSize
      ) {
        return { path, latName, lonName, gridDimSize };
      }
    } catch {
      continue;
    }
  }
  return null;
}
