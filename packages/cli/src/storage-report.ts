import { CONTENT_KEY, LEGACY_MAP_KEY, contentKey } from "@tide/protocol";

import type { Bucket, ListEntry } from "./bucket.ts";
import { BucketError } from "./bucket.ts";
import { member } from "./keys.ts";
import {
  BASE_PREFIX,
  PublishError,
  RECORD_PREFIX,
  readBaseRecord,
  readReleaseRecord,
} from "./publish-record.ts";

const REPORTED = ["assets/", "bundles/", RECORD_PREFIX] as const;
const MAX_MAP_BYTES = 64 * 1024 * 1024;
const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/**
 * Prints every object under `assets/`, `bundles/` and `updates/` that no release record, base record or legacy map
 * entry names, as `<name> <bytes>`, then the count and total. Returns 1 with nothing on stdout when a listing or read
 * fails, since a partial scan could report a referenced object.
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

/**
 * Lists the reported prefixes and `bases/`, then reads the legacy map, every release record and every base record. A
 * pointer serves its release record, which is retained, so pointers add no root.
 */
async function scan(bucket: Pick<Bucket, "get" | "list">): Promise<ListEntry[]> {
  let listed: ListEntry[] = [];
  // Not push(...): a prefix can hold more entries than a call takes arguments.
  for (const prefix of REPORTED) listed = listed.concat(await listing(bucket, prefix));
  const referenced = new Set(await legacyKeys(bucket));
  for (const e of listed) {
    if (!("key" in e) || !e.key.startsWith(RECORD_PREFIX)) continue;
    const record = await reading(e.key, () => readReleaseRecord(bucket, e.key));
    if (record === undefined) continue;
    referenced.add(`bundles/${contentKey(record.launchAsset.hash)}`);
    for (const a of record.assets) referenced.add(`assets/${contentKey(a.hash)}`);
  }
  // A base's bundle is what patches start from; its embedded assets are in the store build, not the bucket.
  for (const e of await listing(bucket, BASE_PREFIX)) {
    if (!("key" in e)) continue; // No reader opens a name outside the grammar.
    const base = await reading(e.key, () => readBaseRecord(bucket, e.key));
    if (base !== undefined) referenced.add(`bundles/${contentKey(base.launchAsset.hash)}`);
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
  let text, keys;
  try {
    text = utf8.decode(object.bytes);
    keys = member(JSON.parse(text), "keys");
  } catch {
    // Falls through to the refusal.
  }
  if (
    !Array.isArray(keys) ||
    !keys.every(
      (k: unknown, i) =>
        typeof k === "string" && CONTENT_KEY.test(k) && (i === 0 || (keys[i - 1] as string) < k),
    ) ||
    JSON.stringify({ version: 1, keys }) !== text
  ) {
    throw new PublishError(`${LEGACY_MAP_KEY} is unreadable: not in the form tide writes`);
  }
  return keys as string[];
}

/** A name outside the key grammar as a JSON string of printable ASCII, so no stored byte reaches a terminal raw. */
const quoted = (name: string) =>
  JSON.stringify(name).replace(
    /[^\x20-\x7e]/g,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
