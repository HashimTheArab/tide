import { ProtocolError, sha256Hex } from "./hash.ts";
import { UUID } from "./manifest.ts";
import { BOUNDARY } from "./multipart.ts";
import { encodeSfvDictionary, parseSfvDictionary } from "./sfv.ts";

/**
 * A ready-to-serve `/manifest` reply: the exact signed multipart body and what the server sends beside it. The
 * publisher derives every field from the parts it built and signed (docs/design.md, Stored replies).
 */
export type StoredReply =
  | {
      readonly kind: "manifest";
      readonly updateId: string;
      readonly boundary: string;
      readonly manifestFilters: string;
      readonly body: Uint8Array<ArrayBuffer>;
    }
  | {
      readonly kind: "rollBackToEmbedded";
      readonly boundary: string;
      readonly body: Uint8Array<ArrayBuffer>;
    }
  | {
      readonly kind: "noUpdateAvailable";
      readonly boundary: string;
      readonly body: Uint8Array<ArrayBuffer>;
    };

type Kind = StoredReply["kind"];
type ManifestReply = Extract<StoredReply, { kind: "manifest" }>;
type RollbackReply = Extract<StoredReply, { kind: "rollBackToEmbedded" }>;

/**
 * A pointer that serves `new` to `percent` of devices and `earlier` to the rest; an absent earlier reply means the
 * stored `reply/no-update`. Both bodies are the exact signed bytes.
 */
export interface Rollout {
  readonly kind: "rollout";
  readonly percent: number; // 0 to 100 in steps of 0.01.
  readonly new: ManifestReply;
  readonly earlier: ManifestReply | RollbackReply | undefined;
}

/** The key of the signed noUpdateAvailable reply served when no pointer applies. */
export const NO_UPDATE_KEY = "reply/no-update";
/** The content keys that URLs published by earlier servers name, written by the legacy import. */
export const LEGACY_MAP_KEY = "legacy/map.json";
/** The largest record the server reads; encode refuses a larger one. */
export const MAX_REPLY_BYTES = 2 * 1024 * 1024;
/** The longest `expo-manifest-filters` value, well under the smallest client header budget. */
export const MAX_FILTERS_BYTES = 4096;

const VERSION = 1;
const ROLLOUT_VERSION = 2;
const BUCKETS = 10_000; // One per 0.01 percentage point.
// Fields each kind's record may hold; a directive has no update ID or filters.
const RECORD_FIELDS: Record<Kind, readonly string[]> = {
  manifest: ["version", "kind", "updateId", "contentType", "manifestFilters", "body"],
  rollBackToEmbedded: ["version", "kind", "contentType", "body"],
  noUpdateAvailable: ["version", "kind", "contentType", "body"],
};
/** A content-addressed bundle or asset key; lowercase, so it is safe on case-insensitive disks. */
export const CONTENT_KEY = /^(?:assets|bundles)\/[0-9a-f]{64}$/;
// Release record, base record and patch keys, lowercase for the same reason.
const RECORD_KEY = new RegExp(`^updates/${UUID.source.slice(1, -1)}\\.json$`);
const BASE_KEY = new RegExp(`^bases/${UUID.source.slice(1, -1)}$`);
const PATCH_KEY = /^patches\/[0-9a-f]{64}\/[0-9a-f]{64}$/;
const IDENTITY_KEY = /^identities\/[0-9a-f]{64}$/;
const CONTENT_TYPE = /^multipart\/mixed; boundary=(.*)$/s;
// Covers every Expo runtime policy: appVersion `2.6.2`, nativeVersion `1.0.0(1)`, sdkVersion `exposdk:57.0.0`.
const NAME = /^[A-Za-z0-9._+():-]{1,64}$/;

const encoder = new TextEncoder();
const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** Returns the record bytes for `reply`: one JSON object, keys in a fixed order, the body as a string. */
export function encodeStoredReply(reply: StoredReply): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(
    encoder.encode(JSON.stringify({ version: VERSION, ...replyFields(reply) })),
  );
  decodeStoredReply(bytes); // Encode never writes what decode refuses.
  return bytes;
}

/** Returns the version-2 record bytes for `rollout`, keys in a fixed order and both bodies as strings. */
export function encodeRollout(rollout: Rollout): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(encoder.encode(serializeRollout(rollout)));
  decodePointer(bytes); // Encode never writes what decode refuses.
  return bytes;
}

