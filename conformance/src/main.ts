#!/usr/bin/env node
import { randomUUID } from "node:crypto";

import type { ExpoVersion, Run, Scenario } from "./options.ts";
import type { Outcome, Target } from "./scenarios.ts";
import { androidDevice } from "./android.ts";
import { buildAndroid, exportUpdate, materialise } from "./app.ts";
import { USAGE, UsageError, parseRun } from "./options.ts";
import { STEPS, plan, runScenarios } from "./scenarios.ts";
import { withStack } from "./stack.ts";
import { tideCli } from "./tide-cli.ts";

// The seed's own runtime keeps it out of every tested runtime's patch bases.
const SEED_RUNTIME = "conformance-seed";

const out = (line: string) => process.stdout.write(`${line}\n`);
const say = (line: string) => process.stderr.write(`conformance: ${line}\n`);
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Exit 0 for help or a run that passed, 2 for a usage error before anything starts, 1 when the run fails. */
async function main(args: readonly string[]): Promise<number> {
  let run;
  try {
    run = parseRun(args);
  } catch (e) {
    if (!(e instanceof UsageError)) throw e;
    say(`${e.message}; see pnpm conformance --help`);
    return 2;
  }
  if (run === "help") {
    out(USAGE);
    return 0;
  }
  if (run.platform === "ios") {
    say("no ios device driver exists yet");
    return 1;
  }
  const sdk = process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT;
  if (sdk === undefined || sdk === "") {
    say("set ANDROID_HOME to the Android SDK");
    return 1;
  }
  try {
    return await android(run, sdk);
  } catch (e) {
    say(message(e));
    return 1;
  }
}

/**
 * Builds each version's app and runs the scenarios on one device, printing one line per version and scenario;
 * returns 1 if any failed or did not run.
 */
async function android(run: Run, sdk: string): Promise<number> {
  const names = plan(run.scenarios);
  const failed: string[] = [];
  const report = (version: ExpoVersion, name: Scenario, outcome: Outcome) => {
    const [first, ...rest] = (outcome.pass ? outcome.saw : outcome.why).split("\n");
    out(`android expo-updates ${version} ${name}: ${outcome.pass ? "pass" : "fail"}: ${first}`);
    if (rest.length > 0) say(`${version} ${name}:\n${rest.join("\n")}`);
    if (!outcome.pass) failed.push(`${version} ${name}`);
  };
  const notRun = (versions: readonly ExpoVersion[], e: unknown) => {
    for (const version of versions) {
      for (const name of names)
        report(version, name, { pass: false, why: `not run: ${message(e)}` });
    }
  };
  await withStack(async (stack) => {
    const cli = tideCli(stack);
    let device;
    try {
      device = await androidDevice(stack, {
        sdk,
        serial: process.env.ANDROID_SERIAL === "" ? undefined : process.env.ANDROID_SERIAL,
        avd: run.avd,
      });
      say(`using ${device.serial} (${device.abi}${device.booted ? ", booted read-only" : ""})`);
      await device.reverse(Number(new URL(stack.serverUrl).port));
    } catch (e) {
      return notRun(run.versions, e);
    }
    let seeded = false;
    for (const [i, version] of run.versions.entries()) {
      let target: Target;
      try {
        const app = materialise(stack, version);
        say(`building the expo-updates ${version} release APK`);
        const marker = `embedded-${version}-${randomUUID().slice(0, 8)}`;
        const build = await buildAndroid(stack, app, sdk, device.abi, marker);
        target = { stack, device, cli, app, build };
      } catch (e) {
        notRun([version], e);
        continue;
      }
      if (!seeded) {
        // The bucket serves no-update and the identity only once something is published.
        try {
          const from = await exportUpdate(stack, cli, target.app, "seed", SEED_RUNTIME);
          await cli.publish(from, "seed");
          seeded = true;
        } catch (e) {
          return notRun(run.versions.slice(i), e);
        }
      }
      await runScenarios(
        names,
        (name, running) => STEPS[name].run(target, running),
        (name, outcome) => report(version, name, outcome),
      );
    }
  });
  return failed.length > 0 ? 1 : 0;
}

process.exitCode = await main(process.argv.slice(2));
