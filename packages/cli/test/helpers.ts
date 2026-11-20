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

interface RunResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** Runs `script` in a Node child with exactly `env`, draining stdout and stderr until it closes. */
export async function run(
  script: string,
  args: string[],
  env: Record<string, string>,
): Promise<RunResult> {
  const proc = spawn(process.execPath, [script, ...args], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  onTestFinished(() => {
    proc.kill("SIGKILL");
  });
  let stdout = "";
  let stderr = "";
  proc.stdout.setEncoding("utf8").on("data", (s: string) => (stdout += s));
  proc.stderr.setEncoding("utf8").on("data", (s: string) => (stderr += s));
  const [code] = (await once(proc, "close")) as [number | null];
  return { code, stdout, stderr };
}

// These assertions fail with fixed text and never pass output to a matcher, so a failing test cannot print a PEM.

/** Fails unless `result` exited 0 with nothing on stderr. */
export function expectSuccess(result: RunResult): void {
  if (result.code !== 0 || result.stderr !== "") throw new Error("unexpected exit code");
}

/** Fails unless `result` is exactly the refusal `message` with exit code 2. */
export function expectRefusal(result: RunResult, message: string): void {
  if (result.code !== 2) throw new Error("unexpected exit code");
  if (result.stdout !== "" || result.stderr !== `tide: ${message}\n`) {
    throw new Error(`expected refusal missing: ${message}`);
  }
}

/** Fails if `output` holds any base64 line of `pem`, its joined body, or a PEM label. */
export function expectNoPem(output: string, pem: string): void {
  const lines = pem.split("\n").filter((l) => l !== "" && !l.startsWith("-----"));
  const flat = output.replace(/\s/g, "");
  if (
    output.includes("-----BEGIN") ||
    lines.some((l) => l.length >= 16 && output.includes(l)) ||
    flat.includes(lines.join(""))
  ) {
    throw new Error("output contains PEM text");
  }
}
