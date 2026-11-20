import { appendFileSync, cpSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

import {
  NO_UPDATE_KEY,
  baseKey,
  decodeBaseRecord,
  decodeStoredReply,
  sha256Base64Url,
} from "@tide/protocol";

import type { Manifest } from "./publish-fixture.ts";
import { runEntry } from "../../server/test/node/entry.ts";
import { diskBucket } from "../src/disk.ts";
import { decodeRecord, recordKey } from "../src/publish-record.ts";
import { republish, rollback } from "../src/publish-rollback.ts";
import { publish } from "../src/publish.ts";
import { run, tempRoot, utf8 } from "./helpers.ts";
import {
  ANDROID,
  EXPORT,
  IOS,
  MAIN,
  MISMATCH,
  T,
  artifact,
  diskObjects,
  env,
  identity,
  main,
  other,
  pins,
  s3,
  s3Env,
  s3Snapshot,
  seededPointer,
  signedManifest,
  signedPart,
  tree,
  useFixture,
} from "./publish-fixture.ts";

useFixture();

const BETA = "reply/beta/1.0.0/ios";
const OTHER_IDENTITY =
  "this bucket's replies are signed by a different certificate or key ID: a new signing identity needs a new bucket";
const UNKNOWN_ID = "6f9619ff-8b86-4d01-b42d-00cf4fc964ff";
const STALE = (key: string) =>
  `${key} was changed by another writer since it was read; it keeps theirs`;
const COMMANDS = { publish, rollback, republish };

type Store = ReturnType<(typeof STORES)[keyof typeof STORES]>;

const content = (snapshot: Map<string, string>) =>
  new Map([...snapshot].filter(([k]) => /^(?:bundles|assets)\//.test(k)));

const STORES = {
  disk: (root = tempRoot()) => {
    return {
      root,
      env: { TIDE_DISK_DIR: root },
      objects: () => diskObjects(root),
      snapshot: () => tree(root),
    };
  },
  s3: () => ({
    root: undefined,
    env: s3Env(),
    objects: () => s3.objects,
    snapshot: s3Snapshot,
  }),
};

/** The writer configuration over `store`, without the URLs only publish needs. */
function writerEnv(store: Store, id = main): Record<string, string> {
  const { TIDE_SERVER_URL: _s, TIDE_ASSET_URL: _a, ...rest } = env(store.env, id);
  return rest;
}

/** Runs a write command in process; returns the exit code and output lines. */
async function cmd(
  command: keyof typeof COMMANDS,
  args: string[],
  environment: Record<string, string>,
  now?: () => number,
) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await COMMANDS[command](args, environment, {
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    ...(now && { now }),
  });
  return { code, out, err };
}

/** A copy of the fixture export whose iOS bundle has other bytes, so its update cannot pass for A's. */
function exportB(): string {
  const dir = join(tempRoot(), "export");
  cpSync(EXPORT, dir, { recursive: true });
  appendFileSync(join(dir, "_expo", "static", "js", "ios", "index-ios.hbc"), "// B\n");
  return dir;
}

/** Publishes an iOS-only export of `dist` to channel main and returns the stored manifest. */
async function publishIos(
  store: Store,
  dist = EXPORT,
  now?: () => number,
  id = main,
): Promise<Manifest> {
  const dir = artifact({ dist, fields: { platforms: { ios: { runtimeVersion: "1.0.0" } } } });
  const result = await cmd(
    "publish",
    ["--channel", "main", "--from", dir],
    env(store.env, id),
    now,
  );
  expect(result.err).toEqual([]);
  return (await signedManifest(store.objects(), IOS)).manifest;
}

/** Starts the real Node server over `store`. */
async function serve(store: Store) {
  const server = runEntry(store.env);
  const port = await server.listening;
  return {
    manifest: (channel: string, platform: string, current?: string) =>
      fetch(`http://127.0.0.1:${port}/manifest`, {
        headers: {
          "expo-platform": platform,
          "expo-channel-name": channel,
          "expo-runtime-version": "1.0.0",
          "expo-protocol-version": "1",
          accept: "multipart/mixed",
          ...(current && { "expo-current-update-id": current }),
        },
      }),
    /** The SHA-256 of the bytes this server returns for a signed URL's path. */
    hashAt: async (url: string) => {
      const res = await fetch(`http://127.0.0.1:${port}${new URL(url).pathname}`);
      expect(res.status).toBe(200);
      return await sha256Base64Url(new Uint8Array(await res.arrayBuffer()));
    },
  };
}

/** Checks a served manifest reply against the stored one byte for byte, and returns the manifest the client verifies. */
async function servedManifest(res: Response, store: Store, key: string) {
  const stored = decodeStoredReply(store.objects().get(key)!);
  if (stored.kind !== "manifest") throw new Error(`${key} is not a manifest`);
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toBe(`multipart/mixed; boundary=${stored.boundary}`);
  expect(res.headers.get("expo-manifest-filters")).toBe(stored.manifestFilters);
  const body = new Uint8Array(await res.arrayBuffer());
  expect(body).toEqual(stored.body);
  return (await signedPart(body, stored.boundary, "manifest")) as Manifest;
}

/** Fails unless `bases/<id>` is the update base record of `manifest`. */
function expectBase(store: Store, manifest: Manifest, platform: string) {
  expect(decodeBaseRecord(store.objects().get(baseKey(manifest.id))!)).toEqual({
    kind: "update",
    updateId: manifest.id,
    runtimeVersion: manifest.runtimeVersion,
    platform,
    launchAsset: { hash: manifest.launchAsset.hash },
  });
}

/** The parts of a manifest a republish must carry over unchanged. */
const code = (m: Manifest) => ({
  runtimeVersion: m.runtimeVersion,
  launchAsset: m.launchAsset,
  assets: m.assets,
  extra: m.extra,
});

describe.each(Object.keys(STORES) as (keyof typeof STORES)[])("on %s", (kind) => {
  const open = () => STORES[kind]();

  test("rollback --embedded through the bin is served as a signed rollBackToEmbedded after the pointer it replaces", async () => {
    const store = open();
    // A pointer ahead of the clock, and no reply/no-update to repair.
    const ahead = Math.floor(Date.now() / 1000) * 1000 + 3_600_000;
    await put(store, IOS, await seededPointer("manifest", ahead));
    const args = ["--embedded", "--channel", "main", "--runtime-version", "1.0.0"];
    const result = await run(
      MAIN,
      ["rollback", ...args, "--platform", "ios"],
      writerEnv(store),
      tempRoot(),
    );
    const commitTime = new Date(ahead + 1).toISOString();
    expect(result).toEqual({ code: 0, stdout: `${IOS} - ${commitTime}\n`, stderr: "" });

    const stored = decodeStoredReply(store.objects().get(IOS)!);
    expect(stored.kind).toBe("rollBackToEmbedded");
    const server = await serve(store);
    // The client still runs the update the rollback replaces.
    const res = await server.manifest("main", "ios", "0f6a9a3e-6c1b-4c4e-9d55-2b8f3f7c1a90");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe(`multipart/mixed; boundary=${stored.boundary}`);
    expect(res.headers.has("expo-manifest-filters")).toBe(false);
    const body = new Uint8Array(await res.arrayBuffer());
    expect(body).toEqual(stored.body);
    expect(await signedPart(body, stored.boundary, "directive")).toEqual({
      type: "rollBackToEmbedded",
      parameters: { commitTime },
    });
    // The repaired reply/no-update is signed under the identity.
    const noUpdate = decodeStoredReply(store.objects().get(NO_UPDATE_KEY)!);
    expect(await signedPart(noUpdate.body, noUpdate.boundary, "directive")).toEqual({
      type: "noUpdateAvailable",
    });
  });

  test("republish onto another channel keeps the code and URLs, under a new ID and record, uploading nothing", async () => {
    const store = open();
    const a = await publishIos(store);
    const before = store.snapshot();
    s3.puts.length = 0;
    const result = await cmd("republish", [a.id, "--channel", "beta"], writerEnv(store));
    expect(result.err).toEqual([]);
    expect(result.code).toBe(0);

    const { reply, manifest } = await signedManifest(store.objects(), BETA);
    expect(result.out).toEqual([`${BETA} ${manifest.id} ${manifest.createdAt}`]);
    expect(manifest.id).not.toBe(a.id);
    expect(code(manifest)).toEqual(code(a));
    expect(manifest.createdAt > a.createdAt).toBe(true);
    expect(manifest.metadata).toEqual({ channel: "beta" });
    expect(reply.manifestFilters).toBe('channel="beta"');
    const record = decodeRecord(store.objects().get(recordKey(manifest.id))!);
    expect(record).toMatchObject({
      updateId: manifest.id,
      channel: "beta",
      platform: "ios",
      createdAt: manifest.createdAt,
      extra: a.extra,
    });
    expect(content(store.snapshot())).toEqual(content(before));
    expect(store.snapshot().get(IOS)).toEqual(before.get(IOS));
    expectBase(store, manifest, "ios");
    if (kind === "s3")
      expect(s3.puts).toEqual([recordKey(manifest.id), baseKey(manifest.id), BETA]);

    const server = await serve(store);
    const served = await servedManifest(await server.manifest("beta", "ios"), store, BETA);
    expect(served).toEqual(manifest);
    expect(await server.hashAt(served.launchAsset.url)).toBe(a.launchAsset.hash);
  });

  test("rollback --to an older update serves its code under a createdAt after the newer one", async () => {
    const store = open();
    const a = await publishIos(store);
    const b = await publishIos(store, exportB());
    expect(b.launchAsset.hash).not.toBe(a.launchAsset.hash);
    s3.puts.length = 0;
    const result = await cmd("rollback", ["--to", a.id], writerEnv(store));
    expect(result.err).toEqual([]);

    const { manifest } = await signedManifest(store.objects(), IOS);
    expectBase(store, manifest, "ios");
    if (kind === "s3") expect(s3.puts).toEqual([recordKey(manifest.id), baseKey(manifest.id), IOS]);
    expect(result.out).toEqual([`${IOS} ${manifest.id} ${manifest.createdAt}`]);
    expect([a.id, b.id]).not.toContain(manifest.id);
    expect(code(manifest)).toEqual(code(a));
    expect(manifest.createdAt > b.createdAt).toBe(true);
    const server = await serve(store);
    // A client running B gets the rollback, not no-update.
    const served = await servedManifest(await server.manifest("main", "ios", b.id), store, IOS);
    expect(served).toEqual(manifest);
    expect(await server.hashAt(served.launchAsset.url)).toBe(a.launchAsset.hash);
  });

  test("a promotion to an empty channel is newer than the code it copies, even from a clock ahead", async () => {
    const store = open();
    const base = Math.floor(Date.now() / 1000) * 1000;
    s3.setNow(base);
    const a = await publishIos(store, EXPORT, () => base + 30_000);
    const result = await cmd(
      "republish",
      [a.id, "--channel", "beta"],
      writerEnv(store),
      () => base,
    );
    expect(result.code).toBe(0);
    const { manifest } = await signedManifest(store.objects(), BETA);
    expect(manifest.createdAt).toBe(new Date(base + 30_001).toISOString());
  });

  test("rollback --to two updates writes both of their pointers", async () => {
    const store = open();
    const published = await cmd(
      "publish",
      ["--channel", "main", "--from", artifact()],
      env(store.env),
    );
    expect(published.code).toBe(0);
    const [ios, android] = await Promise.all(
      [IOS, ANDROID].map(async (k) => (await signedManifest(store.objects(), k)).manifest.id),
    );
    const result = await cmd("rollback", ["--to", ios!, "--to", android!], writerEnv(store));
    expect(result.code).toBe(0);
    expect(result.out.map((l) => l.split(" ")[0])).toEqual([IOS, ANDROID]);
  });

  describe("refusals leave the bucket unchanged", () => {
    test.each<[string, (s: Store, a: Manifest) => string[] | Promise<string[]>, string]>([
      ["an unknown update ID", () => [UNKNOWN_ID], `no release record for update ${UNKNOWN_ID}`],
      [
        "a deleted bundle",
        async (s, a) => {
          await remove(s, new URL(a.launchAsset.url).pathname.slice(1));
          return [a.id];
        },
        "references bundles/",
      ],
      [
        "a deleted asset",
        async (s, a) => {
          await remove(s, new URL(a.assets[0]!.url).pathname.slice(1));
          return [a.id];
        },
        "references assets/",
      ],
      [
        "another runtime version",
        (_, a) => [a.id, "--runtime-version", "2.0.0"],
        "was built for another runtime version than --runtime-version",
      ],
      [
        "an unreadable record",
        async (s, a) => {
          const key = recordKey(a.id);
          await put(s, key, new Uint8Array([...s.objects().get(key)!, 0x0a]));
          return [a.id];
        },
        "is unreadable: record is not in the form tide writes",
      ],
    ])("republish: %s", async (_, damage, message) => {
      const store = open();
      const a = await publishIos(store);
      const args = await damage(store, a);
      const before = store.snapshot();
      s3.puts.length = 0;
      const result = await cmd("republish", [...args], writerEnv(store));
      expect(result.code).toBe(2);
      expect(result.out).toEqual([]);
      expect(result.err).toHaveLength(1);
      expect(result.err[0]).toContain(message);
      expect(store.snapshot()).toEqual(before);
      expect(s3.puts).toEqual([]);
    });

    test("two updates with one target", async () => {
      const store = open();
      const a = await publishIos(store);
      const b = await publishIos(store, exportB());
      const before = store.snapshot();
      s3.puts.length = 0;
      for (const [command, args] of [
        ["republish", [a.id, b.id]],
        ["rollback", ["--to", a.id, "--to", b.id]],
      ] as const) {
        const result = await cmd(command, [...args], writerEnv(store));
        expect(result).toEqual({
          code: 2,
          out: [],
          err: [`tide: updates ${a.id} and ${b.id} both target ${IOS}`],
        });
      }
      expect(store.snapshot()).toEqual(before);
      expect(s3.puts).toEqual([]);
    });

    test("rollback --embedded of a pointer that does not exist", async () => {
      const store = open();
      await publishIos(store);
      const before = store.snapshot();
      s3.puts.length = 0;
      const result = await cmd(
        "rollback",
        [...["--embedded", "--channel", "mian", "--runtime-version", "1.0.0", "--platform", "ios"]],
        writerEnv(store),
      );
      expect(result).toEqual({
        code: 2,
        out: [],
        err: ["tide: reply/mian/1.0.0/ios does not exist: there is nothing to roll back"],
      });
      expect(store.snapshot()).toEqual(before);
      expect(s3.puts).toEqual([]);
    });

    test.each(["rollback --embedded", "rollback --to", "republish", "publish"])(
      "%s on a bucket whose pointers are another identity's and whose reply/no-update is gone",
      async (command) => {
        const store = open();
        await put(store, IOS, await seededPointer("manifest", Date.now(), other));
        const before = store.snapshot();
        const runs = {
          "rollback --embedded": () =>
            cmd(
              "rollback",
              ["--embedded", "--channel", "main", "--runtime-version", "1.0.0"],
              writerEnv(store),
            ),
          "rollback --to": () => cmd("rollback", ["--to", UNKNOWN_ID], writerEnv(store)),
          republish: () => cmd("republish", [UNKNOWN_ID], writerEnv(store)),
          publish: () =>
            cmd("publish", ["--channel", "main", "--from", artifact()], env(store.env)),
        };
        expect(await runs[command as keyof typeof runs]()).toEqual({
          code: 2,
          out: [],
          err: [`tide: ${OTHER_IDENTITY}`],
        });
        expect(store.snapshot()).toEqual(before);
      },
    );
  });

  test("a mismatched key and a clock a minute off refuse both commands before any write", async () => {
    const store = open();
    const a = await publishIos(store);
    const before = store.snapshot();
    const embedded = ["--embedded", "--channel", "main", "--runtime-version", "1.0.0"];
    for (const args of [embedded, ["--to", a.id]]) {
      const all = [...args];
      const requests = s3.requests;
      expect(await cmd("rollback", all, writerEnv(store, other))).toEqual({
        code: 2,
        out: [],
        err: [`tide: ${MISMATCH}`],
      });
      expect(s3.requests).toBe(requests); // The bucket is never opened.
      s3.puts.length = 0;
      expect(await cmd("rollback", all, writerEnv(store), () => Date.now() + 61_000)).toEqual({
        code: 2,
        out: [],
        err: [
          "tide: the local clock differs from the bucket's by more than a minute: fix the clock",
        ],
      });
      expect(s3.puts).toEqual([]);
    }
    expect(await cmd("republish", [a.id], writerEnv(store, other))).toMatchObject({
      code: 2,
      err: [`tide: ${MISMATCH}`],
    });
    expect(store.snapshot()).toEqual(before);
  });
});

describe("on disk", () => {
  test.each<[string, string[], string]>([
    ["rollback --to A B", ["rollback", "--to", UNKNOWN_ID, UNKNOWN_ID], "unrecognised arguments"],
    ["rollback with no mode", ["rollback"], "give --embedded or --to;"],
    ["rollback with both modes", ["rollback", "--embedded", "--to", UNKNOWN_ID], "not both"],
    [
      "rollback --to with --channel",
      ["rollback", "--to", UNKNOWN_ID, "--channel", "main"],
      "it takes no --channel",
    ],
    [
      "rollback --to with --runtime-version",
      ["rollback", "--to", UNKNOWN_ID, "--runtime-version", "1.0.0"],
      "it takes no --channel",
    ],
    [
      "rollback --to with --platform",
      ["rollback", "--to", UNKNOWN_ID, "--platform", "ios"],
      "it takes no --channel",
    ],
    [
      "rollback --embedded without --runtime-version",
      ["rollback", "--embedded", "--channel", "main"],
      "--embedded needs --channel and --runtime-version",
    ],
    [
      "rollback --embedded with a positional",
      ["rollback", "--embedded", "--channel", "main", "--runtime-version", "1", "x"],
      "unrecognised arguments",
    ],
    [
      "rollback --embedded with a repeated platform",
      [
        "rollback",
        "--embedded",
        "--channel",
        "main",
        "--runtime-version",
        "1",
        "--platform",
        "ios",
        "--platform",
        "ios",
      ],
      "--platform ios is given twice",
    ],
    ["republish with no ID", ["republish"], "give at least one update ID"],
    [
      "rollback with the removed --project-root",
      ["rollback", "--to", UNKNOWN_ID, "--project-root", "."],
      "unrecognised arguments",
    ],
    [
      "republish with the removed --project-root",
      ["republish", UNKNOWN_ID, "--project-root", "."],
      "unrecognised arguments",
    ],
    [
      "republish with --to",
      ["republish", UNKNOWN_ID, "--to", UNKNOWN_ID],
      "unrecognised arguments",
    ],
    [
      "a malformed ID",
      ["republish", UNKNOWN_ID.toUpperCase()],
      "tide: an update ID is not a lowercase UUID",
    ],
    [
      "a repeated ID",
      ["republish", UNKNOWN_ID, UNKNOWN_ID],
      `update ID ${UNKNOWN_ID} is given twice`,
    ],
  ])("%s is refused before the bucket is read", async (_, [command, ...args], message) => {
    const store = STORES.disk();
    const result = await cmd(command as keyof typeof COMMANDS, args, writerEnv(store));
    expect(result.code).toBe(2);
    expect(result.err).toHaveLength(1);
    expect(result.err[0]).toContain(message);
    expect(tree(store.root)).toEqual(new Map());
  });
});

describe("on S3", () => {
  const theirs = utf8("another writer's reply");

  test("a pointer changed after it was read fails rollback --embedded and republish, keeping the other writer's", async () => {
    const store = STORES.s3();
    const a = await publishIos(store);
    const runs = [
      () =>
        cmd(
          "rollback",
          [
            ...[
              "--embedded",
              "--channel",
              "main",
              "--runtime-version",
              "1.0.0",
              "--platform",
              "ios",
            ],
          ],
          writerEnv(store),
        ),
      () => cmd("republish", [a.id], writerEnv(store)),
    ];
    for (const attempt of runs) {
      s3.objects.set(IOS, await seededPointer("manifest", Date.now()));
      s3.raceOnPut(IOS, theirs);
      expect(await attempt()).toEqual({ code: 1, out: [], err: [`tide: ${STALE(IOS)}`] });
      expect(s3.objects.get(IOS)).toEqual(theirs);
    }
  });

  test("a target created by another writer after it was read fails the promotion and keeps theirs", async () => {
    const store = STORES.s3();
    const a = await publishIos(store);
    s3.raceOnPut(BETA, theirs);
    const result = await cmd("republish", [a.id, "--channel", "beta"], writerEnv(store));
    expect(result).toEqual({ code: 1, out: [], err: [`tide: ${STALE(BETA)}`] });
    expect(s3.objects.get(BETA)).toEqual(theirs);
  });

  test("a lost response to reply/no-update or a record stops before any pointer, naming the write", async () => {
    const store = STORES.s3();
    s3.objects.set(IOS, await seededPointer("manifest", Date.now()));
    s3.dropAfterPut(NO_UPDATE_KEY);
    const embedded = [
      "--embedded",
      "--channel",
      "main",
      "--runtime-version",
      "1.0.0",
      "--platform",
      "ios",
    ];
    expect(await cmd("rollback", [...embedded], writerEnv(store))).toEqual({
      code: 1,
      out: [],
      err: [
        `tide: ${NO_UPDATE_KEY}: S3 PutObject failed: network error; outcome unknown; check with tide status`,
      ],
    });
    expect(s3.puts).toEqual([NO_UPDATE_KEY]);

    const a = await publishIos(store);
    s3.puts.length = 0;
    s3.dropAfterPut("updates/");
    const result = await cmd("republish", [a.id, "--channel", "beta"], writerEnv(store));
    expect(result.code).toBe(1);
    expect(result.err).toHaveLength(1);
    expect(result.err[0]).toMatch(
      /^tide: updates\/[0-9a-f-]{36}\.json: S3 PutObject failed: network error; outcome unknown; no pointer names it yet$/,
    );
    expect(s3.puts).toHaveLength(1);
    expect(s3.puts[0]).toMatch(/^updates\//);
  });

  test("a failed base write stops republish and rollback --to before their pointers", async () => {
    const store = STORES.s3();
    const a = await publishIos(store);
    const before = s3.objects.get(IOS);
    for (const args of [
      [a.id, "--channel", "beta"],
      ["--to", a.id],
    ]) {
      s3.puts.length = 0;
      s3.dropAfterPut("bases/");
      const command = args[0] === "--to" ? "rollback" : "republish";
      const result = await cmd(command, [...args], writerEnv(store));
      expect(result.code).toBe(1);
      expect(result.err[0]).toMatch(
        /^tide: bases\/[0-9a-f-]{36}: S3 PutObject failed: network error; outcome unknown; no pointer names it yet$/,
      );
      expect(s3.puts.map((k) => k.split("/")[0])).toEqual(["updates", "bases"]);
    }
    expect(s3.objects.get(IOS)).toBe(before);
    expect(s3.objects.has(BETA)).toBe(false);
  });

  describe("certificate expiry", () => {
    const expiry = T + 3_600_000;
    const embedded = (...platforms: string[]) => [
      "--embedded",
      "--channel",
      "main",
      "--runtime-version",
      "1.0.0",
      ...platforms.flatMap((p) => ["--platform", p]),
    ];

    async function setup() {
      const expiring = await identity(new Date(expiry));
      const environment = { ...writerEnv(STORES.s3(), expiring), ...pins(expiring) };
      s3.setNow(T);
      const published = await cmd(
        "publish",
        [
          "--channel",
          "main",
          "--from",
          artifact({ fields: { certificate: expiring.certificate } }),
        ],
        { ...env(s3Env(), expiring), ...pins(expiring) },
        () => T,
      );
      expect(published.code).toBe(0);
      s3.puts.length = 0;
      return environment;
    }

    test("an expiry after the clock sample and before any write is a refusal", async () => {
      const environment = await setup();
      const start = s3.requests;
      // Requests: reply/no-update, the pointer, the bucket time sampled with the local clock, then the final check's.
      const now = () => (s3.requests - start >= 4 ? expiry + 1000 : T);
      expect(await cmd("rollback", [...embedded("ios")], environment, now)).toEqual({
        code: 2,
        out: [],
        err: ["tide: TIDE_BUILD_CERTIFICATE: certificate has expired"],
      });
      expect(s3.puts).toEqual([]);
    });

    test("an expiry after the first pointer stops the second", async () => {
      const environment = await setup();
      const now = () => (s3.puts.includes(IOS) ? expiry + 1000 : T);
      const result = await cmd("rollback", [...embedded("ios", "android")], environment, now);
      expect(result.code).toBe(1);
      expect(result.out).toEqual([`${IOS} - ${new Date(T + 1).toISOString()}`]);
      expect(result.err).toEqual(["tide: TIDE_BUILD_CERTIFICATE: certificate has expired"]);
      expect(s3.puts).toEqual([IOS]);
    });
  });
});

/** Removes `key` from the store, as a broken gc or an operator might. */
async function remove(store: Store, key: string) {
  if (store.root === undefined) s3.objects.delete(key);
  else await diskBucket(store.root).delete(key);
}

/** Stores `bytes` at `key` directly. */
async function put(store: Store, key: string, bytes: Uint8Array<ArrayBuffer>) {
  if (store.root === undefined) s3.objects.set(key, bytes);
  else await diskBucket(store.root).put(key, bytes);
}
