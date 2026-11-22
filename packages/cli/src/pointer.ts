import type { Rollout, StoredReply } from "@tide-ota/protocol";
import { MAX_REPLY_BYTES, NO_UPDATE_KEY } from "@tide-ota/protocol";

import type { Bucket } from "./bucket.ts";
import type { Entry, Side } from "./status.ts";
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
 * Yields each pointer under `reply/` that `want` accepts, as checkPointer reads it and undefined when absent; a name
 * outside the key grammar yields no key.
 */
export async function* pointers(
  bucket: Bucket,
  want: (key: string) => boolean = () => true,
): AsyncGenerator<{ readonly key?: string; readonly entry?: Entry | string | undefined }> {
  for (const listed of await bucket.list("reply/")) {
    if (!("key" in listed)) {
      yield {};
      continue;
    }
    const { key } = listed;
    if (key === NO_UPDATE_KEY || !want(key)) continue;
    yield { key, entry: await readRecord(bucket, key, checkPointer) };
  }
}

/**
 * Refuses a pointer of `runtimes` on any channel signed under another keyid; `read` pointers are judged as read.
 * Reads only, never fences.
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
  const listed = pointers(bucket, (key) => !seen.has(key) && runtimes.has(runtimeOf(key)));
  for await (const { key, entry } of listed) {
    // A name outside the key grammar names no runtime.
    if (key === undefined) continue;
    // Its owner is unknown, as for an unreadable target.
    if (typeof entry === "string") throw new PublishError(`${key} is unreadable: ${entry}`);
    refuse(key, entry?.sides);
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
