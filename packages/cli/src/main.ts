#!/usr/bin/env node
import type { Bucket } from "./bucket.ts";
import { BucketError } from "./bucket.ts";
import { CERTIFICATE_USAGE, certificate } from "./certificate.ts";
import { EXPORT_USAGE, exportProject } from "./export.ts";
import { PROBE_USAGE, probe } from "./probe.ts";
import { REPUBLISH_USAGE, ROLLBACK_USAGE, republish, rollback } from "./publish-rollback.ts";
import { PUBLISH_USAGE, publish } from "./publish.ts";
import { REGISTER_BUILD_USAGE, registerBuild } from "./register-build.ts";
import { ROLLOUT_USAGE, rollout } from "./rollout.ts";
import { status } from "./status.ts";
import { storage } from "./storage-report.ts";
import { bucketFromEnv } from "./storage.ts";

const USAGE = `usage: tide status\nusage: tide storage\n${EXPORT_USAGE}\n${PUBLISH_USAGE}\n${ROLLOUT_USAGE}\n${ROLLBACK_USAGE}\n${REPUBLISH_USAGE}\n${REGISTER_BUILD_USAGE}\n${PROBE_USAGE}\n${CERTIFICATE_USAGE}`;
// The listing alone names --json and the rollout probe, so every refusal keeps its text.
const LISTING = `${USAGE}
       tide status --json
       tide storage --json
       tide publish ... --json
       tide rollout ... --json
       tide rollback ... --json
       tide republish ... --json
       tide probe ... [--rollout-side new --rollout-update <updateId>] [--json]`;
// Commands that parse arguments and read their own configuration.
const COMMANDS = {
  export: exportProject,
  publish,
  rollout,
  rollback,
  republish,
  "register-build": registerBuild,
  probe,
  certificate,
};
// Commands whose one argument, if any, is --json.
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
  const json = args.length === 2 && args[1] === "--json";
  if (!(args.length === 1 || json) || command === undefined || !Object.hasOwn(READERS, command)) {
    console.error(args.length === 0 ? LISTING : USAGE);
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
      json,
    );
  } catch (e) {
    if (!(e instanceof BucketError)) throw e;
    console.error(`tide: ${e.message}`);
    return 2;
  }
}

try {
  process.exitCode = await main(process.argv.slice(2), process.env);
} catch (e) {
  // A crash exits at once and would drop stdout still queued for a pipe.
  await new Promise((resolve) => process.stdout.write("", resolve));
  throw e;
}
