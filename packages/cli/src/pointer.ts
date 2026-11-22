import type { Rollout, StoredReply } from "@tide-ota/protocol";
import { MAX_REPLY_BYTES, NO_UPDATE_KEY } from "@tide-ota/protocol";

import type { Bucket } from "./bucket.ts";
import type { Side } from "./status.ts";
import { BucketError } from "./bucket.ts";
import { PublishError } from "./publish-record.ts";
import { checkPointer, readRecord } from "./status.ts";

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
  const entry = checkPointer(key, object.bytes);
  if (typeof entry === "string") throw new PublishError(`${key} is unreadable: ${entry}`);
  if (entry.time === undefined) throw new PublishError(`${key} is unreadable: it has no time`);
  const { reply, sides } = entry;
  return { etag: object.etag, time: Date.parse(entry.time), reply, sides };
}

/** Returns the `<runtime>/<platform>` a pointer key names. */
export const runtimeOf = (key: string) => key.split("/").slice(2).join("/");

/**
 * Refuses when a pointer of any of `runtimes` (`<runtime>/<platform>`), on any channel, is signed under another keyid
 * than `keyId`. The pointers in `read` are judged as read, whatever a later listing shows; every other listed pointer
 * of those runtimes is read once. It reads, it does not fence: a write landing after the listing is not seen.
 */
export async function ownRuntimes(
  bucket: Bucket,
  keyId: string,
  runtimes: ReadonlySet<string>,
  read: readonly { readonly key: string; readonly previous: PointerState }[] = [],
): Promise<void> {
  const refuse = (key: string, sides: readonly Side[] = []) => {
    if (sides.some((s) => s.keyId !== keyId)) {
      throw new PublishError(
        `${key} is signed under another keyid: a new signing identity needs a new runtimeVersion`,
      );
    }
  };
  for (const { key, previous } of read) refuse(key, previous.sides);
  const seen = new Set(read.map((t) => t.key));
  for (const entry of await bucket.list("reply/")) {
    // A name outside the key grammar names no runtime.
    if (!("key" in entry)) continue;
    const { key } = entry;
    if (key === NO_UPDATE_KEY || seen.has(key) || !runtimes.has(runtimeOf(key))) continue;
    const pointer = await readRecord(bucket, key, (bytes) => checkPointer(key, bytes));
    // Its owner is unknown, as for an unreadable target.
    if (typeof pointer === "string") throw new PublishError(`${key} is unreadable: ${pointer}`);
    refuse(key, pointer?.sides);
  }
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
