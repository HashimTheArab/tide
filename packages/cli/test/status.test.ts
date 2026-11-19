import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, onTestFinished, test } from "vitest";

import type { StoredReply } from "@tide/protocol";
import type { FakeS3 } from "@tide/server/test/fake-s3";
import { MAX_REPLY_BYTES, diskPath, encodeStoredReply } from "@tide/protocol";
import { FAKE_S3, startFakeS3 } from "@tide/server/test/fake-s3";

import type { Bucket } from "../src/bucket.ts";
import { diskBucket } from "../src/disk.ts";
import { s3Bucket } from "../src/s3.ts";
import { fixture, tempRoot, utf8 } from "./helpers.ts";

const PACKAGE = new URL("../", import.meta.url);
const BIN = fileURLToPath(
  new URL(
    (
      JSON.parse(readFileSync(new URL("package.json", PACKAGE), "utf8")) as {
        bin: { tide: string };
      }
    ).bin.tide,
    PACKAGE,
  ),
);
const UPDATE_ID = "0f6a9a3e-6c1b-4c4e-9d55-2b8f3f7c1a90"; // manifest.json's id
const CREATED_AT = "2026-11-19T12:34:56.789Z"; // manifest.json's createdAt
const COMMIT_TIME = "2026-11-19T08:09:10.123Z"; // directive-rollback.json's commitTime
const BOUNDARY = "tide_fixture_boundary";
const MANIFEST = fixture("manifest.reply.json"); // Signed for runtime 1.0.0.
const ROLLBACK = fixture("rollback.reply.json");
const NO_UPDATE = fixture("no-update.reply.json");
const ascii = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

/** A manifest record over the golden multipart, changed by `edit`. */
const manifestWith = (edit: (multipart: string) => string, updateId = UPDATE_ID) =>
  encodeStoredReply({
    kind: "manifest",
    updateId,
    boundary: BOUNDARY,
    manifestFilters: 'branch="main"',
    body: utf8(edit(ascii(fixture("manifest.multipart")))),
  } satisfies StoredReply);
const rollbackWith = (edit: (multipart: string) => string) =>
  encodeStoredReply({
    kind: "rollBackToEmbedded",
    boundary: BOUNDARY,
    body: utf8(edit(ascii(fixture("rollback.multipart")))),
  });

/** Runs the `tide` bin as an executable, with `node` first on PATH, and only `env` besides. */
async function tide(env: Record<string, string>) {
  const proc = spawn(BIN, ["status"], {
    env: { ...env, PATH: `${dirname(process.execPath)}:/usr/bin:/bin` },
    stdio: ["ignore", "pipe", "pipe"],
  });
  onTestFinished(() => {
    proc.kill("SIGKILL");
  });
  let stdout = "";
  let stderr = "";
  proc.stdout.setEncoding("utf8").on("data", (s: string) => (stdout += s));
  proc.stderr.setEncoding("utf8").on("data", (s: string) => (stderr += s));
  const [code] = (await once(proc, "exit")) as [number | null];
  return { code, stdout, stderr };
}

let fake: FakeS3;
beforeAll(async () => {
  fake = await startFakeS3();
});
afterAll(() => fake.close());

interface Store {
  readonly bucket: Bucket;
  readonly env: Record<string, string>;
}

const stores: [string, () => Store][] = [
  [
    "disk",
    () => {
      const root = tempRoot();
      return { bucket: diskBucket(root), env: { TIDE_DISK_DIR: root } };
    },
  ],
  [
    "s3",
    () => {
      fake.objects.clear();
      return {
        bucket: s3Bucket({ ...FAKE_S3, endpoint: fake.endpoint }),
        env: {
          TIDE_S3_ENDPOINT: fake.endpoint,
          TIDE_S3_REGION: FAKE_S3.region,
          TIDE_S3_BUCKET: FAKE_S3.bucket,
          TIDE_S3_ACCESS_KEY_ID: FAKE_S3.accessKeyId,
          TIDE_S3_SECRET_ACCESS_KEY: FAKE_S3.secretAccessKey,
        },
      };
    },
  ],
];

/** Seeds manifests and rollbacks for several channels, runtimes and platforms. */
async function seed(bucket: Bucket) {
  await bucket.put("reply/main/1.0.0/ios", MANIFEST);
  await bucket.put("reply/Beta/1.0.0/android", MANIFEST);
  await bucket.put("reply/main/2.0.0/ios", ROLLBACK);
  await bucket.put("reply/main/exposdk:57.0.0/android", ROLLBACK);
}
const SEEDED = [
  `Beta 1.0.0 android manifest ${UPDATE_ID} ${CREATED_AT}`,
  `main 1.0.0 ios manifest ${UPDATE_ID} ${CREATED_AT}`,
  `main 2.0.0 ios rollBackToEmbedded - ${COMMIT_TIME}`,
  `main exposdk:57.0.0 android rollBackToEmbedded - ${COMMIT_TIME}`,
];
const lines = (...l: string[]) => l.map((s) => `${s}\n`).join("");

