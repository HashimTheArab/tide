import type { Rollout, StoredReply } from "@tide-ota/protocol";
import {
  MAX_IDENTITIES_BYTES,
  NO_UPDATE_KEY,
  decodeNoUpdate,
  decodePointer,
  decodeStoredReply,
  parseExpoSignature,
  parseMultipart,
} from "@tide-ota/protocol";

import type { Bucket } from "./bucket.ts";
import { BucketError } from "./bucket.ts";

const TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** One stored reply with its signed part as stored. */
export interface Side {
  readonly kind: StoredReply["kind"];
  readonly updateId?: string;
  readonly time?: string;
  readonly keyId: string; // The keyid its expo-signature names, `root` when it names none.
  readonly signed: {
    readonly body: Uint8Array<ArrayBuffer>;
    readonly signature: string;
    readonly chain?: Uint8Array<ArrayBuffer>; // The reply's certificate_chain part body, when it has one.
  };
}

/** One identity's replies (`[reply]`, or a rollout's `[new, earlier?]`) and the newest time they hold. */
export interface Entry {
  readonly reply: StoredReply | Rollout;
  readonly time: string | undefined; // Undefined only for `reply/no-update`.
  readonly sides: readonly Side[];
}

/**
 * One readable record: a version-1 or version-2 record's one entry, or a version-3 record's entries by keyid, in keyid
 * order. Otherwise why it cannot be served; every reason is fixed text, never stored data.
 */
export type Verdict =
  | { readonly layout: "legacy"; readonly entry: Entry }
  | { readonly layout: "identities"; readonly entries: ReadonlyMap<string, Entry> }
  | string;

/**
 * Prints one line per pointer under `reply/`, and per keyid in a version-3 pointer, and whether `reply/no-update`
 * exists, reading each record's signed parts as stored. Returns 1 when any listed record is unreadable, else 0; a
 * listing failure rejects.
 */
export async function status(
  bucket: Bucket,
  out: (line: string) => void,
  err: (line: string) => void,
): Promise<0 | 1> {
  let unreadable = false;
  let noUpdate = [`${NO_UPDATE_KEY}: missing`];
  for (const entry of await bucket.list("reply/")) {
    if (!("key" in entry)) {
      // The name is stored data, so it is not printed.
      err("reply/: unreadable: an object name outside the key grammar");
      unreadable = true;
      continue;
    }
    const { key } = entry;
    const verdict = (await readRecord(bucket, key)) ?? "absent when read";
    if (typeof verdict === "string") {
      err(`${key}: unreadable: ${verdict}`);
      unreadable = true;
      if (key === NO_UPDATE_KEY) noUpdate = [`${NO_UPDATE_KEY}: unreadable`];
    } else if (key === NO_UPDATE_KEY) {
      noUpdate =
        verdict.layout === "legacy"
          ? [`${NO_UPDATE_KEY}: present`]
          : [...verdict.entries.keys()].map((k) => `${NO_UPDATE_KEY} keyid ${quoted(k)}: present`);
    } else {
      const [, channel, runtime, platform] = key.split("/");
      const columns = `${channel} ${runtime} ${platform}`;
      if (verdict.layout === "legacy") out(`${columns} ${row(verdict.entry)}`);
      else for (const [k, e] of verdict.entries) out(`${columns} keyid ${quoted(k)} ${row(e)}`);
    }
  }
  for (const line of noUpdate) out(line);
  return unreadable ? 1 : 0;
}

/** A keyid as status prints it: a JSON string, which for printable ASCII escapes only `"` and `\`. */
const quoted = (keyId: string) => JSON.stringify(keyId);

/** A pointer's status columns after its key's: `<kind> <updateId|-> <time>`, or a rollout's percentage and sides. */
function row({ reply, sides }: Entry): string {
  const side = (s: Side | undefined) =>
    s === undefined ? "none" : `${s.kind} ${s.updateId ?? "-"} ${s.time}`;
  const [first, earlier] = sides;
  if (reply.kind !== "rollout") return side(first);
  return `rollout ${reply.percent} new ${reply.new.updateId} ${first?.time} earlier ${side(earlier)}`;
}

/** Reads and checks the record at `key`; undefined when absent. */
export async function readRecord(bucket: Bucket, key: string): Promise<Verdict | undefined> {
  let bytes;
  try {
    bytes = (await bucket.get(key, MAX_IDENTITIES_BYTES))?.bytes;
  } catch (e) {
    // The listing succeeded, so one failed read is this record's problem; later records are still read.
    return e instanceof BucketError ? e.message : "read failed";
  }
  return bytes === undefined ? undefined : checkRecord(key, bytes);
}

