import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { expect, test } from "vitest";

import type { Objects } from "./publish-fixture.ts";
import { publish } from "../src/publish.ts";
import { seeded, tempRoot } from "./helpers.ts";
import { T, env, exportIn, project, s3, s3Env, tree, useFixture } from "./publish-fixture.ts";

useFixture();

// Each object's SHA-256: secret scanners read a release record's asset key and hash as an API key, even encoded.
const GOLDEN = new URL("fixtures/published.json", import.meta.url);

/** Every object as latin1 text, each signature's base64 replaced by as many `A`s: keys are generated per run. */
function normalised(objects: Objects): Map<string, string> {
  const out = new Map<string, string>();
  for (const [key, bytes] of [...objects].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const text = Buffer.from(bytes).toString("latin1");
    out.set(
      key,
      // A stored reply is JSON, so the quote before the base64 is escaped.
      text.replace(
        /(sig=\\?")([A-Za-z0-9+/=]+)/g,
        (_, head: string, sig: string) => head + "A".repeat(sig.length),
      ),
    );
  }
  return out;
}

/** The SHA-256 of each normalised object, by key. */
function digests(objects: Map<string, string>): Record<string, string> {
  return Object.fromEntries(
    [...objects].map(([key, text]) => [
      key,
      createHash("sha256").update(Buffer.from(text, "latin1")).digest("hex"),
    ]),
  );
}

/** The golden digests, by key. */
const golden = () => JSON.parse(readFileSync(GOLDEN, "utf8")) as Record<string, string>;

/** Publishes to `store` at `now` with seed 1, failing the test unless it exits 0. */
async function publishAt(args: string[], store: Record<string, string>, now: number) {
  const err: string[] = [];
  const code = await publish(["--channel", "main", ...args], env(store), {
    out: () => undefined,
    err: (l) => err.push(l),
    now: () => now,
    random: seeded(1),
  });
  expect(err).toEqual([]);
  expect(code).toBe(0);
}

test("a publish at a fixed time and seed stores the golden objects, signatures aside", async () => {
  s3.setNow(T);
  await publishAt(["--project-root", project().root], s3Env(), T);
  expect(digests(normalised(s3.objects))).toEqual(golden());
});

test("export then publish --from stores the direct publish's bytes, on disk and on S3", async () => {
  const app = project();
  const exported = await exportIn(app.root);
  expect(exported.code).toBe(0);
  // The disk bucket's time is the local clock, so both runs share one whole-second sample of it.
  const t = Math.floor(Date.now() / 1000) * 1000;
  const run = async (args: string[]) => {
    const disk = tempRoot();
    await publishAt(args, { TIDE_DISK_DIR: disk }, t);
    s3.reset();
    s3.setNow(t);
    await publishAt(args, s3Env(), t);
    return { disk: tree(disk), s3: new Map(s3.objects) };
  };
  const direct = await run(["--project-root", app.root]);
  const from = await run(["--from", exported.dir]);
  expect(from.disk).toEqual(direct.disk);
  expect(from.s3).toEqual(direct.s3);
  expect(from.s3.size).toBe(12);
});
