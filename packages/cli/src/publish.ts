import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { parseArgs } from "node:util";

import type { NoUpdateReply, Rollout } from "@tide-ota/protocol";
import {
  NO_UPDATE_KEY,
  ProtocolError,
  assetContentType,
  baseKey,
  buildManifest,
  buildNoUpdateAvailable,
  contentKey,
  encodeBaseRecord,
  encodeIdentityNoUpdate,
  encodeSfvDictionary,
  encodeStoredReply,
  replyKey,
} from "@tide-ota/protocol";

import type { Bucket } from "./bucket.ts";
import type { Env, StoredNoUpdate, Writer } from "./keys.ts";
import type { PointerState } from "./pointer.ts";
import type { ExportedPlatform } from "./publish-export.ts";
import type { PatchBase } from "./publish-patch.ts";
import type { Platform, ReleaseRecord } from "./publish-record.ts";
import { BucketError } from "./bucket.ts";
import { KeyError, openWriter, sameBytes } from "./keys.ts";
import {
  createdAtFloor,
  ownRuntimes,
  readPointer,
  runtimeOf,
  writePointer,
  writing,
} from "./pointer.ts";
import { readProjectExport } from "./publish-export.ts";
import { preparePatches, uploadPatches } from "./publish-patch.ts";
import {
  BASE_PREFIX,
  PublishError,
  RECORD_PREFIX,
  assetUrl,
  encodeRecord,
  launchUrl,
  readBaseRecord,
  readReleaseRecord,
  recordKey,
  urlBase,
} from "./publish-record.ts";
import { earlierOf, percentOf, rolloutRecord, stagedRollout } from "./rollout.ts";

export interface PublishOptions {
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
  readonly now?: () => number; // The local clock, epoch milliseconds.
  readonly cwd?: string;
}

/** A release record before it has an update ID and a time: everything its manifest is built from. */
export type DraftRecord = Omit<ReleaseRecord, "updateId" | "createdAt">;

/**
 * One pointer's reply, built and signed before anything is written, the state it replaces and its stdout line. An
 * absent reply was already written by an earlier run of the same publish, so only its line is printed.
 */
export interface PointerWrite {
  readonly key: string;
  readonly previous: PointerState;
  readonly reply: Uint8Array<ArrayBuffer> | undefined;
  readonly line: string;
}

/** Everything a write command writes after its uploads, prepared with every refusal already made. */
export interface Plan {
  readonly writer: Writer;
  /** The `reply/no-update` to create, or with `etag` to replace; absent when the stored one stays. */
  readonly noUpdate:
    | { readonly bytes: Uint8Array<ArrayBuffer>; readonly etag?: string }
    | undefined;
  readonly records: readonly (readonly [string, Uint8Array<ArrayBuffer>])[]; // Release and base records.
  readonly pointers: readonly PointerWrite[];
  /** Refuses unless the certificate is valid by both clocks, each read afresh. */
  readonly checkCertificate: () => Promise<void>;
}

/** A write command's writes, returned once every refusal has been made; every failure in it follows a write. */
export type WriteStep = () => Promise<void>;

/** Asset keys, lowercased because iOS stores asset files on a case-insensitive disk, to the one SHA-256 each names. */
type KeyHashes = Map<string, { readonly hash: string; readonly source: string }>;

export const PUBLISH_USAGE =
  "usage: tide publish --from <dir> --channel <name> [--rollout <percent>] [--add-identity]";
const MAX_SKEW_MS = 60_000;

/**
 * Publishes one update per platform to `--channel`. Returns 0 when every pointer is written, 2 when the publish is
 * refused before any write, and 1 when it fails after writes began.
 */
export async function publish(
  args: readonly string[],
  env: Env,
  options: PublishOptions,
): Promise<0 | 1 | 2> {
  return await execute(options, async () => {
    const { ready, exported, stored, patches } = await prepare(args, env, options);
    return async () => {
      await uploadObjects(ready.writer.bucket, exported, stored);
      await uploadPatches(ready.writer.bucket, patches);
      await commit(ready, options.out);
    };
  });
}

/** Runs a write command: 0 once its write step succeeds, 2 when `prepare` refuses, 1 when a write fails. */
export async function execute(
  options: PublishOptions,
  prepare: () => Promise<WriteStep>,
): Promise<0 | 1 | 2> {
  let write;
  try {
    write = await prepare();
  } catch (e) {
    return report(e, options, 2);
  }
  try {
    await write();
  } catch (e) {
    return report(e, options, 1);
  }
  return 0;
}