/**
 * Checks the bytes stored at `key` the way a signing client would receive them; a rollout checks both sides. Every
 * side of a version-3 entry must be signed under that entry's keyid.
 */
export function checkRecord(key: string, bytes: Uint8Array): Verdict {
  const decoded = decode(key, bytes);
  if (decoded === undefined) return "not a stored reply";
  if (decoded.kind !== "identities") {
    const entry = checkEntry(key, decoded);
    return typeof entry === "string" ? entry : { layout: "legacy", entry };
  }
  const entries = new Map<string, Entry>();
  for (const [keyId, reply] of decoded.entries) {
    const entry = checkEntry(key, reply);
    if (typeof entry === "string") return `an entry's ${entry}`;
    if (entry.sides.some((s) => s.keyId !== keyId)) return "an entry is signed under another keyid";
    entries.set(keyId, entry);
  }
  return { layout: "identities", entries };
}

/** Decodes a record of `key`'s kind, or undefined. Version 1 first at `reply/no-update`, so a misplaced reply keeps its reason. */
function decode(key: string, bytes: Uint8Array) {
  try {
    if (key !== NO_UPDATE_KEY) return decodePointer(bytes);
    try {
      return decodeStoredReply(bytes);
    } catch {
      return decodeNoUpdate(bytes);
    }
  } catch {
    return undefined;
  }
}

/** Checks one identity's reply or rollout at `key`. */
function checkEntry(key: string, reply: StoredReply | Rollout): Entry | string {
  if (reply.kind !== "rollout") {
    const side = checkSide(key, reply);
    return typeof side === "string" ? side : { reply, time: side.time, sides: [side] };
  }
  const next = checkSide(key, reply.new);
  if (typeof next === "string") return `new reply: ${next}`;
  if (reply.earlier === undefined) return { reply, time: next.time, sides: [next] };
  const earlier = checkSide(key, reply.earlier);
  if (typeof earlier === "string") return `earlier reply: ${earlier}`;
  // Both are valid times: every manifest and rollback has one.
  const time =
    Date.parse(earlier.time ?? "") > Date.parse(next.time ?? "") ? earlier.time : next.time;
  return { reply, time, sides: [next, earlier] };
}

/** Checks one stored reply at `key`. */
function checkSide(key: string, reply: StoredReply): Side | string {
  const pointer = key !== NO_UPDATE_KEY;
  if (pointer === (reply.kind === "noUpdateAvailable")) {
    return `holds ${reply.kind}, which does not fit its key`;
  }
  const partName = reply.kind === "manifest" ? "manifest" : "directive";
  let parts;
  try {
    parts = parseMultipart(reply.body, reply.boundary);
  } catch {
    return "body is not a valid multipart";
  }
  const part = parts.find((p) => p.name === partName);
  if (part === undefined) return `body has no ${partName} part`;
  // A client configured for code signing rejects a part without one.
  const { body, signature } = part;
  if (signature === undefined) return `${partName} part has no expo-signature`;
  const chain = parts.find((p) => p.name === "certificate_chain")?.body;
  const signed = chain === undefined ? { body, signature } : { body, signature, chain };
  let keyId;
  try {
    ({ keyId } = parseExpoSignature(signature));
  } catch {
    return `${partName} part has a malformed expo-signature`;
  }
  let json: unknown;
  try {
    json = JSON.parse(utf8.decode(body));
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
    return { kind: reply.kind, updateId: reply.updateId, time: createdAt, keyId, signed };
  }
  if (field("type") !== reply.kind) return `directive type is not ${reply.kind}`;
  if (reply.kind === "noUpdateAvailable") return { kind: reply.kind, keyId, signed };
  const commitTime = field("parameters", "commitTime");
  if (!isTime(commitTime)) return "directive commitTime is not a valid time";
  return { kind: reply.kind, time: commitTime, keyId, signed };
}

/** Exactly the form the publisher writes: an ISO 8601 UTC time with milliseconds that names a real instant. */
export function isTime(value: unknown): value is string {
  if (typeof value !== "string" || !TIME.test(value)) return false;
  const ms = Date.parse(value);
  return !Number.isNaN(ms) && new Date(ms).toISOString() === value;
}
