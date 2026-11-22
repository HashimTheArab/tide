import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import { join, sep } from "node:path";

import type { JsonObject } from "@tide-ota/protocol";
import { replyKey, sha256Base64Url } from "@tide-ota/protocol";

import type { SigningMetadata } from "./keys.ts";
import type { Platform } from "./publish-record.ts";
import { isObject, member, signingMetadata } from "./keys.ts";
import { PublishError } from "./publish-record.ts";

/** One exported file: its bytes and their SHA-256 as the manifest `hash`. */
interface ExportedFile {
  readonly bytes: Uint8Array<ArrayBuffer>;
  readonly hash: string;
}

/** A non-launch asset with the key the bundle references and its bare extension. */
interface ExportedAsset extends ExportedFile {
  readonly key: string;
  readonly ext: string;
}

export interface ExportedPlatform {
  readonly bundle: ExportedFile;
  readonly assets: readonly ExportedAsset[];
  // As metadata.json names them, every asset path kept before identical assets collapse.
  readonly paths: { readonly bundle: string; readonly assets: readonly string[] };
}

/** What `tide export` writes beside `dist/`: only what every manifest or shipped build already makes public. */
export interface ProjectExport {
  readonly certificate: string; // The PEM the builds embed.
  readonly codeSigningMetadata: SigningMetadata; // What the builds embed.
  // Chain mode: the certificate is the root the builds embed. Written only when true, so a direct export is unchanged.
  readonly codeSigningIncludeManifestResponseCertificateChain?: true;
  readonly expoClient: JsonObject; // `expo config --type public`, served as `extra.expoClient`.
  readonly platforms: Readonly<Partial<Record<Platform, { readonly runtimeVersion: string }>>>;
}

export const EXPORT_FILE = "tide-export.json";
export const EXPORT_LIMIT = 16 * 1024 * 1024;
const EXPORT_VERSION = 1;
// Every field the file holds; the reader refuses any other.
const EXPORT_FIELDS = {
  version: true,
  certificate: true,
  codeSigningMetadata: true,
  codeSigningIncludeManifestResponseCertificateChain: true,
  expoClient: true,
  platforms: true,
} as const satisfies Record<keyof ProjectExport | "version", true>;
export const CHAIN_FLAG = "codeSigningIncludeManifestResponseCertificateChain";
const CERTIFICATE_LIMIT = 64 * 1024;
const METADATA_LIMIT = 16 * 1024 * 1024;
// O_NOFOLLOW refuses a symlink as the last component; O_NONBLOCK keeps a FIFO from hanging the open.
const OPEN_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
const SEGMENT = /^[^/\\\0]+$/;
const EXT = /^[A-Za-z0-9]{1,16}$/;
// Metro names each file by the key the bundle asks for: the MD5 of its bytes.
const ASSET_PATH = /^assets\/([0-9a-f]{32})$/;
const DOM_PATH = /^www\.bundle\/([0-9a-f]{32})\.([A-Za-z0-9]{1,16})$/;

/** Returns the bytes of `tide-export.json` for `value`. */
export function encodeProjectExport(value: ProjectExport): Uint8Array<ArrayBuffer> {
  return new Uint8Array(
    new TextEncoder().encode(JSON.stringify({ version: EXPORT_VERSION, ...value })),
  );
}

/**
 * Reads an export directory `tide export` wrote: `tide-export.json` and each platform's files under `dist/`. Nothing
 * outside the directory is read; the directory must not change while it is read.
 */
