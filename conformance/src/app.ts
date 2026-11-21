// The conformance app: one shared source built per expo-updates version, configured for a stack's Tide and identity.
import { createHash } from "node:crypto";
import { once } from "node:events";
import {
  copyFileSync,
  cpSync,
  createWriteStream,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type { ExpoVersion } from "./options.ts";
import type { Stack } from "./stack.ts";
import type { TideCli } from "./tide-cli.ts";
import { hostEnv } from "./stack.ts";

const APPS = fileURLToPath(new URL("../apps/", import.meta.url));
const RUNTIME_VERSION = "1.0.0";
const CERTIFICATE = "keys/certificate.pem";
const CERTIFICATE_META = "expo.modules.updates.CODE_SIGNING_CERTIFICATE";
const BSDIFF_META = "expo.modules.updates.ENABLE_BSDIFF_PATCH_SUPPORT";

/** One version's app, materialised in a stack's temp dir. */
export interface App {
  readonly version: ExpoVersion;
  readonly dir: string;
  readonly packageName: string;
  readonly channel: string; // One per version, so versions share a stack without sharing a pointer.
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
  };
  const config = {
    expo: {
      name: `Tide conformance ${version}`,
      slug: "tide-conformance",
      version: "1.0.0",
      runtimeVersion: RUNTIME_VERSION,
      android: { package: app.packageName },
      plugins: ["./cleartext.js"],
      updates: {
        url: `${stack.serverUrl}/manifest`,
        requestHeaders: { "expo-channel-name": app.channel },
        // The app checks itself, so a launch never fetches on its own and each step is deterministic.
        checkAutomatically: "NEVER",
        enableBsdiffPatchSupport: true, // Off by default on 55.
        codeSigningCertificate: `./${CERTIFICATE}`,
        codeSigningMetadata: { keyid: stack.identity.keyId, alg: "rsa-v1_5-sha256" },
      },
    },
  };
  writeFileSync(join(dir, "app.json"), `${JSON.stringify(config, null, 2)}\n`);
  writeMarker(app, "unset");
  return app;
}

/** Sets the marker the next build or export of `app` reports. */
export function writeMarker(app: App, marker: string): void {
  writeFileSync(join(app.dir, "marker.js"), `export const MARKER = ${JSON.stringify(marker)};\n`);
}

/**
 * Installs the app's locked dependencies, prebuilds it and runs a clean release build for `abi`, then extracts the
 * embedded update and checks it ships the image, and that the APK carries the run's certificate and bsdiff support.
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
    assets: { packagerHash: string }[];
  };
  // The one image must ship in the build, where register-build finds it by its packager hash.
  const shipped = readdirSync(resDir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) =>
      createHash("md5")
        .update(readFileSync(join(e.parentPath, e.name)))
        .digest("hex"),
    );
  if (assets.length !== 1 || !shipped.includes(assets[0]?.packagerHash ?? "")) {
    throw new Error(`the embedded update does not ship the image asset: ${JSON.stringify(assets)}`);
  }

  const meta = metaData(
    await capture(
      stack,
      aapt2(sdk),
      ["dump", "xmltree", "--file", "AndroidManifest.xml", apk],
      env,
    ),
  );
  const certificate = readFileSync(stack.identity.certificateFile, "utf8");
  if (squash(meta.get(CERTIFICATE_META) ?? "") !== squash(certificate)) {
    throw new Error(`the APK's ${CERTIFICATE_META} is not the run's certificate`);
  }
  if (meta.get(BSDIFF_META) !== "true") throw new Error(`the APK's ${BSDIFF_META} is not true`);
  return {
    apk,
    marker,
    embeddedUpdateId: id.toLowerCase(),
    manifest,
    bundle: join(out, "assets", "index.android.bundle"),
    resDir,
  };
}

/** Exports `app` with `marker` into a new directory under the stack and returns it, for `tide publish --from`. */
export async function exportUpdate(stack: Stack, cli: TideCli, app: App, marker: string) {
  writeMarker(app, marker);
  const out = join(stack.dir, `export-${app.version}-${marker}`);
  await cli.export(app.dir, out, ["android"]);
  return out;
}

/** Returns the `<meta-data>` names and values in `aapt2 dump xmltree` output of an Android manifest. */
export function metaData(xmltree: string): Map<string, string> {
  const meta = new Map<string, string>();
  // aapt2 prints a string value quoted with its raw form after it, and a typed one bare; name sorts before value.
  const entry =
    /E: meta-data[^\n]*\n\s*A: [^\n]*:name\(0x01010003\)="([^"]*)"[^\n]*\n\s*A: [^\n]*:value\(0x01010024\)=(?:"([\s\S]*?)" \(Raw: |(\S+))/g;
  for (const [, name = "", quoted, bare] of xmltree.matchAll(entry)) {
    // aapt2 indents each continuation line of a multi-line value.
    meta.set(name, quoted === undefined ? (bare ?? "") : quoted.replace(/\n[ \t]+/g, "\n"));
  }
  return meta;
}

const squash = (pem: string) => pem.replace(/\s+/g, "");

/** Returns the newest build-tools' aapt2. */
function aapt2(sdk: string): string {
  const tools = join(sdk, "build-tools");
  const versions = readdirSync(tools).sort((a, b) => a.localeCompare(b, "en", { numeric: true }));
  const newest = versions.at(-1);
  if (newest === undefined) throw new Error(`no build-tools in ${tools}`);
  return join(tools, newest, "aapt2");
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
    const tail = readFileSync(log, "utf8").trimEnd().split("\n").slice(-40).join("\n");
    const name = command.split("/").at(-1);
    throw new Error(
      `${name} ${args[0]} ${signal ? `was killed by ${signal}` : `exited ${code}`}:\n${tail}`,
    );
  }
}

/** Runs `command` and returns its stdout; a failure throws with its stderr. */
async function capture(
  stack: Stack,
  command: string,
  args: readonly string[],
  env: Record<string, string>,
) {
  const proc = stack.spawn(command, args, env);
  let stdout = "";
  let stderr = "";
  proc.stdout.setEncoding("utf8").on("data", (s: string) => (stdout += s));
  proc.stderr.setEncoding("utf8").on("data", (s: string) => (stderr += s));
  const [code] = (await once(proc, "close")) as [number | null];
  if (code !== 0) throw new Error(`${command} ${args.join(" ")} exited ${code}: ${stderr.trim()}`);
  return stdout;
}
