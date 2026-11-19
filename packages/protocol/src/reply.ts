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
// Record keys in the order they are written; a directive has no update ID or filters.
const RECORD_FIELDS: Record<Kind, readonly string[]> = {
  manifest: ["version", "kind", "updateId", "contentType", "manifestFilters", "body"],
  rollBackToEmbedded: ["version", "kind", "contentType", "body"],
  noUpdateAvailable: ["version", "kind", "contentType", "body"],
};
const REPLY_FIELDS: Record<Kind, readonly string[]> = {
  manifest: ["kind", "updateId", "boundary", "manifestFilters", "body"],
  rollBackToEmbedded: ["kind", "boundary", "body"],
  noUpdateAvailable: ["kind", "boundary", "body"],
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CONTENT_TYPE = /^multipart\/mixed; boundary=(.*)$/s;
const NAME = /^[A-Za-z0-9._+-]{1,64}$/;

const encoder = new TextEncoder();
const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** Returns the record bytes for `reply`: one JSON object, keys in a fixed order, the body as a string. */
export function encodeStoredReply(reply: StoredReply): Uint8Array<ArrayBuffer> {
  const r = plainObject(reply, "reply");
  const kind = checkKind(r.kind);
  for (const key of Object.keys(r)) {
    if (!REPLY_FIELDS[kind].includes(key)) {
      throw new ProtocolError(key, `is not a field of a ${kind} reply`);
    }
  }
  const boundary = present(r, "boundary");
  if (typeof boundary !== "string" || !BOUNDARY.test(boundary)) {
    throw new ProtocolError("boundary", "must be 1 to 70 characters of A-Z, a-z, 0-9, _ or -");
  }
  const body = present(r, "body");
  if (!(body instanceof Uint8Array) || body.length === 0) {
    throw new ProtocolError("body", "must be non-empty bytes");
  }
  let text: string;
  try {
    text = utf8.decode(body);
  } catch {
    throw new ProtocolError("body", "is not UTF-8");
  }
  const record =
    kind === "manifest"
      ? {
          version: VERSION,
          kind,
          updateId: checkUpdateId(present(r, "updateId")),
          contentType: `multipart/mixed; boundary=${boundary}`,
          manifestFilters: checkFilters(present(r, "manifestFilters")),
          body: text,
        }
      : {
          version: VERSION,
          kind,
          contentType: `multipart/mixed; boundary=${boundary}`,
          body: text,
        };
  const bytes = new Uint8Array(encoder.encode(JSON.stringify(record)));
  if (bytes.length > MAX_REPLY_BYTES) {
    throw new ProtocolError("record", `is too large: over ${MAX_REPLY_BYTES} bytes`);
  }
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
  if (key === NO_UPDATE_KEY || /^assets\/[0-9a-f]{64}$/.test(key)) return key;
  const [prefix, channel = "", runtime = "", platform = "", ...rest] = key.split("/");
  if (prefix !== "reply" || rest.length > 0) throw new ProtocolError("key", "is not a store key");
  try {
    replyKey(channel, runtime, platform);
  } catch {
    throw new ProtocolError("key", "is not a store key");
  }
  return `reply/${escapeName(channel)}/${escapeName(runtime)}/${platform}`;
}

function escapeName(name: string): string {
  return name.replace(/[^a-z0-9]/g, (c) => `_${c.charCodeAt(0).toString(16).padStart(2, "0")}`);
}

function checkName(value: string, field: string): void {
  // Dot segments would resolve in an S3 URL or a path join.
  if (!NAME.test(value) || value === "." || value === "..") {
    throw new ProtocolError(
      field,
      "must be 1 to 64 of A-Z, a-z, 0-9, ., _, + and -, and not . or ..",
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

function plainObject(value: unknown, field: string): Record<string, unknown> {
  const proto: unknown =
    typeof value === "object" && value !== null && Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    throw new ProtocolError(field, "must be a plain object");
  }
  return value as Record<string, unknown>;
}

function present(r: Record<string, unknown>, field: string): unknown {
  if (!Object.hasOwn(r, field)) throw new ProtocolError(field, "is missing");
  return r[field];
}
