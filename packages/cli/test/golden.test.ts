import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { expect, test } from "vitest";

import { NO_UPDATE_KEY, decodeStoredReply } from "@tide-ota/protocol";

import type { Objects } from "./publish-fixture.ts";
import { publish } from "../src/publish.ts";
import { tempRoot } from "./helpers.ts";
import {
  ANDROID,
  IOS,
  T,
  artifact,
  diskObjects,
  env,
  exportIn,
  project,
  s3,
  s3Env,
  signedManifest,
  signedPart,
  useFixture,
} from "./publish-fixture.ts";

useFixture();

// Each object's SHA-256: secret scanners read a release record's asset key and hash as an API key, even encoded.
const GOLDEN = new URL("fixtures/published.json", import.meta.url);

/**
 * Every object as latin1 text, keys and bodies alike: each update ID and boundary becomes `<id-N>` or `<boundary-N>`
 * in first-seen order, and each signature's base64 as many `A`s, since IDs, boundaries and keys are drawn per run.
 */
function normalised(objects: Objects): Map<string, string> {
  const texts = [...objects]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([key, bytes]) => [key, Buffer.from(bytes).toString("latin1")] as const);
  const names = new Map<string, string>();
  for (const key of [ANDROID, IOS]) {
    const reply = decodeStoredReply(objects.get(key)!);
    if (reply.kind === "manifest") names.set(reply.updateId, `<id-${names.size + 1}>`);
  }
  let boundaries = 0;
  for (const [, text] of texts) {
    for (const [, b] of text.matchAll(/boundary=([0-9a-f]+)/g)) {
      if (!names.has(b!)) names.set(b!, `<boundary-${++boundaries}>`);
    }
  }
  const rename = (text: string) =>
    [...names].reduce((t, [from, to]) => t.replaceAll(from, to), text);
  return new Map(
    texts.map(([key, text]) => [
      rename(key),
      // A stored reply is JSON, so the quote before the base64 is escaped.
      rename(text).replace(
        /(sig=\\?")([A-Za-z0-9+/=]+)/g,
        (_, head: string, sig: string) => head + "A".repeat(sig.length),
      ),
    ]),
  );
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

/** Publishes to `store` at `now`, failing the test unless it exits 0. */
async function publishAt(args: string[], store: Record<string, string>, now: number) {
  const err: string[] = [];
  const code = await publish(["--channel", "main", ...args], env(store), {
    out: () => undefined,
    err: (l) => err.push(l),
    now: () => now,
  });
  expect(err).toEqual([]);
  expect(code).toBe(0);
}

test("export then publish --from at a fixed time stores the golden objects, every signature verifying", async () => {
  const exported = await exportIn(project().root);
  expect(exported.code).toBe(0);
  s3.setNow(T);
  await publishAt(["--from", exported.dir], s3Env(), T);
  expect(digests(normalised(s3.objects))).toEqual(golden());
  // The golden replaces each signature; the real ones verify under the run's certificate.
  for (const key of [IOS, ANDROID]) await signedManifest(s3.objects, key);
  const noUpdate = decodeStoredReply(s3.objects.get(NO_UPDATE_KEY)!);
  await signedPart(noUpdate.body, noUpdate.boundary, "directive");
});

test("one export published at one time stores the same objects on disk and S3", async () => {
  // The disk bucket's time is the local clock, so both runs share one whole-second sample of it.
  const t = Math.floor(Date.now() / 1000) * 1000;
  const dir = artifact();
  const disk = tempRoot();
  await publishAt(["--from", dir], { TIDE_DISK_DIR: disk }, t);
  s3.setNow(t);
  await publishAt(["--from", dir], s3Env(), t);
  expect(s3.objects.size).toBe(12);
  expect(normalised(diskObjects(disk))).toEqual(normalised(s3.objects));
});
