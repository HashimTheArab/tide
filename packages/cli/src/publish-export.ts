import { spawn } from "node:child_process";
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
import { dirname, join, sep } from "node:path";

import { sha256Base64Url } from "@tide/protocol";

import type { Env } from "./keys.ts";
import type { Platform } from "./publish-record.ts";
import { member } from "./keys.ts";
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
}

const STDOUT_LIMIT = 16 * 1024 * 1024;
const METADATA_LIMIT = 16 * 1024 * 1024;
// O_NOFOLLOW refuses a symlink as the last component; O_NONBLOCK keeps a FIFO from hanging the open.
const OPEN_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
const SEGMENT = /^[^/\\\0]+$/;
const EXT = /^[A-Za-z0-9]{1,16}$/;
// Metro names each file by the key the bundle asks for: the MD5 of its bytes.
const ASSET_PATH = /^assets\/([0-9a-f]{32})$/;
const DOM_PATH = /^www\.bundle\/([0-9a-f]{32})\.([A-Za-z0-9]{1,16})$/;

/**
 * Returns the environment for Expo's tools: the caller's without any `TIDE_` variable, no dotenv files, and the
 * production mode `expo export` forces, so config, runtime and bundle are evaluated alike.
 */
export function expoEnv(env: Env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (value !== undefined && !name.startsWith("TIDE_")) out[name] = value;
  }
  out.EXPO_NO_DOTENV = "1";
  out.NODE_ENV = "production";
  // As Expo's own setNodeEnv; the runtime resolver sets none, so it gets the same value explicitly.
  out.BABEL_ENV =
    env.BABEL_ENV === undefined || env.BABEL_ENV === "" ? "production" : env.BABEL_ENV;
  return out;
}

/** Runs `tool` from the project's own dependencies and returns its stdout parsed as JSON. */
export async function expoJson(
  projectRoot: string,
  env: Record<string, string>,
  tool: "expo" | "expo-updates",
  args: readonly string[],
): Promise<unknown> {
  const stdout = await runTool(projectRoot, env, tool, args, "pipe");
  try {
    return JSON.parse(stdout);
  } catch {
    throw new PublishError(`${tool} ${args[0] ?? ""} did not print JSON`);
  }
}

/** Runs `expo export` for `platforms` into `outputDir`; its progress output goes to stderr. */
export async function expoExport(
  projectRoot: string,
  env: Record<string, string>,
  outputDir: string,
  platforms: readonly Platform[],
): Promise<void> {
  const args = [
    "export",
    "--output-dir",
    outputDir,
    ...platforms.flatMap((p) => ["--platform", p]),
  ];
  await runTool(projectRoot, env, "expo", args, "stderr");
}

/** Returns the nearest `node_modules/.bin/<tool>` at or above the project root, as npm exec would. */
function toolPath(projectRoot: string, tool: string): string {
  for (let dir = projectRoot; ; dir = dirname(dir)) {
    const path = join(dir, "node_modules", ".bin", tool);
    if (statSync(path, { throwIfNoEntry: false })?.isFile() === true) return path;
    if (dirname(dir) === dir) {
      throw new PublishError(
        `${tool} is not installed in the project: add expo and expo-updates to its dependencies`,
      );
    }
  }
}

function runTool(
  projectRoot: string,
  env: Record<string, string>,
  tool: string,
  args: readonly string[],
  stdout: "pipe" | "stderr",
): Promise<string> {
  const command = `${tool} ${args[0] ?? ""}`;
  const child = spawn(toolPath(projectRoot, tool), args, {
    cwd: projectRoot,
    env,
    shell: false,
    stdio: ["ignore", stdout === "pipe" ? "pipe" : process.stderr, "inherit"],
  });
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    child.stdout?.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > STDOUT_LIMIT) child.kill("SIGKILL");
      else chunks.push(chunk);
    });
    child.once("error", () => {
      reject(new PublishError(`${command} could not be started`));
    });
    child.once("close", (code) => {
      if (size > STDOUT_LIMIT) reject(new PublishError(`${command} printed over 16 MiB`));
      else if (code !== 0) reject(new PublishError(`${command} failed with exit code ${code}`));
      else resolve(Buffer.concat(chunks).toString("utf8"));
    });
  });
}

/**
 * Reads a production `expo export` of `platforms` from `dir`. Every file must resolve inside the directory and be a
 * regular file, and every asset must hash to the key in its path. The directory must not change while it is read.
 */
export async function readExport(
  dir: string,
  platforms: readonly Platform[],
): Promise<Map<Platform, ExportedPlatform>> {
  let root: string;
  try {
    root = realpathSync(dir);
  } catch {
    throw new PublishError("the export directory is unreadable");
  }
  const cache = new Map<string, ExportedFile>();
  const file = async (path: unknown, field: string): Promise<ExportedFile> => {
    const real = containedPath(root, path, field);
    let found = cache.get(real);
    if (found === undefined) {
      const bytes = readRegular(real, Infinity, field);
      found = { bytes, hash: await sha256Base64Url(bytes) };
      cache.set(real, found);
    }
    return found;
  };

  let metadata: unknown;
  try {
    const bytes = readRegular(
      containedPath(root, "metadata.json", "metadata.json"),
      METADATA_LIMIT,
      "metadata.json",
    );
    metadata = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (e) {
    if (e instanceof PublishError) throw e;
    throw new PublishError("export metadata.json is not UTF-8 JSON");
  }
  if (member(metadata, "version") !== 0 || member(metadata, "bundler") !== "metro") {
    throw new PublishError("export metadata.json is not version 0 from metro");
  }
  const result = new Map<Platform, ExportedPlatform>();
  for (const platform of platforms) {
    const at = `metadata.json fileMetadata.${platform}`;
    const entry = member(member(metadata, "fileMetadata"), platform);
    const list = member(entry, "assets");
    if (entry === undefined)
      throw new PublishError(`export has no ${platform} bundle: ${at} is missing`);
    if (!Array.isArray(list)) throw new PublishError(`export ${at}.assets is not an array`);
    const bundle = await file(member(entry, "bundle"), `${at}.bundle`);
    const assets = new Map<string, ExportedAsset>();
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
      }
    }
    result.set(platform, { bundle, assets: [...assets.values()] });
  }
  return result;
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

/** Returns the bytes of the regular file at `path`, read through one descriptor. */
function readRegular(path: string, limit: number, field: string): Uint8Array<ArrayBuffer> {
  let fd: number;
  try {
    fd = openSync(path, OPEN_FLAGS);
  } catch {
    throw new PublishError(`export ${field} is missing or unreadable`);
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new PublishError(`export ${field} is not a regular file`);
    if (stat.size > limit) throw new PublishError(`export ${field} is over ${limit} bytes`);
    return new Uint8Array(readFileSync(fd));
  } finally {
    closeSync(fd);
  }
}
