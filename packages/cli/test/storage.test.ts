import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, test } from "vitest";

import { LEGACY_MAP_KEY, baseKey, contentKey, sha256Base64Url } from "@tide/protocol";

import { FAKE_S3 } from "../../server/test/fakes/s3.ts";
import { byteOrder } from "../src/bucket.ts";
import { encodeRecord, recordKey } from "../src/publish-record.ts";
import { republish, rollback } from "../src/publish-rollback.ts";
import { publish } from "../src/publish.ts";
import { registerBuild } from "../src/register-build.ts";
import { bucketFromEnv } from "../src/storage.ts";
import { run, tempRoot, utf8 } from "./helpers.ts";
import {
  ASSET_URL,
  EXPORT,
  IOS,
  MAIN,
  SERVER_URL,
  diskObjects,
  env,
  project,
  s3,
  s3Env,
  s3Snapshot,
  signedManifest,
  tree,
  useFixture,
} from "./publish-fixture.ts";

useFixture();

const STORES = {
  disk: (root = tempRoot()) => ({
    root,
    env: { TIDE_DISK_DIR: root },
    objects: () => diskObjects(root),
    snapshot: () => tree(root),
    /** Stores `bytes` under any name, around the adapter. */
    plant: (name: string, bytes: Uint8Array) => {
      mkdirSync(dirname(join(root, name)), { recursive: true });
      writeFileSync(join(root, name), bytes);
    },
  }),
  s3: () => ({
    root: undefined,
    env: s3Env(),
    objects: () => s3.objects,
    snapshot: s3Snapshot,
    plant: (name: string, bytes: Uint8Array) => {
      s3.objects.set(name, bytes);
    },
  }),
};
type Store = ReturnType<(typeof STORES)[keyof typeof STORES]>;

const COMMANDS = { publish, rollback, republish, "register-build": registerBuild };
const UPDATE_ID = "6f9619ff-8b86-4d01-b42d-00cf4fc964ff";
const SUMMARY = (n: number, total: bigint | number) => `${n} unreferenced objects, ${total} bytes`;

/** Runs a write command in process, failing the test unless it succeeds. */
async function write(command: keyof typeof COMMANDS, args: string[], environment: Env) {
  const err: string[] = [];
  const code = await COMMANDS[command](args, environment, {
    out: () => undefined,
    err: (l) => err.push(l),
  });
  expect({ code, err }).toEqual({ code: 0, err: [] });
}
type Env = Record<string, string>;

/** The writer configuration over `store`, without the URLs only publish needs. */
function writerEnv(store: Store): Env {
  const { TIDE_SERVER_URL: _s, TIDE_ASSET_URL: _a, ...rest } = env(store.env);
  return rest;
}

/** Runs `tide storage` through the bin with only the bucket variables. */
const storage = (store: Store) => run(MAIN, ["storage"], store.env);

const contentOf = async (prefix: "assets" | "bundles", bytes: Uint8Array<ArrayBuffer>) =>
  `${prefix}/${contentKey(await sha256Base64Url(bytes))}`;

/** The exact report for `rows`, each a stored name, how it prints, and its bytes. */
function report(rows: readonly (readonly [string, string, Uint8Array])[]): string {
  const sorted = [...rows].sort(([a], [b]) => byteOrder(a, b));
  const total = sorted.reduce((n, [, , bytes]) => n + bytes.length, 0);
  const lines = sorted.map(([, printed, bytes]) => `${printed} ${bytes.length}`);
  return `${[...lines, SUMMARY(sorted.length, total)].join("\n")}\n`;
}

/** A copy of the fixture export whose iOS bundle has other bytes and whose iOS update drops the font. */
function exportB(): string {
  const dir = join(tempRoot(), "export");
  cpSync(EXPORT, dir, { recursive: true });
  writeFileSync(join(dir, "_expo", "static", "js", "ios", "index-ios.hbc"), "// B\n");
  const metadata = JSON.parse(readFileSync(join(dir, "metadata.json"), "utf8")) as {
    fileMetadata: { ios: { assets: { ext: string }[] } };
  };
  const ios = metadata.fileMetadata.ios;
  ios.assets = ios.assets.filter((a) => a.ext !== "ttf");
  writeFileSync(join(dir, "metadata.json"), JSON.stringify(metadata));
  return dir;
}