/** Returns the reply a version-1 record holds, with the body's exact bytes; a record encode would refuse is rejected. */
export function decodeStoredReply(bytes: Uint8Array): StoredReply {
  const { record, version } = parseRecord(bytes);
  if (version !== VERSION) throw new ProtocolError("version", "is not supported");
  return readReply(record);
}

/** Returns what a pointer key holds: a version-1 reply or a version-2 rollout. */
export function decodePointer(bytes: Uint8Array): StoredReply | Rollout {
  const { record, text, version } = parseRecord(bytes);
  if (version === VERSION) return readReply(record);
  if (version === ROLLOUT_VERSION) return readRollout(record, text);
  throw new ProtocolError("version", "is not supported");
}

/** Returns `header` lowercased when it is exactly one UUID, else undefined. */
export function rolloutClientId(header: string | undefined): string | undefined {
  const id = header?.toLowerCase();
  return id !== undefined && UUID.test(id) ? id : undefined;
}

/** Returns the bucket, 0 to 9999, of a `rolloutClientId` result in the rollout of `updateId`. */
export async function rolloutBucket(clientId: string, updateId: string): Promise<number> {
  const input = encoder.encode(`${updateId}:${clientId}`);
  const digest = await crypto.subtle.digest("SHA-256", input);
  return new DataView(digest).getUint32(0) % BUCKETS;
}

/**
 * Returns the side of `rollout` a request with this `EAS-Client-ID` value gets. 100% is `new` for every request;
 * otherwise a request without a usable client ID gets `earlier`.
 */
export async function rolloutSide(
  rollout: Rollout,
  clientIdHeader: string | undefined,
): Promise<"new" | "earlier"> {
  if (rollout.percent === 100) return "new";
  const id = rolloutClientId(clientIdHeader);
  if (id === undefined) return "earlier";
  const bucket = await rolloutBucket(id, rollout.new.updateId);
  return bucket < Math.round(rollout.percent * 100) ? "new" : "earlier";
}

/** A reply's record fields without `version`, in the fixed order; `body` defaults to the reply's bytes decoded. */
function replyFields(reply: StoredReply, body = bodyText(reply.body)): Record<string, unknown> {
  const contentType = `multipart/mixed; boundary=${reply.boundary}`;
  return reply.kind === "manifest"
    ? {
        kind: reply.kind,
        updateId: reply.updateId,
        contentType,
        manifestFilters: reply.manifestFilters,
        body,
      }
    : { kind: reply.kind, contentType, body };
}

function bodyText(body: Uint8Array): string {
  try {
    return utf8.decode(body);
  } catch {
    throw new ProtocolError("body", "is not UTF-8");
  }
}

/**
 * The exact version-2 record text for `rollout`; an absent reply is written as null. `bodies` are the replies' bodies
 * as strings when the caller already holds them, so a read does not decode the bytes it just encoded.
 */
function serializeRollout(
  rollout: Rollout,
  bodies?: { new: string; earlier: string | undefined },
): string {
  // `unknown`: a JavaScript caller may pass null or a missing reply, which decode then refuses.
  const nested = (field: string, reply: unknown, body: string | undefined) => {
    if (typeof reply !== "object" || reply === null) return null;
    try {
      return replyFields(reply as StoredReply, body);
    } catch (e) {
      throw prefixed(field, e);
    }
  };
  return JSON.stringify({
    version: ROLLOUT_VERSION,
    kind: "rollout",
    percent: rollout.percent,
    new: nested("new", rollout.new, bodies?.new),
    earlier: nested("earlier", rollout.earlier, bodies?.earlier),
  });
}

/** Parses a record up to its version; every decoder starts here. */
function parseRecord(bytes: Uint8Array): {
  record: Record<string, unknown>;
  text: string;
  version: number;
} {
  if (bytes.length > MAX_REPLY_BYTES) {
    throw new ProtocolError("record", `is too large: over ${MAX_REPLY_BYTES} bytes`);
  }
  let text: string;
  try {
    text = utf8.decode(bytes);
  } catch {
    throw new ProtocolError("record", "is not UTF-8");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ProtocolError("record", "is not JSON");
  }
  if (!isObject(parsed)) throw new ProtocolError("record", "must be a JSON object");
  // Version first, so a later layout is reported as unsupported rather than as malformed.
  const version = present(parsed, "version");
  if (!Number.isInteger(version)) throw new ProtocolError("version", "must be an integer");
  return { record: parsed, text, version: version as number };
}

