#!/usr/bin/env node
import { parseArgs } from "node:util";

import { storageFromEnv } from "@tide/protocol";

import type { Bucket } from "./bucket.ts";
import { BucketError } from "./bucket.ts";
import { diskBucket } from "./disk.ts";
import { s3Bucket } from "./s3.ts";
import { status } from "./status.ts";

const USAGE = "usage: tide status";

/** Returns the bucket the environment configures, with the server's variables: TIDE_DISK_DIR or TIDE_S3_*. */
function bucketFromEnv(env: Readonly<Record<string, string | undefined>>): Bucket {
  const storage = storageFromEnv(env);
  return "disk" in storage ? diskBucket(storage.disk) : s3Bucket(storage.s3);
}

/** Runs one command; 0 is success, 1 an unreadable record, 2 a usage, configuration or bucket error. */
async function main(args: string[], env: NodeJS.ProcessEnv): Promise<number> {
  let positionals: string[];
  try {
    ({ positionals } = parseArgs({ args, allowPositionals: true, options: {} }));
  } catch {
    console.error(USAGE);
    return 2;
  }
  if (positionals.length !== 1 || positionals[0] !== "status") {
    console.error(USAGE);
    return 2;
  }
  let bucket: Bucket;
  try {
    bucket = bucketFromEnv(env);
  } catch (e) {
    // Configuration messages name variables and rules, never values; nothing has been sent.
    console.error(`tide: ${(e as Error).message}`);
    return 2;
  }
  try {
    return await status(
      bucket,
      (line) => process.stdout.write(`${line}\n`),
      (line) => process.stderr.write(`${line}\n`),
    );
  } catch (e) {
    if (!(e instanceof BucketError)) throw e;
    console.error(`tide: ${e.message}`);
    return 2;
  }
}

process.exitCode = await main(process.argv.slice(2), process.env);
