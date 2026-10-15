import * as zarr from "zarrita";

/** Open and fully read the `band` coordinate array from the root group.
 * Returns band labels in order, or [] if the coord is absent or non-string. */
export async function fetchBandLabels(
  root: zarr.Group<zarr.Readable>,
): Promise<string[]> {
  try {
    const bandArr = await zarr.open(root.resolve("band"), { kind: "array" });
    if (!bandArr.is("string")) return [];
    const chunk = await zarr.get(bandArr);
    return Array.from(chunk.data as ArrayLike<string>);
  } catch {
    return [];
  }
}
