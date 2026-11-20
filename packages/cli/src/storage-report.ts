import {
  LEGACY_MAP_KEY,
  NO_UPDATE_KEY,
  ProtocolError,
  assetHash,
  contentKey,
} from "@tide/protocol";

import type { Bucket, ListEntry } from "./bucket.ts";
import { BucketError } from "./bucket.ts";
import { isObject } from "./keys.ts";
import { PublishError, RECORD_PREFIX, readReleaseRecord } from "./publish-record.ts";
import { readRecord } from "./status.ts";

const REPORTED = ["assets/", "bundles/", RECORD_PREFIX] as const;
const MAX_MAP_BYTES = 64 * 1024 * 1024;
const CONTENT_KEY = /^(?:assets|bundles)\/[0-9a-f]{64}$/;
const CONTENT_PATH = /\/((?:assets|bundles)\/[0-9a-f]{64})$/;
const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/**
 * Prints every object under `assets/`, `bundles/` and `updates/` that no served manifest, release record or legacy
 * map entry names, as `<name> <bytes>`, then the count and total. Returns 1 with nothing on stdout when a listing or
 * read fails, since a partial scan could report a referenced object.
 */
export async function storage(
  bucket: Pick<Bucket, "get" | "list">,
  out: (line: string) => void,
  err: (line: string) => void,
): Promise<0 | 1> {
  let unreferenced;
  try {
    unreferenced = await scan(bucket);
  } catch (e) {
    if (!(e instanceof PublishError)) throw e;
    err(`tide: ${e.message}`);
    return 1;
  }
  let total = 0n;
  for (const e of unreferenced) {
    out(`${"key" in e ? e.key : quoted(e.unknown)} ${e.size}`);
    total += BigInt(e.size);
  }
  out(`${unreferenced.length} unreferenced objects, ${total} bytes`);
  return 0;
}

/** Lists the reported prefixes, then reads every root: the legacy map, each release record, then each pointer. */
async function scan(bucket: Pick<Bucket, "get" | "list">): Promise<ListEntry[]> {
  const listed: ListEntry[] = [];
  for (const prefix of REPORTED) listed.push(...(await listing(bucket, prefix)));
  const referenced = new Set(await legacyKeys(bucket));
  for (const e of listed) {
    if (!("key" in e) || !e.key.startsWith(RECORD_PREFIX)) continue;
    const record = await reading(e.key, () => readReleaseRecord(bucket, e.key));
    if (record === undefined) continue;
    referenced.add(`bundles/${contentKey(record.launchAsset.hash)}`);
    for (const a of record.assets) referenced.add(`assets/${contentKey(a.hash)}`);
  }
  // Names outside the grammar are never routed, so they serve nothing.
  for (const [i, e] of (await listing(bucket, "reply/")).entries()) {
    if (!("key" in e) || e.key === NO_UPDATE_KEY) continue;
    // A pointer key can hold any channel text, a credential included, so failures name its position.
    const label = `reply/ entry ${i + 1}`;
    const verdict = await readRecord(bucket, e.key);
    if (typeof verdict === "string") throw new PublishError(`${label} is unreadable: ${verdict}`);
    if (verdict?.kind !== "manifest") continue;
    try {
      for (const key of servedKeys(verdict.signed.body)) referenced.add(key);
    } catch (e) {
      if (!(e instanceof ProtocolError)) throw e;
      throw new PublishError(`${label} is unreadable: ${e.message}`);
    }
  }
  // A release record is itself retained.
  return listed.filter(
    (e) => !("key" in e && (e.key.startsWith(RECORD_PREFIX) || referenced.has(e.key))),
  );
}

async function listing(bucket: Pick<Bucket, "list">, prefix: string): Promise<ListEntry[]> {
  try {
    return await bucket.list(prefix);
  } catch (e) {
    if (!(e instanceof BucketError)) throw e;
    throw new PublishError(`${prefix} cannot be listed: ${e.message}`);
  }
}

async function reading<T>(key: string, read: () => Promise<T>): Promise<T> {
  try {
    return await read();
  } catch (e) {
    if (!(e instanceof BucketError)) throw e;
    throw new PublishError(`${key} is unreadable: ${e.message}`);
  }
}

/**
 * Returns the content keys `legacy/map.json` names; none when absent. It must be exactly
 * `{"version":1,"keys":[...]}`: content keys in strictly ascending order, no trailing newline.
 */
async function legacyKeys(bucket: Pick<Bucket, "get">): Promise<string[]> {
  const object = await reading(LEGACY_MAP_KEY, () => bucket.get(LEGACY_MAP_KEY, MAX_MAP_BYTES));
  if (object === undefined) return [];
  const refuse = () =>
    new PublishError(`${LEGACY_MAP_KEY} is unreadable: not in the form tide writes`);
  let map: unknown;
  try {
    map = JSON.parse(utf8.decode(object.bytes));
  } catch {
    throw refuse();
  }
  const keys = isObject(map) ? map.keys : undefined;
  if (
    !Array.isArray(keys) ||
    !keys.every(
      (k: unknown, i) =>
        typeof k === "string" && CONTENT_KEY.test(k) && (i === 0 || (keys[i - 1] as string) < k),
    ) ||
    JSON.stringify({ version: 1, keys }) !== utf8.decode(object.bytes)
  ) {
    throw refuse();
  }
  return keys as string[];
}

/**
 * Returns the content keys a signed manifest's launch asset and assets resolve to. A URL in a shape Tide serves names
 * its key (`/bundles/<hex>`, `/assets/<hex>`, or the legacy `/assets?h=`); any other falls back to the hash.
 */
function servedKeys(body: Uint8Array): string[] {
  // checkRecord has parsed these bytes as UTF-8 JSON; they are read, never re-serialised.
  const manifest = JSON.parse(utf8.decode(body)) as unknown;
  const launch = own(manifest, "launchAsset");
  if (!isObject(launch)) throw new ProtocolError("manifest.launchAsset", "must be an object");
  const assets = own(manifest, "assets");
  if (!Array.isArray(assets)) throw new ProtocolError("manifest.assets", "must be an array");
  return [
    servedKey(launch, "bundles", "manifest.launchAsset"),
    ...assets.map((a: unknown, i) => {
      if (!isObject(a)) throw new ProtocolError(`manifest.assets[${i}]`, "must be an object");
      return servedKey(a, "assets", `manifest.assets[${i}]`);
    }),
  ];
}

function servedKey(asset: object, prefix: string, field: string): string {
  const hash = assetHash(own(asset, "hash"), `${field}.hash`);
  const url = own(asset, "url");
  const parsed = typeof url === "string" ? URL.parse(url) : null;
  const path = parsed === null ? undefined : CONTENT_PATH.exec(parsed.pathname)?.[1];
  if (path !== undefined) return path;
  const h = parsed?.pathname.endsWith("/assets") === true ? parsed.searchParams.getAll("h") : [];
  if (h.length === 1) {
    try {
      return `assets/${contentKey(h[0] ?? "")}`;
    } catch {
      // An h the server refuses falls back to the hash.
    }
  }
  return `${prefix}/${contentKey(hash)}`;
}

const own = (o: unknown, field: string): unknown =>
  typeof o === "object" && o !== null && Object.hasOwn(o, field)
    ? (o as Record<string, unknown>)[field]
    : undefined;

/** A name outside the key grammar as a JSON string of printable ASCII, so no stored byte reaches a terminal raw. */
const quoted = (name: string) =>
  JSON.stringify(name).replace(
    /[^\x20-\x7e]/g,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