/** Prints a write command's own error and returns `code`; anything else is a bug and is rethrown. */
export function report<Code extends 1 | 2>(e: unknown, { err }: PublishOptions, code: Code): Code {
  if (
    !(
      e instanceof PublishError ||
      e instanceof KeyError ||
      e instanceof BucketError ||
      e instanceof ProtocolError
    )
  ) {
    throw e;
  }
  err(`tide: ${e.message}`);
  return code;
}

async function prepare(
  args: readonly string[],
  env: Env,
  { now = Date.now, cwd = process.cwd() }: PublishOptions,
) {
  const { channel, from, percent, addIdentity } = parse(args, cwd);
  const serverUrl = configuredBase(env, "TIDE_SERVER_URL");
  const assetBase = configuredBase(env, "TIDE_ASSET_URL");

  const artifact = await readProjectExport(from);
  const writer = await openWriter(env, { now, app: artifact, addIdentity });
  const exported = artifact.platforms.map((p) => ({
    ...p,
    key: replyKey(channel, p.runtime, p.platform),
  }));

  const { keys, bases } = await recordedKeys(writer.bucket, { targets: exported });
  for (const { platform, assets } of exported) {
    for (const a of assets) addKey(keys, a.key, a.hash, `this export (${platform})`);
  }

  const { targets, local, checkCertificate } = await readTargets(writer, exported, now);
  const records = [];
  const writes = [];
  for (const t of targets) {
    const draft: DraftRecord = {
      channel,
      runtimeVersion: t.runtime,
      platform: t.platform,
      serverUrl,
      assetUrl: assetBase,
      launchAsset: { hash: t.bundle.hash },
      assets: t.assets.map((a) => ({ key: a.key, hash: a.hash, fileExtension: `.${a.ext}` })),
      extra: { expoClient: artifact.expoClient },
    };
    let earlier;
    if (percent !== undefined) {
      const staged = await stagedRollout(writer, t, draft, percent);
      if (staged !== undefined) {
        writes.push(staged);
        continue;
      }
      earlier = await earlierOf(writer.identity, t.key, t.previous);
    }
    const c = await compose(writer, draft, createdAtFloor(local, t.previous), t);
    records.push(...c.records);
    if (percent === undefined) {
      writes.push(c.pointer);
      continue;
    }
    const next: Rollout = { kind: "rollout", percent, new: c.manifest, earlier };
    // Sized at the longest percentage too, so tide rollout can move it to any goal within the limit.
    rolloutRecord(t.key, { ...next, percent: 99.99 });
    writes.push({ ...c.pointer, reply: rolloutRecord(t.key, next) });
  }
  const stored = await storedContent(writer.bucket);
  // Before the plan, so its fresh certificate check also covers the time spent diffing.
  const patches = await preparePatches(writer.bucket, exported, bases, stored);
  return {
    ready: await plan(writer, checkCertificate, records, writes),
    exported,
    stored,
    patches,
  };
}

/**
 * Reads each item's pointer, refusing a runtime and platform another keyid's pointer holds on any channel, then the
 * bucket's time, refusing a local clock more than a minute from it or a certificate invalid by either clock. Returns
 * the pointers and the one local sample every new time comes from.
 */
export async function readTargets<T extends { readonly key: string }>(
  writer: Writer,
  items: readonly T[],
  now: () => number,
) {
  const { bucket } = writer;
  const targets: (T & { readonly previous: PointerState })[] = [];
  for (const t of items) targets.push({ ...t, previous: await readPointer(bucket, t.key) });
  const runtimes = new Set(items.map((t) => runtimeOf(t.key)));
  await ownRuntimes(bucket, writer.identity.keyId, runtimes, targets);
  const bucketTime = await bucket.time();
  const local = now();
  if (Math.abs(local - bucketTime) > MAX_SKEW_MS) {
    throw new PublishError(
      "the local clock differs from the bucket's by more than a minute: fix the clock",
    );
  }
  await writer.checkCertificate(local);
  await writer.checkCertificate(bucketTime);
  // The local clock last, so expiry during the bucket read still counts.
  const checkCertificate = async () => {
    await writer.checkCertificate(await bucket.time());
    await writer.checkCertificate(now());
  };
  return { targets, local, checkCertificate };
}

