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
import type { Platform } from "./publish-record.ts";
import { BucketError } from "./bucket.ts";
import { KeyError, isObject, member, openWriter } from "./keys.ts";
import { createdAtFloor, readPointer, writePointer } from "./pointer.ts";
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

/** One platform's pointer, its export and the pointer state read before composing. */
interface Target extends ExportedPlatform {
  readonly platform: Platform;
  readonly runtime: string;
  readonly key: string; // The pointer.
  readonly previous: PointerState;
}

/** One target's update, built and signed in memory before anything is written. */
interface Composed {
  readonly updateId: string;
  readonly createdAt: string;
  readonly reply: Uint8Array<ArrayBuffer>;
  readonly record: Uint8Array<ArrayBuffer>;
}

/** Everything a publish writes, prepared with every refusal already made. */
interface Plan {
  readonly writer: Writer;
  readonly updates: readonly (readonly [Target, Composed])[];
  readonly noUpdate: Uint8Array<ArrayBuffer> | undefined; // Absent when the bucket already holds one.
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
    await write(plan, options.out);
  } catch (e) {
    return report(e, options, 1);
  }
  return 0;
}

function report<Code extends 1 | 2>(e: unknown, { err }: PublishOptions, code: Code): Code {
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
): Promise<Plan> {
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
  const { bucket } = writer;
  const exported = await exportFor(projectRoot, toolEnv, exportDir, pointers);

  const keys: KeyHashes = new Map();
  await addRecordedKeys(bucket, keys);
  for (const { platform, assets } of exported) {
    for (const a of assets) addKey(keys, a.key, a.hash, `this export (${platform})`);
  }

  const targets: Target[] = [];
  for (const e of exported) targets.push({ ...e, previous: await readPointer(bucket, e.key) });
  const bucketTime = await bucket.time();
  const local = now(); // The one sample every createdAt comes from.
  if (Math.abs(local - bucketTime) > MAX_SKEW_MS) {
    throw new PublishError(
      "the local clock differs from the bucket's by more than a minute: fix the clock",
    );
  }
  await writer.checkCertificate(local);
  await writer.checkCertificate(bucketTime);
  // Valid by both clocks, each read afresh, so neither clock alone can activate an update past expiry.
  const checkCertificate = async () => {
    await writer.checkCertificate(now());
    await writer.checkCertificate(await bucket.time());
  };

  const updates: (readonly [Target, Composed])[] = [];
  for (const t of targets) {
    const createdAt = createdAtFloor(local, t.previous);
    const p = { channel, serverUrl, assetBase, expoClient: expoClient as JsonObject, createdAt };
    updates.push([t, await compose(writer, t, p)]);
  }
  const noUpdate = writer.noUpdate ? undefined : await noUpdateReply(writer);
  return { writer, updates, noUpdate, checkCertificate };
}

async function write(
  { writer, updates, noUpdate, checkCertificate }: Plan,
  out: (line: string) => void,
): Promise<void> {
  const { bucket } = writer;
  await uploadObjects(
    bucket,
    updates.map(([t]) => t),
  );
  if (noUpdate !== undefined) await ensureNoUpdate(writer, noUpdate);
  for (const [, c] of updates) {
    const key = recordKey(c.updateId);
    if ((await bucket.putIfAbsent(key, c.record)) === undefined) {
      throw new PublishError(`${key} already exists`);
    }
  }
  for (const [t, c] of updates) {
    await checkCertificate();
    await writePointer(bucket, t.key, c.reply, t.previous);
    out(`${t.key} ${c.updateId} ${c.createdAt}`);
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
  const platforms: Platform[] = [];
  for (const p of values.platform ?? ["ios", "android"]) {
    if (p !== "ios" && p !== "android") throw new PublishError("--platform must be ios or android");
    // Two writes over one read ETag would fail the run against its own pointer.
    if (platforms.includes(p)) throw new PublishError(`--platform ${p} is given twice`);
    platforms.push(p);
  }
  const exportDir = values["export-dir"];
  return {
    channel,
    platforms,
    runtimeVersion: values["runtime-version"],
    exportDir: exportDir === undefined ? undefined : resolve(cwd, exportDir),
    projectRoot: resolve(cwd, values["project-root"] ?? "."),
  };
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

/** Adds every asset key of every retained release record; a record that cannot be read refuses the publish. */
async function addRecordedKeys(bucket: Bucket, keys: KeyHashes): Promise<void> {
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
  }
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

/** Builds and signs one target's manifest, its stored reply and its release record. */
async function compose(
  writer: Writer,
  { platform, runtime, bundle, assets }: Target,
  p: {
    readonly channel: string;
    readonly serverUrl: string;
    readonly assetBase: string;
    readonly expoClient: JsonObject;
    readonly createdAt: number;
  },
): Promise<Composed> {
  const updateId = randomUUID();
  const date = new Date(p.createdAt);
  const createdAt = date.toISOString();
  const extra = { expoClient: p.expoClient };
  const manifest = buildManifest({
    id: updateId,
    createdAt: date,
    runtimeVersion: runtime,
    launchAsset: {
      hash: bundle.hash,
      contentType: assetContentType("bundle"),
      fileExtension: ".bundle",
      url: launchUrl(p.serverUrl, bundle.hash),
    },
    assets: assets.map((a) => ({
      hash: a.hash,
      key: a.key,
      contentType: assetContentType(a.ext),
      fileExtension: `.${a.ext}`,
      url: assetUrl(p.assetBase, a.hash),
    })),
    metadata: { channel: p.channel },
    extra,
  });
  const signature = await expoSignature(manifest, writer.signer);
  const { boundary, body } = encodeMultipart([{ name: "manifest", body: manifest, signature }]);
  return {
    updateId,
    createdAt,
    reply: encodeStoredReply({
      kind: "manifest",
      updateId,
      boundary,
      manifestFilters: encodeSfvDictionary({ channel: p.channel }),
      body,
    }),
    record: encodeRecord({
      updateId,
      channel: p.channel,
      runtimeVersion: runtime,
      platform,
      createdAt,
      serverUrl: p.serverUrl,
      assetUrl: p.assetBase,
      launchAsset: { hash: bundle.hash },
      assets: assets.map((a) => ({ key: a.key, hash: a.hash, fileExtension: `.${a.ext}` })),
      extra,
    }),
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
  const existing = new Set(
    [...(await bucket.list("assets/")), ...(await bucket.list("bundles/"))].flatMap((e) =>
      "key" in e ? [e.key] : [],
    ),
  );
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