/** A release record for `UPDATE_ID` naming `launch` as its bundle. */
async function record(launch: Uint8Array<ArrayBuffer>) {
  return encodeRecord({
    updateId: UPDATE_ID,
    channel: "main",
    runtimeVersion: "1.0.0",
    platform: "ios",
    createdAt: "2026-01-01T00:00:00.000Z",
    serverUrl: SERVER_URL,
    assetUrl: ASSET_URL,
    launchAsset: { hash: await sha256Base64Url(launch) },
    assets: [],
    extra: {},
  });
}

/** Fails unless `result` is exit 1 with nothing on stdout and exactly `message` on stderr, holding no credential. */
function expectFailure(result: Awaited<ReturnType<typeof storage>>, message: string) {
  expect(result).toEqual({ code: 1, stdout: "", stderr: `tide: ${message}\n` });
  expect(result.stderr).not.toContain(FAKE_S3.accessKeyId);
  expect(result.stderr).not.toContain(FAKE_S3.secretAccessKey);
}

describe.each(Object.keys(STORES) as (keyof typeof STORES)[])("on %s", (kind) => {
  const open = (): Store => STORES[kind]();

  test("after publishes, a rollback and a republish, exactly the unreferenced objects are listed and nothing changes", async () => {
    const store = open();
    const app = project();
    const common = ["--runtime-version", "1.0.0", "--project-root", app.root];
    // R1 (iOS) and R2 (Android), then R3 on iOS without the font, then Android rolled back.
    await write(
      "publish",
      ["--channel", "main", "--export-dir", EXPORT, ...common],
      env(store.env),
    );
    const b = exportB();
    const ios = ["--channel", "main", "--platform", "ios", "--export-dir", b, ...common];
    await write("publish", ios, env(store.env));
    const embedded = ["--embedded", "--channel", "main", "--platform", "android", ...common];
    await write("rollback", embedded, writerEnv(store));
    const r3 = (await signedManifest(store.objects(), IOS)).manifest.id;
    await write(
      "republish",
      [r3, "--channel", "beta", "--project-root", app.root],
      writerEnv(store),
    );
    const build = tempRoot();
    writeFileSync(join(build, "app.manifest"), JSON.stringify({ id: UPDATE_ID, assets: [] }));
    writeFileSync(join(build, "main.jsbundle"), "embedded");
    await write(
      "register-build",
      [
        ...["--platform", "ios", "--runtime-version", "1.0.0"],
        ...["--manifest", join(build, "app.manifest"), "--bundle", join(build, "main.jsbundle")],
      ],
      store.env,
    );

    // Each object below is protected by one traversal alone, so dropping any traversal changes the report. Every
    // update's bundle has two roots, its release record and its base record.
    const exported = (path: string) => new Uint8Array(readFileSync(join(EXPORT, path)));
    const protectedKeys = [
      await contentOf("assets", exported("assets/75d117bbd0d2fe64c29bb45b5abe285e")), // The font, only in R1.
      await contentOf("bundles", utf8("embedded")), // Only in the registered build.
    ];
    const bucket = bucketFromEnv(store.env);
    const stored = async (prefix: "assets" | "bundles", bytes: Uint8Array<ArrayBuffer>) => {
      const key = await contentOf(prefix, bytes);
      await bucket.putIfAbsent(key, bytes, "application/octet-stream");
      return key;
    };
    const mapped = utf8("mapped");
    const mappedKey = await stored("assets", mapped);
    const unreferenced = [
      [await stored("bundles", utf8("orphan bundle")), utf8("orphan bundle")],
      [await stored("assets", utf8("orphan asset")), utf8("orphan asset")],
    ].map(([k, v]) => [k, k, v] as [string, string, Uint8Array]);
    const odd: [string, string, Uint8Array][] = [
      ["assets/readme", '"assets/readme"', utf8("xy")],
      ["assets/rea\u0007me", '"assets/rea\\u0007me"', utf8("zz")],
      ["updates/notes.txt", '"updates/notes.txt"', utf8("notes")],
    ];
    for (const [name, printed, bytes] of odd) {
      store.plant(name, bytes);
      expect(JSON.parse(printed)).toBe(name);
    }
    // Never reported: base records are roots, and patches are served only beside their bundles.
    for (const name of [
      "bases/notes.txt",
      "patches/notes",
      `patches/${"a".repeat(64)}/${"b".repeat(64)}`,
    ]) {
      store.plant(name, utf8("never reported"));
    }
    for (const key of protectedKeys) expect(store.objects().has(key), key).toBe(true);

    const before = await storage(store);
    expect(before).toEqual({
      code: 0,
      stdout: report([...unreferenced, ...odd, [mappedKey, mappedKey, mapped]]),
      stderr: "",
    });

    await bucket.put(LEGACY_MAP_KEY, utf8(JSON.stringify({ version: 1, keys: [mappedKey] })));
    const snapshot = store.snapshot();
    const [puts, deletes] = [s3.puts.length, s3.deletes.length];
    expect(await storage(store)).toEqual({
      code: 0,
      stdout: report([...unreferenced, ...odd]),
      stderr: "",
    });
    expect(store.snapshot()).toEqual(snapshot);
    expect([s3.puts.length, s3.deletes.length]).toEqual([puts, deletes]);
  });

  test("an empty bucket reports nothing", async () => {
    expect(await storage(open())).toEqual({ code: 0, stdout: `${SUMMARY(0, 0)}\n`, stderr: "" });
  });

  test.each([
    [
      "a record that is valid JSON but not a record",
      recordKey(UPDATE_ID),
      utf8(`{"version":1,"updateId":"${UPDATE_ID}","channel":{"toString":null}}`),
      `${recordKey(UPDATE_ID)} is unreadable: record.channel must be a string`,
    ],
    [
      "a record that names another ID",
      "updates/0f6a9a3e-6c1b-4c4e-9d55-2b8f3f7c1a90.json",
      undefined,
      "updates/0f6a9a3e-6c1b-4c4e-9d55-2b8f3f7c1a90.json is unreadable: its updateId differs from its name",
    ],
    [
      "a base record that does not decode",
      baseKey(UPDATE_ID),
      utf8("{}"),
      `${baseKey(UPDATE_ID)} is unreadable: version must be an integer`,
    ],
    [
      "a legacy map with a trailing newline",
      LEGACY_MAP_KEY,
      utf8(`{"version":1,"keys":[]}\n`),
      `${LEGACY_MAP_KEY} is unreadable: not in the form tide writes`,
    ],
    [
      "a legacy map out of order",
      LEGACY_MAP_KEY,
      utf8(
        JSON.stringify({
          version: 1,
          keys: [`bundles/${"0".repeat(64)}`, `assets/${"0".repeat(64)}`],
        }),
      ),
      `${LEGACY_MAP_KEY} is unreadable: not in the form tide writes`,
    ],
    [
      "a legacy map naming a record",
      LEGACY_MAP_KEY,
      utf8(JSON.stringify({ version: 1, keys: [recordKey(UPDATE_ID)] })),
      `${LEGACY_MAP_KEY} is unreadable: not in the form tide writes`,
    ],
  ])("%s fails the report", async (_, key, bytes, message) => {
    const store = open();
    await bucketFromEnv(store.env).put(key, bytes ?? (await record(utf8("launch"))));
    expectFailure(await storage(store), message);
  });
});

