import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

import { diskPath } from "@tide/protocol";

import { BucketError } from "../src/bucket.ts";
import { diskBucket } from "../src/disk.ts";
import { child, rejection, tempRoot, utf8 } from "./helpers.ts";

const WRITER = fileURLToPath(new URL("disk-writer.ts", import.meta.url));
const KEY = "reply/main/1.0.0/ios";
const path = (root: string, key = KEY) => join(root, diskPath(key));
const staged = (root: string) => readdirSync(join(root, ".tide", "tmp"));

/** Starts a writer process and waits until it is ready to run its operation. */
async function writer(root: string, op: string, payload: string, etag = "") {
  const w = child(WRITER, [root, op, KEY, payload, etag]);
  expect(await w.line()).toBe(op === "hold" ? "held" : "ready");
  return w;
}

describe("independent processes", () => {
  test("of two putIfAbsent calls on a fresh root, exactly one wins and nothing stays staged", async () => {
    const root = tempRoot();
    const writers = [
      await writer(root, "putIfAbsent", "first"),
      await writer(root, "putIfAbsent", "second"),
    ];
    for (const w of writers) w.send("go");
    const results = await Promise.all(
      writers.map(async (w) => JSON.parse(await w.line()) as { etag?: string | null }),
    );
    const won = results.findIndex((r) => typeof r.etag === "string");
    expect(won).not.toBe(-1);
    expect(results[1 - won]).toEqual({ etag: null }); // A lost race, not an error.
    expect(readFileSync(path(root), "utf8")).toBe(won === 0 ? "first" : "second");
    expect(staged(root)).toEqual([]);
  });

  test("of two putIfMatch calls on one ETag, exactly one wins", async () => {
    const root = tempRoot();
    const original = await diskBucket(root).put(KEY, utf8("original"));
    const writers = [
      await writer(root, "putIfMatch", "first", original),
      await writer(root, "putIfMatch", "second", original),
    ];
    for (const w of writers) w.send("go");
    const results = await Promise.all(
      writers.map(async (w) => JSON.parse(await w.line()) as { etag?: string | null }),
    );
    const won = results.findIndex((r) => typeof r.etag === "string");
    expect(won).not.toBe(-1);
    expect(results[won]?.etag).not.toBe(original);
    expect(results[1 - won]).toEqual({ etag: null });
    expect(readFileSync(path(root), "utf8")).toBe(won === 0 ? "first" : "second");
    expect(staged(root)).toEqual([]);
  });

  test("a writer inside its critical section blocks every mutation, until it dies", async () => {
    const root = tempRoot();
    const bucket = diskBucket(root, { busyTimeoutMs: 0 });
    const etag = await bucket.put(KEY, utf8("stored"));
    const holder = await writer(root, "hold", "");
    for (const op of [
      bucket.put(KEY, utf8("x")),
      bucket.putIfAbsent("reply/main/2/ios", utf8("x")),
      bucket.putIfMatch(KEY, utf8("x"), etag),
      bucket.delete(KEY),
    ]) {
      expect(await rejection(op)).toMatchObject({
        message: `disk bucket ${root} busy`,
        outcome: "failed",
      });
    }
    expect(readFileSync(path(root), "utf8")).toBe("stored");
    expect(existsSync(path(root, "reply/main/2/ios"))).toBe(false);
    expect(staged(root)).toEqual([]);

    holder.proc.kill("SIGKILL");
    await holder.exited;
    expect(await bucket.putIfMatch(KEY, utf8("after"), etag)).toBeDefined();
    expect(readFileSync(path(root), "utf8")).toBe("after");
  });
});

