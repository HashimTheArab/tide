import { statSync } from "node:fs";
import { open, stat } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import type { ServerType } from "@hono/node-server";
import type { FileHandle } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { serve } from "@hono/node-server";

import { diskPath } from "@tide/protocol";

import type { S3Config } from "./core/s3.ts";
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

// The TIDE_ prefix keeps ambient AWS credentials out.
const S3_VARS = {
  endpoint: "TIDE_S3_ENDPOINT",
  region: "TIDE_S3_REGION",
  bucket: "TIDE_S3_BUCKET",
  accessKeyId: "TIDE_S3_ACCESS_KEY_ID",
  secretAccessKey: "TIDE_S3_SECRET_ACCESS_KEY",
} as const satisfies Record<Exclude<keyof S3Config, "timeoutMs">, string>;

/** Returns the store the environment configures: TIDE_DISK_DIR, or every TIDE_S3_* variable. Empty means unset. */
export function storeFromEnv(env: Readonly<Record<string, string | undefined>>): Store {
  const read = (name: string) => (env[name] === "" ? undefined : env[name]);
  const disk = read("TIDE_DISK_DIR");
  const names = Object.values(S3_VARS);
  const missing = names.filter((name) => read(name) === undefined);

  if (missing.length === names.length) {
    if (disk !== undefined) return diskStore(disk);
    throw new Error(`no store configured: set TIDE_DISK_DIR, or all of ${names.join(", ")}`);
  }
  if (disk !== undefined) throw new Error("set TIDE_DISK_DIR or the TIDE_S3_* variables, not both");
  if (missing.length > 0) throw new Error(`S3 store incomplete: set ${missing.join(", ")}`);
  const config = Object.fromEntries(Object.entries(S3_VARS).map(([k, v]) => [k, read(v)]));
  try {
    return s3Store(config as Record<keyof typeof S3_VARS, string>);
  } catch (e) {
    throw new Error(`${S3_VARS.endpoint}: ${(e as Error).message}`); // Only the endpoint is checked here.
  }
}

/** Starts the app on Node; port 0 picks a free port. */
export function startServer(options: {
  port: number;
  store: Store;
  appId?: string | undefined;
}): Promise<ServerType> {
  const app = createApp(options.store, { appId: options.appId });
  return new Promise((resolve) => {
    const server = serve({ fetch: app.fetch, port: options.port }, () => resolve(server));
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
}
