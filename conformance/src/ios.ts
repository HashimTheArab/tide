// The iOS device side of a run: one simulator, reached through simctl, that the stack's close leaves as it found it.
// The simulator shares the host's network, so the app reaches the local Tide at 127.0.0.1 without a mapping.
import { spawn } from "node:child_process";
import { once } from "node:events";

import type { Device } from "./device.ts";
import type { Stack } from "./stack.ts";
import {
  BOOT_MS,
  COMMAND_MS,
  INSTALL_MS,
  SHUTDOWN_MS,
  readReports,
  ToolError,
  settles,
  tool,
} from "./device.ts";
import { hostEnv } from "./stack.ts";

// Where React Native logs the app's console (RCTLog's os_log), at the info level.
const JS_LOG = 'subsystem == "com.facebook.react.log" AND category == "javascript"';
const IOS_RUNTIME = ".SimRuntime.iOS-";

export interface IosOptions {
  readonly xcrun: string;
  readonly simulator: string | undefined; // --simulator: a name or UDID; the booted one, else the first listed.
}

export interface IosDevice extends Device {
  readonly udid: string;
  readonly name: string;
  readonly booted: boolean; // Whether the harness booted it, and so shuts it down.
}

interface Simulator {
  readonly udid: string;
  readonly name: string;
  readonly state: string;
}

/**
 * Returns the simulator a run uses: the booted one or the one `options.simulator` names, booted if it is shut down.
 * The stack's close uninstalls every app this device installed and shuts down only a simulator this call booted. No
 * simulator is ever created, erased or changed otherwise.
 */
export async function iosDevice(stack: Stack, options: IosOptions): Promise<IosDevice> {
  const simctl = (args: readonly string[], ms = COMMAND_MS) =>
    tool(options.xcrun, ["simctl", ...args], ms);
  const simulators = parseSimulators(await simctl(["list", "devices", "--json"]));
  const sim = pick(simulators, options.simulator);
  const closing = new AbortController(); // Aborted by close; only bootstatus takes it.
  let tail: Promise<unknown> = Promise.resolve();
  // Runs device mutations one at a time, so close never runs beside one; once close starts, refuses the rest.
  const op = <T>(f: () => Promise<T>): Promise<T> => {
    if (closing.signal.aborted) return Promise.reject(new Error("the stack is closed"));
    const p = tail.then(f);
    tail = p.catch(() => undefined);
    return p;
  };
  const apps = new Set<string>();
  let mayBeBooted = false; // This call booted it, or a killed boot that CoreSimulator may carry on.
  // Registered before the log stream's step, so it runs after the stream has ended.
  stack.onClose(async () => {
    closing.abort();
    await tail;
    const errors: unknown[] = [];
    for (const bundleId of apps) {
      try {
        await simctl(["uninstall", sim.udid, bundleId]);
      } catch (e) {
        errors.push(e);
      }
    }
    if (mayBeBooted) {
      try {
        await simctl(["shutdown", sim.udid], SHUTDOWN_MS);
      } catch (e) {
        // A boot killed before CoreSimulator started it.
        if (!(e instanceof Error && e.message.includes("current state: Shutdown"))) errors.push(e);
      }
    }
    if (errors.length > 0) {
      throw new AggregateError(
        errors,
        `simulator ${sim.name} did not clean up: ${errors.join("; ")}`,
      );
    }
  });
  let booted = false;
  if (sim.state !== "Booted") {
    if (sim.state !== "Shutdown") throw new Error(`simulator ${sim.name} is ${sim.state}`);
    await op(async () => {
      try {
        await simctl(["boot", sim.udid], BOOT_MS);
      } catch (e) {
        mayBeBooted = e instanceof ToolError && e.exitCode === null;
        throw e;
      }
      mayBeBooted = true;
    });
    booted = true;
    await op(() =>
      tool(options.xcrun, ["simctl", "bootstatus", sim.udid], BOOT_MS, closing.signal),
    );
  }
  const reports = await followLog(stack, options.xcrun, sim.udid);
  return {
    udid: sim.udid,
    name: sim.name,
    booted,
    install: (app, bundleId) =>
      op(async () => {
        apps.add(bundleId);
        await simctl(["uninstall", sim.udid, bundleId]);
        await simctl(["install", sim.udid, app], INSTALL_MS);
      }),
    launch: (bundleId) =>
      op(async () => {
        await simctl(["launch", sim.udid, bundleId]);
      }),
    stop: (bundleId) =>
      op(async () => {
        try {
          await simctl(["terminate", sim.udid, bundleId]);
        } catch (e) {
          if (!(e instanceof Error && e.message.includes("found nothing to terminate"))) throw e;
        }
      }),
    ...reports,
  };
}

