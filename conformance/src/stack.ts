// The host side of a conformance run: a temp dir, a signing identity generated for the run, and a local Tide.
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { Agent, createServer, request } from "node:http";
import { constants, tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

import { diskPath, patchKey } from "@tide/protocol";
import { diskStore, startServer } from "@tide/server/node";

import { RSA_SHA256, certificate, pem } from "../../packages/protocol/test/fixtures.ts";

const LOOPBACK = "127.0.0.1";
type Step = () => Promise<void> | void;
const DAY_MS = 24 * 60 * 60 * 1000;

/** The run's code-signing identity; the files live in the run's temp dir only. */
interface Identity {
  readonly keyId: string;
  readonly keyFile: string; // PKCS#8 PEM, mode 0600
  readonly certificateFile: string;
  readonly certificate: string;
}

/** One reply the local Tide sent, with the headers the scenarios assert on. */
interface Recorded {
  readonly path: string;
  readonly status: number;
  readonly im: string | undefined;
  readonly baseUpdateId: string | undefined;
}

export interface Stack {
  readonly dir: string; // Removed by `close`.
  readonly storeDir: string; // TIDE_DISK_DIR
  readonly serverUrl: string; // TIDE_SERVER_URL: the Node entry, behind the recorder.
  readonly assetUrl: string; // TIDE_ASSET_URL: a static origin over the store's assets/.
  readonly identity: Identity;
  readonly responses: readonly Recorded[]; // In the order their headers were sent.
  readonly signal: AbortSignal; // Aborted by `close`; a child spawned with it is killed then.
  /** Stops the servers and removes the temp dir; later calls return the first call's promise. */
  close(): Promise<void>;
}

/** Starts a stack; one that fails to start has already removed what it made. */
export async function startStack(): Promise<Stack> {
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
      if (errors.length > 0) throw new AggregateError(errors, "the stack did not close cleanly");
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
    const serverUrl = await serve(recorder(port(tide), agent, responses), steps);
    const assetUrl = await serve(assetOrigin(storeDir), steps);
    return {
      dir,
      storeDir,
      serverUrl,
      assetUrl,
      identity,
      responses,
      signal: controller.signal,
      close,
    };
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

/**
 * Inverts every byte after the BSDIFF40 header of the stored patch from bundle `fromHex` to bundle `toHex`, so the
 * client still recognises the patch but cannot apply it. Returns the file's path.
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
  for (let i = 32; i < bytes.length; i++) bytes[i] = (bytes[i] ?? 0) ^ 0xff;
  writeFileSync(path, bytes);
  return path;
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
  return { keyId: "conformance", keyFile, certificateFile, certificate: cert };
}

/** A proxy to the Tide on `upstream` that records each reply before passing it on unchanged. */
function recorder(upstream: number, agent: Agent, responses: Recorded[]): Server {
  return createServer((req, res) => {
    const path = req.url ?? "";
    const forward = request(
      { host: LOOPBACK, port: upstream, method: req.method, path, headers: req.headers, agent },
      (reply) => {
        const status = reply.statusCode ?? 0;
        const header = (name: string) => reply.headers[name] as string | undefined;
        responses.push({
          path,
          status,
          im: header("im"),
          baseUpdateId: header("expo-base-update-id"),
        });
        res.writeHead(status, reply.rawHeaders);
        reply.pipe(res);
      },
    );
    forward.on("error", () => res.destroy());
    req.pipe(forward);
  });
}

/** Serves `assets/<hex>` from the disk store, as an operator's public bucket domain does. */
function assetOrigin(storeDir: string): Server {
  return createServer((req, res) => {
    const hex = /^\/assets\/([0-9a-f]{64})$/.exec(req.url ?? "")?.[1];
    if (hex === undefined || (req.method !== "GET" && req.method !== "HEAD")) {
      res.writeHead(404).end();
      return;
    }
    readFile(join(storeDir, diskPath(`assets/${hex}`))).then(
      (bytes) => {
        // The disk store keeps no type; the client takes each asset's type from its manifest.
        res.writeHead(200, {
          "content-type": "application/octet-stream",
          "content-length": bytes.length,
          "cache-control": "public, max-age=31536000, immutable",
        });
        res.end(req.method === "HEAD" ? undefined : bytes);
      },
      () => res.writeHead(404).end(),
    );
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