/**
 * Ends a plan once everything is signed: builds `reply/no-update` when `needsNoUpdate` says so, then checks the
 * certificate afresh, so an expiry before the first write is a refusal.
 */
export async function plan(
  writer: Writer,
  checkCertificate: () => Promise<void>,
  records: Plan["records"],
  pointers: Plan["pointers"],
): Promise<Plan> {
  const { noUpdate: stored, identity } = writer;
  const noUpdate = needsNoUpdate(writer, stored)
    ? noUpdateRecord(stored, identity.keyId, await noUpdateReply(writer))
    : undefined;
  await checkCertificate();
  return { writer, noUpdate, records, pointers, checkCertificate };
}

/**
 * Whether a write must replace `stored`, signing nothing: it is absent, has no entry for this keyid, or in chain mode
 * this keyid's entry serves another chain than the configured one.
 */
function needsNoUpdate({ identity, chain }: Writer, stored: StoredNoUpdate | undefined): boolean {
  if (stored === undefined) return true;
  const own = stored.entries.get(identity.keyId);
  if (own === undefined) return true;
  // The identity check has verified it, so in chain mode it carries a chain.
  const served = own.sides[0]?.signed.chain;
  return chain !== undefined && served !== undefined && !sameBytes(served, chain);
}

/**
 * Returns `reply/no-update` with `reply` as `keyId`'s entry over `stored`, and the ETag it replaces; a version-1 record
 * of this keyid stays version 1, and any other keyid's entry is copied as stored.
 */
function noUpdateRecord(
  stored: StoredNoUpdate | undefined,
  keyId: string,
  reply: NoUpdateReply,
): NonNullable<Plan["noUpdate"]> {
  try {
    if (stored === undefined) return { bytes: encodeStoredReply(reply) };
    const { entries, etag } = stored;
    if (stored.version === 1 && entries.has(keyId)) {
      return { bytes: encodeStoredReply(reply), etag };
    }
    // checkNoUpdate has refused any other kind at reply/no-update.
    const replies = new Map([...entries].map(([k, e]) => [k, e.reply as NoUpdateReply]));
    return { bytes: encodeIdentityNoUpdate(replies.set(keyId, reply)), etag };
  } catch (e) {
    if (!(e instanceof ProtocolError)) throw e;
    throw new PublishError(`${NO_UPDATE_KEY}: ${e.message}`);
  }
}

/**
 * Writes binding, reply/no-update, records, then pointers; every failure here follows a write. The certificate is
 * re-checked before a write once a PUT has followed the plan's check, and in chain mode before `reply/no-update`.
 */
export async function commit(
  { writer, noUpdate, records, pointers, checkCertificate }: Plan,
  out: (line: string) => void,
): Promise<void> {
  const { bucket } = writer;
  let attempted = false;
  if (writer.bind !== undefined) {
    attempted = true;
    await writer.bind();
  }
  if (noUpdate !== undefined) {
    if (writer.identity.chain) await checkCertificate();
    attempted = true;
    await writing(NO_UPDATE_KEY, () => ensureNoUpdate(writer, noUpdate));
  }
  for (const [key, bytes] of records) {
    attempted = true;
    const etag = await writing(
      key,
      () => bucket.putIfAbsent(key, bytes),
      "no pointer names it yet",
    );
    if (etag === undefined) throw new PublishError(`${key} already exists`);
  }
  for (const p of pointers) {
    if (p.reply !== undefined) {
      if (attempted) await checkCertificate();
      attempted = true;
      await writePointer(bucket, p.key, p.reply, p.previous);
    }
    out(p.line);
  }
}

function parse(args: readonly string[], cwd: string) {
  const { values } = parsed(PUBLISH_USAGE, () =>
    parseArgs({
      args: [...args],
      options: {
        from: { type: "string" },
        channel: { type: "string" },
        rollout: { type: "string" },
        "add-identity": { type: "boolean" },
      },
      strict: true,
      allowPositionals: false,
    }),
  );
  const { from, channel, rollout } = values;
  const addIdentity = values["add-identity"] === true;
  if (from === undefined || channel === undefined) {
    throw new PublishError(`--from and --channel are required; ${PUBLISH_USAGE}`);
  }
  replyKey(channel, "1", "ios"); // Refuses a bad channel before the export is read.
  const percent = rollout === undefined ? undefined : percentOf(rollout, "--rollout");
  return { channel, from: resolve(cwd, from), percent, addIdentity };
}

