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
import { jsonDocument } from "./json.ts";

const SCHEMA = 1;
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
  readonly sides: readonly [Side, ...Side[]];
}

/** A readable `reply/no-update`: its version and its entries by the keyid each is signed under, in keyid order. */
export interface NoUpdateRecord {
  readonly version: 1 | 3;
  readonly entries: ReadonlyMap<string, Entry>;
}

/**
 * Prints one line per pointer under `reply/` and whether `reply/no-update` exists, per keyid when it is version 3,
 * reading each record's signed parts as stored, or with `json` one document of them. Returns 1 when any listed record
 * is unreadable, else 0; a listing failure rejects.
 */
export async function status(
  bucket: Bucket,
  out: (line: string) => void,
  err: (line: string) => void,
  json = false,
): Promise<0 | 1> {
  const reported: ReturnType<typeof pointerOf>[] = [];
  const unreadable: { readonly key: string | null; readonly reason: string }[] = [];
  let noUpdate: NoUpdateRecord | "missing" | "unreadable" = "missing";
  for (const entry of await bucket.list("reply/")) {
    if (!("key" in entry)) {
      // The name is stored data, so it is not printed.
      const reason = "an object name outside the key grammar";
      err(`reply/: unreadable: ${reason}`);
      unreadable.push({ key: null, reason });
      continue;
    }
    const { key } = entry;
    const fail = (reason: string) => {
      err(`${key}: unreadable: ${reason}`);
      unreadable.push({ key, reason });
    };
    if (key === NO_UPDATE_KEY) {
      const record = (await readRecord(bucket, key, checkNoUpdate)) ?? "absent when read";
      if (typeof record === "string") fail(record);
      noUpdate = typeof record === "string" ? "unreadable" : record;
      continue;
    }
    const pointer = (await readRecord(bucket, key, checkPointer)) ?? "absent when read";
    if (typeof pointer === "string") {
      fail(pointer);
      continue;
    }
    const reportable = pointerOf(key, pointer);
    if (json) reported.push(reportable);
    else out(row(reportable));
  }
  if (json) {
    const record = typeof noUpdate === "string" ? undefined : noUpdate;
    out(
      jsonDocument({
        schema: SCHEMA,
        pointers: reported,
        noUpdate: {
          state: typeof noUpdate === "string" ? noUpdate : "present",
          version: record?.version ?? null,
          entries: [...(record?.entries.keys() ?? [])].map((keyid) => ({ keyid })),
        },
        unreadable,
      }),
    );
  } else if (typeof noUpdate === "string") out(`${NO_UPDATE_KEY}: ${noUpdate}`);
  else if (noUpdate.version === 1) out(`${NO_UPDATE_KEY}: present`);
  else {
    for (const keyid of noUpdate.entries.keys()) {
      out(`${NO_UPDATE_KEY} keyid ${JSON.stringify(keyid)}: present`);
    }
  }
  return unreadable.length > 0 ? 1 : 0;
}

/** A stored reply as reported; its fields are null when it has none, as a directive has no update ID. */
const sideOf = (s: Side) => ({
  kind: s.kind,
  updateId: s.updateId ?? null,
  time: s.time ?? null,
  keyid: s.keyId,
});

/** What `status` reports of the pointer `entry` at `key`: a reply's own fields, or a rollout's percentage and sides. */
function pointerOf(key: string, { reply, sides: [first, earlier] }: Entry) {
  const [, channel, runtimeVersion, platform] = key.split("/");
  const named = { key, channel, runtimeVersion, platform };
  if (reply.kind !== "rollout") return { ...named, ...sideOf(first) };
  return {
    ...named,
    kind: "rollout" as const,
    percent: reply.percent,
    new: sideOf(first),
    earlier: earlier === undefined ? null : sideOf(earlier),
  };
}

/** A pointer's status line: its key's columns, then `<kind> <updateId|-> <time>` or a rollout's percentage and sides. */
function row(p: ReturnType<typeof pointerOf>): string {
  const side = (s: ReturnType<typeof sideOf>) => `${s.kind} ${s.updateId ?? "-"} ${s.time}`;
  const columns =
    p.kind === "rollout"
      ? `rollout ${p.percent} new ${p.new.updateId} ${p.new.time} earlier ${p.earlier === null ? "none" : side(p.earlier)}`
      : side(p);
  return `${p.channel} ${p.runtimeVersion} ${p.platform} ${columns}`;
}

/**
 * Reads the record at `key` and returns what `check` makes of it: every reason is fixed text, never stored data.
 * Undefined when absent.
 */
export async function readRecord<T>(
  bucket: Bucket,
  key: string,
  check: (key: string, bytes: Uint8Array) => T | string,
): Promise<T | string | undefined> {
  let bytes;
  try {
    bytes = (await bucket.get(key, MAX_IDENTITIES_BYTES))?.bytes;
  } catch (e) {
    // The listing succeeded, so one failed read is this record's problem; later records are still read.
    return e instanceof BucketError ? e.message : "read failed";
  }
  return bytes === undefined ? undefined : check(key, bytes);
}

/** Checks a pointer's bytes the way a signing client would receive them; a rollout checks both sides. */
export function checkPointer(key: string, bytes: Uint8Array): Entry | string {
  let decoded;
  try {
    decoded = decodePointer(bytes);
  } catch {
    return "not a stored reply";
  }
  return checkEntry(key, decoded);
}

/** Checks the bytes of `reply/no-update` at `key`; every side of a version-3 entry must be signed under that entry's keyid. */
export function checkNoUpdate(key: string, bytes: Uint8Array): NoUpdateRecord | string {
  let decoded;
  try {
    // Version 1 first, so a misplaced reply keeps its reason.
    decoded = decodeStoredReply(bytes);
  } catch {
    try {
      decoded = decodeNoUpdate(bytes);
    } catch {
      return "not a stored reply";
    }
  }
  if (decoded.kind !== "identities") {
    const side = checkSide(key, decoded);
    if (typeof side === "string") return side;
    const entry: Entry = { reply: decoded, time: side.time, sides: [side] };
    return { version: 1, entries: new Map([[side.keyId, entry]]) };
  }
  const entries = new Map<string, Entry>();
  for (const [keyId, reply] of decoded.entries) {
    const entry = checkEntry(key, reply);
    if (typeof entry === "string") return `an entry's ${entry}`;
    if (entry.sides.some((s) => s.keyId !== keyId)) return "an entry is signed under another keyid";
    entries.set(keyId, entry);
  }
  return { version: 3, entries };
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
