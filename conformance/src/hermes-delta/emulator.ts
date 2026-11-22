// `pnpm hermes-delta --emulator`: whether an update delta-compiled against one OTA update runs on devices that never
// ran that update, from Tide's patches and from the full bundle.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

import { baseKey, contentKey, decodeBaseRecord } from "@tide-ota/protocol";

import type { AndroidDevice } from "../android.ts";
import type { ExpoVersion } from "../options.ts";
import type { Outcome, Target, Update } from "../scenarios.ts";
import type { Stack } from "../stack.ts";
import type { TideCli } from "../tide-cli.ts";
import type { Inspection, Tree } from "./build.ts";
import type { EmulatorApp } from "./options.ts";
import { makeBsdiff } from "../../../packages/cli/src/bsdiff.ts";
import { androidDevice } from "../android.ts";
import { buildAndroid, exportUpdate, materialise, writeMarker } from "../app.ts";
import {
  checkCorruptPatch,
  checkPatch,
  install,
  launch,
  message,
  storePath,
} from "../scenarios.ts";
import { tamperPatch, withStack } from "../stack.ts";
import { tideCli } from "../tide-cli.ts";
import { APPS } from "./apps.ts";
import { applyPatches, compile, exportBundle, exportedBundle, inspect, tools } from "./build.ts";

// The OTA base is the update after previous.patch; the delta-compiled update adds feature.patch on top of it.
const PREVIOUS = "conformance/previous.patch";
const FEATURE = "conformance/feature.patch";
const SEED_RUNTIME = "hermes-delta-seed";

/** The ways a device that never ran the compile base gets the delta-compiled update. */
export const PATHS = {
  "other-ota-patch": "a device on another OTA update applies Tide's patch from that update",
  "other-ota-full":
    "a device on another OTA update gets a tampered patch and falls back to the full bundle",
  "embedded-patch": "a device on the embedded build applies Tide's patch from the embedded bundle",
  "embedded-full":
    "a device on the embedded build gets a tampered patch and falls back to the full bundle",
} as const;
type PathId = keyof typeof PATHS;

/** One delta-compiled launch bundle beside the plain compile of the same JS, each loaded by hermesc alone. */
interface DeltaBundle {
  readonly marker: string;
  readonly delta: { readonly bytes: number; readonly sha256: string; readonly alone: Inspection };
  readonly plain: { readonly bytes: number; readonly sha256: string; readonly alone: Inspection };
  readonly patchFromBase: { readonly plain: number; readonly delta: number }; // makeBsdiff bytes.
}

/** One conformance app's emulator check. */
export interface EmulatorResults {
  readonly schema: 1;
  readonly about: string;
  readonly app: { readonly id: EmulatorApp; readonly title: string; readonly platform: "android" };
  readonly device: { readonly abi: string };
  readonly tools: unknown;
  readonly deltaArgs: readonly string[];
  readonly embeddedBytecodeVersion: number;
  readonly deltas: readonly DeltaBundle[];
  readonly baseRequested: boolean; // Whether any request named the compile base's update or bundle.
  readonly paths: Readonly<Record<PathId, Outcome>>;
}

const ABOUT =
  "Android release build of the conformance app against a local Tide (Node entry, disk store) on an emulator. " +
  "Updates in publish order: older (the start tree), base (previous.patch), delta-1 (feature.patch on base, " +
  "its launch bundle recompiled from Expo's JS and hermesc command with -base-bytecode of base's bundle), " +
  "older-2 (the start tree), delta-2 (as delta-1). No device ever runs base. The embedded build is registered " +
  "before the first publish, so Tide patches from it.";

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/**
 * Builds each app for one emulator and checks every path; writes `emulator-<app>.json` and `.md` under `out` and
 * returns the JSON paths, and whether every path passed with the base never requested.
 */
export async function checkOnEmulator(
  apps: readonly EmulatorApp[],
  avd: string | undefined,
  out: string,
  say: (line: string) => void,
): Promise<{ written: string[]; passed: boolean }> {
  const sdk = process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT;
  if (sdk === undefined || sdk === "") throw new Error("set ANDROID_HOME to the Android SDK");
  const serial = process.env.ANDROID_SERIAL === "" ? undefined : process.env.ANDROID_SERIAL;
  return withStack(async (stack) => {
    const cli = tideCli(stack);
    const device = await androidDevice(stack, { sdk, serial, avd });
    await device.reverse(Number(new URL(stack.serverUrl).port));
    say(`using ${device.serial} (${device.abi}${device.booted ? ", booted read-only" : ""})`);
    const written: string[] = [];
    let passed = true;
    for (const id of apps) {
      const results = await checkApp(stack, cli, device, sdk, id, say);
      written.push(writeEmulatorResults(out, results));
      passed &&= !results.baseRequested && Object.values(results.paths).every((o) => o.pass);
    }
    return { written, passed };
  });
}

