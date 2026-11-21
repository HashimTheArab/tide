// What every device driver gives the scenarios, and the pieces the Android and iOS drivers share.
import { execFile } from "node:child_process";
import { createInterface } from "node:readline";
import type { Readable } from "node:stream";

import { hostEnv } from "./stack.ts";

// What the app prefixes each report with (apps/shared/App.js).
const REPORT_PREFIX = "tide-conformance ";
export const COMMAND_MS = 60_000;
export const INSTALL_MS = 180_000;
export const BOOT_MS = 600_000;
export const SHUTDOWN_MS = 60_000;
// How long a launched app has to report; a cold release start on an emulator takes a few seconds.
const REPORT_MS = 60_000;

/** One line the app logged: what happened, the build or update marker, and the event's fields. */
export interface Report {
  readonly event: string;
  readonly marker: string;
  readonly [field: string]: unknown;
}

/** One emulator or simulator as the scenarios drive it; `appId` is the Android package or iOS bundle identifier. */
export interface Device {
  /** Installs `artifact` as a fresh app, removing any earlier install of `appId` and its data. */
  install(artifact: string, appId: string): Promise<void>;
  launch(appId: string): Promise<void>;
  /** Ends the app's process; an app that is not running is not an error. */
  stop(appId: string): Promise<void>;
  /** Resolves the next report logged since the last `drain`; rejects when none comes within `ms`. */
  nextReport(ms?: number): Promise<Report>;
  /** Discards the reports read so far. */
  drain(): void;
}

/** Returns the report a log line carries, or undefined for any other line. */
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

/** Queues the reports in the lines of `log`, a device log that `name` follows. */
export function readReports(log: Readable, name: string): Pick<Device, "nextReport" | "drain"> {
  const queue: Report[] = [];
  let wake: (() => void) | undefined;
  let ended = false;
  const lines = createInterface({ input: log });
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
    async nextReport(ms = REPORT_MS): Promise<Report> {
      const deadline = AbortSignal.timeout(ms);
      for (;;) {
        const report = queue.shift();
        if (report !== undefined) return report;
        if (ended) throw new Error(`${name} ended`);
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

/**
 * Runs a tool command and returns its stdout; a non-zero exit, the deadline or `signal` throws, once the command has
 * exited.
 */
export function tool(
  file: string,
  args: readonly string[],
  ms = COMMAND_MS,
  signal?: AbortSignal,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      file,
      args,
      {
        encoding: "utf8",
        env: hostEnv(),
        timeout: ms,
        signal,
        killSignal: "SIGKILL",
        maxBuffer: 1 << 26,
      },
      (error, stdout, stderr) => {
        if (error === null) return resolve(stdout);
        const why = signal?.aborted
          ? "was cancelled"
          : error.killed
            ? `took over ${ms} ms`
            : stderr.trim() || stdout.trim() || error.message;
        const failed = () =>
          reject(new Error(`${file.split("/").at(-1)} ${args.join(" ")} failed: ${why}`));
        // A cancel reports before the killed command exits.
        if (child.exitCode === null && child.signalCode === null) child.once("exit", failed);
        else failed();
      },
    );
  });
}

/** Resolves true once `promise` settles, or false after `ms`. */
export function settles(promise: Promise<unknown>, ms: number): Promise<boolean> {
  const deadline = AbortSignal.timeout(ms);
  return new Promise((resolve) => {
    promise.then(
      () => resolve(true),
      () => resolve(true),
    );
    deadline.addEventListener("abort", () => resolve(false), { once: true });
  });
}