describe("on S3", () => {
  test("a listing failure prints only the operation, status and an allowlisted code", async () => {
    s3.failAll({ status: 403, code: "LeakyCode" });
    expectFailure(
      await storage(STORES.s3()),
      "assets/ cannot be listed: S3 ListObjectsV2 failed: 403 with an unrecognised error code",
    );
  });

  test.each([recordKey(UPDATE_ID), LEGACY_MAP_KEY])(
    "a read failure of %s fails the report without provider text",
    async (key) => {
      s3.objects.set(key, await record(utf8("launch")));
      s3.behave(key, "access-denied");
      expectFailure(
        await storage(STORES.s3()),
        `${key} is unreadable: S3 GetObject failed: 403 AccessDenied`,
      );
    },
  );

  test("sizes past 2^53 are totalled exactly", async () => {
    const keys = ["aa", "bb", "cc"].map((b) => `assets/${b.repeat(32)}`);
    for (const key of keys) {
      s3.objects.set(key, utf8("x"));
      s3.listSize(key, String(Number.MAX_SAFE_INTEGER));
    }
    const rows = keys.map((k) => `${k} ${Number.MAX_SAFE_INTEGER}\n`).join("");
    const total = 3n * BigInt(Number.MAX_SAFE_INTEGER);
    expect(await storage(STORES.s3())).toEqual({
      code: 0,
      stdout: `${rows}${SUMMARY(3, total)}\n`,
      stderr: "",
    });
  });

  test("a prefix with more objects than a call takes arguments is reported in full", async () => {
    s3.listPage(1000); // S3's own page size.
    const keys = Array.from(
      { length: 130_000 },
      (_, i) => `assets/${i.toString(16).padStart(64, "0")}`,
    );
    const empty = new Uint8Array();
    for (const key of keys) s3.objects.set(key, empty);
    const { code, stdout, stderr } = await storage(STORES.s3());
    expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
    const expected = `${keys.map((k) => `${k} 0\n`).join("")}${SUMMARY(keys.length, 0)}\n`;
    expect(stdout.length).toBe(expected.length);
    expect(stdout === expected).toBe(true); // A boolean, so a failure does not diff megabytes.
  });

  test("a record committed after updates/ is listed protects nothing in that run, and does in the next", async () => {
    const store = STORES.s3();
    const app = project();
    const args = ["--channel", "main", "--platform", "ios", "--runtime-version", "1.0.0"];
    await write(
      "publish",
      [...args, "--export-dir", EXPORT, "--project-root", app.root],
      env(store.env),
    );
    const key = [...s3.objects.keys()].find((k) => k.startsWith("updates/"))!;
    const bytes = s3.objects.get(key)!;
    s3.objects.delete(key);
    s3.objects.delete(IOS);
    // Its base record would protect the bundle in both runs.
    s3.objects.delete([...s3.objects.keys()].find((k) => k.startsWith("bases/"))!);
    s3.onList("updates/", () => s3.objects.set(key, bytes));
    const content = [...s3.objects]
      .filter(([k]) => /^(?:assets|bundles)\//.test(k))
      .map(([k, v]) => [k, k, v] as const);
    expect(content).toHaveLength(4); // The bundle, png, ttf and html.
    expect(await storage(store)).toEqual({ code: 0, stdout: report(content), stderr: "" });
    expect(await storage(store)).toEqual({ code: 0, stdout: `${SUMMARY(0, 0)}\n`, stderr: "" });
  });
});

describe("on disk", () => {
  test("a listing that cannot reach a prefix fails the report", async () => {
    const store = STORES.disk();
    writeFileSync(join(store.root, "assets"), "x");
    expectFailure(
      await storage(store),
      `assets/ cannot be listed: disk bucket ${store.root} failed: ENOTDIR`,
    );
  });

  test("a record stored under a directory named in another case still protects its content", async () => {
    const store = STORES.disk();
    // On a case-insensitive volume the writer accepts this directory as updates/.
    mkdirSync(join(store.root, "Updates"));
    const args = ["--channel", "main", "--platform", "ios", "--runtime-version", "1.0.0"];
    await write(
      "publish",
      [...args, "--export-dir", EXPORT, "--project-root", project().root],
      env(store.env),
    );
    expect(await storage(store)).toEqual({ code: 0, stdout: `${SUMMARY(0, 0)}\n`, stderr: "" });
  });

  test("a directory at a record key fails the report", async () => {
    const store = STORES.disk();
    mkdirSync(join(store.root, recordKey(UPDATE_ID)), { recursive: true });
    expectFailure(
      await storage(store),
      `${recordKey(UPDATE_ID)} is unreadable: disk bucket ${store.root} not a regular file`,
    );
  });
});

describe("usage", () => {
  test("an argument is a usage error and a missing bucket a configuration error, each exit 2", async () => {
    const usage = await run(MAIN, ["storage", "x"], { TIDE_DISK_DIR: tempRoot() });
    expect(usage.code).toBe(2);
    expect(usage.stderr).toContain("usage: tide storage\n");
    const config = await run(MAIN, ["storage"], {});
    expect(config).toMatchObject({ code: 2, stdout: "" });
    expect(config.stderr).toMatch(/^tide: /);
  });
});
