// Runs one disk-bucket operation in its own process, as a concurrent CLI would.
// Usage: node disk-writer.ts <root> putIfAbsent|putIfMatch|hold <key> <payload> [etag]
// Prints "ready" (or "held"), waits for a "go" line on stdin, then prints the result as one JSON line.
import { once } from "node:events";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { DatabaseSync } from "node:sqlite";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";

import { BucketError } from "../src/bucket.ts";
import { diskBucket } from "../src/disk.ts";

const [root = "", op = "", key = "", payload = "", etag = ""] = process.argv.slice(2);
const lines = createInterface({ input: process.stdin });

if (op === "hold") {
  hold();
  // A full collection first, so "held" proves the lock outlives the function that took it.
  setFlagsFromString("--expose-gc");
  (runInNewContext("gc") as () => void)();
  process.stdout.write("held\n");
} else {
  const bucket = diskBucket(root, { busyTimeoutMs: 60_000 });
  const bytes = new Uint8Array(new TextEncoder().encode(payload));
  process.stdout.write("ready\n");
  await once(lines, "line");
  try {
    const result =
      op === "putIfAbsent"
        ? await bucket.putIfAbsent(key, bytes)
        : await bucket.putIfMatch(key, bytes, etag);
    process.stdout.write(`${JSON.stringify({ etag: result ?? null })}\n`);
  } catch (e) {
    if (!(e instanceof BucketError)) throw e;
    process.stdout.write(`${JSON.stringify({ error: e.message, outcome: e.outcome })}\n`);
  }
  lines.close();
}

/**
 * Holds the writers' mutex as another CLI process inside its critical section would, until killed. Collecting the
 * connection closes it and frees the lock, so the stdin listener keeps it reachable.
 */
function hold() {
  const db = new DatabaseSync(join(root, ".tide", "mutex.sqlite"), { timeout: 0 });
  db.exec("BEGIN IMMEDIATE");
  lines.on("close", () => db.close());
}
