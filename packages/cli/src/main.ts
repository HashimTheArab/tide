#!/usr/bin/env node
import type { Bucket } from "./bucket.ts";
import { BucketError } from "./bucket.ts";
import { REPUBLISH_USAGE, ROLLBACK_USAGE, republish, rollback } from "./publish-rollback.ts";
import { PUBLISH_USAGE, publish } from "./publish.ts";
import { status } from "./status.ts";
import { bucketFromEnv } from "./storage.ts";

const USAGE = `usage: tide status\n${PUBLISH_USAGE}\n${ROLLBACK_USAGE}\n${REPUBLISH_USAGE}`;
const WRITERS = { publish, rollback, republish };

/** Runs one command; each command documents its exit codes, and 2 is always a usage error. */
async function main(args: string[], env: NodeJS.ProcessEnv): Promise<number> {
  const command = args[0];
  if (command !== undefined && Object.hasOwn(WRITERS, command)) {
    return await WRITERS[command as keyof typeof WRITERS](args.slice(1), env, {
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
