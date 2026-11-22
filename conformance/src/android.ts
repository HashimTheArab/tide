// The Android device side of a run: one emulator, reached through adb, that the stack's close leaves as it found it.
import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";

import type { Device } from "./device.ts";
import type { Stack } from "./stack.ts";
import {
  BOOT_MS,
  COMMAND_MS,
  INSTALL_MS,
  SHUTDOWN_MS,
  ToolError,
  readReports,
  settles,
  tool,
} from "./device.ts";
import { hostEnv, tail } from "./stack.ts";

// The tag React Native logs the app's console under.
const JS_TAG = "ReactNativeJS";
// adb's exit status when the device's connection drops under a running command.
const DROPPED = 255;
// adb finds emulators by themselves only on the even console ports 5554 to 5584.
const FIRST_PORT = 5554;
const LAST_PORT = 5584;

export interface AndroidOptions {
  readonly sdk: string; // ANDROID_HOME
  readonly serial: string | undefined; // ANDROID_SERIAL: which attached device to use.
  readonly avd: string | undefined; // The AVD to boot when no emulator is running; the first listed otherwise.
}

export interface AndroidDevice extends Device {
  readonly serial: string;
  readonly abi: string;
  readonly booted: boolean; // Whether the harness started it, and so shuts it down.
  /** Lets the device reach the host's `port` at 127.0.0.1:`port` until the stack closes. */
  reverse(port: number): Promise<void>;
}

/**
 * Returns the device a run uses: the running emulator, or `options.avd` booted read-only so that nothing it does
 * persists. The stack's close shuts down only an emulator this call booted. No AVD is ever created or changed.
 */
export async function androidDevice(stack: Stack, options: AndroidOptions): Promise<AndroidDevice> {
  const adbPath = join(options.sdk, "platform-tools", "adb");
  const attached = parseDevices(await tool(adbPath, ["devices"]));
  let serial: string;
  let booted = false;
  if (options.serial !== undefined) {
    if (attached.get(options.serial) !== "device") {
      throw new Error(`ANDROID_SERIAL ${options.serial} is not an attached device`);
    }
    serial = options.serial;
  } else {
    const running = [...attached].filter(([s, state]) => isEmulator(s) && state === "device");
    if (running.length > 1) {
      throw new Error(`${running.length} emulators are running: set ANDROID_SERIAL to pick one`);
    }
    const [first] = running;
    if (first === undefined) {
      serial = await boot(stack, options, adbPath, [...attached.keys()]);
      booted = true;
    } else {
      serial = first[0];
    }
  }
  const adb = (args: readonly string[], ms = COMMAND_MS) =>
    tool(adbPath, ["-s", serial, ...args], ms);
  // Installing uninstalls the app first, so a phone would lose its data. A serial is only a name: ask the device.
  if (!booted && !(await qemu(adb, "ro.boot.qemu")) && !(await qemu(adb, "ro.kernel.qemu"))) {
    throw new Error(`${serial} is not an emulator`);
  }
  const abi = (await adb(["shell", "getprop", "ro.product.cpu.abi"])).trim();
  const reports = await followLog(stack, adbPath, serial, adb);
  return {
    serial,
    abi,
    booted,
    async reverse(port) {
      await adb(["reverse", `tcp:${port}`, `tcp:${port}`]);
      stack.onClose(() => adb(["reverse", "--remove", `tcp:${port}`]).then(() => undefined));
    },
    async install(apk, packageName) {
      const listed = await adb(["shell", "pm", "list", "packages", packageName]);
      if (listed.split(/\r?\n/).some((l) => l.trim() === `package:${packageName}`)) {
        await adb(["uninstall", packageName]);
      }
      await adb(["install", apk], INSTALL_MS);
    },
    async launch(packageName) {
      const out = await adb(["shell", "am", "start", "-W", "-n", `${packageName}/.MainActivity`]);
      if (/^Error/m.test(out)) throw new Error(`launching ${packageName} failed: ${out.trim()}`);
    },
    async stop(packageName) {
      await adb(["shell", "am", "force-stop", packageName]);
    },
    ...reports,
  };
}

/** Returns each `adb devices` serial with its state. */
export function parseDevices(out: string): Map<string, string> {
  const devices = new Map<string, string>();
  for (const line of out.split(/\r?\n/).slice(1)) {
    const [serial, state] = line.trim().split(/\s+/);
    if (serial !== undefined && serial !== "" && state !== undefined) devices.set(serial, state);
  }
  return devices;
}

const isEmulator = (serial: string) => serial.startsWith("emulator-");

