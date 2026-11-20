import { statSync } from "node:fs";
import { open, stat } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import type { FileHandle } from "node:fs/promises";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { serve } from "@hono/node-server";

import { diskPath, storageFromEnv } from "@tide/protocol";

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

/** Starts the app on Node; port 0 picks a free port. */
export function startServer(options: {
  port: number;
  store: Store;
  appId?: string | undefined;
}): Promise<Server> {
  const app = createApp(options.store, { appId: options.appId });
  return new Promise((resolve) => {
    // Without a createServer option, serve makes an HTTP/1.1 server.
    const server = serve({ fetch: app.fetch, port: options.port }, () => resolve(server as Server));
  });
}

if (import.meta.main) {
  let store: Store;
  try {
    store = storeFromEnv(process.env);
  } catch (e) {
    console.error(`tide: ${(e as Error).message}`);
    process.exit(1);
  }
  const server = await startServer({
    port: Number(process.env.PORT ?? 8787),
    store,
    appId: process.env.TIDE_APP_ID,
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
