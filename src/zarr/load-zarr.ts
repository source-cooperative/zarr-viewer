import {
  encodeObjectId12,
  HttpStorage,
  IcechunkStore,
  Repository,
  SpecVersion,
} from "icechunk-js";
import * as zarr from "zarrita";
import { createLogger } from "../log";
import { withRetry } from "./retry-store";

const log = createLogger("store");

export type ConsolidatedStore = zarr.Readable & {
  contents: () => { path: string; kind: "array" | "group" }[];
};

/** Version/provenance facts about an Icechunk repo, surfaced in the
 * Structure panel. Attached to the opened store (see {@link asIcechunk}). */
export type IcechunkInfo = {
  specVersion: "v1" | "v2";
  branch: string;
  snapshotId: string;
  message: string;
  flushedAt: Date;
  /** Other branches/tags in the repo. Empty for v1 stores read over plain
   * HTTP — `HttpStorage` can't list refs, so only the checked-out branch is
   * known. */
  branches: string[];
  tags: string[];
};

type IcechunkAwareStore = zarr.Readable & { icechunk: IcechunkInfo };

export type OpenedStore = {
  group: zarr.Group<zarr.Readable>;
  /** The underlying store. When `consolidated: true` was requested, this
   * is the consolidated-metadata wrapper exposing `.contents()`. For
   * Icechunk stores this is the `IcechunkStore`, which carries both a
   * `contents()` adapter and the `icechunk` info object. */
  store: zarr.Readable;
};

/** True when a (normalized) store URL points at an Icechunk repository
 * rather than a plain Zarr hierarchy. Icechunk stores have a transactional
 * `refs/`+`snapshots/`+`manifests/`+`chunks/` layout that `FetchStore`
 * can't read; they're routed through `IcechunkStore` instead.
 *
 * This is the cheap, synchronous fast path — a `.icechunk` filename suffix.
 * Repos that omit it (e.g. source.coop datasets named `*_icechunk` or under a
 * `/icechunk/` path) aren't caught here; {@link hasIcechunkRepoConfig} settles
 * those with a layout probe at open time. */
export function isIcechunkUrl(url: string): boolean {
  return /\.icechunk\/?$/.test(url.split("?")[0]!);
}

/** Layout probe: check whether a suffix-less URL is an Icechunk repo, for
 * hosts where the fast filename-suffix path (`isIcechunkUrl`) doesn't apply
 * (e.g. source.coop's `*_icechunk` datasets, or an arbitrary host like a
 * Cloudflare R2 bucket serving an Icechunk repo under its own domain).
 *
 * Tries two independent markers, since neither alone is universal across
 * writers/hosts:
 *  1. `<url>/repo` — the repo-info config object some Icechunk writers create
 *     for cheap HTTP-only discovery (data.source.coop serves this with
 *     permissive CORS, tagged `x-amz-meta-ic_file_type: repo-info`).
 *  2. `<url>/refs/branch.main/ref.json` — the `main` branch ref pointer,
 *     which the Icechunk storage spec guarantees for any repo with a default
 *     branch, independent of writer version or the `repo` marker above.
 * Both use GET rather than HEAD: some static-asset hosts (e.g. a Cloudflare
 * Worker fronting an R2 bucket) only implement GET and error/reject on HEAD,
 * which would otherwise make a real Icechunk repo look like a miss (issue
 * #62). Any network/CORS error (or a genuine 404 on a plain Zarr store)
 * returns false, falling back to the Zarr path. */
export async function hasIcechunkRepoConfig(url: string): Promise<boolean> {
  const base = url.split("?")[0]!.replace(/\/+$/, "");
  const probe = async (path: string): Promise<boolean> => {
    try {
      const res = await fetch(`${base}/${path}`);
      log.debug(`icechunk layout probe ${base}/${path} → ${res.status}`);
      return res.ok;
    } catch (err) {
      log.debug(`icechunk layout probe ${base}/${path} failed`, err);
      return false;
    }
  };
  return (await probe("repo")) || (await probe("refs/branch.main/ref.json"));
}

/** Open an Icechunk repo at `url` as a zarrita-readable store.
 *
 * `IcechunkStore` implements zarrita's `AsyncReadable` (incl. `getRange`
 * with suffix reads for sharded arrays), so once opened it plugs into the
 * same `zarr.open.v3` / `ZarrLayer` path as a plain store. Unlike
 * `FetchStore`, it must NOT be wrapped with `withRangeCoalescing` (that
 * would hide its `listNodes`/`session` methods) — coalescing is opted into
 * via the `withRangeCoalescing` option instead. ({@link withRetry} IS safe to
 * wrap it with: that store-extension proxy overrides only `get`/`getRange`
 * and delegates everything else — `listNodes`/`session`/`contents`/the
 * attached `icechunk` info — to the inner store.)
 *
 * `Repository.open` auto-detects the v1/v2 format. Ref listing is guarded:
 * over plain HTTP, v1 repos can't enumerate branches/tags, so those degrade
 * to empty while the `main` checkout (legacy ref path) still works. */