describe.each(stores)("tide status on %s", (_, open) => {
  test("prints every pointer and reports a missing reply/no-update", async () => {
    const { bucket, env } = open();
    await seed(bucket);
    expect(await tide(env)).toEqual({
      code: 0,
      stdout: lines(...SEEDED, "reply/no-update: missing"),
      stderr: "",
    });
  });

  test("reports a present reply/no-update", async () => {
    const { bucket, env } = open();
    await seed(bucket);
    await bucket.put("reply/no-update", NO_UPDATE);
    expect(await tide(env)).toEqual({
      code: 0,
      stdout: lines(...SEEDED, "reply/no-update: present"),
      stderr: "",
    });
  });

  // Each sorts before the readable pointer at reply/zz/1.0.0/ios.
  test.each<[string, string, Uint8Array<ArrayBuffer>, string]>([
    ["a garbage record", "reply/a/1.0.0/ios", utf8("garbage"), "not a stored reply"],
    ["a record over the size limit", "reply/a/1.0.0/ios", new Uint8Array(MAX_REPLY_BYTES + 1), ""],
    [
      "a pointer holding noUpdateAvailable",
      "reply/a/1.0.0/ios",
      NO_UPDATE,
      "holds noUpdateAvailable, which does not fit its key",
    ],
    [
      "a reply/no-update holding a manifest",
      "reply/no-update",
      MANIFEST,
      "holds manifest, which does not fit its key",
    ],
    [
      "a manifest part without expo-signature",
      "reply/a/1.0.0/ios",
      manifestWith((m) => m.replace(/expo-signature: [^\r]*\r\n/, "")),
      "manifest part has no expo-signature",
    ],
    [
      "a record whose updateId differs from the signed id",
      "reply/a/1.0.0/ios",
      manifestWith((m) => m, "00000000-0000-4000-8000-000000000000"),
      "manifest id differs from the record's updateId",
    ],
    [
      "a manifest under another runtime",
      "reply/a/2.0.0/ios",
      MANIFEST,
      "manifest runtimeVersion differs from its key",
    ],
    [
      "a manifest created on 30 February",
      "reply/a/1.0.0/ios",
      manifestWith((m) => m.replace(CREATED_AT, "2026-02-30T00:00:00.000Z")),
      "manifest createdAt is not a valid time",
    ],
    [
      "a rollback committed 'soon'",
      "reply/a/1.0.0/ios",
      rollbackWith((m) => m.replace(COMMIT_TIME, "soon")),
      "directive commitTime is not a valid time",
    ],
  ])("%s is unreadable, and later pointers still print", async (_, key, bytes, reason) => {
    const { bucket, env } = open();
    await bucket.put(key, bytes);
    await bucket.put("reply/zz/1.0.0/ios", MANIFEST);
    const { code, stdout, stderr } = await tide(env);
    expect(code).toBe(1);
    expect(stdout).toContain(`zz 1.0.0 ios manifest ${UPDATE_ID} ${CREATED_AT}\n`);
    expect(stderr).toContain(`${key}: unreadable: ${reason}`);
    const noUpdate = key === "reply/no-update" ? "unreadable" : "missing";
    expect(stdout.endsWith(`reply/no-update: ${noUpdate}\n`)).toBe(true);
  });

  test("a record holding a credential as a field name is reported without it", async () => {
    const { bucket, env } = open();
    const record = JSON.parse(ascii(MANIFEST)) as Record<string, unknown>;
    record[FAKE_S3.secretAccessKey] = FAKE_S3.accessKeyId;
    await bucket.put("reply/a/1.0.0/ios", utf8(JSON.stringify(record)));
    const { code, stderr } = await tide(env);
    expect(code).toBe(1);
    expect(stderr).toBe("reply/a/1.0.0/ios: unreadable: not a stored reply\n");
  });

  test("with no store configured, status exits 2", async () => {
    const before = fake.requests;
    const { code, stderr } = await tide({});
    expect(code).toBe(2);
    expect(stderr).toContain("no store configured");
    expect(fake.requests).toBe(before);
  });
});

