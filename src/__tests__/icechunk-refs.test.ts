import { expect, test } from "vitest";
import { installFloat16Polyfill } from "../zarr/float16-polyfill";
import { normalizeStoreUrl } from "../source";
import {
  asIcechunk,
  listIcechunkSnapshots,
  openV3Group,
} from "../zarr/load-zarr";

installFloat16Polyfill();

// HRRR virtual has several branches (main + backfill job branches); each branch
// tip is a single-parentless snapshot (dynamical rewrites per cycle), so history
// is short. That's enough to exercise both branch and snapshot pinning.
const URL_HRRR = normalizeStoreUrl(
  "https://source.coop/dynamical/noaa-hrrr-forecast-48-hour-virtual/v0.5.0.icechunk",
);

test("listIcechunkSnapshots returns the main branch history (tip → older)", {
  timeout: 300_000,
}, async () => {
  const snaps = await listIcechunkSnapshots(URL_HRRR, "main", 10);
  expect(snaps.length).toBeGreaterThanOrEqual(1);
  expect(snaps.length).toBeLessThanOrEqual(10);
  for (const s of snaps) {
    expect(typeof s.id).toBe("string");
    expect(s.id.length).toBeGreaterThan(0);
    expect(s.flushedAt).toBeInstanceOf(Date);
  }
  for (let i = 1; i < snaps.length; i++) {
    expect(snaps[i - 1]!.flushedAt.getTime()).toBeGreaterThanOrEqual(
      snaps[i]!.flushedAt.getTime(),
    );
  }
});

test("default open resolves the main branch tip; a pinned snapshot round-trips", {
  timeout: 300_000,
}, async () => {
  const tipId = (await listIcechunkSnapshots(URL_HRRR, "main", 1))[0]!.id;

  const def = await openV3Group(URL_HRRR, { consolidated: true });
  const info = asIcechunk(def.store)!;
  expect(info.branch).toBe("main");
  expect(info.snapshotId).toBe(tipId);
  expect(info.branches).toContain("main");

  const pinned = await openV3Group(URL_HRRR, {
    consolidated: true,
    snapshot: tipId,
  });
  expect(asIcechunk(pinned.store)?.snapshotId).toBe(tipId);
});

test("a requested branch is checked out (when the store has more than one)", {
  timeout: 300_000,
}, async () => {
  const info = asIcechunk(
    (await openV3Group(URL_HRRR, { consolidated: true })).store,
  )!;
  const other = info.branches.find((b) => b !== "main");
  if (!other) {
    // Single-branch store — nothing to switch to; the default already covers it.
    return;
  }
  const opened = await openV3Group(URL_HRRR, {
    consolidated: true,
    branch: other,
  });
  expect(asIcechunk(opened.store)?.branch).toBe(other);
});

test("an invalid snapshot id falls back to the branch tip", {
  timeout: 300_000,
}, async () => {
  const tip = (await listIcechunkSnapshots(URL_HRRR, "main", 1))[0]!.id;
  const opened = await openV3Group(URL_HRRR, {
    consolidated: true,
    snapshot: "AAAAAAAAAAAAAAAAAAAA", // valid Base32 shape, not a real snapshot
  });
  expect(asIcechunk(opened.store)?.snapshotId).toBe(tip);
});