export async function readProjectExport(dir: string) {
  let root: string;
  try {
    root = realpathSync(dir);
  } catch {
    throw new PublishError("the export directory is unreadable");
  }
  let value: unknown;
  try {
    const bytes = readRegular(
      containedPath(root, EXPORT_FILE, EXPORT_FILE),
      EXPORT_LIMIT,
      EXPORT_FILE,
    );
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (e) {
    if (e instanceof PublishError) throw e;
    throw new PublishError(`${EXPORT_FILE} is not UTF-8 JSON`);
  }
  const { platforms, ...identity } = checkExport(value);
  const targets = Object.entries(platforms).map(([platform, { runtimeVersion }]) => ({
    platform: platform as Platform,
    runtime: runtimeVersion,
  }));
  const dist = containedPath(root, "dist", "dist");
  if (!statSync(dist).isDirectory()) throw new PublishError("export dist is not a directory");
  const exported = (await readExport(dist, targets)).platforms;
  return { ...identity, platforms: exported };
}

/** Returns `value` as an export, refusing any field it should not hold. */
function checkExport(value: unknown): ProjectExport {
  if (!isObject(value) || !Object.keys(value).every((k) => Object.hasOwn(EXPORT_FIELDS, k))) {
    throw new PublishError(
      `${EXPORT_FILE} must hold only ${Object.keys(EXPORT_FIELDS).join(", ")}`,
    );
  }
  if (value.version !== EXPORT_VERSION) {
    throw new PublishError(`${EXPORT_FILE} version must be ${EXPORT_VERSION}`);
  }
  const { certificate, codeSigningMetadata, expoClient, platforms } = value;
  const chain = value[CHAIN_FLAG];
  // Absent is direct, so exports from before chain mode still read.
  if (chain !== undefined && chain !== true) {
    throw new PublishError(`${EXPORT_FILE} ${CHAIN_FLAG} must be true when present`);
  }
  if (
    typeof certificate !== "string" ||
    new TextEncoder().encode(certificate).length > CERTIFICATE_LIMIT
  ) {
    throw new PublishError(`${EXPORT_FILE} certificate must be a string of at most 64 KiB`);
  }
  if (!isObject(expoClient)) throw new PublishError(`${EXPORT_FILE} expoClient must be an object`);
  const entries = isObject(platforms) ? Object.entries(platforms) : [];
  if (entries.length === 0) {
    throw new PublishError(`${EXPORT_FILE} platforms must name at least one platform`);
  }
  for (const [platform, entry] of entries) {
    const runtime = member(entry, "runtimeVersion");
    if (
      (platform !== "ios" && platform !== "android") ||
      !isObject(entry) ||
      Object.keys(entry).length !== 1 ||
      typeof runtime !== "string"
    ) {
      throw new PublishError(
        `${EXPORT_FILE} platforms must map ios or android to only a string runtimeVersion`,
      );
    }
    replyKey("main", runtime, platform);
  }
  return {
    certificate,
    codeSigningMetadata: signingMetadata(codeSigningMetadata, `${EXPORT_FILE} codeSigningMetadata`),
    ...(chain && { [CHAIN_FLAG]: chain }),
    expoClient: expoClient as JsonObject,
    platforms: platforms as ProjectExport["platforms"],
  };
}

/**
 * Reads a production `expo export` of each target's platform from `dir`, returning each target's export and every file
 * read, by its path in `metadata.json`. Every file must resolve inside the directory and be a regular file, and every
 * asset must hash to the key in its path. The directory must not change while it is read.
 */
export async function readExport<T extends { readonly platform: Platform }>(
  dir: string,
  targets: readonly T[],
): Promise<{
  platforms: (T & ExportedPlatform)[];
  files: ReadonlyMap<string, Uint8Array<ArrayBuffer>>;
}> {
  let root: string;
  try {
    root = realpathSync(dir);
  } catch {
    throw new PublishError("the export directory is unreadable");
  }
  const cache = new Map<string, ExportedFile>();
  const files = new Map<string, Uint8Array<ArrayBuffer>>();
  const file = async (path: unknown, field: string): Promise<ExportedFile> => {
    const real = containedPath(root, path, field);
    let found = cache.get(real);
    if (found === undefined) {
      const bytes = readRegular(real, Infinity, `export ${field}`);
      found = { bytes, hash: await sha256Base64Url(bytes) };
      cache.set(real, found);
    }
    files.set(path as string, found.bytes);
    return found;
  };

  let metadata: unknown;
  try {
    const bytes = readRegular(
      containedPath(root, "metadata.json", "metadata.json"),
      METADATA_LIMIT,
      "export metadata.json",
    );
    files.set("metadata.json", bytes);
    metadata = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (e) {
    if (e instanceof PublishError) throw e;
    throw new PublishError("export metadata.json is not UTF-8 JSON");
  }
  if (member(metadata, "version") !== 0 || member(metadata, "bundler") !== "metro") {
    throw new PublishError("export metadata.json is not version 0 from metro");
  }
  const result: (T & ExportedPlatform)[] = [];
  for (const target of targets) {
    const { platform } = target;
    const at = `metadata.json fileMetadata.${platform}`;
    const entry = member(member(metadata, "fileMetadata"), platform);
    const list = member(entry, "assets");
    if (entry === undefined)
      throw new PublishError(`export has no ${platform} bundle: ${at} is missing`);
    if (!Array.isArray(list)) throw new PublishError(`export ${at}.assets is not an array`);
    const bundlePath = member(entry, "bundle");
    const bundle = await file(bundlePath, `${at}.bundle`);
    const assets = new Map<string, ExportedAsset>();
    const assetPaths: string[] = [];
    for (const [i, item] of (list as unknown[]).entries()) {
      const name = `${at}.assets[${i}]`;
      const path = member(item, "path");
      const ext = member(item, "ext");
      if (typeof ext !== "string" || !EXT.test(ext)) {
        throw new PublishError(`export ${name}.ext must be 1 to 16 of A-Z, a-z and 0-9`);
      }
      const match =
        typeof path === "string" ? (ASSET_PATH.exec(path) ?? DOM_PATH.exec(path)) : null;
      if (match === null || (match[2] !== undefined && match[2] !== ext)) {
        throw new PublishError(`export ${name}.path is not assets/<md5> or www.bundle/<md5>.<ext>`);
      }
      const key = match[1] ?? "";
      const exported = await file(path, `${name}.path`);
      assetPaths.push(path as string);
      if (createHash("md5").update(exported.bytes).digest("hex") !== key) {
        throw new PublishError(
          `export ${name}.path does not hash to the key in its name: the file changed after expo export`,
        );
      }
      // DOM components can each list the same content-hashed chunk; identical entries collapse to one.
      const seen = assets.get(key);
      if (seen === undefined) assets.set(key, { ...exported, key, ext });
      else if (seen.ext !== ext) {
        throw new PublishError(`export ${name} lists key ${key} with two extensions`);
      } else if (seen.hash !== exported.hash) {
        // MD5 collides; SHA-256 is the identity the manifest promises.
        throw new PublishError(`export ${name} lists key ${key} for two different files`);
      }
    }
    result.push({
      ...target,
      bundle,
      assets: [...assets.values()],
      paths: { bundle: bundlePath as string, assets: assetPaths },
    });
  }
  return { platforms: result, files };
}

/** Returns the real path of `path` under `root`, refusing any form or symlink that leaves it. */
function containedPath(root: string, path: unknown, field: string): string {
  if (
    typeof path !== "string" ||
    !path.split("/").every((s) => SEGMENT.test(s) && s !== "." && s !== "..")
  ) {
    throw new PublishError(`export ${field} must be a relative path inside the export`);
  }
  let real: string;
  try {
    real = realpathSync(join(root, path));
  } catch {
    throw new PublishError(`export ${field} is missing or unreadable`);
  }
  if (!real.startsWith(root + sep)) {
    throw new PublishError(`export ${field} resolves outside the export directory`);
  }
  return real;
}

/** Returns the bytes of the regular file at `path`, read through one descriptor; `name` leads each refusal. */
export function readRegular(path: string, limit: number, name: string): Uint8Array<ArrayBuffer> {
  let fd: number;
  try {
    fd = openSync(path, OPEN_FLAGS);
  } catch {
    throw new PublishError(`${name} is missing or unreadable`);
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new PublishError(`${name} is not a regular file`);
    if (stat.size > limit) throw new PublishError(`${name} is over ${limit} bytes`);
    return new Uint8Array(readFileSync(fd));
  } finally {
    closeSync(fd);
  }
}