async function openIcechunk(
  url: string,
  consolidated: boolean,
  ref: { branch?: string | null; snapshot?: string | null } = {},
): Promise<OpenedStore> {
  const storage = new HttpStorage(url);
  const repo = await Repository.open({ storage });
  const [branches, tags] = await Promise.all([
    repo.listBranches().catch(() => [] as string[]),
    repo.listTags().catch(() => [] as string[]),
  ]);
  // Honor a requested branch when it's valid — or when we can't list branches
  // to validate it (v1 over plain HTTP degrades to `[]`); otherwise fall back to
  // the default (`main`, else the first listed branch).
  const requested = ref.branch ?? null;
  const branch =
    requested && (branches.length === 0 || branches.includes(requested))
      ? requested
      : branches.length === 0 || branches.includes("main")
        ? "main"
        : branches[0]!;
  const branchSession = await repo.checkoutBranch(branch);
  // A specific snapshot pins the exact repo version; on a stale/invalid id fall
  // back to the branch tip rather than hard-failing the whole load.
  let session = branchSession;
  if (ref.snapshot) {
    try {
      session = await repo.checkoutSnapshot(ref.snapshot);
    } catch (err) {
      log.warn(
        `icechunk snapshot "${ref.snapshot}" not found; using "${branch}" tip`,
        err,
      );
    }
  }
  const ice = await IcechunkStore.open(session, {
    withRangeCoalescing: zarr.withRangeCoalescing,
  });

  const info: IcechunkInfo = {
    specVersion: session.getSpecVersion() === SpecVersion.V2_0 ? "v2" : "v1",
    branch,
    snapshotId: encodeObjectId12(session.getSnapshotId()),
    message: session.getMessage(),
    flushedAt: session.getFlushedAt(),
    branches,
    tags,
  };
  log.info(
    `icechunk ${info.specVersion} branch="${info.branch}" snapshot=${info.snapshotId}`,
  );
  log.debug("icechunk refs", {
    branches: branches.length,
    tags: tags.length,
    flushedAt: info.flushedAt,
  });
  Object.assign(ice, { icechunk: info });

  if (consolidated) {
    // Icechunk has no consolidated-metadata file, but the snapshot already
    // lists every node — adapt `listNodes()` into the `contents()` shape so
    // `asConsolidated()` (and profile variable-enumeration) work unchanged.
    Object.assign(ice, {
      contents: () =>
        ice.listNodes().map((n) => ({
          path: n.path,
          kind: n.nodeData.type as "array" | "group",
        })),
    });
  }

  // Retry transient network/server failures (flaky links, source.coop
  // throttling) on every chunk/metadata read. Wraps AFTER the `contents()` /
  // `icechunk` props are attached so the proxy reflects them through.
  const store = withRetry(ice as zarr.AsyncReadable);
  const group = await zarr.open.v3(store, { kind: "group" });
  return { group, store };
}

/** Open a Zarr store at `url` (v3 or v2). Routes `.icechunk` URLs to
 * {@link openIcechunk}; everything else uses the `FetchStore` stack below.
 *
 * FetchStore stacking:
 * 1. `FetchStore` — base HTTP backend. `useSuffixRequest: true` is
 *    REQUIRED for sharded stores (AEF, FTW). The sharding codec reads
 *    its index from the end of each shard via a suffix read; zarrita's
 *    default path does a HEAD first to turn that into an absolute range,
 *    but cross-origin HEAD responses on `data.source.coop` don't expose a
 *    readable `Content-Length`, so zarrita computes `length = 0` and emits
 *    the malformed header `bytes=-N--1`. The server then answers with the
 *    whole object — a ~500 MB shard pulled per tile. A direct
 *    `bytes=-N` suffix request (which the host honors with a 206) avoids
 *    the HEAD entirely and reads only the index.
 * 2. `withRangeCoalescing` — merges concurrent `getRange` calls within a
 *    microtask if they're separated by < 32 KB. For sharded stores
 *    (AEF, FTW) this is a big win: a single tile typically reads
 *    several nearby sub-shards inside the same outer-chunk file, and
 *    coalescing collapses those into one HTTP request.
 * 3. `withConsolidatedMetadata` (optional) — exposes `.contents()` for
 *    cheap hierarchy listing without per-array `zarr.json` fetches. */