/** Returns every available iOS simulator in `simctl list devices --json` output, in listed order. */
export function parseSimulators(json: string): Simulator[] {
  const { devices } = JSON.parse(json) as {
    devices: Record<string, { udid: string; name: string; state: string; isAvailable: boolean }[]>;
  };
  return Object.entries(devices)
    .filter(([runtime]) => runtime.includes(IOS_RUNTIME))
    .flatMap(([, list]) => list.filter((d) => d.isAvailable))
    .map(({ udid, name, state }) => ({ udid, name, state }));
}

function pick(simulators: readonly Simulator[], wanted: string | undefined): Simulator {
  if (wanted !== undefined) {
    const named = simulators.filter((s) => s.udid === wanted || s.name === wanted);
    const [only, ...more] = named;
    if (only === undefined) {
      const names = simulators.map((s) => s.name).join(", ");
      throw new Error(`no available iOS simulator is named ${wanted}; found ${names}`);
    }
    if (more.length > 0) {
      const udids = named.map((s) => s.udid).join(", ");
      throw new Error(`${named.length} simulators are named ${wanted}: pass a UDID (${udids})`);
    }
    return only;
  }
  const running = simulators.filter((s) => s.state === "Booted");
  if (running.length > 1) {
    throw new Error(`${running.length} simulators are booted: pass --simulator to pick one`);
  }
  const sim = running[0] ?? simulators[0];
  if (sim === undefined) {
    throw new Error("no iOS simulator is booted and none exists: create one in Xcode");
  }
  return sim;
}

/**
 * Follows the simulator's JavaScript log from once it reports it is streaming, and queues the app's reports. The
 * stream runs inside the simulator, so the close step ends it with SIGTERM, which simctl forwards; a SIGKILL would
 * leave it running there.
 */
async function followLog(stack: Stack, xcrun: string, udid: string) {
  const args = ["simctl", "spawn", udid, "log", "stream", "--level", "info", "--style", "compact"];
  // Registered first, so a stack that has closed starts no stream; it runs only after the spawn below.
  stack.onClose(async () => {
    if (stream.exitCode !== null || stream.signalCode !== null || stream.pid === undefined) return;
    stream.kill("SIGTERM");
    if (!(await settles(exited, SHUTDOWN_MS))) {
      stream.kill("SIGKILL");
      await exited;
    }
  });
  const stream = spawn(xcrun, [...args, "--predicate", JS_LOG], {
    stdio: ["ignore", "pipe", "pipe"],
    env: hostEnv(),
  });
  const exited = new Promise<void>((resolve) => {
    stream.once("exit", () => resolve()).once("error", () => resolve());
  });
  let stderr = "";
  stream.stderr.setEncoding("utf8").on("data", (s: string) => (stderr += s));
  const reports = readReports(stream.stdout, "simctl log stream");
  // `log stream` prints a header once it streams; reports logged before then are lost.
  const deadline = AbortSignal.timeout(COMMAND_MS);
  const started = await Promise.race([
    once(stream.stdout, "data").then(() => true),
    exited.then(() => false),
    new Promise<false>((resolve) => {
      deadline.addEventListener("abort", () => resolve(false), { once: true });
    }),
  ]);
  if (!started) throw new Error(`simctl log stream did not start: ${stderr.trim()}`);
  return reports;
}