async function checkApp(
  stack: Stack,
  cli: TideCli,
  device: AndroidDevice,
  sdk: string,
  id: EmulatorApp,
  say: (line: string) => void,
): Promise<EmulatorResults> {
  const version = id.slice("sdk-".length) as ExpoVersion;
  const app = materialise(stack, version, "android");
  say(`${id}: building the release app`);
  const build = await buildAndroid(stack, app, sdk, device.abi, `embedded-${version}`);
  const t: Target = { stack, device, cli, app, build };
  const work = join(stack.dir, `hermes-delta-${version}`);
  mkdirSync(join(work, "tmp"), { recursive: true });
  const tree: Tree = {
    pin: APPS[id],
    dir: app.dir,
    work,
    log: join(work, "log.txt"),
    tmp: join(work, "tmp"),
  };
  const about = tools(tree);
  // register-build needs the identity a publish leaves; the seed's own runtime keeps it out of the app's bases.
  await cli.publish(await exportUpdate(stack, cli, app, `seed-${version}`, SEED_RUNTIME), "seed");
  await cli.registerBuild({
    platform: "android",
    runtimeVersion: app.runtimeVersion,
    manifest: build.manifest,
    bundle: build.bundle,
    assetsDir: build.assetsDir,
  });

  const paths = new Map<PathId, Outcome>();
  const check = async (path: PathId, from: Update, to: Update, run: () => Promise<void>) => {
    say(`${id}: ${path}`);
    try {
      await run();
      paths.set(path, { pass: true, saw: `${to.marker} ran on a device on ${from.marker}` });
    } catch (e) {
      paths.set(path, { pass: false, why: message(e) });
    }
  };
  const deltas: DeltaBundle[] = [];
  let deltaArgs: readonly string[] = [];
  let base: Published | undefined;
  try {
    const older = await publish(t, `older-${version}`);
    const e = await install(t);
    await checkPatch(t, e, older.update, await launch(t));
    base = await withPatches(tree, [PREVIOUS], () => publish(t, `base-${version}`));
    const delta1 = await publishDelta(t, tree, `delta-${version}-1`, base);
    deltas.push(delta1.facts);
    deltaArgs = delta1.args;
    await check("other-ota-patch", older.update, delta1.update, async () =>
      checkPatch(t, older.update, delta1.update, await launch(t)),
    );

    const older2 = await publish(t, `older-${version}-2`);
    await checkPatch(t, await install(t), older2.update, await launch(t));
    const delta2 = await publishDelta(t, tree, `delta-${version}-2`, base);
    deltas.push(delta2.facts);
    await check("other-ota-full", older2.update, delta2.update, async () => {
      const intact = tamperPatch(stack.storeDir, older2.update.hex, delta2.update.hex);
      await checkCorruptPatch(t, older2.update, delta2.update, await launch(t), intact);
    });
    await check("embedded-patch", e, delta2.update, async () => {
      await install(t);
      await checkPatch(t, e, delta2.update, await launch(t));
    });
    await check("embedded-full", e, delta2.update, async () => {
      await install(t);
      const intact = tamperPatch(stack.storeDir, e.hex, delta2.update.hex);
      await checkCorruptPatch(t, e, delta2.update, await launch(t), intact);
    });
  } catch (e) {
    for (const path of Object.keys(PATHS) as PathId[]) {
      if (!paths.has(path)) paths.set(path, { pass: false, why: `not run: ${message(e)}` });
    }
  }
  const baseId = base?.update.updateId;
  const baseBundle = base === undefined ? undefined : `/bundles/${base.update.hex}`;
  return {
    schema: 1,
    about: ABOUT,
    app: { id, title: APPS[id].title, platform: "android" },
    device: { abi: device.abi },
    tools: { ...about.versions, hermesc: about.hermesc, hermesRuntime: hermesRuntime(app.dir) },
    deltaArgs,
    embeddedBytecodeVersion: (await inspect(tree, readFileSync(build.bundle))).bytecodeVersion,
    deltas,
    baseRequested: stack.responses.some(
      (r) =>
        r.path === baseBundle ||
        (baseId !== undefined && (r.currentUpdateId === baseId || r.baseUpdateId === baseId)),
    ),
    paths: Object.fromEntries(
      (Object.keys(PATHS) as PathId[]).map((p) => [p, paths.get(p)]),
    ) as Record<PathId, Outcome>,
  };
}

interface Published {
  readonly update: Update;
  readonly bundle: Uint8Array<ArrayBuffer>; // The launch bundle as published.
}

/** Applies `patches` to the tree for the length of `fn`. */
async function withPatches<T>(tree: Tree, patches: readonly string[], fn: () => Promise<T>) {
  applyPatches(tree, patches);
  try {
    return await fn();
  } finally {
    applyPatches(tree, patches.toReversed(), true);
  }
}

/**
 * Exports the app with `marker`, replaces its launch bundle with `bundle` when given, and publishes it; returns the
 * update as stored, after checking that its launch asset is that bundle.
 */
