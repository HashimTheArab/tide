import type { Rollout, StoredReply } from "@tide-ota/protocol";
import { MAX_REPLY_BYTES } from "@tide-ota/protocol";

import type { Bucket } from "./bucket.ts";
import type { Side } from "./status.ts";
import { BucketError } from "./bucket.ts";
import { PublishError } from "./publish-record.ts";
import { checkRecord } from "./status.ts";

/** A pointer as read before composing: the ETag its write must match, its newest time and what it holds; all absent for none. */
export interface PointerState {
  readonly etag?: string;
  readonly time?: number; // The newest createdAt or commitTime it holds, epoch milliseconds.
  readonly reply?: StoredReply | Rollout; // Exact bodies, so a writer can copy them.
  readonly sides?: readonly Side[]; // `[reply]`, or a rollout's `[new, earlier?]`.
}

/** Reads the pointer at `key`, refusing one a signing client could not receive. */
export async function readPointer(bucket: Bucket, key: string): Promise<PointerState> {
  const object = await bucket.get(key, MAX_REPLY_BYTES);
  if (object === undefined) return {};
  const verdict = checkRecord(key, object.bytes);
  if (typeof verdict === "string") throw new PublishError(`${key} is unreadable: ${verdict}`);
  if (verdict.time === undefined) throw new PublishError(`${key} is unreadable: it has no time`);
  const { reply, sides } = verdict;
  return { etag: object.etag, time: Date.parse(verdict.time), reply, sides };
}

/** Returns a time a client accepts as newer than the pointer it replaces, whatever the local clock says. */
export function createdAtFloor(local: number, previous: PointerState): number {
  return previous.time === undefined ? local : Math.max(local, previous.time + 1);
}

/**
 * Runs one write to `key`, naming the key in a bucket failure. An unknown outcome may have committed, so the message
 * says so with `unknown`, the reader's next step.
 */
export async function writing<T>(
  key: string,
  write: () => Promise<T>,
  unknown = "check with tide status",
): Promise<T> {
  try {
    return await write();
  } catch (e) {
    if (!(e instanceof BucketError)) throw e;
    const hint = e.outcome === "unknown" ? `; outcome unknown; ${unknown}` : "";
    throw new PublishError(`${key}: ${e.message}${hint}`);
  }
}

/**
 * Writes the pointer only over the ETag that was read, or only if still absent. A lost race fails at once and
 * leaves the other writer's reply; an unknown outcome may already be live.
 */
export async function writePointer(
  bucket: Bucket,
  key: string,
  bytes: Uint8Array<ArrayBuffer>,
  previous: PointerState,
): Promise<void> {
  const etag = await writing(key, () =>
    previous.etag === undefined
      ? bucket.putIfAbsent(key, bytes)
      : bucket.putIfMatch(key, bytes, previous.etag),
  );
  if (etag === undefined) {
    throw new PublishError(
      `${key} was changed by another writer since it was read; it keeps theirs`,
    );
  }
}
