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
  let booted = false;
  if (sim.state !== "Booted") {
    if (sim.state !== "Shutdown") throw new Error(`simulator ${sim.name} is ${sim.state}`);
    // True once simctl finished the boot, or a signal killed it while CoreSimulator may carry on; close waits for it.
    let mayHaveBooted = Promise.resolve(false);
    stack.onClose(async () => {
      if (!(await mayHaveBooted)) return;
      try {
        await simctl(["shutdown", sim.udid], SHUTDOWN_MS);
      } catch (e) {
        // A boot killed before CoreSimulator started it.
        if (!(e instanceof Error && e.message.includes("current state: Shutdown"))) throw e;
      }
    });
    const boot = simctl(["boot", sim.udid], BOOT_MS);
    mayHaveBooted = boot.then(
      () => true,
      (e: unknown) => e instanceof ToolError && e.killed,
    );
    await boot;
    booted = true;
    await simctl(["bootstatus", sim.udid], BOOT_MS);
  }
  const installs = new Map<string, Promise<unknown>>(); // Each app's latest install, which close waits for.
  let closed = false;
  // Registered before the log stream's step, so close ends the stream first, then lets running installs finish.
  stack.onClose(async () => {
    closed = true;
    for (const [bundleId, installing] of installs) {
      await installing.catch(() => undefined);
      await simctl(["uninstall", sim.udid, bundleId]);
    }
  });
  const reports = await followLog(stack, options.xcrun, sim.udid);
  return {
    udid: sim.udid,
    name: sim.name,
    booted,
    install(app, bundleId) {
      if (closed) return Promise.reject(new Error("the stack is closed"));
      const installing = (async () => {
        await simctl(["uninstall", sim.udid, bundleId]);
        await simctl(["install", sim.udid, app], INSTALL_MS);
      })();
      installs.set(bundleId, installing);
      return installing;
    },
    async launch(bundleId) {
      await simctl(["launch", sim.udid, bundleId]);
    },
    async stop(bundleId) {
      try {
        await simctl(["terminate", sim.udid, bundleId]);
      } catch (e) {
        if (!(e instanceof Error && e.message.includes("found nothing to terminate"))) throw e;
      }
    },
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
