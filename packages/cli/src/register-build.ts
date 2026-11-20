import { createHash } from "node:crypto";
import { readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

import type { BaseAsset } from "@tide/protocol";
import {
  MAX_BASE_BYTES,
  ProtocolError,
  assetContentType,
  baseKey,
  contentKey,
  encodeBaseRecord,
  replyKey,
  sha256Base64Url,
} from "@tide/protocol";

import type { Bucket } from "./bucket.ts";
import type { Env } from "./keys.ts";
import type { Platform } from "./publish-record.ts";
import type { PublishOptions, WriteStep } from "./publish.ts";
import { member } from "./keys.ts";
import { writing } from "./pointer.ts";
import { readRegular } from "./publish-export.ts";
import { PublishError } from "./publish-record.ts";
import { addKey, execute, recordedKeys } from "./publish.ts";
import { bucketFromEnv } from "./storage.ts";

export const REGISTER_BUILD_USAGE =
  "usage: tide register-build --platform ios|android --runtime-version <version> --manifest <app.manifest> --bundle <file> [--assets-dir <dir>]";
const MANIFEST_LIMIT = 16 * 1024 * 1024;
const MD5 = /^[0-9a-f]{32}$/;
const RERUN = "run register-build again before any other writer";
const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/**
 * Records a store build's embedded bundle as `bases/<id>`, its assets joining the asset key identity check. Exit codes
 * as publish: 0 registered (or already), 2 refused before any write, 1 failed after a write was attempted.
 */
export async function registerBuild(
  args: readonly string[],
  env: Env,
  options: PublishOptions,
): Promise<0 | 1 | 2> {
  return await execute(options, () => prepare(args, env, options));
}

async function prepare(
  args: readonly string[],
  env: Env,
  { out, cwd = process.cwd() }: PublishOptions,
): Promise<WriteStep> {
  const given = parse(args);
  replyKey("main", given.runtime, given.platform);
  const bucket = bucketFromEnv(env);

  const { id, key, keys } = readManifest(resolve(cwd, given.manifest));
  const bundle = readRegular(resolve(cwd, given.bundle), Infinity, "--bundle");
  const launch = await sha256Base64Url(bundle);
  const assets = await embeddedAssets(
    keys,
    given.assetsDir === undefined ? undefined : resolve(cwd, given.assetsDir),
  );
  const record = encodeBaseRecord({
    kind: "embedded",
    updateId: id,
    runtimeVersion: given.runtime,
    platform: given.platform as Platform,
    launchAsset: { hash: launch },
    assets,
  });

  const stored = await bucket.get(key, MAX_BASE_BYTES);
  if (stored !== undefined && !same(stored.bytes, record)) {
    throw new PublishError(`${key} holds another build`);
  }
  const { keys: recorded } = await recordedKeys(bucket);
  for (const a of assets) addKey(recorded, a.key, a.hash, "this build");
  const bundleKey = `bundles/${contentKey(launch)}`;
  const bundleStored = (await bucket.list("bundles/")).some(
    (e) => "key" in e && e.key === bundleKey,
  );

  return async () => {
    // The bundle first, so a base record never names a missing bundle; a lost create stored the same bytes.
    if (!bundleStored) {
      await writing(
        bundleKey,
        () => bucket.putIfAbsent(bundleKey, bundle, assetContentType("bundle")),
        RERUN,
      );
    }
    if (stored === undefined) await createBase(bucket, key, record);
    out(`${key} ${bundleKey}`);
  };
}

/** Creates `key`; a lost create succeeds only when the stored bytes are `record`. */
async function createBase(bucket: Bucket, key: string, record: Uint8Array<ArrayBuffer>) {
  if ((await writing(key, () => bucket.putIfAbsent(key, record), RERUN)) !== undefined) return;
  const stored = await writing(key, () => bucket.get(key, MAX_BASE_BYTES), RERUN);
  if (stored === undefined || !same(stored.bytes, record)) {
    throw new PublishError(`${key} holds another build`);
  }
}

function parse(args: readonly string[]) {
  let values;
  try {
    ({ values } = parseArgs({
      args: [...args],
      options: {
        platform: { type: "string", multiple: true },
        "runtime-version": { type: "string", multiple: true },
        manifest: { type: "string", multiple: true },
        bundle: { type: "string", multiple: true },
        "assets-dir": { type: "string", multiple: true },
      },
      strict: true,
      allowPositionals: false,
    }));
  } catch {
    throw new PublishError(`unrecognised arguments; ${REGISTER_BUILD_USAGE}`);
  }
  const once = (name: keyof typeof values) => {
    const list = values[name];
    if (list !== undefined && list.length > 1) throw new PublishError(`--${name} is given twice`);
    return list?.[0];
  };
  const required = (name: keyof typeof values) => {
    const value = once(name);
    if (value === undefined)
      throw new PublishError(`--${name} is required; ${REGISTER_BUILD_USAGE}`);
    return value;
  };
  return {
    platform: required("platform"),
    runtime: required("runtime-version"),
    manifest: required("manifest"),
    bundle: required("bundle"),
    assetsDir: once("assets-dir"),
  };
}

/** Returns the embedded update ID, its base record key and each asset's key from a build's `app.manifest`. */
function readManifest(path: string): { id: string; key: string; keys: string[] } {
  let manifest: unknown;
  try {
    manifest = JSON.parse(utf8.decode(readRegular(path, MANIFEST_LIMIT, "--manifest")));
  } catch (e) {
    if (e instanceof PublishError) throw e;
    throw new PublishError("--manifest is not UTF-8 JSON");
  }
  const id = member(manifest, "id") as string;
  let key;
  try {
    key = baseKey(id);
  } catch (e) {
    if (!(e instanceof ProtocolError)) throw e;
    throw new PublishError("the manifest's id is not a lowercase UUID");
  }
  const assets = member(manifest, "assets");
  if (!Array.isArray(assets)) throw new PublishError("the manifest's assets is not an array");
  const keys = (assets as unknown[]).map((a, i) => {
    const key = member(a, "packagerHash");
    if (typeof key !== "string" || !MD5.test(key)) {
      throw new PublishError(`the manifest's assets[${i}].packagerHash is not 32 lowercase hex`);
    }
    return key;
  });
  return { id, key, keys };
}

/**
 * Returns each key with the SHA-256 of the file under `dir` whose MD5 it is. Files are found by content, never by
 * location, since a packaged copy may be re-encoded; symlinks and special files are skipped.
 */
async function embeddedAssets(
  keys: readonly string[],
  dir: string | undefined,
): Promise<BaseAsset[]> {
  if (keys.length === 0) return [];
  if (dir === undefined) throw new PublishError("the manifest lists assets: give --assets-dir");
  const byMd5 = new Map<string, string>();
  const walk = async (rel: string) => {
    let entries;
    try {
      entries = readdirSync(join(dir, rel), { withFileTypes: true });
    } catch {
      throw new PublishError(`--assets-dir ${JSON.stringify(rel || ".")} cannot be listed`);
    }
    for (const e of entries) {
      const path = rel === "" ? e.name : `${rel}/${e.name}`;
      if (e.isDirectory()) await walk(path);
      if (!e.isFile()) continue;
      const bytes = readRegular(join(dir, path), Infinity, `--assets-dir ${JSON.stringify(path)}`);
      const md5 = createHash("md5").update(bytes).digest("hex");
      const hash = await sha256Base64Url(bytes);
      const seen = byMd5.get(md5);
      // MD5 collides; SHA-256 is the identity the key check compares.
      if (seen !== undefined && seen !== hash) {
        throw new PublishError(`--assets-dir holds two different files with MD5 ${md5}`);
      }
      byMd5.set(md5, hash);
    }
  };
  await walk("");
  return keys.map((key) => {
    const hash = byMd5.get(key);
    if (hash === undefined) throw new PublishError(`no file in --assets-dir has the MD5 ${key}`);
    return { key, hash };
  });
}

const same = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length && a.every((byte, i) => byte === b[i]);