/** Returns `parse()`, turning parseArgs' own error into a usage refusal. */
export function parsed<T>(usage: string, parse: () => T): T {
  try {
    return parse();
  } catch {
    throw new PublishError(`unrecognised arguments; ${usage}`);
  }
}

type Options<K extends string> = Readonly<Partial<Record<K, readonly string[] | undefined>>>;

/** Returns the value of a `multiple` option given at most once. */
export function once<K extends string>(values: Options<K>, name: K): string | undefined {
  const list = values[name];
  if (list !== undefined && list.length > 1) throw new PublishError(`--${name} is given twice`);
  return list?.[0];
}

/** Returns the value of a `multiple` option given exactly once. */
export function requiredOnce<K extends string>(values: Options<K>, name: K, usage: string): string {
  const value = once(values, name);
  if (value === undefined) throw new PublishError(`--${name} is required; ${usage}`);
  return value;
}

function configuredBase(env: Env, name: string): string {
  const value = env[name];
  if (value === undefined || value === "") {
    throw new PublishError(`${name} is not set: Tide writes it into every manifest`);
  }
  const base = urlBase(value);
  if (base === undefined) {
    throw new PublishError(
      `${name} must be an https URL with no credentials, query or fragment (http only to a loopback IP)`,
    );
  }
  return base;
}

/**
 * Returns the asset keys every retained release record and registered build names, the release records stored at
 * `wanted` keys, and the bases of each `targets` runtime and platform. A record that cannot be read refuses, since
 * the key check cannot be proven without it.
 */
export async function recordedKeys(
  bucket: Bucket,
  {
    wanted = [],
    targets = [],
  }: {
    readonly wanted?: readonly string[];
    readonly targets?: readonly { readonly runtime: string; readonly platform: Platform }[];
  } = {},
) {
  const keys: KeyHashes = new Map();
  const records = new Map<string, ReleaseRecord>();
  const bases: PatchBase[] = [];
  const created = new Map<string, string>(); // Update ID to createdAt, for target pairs only.
  const targeted = (r: { readonly runtimeVersion: string; readonly platform: Platform }) =>
    targets.some((t) => t.runtime === r.runtimeVersion && t.platform === r.platform);
  for (const key of await keysUnder(bucket, RECORD_PREFIX)) {
    const record = await readReleaseRecord(bucket, key);
    if (record === undefined) continue;
    for (const a of record.assets) addKey(keys, a.key, a.hash, key);
    // Others are dropped, so memory follows the key index rather than the release history.
    if (wanted.includes(key)) records.set(key, record);
    if (targeted(record)) created.set(record.updateId, record.createdAt);
  }
  for (const key of await keysUnder(bucket, BASE_PREFIX)) {
    const base = await readBaseRecord(bucket, key);
    if (base === undefined) continue;
    if (base.kind === "embedded") for (const a of base.assets) addKey(keys, a.key, a.hash, key);
    if (!targeted(base)) continue;
    const createdAt = created.get(base.updateId);
    // Writers store the release record first, so only a damaged bucket lacks it.
    if (base.kind === "update" && createdAt === undefined) {
      throw new PublishError(`${key} has no release record ${recordKey(base.updateId)}`);
    }
    const { kind, runtimeVersion, platform } = base;
    bases.push({ key, kind, runtimeVersion, platform, hash: base.launchAsset.hash, createdAt });
  }
  return { keys, records, bases };
}

/** Returns the keys listed under `prefix`; a name outside the key grammar refuses. */
async function keysUnder(bucket: Bucket, prefix: string): Promise<string[]> {
  return (await bucket.list(prefix)).map((entry) => {
    if (!("key" in entry))
      throw new PublishError(`${prefix}: an object name outside the key grammar`);
    return entry.key;
  });
}

/** Records that `key` names `hash`; a key seen with another hash is refused, whichever source came first. */
export function addKey(keys: KeyHashes, key: string, hash: string, source: string): void {
  const seen = keys.get(key.toLowerCase());
  if (seen === undefined) keys.set(key.toLowerCase(), { hash, source });
  else if (seen.hash !== hash) {
    throw new PublishError(
      `asset key ${key} names different bytes in ${seen.source} and ${source}: a key must never change its bytes`,
    );
  }
}