describe("tide status on s3", () => {
  const env = () => ({
    TIDE_S3_ENDPOINT: fake.endpoint,
    TIDE_S3_REGION: FAKE_S3.region,
    TIDE_S3_BUCKET: FAKE_S3.bucket,
    TIDE_S3_ACCESS_KEY_ID: FAKE_S3.accessKeyId,
    TIDE_S3_SECRET_ACCESS_KEY: FAKE_S3.secretAccessKey,
  });

  test.each([
    ["length-secret", "S3 GetObject failed: network error"],
    ["gzip", "S3 GetObject returned 200 with an unsupported content-encoding"],
    ["no-etag", "S3 GetObject returned 200 with a missing or invalid ETag"],
  ] as const)(
    "a pointer answered with %s is reported, and later pointers still print",
    async (behaviour, reason) => {
      fake.objects.clear();
      fake.objects.set("reply/a/1.0.0/ios", MANIFEST);
      fake.behave("reply/a/1.0.0/ios", behaviour);
      fake.objects.set("reply/zz/1.0.0/ios", MANIFEST);
      const { code, stdout, stderr } = await tide(env());
      expect(code).toBe(1);
      expect(stdout).toBe(
        lines(`zz 1.0.0 ios manifest ${UPDATE_ID} ${CREATED_AT}`, "reply/no-update: missing"),
      );
      expect(stderr).toBe(`reply/a/1.0.0/ios: unreadable: ${reason}\n`);
      expect(stderr).not.toContain(FAKE_S3.secretAccessKey);
    },
  );

  test("a reply/no-update with no ETag is unreadable, not missing", async () => {
    fake.objects.clear();
    fake.objects.set("reply/no-update", NO_UPDATE);
    fake.behave("reply/no-update", "no-etag");
    fake.objects.set("reply/zz/1.0.0/ios", MANIFEST);
    const { code, stdout } = await tide(env());
    expect(code).toBe(1);
    expect(stdout).toBe(
      lines(`zz 1.0.0 ios manifest ${UPDATE_ID} ${CREATED_AT}`, "reply/no-update: unreadable"),
    );
  });

  test("a name outside the grammar is reported without printing it", async () => {
    fake.objects.clear();
    fake.objects.set(`reply/${FAKE_S3.secretAccessKey} x/1/ios`, MANIFEST);
    fake.objects.set("reply/zz/1.0.0/ios", MANIFEST);
    const { code, stdout, stderr } = await tide(env());
    expect(code).toBe(1);
    expect(stdout).toContain(`zz 1.0.0 ios manifest`);
    expect(stderr).toBe("reply/: unreadable: an object name outside the key grammar\n");
  });

  test("a failed listing exits 2 with a fixed message", async () => {
    fake.failAll({ status: 500, code: "InternalError" });
    try {
      expect(await tide(env())).toEqual({
        code: 2,
        stdout: "",
        stderr: "tide: S3 ListObjectsV2 failed: 500 InternalError\n",
      });
    } finally {
      fake.failAll(undefined);
    }
  });

  test("an invalid bucket exits 2 before any request", async () => {
    const before = fake.requests;
    const { code, stderr } = await tide({ ...env(), TIDE_S3_BUCKET: "a/b" });
    expect(code).toBe(2);
    expect(stderr).toBe(
      "tide: TIDE_S3_BUCKET: bucket must be 3 to 63 of a-z, 0-9, . and -, starting and ending alphanumeric\n",
    );
    expect(fake.requests).toBe(before);
  });
});

describe("tide status on disk", () => {
  test("a FIFO and a directory at pointer paths are unreadable, and later pointers still print", async () => {
    const root = tempRoot();
    const bucket = diskBucket(root);
    await bucket.put("reply/zz/1.0.0/ios", MANIFEST);
    const fifo = join(root, diskPath("reply/a/1.0.0/ios"));
    mkdirSync(dirname(fifo), { recursive: true });
    execFileSync("mkfifo", [fifo]);
    mkdirSync(join(root, diskPath("reply/b/1.0.0/ios")), { recursive: true });
    mkdirSync(join(root, diskPath("reply/no-update")), { recursive: true });
    const { code, stdout, stderr } = await tide({ TIDE_DISK_DIR: root });
    expect(code).toBe(1);
    expect(stdout).toBe(
      lines(`zz 1.0.0 ios manifest ${UPDATE_ID} ${CREATED_AT}`, "reply/no-update: unreadable"),
    );
    expect(stderr).toBe(
      lines(
        `reply/a/1.0.0/ios: unreadable: disk bucket ${root} not a regular file`,
        `reply/b/1.0.0/ios: unreadable: disk bucket ${root} not a regular file`,
        `reply/no-update: unreadable: disk bucket ${root} not a regular file`,
      ),
    );
  });

  test("a file where the reply directory belongs fails status instead of reporting nothing", async () => {
    const root = tempRoot();
    writeFileSync(join(root, "reply"), "x");
    expect(await tide({ TIDE_DISK_DIR: root })).toEqual({
      code: 2,
      stdout: "",
      stderr: `tide: disk bucket ${root} failed: ENOTDIR\n`,
    });
  });
});
