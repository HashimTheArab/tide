#!/usr/bin/env node
// `pnpm hermes-delta`: measures Tide's patch sizes for Hermes bundles compiled with and without -base-bytecode.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { arch, cpus, release, type } from "node:os";
import { join } from "node:path";

import type { AppId, ChangeId } from "./apps.ts";
import type { Hermesc } from "./build.ts";
import type { AppResult, ChangeResult, Results } from "./measure.ts";
import { APPS, CHANGES } from "./apps.ts";
import {
  checkout,
  compile,
  embed,
  exportBundle,
  exportJs,
  install,
  openTree,
  reproduces,
  tools,
} from "./build.ts";
import { BASES, KEEP_RULE, TARGETS, describe, measureTargets, renderTable } from "./measure.ts";
import { USAGE, UsageError, parseOptions } from "./options.ts";

const say = (line: string) => process.stderr.write(`hermes-delta: ${line}\n`);

/** Builds every bundle of `id` and returns its measurements. */
async function measureApp(id: AppId, work: string): Promise<AppResult> {
  const tree = await openTree(id, work);
  const pin = APPS[id];
  const step = async (name: string, patches: readonly string[]) => {
    say(`${id}: ${name}`);
    const stat = checkout(tree, patches);
    await install(tree);
    return stat;
  };
  // Every export must run hermesc alike, and the study must compile exactly as it does.
  const exported: Hermesc[] = [];
  const exportState = async (name: string) => {
    const e = await exportBundle(tree, name);
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
  const plainJs = await exportJs(tree, "start-js");
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

  const shapes = new Set(exported.map((h) => JSON.stringify(template(h.args, h, "<tmp>"))));
  if (shapes.size !== 1)
    throw new Error(`expo export ran hermesc with different flags: ${[...shapes].join(" | ")}`);
  const scratch = join(work, "hermesc");
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
      command: ["expo", "export", "--output-dir", "<dir>", "--platform", "android"],
      env: { EXPO_NO_DOTENV: "1", NODE_ENV: "production", BABEL_ENV: "production", ...pin.env },
      hermescArgs: template(start.hermesc.args, start.hermesc, "<tmp>"),
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
      hermescArgs: embedded.hermesc.args,
      flagsFrom: embedded.flagsFrom,
    },
    delta: { hermescArgs: deltaArgs.map((a) => a.replaceAll(scratch, "<work>")) },
    bases: {
      ota: describe(bases.ota),
      embedded: describe(bases.embedded),
      "older-ota": describe(bases["older-ota"]),
    },
    changes: changes as Record<ChangeId, ChangeResult>,
  };
}

/** Returns `args` with the compile's input and output directory written as `dir`. */
function template(args: readonly string[], io: Hermesc, dir: string): string[] {
  return args.map((a) =>
    a === io.input ? `${dir}/index.js` : a === io.out ? `${dir}/index.hbc` : a,
  );
}

/** Returns the results file's apps, or none when it does not exist. */
function previousApps(path: string): readonly AppResult[] {
  if (!existsSync(path)) return [];
  return (JSON.parse(readFileSync(path, "utf8")) as Results).apps;
}

/** Exit 0 for help or a finished run, 2 for a usage error, 1 when a build or measurement fails. */
async function main(args: readonly string[]): Promise<number> {
  let options;
  try {
    options = parseOptions(args, process.cwd());
  } catch (e) {
    if (!(e instanceof UsageError)) throw e;
    say(`${e.message}; see pnpm hermes-delta --help`);
    return 2;
  }
  if (options === "help") {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  const json = join(options.out, "results.json");
  const measured = new Map(previousApps(json).map((a) => [a.id, a]));
  try {
    for (const id of options.apps) measured.set(id, await measureApp(id, options.work));
  } catch (e) {
    say(e instanceof Error ? e.message : String(e));
    return 1;
  }
  const results: Results = {
    schema: 1,
    about:
      "Android bundles. Bases: the embedded bundle and an OTA export of each app's start tree, and an OTA export " +
      "one update later (the OTA base); each change is a patch onto that update. Plain bundles are expo export's " +
      "hermesc command recompiled at a fixed path; delta bundles add -base-bytecode.",
    keepRule: KEEP_RULE,
    bases: BASES,
    targets: TARGETS,
    apps: (Object.keys(APPS) as AppId[]).flatMap((id) => measured.get(id) ?? []),
  };
  mkdirSync(options.out, { recursive: true });
  writeFileSync(json, `${JSON.stringify(results, null, 2)}\n`);
  writeFileSync(join(options.out, "results.md"), renderTable(results));
  say(`wrote ${json} and results.md`);
  return 0;
}

process.exitCode = await main(process.argv.slice(2));