/** Builds and signs a new update from `draft` under a fresh ID: its records, its reply and its write to `target`. */
export async function compose(
  writer: Writer,
  draft: DraftRecord,
  createdAtMs: number,
  { key, previous }: { readonly key: string; readonly previous: PointerState },
): Promise<{ records: Plan["records"]; manifest: Rollout["new"]; pointer: PointerWrite }> {
  const updateId = randomUUID();
  const date = new Date(createdAtMs);
  const createdAt = date.toISOString();
  const manifest = buildManifest({
    id: updateId,
    createdAt: date,
    runtimeVersion: draft.runtimeVersion,
    launchAsset: {
      hash: draft.launchAsset.hash,
      contentType: assetContentType("bundle"),
      fileExtension: ".bundle",
      url: launchUrl(draft.serverUrl, draft.launchAsset.hash),
    },
    assets: draft.assets.map((a) => ({
      hash: a.hash,
      key: a.key,
      contentType: assetContentType(a.fileExtension.slice(1)),
      fileExtension: a.fileExtension,
      url: assetUrl(draft.assetUrl, a.hash),
    })),
    metadata: { channel: draft.channel },
    extra: draft.extra,
  });
  const { boundary, body } = await writer.signedReply("manifest", manifest);
  const stored: Rollout["new"] = {
    kind: "manifest",
    updateId,
    boundary,
    manifestFilters: encodeSfvDictionary({ channel: draft.channel }),
    body,
  };
  const base = encodeBaseRecord({
    kind: "update",
    updateId,
    runtimeVersion: draft.runtimeVersion,
    platform: draft.platform,
    launchAsset: draft.launchAsset,
  });
  return {
    records: [
      [recordKey(updateId), encodeRecord({ ...draft, updateId, createdAt })],
      [baseKey(updateId), base],
    ],
    manifest: stored,
    pointer: {
      key,
      previous,
      reply: encodeStoredReply(stored),
      line: `${key} ${updateId} ${createdAt}`,
    },
  };
}

/** Builds and signs this identity's noUpdateAvailable reply. */
async function noUpdateReply(writer: Writer): Promise<NoUpdateReply> {
  const { boundary, body } = await writer.signedReply("directive", buildNoUpdateAvailable());
  return { kind: "noUpdateAvailable", boundary, body };
}

/**
 * Writes `reply/no-update` over the ETag read, or only if still absent. A lost race succeeds only when the winner needs
 * nothing from this writer; otherwise the rerun merges onto it.
 */
async function ensureNoUpdate(
  writer: Writer,
  { bytes, etag }: NonNullable<Plan["noUpdate"]>,
): Promise<void> {
  const { bucket } = writer;
  const written =
    etag === undefined
      ? await bucket.putIfAbsent(NO_UPDATE_KEY, bytes)
      : await bucket.putIfMatch(NO_UPDATE_KEY, bytes, etag);
  if (written !== undefined) return;
  const winner = await writer.readNoUpdate();
  if (winner === undefined) {
    throw new PublishError(`${NO_UPDATE_KEY} was removed by another writer during the publish`);
  }
  if (needsNoUpdate(writer, winner)) {
    throw new PublishError(
      `${NO_UPDATE_KEY} was changed by another writer during the publish; it keeps theirs: run again`,
    );
  }
}

/**
 * Uploads every bundle and asset missing from `stored`, as immutable public content. A lost create means another
 * writer stored the same content-addressed bytes, which is accepted.
 */
async function uploadObjects(
  bucket: Bucket,
  exported: readonly ExportedPlatform[],
  stored: ReadonlyMap<string, number>,
): Promise<void> {
  const existing = new Set(stored.keys());
  const upload = async (key: string, bytes: Uint8Array<ArrayBuffer>, contentType: string) => {
    if (existing.has(key)) return;
    existing.add(key);
    await bucket.putIfAbsent(key, bytes, contentType);
  };
  for (const { bundle, assets } of exported) {
    await upload(`bundles/${contentKey(bundle.hash)}`, bundle.bytes, assetContentType("bundle"));
    for (const a of assets) {
      await upload(`assets/${contentKey(a.hash)}`, a.bytes, assetContentType(a.ext));
    }
  }
}

/** Returns every stored bundle and asset key, objects the server can serve, with its size. */
export async function storedContent(bucket: Bucket): Promise<Map<string, number>> {
  const entries = [...(await bucket.list("assets/")), ...(await bucket.list("bundles/"))];
  return new Map(entries.flatMap((e) => ("key" in e ? [[e.key, e.size] as const] : [])));
}
