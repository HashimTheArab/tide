#!/usr/bin/env node
import type { Bucket } from "./bucket.ts";
import { BucketError } from "./bucket.ts";
import { status } from "./status.ts";
import { bucketFromEnv } from "./storage.ts";

const USAGE = "usage: tide status";

/** Runs one command; 0 is success, 1 an unreadable record, 2 a usage, configuration or bucket error. */
async function main(args: string[], env: NodeJS.ProcessEnv): Promise<number> {
  if (args.length !== 1 || args[0] !== "status") {
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
