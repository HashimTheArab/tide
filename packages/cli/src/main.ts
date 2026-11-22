#!/usr/bin/env node
import type { Bucket } from "./bucket.ts";
import { BucketError } from "./bucket.ts";
import { EXPORT_USAGE, exportProject } from "./export.ts";
import { PROBE_USAGE, probe } from "./probe.ts";
import { REPUBLISH_USAGE, ROLLBACK_USAGE, republish, rollback } from "./publish-rollback.ts";
import { PUBLISH_USAGE, publish } from "./publish.ts";
import { REGISTER_BUILD_USAGE, registerBuild } from "./register-build.ts";
import { ROLLOUT_USAGE, rollout } from "./rollout.ts";
import { status } from "./status.ts";
import { storage } from "./storage-report.ts";
import { bucketFromEnv } from "./storage.ts";

const USAGE = `usage: tide status\nusage: tide storage\n${EXPORT_USAGE}\n${PUBLISH_USAGE}\n${ROLLOUT_USAGE}\n${ROLLBACK_USAGE}\n${REPUBLISH_USAGE}\n${REGISTER_BUILD_USAGE}\n${PROBE_USAGE}`;
// Commands that parse arguments and read their own configuration.
const COMMANDS = {
  export: exportProject,
  publish,
  rollout,
  rollback,
  republish,
  "register-build": registerBuild,
  probe,
};
const READERS = { status, storage };

/** Runs one command; each command documents its exit codes, and 2 is always a usage error. */
async function main(args: string[], env: NodeJS.ProcessEnv): Promise<number> {
  const command = args[0];
  if (command !== undefined && Object.hasOwn(COMMANDS, command)) {
    return await COMMANDS[command as keyof typeof COMMANDS](args.slice(1), env, {
      out: (line) => process.stdout.write(`${line}\n`),
      err: (line) => process.stderr.write(`${line}\n`),
    });
  }
  if (args.length !== 1 || command === undefined || !Object.hasOwn(READERS, command)) {
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
    return await READERS[command as keyof typeof READERS](
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
