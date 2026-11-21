// Drives the Tide CLI as an operator's CI would, against a stack's store and identity only.
import { once } from "node:events";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type { Platform } from "./options.ts";
import type { Stack } from "./stack.ts";
import { hostEnv } from "./stack.ts";

const CLI = fileURLToPath(new URL("../../packages/cli/src/main.ts", import.meta.url));

interface Pointer {
  readonly channel: string;
  readonly runtimeVersion: string;
  readonly platform: Platform;
}

export interface TideCli {
  /** Runs `tide export` on the project at `projectRoot` into the new directory `out`. */
  export(
    projectRoot: string,
    out: string,
    platforms: readonly Platform[],
    runtimeVersion?: string,
  ): Promise<void>;
  /** Publishes the export at `from` and returns each written pointer's update ID by platform. */
  publish(from: string, channel: string): Promise<Partial<Record<Platform, string>>>;
  registerBuild(build: {
    readonly platform: Platform;
    readonly runtimeVersion: string;
    readonly manifest: string;
    readonly bundle: string;
    readonly assetsDir?: string; // Required when the manifest lists assets.
  }): Promise<void>;
  rollbackToEmbedded(pointer: Pointer): Promise<void>;
  /** Returns `tide probe`'s report of what the stack serves for `pointer`. */
  probe(pointer: Pointer): Promise<string>;
}

/** Returns a driver whose commands run with exactly the stack's variables and are stopped when the stack closes. */
export function tideCli(stack: Stack): TideCli {
  const pins = {
    TIDE_BUILD_KEYID: stack.identity.keyId,
    TIDE_BUILD_CERTIFICATE_FILE: stack.identity.certificateFile,
  };
  const write = {
    ...pins,
    TIDE_SIGNING_KEY_FILE: stack.identity.keyFile,
    TIDE_SERVER_URL: stack.serverUrl,
    TIDE_ASSET_URL: stack.serverUrl,
    TIDE_DISK_DIR: stack.storeDir,
  };
  const tide = (args: string[], env: Record<string, string>) => run(stack, args, env);
  const at = (p: Pointer) => [
    "--channel",
    p.channel,
    "--runtime-version",
    p.runtimeVersion,
    "--platform",
    p.platform,
  ];
  return {
    async export(projectRoot, out, platforms, runtimeVersion) {
      const env = hostEnv();
      // The export stages Expo's output under TMPDIR, so a killed export leaves nothing outside the stack.
      env.TMPDIR = await mkdtemp(join(stack.dir, "tmp-"));
      const selected = platforms.flatMap((p) => ["--platform", p]);
      const runtime = runtimeVersion === undefined ? [] : ["--runtime-version", runtimeVersion];
      await tide(
        ["export", "--project-root", projectRoot, "--out", out, ...selected, ...runtime],
        env,
      );
    },
    async publish(from, channel) {
      const stdout = await tide(["publish", "--from", from, "--channel", channel], write);
      // One `<pointer key> <update ID> <createdAt>` line per pointer written.
      const ids: Partial<Record<Platform, string>> = {};
      for (const line of stdout.trimEnd().split("\n")) {
        const [key = "", updateId = ""] = line.split(" ");
        ids[key.split("/")[3] as Platform] = updateId;
      }
      return ids;
    },
    async registerBuild(build) {
      await tide(
        [
          "register-build",
          "--platform",
          build.platform,
          "--runtime-version",
          build.runtimeVersion,
          "--manifest",
          build.manifest,
          "--bundle",
          build.bundle,
          ...(build.assetsDir === undefined ? [] : ["--assets-dir", build.assetsDir]),
        ],
        write,
      );
    },
    async rollbackToEmbedded(pointer) {
      await tide(["rollback", "--embedded", ...at(pointer)], write);
    },
    probe: (pointer) => tide(["probe", "--server-url", stack.serverUrl, ...at(pointer)], pins),
  };
}

/** Runs the CLI with exactly `env` and returns its stdout; a non-zero exit or a kill throws with its stderr. */
async function run(stack: Stack, args: string[], env: Record<string, string>) {
  const proc = stack.spawn(process.execPath, [CLI, ...args], env);
  let stdout = "";
  let stderr = "";
  proc.stdout.setEncoding("utf8").on("data", (s: string) => (stdout += s));
  proc.stderr.setEncoding("utf8").on("data", (s: string) => (stderr += s));
  const [code, signal] = (await once(proc, "close")) as [number | null, NodeJS.Signals | null];
  if (code !== 0) {
    throw new Error(
      `tide ${args[0]} ${signal ? `was killed by ${signal}` : `exited ${code}`}: ${stderr.trim()}`,
    );
  }
  return stdout;
}
