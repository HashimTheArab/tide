import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";

import type { FakeS3 } from "@tide/server/test/fake-s3";
import { diskPath } from "@tide/protocol";
import { FAKE_S3, startFakeS3 } from "@tide/server/test/fake-s3";

import type { Bucket } from "../src/bucket.ts";
import { BucketError } from "../src/bucket.ts";
import { diskBucket } from "../src/disk.ts";
import { s3Bucket } from "../src/s3.ts";
import { rejection, tempRoot, utf8 } from "./helpers.ts";

// A whole second far from the local clock, so a test cannot pass by reading the wrong clock.
const BUCKET_TIME = Date.UTC(2031, 0, 2, 3, 4, 5);
const ASSET = `assets/${"ab".repeat(32)}`;

interface Backend {
  readonly bucket: Bucket;
  /** The bytes the backend holds for `key`, read around the adapter. */
  stored(key: string): Uint8Array | undefined;
  /** Stores a name outside the key grammar, around the adapter, and returns the name the adapter lists. */
  plantUnknown(): string;
  /** Counts requests that reached the backend; disk does no I/O worth counting, so it reports undefined. */
  requests(): number | undefined;
}

let fake: FakeS3;
beforeAll(async () => {
  fake = await startFakeS3();
});
afterAll(() => fake.close());

const backends: [string, () => Backend][] = [
  [
    "disk",
    () => {
      const root = tempRoot();
      return {
        bucket: diskBucket(root, { now: () => BUCKET_TIME }),
        stored: (key) => {
          try {
            return new Uint8Array(readFileSync(join(root, diskPath(key))));
          } catch {
            return undefined;
          }
        },
        plantUnknown: () => {
          mkdirSync(join(root, "reply/.invalid/1"), { recursive: true });
          writeFileSync(join(root, "reply/.invalid/1/ios"), "x");
          return "reply/.invalid/1/ios";
        },
        requests: () => undefined,
      };
    },
  ],
  [
    "s3",
    () => {
      fake.objects.clear();
      fake.setNow(BUCKET_TIME);
      return {
        bucket: s3Bucket({ ...FAKE_S3, endpoint: fake.endpoint }),
        stored: (key) => fake.objects.get(key),
        plantUnknown: () => {
          fake.objects.set("reply/bad name/1/ios", utf8("x"));
          return "reply/bad name/1/ios";
        },
        requests: () => fake.requests,
      };
    },
  ],
];

