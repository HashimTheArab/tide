import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";

import type { FakeS3 } from "@tide/server/test/fake-s3";
import { FAKE_S3, WRONG_SECRET, startFakeS3 } from "@tide/server/test/fake-s3";

import type { Bucket } from "../src/bucket.ts";
import { BucketError } from "../src/bucket.ts";
import { s3Bucket } from "../src/s3.ts";
import { listAll, rejection, utf8 } from "./helpers.ts";

const KEY = "reply/main/1.0.0/ios";

let fake: FakeS3;
let bucket: Bucket;
beforeAll(async () => {
  fake = await startFakeS3();
  bucket = s3Bucket({ ...FAKE_S3, endpoint: fake.endpoint });
});
afterEach(() => {
  fake.failAll(undefined);
  fake.listFault(undefined);
  fake.objects.clear();
});
afterAll(() => fake.close());

/** Each bucket operation, against one key that exists. */
const operations = (b: Bucket, key = KEY): Record<string, () => Promise<unknown>> => ({
  get: () => b.get(key, 100),
  put: () => b.put(key, utf8("x")),
  putIfAbsent: () => b.putIfAbsent(key, utf8("x")),
  putIfMatch: () => b.putIfMatch(key, utf8("x"), fake.etag(key) ?? '"none"'),
  delete: () => b.delete(key),
  list: () => listAll(b, "reply/"),
  time: () => b.time(),
});
const MUTATIONS = new Set(["put", "putIfAbsent", "putIfMatch", "delete"]);

/** Asserts that `error` holds no provider text, no credential and no cause. */
function clean(error: Error): void {
  expect(error).toBeInstanceOf(BucketError);
  expect(error.message).not.toContain(FAKE_S3.accessKeyId);
  expect(error.message).not.toContain(FAKE_S3.secretAccessKey);
  expect(error.message).not.toContain("fake");
  expect(error.cause).toBeUndefined();
}

test("a request signed with the wrong secret is refused by the fake, for every operation", async () => {
  fake.objects.set(KEY, utf8("stored"));
  const wrong = s3Bucket({ ...FAKE_S3, endpoint: fake.endpoint, secretAccessKey: WRONG_SECRET });
  for (const [name, run] of Object.entries(operations(wrong))) {
    const before = fake.requests;
    const error = await rejection(run());
    expect(error.message, name).toMatch(/^S3 \w+ failed: 403 SignatureDoesNotMatch$/);
    expect(fake.requests, name).toBe(before + 1);
  }
  expect(fake.objects.get(KEY)).toEqual(utf8("stored"));
});

test("ETags are opaque: the provider's exact tag is returned, read and matched", async () => {
  const tag = await bucket.put(KEY, utf8("same"));
  expect(tag).toBe(fake.etag(KEY));
  expect(tag).not.toMatch(/^"[0-9a-f]+"$/);
  expect(await bucket.get(KEY, 100)).toEqual({ bytes: utf8("same"), etag: tag });
  // Identical bytes get a new tag, so the first is stale.
  const again = await bucket.put(KEY, utf8("same"));
  expect(again).not.toBe(tag);
  expect(await bucket.putIfMatch(KEY, utf8("next"), tag)).toBeUndefined();
  expect(await bucket.putIfMatch(KEY, utf8("next"), again)).toBe(fake.etag(KEY));
  expect(fake.objects.get(KEY)).toEqual(utf8("next"));
});

test.each(["nested-404", "duplicate-404"] as const)(
  "a 404 under %s is an error, not absence",
  async (behaviour) => {
    fake.behave("reply/odd/1/ios", behaviour);
    const error = await rejection(bucket.get("reply/odd/1/ios", 100));
    expect(error.message).toBe("S3 GetObject failed: 404 without an S3 error document");
    expect(await bucket.get("reply/missing/1/ios", 100)).toBeUndefined();
  },
);

describe.each([
  [{ status: 403, code: "AccessDenied" }, "403 AccessDenied", "failed"],
  [{ status: 500, code: "InternalError" }, "500 InternalError", "unknown"],
  [{ status: 404, code: "NoSuchBucket" }, "404 NoSuchBucket", "failed"],
  [{ status: 409, code: "ConditionalRequestConflict" }, "409 ConditionalRequestConflict", "failed"],
  [{ status: 403, code: FAKE_S3.secretAccessKey }, "403 with an unrecognised error code", "failed"],
  [{ status: 403, code: FAKE_S3.accessKeyId }, "403 with an unrecognised error code", "failed"],
  ["redirect", "301 without an S3 error document", "failed"],
  ["drop", "network error", "unknown"],
] as const)("when every request fails with %j", (failure, message, mutationOutcome) => {
  test("every operation rejects with a fixed message and no provider text", async () => {
    fake.objects.set(KEY, utf8("stored"));
    fake.failAll(failure);
    for (const [name, run] of Object.entries(operations(bucket))) {
      const before = fake.requests;
      const error = await rejection(run());
      clean(error);
      expect(error.message, name).toMatch(new RegExp(`^S3 \\w+ failed: ${message}$`));
      const outcome = MUTATIONS.has(name) ? mutationOutcome : "failed";
      expect((error as BucketError).outcome, name).toBe(outcome);
      expect(fake.requests, name).toBe(before + 1); // A redirect is never followed.
    }
    expect(fake.objects.get(KEY)).toEqual(utf8("stored"));
  });
});

