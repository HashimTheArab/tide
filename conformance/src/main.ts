#!/usr/bin/env node
import { USAGE, UsageError, parseRun } from "./options.ts";

/** Exit 0 for help, 2 for a usage error before anything starts, 1 when the run fails. */
function main(args: readonly string[]): number {
  let run;
  try {
    run = parseRun(args);
  } catch (e) {
    if (!(e instanceof UsageError)) throw e;
    process.stderr.write(`conformance: ${e.message}; see pnpm conformance --help\n`);
    return 2;
  }
  if (run === "help") {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  process.stderr.write(`conformance: no ${run.platform} device driver exists yet\n`);
  return 1;
}

process.exitCode = main(process.argv.slice(2));
