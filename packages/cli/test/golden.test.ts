import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { expect, test } from "vitest";

import type { Objects } from "./publish-fixture.ts";
import { publish } from "../src/publish.ts";
import { prng } from "./helpers.ts";
import { T, env, project, s3, s3Env, useFixture } from "./publish-fixture.ts";

useFixture();

// Each object's SHA-256: secret scanners read a release record's asset key and hash as an API key, even encoded.
const GOLDEN = new URL("fixtures/published.json", import.meta.url);

/** Fills each array from a fixed sequence, so update IDs and boundaries repeat across runs. */
function seeded(seed: number): (bytes: Uint8Array<ArrayBuffer>) => Uint8Array {
  const next = prng(seed);
  return (bytes) => {
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(next() * 256);
    return bytes;
  };
}

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

test("a publish at a fixed time and seed stores the golden objects, signatures aside", async () => {
  s3.setNow(T);
  const err: string[] = [];
  const code = await publish(
    ["--channel", "main", "--project-root", project().root],
    env(s3Env()),
    {
      out: () => undefined,
      err: (l) => err.push(l),
      now: () => T,
      random: seeded(1),
    },
  );
  expect(err).toEqual([]);
  expect(code).toBe(0);
  expect(digests(normalised(s3.objects))).toEqual(golden());
});
