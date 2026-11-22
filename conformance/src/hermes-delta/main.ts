#!/usr/bin/env node
// `pnpm hermes-delta`: measures Tide's patch sizes for Hermes bundles compiled with and without -base-bytecode.
import { arch, cpus, release, type } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type { AppId, ChangeId } from "./apps.ts";
import type { Hermesc } from "./build.ts";
import type { AppResult, ChangeResult } from "./measure.ts";
import { APPS, CHANGES } from "./apps.ts";
import {
  EXPORT_ENV,
  checkout,
  compile,
  embed,
  exportArgs,
  exportBundle,
  exportJs,
  install,
  openTree,
  reproduces,
  retarget,
  tools,
} from "./build.ts";
import { BASES, KEEP_RULE, TARGETS, describe, measureTargets, writeResults } from "./measure.ts";
import { USAGE, UsageError, parseOptions } from "./options.ts";

const OUT = fileURLToPath(new URL("../../../docs/assets/hermes-delta/", import.meta.url));
// Gitignored and owned by this script, which deletes and rebuilds what is under it.
const WORK = join(fileURLToPath(new URL("../../../", import.meta.url)), ".cache", "hermes-delta");

const say = (line: string) => process.stderr.write(`hermes-delta: ${line}\n`);

/** Builds every bundle of `id` and returns its measurements. */
async function measureApp(id: AppId, work: string): Promise<AppResult> {
  const pin = APPS[id];
  const tree = await openTree(id, pin, work);
  const step = async (name: string, patches: readonly string[]) => {
    say(`${id}: ${name}`);
    const stat = checkout(tree, patches);
    await install(tree);
    return stat;
  };
  // Every export must run hermesc alike, and the study must compile exactly as it does.
  const exported: Hermesc[] = [];
  const exportState = async (name: string) => {
    const e = await exportBundle(tree);
    if (!(await reproduces(tree, e.hermesc, e.js, e.hbc))) {
      throw new Error(
        `recompiling the ${name} export's JS with its hermesc command gave other bytes`,
      );
    }
    exported.push(e.hermesc);
    return e;
  };

  await step("start tree: embedded and older OTA bases", []);
  const about = tools(tree);
  const embedded = await embed(tree);
  const start = await exportState("start");
  const plainJs = await exportJs(tree);
  const noBytecode = Buffer.from(plainJs).equals(start.js);
  const older = await compile(tree, start.hermesc, start.js);

  await step("previous update: OTA base", [pin.patches.previous]);
  const previous = await exportState("previous");
  const ota = await compile(tree, previous.hermesc, previous.js);
  const bases = { ota: ota.hbc, embedded: embedded.hbc, "older-ota": older.hbc };

  const changes: Partial<Record<ChangeId, ChangeResult>> = {};
  let deltaArgs: string[] = [];
  for (const change of Object.keys(CHANGES) as ChangeId[]) {
    const patch = pin.patches[change];
    const stat = await step(`${change} change`, [pin.patches.previous, patch]);
    const target = await exportState(change);
    const plain = await compile(tree, target.hermesc, target.js);
    const deltaOta = await compile(tree, target.hermesc, target.js, ota.hbc);
    const deltaEmbedded = await compile(tree, target.hermesc, target.js, embedded.hbc);
    deltaArgs = deltaOta.args;
    say(`${id}: measuring ${change}`);
    const targets = await measureTargets(bases, {
      plain: plain.hbc,
      "delta-ota": deltaOta.hbc,
      "delta-embedded": deltaEmbedded.hbc,
    });
    changes[change] = { patch, ...stat, targets };
  }

  const shapes = new Set(
    exported.map((h) => JSON.stringify(retarget(h, "<tmp>/index.js", "<tmp>/index.hbc"))),
  );
  if (shapes.size !== 1)
    throw new Error(`expo export ran hermesc with different flags: ${[...shapes].join(" | ")}`);
  return {
    id,
    title: pin.title,
    source:
      pin.source.kind === "tide"
        ? {
            repository: "this repository",
            commit: pin.source.commit,
            paths: "conformance/apps/shared, package files",
          }
        : { repository: pin.source.url, commit: pin.source.commit },
    platform: "android",
    machine: {
      os: `${type()} ${release()}`,
      arch: arch(),
      cpu: cpus()[0]?.model ?? "unknown",
      node: process.version,
    },
    tools: { ...about.versions, hermesc: about.hermesc },
    export: {
      command: ["expo", ...exportArgs("<dir>")],
      env: { ...EXPORT_ENV, ...pin.env },
      hermescArgs: retarget(start.hermesc, "<tmp>/index.js", "<tmp>/index.hbc"),
      hermescTempDir:
        "<tmpdir>/expo-bundler-<Math.random()>-<Date.now()>, removed after the compile",
      reproducesExport: true,
      // hermesc embeds the input's path, so the temp dir's name alone changes every export's bytes.
      bytesDependOnTempPath: !Buffer.from(older.hbc).equals(start.hbc),
      noBytecodeJsIsHermescInput: noBytecode,
      noBytecodeJsBytes: plainJs.length,
      hermescInputBytes: start.js.length,
      serializer: about.serializer,
      hook:
        `${about.serializer.compile} passes hermesc no caller arguments, so -base-bytecode needs one of two ` +
        "seams: a hermesc under REACT_NATIVE_OVERRIDE_HERMES_DIR that appends it (how this study captures each " +
        "compile), or expo export --no-bytecode followed by Tide's own hermesc run with Expo's flags on the JS " +
        "bundle it writes" +
        (noBytecode
          ? "; the --no-bytecode JS is byte-identical to what Expo compiles"
          : "; the --no-bytecode JS differs from what Expo compiles"),
    },
    embedded: {
      bundleCommand: embedded.bundleCommand.map((a) => a.replace(tree.dir, "<app>")),
      hermescArgs: embedded.hermescArgs,
      flagsFrom: embedded.flagsFrom,
    },
    delta: { hermescArgs: deltaArgs },
    bases: {
      ota: describe(bases.ota),
      embedded: describe(bases.embedded),
      "older-ota": describe(bases["older-ota"]),
    },
    changes: changes as Record<ChangeId, ChangeResult>,
  };
}

/** Exit 0 for help or a finished run, 2 for a usage error, 1 when a build or measurement fails. */
async function main(args: readonly string[]): Promise<number> {
  let options;
  try {
    options = parseOptions(args);
  } catch (e) {
    if (!(e instanceof UsageError)) throw e;
    say(`${e.message}; see pnpm hermes-delta --help`);
    return 2;
  }
  if (options === "help") {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  try {
    for (const id of options.apps) {
      const app = await measureApp(id, WORK);
      const json = writeResults(OUT, {
        schema: 2,
        about:
          "Android bundles. Bases: the embedded bundle and an OTA export of the app's start tree, and an OTA export " +
          "one update later (the OTA base); each change is a patch onto that update. Plain bundles are expo " +
          "export's hermesc command recompiled on fixed relative names; delta bundles add -base-bytecode.",
        keepRule: KEEP_RULE,
        bases: BASES,
        targets: TARGETS,
        app,
      });
      say(`wrote ${json} and its table`);
    }
  } catch (e) {
    say(e instanceof Error ? e.message : String(e));
    return 1;
  }
  return 0;
}

process.exitCode = await main(process.argv.slice(2));