test("an error never names the key, even one holding the access key ID", async () => {
  const key = `reply/${FAKE_S3.accessKeyId}/1/ios`;
  fake.failAll({ status: 403, code: "AccessDenied" });
  for (const run of Object.values(operations(bucket, key))) clean(await rejection(run()));
});

test.each([
  ["encoding-access-key", "returned 200 with an unsupported content-encoding"],
  ["encoding-secret", "returned 200 with an unsupported content-encoding"],
  ["gzip", "returned 200 with an unsupported content-encoding"],
  ["no-etag", "returned 200 with a missing or invalid ETag"],
  // fetch refuses a non-numeric Content-Length before the adapter sees the response.
  ["length-secret", "failed: network error"],
] as const)("a GET answered with %s rejects with a fixed message", async (behaviour, message) => {
  const key = `reply/${behaviour.replaceAll("-", "")}/1/ios`;
  fake.objects.set(key, utf8("stored"));
  fake.behave(key, behaviour);
  const error = await rejection(bucket.get(key, 100));
  clean(error);
  expect(error.message).toBe(`S3 GetObject ${message}`);
});

test("an object over maxBytes is never read: its body is abandoned", async () => {
  fake.behave("reply/big/1/ios", "oversize");
  const error = await rejection(bucket.get("reply/big/1/ios", 100));
  expect(error.message).toBe(
    "S3 GetObject returned 200 with a content-length over the caller's limit",
  );
  await fake.abandoned("reply/big/1/ios");
});

test("putIfMatch on an absent key is AWS's 404, an error rather than a lost race", async () => {
  const error = await rejection(bucket.putIfMatch(KEY, utf8("x"), '"fake-1!~/"'));
  expect(error).toMatchObject({ message: "S3 PutObject failed: 404 NoSuchKey", outcome: "failed" });
  expect(fake.objects.has(KEY)).toBe(false);
});

test.each(["malformed", "missing-field", "common-prefixes", "repeat-token"] as const)(
  "a second listing page that is %s rejects after the first page's entries",
  async (fault) => {
    for (const n of [1, 2, 3, 4, 5]) fake.objects.set(`reply/c${n}/1/ios`, utf8("x"));
    fake.listFault(fault);
    const seen: unknown[] = [];
    const error = await rejection(
      (async () => {
        for await (const entry of bucket.list("reply/")) seen.push(entry);
      })(),
    );
    expect(error).toMatchObject({
      message: "S3 ListObjectsV2 returned 200 with an invalid listing page",
      outcome: "failed",
    });
    expect(seen).toEqual([1, 2, 3].map((n) => ({ key: `reply/c${n}/1/ios` })));
  },
);

test("a clean listing sends each continuation token back byte for byte", async () => {
  const before = fake.tokens.length;
  for (const n of [1, 2, 3, 4, 5, 6, 7]) fake.objects.set(`reply/t${n}/1/ios`, utf8("x"));
  expect(await listAll(bucket, "reply/")).toHaveLength(7);
  const sent = fake.tokens.slice(before);
  expect(sent).toHaveLength(2);
  for (const token of sent) expect(token).toMatch(/^t\d+\+\/=$/);
});

test.each(["hang", "stall-body"] as const)(
  "a GET that %s times out at the operation's deadline",
  async (behaviour) => {
    const key = `reply/${behaviour.replace("-", "")}/1/ios`;
    fake.behave(key, behaviour);
    const quick = s3Bucket({ ...FAKE_S3, endpoint: fake.endpoint }, { timeoutMs: 250 });
    const get = quick.get(key, 100);
    if (behaviour === "stall-body") await fake.flushed(key); // The headers, ETag included, have arrived.
    const error = await rejection(get);
    expect(error.message).toBe("S3 GetObject timed out after 250 ms");
    await fake.abandoned(key);
  },
);

test("an invalid configuration sends nothing", () => {
  const before = fake.requests;
  expect(() => s3Bucket({ ...FAKE_S3, endpoint: fake.endpoint, bucket: "a/b" })).toThrow(
    "bucket must be",
  );
  expect(fake.requests).toBe(before);
});
