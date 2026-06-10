import { afterEach, describe, expect, it, vi } from "vitest";
import type { AsyncReadable } from "zarrita";
import { NotFoundError, UnsupportedError } from "zarrita";
import {
  isTransientError,
  parseHttpStatus,
  type RetryOptions,
  withRetry,
} from "../zarr/retry-store";

const named = (name: string, message = "") =>
  Object.assign(new Error(message), { name });

describe("parseHttpStatus", () => {
  it("reads icechunk 'HTTP NNN' form", () => {
    expect(parseHttpStatus("HTTP 503 Service Unavailable for https://x")).toBe(
      503,
    );
  });
  it("reads zarrita FetchStore 'status NNN' form", () => {
    expect(parseHttpStatus("Unexpected response status 429 Too Many")).toBe(429);
  });
  it("falls back to a bare 4xx/5xx token", () => {
    expect(parseHttpStatus("got a 500 here")).toBe(500);
  });
  it("returns null when no status present", () => {
    expect(parseHttpStatus("Failed to fetch")).toBeNull();
  });
});

describe("isTransientError", () => {
  it("does NOT retry aborts", () => {
    expect(isTransientError(new DOMException("x", "AbortError"))).toBe(false);
  });
  it("does NOT retry zarrita NotFound / Unsupported", () => {
    expect(isTransientError(new NotFoundError("x"))).toBe(false);
    expect(isTransientError(new UnsupportedError("float16"))).toBe(false);
  });
  it("does NOT retry icechunk NotFoundError", () => {
    expect(isTransientError(named("NotFoundError", "Object not found: x"))).toBe(
      false,
    );
  });
  it("does NOT retry HTTP 4xx (except 429)", () => {
    expect(
      isTransientError(new Error("Unexpected response status 403 Forbidden")),
    ).toBe(false);
    expect(
      isTransientError(new Error("Unexpected response status 404 Not Found")),
    ).toBe(false);
  });
  it("retries fetch network failures", () => {
    expect(isTransientError(new TypeError("Failed to fetch"))).toBe(true);
    expect(isTransientError(new Error("terminated"))).toBe(true);
  });
  it("retries icechunk StorageError", () => {
    expect(isTransientError(named("StorageError", "Failed to fetch https://x"))).toBe(
      true,
    );
    expect(isTransientError(named("StorageError", "HTTP 502 Bad Gateway for x"))).toBe(
      true,
    );
    // 4xx StorageError (e.g. forbidden) is not transient.
    expect(isTransientError(named("StorageError", "HTTP 403 for x"))).toBe(false);
  });
  it("retries 429 and 5xx", () => {
    expect(isTransientError(new Error("HTTP 429 for x"))).toBe(true);
    expect(
      isTransientError(new Error("Unexpected response status 503 Unavailable")),
    ).toBe(true);
  });
  it("does NOT retry unknown errors", () => {
    expect(isTransientError(new Error("something weird"))).toBe(false);
  });
});

describe("withRetry", () => {
  afterEach(() => vi.useRealTimers());

  type MockStore = {
    get: ReturnType<typeof vi.fn>;
    getRange: ReturnType<typeof vi.fn>;
    listNodes?: () => string[];
  };
  const makeStore = (): MockStore => ({ get: vi.fn(), getRange: vi.fn() });
  // The mock's vi.fn() signatures are looser than AsyncReadable; cast at the
  // boundary so the test reads cleanly.
  const wrap = (store: MockStore, opts?: RetryOptions) =>
    withRetry(store as unknown as AsyncReadable, opts);

  it("retries a transient failure then resolves", async () => {
    vi.useFakeTimers();
    const store = makeStore();
    store.get
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValueOnce(new Uint8Array([1]));
    const wrapped = wrap(store, { baseDelayMs: 5, maxDelayMs: 5 });
    const p = wrapped.get("/k");
    await vi.advanceTimersByTimeAsync(20);
    await expect(p).resolves.toEqual(new Uint8Array([1]));
    expect(store.get).toHaveBeenCalledTimes(2);
  });

  it("does not retry a 404 (store returns undefined, no error)", async () => {
    const store = makeStore();
    store.get.mockResolvedValue(undefined);
    const wrapped = wrap(store);
    await expect(wrapped.get("/k")).resolves.toBeUndefined();
    expect(store.get).toHaveBeenCalledTimes(1);
  });

  it("does not retry a permanent error", async () => {
    const store = makeStore();
    const err = new Error("Unexpected response status 403 Forbidden");
    store.get.mockRejectedValue(err);
    const wrapped = wrap(store);
    await expect(wrapped.get("/k")).rejects.toBe(err);
    expect(store.get).toHaveBeenCalledTimes(1);
  });

  it("caps at maxAttempts and rethrows the original error", async () => {
    vi.useFakeTimers();
    const store = makeStore();
    const err = new TypeError("Failed to fetch");
    store.get.mockRejectedValue(err);
    const wrapped = wrap(store, {
      maxAttempts: 3,
      baseDelayMs: 1,
      maxDelayMs: 1,
    });
    const p = wrapped.get("/k");
    const assertion = expect(p).rejects.toBe(err);
    await vi.advanceTimersByTimeAsync(50);
    await assertion;
    expect(store.get).toHaveBeenCalledTimes(3);
  });

  it("rejects immediately for an already-aborted signal (no call)", async () => {
    const store = makeStore();
    store.get.mockResolvedValue(new Uint8Array([1]));
    const wrapped = wrap(store);
    const c = new AbortController();
    c.abort();
    await expect(
      wrapped.get("/k", { signal: c.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(store.get).not.toHaveBeenCalled();
  });

  it("stops retrying when aborted during backoff", async () => {
    vi.useFakeTimers();
    const store = makeStore();
    store.get.mockRejectedValue(new TypeError("Failed to fetch"));
    const wrapped = wrap(store, { baseDelayMs: 10_000, maxDelayMs: 10_000 });
    const c = new AbortController();
    const p = wrapped.get("/k", { signal: c.signal });
    const assertion = expect(p).rejects.toMatchObject({ name: "AbortError" });
    await vi.advanceTimersByTimeAsync(0); // flush first rejection → enter backoff
    c.abort(); // cancels the pending backoff sleep
    await assertion;
    expect(store.get).toHaveBeenCalledTimes(1);
  });

  it("delegates non-overridden members to the inner store", () => {
    const store = makeStore();
    store.listNodes = () => ["/a", "/b"];
    const wrapped = wrap(store) as unknown as MockStore;
    expect(typeof wrapped.listNodes).toBe("function");
    expect(wrapped.listNodes!()).toEqual(["/a", "/b"]);
  });
});
