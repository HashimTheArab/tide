import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { parseArgs } from "node:util";

import type { JsonObject } from "@tide/protocol";
import {
  MAX_REPLY_BYTES,
  NO_UPDATE_KEY,
  ProtocolError,
  assetContentType,
  buildManifest,
  buildNoUpdateAvailable,
  contentKey,
  encodeMultipart,
  encodeSfvDictionary,
  encodeStoredReply,
  expoSignature,
  replyKey,
} from "@tide/protocol";

import type { Bucket } from "./bucket.ts";
import type { Env, Writer } from "./keys.ts";
import type { PointerState } from "./pointer.ts";
import type { ExportedPlatform } from "./publish-export.ts";
import type { Platform, ReleaseRecord } from "./publish-record.ts";
import { BucketError } from "./bucket.ts";
import { KeyError, isObject, member, openWriter } from "./keys.ts";
import { createdAtFloor, readPointer, writePointer, writing } from "./pointer.ts";
import { expoEnv, expoJson, exportFor } from "./publish-export.ts";
import {
  PublishError,
  RECORD_PREFIX,
  assetUrl,
  decodeRecord,
  encodeRecord,
  launchUrl,
  recordKey,
  urlBase,
} from "./publish-record.ts";

export interface PublishOptions {
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
  readonly now?: () => number; // The local clock, epoch milliseconds.
  readonly cwd?: string;
}

/** A release record before it has an update ID and a time: everything its manifest is built from. */
export type DraftRecord = Omit<ReleaseRecord, "updateId" | "createdAt">;

/** One pointer's reply, built and signed before anything is written, the state it replaces and its stdout line. */
interface PointerWrite {
  readonly key: string;
  readonly previous: PointerState;
  readonly reply: Uint8Array<ArrayBuffer>;
  readonly line: string;
}

/** Everything a write command writes after its uploads, prepared with every refusal already made. */
export interface Plan {
  readonly writer: Writer;
  readonly noUpdate: Uint8Array<ArrayBuffer> | undefined; // Absent when the bucket already holds one.
  readonly records: readonly (readonly [string, Uint8Array<ArrayBuffer>])[];
  readonly pointers: readonly PointerWrite[];
  /** Refuses unless the certificate is valid by both clocks, each read afresh. */
  readonly checkCertificate: () => Promise<void>;
}

/** Asset keys, lowercased because iOS stores asset files on a case-insensitive disk, to the one SHA-256 each names. */
type KeyHashes = Map<string, { readonly hash: string; readonly source: string }>;

export const PUBLISH_USAGE =
  "usage: tide publish --channel <name> [--platform ios|android]... [--runtime-version <version>] [--export-dir <dir>] [--project-root <dir>]";
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
  let plan;
  try {
    plan = await prepare(args, env, options);
  } catch (e) {
    return report(e, options, 2);
  }
  try {
    await uploadObjects(plan.writer.bucket, plan.exported);
    await commit(plan, options.out);
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
): Promise<Plan & { readonly exported: readonly ExportedPlatform[] }> {
  const { channel, platforms, runtimeVersion, exportDir, projectRoot } = parse(args, cwd);
  const serverUrl = configuredBase(env, "TIDE_SERVER_URL");
  const assetBase = configuredBase(env, "TIDE_ASSET_URL");

  const toolEnv = expoEnv(env);
  const config = await expoJson(projectRoot, toolEnv, "expo", ["config", "--json"]);
  const expoClient = await expoJson(projectRoot, toolEnv, "expo", [
    "config",
    "--type",
    "public",
    "--json",
  ]);
  if (!isObject(expoClient)) {
    throw new PublishError("expo config --type public did not print an object");
  }
  const pointers = [];
  for (const platform of platforms) {
    const runtime =
      runtimeVersion ??
      member(
        await expoJson(projectRoot, toolEnv, "expo-updates", [
          "runtimeversion:resolve",
          "--platform",
          platform,
        ]),
        "runtimeVersion",
      );
    if (runtime === null || runtime === undefined) {
      throw new PublishError(
        `no ${platform} runtime version: set runtimeVersion or pass --runtime-version`,
      );
    }
    if (typeof runtime !== "string") {
      throw new PublishError(`the ${platform} runtime version is not a string`);
    }
    pointers.push({ platform, runtime, key: replyKey(channel, runtime, platform) });
  }

  const writer = await openWriter(env, { projectRoot, config }, { now });
  const exported = await exportFor(projectRoot, toolEnv, exportDir, pointers);

  const { keys } = await recordedKeys(writer.bucket);
  for (const { platform, assets } of exported) {
    for (const a of assets) addKey(keys, a.key, a.hash, `this export (${platform})`);
  }

  const { targets, local, checkCertificate } = await readTargets(writer, exported, now);
  const records: (readonly [string, Uint8Array<ArrayBuffer>])[] = [];
  const writes: PointerWrite[] = [];
  for (const t of targets) {
    const draft: DraftRecord = {
      channel,
      runtimeVersion: t.runtime,
      platform: t.platform,
      serverUrl,
      assetUrl: assetBase,
      launchAsset: { hash: t.bundle.hash },
      assets: t.assets.map((a) => ({ key: a.key, hash: a.hash, fileExtension: `.${a.ext}` })),
      extra: { expoClient: expoClient as JsonObject },
    };
    const c = await compose(writer, draft, createdAtFloor(local, t.previous));
    records.push([recordKey(c.updateId), c.record]);
    writes.push({ key: t.key, previous: t.previous, reply: c.reply, line: c.line(t.key) });
  }
  return {
    ...(await finish(writer, checkCertificate)),
    records,
    pointers: writes,
    exported,
  };
}