/** Reads a version-1 reply, or a reply inside a rollout, whose exact-text check refuses a nested `version`. */
function readReply(r: Record<string, unknown>): StoredReply {
  const kind = checkKind(present(r, "kind"));
  for (const key of Object.keys(r)) {
    if (!RECORD_FIELDS[kind].includes(key))
      throw new ProtocolError(key, `is not a field of a ${kind} reply`);
  }
  const contentType = present(r, "contentType");
  const boundary =
    typeof contentType === "string" ? CONTENT_TYPE.exec(contentType)?.[1] : undefined;
  if (boundary === undefined || !BOUNDARY.test(boundary)) {
    throw new ProtocolError("contentType", "must be multipart/mixed; boundary=<boundary>");
  }
  const body = present(r, "body");
  if (typeof body !== "string" || body === "") {
    throw new ProtocolError("body", "must be a non-empty string");
  }
  // JSON.parse accepts an escaped lone surrogate, which TextEncoder would replace with U+FFFD.
  if (!body.isWellFormed()) throw new ProtocolError("body", "is not well-formed Unicode");
  const bodyBytes = new Uint8Array(encoder.encode(body));

  if (kind !== "manifest") return { kind, boundary, body: bodyBytes };
  return {
    kind,
    updateId: checkUpdateId(present(r, "updateId")),
    boundary,
    manifestFilters: checkFilters(present(r, "manifestFilters")),
    body: bodyBytes,
  };
}

/**
 * Reads a version-2 record, which must be exactly what `serializeRollout` writes for it; that comparison refuses any
 * other key, kind, order or spelling.
 */
function readRollout(r: Record<string, unknown>, text: string): Rollout {
  const percent = present(r, "percent");
  if (
    typeof percent !== "number" ||
    !(percent >= 0 && percent <= 100) ||
    Math.round(percent * 100) / 100 !== percent
  ) {
    throw new ProtocolError("percent", "must be a number from 0 to 100 in steps of 0.01");
  }
  const [next, newBody] = nestedReply(present(r, "new"), "new", ["manifest"]);
  const earlierValue = present(r, "earlier");
  const [earlier, earlierBody] =
    earlierValue === null
      ? []
      : nestedReply(earlierValue, "earlier", ["manifest", "rollBackToEmbedded"]);
  if (earlier?.kind === "manifest" && earlier.updateId === next.updateId) {
    throw new ProtocolError("earlier.updateId", "must differ from new.updateId");
  }
  const rollout: Rollout = { kind: "rollout", percent, new: next, earlier };
  // Refuses another key order, whitespace, escape or number spelling.
  if (serializeRollout(rollout, { new: newBody, earlier: earlierBody }) !== text) {
    throw new ProtocolError("record", "must be exactly what encodeRollout writes");
  }
  return rollout;
}

/** Reads the reply at rollout field `field`, which must be one of `kinds`, and returns it with its body string. */
function nestedReply<K extends Kind>(
  value: unknown,
  field: string,
  kinds: readonly K[],
): [Extract<StoredReply, { kind: K }>, string] {
  const expected = `must be a ${kinds.join(" or ")} reply`;
  if (!isObject(value)) throw new ProtocolError(field, expected);
  let reply: StoredReply;
  try {
    reply = readReply(value);
  } catch (e) {
    throw prefixed(field, e);
  }
  if (!(kinds as readonly Kind[]).includes(reply.kind)) {
    throw new ProtocolError(`${field}.kind`, expected);
  }
  // readReply has checked that `body` is a well-formed string.
  return [reply as Extract<StoredReply, { kind: K }>, value.body as string];
}

