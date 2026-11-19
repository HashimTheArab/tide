import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { onTestFinished } from "vitest";

/** Returns the bytes of a protocol golden fixture. */
export function fixture(name: string): Uint8Array<ArrayBuffer> {
  return new Uint8Array(
    readFileSync(new URL(`../../protocol/test/fixtures/${name}`, import.meta.url)),
  );
}

export const utf8 = (s: string) => new Uint8Array(new TextEncoder().encode(s));

/** Returns a fresh directory, removed when the test finishes. */
export function tempRoot(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "tide-cli-")));
  onTestFinished(() => {
    rmSync(root, { recursive: true, force: true });
  });
  return root;
}

/** Returns the rejection of `promise`, failing the test if it resolves. */
export async function rejection(promise: Promise<unknown>): Promise<Error> {
  return promise.then(
    () => {
      throw new Error("expected a rejection");
    },
    (e: unknown) => e as Error,
  );
}

/**
 * Starts a Node child running `script` with `args`; `line()` resolves its next stdout line. The child is killed when
 * the test finishes.
 */
export function child(script: string, args: string[], env: NodeJS.ProcessEnv = process.env) {
  const proc = spawn(process.execPath, [script, ...args], {
    env,
    stdio: ["pipe", "pipe", "inherit"],
  });
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
    send(line: string) {
      proc.stdin.write(`${line}\n`);
    },
    exited: once(proc, "exit"),
  };
}
