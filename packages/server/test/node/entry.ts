import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { onTestFinished } from "vitest";

const ENTRY = fileURLToPath(new URL("../../src/node.ts", import.meta.url));

/** Runs the Node entry with only `env` and PORT=0; the process is killed when the test finishes. */
export function runEntry(env: Record<string, string>): {
  /** Resolves the listening port, or rejects with stderr if the process exits first. */
  listening: Promise<number>;
  exited: Promise<{ code: number | null; stdout: string; stderr: string }>;
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
  child.stderr.setEncoding("utf8").on("data", (s: string) => (stderr += s));
  const exited = once(child, "exit").then(([code]) => ({
    code: code as number | null,
    stdout,
    stderr,
  }));
  const listening = new Promise<number>((resolve, reject) => {
    child.stdout.setEncoding("utf8").on("data", (s: string) => {
      stdout += s;
      const port = /tide listening on port (\d+)/.exec(stdout)?.[1];
      if (port !== undefined) resolve(Number(port));
    });
    void exited.then(({ stderr: err }) => reject(new Error(`entry exited: ${err}`)));
  });
  void listening.catch(() => undefined); // A test that expects an exit never awaits it.
  return { listening, exited };
}
