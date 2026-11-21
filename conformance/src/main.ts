#!/usr/bin/env node
import { randomUUID } from "node:crypto";

import type { Run } from "./options.ts";
import { androidDevice } from "./android.ts";
import { buildAndroid, exportUpdate, materialise } from "./app.ts";
import { USAGE, UsageError, parseRun } from "./options.ts";
import { STEPS } from "./scenarios.ts";
import { withStack } from "./stack.ts";
import { tideCli } from "./tide-cli.ts";

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
  if (run.platform === "ios") {
    say("no ios device driver exists yet");
    return 1;
  }
  const missing = run.scenarios.filter((s) => STEPS[s] === undefined);
  if (missing.length > 0) {
    say(`no ${missing.join(", ")} scenario exists yet; run --scenario embedded`);
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
    say(e instanceof Error ? e.message : String(e));
    return 1;
  }
}

/** Builds and installs each version's app on one device, then runs the scenarios; returns 1 if any failed. */
async function android(run: Run, sdk: string): Promise<number> {
  const failed: string[] = [];
  await withStack(async (stack) => {
    const cli = tideCli(stack);
    const device = await androidDevice(stack, {
      sdk,
      serial: process.env.ANDROID_SERIAL === "" ? undefined : process.env.ANDROID_SERIAL,
      avd: run.avd,
    });
    say(`using ${device.serial} (${device.abi}${device.booted ? ", booted read-only" : ""})`);
    await device.reverse(Number(new URL(stack.serverUrl).port));
    let seeded = false;
    for (const version of run.versions) {
      const app = materialise(stack, version);
      say(`building the expo-updates ${version} release APK`);
      const marker = `embedded-${version}-${randomUUID().slice(0, 8)}`;
      const build = await buildAndroid(stack, app, sdk, device.abi, marker);
      if (!seeded) {
        // The bucket serves no-update and the identity only once something is published; this goes to another channel.
        await cli.publish(await exportUpdate(stack, cli, app, "seed"), "seed");
        seeded = true;
      }
      await device.install(build.apk, app.packageName);
      for (const scenario of run.scenarios) {
        const name = `android expo-updates ${version} ${scenario}`;
        try {
          const saw = await STEPS[scenario]?.({ stack, device, app, build });
          out(`${name}: pass: ${saw}`);
        } catch (e) {
          failed.push(name);
          out(`${name}: fail: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    }
  });
  return failed.length > 0 ? 1 : 0;
}

process.exitCode = await main(process.argv.slice(2));