/** Whether the device sets `prop`, one of the properties only the emulator's kernel sets, to 1. */
async function qemu(adb: (args: readonly string[]) => Promise<string>, prop: string) {
  return (await adb(["shell", "getprop", prop])).trim() === "1";
}

/** Boots the AVD read-only on a free console port, registers its shutdown and returns its serial once booted. */
async function boot(
  stack: Stack,
  { sdk, avd }: AndroidOptions,
  adbPath: string,
  known: readonly string[],
): Promise<string> {
  const emulator = join(sdk, "emulator", "emulator");
  // Some emulator versions print notices on stdout too; an AVD name has no spaces.
  const avds = (await tool(emulator, ["-list-avds"]))
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => /^[\w.-]+$/.test(l));
  const name = avd ?? avds[0];
  if (name === undefined) {
    throw new Error("no emulator is running and no AVD exists: start an emulator or create an AVD");
  }
  if (!avds.includes(name)) throw new Error(`no AVD is named ${name}; found ${avds.join(", ")}`);
  const port = await freeConsolePort(known);
  const serial = `emulator-${port}`;
  const logFile = join(stack.dir, "emulator.log");
  const log = openSync(logFile, "a");
  // -read-only discards disk writes and -no-snapshot neither loads nor saves one, so the AVD's images stay as they were.
  const proc = spawn(
    emulator,
    [
      ...["-avd", name, "-port", String(port), "-read-only", "-no-snapshot"],
      ...["-no-window", "-no-audio", "-no-boot-anim"],
    ],
    { detached: true, stdio: ["ignore", log, log], env: hostEnv() },
  );
  closeSync(log);
  const exited = new Promise<void>((resolve) => {
    proc.once("exit", () => resolve()).once("error", () => resolve());
  });
  stack.onClose(async () => {
    if (proc.exitCode !== null || proc.signalCode !== null || proc.pid === undefined) return;
    try {
      await tool(adbPath, ["-s", serial, "emu", "kill"]);
    } catch {
      // Killed below.
    }
    if (!(await settles(exited, SHUTDOWN_MS))) {
      process.kill(-proc.pid, "SIGKILL");
      await exited;
    }
  });
  const waiting = new AbortController();
  const ready = waitBooted(adbPath, serial, waiting.signal);
  if (!(await Promise.race([ready.then(() => true), exited.then(() => false)]))) {
    waiting.abort();
    await ready.catch(() => undefined); // Reaps the wait, so nothing outlives the failed boot.
    throw new Error(`the emulator for ${name} exited while booting:\n${tail(logFile)}`);
  }
  return serial;
}

/**
 * Resolves once `serial` reports boot completed, within `BOOT_MS`. A fresh AVD's first boot drops adb's connection
 * once, ending the shell with adb's exit 255; the wait then starts again on the reconnected device.
 */
async function waitBooted(adbPath: string, serial: string, signal: AbortSignal): Promise<void> {
  const deadline = Date.now() + BOOT_MS;
  const args = [
    ...["-s", serial, "wait-for-device", "shell"],
    'while [ "$(getprop sys.boot_completed)" != 1 ]; do sleep 1; done',
  ];
  for (;;) {
    try {
      await tool(adbPath, args, Math.max(deadline - Date.now(), 1), signal);
      return;
    } catch (e) {
      if (!(e instanceof ToolError) || e.exitCode !== DROPPED || Date.now() >= deadline) throw e;
    }
  }
}

/** Returns an even port in adb's emulator range whose console and adb ports are both free. */
async function freeConsolePort(known: readonly string[]): Promise<number> {
  for (let port = FIRST_PORT; port <= LAST_PORT; port += 2) {
    if (known.includes(`emulator-${port}`)) continue;
    if ((await bindable(port)) && (await bindable(port + 1))) return port;
  }
  throw new Error(`no free emulator port from ${FIRST_PORT} to ${LAST_PORT}`);
}

function bindable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => server.close(() => resolve(true)));
  });
}

/** Follows the device's JavaScript log from now on and queues the app's reports. */
async function followLog(
  stack: Stack,
  adbPath: string,
  serial: string,
  adb: (args: readonly string[]) => Promise<string>,
) {
  const since = (await adb(["shell", "date", "+%s"])).trim();
  const logcat = stack.spawn(
    adbPath,
    ["-s", serial, "logcat", "-v", "raw", "-s", `${JS_TAG}:V`, "-T", `${since}.000`],
    hostEnv(),
  );
  logcat.stderr.resume();
  return readReports(logcat.stdout, "adb logcat");
}
