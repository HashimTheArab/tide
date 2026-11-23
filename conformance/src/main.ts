#!/usr/bin/env node
import type { Run } from "./options.ts";
import type { Driver } from "./scenarios.ts";
import { androidDevice } from "./android.ts";
import { buildAndroid, buildIos } from "./app.ts";
import { iosDevice } from "./ios.ts";
import { USAGE, UsageError, parseRun } from "./options.ts";
import { conform, message } from "./scenarios.ts";

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
    if (run.platform === "ios") return await conform(run, ios(run), out, say);
    const sdk = process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT;
    if (sdk === undefined || sdk === "") {
      say("set ANDROID_HOME to the Android SDK");
      return 1;
    }
    return await conform(run, android(run, sdk), out, say);
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

process.exitCode = await main(process.argv.slice(2));
