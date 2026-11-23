// The host side of a conformance run: a temp dir, a signing identity generated for the run, and a local Tide.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { Agent, createServer, request } from "node:http";
import { constants, tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { ChildProcessByStdio } from "node:child_process";
import type { IncomingHttpHeaders, Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Readable } from "node:stream";

import { diskPath, patchKey } from "@tide-ota/protocol";
import { diskStore, startServer } from "@tide-ota/server/node";

import { RSA_SHA256, certificate, pem } from "../../packages/protocol/test/fixtures.ts";

const LOOPBACK = "127.0.0.1";
const MULTIPART = /^multipart\/mixed; boundary=(.*)$/s;
// Operator and cloud credentials in the caller's shell never reach a child.
const CREDENTIAL = /^(?:TIDE|AWS|ACTIONS|CLOUDFLARE|CF)_|_TOKEN$/i;
type Step = () => Promise<void> | void;
const DAY_MS = 24 * 60 * 60 * 1000;

/** What builds embed and what their writers sign with; the files live in the stack's temp dir only. */
export interface Identity {
  readonly keyId: string;
  readonly keyFile: string; // The writers' PKCS#8 PEM, mode 0600; the leaf's in chain mode.
  readonly certificateFile: string; // What the builds embed; the root in chain mode.
  readonly chainFile: string | undefined; // The chain the writers serve, leaf first; undefined in direct mode.
}

/** One reply the local Tide sent, with the request and reply headers the scenarios assert on. */
export interface Recorded {
  readonly path: string;
  readonly expectSignature: string | undefined; // The request's; a client sends it only with a certificate embedded.
  readonly aIm: string | undefined; // The request's A-IM.
  readonly currentUpdateId: string | undefined; // The request's Expo-Current-Update-ID.
  readonly requestedUpdateId: string | undefined; // The request's Expo-Requested-Update-ID.
  readonly status: number;
  readonly im: string | undefined;
  readonly baseUpdateId: string | undefined;
  readonly boundary: string | undefined; // A multipart reply's boundary, which names the stored reply it came from.
  readonly body: Uint8Array<ArrayBuffer> | undefined; // A multipart reply's body as forwarded so far, before the client gets it.
  readonly sha256: string | undefined; // Hex SHA-256 of a forwarded body, set once the upstream reply has ended.
}

export interface Stack {
  readonly dir: string; // Removed by `close`.
  readonly storeDir: string; // TIDE_DISK_DIR
  readonly serverUrl: string; // TIDE_SERVER_URL and TIDE_ASSET_URL: the recorder.
  readonly identity: Identity; // The direct identity, whose publish fills the empty bucket.
  readonly responses: readonly Recorded[]; // In the order their headers were sent.
  /**
   * Starts `command` with exactly `env` in a process group of its own. The group is killed once the child's stdout
   * and stderr close, or on `close`, which waits for those streams; its own children inherit them unless redirected.
   */
  spawn(command: string, args: readonly string[], env: Record<string, string>, cwd?: string): Child;
  /** Runs `step` on `close` after every child is killed and before the servers stop; later steps run first. */
  onClose(step: Step): void;
  /** Stops every child and the servers, then removes the temp dir; later calls return the first call's promise. */
  close(): Promise<void>;
}

type Child = ChildProcessByStdio<null, Readable, Readable>;

/** Starts a stack; one that fails to start has already removed what it made. */
async function startStack(): Promise<Stack> {
  const dir = realpathSync(await mkdtemp(join(tmpdir(), "tide-conformance-")));
  const controller = new AbortController();
  const steps: Step[] = [() => rm(dir, { recursive: true, force: true })];
  let closing: Promise<void> | undefined;
  const close = () =>
    (closing ??= (async () => {
      controller.abort();
      const errors: unknown[] = [];
      for (const step of steps.reverse()) {
        try {
          await step();
        } catch (e) {
          errors.push(e);
        }
      }
      if (errors.length > 0) {
        throw new AggregateError(errors, `the stack did not close cleanly: ${errors.join("; ")}`);
      }
    })());
  try {
    const storeDir = join(dir, "store");
    await mkdir(storeDir);
    const identity = await writeIdentity(join(dir, "identity"));
    const tide = await startServer({ port: 0, hostname: LOOPBACK, store: diskStore(storeDir) });
    steps.push(() => stop(tide));
    const responses: Recorded[] = [];
    const agent = new Agent();
    steps.push(() => agent.destroy());
    const serverUrl = await serve(recorder(port(tide), agent, storeDir, responses), steps);
    const children = new Set<Promise<void>>();
    steps.push(() => Promise.all(children).then(() => undefined));
    const start = (
      command: string,
      args: readonly string[],
      env: Record<string, string>,
      cwd?: string,
    ) => {
      if (controller.signal.aborted) throw new Error("the stack is closed");
      const child = spawn(command, args, {
        env,
        cwd,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      const kill = () => {
        if (child.pid === undefined) return; // It never started; kill(0) would signal our own group.
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          // The group has already gone.
        }
      };
      const closed = new Promise<void>((resolve) => {
        child.once("close", () => resolve()).once("error", () => resolve());
      }).then(() => {
        // A worker that redirected its stdio outlives the streams; once the group empties, its ID may be reused.
        kill();
        controller.signal.removeEventListener("abort", kill);
        children.delete(closed);
      });
      children.add(closed);
      controller.signal.addEventListener("abort", kill, { once: true });
      return child;
    };
    const onClose = (step: Step) => {
      if (controller.signal.aborted) throw new Error("the stack is closed");
      steps.push(step);
    };
    return { dir, storeDir, serverUrl, identity, responses, spawn: start, onClose, close };
  } catch (e) {
    await close();
    throw e;
  }
}

/**
 * Runs `body` with a fresh stack and closes it on return, on throw, and on SIGINT or SIGTERM, after which the process
 * exits with 128 plus the signal number.
 */
export async function withStack<T>(body: (stack: Stack) => Promise<T>): Promise<T> {
  const starting = startStack();
  const onSignal = (signal: NodeJS.Signals) => {
    void starting
      .then((s) => s.close())
      .catch(() => undefined)
      .finally(() => process.exit(128 + constants.signals[signal]));
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  try {
    const stack = await starting;
    try {
      return await body(stack);
    } finally {
      await stack.close();
    }
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  }
}

/** Returns the caller's environment without operator and cloud credentials. */
export function hostEnv(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      (e): e is [string, string] => e[1] !== undefined && !CREDENTIAL.test(e[0]),
    ),
  );
}

/** Returns the last 40 lines of `file`, or a note that it does not exist. */
export function tail(file: string): string {
  try {
    return readFileSync(file, "utf8").trimEnd().split("\n").slice(-40).join("\n");
  } catch {
    return `(no ${basename(file)})`;
  }
}

/**
 * Inverts every byte after the BSDIFF40 header of the stored patch from bundle `fromHex` to bundle `toHex`, so the
 * client still recognises the patch but cannot apply it; returns the patch's SHA-256 before the change.
 */
export function tamperPatch(storeDir: string, fromHex: string, toHex: string): string {
  const key = patchKey(fromHex, toHex);
  const path = join(storeDir, diskPath(key));
  let bytes: Buffer;
  try {
    bytes = readFileSync(path);
  } catch {
    throw new Error(`${key} is not stored`);
  }
  if (bytes.length <= 32 || bytes.toString("latin1", 0, 8) !== "BSDIFF40") {
    throw new Error(`${key} is not a BSDIFF40 patch`);
  }
  const intact = createHash("sha256").update(bytes).digest("hex");
  for (let i = 32; i < bytes.length; i++) bytes[i] = (bytes[i] ?? 0) ^ 0xff;
  writeFileSync(path, bytes);
  return intact;
}

async function writeIdentity(dir: string): Promise<Identity> {
  await mkdir(dir, { mode: 0o700 });
  const keys = await crypto.subtle.generateKey(RSA_SHA256, true, ["sign", "verify"]);
  const now = Date.now();
  // Valid from a day back, so a device clock behind the host's still accepts it.
  const cert = await certificate(keys.publicKey, keys.privateKey, new Date(now), {
    notBefore: new Date(now - DAY_MS),
    notAfter: new Date(now + 30 * DAY_MS),
  });
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", keys.privateKey));
  const keyFile = join(dir, "key.pem");
  const certificateFile = join(dir, "certificate.pem");
  await writeFile(keyFile, pem(pkcs8, "PRIVATE KEY"), { mode: 0o600, flag: "wx" });
  await writeFile(certificateFile, cert, { flag: "wx" });
  return { keyId: "conformance", keyFile, certificateFile, chainFile: undefined };
}

/**
 * Records each reply before sending it. Serves GET and HEAD of `assets/<hex>` from the disk store, as an operator's
 * public bucket domain does, and passes everything else to the Tide on `upstream` unchanged. A reply the upstream cuts
 * off closes the client's connection and keeps no `sha256`.
 */
export function recorder(
  upstream: number,
  agent: Agent,
  storeDir: string,
  responses: Recorded[],
): Server {
  return createServer((req, res) => {
    const path = req.url ?? "";
    const record = (status: number, headers: IncomingHttpHeaders = {}) => {
      const boundary = MULTIPART.exec(headers["content-type"] ?? "")?.[1];
      const header = (name: string) => req.headers[name] as string | undefined;
      const entry: { -readonly [K in keyof Recorded]: Recorded[K] } = {
        path,
        expectSignature: header("expo-expect-signature"),
        aIm: header("a-im"),
        currentUpdateId: header("expo-current-update-id"),
        requestedUpdateId: header("expo-requested-update-id"),
        status,
        im: headers.im as string | undefined,
        baseUpdateId: headers["expo-base-update-id"] as string | undefined,
        boundary,
        body: boundary === undefined ? undefined : new Uint8Array(),
        sha256: undefined,
      };
      responses.push(entry);
      return entry;
    };
    const hex = /^\/assets\/([0-9a-f]{64})$/.exec(path)?.[1];
    if (hex !== undefined && (req.method === "GET" || req.method === "HEAD")) {
      readFile(join(storeDir, diskPath(`assets/${hex}`))).then(
        (bytes) => {
          record(200);
          // The disk store keeps no type; the client takes each asset's type from its manifest.
          res.writeHead(200, {
            "content-type": "application/octet-stream",
            "content-length": bytes.length,
            "cache-control": "public, max-age=31536000, immutable",
          });
          res.end(req.method === "HEAD" ? undefined : bytes);
        },
        () => {
          record(404);
          res.writeHead(404).end();
        },
      );
      return;
    }
    const forward = request(
      { host: LOOPBACK, port: upstream, method: req.method, path, headers: req.headers, agent },
      (reply) => {
        const status = reply.statusCode ?? 0;
        const entry = record(status, reply.headers);
        const digest = createHash("sha256");
        // Added before the pipe, so each chunk is recorded before it is forwarded.
        reply.on("data", (chunk: Buffer) => {
          digest.update(chunk);
          if (entry.body !== undefined) {
            entry.body = new Uint8Array(Buffer.concat([entry.body, chunk]));
          }
        });
        reply.on("end", () => (entry.sha256 = digest.digest("hex")));
        reply.on("error", () => res.destroy());
        res.writeHead(status, reply.rawHeaders);
        reply.pipe(res);
      },
    );
    forward.on("error", () => res.destroy());
    req.pipe(forward);
  });
}

/** Listens on a free loopback port, registers the server's stop step and returns its base URL. */
async function serve(server: Server, steps: Step[]): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, LOOPBACK, resolve);
  });
  steps.push(() => stop(server));
  return `http://${LOOPBACK}:${port(server)}`;
}

const port = (server: Server) => (server.address() as AddressInfo).port;

function stop(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((e) => (e ? reject(e) : resolve()));
    server.closeAllConnections();
  });
}
