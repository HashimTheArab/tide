import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";

import type { JsonObject } from "@tide/protocol";
import { replyKey } from "@tide/protocol";

import type { Env } from "./keys.ts";
import type { ProjectExport } from "./publish-export.ts";
import type { Platform } from "./publish-record.ts";
import type { PublishOptions } from "./publish.ts";
import {
  KeyError,
  isObject,
  member,
  readSmallFile,
  signingMetadata,
  validCertificate,
} from "./keys.ts";
import { EXPORT_FILE, EXPORT_LIMIT, encodeProjectExport, readExport } from "./publish-export.ts";
import { PublishError, platformsOf } from "./publish-record.ts";
import { parsed, report } from "./publish.ts";

export const EXPORT_USAGE =
  "usage: tide export --out <dir> [--platform ios|android]... [--runtime-version <version>] [--project-root <dir>] [--pass-env <name>]...";
const STDOUT_LIMIT = 16 * 1024 * 1024;
// What every child sees from the caller: locale, paths and CI flags, and what Expo inlines into the public bundle.
const INHERITED = /^(?:PATH|HOME|TMPDIR|LANG|LANGUAGE|TZ|CI|LC_[A-Z]+|EXPO_PUBLIC_\w+)$/;
const NAME = /^[A-Za-z_]\w*$/;
// Tide's own, cloud and CI credentials; the export holds none, so project code is never given them.
const SECRET = /^(?:TIDE|AWS|ACTIONS)_/i;

/**
 * Exports the app for `tide publish --from`: the public config, each platform's runtime, the certificate and
 * `keyid`, and the files `metadata.json` names. Reads no credential. Exit 0, or 2 on any refusal or tool failure.
 */
export async function exportProject(
  args: readonly string[],
  env: Env,
  options: PublishOptions,
): Promise<0 | 2> {
  try {
    await run(args, env, options);
    return 0;
  } catch (e) {
    return report(e, options, 2);
  }
}

