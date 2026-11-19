import type { StoredReply } from "@tide/protocol";
import { MAX_REPLY_BYTES, NO_UPDATE_KEY, decodeStoredReply, parseMultipart } from "@tide/protocol";

import type { Bucket } from "./bucket.ts";
import { BucketError } from "./bucket.ts";

const TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** One readable pointer, or why a record cannot be served; every reason is fixed text, never stored data. */
type Verdict =
  | { readonly kind: StoredReply["kind"]; readonly updateId?: string; readonly time?: string }
  | string;

/**
 * Prints one line per pointer under `reply/` and whether `reply/no-update` exists, reading each record's signed part
 * as stored. Returns 1 when any listed record is unreadable, else 0; a listing failure rejects.
 */
export async function status(
  bucket: Bucket,
  out: (line: string) => void,
  err: (line: string) => void,
): Promise<0 | 1> {
  let unreadable = false;
  let noUpdate: "present" | "unreadable" | "missing" = "missing";
  for (const entry of await bucket.list("reply/")) {
    if (!("key" in entry)) {
      // The name is stored data, so it is not printed.
      err("reply/: unreadable: an object name outside the key grammar");
      unreadable = true;
      continue;
    }
    const { key } = entry;
    const verdict = await check(bucket, key);
    if (key === NO_UPDATE_KEY) noUpdate = typeof verdict === "string" ? "unreadable" : "present";
    if (typeof verdict === "string") {
      err(`${key}: unreadable: ${verdict}`);
      unreadable = true;
    } else if (key !== NO_UPDATE_KEY) {
      const [, channel, runtime, platform] = key.split("/");
      out(
        `${channel} ${runtime} ${platform} ${verdict.kind} ${verdict.updateId ?? "-"} ${verdict.time}`,
      );
    }
  }
  out(`${NO_UPDATE_KEY}: ${noUpdate}`);
  return unreadable ? 1 : 0;
}

/** Reads and checks the record at `key` the way a signing client would receive it. */
async function check(bucket: Bucket, key: string): Promise<Verdict> {
  let bytes;
  try {
    bytes = (await bucket.get(key, MAX_REPLY_BYTES))?.bytes;
  } catch (e) {
    // The listing succeeded, so one failed read is this record's problem; later records are still read.
    return e instanceof BucketError ? e.message : "read failed";
  }
  if (bytes === undefined) return "absent when read";
  let reply: StoredReply;
  try {
    reply = decodeStoredReply(bytes);
  } catch {
    return "not a stored reply";
  }
  const pointer = key !== NO_UPDATE_KEY;
  if (pointer === (reply.kind === "noUpdateAvailable")) {
    return `holds ${reply.kind}, which does not fit its key`;
  }
  const partName = reply.kind === "manifest" ? "manifest" : "directive";
  let part;
  try {
    part = parseMultipart(reply.body, reply.boundary).find((p) => p.name === partName);
  } catch {
    return "body is not a valid multipart";
  }
  if (part === undefined) return `body has no ${partName} part`;
  // A client configured for code signing rejects a part without one.
  if (part.signature === undefined) return `${partName} part has no expo-signature`;
  let json: unknown;
  try {
    json = JSON.parse(utf8.decode(part.body));
  } catch {
    return `${partName} part is not JSON`;
  }
  const field = (...path: string[]) =>
    path.reduce<unknown>(
      (o, p) =>
        typeof o === "object" && o !== null && Object.hasOwn(o, p)
          ? (o as Record<string, unknown>)[p]
          : undefined,
      json,
    );

  if (reply.kind === "manifest") {
    if (field("id") !== reply.updateId) return "manifest id differs from the record's updateId";
    if (field("runtimeVersion") !== key.split("/")[2]) {
      return "manifest runtimeVersion differs from its key";
    }
    const createdAt = field("createdAt");
    if (!isTime(createdAt)) return "manifest createdAt is not a valid time";
    return { kind: reply.kind, updateId: reply.updateId, time: createdAt };
  }
  if (field("type") !== reply.kind) return `directive type is not ${reply.kind}`;
  if (reply.kind === "noUpdateAvailable") return { kind: reply.kind };
  const commitTime = field("parameters", "commitTime");
  if (!isTime(commitTime)) return "directive commitTime is not a valid time";
  return { kind: reply.kind, time: commitTime };
}

/** Exactly the form the publisher writes: an ISO 8601 UTC time with milliseconds that names a real instant. */
function isTime(value: unknown): value is string {
  if (typeof value !== "string" || !TIME.test(value)) return false;
  const ms = Date.parse(value);
  return !Number.isNaN(ms) && new Date(ms).toISOString() === value;
}
