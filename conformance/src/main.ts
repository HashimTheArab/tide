#!/usr/bin/env node
import { randomUUID } from "node:crypto";

import type { AndroidDevice } from "./android.ts";
import type { App, Build } from "./app.ts";
import type { Device } from "./device.ts";
import type { IosDevice } from "./ios.ts";
import type { ExpoVersion, Run, Scenario } from "./options.ts";
import type { Outcome, Target } from "./scenarios.ts";
import type { Stack } from "./stack.ts";
import { androidDevice } from "./android.ts";
import { buildAndroid, buildIos, exportUpdate, materialise } from "./app.ts";
import { iosDevice } from "./ios.ts";
import { USAGE, UsageError, parseRun } from "./options.ts";
import { STEPS, message, plan, runScenarios } from "./scenarios.ts";
import { withStack } from "./stack.ts";
import { tideCli } from "./tide-cli.ts";

// The seed's own runtime keeps it out of every tested runtime's patch bases.
const SEED_RUNTIME = "conformance-seed";

const out = (line: string) => process.stdout.write(`${line}\n`);
const say = (line: string) => process.stderr.write(`conformance: ${line}\n`);

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
  try {
    if (run.platform === "ios") return await conform(run, ios(run));
    const sdk = process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT;
    if (sdk === undefined || sdk === "") {
      say("set ANDROID_HOME to the Android SDK");
      return 1;
    }
    return await conform(run, android(run, sdk));
  } catch (e) {
    say(message(e));
    return 1;
  }
}

/** How a run reaches one platform's device and builds its app. */
interface Driver<D extends Device> {
  /** Returns the run's device, reaching the stack's Tide at 127.0.0.1, and a line naming it. */
  open(stack: Stack): Promise<{ device: D; about: string }>;
  build(stack: Stack, app: App, device: D, marker: string): Promise<Build>;
}

const android = (run: Run, sdk: string): Driver<AndroidDevice> => ({
  async open(stack) {
    const device = await androidDevice(stack, {
      sdk,
      serial: process.env.ANDROID_SERIAL === "" ? undefined : process.env.ANDROID_SERIAL,
      avd: run.avd,
    });
    await device.reverse(Number(new URL(stack.serverUrl).port));
    const about = `${device.serial} (${device.abi}${device.booted ? ", booted read-only" : ""})`;
    return { device, about };
  },
  build: (stack, app, device, marker) => buildAndroid(stack, app, sdk, device.abi, marker),
});

const ios = (run: Run): Driver<IosDevice> => ({
  async open(stack) {
    const device = await iosDevice(stack, { xcrun: "xcrun", simulator: run.simulator });
    return { device, about: `${device.name} (${device.udid}${device.booted ? ", booted" : ""})` };
  },
  build: (stack, app, device, marker) => buildIos(stack, app, device.udid, marker),
});

/**
 * Builds each version's app and runs the scenarios on one device, printing one line per version and scenario;
 * returns 1 if any failed or did not run.
 */
async function conform<D extends Device>(run: Run, driver: Driver<D>): Promise<number> {
  const names = plan(run.scenarios);
  const failed: string[] = [];
  const report = (version: ExpoVersion, name: Scenario, outcome: Outcome) => {
    const [first, ...rest] = (outcome.pass ? outcome.saw : outcome.why).split("\n");
    const result = outcome.pass ? "pass" : "fail";
    out(`${run.platform} expo-updates ${version} ${name}: ${result}: ${first}`);
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
    let device: D;
    try {
      let about;
      ({ device, about } = await driver.open(stack));
      say(`using ${about}`);
    } catch (e) {
      return notRun(run.versions, e);
    }
    let seeded = false;
    for (const [i, version] of run.versions.entries()) {
      let target: Target;
      try {
        const app = materialise(stack, version, run.platform);
        say(`building the expo-updates ${version} release ${run.platform} app`);
        const marker = `embedded-${version}-${randomUUID().slice(0, 8)}`;
        const build = await driver.build(stack, app, device, marker);
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