async function run(
  args: readonly string[],
  env: Env,
  { out: print, now = Date.now, cwd = process.cwd() }: PublishOptions,
) {
  const { out, platforms, runtimeVersion, projectRoot, passEnv } = parse(args, cwd);
  const childEnv = environment(env, passEnv);

  const config = await expoJson(projectRoot, childEnv, ["config", "--json"], "expo");
  const updates = member(config, "updates");
  const metadata = signingMetadata(
    member(updates, "codeSigningMetadata"),
    "app config updates.codeSigningMetadata",
  );
  const certificate = await appCertificate(
    projectRoot,
    member(updates, "codeSigningCertificate"),
    now(),
  );
  const expoClient = await expoJson(
    projectRoot,
    childEnv,
    ["config", "--type", "public", "--json"],
    "expo",
  );
  if (!isObject(expoClient)) {
    throw new PublishError("expo config --type public did not print an object");
  }
  const runtimes: Partial<Record<Platform, { runtimeVersion: string }>> = {};
  for (const platform of platforms) {
    const runtime =
      runtimeVersion ??
      member(
        await expoJson(
          projectRoot,
          childEnv,
          ["runtimeversion:resolve", "--platform", platform],
          "expo-updates",
        ),
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
    replyKey("main", runtime, platform);
    runtimes[platform] = { runtimeVersion: runtime };
  }
  const value: ProjectExport = {
    certificate,
    codeSigningMetadata: metadata,
    expoClient: expoClient as JsonObject,
    platforms: runtimes,
  };
  const envelope = encodeProjectExport(value);
  if (envelope.length > EXPORT_LIMIT) {
    throw new PublishError(`${EXPORT_FILE} would be over ${EXPORT_LIMIT} bytes`);
  }

  try {
    mkdirSync(out);
  } catch (e) {
    throw new PublishError(
      (e as NodeJS.ErrnoException).code === "EEXIST"
        ? "--out already exists: give a new directory"
        : "--out cannot be created",
    );
  }
  const staging = mkdtempSync(join(tmpdir(), "tide-export-"));
  try {
    const selected = platforms.flatMap((p) => ["--platform", p]);
    await runTool(projectRoot, childEnv, "expo", ["export", "--output-dir", staging, ...selected]);
    const { files } = await readExport(
      staging,
      platforms.map((platform) => ({ platform })),
    );
    // Only what metadata.json names: Expo also copies the project's public/ folder into its output.
    for (const [path, bytes] of files) write(join(out, "dist", path), bytes);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
  // Written last, under its name only once complete, so a partial export is never read as one.
  const temporary = join(out, `.${EXPORT_FILE}.partial`);
  write(temporary, envelope);
  renameSync(temporary, join(out, EXPORT_FILE));
  for (const platform of platforms) print(`${platform} ${runtimes[platform]?.runtimeVersion}`);
}

function parse(args: readonly string[], cwd: string) {
  const { values } = parsed(EXPORT_USAGE, () =>
    parseArgs({
      args: [...args],
      options: {
        out: { type: "string" },
        platform: { type: "string", multiple: true },
        "runtime-version": { type: "string" },
        "project-root": { type: "string" },
        "pass-env": { type: "string", multiple: true },
      },
      strict: true,
      allowPositionals: false,
    }),
  );
  if (values.out === undefined) throw new PublishError(`--out is required; ${EXPORT_USAGE}`);
  const runtimeVersion = values["runtime-version"];
  if (runtimeVersion !== undefined) replyKey("main", runtimeVersion, "ios");
  const passEnv = values["pass-env"] ?? [];
  for (const name of passEnv) {
    if (!NAME.test(name)) throw new PublishError("--pass-env must name an environment variable");
    if (SECRET.test(name)) {
      throw new PublishError(
        "--pass-env cannot pass TIDE_, AWS_ or ACTIONS_ variables to project code",
      );
    }
  }
  return {
    // Both against the caller's directory, before any child runs elsewhere.
    out: resolve(cwd, values.out),
    projectRoot: resolve(cwd, values["project-root"] ?? "."),
    platforms: platformsOf(values.platform),
    runtimeVersion,
    passEnv,
  };
}

/**
 * Returns the environment every child gets: the inherited allowlist, each `--pass-env` name, no dotenv files, and
 * the production mode `expo export` forces, so config, runtime and bundle are evaluated alike.
 */
function environment(env: Env, passEnv: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (value !== undefined && (INHERITED.test(name) || passEnv.includes(name))) out[name] = value;
  }
  out.EXPO_NO_DOTENV = "1";
  out.NODE_ENV = "production";
  // As Expo's own setNodeEnv; the runtime resolver sets none, so it gets the same value explicitly.
  out.BABEL_ENV =
    env.BABEL_ENV === undefined || env.BABEL_ENV === "" ? "production" : env.BABEL_ENV;
  return out;
}

/** Returns the app's certificate PEM, checked against the code-signing profile at epoch milliseconds `now`. */
async function appCertificate(projectRoot: string, path: unknown, now: number): Promise<string> {
  if (typeof path !== "string" || path === "") {
    throw new KeyError(
      "app config has no updates.codeSigningCertificate: Tide publishes only signed updates",
    );
  }
  // Invalid UTF-8 decodes to U+FFFD, which the certificate's PEM pattern refuses.
  const pem = readSmallFile(join(projectRoot, path))?.toString("utf8");
  if (pem === undefined) {
    throw new KeyError("updates.codeSigningCertificate is unreadable or over 64 KiB");
  }
  // One CERTIFICATE block and whitespace only, so the export can carry nothing else from the file.
  await validCertificate(pem, "updates.codeSigningCertificate", now);
  return pem;
}

/** Writes a new file at `path`, creating its directories. */
function write(path: string, bytes: Uint8Array): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, bytes, { flag: "wx" });
  } catch {
    throw new PublishError("the export directory cannot be written");
  }
}

/** Runs `tool` from the project's own dependencies and returns its stdout parsed as JSON. */
async function expoJson(
  projectRoot: string,
  env: Record<string, string>,
  args: readonly string[],
  tool: "expo" | "expo-updates",
): Promise<unknown> {
  const stdout = await runTool(projectRoot, env, tool, args, "pipe");
  try {
    return JSON.parse(stdout);
  } catch {
    throw new PublishError(`${tool} ${args[0] ?? ""} did not print JSON`);
  }
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

/** Runs `tool` with no shell; its stdout is returned, or with "stderr" passed through as progress. */
function runTool(
  projectRoot: string,
  env: Record<string, string>,
  tool: string,
  args: readonly string[],
  stdout: "pipe" | "stderr" = "stderr",
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