describe.each(backends)("%s bucket", (_, open) => {
  let b: Backend;
  let bucket: Bucket;
  beforeEach(() => {
    b = open();
    bucket = b.bucket;
  });

  test("put, get with ETag, overwrite, delete and a delete of an absent key", async () => {
    const key = "reply/main/1.0.0/ios";
    const first = await bucket.put(key, utf8("one"));
    expect(b.stored(key)).toEqual(utf8("one"));
    expect(await bucket.get(key, 100)).toEqual({ bytes: utf8("one"), etag: first });

    const second = await bucket.put(key, utf8("two"));
    expect(second).not.toBe(first);
    expect(b.stored(key)).toEqual(utf8("two"));
    expect(await bucket.get(key, 100)).toEqual({ bytes: utf8("two"), etag: second });

    await bucket.delete(key);
    expect(b.stored(key)).toBeUndefined();
    expect(await bucket.get(key, 100)).toBeUndefined();
    await bucket.delete(key);
  });

  test("a key of maximum length round-trips", async () => {
    const key = `reply/${"C".repeat(64)}/${"exposdk:57.0.0(1)".padEnd(64, "+")}/android`;
    await bucket.put(key, utf8("long"));
    expect((await bucket.get(key, 100))?.bytes).toEqual(utf8("long"));
    expect(await bucket.list("reply/")).toEqual([{ key, size: 4 }]);
  });

  test("get rejects an object over maxBytes", async () => {
    await bucket.put(ASSET, utf8("12345"));
    const error = await rejection(bucket.get(ASSET, 4));
    expect(error).toBeInstanceOf(BucketError);
    expect(await bucket.get(ASSET, 5)).toMatchObject({ bytes: utf8("12345") });
  });

  const KEYS = [
    "reply/Main/1.0.0/ios",
    "reply/Main/2.0.0/android",
    "reply/a+b/1.0.0/android",
    "reply/a+b/1.0.0/ios",
    "reply/a+b/2/ios",
    "reply/a+b/3/ios",
    "reply/main/1.0.0/ios",
    "reply/no-update",
  ];

  test("list returns every key under a prefix, across pages, in byte order", async () => {
    for (const key of [...KEYS, ASSET].reverse()) await bucket.put(key, utf8(key));
    const keys = (entries: unknown[]) => entries.map((e) => (e as { key: string }).key);
    expect(keys(await bucket.list("reply/"))).toEqual(KEYS);
    expect(keys(await bucket.list("reply/a+b/"))).toEqual(KEYS.slice(2, 6));
    expect(keys(await bucket.list("reply/Ma"))).toEqual(KEYS.slice(0, 2));
    expect(keys(await bucket.list("reply/Main/"))).toEqual(KEYS.slice(0, 2));
    expect(keys(await bucket.list(""))).toEqual([ASSET, ...KEYS]);
    expect(await bucket.list("reply/zz")).toEqual([]);
  });

  test("a stored name outside the grammar is listed as itself, and later keys still are", async () => {
    await bucket.put("reply/zz/1/ios", utf8("zz"));
    const unknown = b.plantUnknown();
    expect(await bucket.list("reply/")).toEqual([
      { unknown, size: 1 },
      { key: "reply/zz/1/ios", size: 2 },
    ]);
  });

  test("every entry carries its stored size, an empty object included", async () => {
    await bucket.put(ASSET, new Uint8Array(70_000));
    await bucket.put("reply/no-update", new Uint8Array());
    expect(await bucket.list("")).toEqual([
      { key: ASSET, size: 70_000 },
      { key: "reply/no-update", size: 0 },
    ]);
  });

  test("putIfAbsent on an existing key and putIfMatch with a stale ETag lose, leaving the bytes", async () => {
    const key = "reply/main/1/ios";
    const stale = await bucket.put(key, utf8("old"));
    expect(await bucket.putIfAbsent(key, utf8("absent"))).toBeUndefined();
    expect(b.stored(key)).toEqual(utf8("old"));

    const current = await bucket.put(key, utf8("current"));
    expect(await bucket.putIfMatch(key, utf8("stale"), stale)).toBeUndefined();
    expect(b.stored(key)).toEqual(utf8("current"));

    const next = await bucket.putIfMatch(key, utf8("next"), current);
    expect(next).toBeDefined();
    expect(await bucket.get(key, 100)).toEqual({ bytes: utf8("next"), etag: next });
    expect(await bucket.putIfAbsent("reply/main/2/ios", utf8("new"))).toBeDefined();
    expect(b.stored("reply/main/2/ios")).toEqual(utf8("new"));
  });

  test.each(["*", 'W/"abc"', '"a", "b"', '"a,b"', "abc", '""'])(
    "putIfMatch rejects the ETag %j before any I/O",
    async (etag) => {
      const before = b.requests();
      const error = await rejection(bucket.putIfMatch("reply/main/1/ios", utf8("x"), etag));
      expect(error).toMatchObject({
        message: "ETag must be one strong entity-tag",
        outcome: "failed",
      });
      expect(b.requests()).toBe(before);
      expect(b.stored("reply/main/1/ios")).toBeUndefined();
    },
  );

  test.each(["reply/main/1/web", "reply/../x/ios", "lock", "assets/AB"])(
    "every operation rejects the key %j before any I/O",
    async (key) => {
      const before = b.requests();
      for (const op of [
        bucket.get(key, 10),
        bucket.put(key, utf8("x")),
        bucket.putIfAbsent(key, utf8("x")),
        bucket.putIfMatch(key, utf8("x"), '"a"'),
        bucket.delete(key),
      ]) {
        const error = await rejection(op);
        expect(error.message).toBe("invalid store key");
      }
      expect(b.requests()).toBe(before);
    },
  );

  test("of two concurrent putIfAbsent calls, exactly one wins", async () => {
    const key = "reply/race/1/ios";
    const results = await Promise.all([
      bucket.putIfAbsent(key, utf8("first")),
      bucket.putIfAbsent(key, utf8("second")),
    ]);
    const winners = results.filter((r) => r !== undefined);
    expect(winners).toHaveLength(1);
    const won = results[0] === undefined ? "second" : "first";
    expect(b.stored(key)).toEqual(utf8(won));
    expect(await bucket.get(key, 100)).toEqual({ bytes: utf8(won), etag: winners[0] });
  });

  test("of two concurrent putIfMatch calls on one ETag, exactly one wins", async () => {
    const key = "reply/race/1/ios";
    const original = await bucket.put(key, utf8("original"));
    const results = await Promise.all([
      bucket.putIfMatch(key, utf8("first"), original),
      bucket.putIfMatch(key, utf8("second"), original),
    ]);
    const winners = results.filter((r) => r !== undefined);
    expect(winners).toHaveLength(1);
    expect(winners[0]).not.toBe(original);
    const won = results[0] === undefined ? "second" : "first";
    expect(b.stored(key)).toEqual(utf8(won));
  });

  test("time is the bucket's clock", async () => {
    expect(await bucket.time()).toBe(BUCKET_TIME);
  });
});
