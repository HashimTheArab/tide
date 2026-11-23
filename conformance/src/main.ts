#!/usr/bin/env node
import type { Run, Scenario } from "./options.ts";
import type { Builds, Driver, Outcome } from "./scenarios.ts";
import { androidDevice } from "./android.ts";
import { buildAndroid, buildIos } from "./app.ts";
import { iosDevice } from "./ios.ts";
import { USAGE, UsageError, parseRun } from "./options.ts";
import { STEPS, message, plan, prepare, runScenarios } from "./scenarios.ts";
import { withStack } from "./stack.ts";

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

const android = (run: Run, sdk: string): Driver => ({
  async open(stack) {
    const device = await androidDevice(stack, {
      sdk,
      serial: process.env.ANDROID_SERIAL === "" ? undefined : process.env.ANDROID_SERIAL,
      avd: run.avd,
    });
    await device.reverse(Number(new URL(stack.serverUrl).port));
    return {
      device,
      about: `${device.serial} (${device.abi}${device.booted ? ", booted read-only" : ""})`,
      build: (app, marker) => buildAndroid(stack, app, sdk, device.abi, marker),
    };
  },
});

const ios = (run: Run): Driver => ({
  async open(stack) {
    const device = await iosDevice(stack, { xcrun: "xcrun", simulator: run.simulator });
    return {
      device,
      about: `${device.name} (${device.udid}${device.booted ? ", booted" : ""})`,
      build: (app, marker) => buildIos(stack, app, device.udid, marker),
    };
  },
});

/**
 * Builds each version's app and runs the scenarios on one device, with a stack per version; prints one line per
 * version and scenario, and returns 1 if any failed or did not run.
 */
async function conform(run: Run, driver: Driver): Promise<number> {
  const names = plan(run.scenarios);
  const failed: string[] = [];
  for (const version of run.versions) {
    const report = (name: Scenario, outcome: Outcome) => {
      const [first, ...rest] = (outcome.pass ? outcome.saw : outcome.why).split("\n");
      const result = outcome.pass ? "pass" : "fail";
      out(`${run.platform} expo-updates ${version} ${name}: ${result}: ${first}`);
      if (rest.length > 0) say(`${version} ${name}:\n${rest.join("\n")}`);
      if (!outcome.pass) failed.push(`${version} ${name}`);
    };
    await withStack(async (stack) => {
      let builds: Builds;
      try {
        builds = await prepare(stack, version, run.platform, driver, say);
      } catch (e) {
        for (const name of names) report(name, { pass: false, why: `not run: ${message(e)}` });
        return;
      }
      await runScenarios(names, (name, running) => STEPS[name].run(builds, running), report);
    });
  }
  return failed.length > 0 ? 1 : 0;
}

process.exitCode = await main(process.argv.slice(2));
