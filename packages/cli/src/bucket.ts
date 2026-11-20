import { diskPath } from "@tide/protocol";

interface BucketObject {
  readonly bytes: Uint8Array<ArrayBuffer>;
  readonly etag: string; // Opaque: compared by exact string equality only.
}

/** A listed name: a store key, or a stored name outside the key grammar or, on disk, a bundle or asset it cannot open. */
export type ListEntry = { readonly key: string } | { readonly unknown: string };

/**
 * The CLI's read-write view of the bucket. A conditional write resolves undefined only when its precondition was
 * evaluated against stored state and failed; every other failure rejects with a `BucketError`.
 */
export interface Bucket {
  /** Undefined only when absent; an object over `maxBytes` is never buffered. */
  get(key: string, maxBytes: number): Promise<BucketObject | undefined>;
  /** Returns the new ETag. */
  put(key: string, bytes: Uint8Array<ArrayBuffer>): Promise<string>;
  /**
   * Creates `key` only if nothing is stored there. A `contentType` marks immutable public content, served with it
   * and cached forever; disk keeps no headers.
   */
  putIfAbsent(
    key: string,
    bytes: Uint8Array<ArrayBuffer>,
    contentType?: string,
  ): Promise<string | undefined>;
  /** Replaces `key` only if its stored ETag is exactly `etag`. */
  putIfMatch(
    key: string,
    bytes: Uint8Array<ArrayBuffer>,
    etag: string,
  ): Promise<string | undefined>;
  /** Absent is success. */
  delete(key: string): Promise<void>;
  /** Every entry whose name starts with `prefix`, in ascending UTF-8 byte order, across all pages. */
  list(prefix: string): Promise<ListEntry[]>;
  /** Epoch milliseconds by the bucket's clock. */
  time(): Promise<number>;
}

/**
 * A bucket failure; its message never names a key or holds provider text. `unknown` means a mutation may have
 * committed, or may still commit, so the caller must re-read before acting on it.
 */
export class BucketError extends Error {
  readonly outcome: "failed" | "unknown";

  constructor(message: string, outcome: "failed" | "unknown") {
    super(message);
    this.name = "BucketError";
    this.outcome = outcome;
  }
}

/** One strong RFC 9110 entity-tag: no `W/`, no `*`, no list. */
export const STRONG_ETAG = /^"[\x21\x23-\x2B\x2D-\x7E]{1,256}"$/;

/** True when `key` is in the store key grammar. */
export function isKey(key: string): boolean {
  try {
    diskPath(key);
    return true;
  } catch {
    return false;
  }
}

/** Rejects a key outside the store grammar before any I/O. */
export function checkKey(key: string): void {
  if (!isKey(key)) throw new BucketError("invalid store key", "failed");
}

/** Rejects an ETag that is not one strong entity-tag before any I/O. */
export function checkEtag(etag: string): void {
  if (!STRONG_ETAG.test(etag))
    throw new BucketError("ETag must be one strong entity-tag", "failed");
}

/** Returns -1, 0 or 1 by UTF-8 byte order, which is S3's listing order. */
export function byteOrder(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a), Buffer.from(b));
}