async function publish(t: Target, marker: string, bundle?: Uint8Array): Promise<Published> {
  const out = await exportUpdate(t.stack, t.cli, t.app, marker);
  const dist = join(out, "dist");
  const path = join(dist, exportedBundle(dist));
  if (bundle !== undefined) writeFileSync(path, bundle);
  const stored = new Uint8Array(readFileSync(path));
  const updateId = (await t.cli.publish(out, t.app.channel)).android;
  if (updateId === undefined)
    throw new Error(`tide publish wrote no android pointer for ${marker}`);
  const record = decodeBaseRecord(readFileSync(storePath(t, baseKey(updateId))));
  const hex = contentKey(record.launchAsset.hash);
  if (hex !== sha256(stored)) throw new Error(`${marker} was stored with another launch bundle`);
  return { update: { updateId, marker, hex, embedded: false }, bundle: stored };
}

/**
 * Publishes the feature update with its launch bundle delta-compiled against `base`: Expo's JS and hermesc command
 * for the same tree, compiled plain and with -base-bytecode on fixed names; refuses a delta equal to the plain compile.
 */
async function publishDelta(t: Target, tree: Tree, marker: string, base: Published) {
  return withPatches(tree, [PREVIOUS, FEATURE], async () => {
    writeMarker(t.app, marker);
    const exported = await exportBundle(tree);
    const plain = await compile(tree, exported.hermesc, exported.js);
    const delta = await compile(tree, exported.hermesc, exported.js, base.bundle);
    if (Buffer.from(delta.hbc).equals(plain.hbc)) {
      throw new Error(`-base-bytecode changed nothing in ${marker}'s bundle`);
    }
    const facts: DeltaBundle = {
      marker,
      delta: {
        bytes: delta.hbc.length,
        sha256: sha256(delta.hbc),
        alone: await inspect(tree, delta.hbc),
      },
      plain: {
        bytes: plain.hbc.length,
        sha256: sha256(plain.hbc),
        alone: await inspect(tree, plain.hbc),
      },
      patchFromBase: {
        plain: makeBsdiff(base.bundle, plain.hbc).length,
        delta: makeBsdiff(base.bundle, delta.hbc).length,
      },
    };
    return { ...(await publish(t, marker, delta.hbc)), facts, args: delta.args };
  });
}

/** Returns the Hermes release react-native builds the app's runtime from. */
function hermesRuntime(appDir: string): { release: string; from: string } {
  const rn = dirname(
    createRequire(join(appDir, "package.json")).resolve("react-native/package.json"),
  );
  const from = "react-native/sdks/hermes-engine/version.properties HERMES_VERSION_NAME";
  const text = readFileSync(join(rn, "sdks", "hermes-engine", "version.properties"), "utf8");
  const release = /^HERMES_VERSION_NAME=(\S+)$/m.exec(text)?.[1];
  if (release === undefined) throw new Error(`no HERMES_VERSION_NAME in ${from}`);
  return { release, from };
}

/** Writes `results` to `emulator-<app id>.json` and its Markdown to `.md` under `out`; returns the JSON path. */
export function writeEmulatorResults(out: string, results: EmulatorResults): string {
  mkdirSync(out, { recursive: true });
  const json = join(out, `emulator-${results.app.id}.json`);
  writeFileSync(json, `${JSON.stringify(results, null, 2)}\n`);
  writeFileSync(join(out, `emulator-${results.app.id}.md`), renderEmulator(results));
  return json;
}

const n = (x: number) => x.toLocaleString("en-US");

/** Returns an app's emulator check as Markdown: one row per path, then each delta bundle beside its plain compile. */
export function renderEmulator(results: EmulatorResults): string {
  const { app } = results;
  const lines = [
    `# Hermes delta compiles on an emulator: ${app.title}`,
    "",
    `Generated by \`pnpm hermes-delta --emulator\` from the JSON file of the same name beside this file. ${results.about}`,
    "",
    `Device ABI ${results.device.abi}. Delta hermesc arguments: \`${results.deltaArgs.join(" ")}\`. ` +
      `Bytecode version of the embedded bundle ${results.embeddedBytecodeVersion}. ` +
      `A request for the base's update or bundle: ${results.baseRequested ? "yes" : "none"}.`,
    "",
    "| Path | Result |",
    "| --- | --- |",
    ...(Object.keys(PATHS) as PathId[]).map((p) => {
      const o = results.paths[p];
      return `| ${PATHS[p]} | ${o.pass ? `pass: ${o.saw}` : `fail: ${o.why.split("\n")[0]}`} |`;
    }),
    "",
    "Each delta bundle and the plain compile of the same JS, as `hermesc -b -dump-bytecode` reads each file alone, " +
      "and the makeBsdiff patch to each from the base's bundle:",
    "",
    "| Update | Bundle | Bytes | Bytecode version | Functions | Strings | Patch from base |",
    "| --- | --- | --- | --- | --- | --- | --- |",
  ];
  for (const d of results.deltas) {
    for (const kind of ["plain", "delta"] as const) {
      const b = d[kind];
      lines.push(
        `| ${d.marker} | ${kind} | ${n(b.bytes)} | ${b.alone.bytecodeVersion} | ${n(b.alone.functions)} | ` +
          `${n(b.alone.strings)} | ${n(d.patchFromBase[kind])} |`,
      );
    }
  }
  lines.push("");
  return lines.join("\n");
}
