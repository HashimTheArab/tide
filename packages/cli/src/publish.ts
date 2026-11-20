import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

import type { JsonObject } from "@tide/protocol";
import {
  MAX_REPLY_BYTES,
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

import type { Bucket, ObjectHeaders } from "./bucket.ts";
import type { Env, Writer } from "./keys.ts";
import type { PointerState } from "./pointer.ts";
import type { ExportedPlatform } from "./publish-export.ts";
import type { Platform } from "./publish-record.ts";
import { BucketError } from "./bucket.ts";
import { KeyError, member, openWriter } from "./keys.ts";
import { createdAtFloor, ensureNoUpdate, readPointer, writePointer } from "./pointer.ts";
import { expoEnv, expoExport, expoJson, readExport } from "./publish-export.ts";
import {
  KeyIdentity,
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

/** One platform's update, built and signed in memory before anything is written. */
interface Composed {
  readonly key: string;
  readonly updateId: string;
  readonly createdAt: string;
  readonly reply: Uint8Array<ArrayBuffer>;
  readonly record: Uint8Array<ArrayBuffer>;
  readonly previous: PointerState;
}

export const PUBLISH_USAGE =
  "usage: tide publish --channel <name> [--platform ios|android]... [--runtime-version <version>] [--export-dir <dir>] [--project-root <dir>]";
const IMMUTABLE = "public, max-age=31536000, immutable";
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
  const state = { writing: false };
  try {
    await run(args, env, options, () => {
      state.writing = true;
    });
    return 0;
  } catch (e) {
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
    options.err(`tide: ${e.message}`);
    return state.writing ? 1 : 2;
  }
}

async function run(
  args: readonly string[],
  env: Env,
  { out, now = Date.now, cwd = process.cwd() }: PublishOptions,
  startWriting: () => void,
): Promise<void> {
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
  if (typeof expoClient !== "object" || expoClient === null || Array.isArray(expoClient)) {
    throw new PublishError("expo config --type public did not print an object");
  }
  const runtimes = new Map<Platform, string>();
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
    if (typeof runtime !== "string" || !inGrammar(() => replyKey(channel, runtime, platform))) {
      throw new PublishError(
        `the ${platform} runtime version must be 1 to 64 of A-Z, a-z, 0-9, ., _, +, -, (, ) and :`,
      );
    }
    runtimes.set(platform, runtime);
  }

  const writer = await openWriter(env, { projectRoot, config }, { now });
  const { bucket } = writer;
  const exported =
    exportDir === undefined
      ? await freshExport(projectRoot, toolEnv, platforms)
      : await readExport(exportDir, platforms);

  const identity = new KeyIdentity();
  await addRecordedKeys(bucket, identity);
  for (const [platform, { assets }] of exported) {
    for (const a of assets) identity.add(a.key, a.hash, `this export (${platform})`);
  }

  const previous = new Map<Platform, PointerState>();
  for (const platform of platforms) {
    const key = replyKey(channel, runtimes.get(platform) ?? "", platform);
    previous.set(platform, await readPointer(bucket, key));
  }
  const bucketTime = await bucket.time();
  const local = now(); // The one sample every createdAt comes from.
  if (Math.abs(local - bucketTime) > MAX_SKEW_MS) {
    throw new PublishError(
      "the local clock differs from the bucket's by more than a minute: fix the clock",
    );
  }
  // Valid by both clocks, so a skewed publisher cannot activate an update after the certificate expires.
  const checkCertificate = async () => {
    const at = now();
    await writer.checkCertificate(at);
    await writer.checkCertificate(at + bucketTime - local);
  };
  await checkCertificate();

  const composed: Composed[] = [];
  for (const [platform, files] of exported) {
    const runtime = runtimes.get(platform) ?? "";
    const before = previous.get(platform) ?? {};
    composed.push(
      await compose(writer, files, {
        channel,
        platform,
        runtime,
        serverUrl,
        assetBase,
        expoClient: expoClient as JsonObject,
        createdAt: createdAtFloor(local, before),
        previous: before,
      }),
    );
  }
  const noUpdate = writer.noUpdate ? undefined : await noUpdateReply(writer);

  startWriting();
  await uploadObjects(bucket, exported);
  if (noUpdate !== undefined) await ensureNoUpdate(writer, noUpdate);
  for (const c of composed) {
    const key = recordKey(c.updateId);
    if ((await bucket.putIfAbsent(key, c.record)) === undefined) {
      throw new PublishError(`${key} already exists`);
    }
  }
  for (const c of composed) {
    await checkCertificate();
    await writePointer(bucket, c.key, c.reply, c.previous);
    out(`${c.key} ${c.updateId} ${c.createdAt}`);
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
  if (!inGrammar(() => replyKey(channel, "1", "ios"))) {
    throw new PublishError(
      "--channel must be 1 to 64 of A-Z, a-z, 0-9, ., _, +, -, (, ) and :, and not . or ..",
    );
  }
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

function inGrammar(check: () => unknown): boolean {
  try {
    check();
    return true;
  } catch {
    return false;
  }
}

async function freshExport(
  projectRoot: string,
  env: Record<string, string>,
  platforms: readonly Platform[],
): Promise<Map<Platform, ExportedPlatform>> {
  const dir = mkdtempSync(join(tmpdir(), "tide-export-"));
  try {
    await expoExport(projectRoot, env, dir, platforms);
    return await readExport(dir, platforms);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Adds every asset key of every retained release record; a record that cannot be read refuses the publish. */
async function addRecordedKeys(bucket: Bucket, identity: KeyIdentity): Promise<void> {
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
    for (const a of record.assets) identity.add(a.key, a.hash, entry.key);
  }
}

/** Builds and signs one platform's manifest, its stored reply and its release record. */
async function compose(
  writer: Writer,
  { bundle, assets }: ExportedPlatform,
  p: {
    readonly channel: string;
    readonly platform: Platform;
    readonly runtime: string;
    readonly serverUrl: string;
    readonly assetBase: string;
    readonly expoClient: JsonObject;
    readonly createdAt: number;
    readonly previous: PointerState;
  },
): Promise<Composed> {
  const updateId = randomUUID();
  const createdAt = new Date(p.createdAt).toISOString();
  const extra = { expoClient: p.expoClient };
  const manifest = buildManifest({
    id: updateId,
    createdAt: new Date(p.createdAt),
    runtimeVersion: p.runtime,
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
    key: replyKey(p.channel, p.runtime, p.platform),
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
      runtimeVersion: p.runtime,
      platform: p.platform,
      createdAt,
      serverUrl: p.serverUrl,
      assetUrl: p.assetBase,
      launchAsset: { hash: bundle.hash },
      assets: assets.map((a) => ({ key: a.key, hash: a.hash, fileExtension: `.${a.ext}` })),
      extra,
    }),
    previous: p.previous,
  };
}

/** Builds and signs the stored `reply/no-update`. */
async function noUpdateReply(writer: Writer): Promise<Uint8Array<ArrayBuffer>> {
  const directive = buildNoUpdateAvailable();
  const signature = await expoSignature(directive, writer.signer);
  const { boundary, body } = encodeMultipart([{ name: "directive", body: directive, signature }]);
  return encodeStoredReply({ kind: "noUpdateAvailable", boundary, body });
}

/**
 * Uploads every bundle and asset the bucket lacks, with the headers its public domain serves. A lost create means
 * another writer stored the same content-addressed bytes, which is accepted.
 */
async function uploadObjects(
  bucket: Bucket,
  exported: ReadonlyMap<Platform, ExportedPlatform>,
): Promise<void> {
  const existing = new Set(
    [...(await bucket.list("assets/")), ...(await bucket.list("bundles/"))].flatMap((e) =>
      "key" in e ? [e.key] : [],
    ),
  );
  const pending = new Map<string, { bytes: Uint8Array<ArrayBuffer>; headers: ObjectHeaders }>();
  const add = (key: string, bytes: Uint8Array<ArrayBuffer>, contentType: string) => {
    if (!existing.has(key) && !pending.has(key)) {
      pending.set(key, { bytes, headers: { contentType, cacheControl: IMMUTABLE } });
    }
  };
  for (const { bundle, assets } of exported.values()) {
    add(`bundles/${contentKey(bundle.hash)}`, bundle.bytes, assetContentType("bundle"));
    for (const a of assets) add(`assets/${contentKey(a.hash)}`, a.bytes, assetContentType(a.ext));
  }
  for (const [key, { bytes, headers }] of pending) await bucket.putIfAbsent(key, bytes, headers);
}
