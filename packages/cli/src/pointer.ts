import { MAX_REPLY_BYTES, NO_UPDATE_KEY } from "@tide/protocol";

import type { Bucket } from "./bucket.ts";
import type { Writer } from "./keys.ts";
import { BucketError } from "./bucket.ts";
import { PublishError } from "./publish-record.ts";
import { checkRecord } from "./status.ts";

/** A pointer as read before composing: the ETag its write must match and its time, both absent for none. */
export interface PointerState {
  readonly etag?: string;
  readonly time?: number; // A manifest's createdAt or a rollback's commitTime, epoch milliseconds.
}

/** Reads the pointer at `key`, refusing one a signing client could not receive. */
export async function readPointer(bucket: Bucket, key: string): Promise<PointerState> {
  const object = await bucket.get(key, MAX_REPLY_BYTES);
  if (object === undefined) return {};
  const verdict = checkRecord(key, object.bytes);
  if (typeof verdict === "string") throw new PublishError(`${key} is unreadable: ${verdict}`);
  if (verdict.time === undefined) throw new PublishError(`${key} is unreadable: it has no time`);
  return { etag: object.etag, time: Date.parse(verdict.time) };
}

/** Returns a time a client accepts as newer than the pointer it replaces, whatever the local clock says. */
export function createdAtFloor(local: number, previous: PointerState): number {
  return previous.time === undefined ? local : Math.max(local, previous.time + 1);
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
  let etag;
  try {
    etag =
      previous.etag === undefined
        ? await bucket.putIfAbsent(key, bytes)
        : await bucket.putIfMatch(key, bytes, previous.etag);
  } catch (e) {
    if (!(e instanceof BucketError)) throw e;
    const unknown = e.outcome === "unknown" ? "; outcome unknown; check with tide status" : "";
    throw new PublishError(`${key}: ${e.message}${unknown}`);
  }
  if (etag === undefined) {
    throw new PublishError(
      `${key} was changed by another writer since it was read; it keeps theirs`,
    );
  }
}

/** Creates `reply/no-update` from `bytes`, or accepts one another writer created under this identity. */
export async function ensureNoUpdate(
  writer: Writer,
  bytes: Uint8Array<ArrayBuffer>,
): Promise<void> {
  if ((await writer.bucket.putIfAbsent(NO_UPDATE_KEY, bytes)) !== undefined) return;
  if (!(await writer.checkNoUpdate())) {
    throw new PublishError(`${NO_UPDATE_KEY} was removed by another writer during the publish`);
  }
}
