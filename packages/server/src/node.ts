import { statSync } from "node:fs";
import { open, stat } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import type { FileHandle } from "node:fs/promises";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { serve } from "@hono/node-server";

import { diskPath, storageFromEnv } from "@tide-ota/protocol";

import type { AnalyticsSink } from "./core/analytics.ts";
import type { Store } from "./core/store.ts";
import { createApp } from "./core/app.ts";
import { s3Store } from "./core/s3.ts";

/**
 * Returns a store over a directory, for tests and single-host development. The root is trusted (only the publisher
 * writes it), so the key grammar is the whole containment rule.
 */
export function diskStore(root: string): Store {
  if (!statSync(root, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error(`disk store root ${root} is not a directory`);
  }
  return {
    async get(key) {
      let path: string;
      try {
        path = diskPath(key);
      } catch {
        throw new Error(`invalid store key ${JSON.stringify(key)}`);
      }
      let fh: FileHandle;
      try {
        fh = await open(join(root, path), "r");
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
        // A root gone after startup is an outage, not a miss for every key.
        if ((await stat(root).catch(() => undefined))?.isDirectory()) return undefined;
        throw new Error(`disk store root ${root} unavailable`, { cause: e });
      }
      try {
        const st = await fh.stat();
        if (!st.isFile()) throw new Error(`${key} is not a regular file`);
        // createReadStream closes the handle on end, error and cancel alike.
        const body = Readable.toWeb(fh.createReadStream()) as ReadableStream<Uint8Array>;
        return { body, size: st.size };
      } catch (e) {
        await fh.close();
        throw e;
      }
    },
  };
}

/** Returns the store the environment configures: TIDE_DISK_DIR, or every TIDE_S3_* variable. Empty means unset. */
export function storeFromEnv(env: Readonly<Record<string, string | undefined>>): Store {
  const storage = storageFromEnv(env);
  return "disk" in storage ? diskStore(storage.disk) : s3Store(storage.s3);
}

const POINT_SCHEMA = 1;

/** Returns the sink TIDE_ANALYTICS selects: `stdout`, or none when unset or empty. */
function analyticsFromEnv(
  env: Readonly<Record<string, string | undefined>>,
): AnalyticsSink | undefined {
  const value = env.TIDE_ANALYTICS ?? "";
  if (value === "") return undefined;
  if (value !== "stdout") throw new Error("TIDE_ANALYTICS must be stdout, or unset");
  const { stdout } = process;
  // An unhandled error event, such as a closed reader's EPIPE, would end the process.
  stdout.on("error", () => undefined);
  return (point) => {
    // A reader that has stalled; past the stream's buffer every write would be held in memory.
    if (stdout.writableNeedDrain) return;
    const time = new Date().toISOString();
    stdout.write(`${JSON.stringify({ schema: POINT_SCHEMA, time, ...point })}\n`);
  };
}

/** Starts the app on Node; port 0 picks a free port, and no `hostname` listens on every interface. */
export function startServer(options: {
  port: number;
  hostname?: string;
  store: Store;
  appId?: string | undefined;
  analytics?: AnalyticsSink | undefined;
}): Promise<Server> {
  const app = createApp(options.store, { appId: options.appId, analytics: options.analytics });
  const { port, hostname } = options;
  return new Promise((resolve) => {
    // Without a createServer option, serve makes an HTTP/1.1 server.
    const server = serve(
      { fetch: app.fetch, port, ...(hostname !== undefined && { hostname }) },
      () => resolve(server as Server),
    );
  });
}

if (import.meta.main) {
  let store: Store;
  let analytics: AnalyticsSink | undefined;
  try {
    store = storeFromEnv(process.env);
    analytics = analyticsFromEnv(process.env);
  } catch (e) {
    console.error(`tide: ${(e as Error).message}`);
    process.exit(1);
  }
  const server = await startServer({
    port: Number(process.env.PORT ?? 8787),
    store,
    appId: process.env.TIDE_APP_ID,
    analytics,
  });
  console.log(`tide listening on port ${(server.address() as AddressInfo).port}`);
  // As PID 1 in a container, Node would ignore SIGTERM; close lets in-flight replies finish before exiting.
  let closing = false;
  // close only drops connections idle at the time; one whose reply ends later would wait out its keep-alive.
  server.on("request", (_req, res) => {
    res.once("finish", () => closing && server.closeIdleConnections());
  });
  const shutdown = () => {
    console.log("tide closing");
    closing = true;
    server.close(() => process.exit(0));
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
}