/** Returns `e` with its field under `field`, or `e` itself when it is not a ProtocolError. */
function prefixed(field: string, e: unknown): unknown {
  if (!(e instanceof ProtocolError)) return e;
  return new ProtocolError(`${field}.${e.field}`, e.message.slice(e.field.length + 1));
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Returns the pointer key for a channel, runtime version and platform; names outside the grammar are rejected. */
export function replyKey(channel: string, runtimeVersion: string, platform: string): string {
  checkName(channel, "channel");
  checkName(runtimeVersion, "runtimeVersion");
  if (platform !== "ios" && platform !== "android") {
    throw new ProtocolError("platform", "must be ios or android");
  }
  return `reply/${channel}/${runtimeVersion}/${platform}`;
}

/** Returns the base record key for `updateId`, which must be a lowercase UUID. */
export function baseKey(updateId: string): string {
  return `bases/${checkUpdateId(updateId)}`;
}

/** Returns the key of the patch from bundle `fromHex` to bundle `toHex`, each 64 lowercase hex. */
export function patchKey(fromHex: string, toHex: string): string {
  const key = `patches/${fromHex}/${toHex}`;
  if (!PATCH_KEY.test(key)) throw new ProtocolError("key", "must name two 64-hex bundle keys");
  return key;
}

/** Returns the key of the CLI's binding for `keyId`, named by the SHA-256 of its UTF-8; no server reads it. */
export async function identityKey(keyId: string): Promise<string> {
  return `identities/${await sha256Hex(new Uint8Array(encoder.encode(keyId)))}`;
}

/**
 * Returns the relative file path that holds `key` on disk. Names are hex-escaped to lowercase without `.` or `-`, so
 * no two keys share a path on a case-insensitive filesystem and no name collides with `reply/no-update`.
 */
export function diskPath(key: string): string {
  if (
    key === NO_UPDATE_KEY ||
    key === LEGACY_MAP_KEY ||
    CONTENT_KEY.test(key) ||
    RECORD_KEY.test(key) ||
    BASE_KEY.test(key) ||
    PATCH_KEY.test(key) ||
    IDENTITY_KEY.test(key)
  ) {
    return key;
  }
  const [prefix, channel = "", runtime = "", platform = "", ...rest] = key.split("/");
  if (prefix !== "reply" || rest.length > 0) throw new ProtocolError("key", "is not a store key");
  try {
    replyKey(channel, runtime, platform);
  } catch {
    throw new ProtocolError("key", "is not a store key");
  }
  return `reply/${escapeName(channel)}/${escapeName(runtime)}/${platform}`;
}

/** Returns the key whose `diskPath` is `path`, or undefined when no key maps there. */
export function diskKey(path: string): string | undefined {
  const key = unescapeDiskPath(path);
  try {
    return diskPath(key) === path ? key : undefined;
  } catch {
    return undefined;
  }
}

/** Reverses `diskPath`'s escaping; for a directory `diskPath` creates, this is the key prefix it holds. */
export function unescapeDiskPath(path: string): string {
  return path.replace(/_([0-9a-f]{2})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16)));
}

function escapeName(name: string): string {
  return name.replace(/[^a-z0-9]/g, (c) => `_${c.charCodeAt(0).toString(16).padStart(2, "0")}`);
}

export function checkName(value: string, field: string): void {
  // Dot segments would resolve in an S3 URL or a path join.
  if (!NAME.test(value) || value === "." || value === "..") {
    throw new ProtocolError(
      field,
      "must be 1 to 64 of A-Z, a-z, 0-9, ., _, +, -, (, ) and :, and not . or ..",
    );
  }
}

function checkKind(kind: unknown): Kind {
  if (typeof kind !== "string" || !Object.hasOwn(RECORD_FIELDS, kind)) {
    throw new ProtocolError("kind", "must be manifest, rollBackToEmbedded or noUpdateAvailable");
  }
  return kind as Kind;
}

export function checkUpdateId(value: unknown): string {
  if (typeof value !== "string" || !UUID.test(value)) {
    throw new ProtocolError("updateId", "must be a lowercase UUID");
  }
  return value;
}

/** Empty, or a canonical dictionary of strings: exactly what `encodeSfvDictionary` writes. */
function checkFilters(value: unknown): string {
  if (typeof value !== "string") throw new ProtocolError("manifestFilters", "must be a string");
  if (value.length > MAX_FILTERS_BYTES) {
    throw new ProtocolError("manifestFilters", `is longer than ${MAX_FILTERS_BYTES} bytes`);
  }
  const members = new Map<string, string>();
  for (const [key, member] of parseSfvDictionary(value, "manifestFilters")) {
    if (member.kind !== "string") {
      throw new ProtocolError("manifestFilters", `${key} must be a string`);
    }
    members.set(key, member.text);
  }
  if (encodeSfvDictionary(Object.fromEntries(members)) !== value) {
    throw new ProtocolError("manifestFilters", "must be written by encodeSfvDictionary");
  }
  return value;
}

function present(r: Record<string, unknown>, field: string): unknown {
  if (!Object.hasOwn(r, field)) throw new ProtocolError(field, "is missing");
  return r[field];
}