describe("disk bucket", () => {
  test("a FIFO at a key fails get and putIfMatch without blocking, and the mutex is released", async () => {
    const root = tempRoot();
    const bucket = diskBucket(root, { busyTimeoutMs: 0 });
    mkdirSync(join(path(root), ".."), { recursive: true });
    execFileSync("mkfifo", [path(root)]);
    expect(await rejection(bucket.get(KEY, 100))).toMatchObject({
      message: `disk bucket ${root} not a regular file`,
    });
    expect(await rejection(bucket.putIfMatch(KEY, utf8("x"), '"a"'))).toMatchObject({
      message: `disk bucket ${root} not a regular file`,
      outcome: "failed",
    });
    // busyTimeoutMs is 0, so this succeeds only if the failed write released the mutex.
    expect(await bucket.put("reply/main/2/ios", utf8("x"))).toBeDefined();
  });

  test("a directory at a key is listed and fails get and every write", async () => {
    const root = tempRoot();
    const bucket = diskBucket(root);
    mkdirSync(path(root), { recursive: true });
    expect(await bucket.list("reply/")).toEqual([{ key: KEY }]);
    expect(await rejection(bucket.get(KEY, 100))).toMatchObject({
      message: `disk bucket ${root} not a regular file`,
    });
    expect(await bucket.putIfAbsent(KEY, utf8("x"))).toBeUndefined();
    for (const op of [
      bucket.put(KEY, utf8("x")),
      bucket.putIfMatch(KEY, utf8("x"), '"a"'),
      bucket.delete(KEY),
    ]) {
      const error = await rejection(op);
      expect(error).toBeInstanceOf(BucketError);
      expect(error).toMatchObject({ outcome: "failed" });
    }
    expect(staged(root)).toEqual([]);
  });

  test.each([
    ["a regular file", (root: string) => writeFileSync(join(root, "reply"), "x")],
    ["a symlink to a directory", (root: string) => symlinkSync(tempRoot(), join(root, "reply"))],
  ])("%s at reply/ fails the listing rather than hiding every pointer", async (_, plant) => {
    const root = tempRoot();
    plant(root);
    expect(await rejection(diskBucket(root).list("reply/"))).toMatchObject({
      message: `disk bucket ${root} failed: ENOTDIR`,
    });
  });

  test.each([
    ["a regular file at .tide", (root: string) => writeFileSync(join(root, ".tide"), "x")],
    [
      "a symlink at .tide/tmp",
      (root: string) => {
        mkdirSync(join(root, ".tide"));
        symlinkSync(tempRoot(), join(root, ".tide", "tmp"));
      },
    ],
  ])("%s makes writes fail and nothing is written outside the root", async (_, plant) => {
    const root = tempRoot();
    plant(root);
    expect(await rejection(diskBucket(root).put(KEY, utf8("x")))).toMatchObject({
      message: `disk bucket ${root} unavailable`,
      outcome: "failed",
    });
    expect(existsSync(path(root))).toBe(false);
  });

  test("putIfMatch on an absent key is a lost race", async () => {
    const root = tempRoot();
    expect(await diskBucket(root).putIfMatch(KEY, utf8("x"), '"a"')).toBeUndefined();
    expect(existsSync(path(root))).toBe(false);
  });

  test("a root removed after start is an outage, never recreated", async () => {
    const root = tempRoot();
    const bucket = diskBucket(root);
    expect(await bucket.get(KEY, 100)).toBeUndefined();
    expect(await bucket.list("reply/")).toEqual([]);
    rmSync(root, { recursive: true });
    for (const op of [
      bucket.get(KEY, 100),
      bucket.delete(KEY),
      bucket.list("reply/"),
      bucket.put(KEY, utf8("x")),
    ]) {
      expect(await rejection(op)).toMatchObject({ message: `disk bucket ${root} unavailable` });
    }
    expect(existsSync(root)).toBe(false);
  });

  test("an unreadable directory fails only the listings that can reach it", async () => {
    const root = tempRoot();
    const bucket = diskBucket(root);
    await bucket.put(KEY, utf8("x"));
    const assets = join(root, "assets");
    mkdirSync(assets);
    chmodSync(assets, 0);
    try {
      expect(() => readdirSync(assets)).toThrow(); // Holds only without a permission bypass such as root.
      expect(await bucket.list("reply/")).toEqual([{ key: KEY }]);
      expect(await rejection(bucket.list(""))).toMatchObject({
        message: `disk bucket ${root} failed: EACCES`,
      });
      chmodSync(join(root, "reply"), 0);
      expect(await rejection(bucket.list("reply/"))).toMatchObject({
        message: `disk bucket ${root} failed: EACCES`,
      });
    } finally {
      chmodSync(assets, 0o755);
      chmodSync(join(root, "reply"), 0o755);
    }
  });

  test("a listing never leaves the root", async () => {
    const parent = tempRoot();
    const root = join(parent, "bucket");
    mkdirSync(root);
    mkdirSync(join(parent, "reply"));
    writeFileSync(join(parent, "reply", "no-update"), "outside");
    expect(await diskBucket(root).list("../")).toEqual([]);
    expect(await diskBucket(root).list("")).toEqual([]);
  });

  test("reads write nothing", async () => {
    const root = tempRoot();
    const bucket = diskBucket(root);
    await bucket.get(KEY, 100);
    await bucket.list("");
    await bucket.time();
    expect(readdirSync(root)).toEqual([]);
  });
});
