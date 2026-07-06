import { isZarritaError } from "zarrita";
import { isTransientError, parseHttpStatus } from "../zarr/retry-store";
import { UnsupportedCodecError } from "../zarr/unsupported-codec";

type Props = {
  message: string | null;
  onDismiss: () => void;
  /** Visual severity. `error` (default) is the red fatal-load toast; `warn`
   * is an amber, non-fatal notice (e.g. tiles loading slowly). */
  intent?: "error" | "warn";
};

export function Toast({ message, onDismiss, intent = "error" }: Props) {
  if (!message) return null;
  return (
    <div
      role={intent === "error" ? "alert" : "status"}
      className="panel"
      style={{
        position: "absolute",
        bottom: 24,
        left: "50%",
        transform: "translateX(-50%)",
        background: intent === "error" ? "#7a1a1a" : "#6b4e16",
        color: "#ffffff",
        padding: "10px 14px",
        borderRadius: "var(--radius)",
        zIndex: 20,
        display: "flex",
        gap: 12,
        alignItems: "center",
        maxWidth: "min(640px, calc(100vw - 32px))",
      }}
    >
      <span style={{ fontSize: 13 }}>{message}</span>
      <button
        type="button"
        onClick={onDismiss}
        style={{
          background: "transparent",
          color: "#ffffff",
          border: "1px solid rgba(255,255,255,0.6)",
        }}
      >
        Dismiss
      </button>
    </div>
  );
}

/** Map a thrown error / rejected fetch to a one-line user-facing message.
 * Ordered most-specific first; a slow/flaky network (the common failure on a
 * weak link) is distinguished from a genuine 404 so we don't wrongly tell the
 * user to fix a URL that's actually reachable. */
export function humanizeError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  const lower = msg.toLowerCase();

  // Transient network / server failure that survived the store-layer retries.
  if (isTransientError(err)) {
    return "Couldn't reach the data after several retries — your connection looks slow or unstable. Check your network and try again. (This store fetches a whole chunk per tile, so a weak link can stall.)";
  }
  // Genuine missing store/key (not a transient blip).
  if (
    isZarritaError(err, "NotFoundError") ||
    (err as { name?: unknown })?.name === "NotFoundError" ||
    parseHttpStatus(msg) === 404 ||
    lower.includes("not found")
  ) {
    return "No Zarr store found at that URL (404). Check the path points to the store root (no trailing /zarr.json) — for source.coop datasets the byte-serving host is data.source.coop.";
  }
  // CORS is indistinguishable from a hard network failure in fetch(), so only
  // an explicit CORS token lands here (plain network failures are transient).
  if (lower.includes("cors")) {
    return "The host blocked this cross-origin request (CORS). For source.coop datasets use the data.source.coop byte-serving host.";
  }
  // A compression codec we can't decode in-browser (e.g. Blosc2, which has no
  // JS decoder). The store opened, but its chunks can't be decompressed — name
  // the codec so the user knows why, and point at a renderable copy.
  if (err instanceof UnsupportedCodecError || isZarritaError(err, "UnknownCodecError")) {
    const codec =
      err instanceof UnsupportedCodecError
        ? err.codecId
        : ((err as { codec?: string }).codec ?? "unknown");
    return `This dataset is compressed with the "${codec}" codec, which this viewer can't decode in the browser — the store opened, but its data can't be displayed. Supported codecs: blosc, zstd, gzip, lz4, zlib. If a Zarr v3 or Icechunk copy of the dataset exists, try that.`;
  }
  // Store opened but the viewer can't render it.
  if (
    lower.includes("no regular lat/lon gridded variables found") ||
    isZarritaError(err, "UnsupportedError") ||
    lower.includes("unsupported")
  ) {
    return "This store opened, but the viewer can't render it: no regular lat/lon gridded variable (it may use an unstructured mesh, a projected grid, or an unsupported data type).";
  }
  if (isZarritaError(err) || lower.includes("zarr") || lower.includes("metadata")) {
    return `Could not open the Zarr store: ${msg}`;
  }
  return `Could not load the Zarr store: ${msg}`;
}
