// The Android device side of a run: one emulator, reached through adb, that the stack's close leaves as it found it.
import { execFile, spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { createInterface } from "node:readline";

import type { Stack } from "./stack.ts";
import { hostEnv, tail } from "./stack.ts";

// What the app prefixes each report with (apps/shared/App.js); React Native logs it under this tag.
const REPORT_PREFIX = "tide-conformance ";
const JS_TAG = "ReactNativeJS";
const COMMAND_MS = 60_000;
const INSTALL_MS = 180_000;
const BOOT_MS = 600_000;
const SHUTDOWN_MS = 60_000;
// How long a launched app has to report; a cold release start on an emulator takes a few seconds.
const REPORT_MS = 60_000;
// adb finds emulators by themselves only on the even console ports 5554 to 5584.
const FIRST_PORT = 5554;
const LAST_PORT = 5584;

/** One line the app logged: what happened, the build or update marker, and the event's fields. */
export interface Report {
  readonly event: string;
  readonly marker: string;
  readonly [field: string]: unknown;
}

export interface AndroidOptions {
  readonly sdk: string; // ANDROID_HOME
  readonly serial: string | undefined; // ANDROID_SERIAL: which attached device to use.
  readonly avd: string | undefined; // The AVD to boot when no emulator is running; the first listed otherwise.
}

export interface AndroidDevice {
  readonly serial: string;
  readonly abi: string;
  readonly booted: boolean; // Whether the harness started it, and so shuts it down.
  /** Lets the device reach the host's `port` at 127.0.0.1:`port` until the stack closes. */
  reverse(port: number): Promise<void>;
  /** Installs `apk` as a fresh app, removing any earlier install of `packageName` and its data. */
  install(apk: string, packageName: string): Promise<void>;
  launch(packageName: string): Promise<void>;
  forceStop(packageName: string): Promise<void>;
  /** Resolves the next report logged since the last `drain`; rejects when none comes within `ms`. */
  nextReport(ms?: number): Promise<Report>;
  /** Discards the reports read so far. */
  drain(): void;
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
  const abi = (await adb(["shell", "getprop", "ro.product.cpu.abi"])).trim();
  const reports = await readReports(stack, adbPath, serial, adb);
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
    async forceStop(packageName) {
      await adb(["shell", "am", "force-stop", packageName]);
    },
    nextReport: (ms = REPORT_MS) => reports.next(ms),
    drain: () => reports.drain(),
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

/** Returns the report a logcat line carries, or undefined for any other line. */
export function parseReport(line: string): Report | undefined {
  const at = line.indexOf(REPORT_PREFIX);
  if (at === -1) return undefined;
  try {
    const value: unknown = JSON.parse(line.slice(at + REPORT_PREFIX.length));
    if (typeof value !== "object" || value === null) return undefined;
    const { event, marker } = value as Record<string, unknown>;
    return typeof event === "string" && typeof marker === "string" ? (value as Report) : undefined;
  } catch {
    return undefined;
  }
}

const isEmulator = (serial: string) => serial.startsWith("emulator-");

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
  const ready = tool(
    adbPath,
    [
      ...["-s", serial, "wait-for-device", "shell"],
      'while [ "$(getprop sys.boot_completed)" != 1 ]; do sleep 1; done',
    ],
    BOOT_MS,
  );
  const quit = exited.then(() => {
    throw new Error(`the emulator for ${name} exited while booting:\n${tail(logFile)}`);
  });
  quit.catch(() => undefined); // After a boot it rejects only once the emulator stops at close.
  await Promise.race([ready, quit]);
  return serial;
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
async function readReports(
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
  const queue: Report[] = [];
  let wake: (() => void) | undefined;
  let ended = false;
  const lines = createInterface({ input: logcat.stdout });
  lines.on("line", (line) => {
    const report = parseReport(line);
    if (report === undefined) return;
    queue.push(report);
    wake?.();
  });
  lines.once("close", () => {
    ended = true;
    wake?.();
  });
  return {
    drain() {
      queue.length = 0;
    },
    async next(ms: number): Promise<Report> {
      const deadline = AbortSignal.timeout(ms);
      for (;;) {
        const report = queue.shift();
        if (report !== undefined) return report;
        if (ended) throw new Error("adb logcat ended");
        const woken = new Promise<boolean>((resolve) => {
          wake = () => resolve(true);
          deadline.addEventListener("abort", () => resolve(false), { once: true });
        });
        const before = deadline.aborted ? false : await woken;
        wake = undefined;
        if (!before) throw new Error(`the app logged no report within ${ms} ms`);
      }
    },
  };
}

/** Runs a short tool command and returns its stdout; a non-zero exit or the deadline throws with its stderr. */
function tool(file: string, args: readonly string[], ms = COMMAND_MS): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      { encoding: "utf8", env: hostEnv(), timeout: ms, killSignal: "SIGKILL", maxBuffer: 1 << 26 },
      (error, stdout, stderr) => {
        if (error === null) return resolve(stdout);
        const why = error.killed
          ? `took over ${ms} ms`
          : stderr.trim() || stdout.trim() || error.message;
        reject(new Error(`${file.split("/").at(-1)} ${args.join(" ")} failed: ${why}`));
      },
    );
  });
}

/** Resolves true once `promise` settles, or false after `ms`. */
function settles(promise: Promise<unknown>, ms: number): Promise<boolean> {
  const deadline = AbortSignal.timeout(ms);
  return new Promise((resolve) => {
    promise.then(
      () => resolve(true),
      () => resolve(true),
    );
    deadline.addEventListener("abort", () => resolve(false), { once: true });
  });
}