/**
 * Reads each item's pointer, then the bucket's time, refusing a local clock more than a minute from it or a
 * certificate invalid by either clock. Returns the pointers and the one local sample every new time comes from.
 */
export async function readTargets<T extends { readonly key: string }>(
  writer: Writer,
  items: readonly T[],
  now: () => number,
) {
  const { bucket } = writer;
  const targets: (T & { readonly previous: PointerState })[] = [];
  for (const t of items) targets.push({ ...t, previous: await readPointer(bucket, t.key) });
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
 * Ends a plan once everything is signed: builds `reply/no-update` if the bucket lacks one, then checks the
 * certificate afresh, so an expiry before the first write is a refusal.
 */
export async function finish(writer: Writer, checkCertificate: () => Promise<void>) {
  const noUpdate = writer.noUpdate ? undefined : await noUpdateReply(writer);
  await checkCertificate();
  return { writer, noUpdate, checkCertificate };
}

/**
 * Writes `reply/no-update` if needed, the release records, then each pointer. The certificate is re-checked before a
 * pointer only once a PUT has been attempted since the plan's final check, so every failure here follows a write.
 */
export async function commit(
  { writer, noUpdate, records, pointers, checkCertificate }: Plan,
  out: (line: string) => void,
): Promise<void> {
  const { bucket } = writer;
  let attempted = false;
  if (noUpdate !== undefined) {
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
    if (attempted) await checkCertificate();
    attempted = true;
    await writePointer(bucket, p.key, p.reply, p.previous);
    out(p.line);
  }
}

function parse(args: readonly string[], cwd: string) {
  let values;
  try {
    ({ values } = parseArgs({
      args: [...args],
      options: {
        channel: { type: "string" },
        platform: { type: "string", multiple: true },
        "runtime-version": { type: "string" },
        "export-dir": { type: "string" },
        "project-root": { type: "string" },
      },
      strict: true,
      allowPositionals: false,
    }));
  } catch {
    throw new PublishError(`unrecognised arguments; ${PUBLISH_USAGE}`);
  }
  const { channel } = values;
  if (channel === undefined) throw new PublishError(`--channel is required; ${PUBLISH_USAGE}`);
  replyKey(channel, "1", "ios"); // Refuses a bad channel before Expo runs.
  const exportDir = values["export-dir"];
  return {
    channel,
    platforms: platformsOf(values.platform),
    runtimeVersion: values["runtime-version"],
    exportDir: exportDir === undefined ? undefined : resolve(cwd, exportDir),
    projectRoot: resolve(cwd, values["project-root"] ?? "."),
  };
}

/** Returns the `--platform` values, both by default; a repeat is refused. */
export function platformsOf(values: readonly string[] | undefined): Platform[] {
  const platforms: Platform[] = [];
  for (const p of values ?? ["ios", "android"]) {
    if (p !== "ios" && p !== "android") throw new PublishError("--platform must be ios or android");
    // Two writes over one read ETag would fail the run against its own pointer.
    if (platforms.includes(p)) throw new PublishError(`--platform ${p} is given twice`);
    platforms.push(p);
  }
  return platforms;
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
 * Reads every retained release record, by key, with the asset keys they name. A record that cannot be read refuses,
 * since the key check cannot be proven without it.
 */
export async function recordedKeys(bucket: Bucket) {
  const keys: KeyHashes = new Map();
  const records = new Map<string, ReleaseRecord>();
  for (const entry of await bucket.list(RECORD_PREFIX)) {
    if (!("key" in entry)) {
      throw new PublishError(`${RECORD_PREFIX}: an object name outside the key grammar`);
    }
    const object = await bucket.get(entry.key, MAX_REPLY_BYTES);
    if (object === undefined) continue;
    let record;
    try {
      record = decodeRecord(object.bytes);
    } catch (e) {
      if (!(e instanceof ProtocolError)) throw e;
      throw new PublishError(`${entry.key} is unreadable: ${e.message}`);
    }
    if (recordKey(record.updateId) !== entry.key) {
      throw new PublishError(`${entry.key} is unreadable: its updateId differs from its name`);
    }
    for (const a of record.assets) addKey(keys, a.key, a.hash, entry.key);
    records.set(entry.key, record);
  }
  return { keys, records };
}

/** Records that `key` names `hash`; a key seen with another hash is refused, whichever source came first. */
function addKey(keys: KeyHashes, key: string, hash: string, source: string): void {
  const seen = keys.get(key.toLowerCase());
  if (seen === undefined) keys.set(key.toLowerCase(), { hash, source });
  else if (seen.hash !== hash) {
    throw new PublishError(
      `asset key ${key} names different bytes in ${seen.source} and ${source}: a key must never change its bytes`,
    );
  }
}

/** Builds and signs a new update from `draft` under a fresh ID: its stored reply and its release record. */
export async function compose(writer: Writer, draft: DraftRecord, createdAtMs: number) {
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
  const signature = await expoSignature(manifest, writer.signer);
  const { boundary, body } = encodeMultipart([{ name: "manifest", body: manifest, signature }]);
  return {
    updateId,
    reply: encodeStoredReply({
      kind: "manifest",
      updateId,
      boundary,
      manifestFilters: encodeSfvDictionary({ channel: draft.channel }),
      body,
    }),
    record: encodeRecord({ ...draft, updateId, createdAt }),
    line: (key: string) => `${key} ${updateId} ${createdAt}`,
  };
}

/** Builds and signs the stored `reply/no-update`. */
async function noUpdateReply(writer: Writer): Promise<Uint8Array<ArrayBuffer>> {
  const directive = buildNoUpdateAvailable();
  const signature = await expoSignature(directive, writer.signer);
  const { boundary, body } = encodeMultipart([{ name: "directive", body: directive, signature }]);
  return encodeStoredReply({ kind: "noUpdateAvailable", boundary, body });
}

/** Creates `reply/no-update` from `bytes`, or accepts one another writer created under this identity. */
async function ensureNoUpdate(writer: Writer, bytes: Uint8Array<ArrayBuffer>): Promise<void> {
  if ((await writer.bucket.putIfAbsent(NO_UPDATE_KEY, bytes)) !== undefined) return;
  if (!(await writer.checkNoUpdate())) {
    throw new PublishError(`${NO_UPDATE_KEY} was removed by another writer during the publish`);
  }
}

/**
 * Uploads every bundle and asset the bucket lacks, as immutable public content. A lost create means another writer
 * stored the same content-addressed bytes, which is accepted.
 */
async function uploadObjects(bucket: Bucket, exported: readonly ExportedPlatform[]): Promise<void> {
  const existing = new Set(await storedContent(bucket));
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

/** Returns every stored bundle and asset key: objects the server can serve. */
export async function storedContent(bucket: Bucket): Promise<string[]> {
  return [...(await bucket.list("assets/")), ...(await bucket.list("bundles/"))].flatMap((e) =>
    "key" in e ? [e.key] : [],
  );
}
