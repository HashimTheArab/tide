// The conformance app: one shared source built per expo-updates version, configured for a stack's Tide and identity.
import { once } from "node:events";
import {
  copyFileSync,
  cpSync,
  createWriteStream,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type { ExpoVersion } from "./options.ts";
import type { Stack } from "./stack.ts";
import type { TideCli } from "./tide-cli.ts";
import { hostEnv, tail } from "./stack.ts";

const APPS = fileURLToPath(new URL("../apps/", import.meta.url));
const CERTIFICATE = "keys/certificate.pem";

/** One version's app, materialised in a stack's temp dir. */
export interface App {
  readonly version: ExpoVersion;
  readonly dir: string;
  readonly packageName: string;
  readonly channel: string; // One per version, so versions share a stack without sharing a pointer.
  readonly runtimeVersion: string; // One per version: bases and patches are scoped by runtime, and each SDK is its own.
}

/** A release build and what `register-build` reads from it. */
export interface AndroidBuild {
  readonly apk: string;
  readonly marker: string;
  readonly embeddedUpdateId: string; // app.manifest's `id`
  readonly manifest: string; // app.manifest
  readonly bundle: string; // index.android.bundle
  readonly resDir: string; // The res dir the release bundle task generated, holding the embedded assets.
}

/** Copies the version's app into the stack's dir and writes its config for the stack's Tide and identity. */
export function materialise(stack: Stack, version: ExpoVersion): App {
  const dir = join(stack.dir, `app-${version}`);
  cpSync(join(APPS, "shared"), dir, { recursive: true, errorOnExist: true, force: false });
  for (const file of ["package.json", "package-lock.json"]) {
    copyFileSync(join(APPS, `sdk-${version}`, file), join(dir, file));
  }
  mkdirSync(join(dir, "keys"));
  copyFileSync(stack.identity.certificateFile, join(dir, CERTIFICATE));
  const app = {
    version,
    dir,
    packageName: `dev.tide.conformance.sdk${version}`,
    channel: `expo-${version}`,
    runtimeVersion: `1.0.0-sdk${version}`,
  };
  const config = {
    expo: {
      name: `Tide conformance ${version}`,
      slug: "tide-conformance",
      version: "1.0.0",
      runtimeVersion: app.runtimeVersion,
      android: { package: app.packageName },
      plugins: ["./cleartext.js"],
      updates: {
        url: `${stack.serverUrl}/manifest`,
        requestHeaders: { "expo-channel-name": app.channel },
        // Only the app's own fetch requests an update, so each launch is one deterministic step.
        checkAutomatically: "NEVER",
        enableBsdiffPatchSupport: true, // Off by default on 55.
        codeSigningCertificate: `./${CERTIFICATE}`,
        codeSigningMetadata: { keyid: stack.identity.keyId, alg: "rsa-v1_5-sha256" },
      },
    },
  };
  writeFileSync(join(dir, "app.json"), `${JSON.stringify(config, null, 2)}\n`);
  return app;
}

/** Sets the marker the next build or export of `app` reports. */
export function writeMarker(app: App, marker: string): void {
  writeFileSync(join(app.dir, "marker.js"), `export const MARKER = ${JSON.stringify(marker)};\n`);
}

/**
 * Installs the app's locked dependencies, prebuilds it and runs a clean release build for `abi`, then extracts the
 * embedded update for `register-build`.
 */
export async function buildAndroid(
  stack: Stack,
  app: App,
  sdk: string,
  abi: string,
  marker: string,
): Promise<AndroidBuild> {
  writeMarker(app, marker);
  const log = join(app.dir, "build.log");
  const env = { ...hostEnv(), ANDROID_HOME: sdk, CI: "1" };
  const step = (command: string, args: readonly string[], cwd = app.dir) =>
    run(stack, command, args, env, cwd, log);
  // Install scripts stay off: the app needs none, and they would run every dependency's code.
  await step("npm", ["ci", "--ignore-scripts", "--no-audit", "--no-fund"]);
  await step(join(app.dir, "node_modules", ".bin", "expo"), [
    "prebuild",
    "--platform",
    "android",
    "--no-install",
  ]);
  const android = join(app.dir, "android");
  await step(
    join(android, "gradlew"),
    [
      "assembleRelease",
      "--rerun-tasks",
      "--no-daemon",
      "--console=plain",
      `-PreactNativeArchitectures=${abi}`,
      // No Kotlin daemon outlives the build; an in-process compiler runs out of heap.
      "-Pkotlin.compiler.execution.strategy=out-of-process",
    ],
    android,
  );
  const apk = join(android, "app", "build", "outputs", "apk", "release", "app-release.apk");
  const out = join(app.dir, "embedded");
  await step("unzip", ["-q", apk, "assets/app.manifest", "assets/index.android.bundle", "-d", out]);
  const manifest = join(out, "assets", "app.manifest");
  const resDir = join(android, "app", "build", "generated", "res", "react", "release");
  const { id, assets } = JSON.parse(readFileSync(manifest, "utf8")) as {
    id: string;
    assets: unknown[];
  };
  if (assets.length !== 1) {
    throw new Error(`the embedded update does not ship one image asset: ${JSON.stringify(assets)}`);
  }
  return {
    apk,
    marker,
    embeddedUpdateId: id.toLowerCase(),
    manifest,
    bundle: join(out, "assets", "index.android.bundle"),
    resDir,
  };
}

/**
 * Exports `app` with `marker` into a new directory under the stack and returns it, for `tide publish --from`;
 * `runtimeVersion` replaces the app's.
 */
export async function exportUpdate(
  stack: Stack,
  cli: TideCli,
  app: App,
  marker: string,
  runtimeVersion?: string,
) {
  writeMarker(app, marker);
  const out = join(stack.dir, `export-${app.version}-${marker}`);
  await cli.export(app.dir, out, ["android"], runtimeVersion);
  return out;
}

/** Runs `command`, appending its output to `log`; a failure throws with the log's last lines. */
async function run(
  stack: Stack,
  command: string,
  args: readonly string[],
  env: Record<string, string>,
  cwd: string,
  log: string,
) {
  const sink = createWriteStream(log, { flags: "a" });
  const proc = stack.spawn(command, args, env, cwd);
  proc.stdout.pipe(sink, { end: false });
  proc.stderr.pipe(sink, { end: false });
  const [code, signal] = (await once(proc, "close")) as [number | null, NodeJS.Signals | null];
  sink.end();
  await once(sink, "close");
  if (code !== 0) {
    const name = command.split("/").at(-1);
    throw new Error(
      `${name} ${args[0]} ${signal ? `was killed by ${signal}` : `exited ${code}`}:\n${tail(log)}`,
    );
  }
}
