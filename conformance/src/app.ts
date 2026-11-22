// The conformance app: one shared source built per expo-updates version, configured for a stack's Tide and identity.
import { once } from "node:events";
import {
  copyFileSync,
  cpSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type { ExpoVersion, Platform } from "./options.ts";
import type { Stack } from "./stack.ts";
import type { TideCli } from "./tide-cli.ts";
import { hostEnv, tail } from "./stack.ts";

const APPS = fileURLToPath(new URL("../apps/", import.meta.url));
const CERTIFICATE = "keys/certificate.pem";

/** One version's app for one platform, materialised in a stack's temp dir. */
export interface App {
  readonly version: ExpoVersion;
  readonly platform: Platform;
  readonly dir: string;
  readonly appId: string; // The Android package and the iOS bundle identifier.
  readonly channel: string; // One per version, so versions share a stack without sharing a pointer.
  readonly runtimeVersion: string; // One per version: bases and patches are scoped by runtime, and each SDK is its own.
}

/** A release build and what `register-build` reads from it. */
export interface Build {
  readonly artifact: string; // The APK or .app the device installs.
  readonly marker: string;
  readonly embeddedUpdateId: string; // app.manifest's `id`
  readonly manifest: string; // app.manifest
  readonly bundle: string; // index.android.bundle or main.jsbundle
  readonly assetsDir: string; // Holds the embedded assets with the bytes Metro wrote.
}

/** Copies the version's app into the stack's dir and writes its config for the stack's Tide and identity. */
export function materialise(stack: Stack, version: ExpoVersion, platform: Platform): App {
  const dir = join(stack.dir, `app-${version}`);
  cpSync(join(APPS, "shared"), dir, { recursive: true, errorOnExist: true, force: false });
  for (const file of ["package.json", "package-lock.json"]) {
    copyFileSync(join(APPS, `sdk-${version}`, file), join(dir, file));
  }
  mkdirSync(join(dir, "keys"));
  copyFileSync(stack.identity.certificateFile, join(dir, CERTIFICATE));
  const app = {
    version,
    platform,
    dir,
    appId: `dev.tide.conformance.sdk${version}`,
    channel: `expo-${version}`,
    runtimeVersion: `1.0.0-sdk${version}`,
  };
  const config = {
    expo: {
      name: `Tide conformance ${version}`,
      slug: "tide-conformance",
      version: "1.0.0",
      runtimeVersion: app.runtimeVersion,
      android: { package: app.appId },
      ios: { bundleIdentifier: app.appId },
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
): Promise<Build> {
  const step = await prebuild(stack, app, marker, { ANDROID_HOME: sdk });
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
  return embeddedBuild({
    artifact: apk,
    marker,
    manifest: join(out, "assets", "app.manifest"),
    bundle: join(out, "assets", "index.android.bundle"),
    assetsDir: join(android, "app", "build", "generated", "res", "react", "release"),
  });
}

/**
 * Installs the app's locked dependencies, prebuilds it with its pods and runs a Release simulator build for the
 * simulator `udid`'s architecture, then reads the embedded update for `register-build` from the built `.app`.
 */
export async function buildIos(
  stack: Stack,
  app: App,
  udid: string,
  marker: string,
): Promise<Build> {
  // CocoaPods refuses to run without a UTF-8 locale; LC_ALL overrides one the caller set.
  const utf8 = "en_US.UTF-8";
  const step = await prebuild(stack, app, marker, { LANG: utf8, LC_ALL: utf8 });
  const ios = join(app.dir, "ios");
  await step("pod", ["install"], ios);
  const workspace = only(ios, ".xcworkspace");
  const derived = join(app.dir, "derived");
  await step("xcodebuild", [
    "build",
    ...["-workspace", join(ios, workspace), "-scheme", workspace.slice(0, -".xcworkspace".length)],
    ...["-configuration", "Release", "-destination", `id=${udid}`, "-derivedDataPath", derived],
    ...["ONLY_ACTIVE_ARCH=YES", "CODE_SIGNING_ALLOWED=NO"],
  ]);
  const products = join(derived, "Build", "Products", "Release-iphonesimulator");
  const artifact = join(products, only(products, ".app"));
  // The manifest the client loads: EXUpdates.bundle's, beside the statically linked EXUpdates, else the .app's own.
  const bundled = join(artifact, "EXUpdates.bundle", "app.manifest");
  return embeddedBuild({
    artifact,
    marker,
    manifest: existsSync(bundled) ? bundled : join(artifact, "app.manifest"),
    bundle: join(artifact, "main.jsbundle"),
    // Metro's copies: the image is not compiled into an asset catalog.
    assetsDir: join(artifact, "assets"),
  });
}

/**
 * Writes `marker`, installs the app's locked dependencies and prebuilds its native project for its platform; returns
 * a runner for the build's further steps, which log to the same file, with `env` added to the host's.
 */
async function prebuild(stack: Stack, app: App, marker: string, env: Record<string, string>) {
  writeMarker(app, marker);
  const log = join(app.dir, "build.log");
  const all = { ...hostEnv(), ...env, CI: "1" };
  const step = (command: string, args: readonly string[], cwd = app.dir) =>
    run(stack, command, args, all, cwd, log);
  // Install scripts stay off: the app needs none, and they would run every dependency's code.
  await step("npm", ["ci", "--ignore-scripts", "--no-audit", "--no-fund"]);
  await step(join(app.dir, "node_modules", ".bin", "expo"), [
    "prebuild",
    "--platform",
    app.platform,
    "--no-install",
  ]);
  return step;
}

/** Returns the one entry of `dir` whose name ends with `suffix`. */
function only(dir: string, suffix: string): string {
  const found = readdirSync(dir).filter((name) => name.endsWith(suffix));
  if (found.length !== 1) throw new Error(`${dir} holds ${found.length} ${suffix} entries, not 1`);
  return found[0] ?? "";
}

/** Returns `build` with its embedded update ID, after checking that the update ships the app's one image. */
function embeddedBuild(build: Omit<Build, "embeddedUpdateId">): Build {
  const { id, assets } = JSON.parse(readFileSync(build.manifest, "utf8")) as {
    id: string;
    assets: unknown[];
  };
  if (assets.length !== 1) {
    throw new Error(`the embedded update does not ship one image asset: ${JSON.stringify(assets)}`);
  }
  return { ...build, embeddedUpdateId: id.toLowerCase() };
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
  base?: string, // A bundle to delta-compile the launch bundle against.
) {
  writeMarker(app, marker);
  const out = join(stack.dir, `export-${app.version}-${marker}`);
  const bases = base === undefined ? {} : { [app.platform]: base };
  await cli.export(app.dir, out, [app.platform], runtimeVersion, bases);
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
