import { ProtocolError } from "./hash.ts";
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
      readonly kind: "rollBackToEmbedded" | "noUpdateAvailable";
      readonly boundary: string;
      readonly body: Uint8Array<ArrayBuffer>;
    };

type Kind = StoredReply["kind"];

/** The key of the signed noUpdateAvailable reply served when no pointer applies. */
export const NO_UPDATE_KEY = "reply/no-update";
/** The largest record the server reads; encode refuses a larger one. */
export const MAX_REPLY_BYTES = 2 * 1024 * 1024;
/** The longest `expo-manifest-filters` value, well under the smallest client header budget. */
export const MAX_FILTERS_BYTES = 4096;

const VERSION = 1;
// Fields each kind's record may hold; a directive has no update ID or filters.
const RECORD_FIELDS: Record<Kind, readonly string[]> = {
  manifest: ["version", "kind", "updateId", "contentType", "manifestFilters", "body"],
  rollBackToEmbedded: ["version", "kind", "contentType", "body"],
  noUpdateAvailable: ["version", "kind", "contentType", "body"],
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// Content-addressed objects and release records; lowercase, so they are safe on case-insensitive disks.
const CONTENT_KEY = /^(?:assets|bundles)\/[0-9a-f]{64}$/;
const RECORD_KEY = new RegExp(`^updates/${UUID.source.slice(1, -1)}\\.json$`);
const CONTENT_TYPE = /^multipart\/mixed; boundary=(.*)$/s;
// Covers every Expo runtime policy: appVersion `2.6.2`, nativeVersion `1.0.0(1)`, sdkVersion `exposdk:57.0.0`.
const NAME = /^[A-Za-z0-9._+():-]{1,64}$/;

const encoder = new TextEncoder();
const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** Returns the record bytes for `reply`: one JSON object, keys in a fixed order, the body as a string. */
export function encodeStoredReply(reply: StoredReply): Uint8Array<ArrayBuffer> {
  let body: string;
  try {
    body = utf8.decode(reply.body);
  } catch {
    throw new ProtocolError("body", "is not UTF-8");
  }
  const contentType = `multipart/mixed; boundary=${reply.boundary}`;
  const record =
    reply.kind === "manifest"
      ? {
          version: VERSION,
          kind: reply.kind,
          updateId: reply.updateId,
          contentType,
          manifestFilters: reply.manifestFilters,
          body,
        }
      : { version: VERSION, kind: reply.kind, contentType, body };
  const bytes = new Uint8Array(encoder.encode(JSON.stringify(record)));
  decodeStoredReply(bytes); // Encode never writes what decode refuses.
  return bytes;
}

/** Returns the reply a record holds, with the body's exact bytes; a record encode would refuse is rejected. */
export function decodeStoredReply(bytes: Uint8Array): StoredReply {
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
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new ProtocolError("record", "must be a JSON object");
  }
  const r = parsed as Record<string, unknown>;
  // Version first, so a later layout is reported as unsupported rather than as malformed.
  const version = present(r, "version");
  if (!Number.isInteger(version)) throw new ProtocolError("version", "must be an integer");
  if (version !== VERSION) throw new ProtocolError("version", "is not supported");

  const kind = checkKind(present(r, "kind"));
  for (const key of Object.keys(r)) {
    if (!RECORD_FIELDS[kind].includes(key)) {
      throw new ProtocolError(key, `is not a field of a ${kind} reply`);
    }
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

/** Returns the pointer key for a channel, runtime version and platform; names outside the grammar are rejected. */
export function replyKey(channel: string, runtimeVersion: string, platform: string): string {
  checkName(channel, "channel");
  checkName(runtimeVersion, "runtimeVersion");
  if (platform !== "ios" && platform !== "android") {
    throw new ProtocolError("platform", "must be ios or android");
  }
  return `reply/${channel}/${runtimeVersion}/${platform}`;
}

/**
 * Returns the relative file path that holds `key` on disk. Names are hex-escaped to lowercase without `.` or `-`, so
 * no two keys share a path on a case-insensitive filesystem and no name collides with `reply/no-update`.
 */
export function diskPath(key: string): string {
  if (key === NO_UPDATE_KEY || CONTENT_KEY.test(key) || RECORD_KEY.test(key)) return key;
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

function checkName(value: string, field: string): void {
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

function checkUpdateId(value: unknown): string {
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
