#!/usr/bin/env node
import type { Bucket } from "./bucket.ts";
import { BucketError } from "./bucket.ts";
import { PUBLISH_USAGE, publish } from "./publish.ts";
import { status } from "./status.ts";
import { bucketFromEnv } from "./storage.ts";

const USAGE = `usage: tide status\n${PUBLISH_USAGE}`;

/** Runs one command; each command documents its exit codes, and 2 is always a usage error. */
async function main(args: string[], env: NodeJS.ProcessEnv): Promise<number> {
  if (args[0] === "publish") {
    return await publish(args.slice(1), env, {
      out: (line) => process.stdout.write(`${line}\n`),
      err: (line) => process.stderr.write(`${line}\n`),
    });
  }
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
