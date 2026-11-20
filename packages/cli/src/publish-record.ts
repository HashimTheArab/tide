import type { JsonObject } from "@tide/protocol";
import { MAX_REPLY_BYTES, ProtocolError, assetHash, contentKey, replyKey } from "@tide/protocol";

import { isKey } from "./bucket.ts";
import { isObject } from "./keys.ts";
import { isTime } from "./status.ts";

/** A write command's refusal or failure. Its message names keys, variables and rules, never stored data. */
export class PublishError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PublishError";
  }
}

export type Platform = "ios" | "android";

/** What `updates/<updateId>.json` holds: enough to rebuild the update's manifest byte for byte, URLs included. */
export interface ReleaseRecord {
  readonly updateId: string;
  readonly channel: string;
  readonly runtimeVersion: string;
  readonly platform: Platform;
  readonly createdAt: string;
  readonly serverUrl: string;
  readonly assetUrl: string;
  readonly launchAsset: { readonly hash: string };
  readonly assets: readonly RecordedAsset[];
  readonly extra: JsonObject;
}

interface RecordedAsset {
  readonly key: string;
  readonly hash: string;
  readonly fileExtension: string;
}

export const RECORD_PREFIX = "updates/";
const VERSION = 1;
const KEY = /^[A-Za-z0-9_-]{1,64}$/;
const FILE_EXTENSION = /^\.[A-Za-z0-9]{1,16}$/;
const LOOPBACK = /^(?:127(?:\.\d{1,3}){3}|\[::1\])$/;
const encoder = new TextEncoder();
const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

export const recordKey = (updateId: string) => `${RECORD_PREFIX}${updateId}.json`;

/** The launch asset URL shape, permanent once published. */
export const launchUrl = (serverUrl: string, hash: string) =>
  `${serverUrl}/bundles/${contentKey(hash)}`;

/** The asset URL shape, permanent once published. */
export const assetUrl = (assetBase: string, hash: string) =>
  `${assetBase}/assets/${contentKey(hash)}`;

/**
 * Returns `value` as a URL base without a trailing `/`, or undefined unless it is an absolute `https:` URL (or
 * `http:` to a loopback IP literal) with no credentials, query or fragment.
 */
export function urlBase(value: string): string | undefined {
  const url = URL.parse(value);
  if (
    url === null ||
    !(url.protocol === "https:" || (url.protocol === "http:" && LOOPBACK.test(url.hostname))) ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== "" ||
    value.includes("?") ||
    value.includes("#")
  ) {
    return undefined;
  }
  return url.href.replace(/\/$/, "");
}

/** Returns the record bytes: one JSON object, keys in a fixed order, no trailing newline, at most 2 MiB. */
export function encodeRecord(record: ReleaseRecord): Uint8Array<ArrayBuffer> {
  const r = record;
  const fail = (field: string, rule: string) => new ProtocolError(`record.${field}`, rule);
  if (typeof r.updateId !== "string" || !isKey(recordKey(r.updateId))) {
    throw fail("updateId", "must be a lowercase UUID");
  }
  replyKey(r.channel, r.runtimeVersion, r.platform);
  if (!isTime(r.createdAt))
    throw fail("createdAt", "must be an ISO 8601 UTC time with milliseconds");
  for (const field of ["serverUrl", "assetUrl"] as const) {
    if (typeof r[field] !== "string" || urlBase(r[field]) !== r[field]) {
      throw fail(field, "must be an https URL base without a trailing /");
    }
  }
  if (!isObject(r.launchAsset)) throw fail("launchAsset", "must be an object");
  const launchAsset = { hash: assetHash(r.launchAsset.hash, "record.launchAsset.hash") };
  if (!Array.isArray(r.assets)) throw fail("assets", "must be an array");
  const assets = r.assets.map((a: unknown, i) => {
    if (!isObject(a)) throw fail(`assets[${i}]`, "must be an object");
    if (typeof a.key !== "string" || !KEY.test(a.key)) {
      throw fail(`assets[${i}].key`, "must be 1 to 64 of A-Z, a-z, 0-9, _ and -");
    }
    if (typeof a.fileExtension !== "string" || !FILE_EXTENSION.test(a.fileExtension)) {
      throw fail(`assets[${i}].fileExtension`, "must be a dot and 1 to 16 of A-Z, a-z and 0-9");
    }
    return {
      key: a.key,
      hash: assetHash(a.hash, `record.assets[${i}].hash`),
      fileExtension: a.fileExtension,
    };
  });
  if (!isObject(r.extra)) throw fail("extra", "must be an object");
  const bytes = new Uint8Array(
    encoder.encode(
      JSON.stringify({
        version: VERSION,
        updateId: r.updateId,
        channel: r.channel,
        runtimeVersion: r.runtimeVersion,
        platform: r.platform,
        createdAt: r.createdAt,
        serverUrl: r.serverUrl,
        assetUrl: r.assetUrl,
        launchAsset,
        assets,
        extra: r.extra,
      }),
    ),
  );
  if (bytes.length > MAX_REPLY_BYTES) throw fail("", `is over ${MAX_REPLY_BYTES} bytes`);
  return bytes;
}

/** Returns the record `bytes` hold; anything `encodeRecord` would not have written is refused. */
export function decodeRecord(bytes: Uint8Array): ReleaseRecord {
  let parsed: unknown;
  try {
    parsed = JSON.parse(utf8.decode(bytes));
  } catch {
    throw new ProtocolError("record", "is not UTF-8 JSON");
  }
  if (!isObject(parsed)) throw new ProtocolError("record", "must be a JSON object");
  if (parsed.version !== VERSION) throw new ProtocolError("record.version", "is not supported");
  const record = parsed as unknown as ReleaseRecord;
  const canonical = encodeRecord(record);
  if (canonical.length !== bytes.length || canonical.some((b, i) => b !== bytes[i])) {
    throw new ProtocolError("record", "is not in the form tide writes");
  }
  return record;
}
