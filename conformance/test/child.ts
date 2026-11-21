import { spawn } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { onTestFinished } from "vitest";

/** Starts a Node child running `script`; `line()` resolves its next stdout line. It is killed when the test ends. */
export function child(script: string) {
  const proc = spawn(process.execPath, [script], { stdio: ["ignore", "pipe", "inherit"] });
  onTestFinished(() => {
    proc.kill("SIGKILL");
  });
  const lines = createInterface({ input: proc.stdout })[Symbol.asyncIterator]();
  return {
    proc,
    async line(): Promise<string> {
      const { value, done } = await lines.next();
      if (done === true) throw new Error(`${script} ended before writing a line`);
      return value;
    },
    exited: once(proc, "exit"),
  };
}