export async function openV3Group(
  url: string,
  options: {
    consolidated?: boolean;
    /** Icechunk ref selection (ignored for plain Zarr). */
    branch?: string | null;
    snapshot?: string | null;
  } = {},
): Promise<OpenedStore> {
  // Suffix is the fast path; for suffix-less URLs, a layout probe catches
  // Icechunk repos whose name doesn't end in `.icechunk` (e.g. source.coop's
  // `*_icechunk` / `/icechunk/` datasets). Plain Zarr stores cost one extra
  // HEAD (404) before falling through.
  const done = log.time(`open ${url}`, "info");
  if (isIcechunkUrl(url) || (await hasIcechunkRepoConfig(url))) {
    log.info(`open (icechunk) ${url}`);
    const opened = await openIcechunk(url, options.consolidated ?? false, {
      branch: options.branch,
      snapshot: options.snapshot,
    });
    done();
    return opened;
  }
  log.info(`open (fetch) ${url}`);
  const raw = new zarr.FetchStore(url, { useSuffixRequest: true });
  const coalesced = zarr.withRangeCoalescing(raw);
  // Retry transient failures outside coalescing so a coalesced group-read is
  // retried as one unit (and consolidated-metadata reads inherit it too).
  const retrying = withRetry(coalesced);
  let store: zarr.Readable = retrying;
  if (options.consolidated) {
    try {
      // Try v3 consolidated first (the common source.coop case), then v2
      // `.zmetadata` (e.g. SILAM's consolidated Zarr v2 stores). zarrita parses
      // the file per format and falls through on mismatch.
      store = await zarr.withConsolidatedMetadata(retrying, {
        format: ["v3", "v2"],
      });
      log.debug("consolidated metadata: hit");
    } catch {
      // Store ships no consolidated metadata (e.g. FireSmoke). Fall back to
      // the plain (still retrying) store; callers that need to enumerate
      // nodes detect the missing `contents()` via `asConsolidated` and probe.
      store = retrying;
      log.debug("consolidated metadata: miss (will probe variables)");
    }
  }
  // Auto-detect the Zarr version: zarrita's `open` tries v3 (`zarr.json`) then
  // falls back to v2 (`.zgroup`/`.zarray`), so both plain v3 stores and
  // consolidated v2 stores (SILAM) open here. It records the resolved version,
  // so later child-array opens (`zarr.open` in the profiles) stay single-request.
  const group = await zarr.open(store, { kind: "group" });
  done();
  return { group, store };
}

/** Narrow a store to the consolidated `Listable` shape. Returns null when
 * the store wasn't wrapped with `withConsolidatedMetadata` (or, for
 * Icechunk, given a `contents()` adapter). */
export function asConsolidated(store: zarr.Readable): ConsolidatedStore | null {
  if (typeof (store as ConsolidatedStore).contents === "function") {
    return store as ConsolidatedStore;
  }
  return null;
}

/** Narrow a store to its Icechunk info, or null for plain-Zarr stores. */
export function asIcechunk(store: zarr.Readable): IcechunkInfo | null {
  const info = (store as IcechunkAwareStore).icechunk;
  return info ?? null;
}

/** A commit in an Icechunk branch's history (most-recent first). */
export type IcechunkSnapshot = {
  /** Base32 snapshot id (feeds `openV3Group({ snapshot })`). */
  id: string;
  message: string;
  flushedAt: Date;
};

/** Walk an Icechunk branch's snapshot history (tip → older), capped at `limit`.
 *
 * Loaded lazily/off the hot path — most stores load without it, and a store like
 * HRRR has thousands of snapshots, so we only surface the most recent `limit`
 * for the snapshot selector. Guarded: any failure (e.g. plain-HTTP listing
 * limits) returns what was collected so far (possibly `[]`). */
export async function listIcechunkSnapshots(
  url: string,
  branch: string,
  limit = 25,
): Promise<IcechunkSnapshot[]> {
  const out: IcechunkSnapshot[] = [];
  try {
    const repo = await Repository.open({ storage: new HttpStorage(url) });
    const session = await repo.checkoutBranch(branch);
    for await (const snap of repo.walkHistory(session)) {
      out.push({
        id: snap.id,
        message: snap.message,
        flushedAt: snap.flushedAt,
      });
      if (out.length >= limit) break;
    }
  } catch (err) {
    log.debug(`listIcechunkSnapshots("${url}", "${branch}") failed`, err);
  }
  return out;
}
