import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import type { Readable } from "node:stream";
import { onTestFinished } from "vitest";

const ENTRY = fileURLToPath(new URL("../../src/node.ts", import.meta.url));

/** Runs the Node entry with only `env` and PORT=0; the process is killed when the test finishes. */
export function runEntry(env: Record<string, string>): {
  /** Resolves the listening port, or rejects with stderr if the process exits first. */
  listening: Promise<number>;
  /** Resolves the first match of `pattern` in stdout, or rejects if the process exits first. */
  printed: (pattern: RegExp) => Promise<RegExpExecArray>;
  /** The reader of the process's stdout, to pause or close. */
  stdout: Readable;
  kill: (signal: NodeJS.Signals) => void;
  exited: Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
    stdout: string;
    stderr: string;
  }>;
} {
  const child = spawn(process.execPath, [ENTRY], {
    env: { ...env, PORT: "0" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  onTestFinished(() => {
    child.kill("SIGKILL");
  });
  let stdout = "";
  let stderr = "";
  const waiting = new Set<() => void>();
  child.stderr.setEncoding("utf8").on("data", (s: string) => (stderr += s));
  child.stdout.setEncoding("utf8").on("data", (s: string) => {
    stdout += s;
    for (const check of waiting) check();
  });
  // Not "exit", which can come before the last output is read.
  const exited = once(child, "close").then(([code, signal]) => ({
    code: code as number | null,
    signal: signal as NodeJS.Signals | null,
    stdout,
    stderr,
  }));
  const printed = (pattern: RegExp) =>
    new Promise<RegExpExecArray>((resolve, reject) => {
      const check = () => {
        const match = pattern.exec(stdout);
        if (match === null) return;
        waiting.delete(check);
        resolve(match);
      };
      waiting.add(check);
      check();
      void exited.then(({ stderr: err }) => reject(new Error(`entry exited: ${err}`)));
    });
  const listening = printed(/tide listening on port (\d+)\n/).then(([, port]) => Number(port));
  void listening.catch(() => undefined); // A test that expects an exit never awaits it.
  return {
    listening,
    printed,
    stdout: child.stdout,
    kill: (signal) => child.kill(signal),
    exited,
  };
}
