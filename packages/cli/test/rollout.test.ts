import { createHash } from "node:crypto";
import { describe, expect, test } from "vitest";

import type { Rollout } from "@tide-ota/protocol";
import {
  MAX_REPLY_BYTES,
  NO_UPDATE_KEY,
  buildManifest,
  cryptoKeySigner,
  decodePointer,
  decodeStoredReply,
  encodeMultipart,
  encodeRollout,
  expoSignature,
  parseMultipart,
  sha256Base64Url,
} from "@tide-ota/protocol";

import type { Identity } from "./publish-fixture.ts";
import { runEntry } from "../../server/test/node/entry.ts";
import { launchUrl } from "../src/publish-record.ts";
import { republish, rollback } from "../src/publish-rollback.ts";
import { PUBLISH_USAGE, publish } from "../src/publish.ts";
import { ROLLOUT_USAGE, rollout } from "../src/rollout.ts";
import { bucketFromEnv } from "../src/storage.ts";
import { run, tempRoot, utf8 } from "./helpers.ts";
import {
  ANDROID,
  IOS,
  MAIN,
  SERVER_URL,
  artifact,
  diskObjects,
  env,
  main,
  noUpdateBy,
  other,
  pins,
  s3,
  s3Env,
  s3Snapshot,
  seededPointer,
  tree,
  useFixture,
} from "./publish-fixture.ts";

useFixture();

const COMMANDS = { publish, rollout, rollback, republish };
const IOS_ONLY = { platforms: { ios: { runtimeVersion: "1.0.0" } } };
const TARGET = ["--channel", "main", "--runtime-version", "1.0.0"];
const ONLY_IOS = ["--platform", "ios"];
const STALE = (key: string) =>
  `${key} was changed by another writer since it was read; it keeps theirs`;
const UNVERIFIED = (key: string, name: string) =>
  `${key}: its ${name} does not verify under this app's certificate and key ID`;
const PERCENT = "--rollout must be a percentage from 0.01 to 99.99 in steps of 0.01";
const HOLDS = (key: string) =>
  `${key} holds a rollout: finish it with tide rollout complete, or replace it with tide publish, republish or rollback`;

const STORES = {
  disk: () => {
    const root = tempRoot();
    return {
      env: { TIDE_DISK_DIR: root },
      objects: () => diskObjects(root),
      snapshot: () => tree(root),
    };
  },
  s3: () => ({ env: s3Env(), objects: () => s3.objects, snapshot: s3Snapshot }),
};

type Store = ReturnType<(typeof STORES)[keyof typeof STORES]>;

/** Runs a command in process; returns the exit code and output lines. */
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

/** The rollout configuration: the build pins and the bucket, and no signing key. */
const rolloutEnv = (store: Store) => ({ PATH: process.env.PATH ?? "", ...pins(), ...store.env });

/** Publishes the export `dir` to channel main, with `extra` arguments. */
const publishTo = (
  store: Store,
  dir: string,
  extra: string[] = [],
  options: { now?: () => number; env?: Record<string, string> } = {},
) =>
  cmd(
    "publish",
    ["--channel", "main", "--from", dir, ...extra],
    options.env ?? env(store.env),
    options.now,
  );

/** Runs `tide rollout <goal>` on channel main, runtime 1.0.0. */
const rolloutTo = (store: Store, goal: string, extra: string[] = []) =>
  cmd("rollout", [goal, ...TARGET, ...extra], rolloutEnv(store));

const text = (bytes: Uint8Array | undefined) => new TextDecoder().decode(bytes);
const stored = (store: Store, key: string) => {
  const bytes = store.objects().get(key);
  if (bytes === undefined) throw new Error(`${key} is absent`);
  return bytes;
};
/** The signed createdAt of a rollout's new manifest. */
const createdAtOf = (r: Rollout) =>
  (JSON.parse(text(parseMultipart(r.new.body, r.new.boundary)[0]?.body)) as { createdAt: string })
    .createdAt;
/** The export with its iOS update only, `n` giving it its own `expoClient` and so its own release record. */
const iosExport = (n = 0) =>
  artifact({ fields: { ...IOS_ONLY, ...(n !== 0 && { expoClient: { name: "Fixture", n } }) } });
const rolloutAt = (store: Store, key: string): Rollout => {
  const pointer = decodePointer(stored(store, key));
  if (pointer.kind !== "rollout") throw new Error(`${key} holds no rollout`);
  return pointer;
};

/** The record `before` at another percentage: the exact bytes a rollout command must write. */
const atPercent = (before: Uint8Array, from: number, to: number) => {
  const old = `{"version":2,"kind":"rollout","percent":${from},`;
  expect(text(before).startsWith(old)).toBe(true);
  return `{"version":2,"kind":"rollout","percent":${to},${text(before).slice(old.length)}`;
};

/** A version-1 record's fields as a rollout nests them: without `version`, otherwise byte for byte. */
const nested = (record: Uint8Array) => {
  const head = '{"version":1,';
  expect(text(record).startsWith(head)).toBe(true);
  return `{${text(record).slice(head.length)}`;
};

/** The exact text of a rollout record's `new` object. */
const newText = (record: Uint8Array) => {
  const t = text(record);
  // Quotes inside a body are escaped, so the first unescaped `,"earlier":` ends `new`.
  return t.slice(t.indexOf('"new":') + 6, t.indexOf(',"earlier":'));
};

/** The rollout bucket of a client, computed here independently of protocol `rolloutBucket`. */
const bucketOf = (updateId: string, clientId: string) =>
  createHash("sha256").update(`${updateId}:${clientId}`).digest().readUInt32BE(0) % 10_000;

/** The first of a fixed sequence of client IDs whose bucket in `updateId`'s rollout is in [lo, hi). */
function clientIn(updateId: string, lo: number, hi: number): string {
  for (let i = 0; ; i++) {
    const id = `00000000-0000-4000-8000-${i.toString(16).padStart(12, "0")}`;
    const b = bucketOf(updateId, id);
    if (b >= lo && b < hi) return id;
  }
}

/** A manifest reply with `id` created at `time`, signed by `by`; `extra` pads it when needed. */
async function manifestReply(
  id: string,
  time: number,
  options: { by?: Identity; extra?: Record<string, string> } = {},
): Promise<Rollout["new"]> {
  const hash = await sha256Base64Url(utf8(id));
  const body = buildManifest({
    id,
    createdAt: new Date(time),
    runtimeVersion: "1.0.0",
    launchAsset: {
      hash,
      contentType: "application/javascript",
      fileExtension: ".bundle",
      url: launchUrl(SERVER_URL, hash),
    },
    assets: [],
    metadata: { channel: "main" },
    extra: options.extra ?? {},
  });
  const signer = cryptoKeySigner((options.by ?? main).keys.privateKey, "main");
  const multipart = encodeMultipart([
    { name: "manifest", body, signature: await expoSignature(body, signer) },
  ]);
  return { kind: "manifest", updateId: id, manifestFilters: "", ...multipart };
}

/** `reply` with its signed part re-signed by `by`, so only its signature changes. */
async function resigned<R extends { boundary: string; body: Uint8Array<ArrayBuffer> }>(
  reply: R,
  by: Identity,
): Promise<R> {
  const [part] = parseMultipart(reply.body, reply.boundary);
  if (part === undefined) throw new Error("no part");
  const signature = await expoSignature(part.body, cryptoKeySigner(by.keys.privateKey, "main"));
  const { body } = encodeMultipart(
    [{ name: part.name, body: part.body, signature }],
    reply.boundary,
  );
  return { ...reply, body };
}

const ID_A = "1a2b3c4d-0000-4000-8000-00000000000a";
const ID_B = "1a2b3c4d-0000-4000-8000-00000000000b";

/** Starts the Node server over `store` and returns its base URL and a `/manifest` client for channel main. */
async function serve(store: Store) {
  const base = `http://127.0.0.1:${await runEntry(store.env).listening}`;
  const manifest = async (
    headers: { client?: string; current?: string; platform?: string } = {},
  ): Promise<Uint8Array> => {
    const res = await fetch(`${base}/manifest`, {
      headers: {
        "expo-platform": headers.platform ?? "ios",
        "expo-channel-name": "main",
        "expo-runtime-version": "1.0.0",
        "expo-protocol-version": "1",
        accept: "multipart/mixed",
        ...(headers.client && { "eas-client-id": headers.client }),
        ...(headers.current && { "expo-current-update-id": headers.current }),
      },
    });
    expect(res.status).toBe(200);
    return new Uint8Array(await res.arrayBuffer());
  };
  return { base, manifest };
}

describe.each(Object.keys(STORES) as (keyof typeof STORES)[])("on %s", (kind) => {
  const open = () => STORES[kind]();

  test("publish --rollout through the bin splits devices by EAS-Client-ID; rollout 90 adds devices; complete serves every device the new reply", async () => {
    const store = open();
    const { base, manifest } = await serve(store);
    const write = { ...env(store.env), TIDE_SERVER_URL: base };
    expect((await publishTo(store, artifact(), [], { env: write })).code).toBe(0);
    const earlier = decodeStoredReply(stored(store, IOS));
    if (earlier.kind !== "manifest") throw new Error("not a manifest");

    const published = await run(
      MAIN,
      ["publish", "--channel", "main", "--from", artifact(), "--rollout", "50"],
      write,
    );
    expect(published.stderr).toBe("");
    expect(published.code).toBe(0);
    const ios = rolloutAt(store, IOS);
    const android = rolloutAt(store, ANDROID);
    expect(published.stdout).toBe(
      `${IOS} ${ios.new.updateId} ${createdAtOf(ios)}\n${ANDROID} ${android.new.updateId} ${createdAtOf(android)}\n`,
    );
    expect(ios.percent).toBe(50);
    expect(ios.earlier).toEqual(earlier);

    const next = ios.new.updateId;
    const low = clientIn(next, 0, 5000);
    const middle = clientIn(next, 5000, 9000);
    const high = clientIn(next, 9000, 10_000);
    const noUpdate = decodeStoredReply(stored(store, NO_UPDATE_KEY)).body;
    expect(await manifest({ client: low })).toEqual(ios.new.body);
    expect(await manifest({ client: middle })).toEqual(earlier.body);
    expect(await manifest({ client: high })).toEqual(earlier.body);
    expect(await manifest()).toEqual(earlier.body);
    // The probe sends no EAS-Client-ID, so it sees the earlier side.
    const probed = await run(
      MAIN,
      ["probe", "--server-url", base, ...TARGET, "--platform", "ios"],
      pins(),
    );
    expect(probed.code).toBe(0);
    expect(probed.stdout.startsWith(`manifest ${earlier.updateId}: signature verified\n`)).toBe(
      true,
    );

    const at50 = stored(store, IOS);
    const raised = await run(MAIN, ["rollout", "90", ...TARGET], rolloutEnv(store));
    expect(raised).toEqual({
      code: 0,
      stdout: `${IOS} ${next} 90\n${ANDROID} ${android.new.updateId} 90\n`,
      stderr: "",
    });
    expect(text(stored(store, IOS))).toBe(atPercent(at50, 50, 90));
    expect(await manifest({ client: middle })).toEqual(ios.new.body);
    expect(await manifest({ client: high })).toEqual(earlier.body);

    const at90 = stored(store, IOS);
    expect((await rolloutTo(store, "complete")).code).toBe(0);
    expect(text(stored(store, IOS))).toBe(atPercent(at90, 90, 100));
    for (const client of [low, middle, high, undefined]) {
      expect(await manifest(client === undefined ? {} : { client })).toEqual(ios.new.body);
    }
    expect(await manifest({ client: high, current: next })).toEqual(noUpdate);
    expect(await manifest({ platform: "android" })).toEqual(android.new.body);
  });

  test("revert serves every device the earlier reply, and a device on the reverted update stays on it", async () => {
    const store = open();
    const { base, manifest } = await serve(store);
    const write = { ...env(store.env), TIDE_SERVER_URL: base };
    const dir = iosExport();
    expect((await publishTo(store, dir, [], { env: write })).code).toBe(0);
    const earlier = decodeStoredReply(stored(store, IOS));
    if (earlier.kind !== "manifest") throw new Error("not a manifest");
    expect((await publishTo(store, dir, ["--rollout", "50"], { env: write })).code).toBe(0);
    const at50 = stored(store, IOS);
    const next = rolloutAt(store, IOS).new.updateId;

    expect(await rolloutTo(store, "revert", ONLY_IOS)).toEqual({
      code: 0,
      out: [`${IOS} ${next} 0`],
      err: [],
    });
    expect(text(stored(store, IOS))).toBe(atPercent(at50, 50, 0));
    for (const client of [clientIn(next, 0, 5000), clientIn(next, 5000, 10_000), undefined]) {
      expect(await manifest(client === undefined ? {} : { client })).toEqual(earlier.body);
    }
    // The guard stays with the record, so the earlier reply's filters cannot move this device back.
    const noUpdate = decodeStoredReply(stored(store, NO_UPDATE_KEY)).body;
    expect(await manifest({ current: next })).toEqual(noUpdate);
    const probed = await run(
      MAIN,
      ["probe", "--server-url", base, ...TARGET, "--platform", "ios"],
      pins(),
    );
    expect(probed.stdout.startsWith(`manifest ${earlier.updateId}: signature verified\n`)).toBe(
      true,
    );
  });

  test("publish --rollout keeps the previous pointer's exact record as the earlier reply: none, a manifest, a rollback, or a complete rollout's new reply", async () => {
    const store = open();
    // Each publish exports other code, so none passes for a rerun of the one before.
    const variant = (n: number) => artifact({ fields: { expoClient: { name: "Fixture", n } } });
    const first = await publishTo(store, variant(1), ["--rollout", "25"]);
    expect(first).toEqual({
      code: 0,
      out: [IOS, ANDROID].map(
        (k) => `${k} ${rolloutAt(store, k).new.updateId} ${createdAtOf(rolloutAt(store, k))}`,
      ),
      err: [],
    });
    for (const key of [IOS, ANDROID]) {
      expect(rolloutAt(store, key).percent).toBe(25);
      expect(rolloutAt(store, key).earlier).toBeUndefined();
    }

    expect((await rolloutTo(store, "complete")).code).toBe(0);
    const complete = stored(store, IOS);
    expect((await publishTo(store, variant(2), ["--rollout", "30"])).code).toBe(0);
    expect(text(stored(store, IOS)).endsWith(`"earlier":${newText(complete)}}`)).toBe(true);

    expect((await publishTo(store, variant(3))).code).toBe(0);
    const manifest = stored(store, IOS);
    expect((await publishTo(store, variant(4), ["--rollout", "12.5"])).code).toBe(0);
    expect(text(stored(store, IOS)).endsWith(`"earlier":${nested(manifest)}}`)).toBe(true);
    expect(rolloutAt(store, IOS).percent).toBe(12.5);

    expect((await cmd("rollback", ["--embedded", ...TARGET], writerEnv(store))).code).toBe(0);
    const rolledBack = stored(store, ANDROID);
    expect((await publishTo(store, variant(5), ["--rollout", "99.99"])).code).toBe(0);
    expect(text(stored(store, ANDROID)).endsWith(`"earlier":${nested(rolledBack)}}`)).toBe(true);
  });

  describe("a rollout only moves forward", () => {
    /** Publishes an iOS-only update, then a 50% rollout over it; returns the rollout's update ID. */
    async function staged(store: Store) {
      const dir = iosExport();
      expect((await publishTo(store, dir)).code).toBe(0);
      expect((await publishTo(store, dir, ["--rollout", "50"])).code).toBe(0);
      return rolloutAt(store, IOS).new.updateId;
    }
    const ios = (store: Store, goal: string) => rolloutTo(store, goal, ONLY_IOS);

    test("a goal already reached writes nothing and prints its line", async () => {
      const store = open();
      const next = await staged(store);
      for (const [goal, percent, writes] of [
        ["50", 50, false],
        ["90", 90, true],
        ["90", 90, false],
        ["complete", 100, true],
        ["complete", 100, false],
      ] as const) {
        const before = store.snapshot();
        const record = stored(store, IOS);
        expect(await ios(store, goal)).toEqual({
          code: 0,
          out: [`${IOS} ${next} ${percent}`],
          err: [],
        });
        expect([goal, text(stored(store, IOS)) !== text(record)]).toEqual([goal, writes]);
        if (!writes) expect(store.snapshot()).toEqual(before);
        expect(rolloutAt(store, IOS).percent).toBe(percent);
      }
      const reverted = open();
      const id = await staged(reverted);
      expect((await ios(reverted, "revert")).code).toBe(0);
      const before = reverted.snapshot();
      expect((await ios(reverted, "revert")).out).toEqual([`${IOS} ${id} 0`]);
      expect(reverted.snapshot()).toEqual(before);
    });

    test("lowering, and moving a complete or reverted rollout, refuse before any write", async () => {
      const store = open();
      await staged(store);
      let before = store.snapshot();
      expect(await ios(store, "30")).toEqual({
        code: 2,
        out: [],
        err: [
          `tide: ${IOS} is at 50%: a rollout percentage only rises; lowering it never moves a device back, so use tide rollout revert or tide rollback`,
        ],
      });
      expect(store.snapshot()).toEqual(before);
      expect((await ios(store, "complete")).code).toBe(0);
      before = store.snapshot();
      for (const goal of ["60", "revert"]) {
        expect(await ios(store, goal)).toEqual({
          code: 2,
          out: [],
          err: [
            `tide: ${IOS}'s rollout is complete: start another with tide publish --rollout, or use tide rollback`,
          ],
        });
      }
      expect(store.snapshot()).toEqual(before);

      const reverted = open();
      await staged(reverted);
      expect((await ios(reverted, "revert")).code).toBe(0);
      before = reverted.snapshot();
      for (const goal of ["60", "complete"]) {
        expect(await ios(reverted, goal)).toEqual({
          code: 2,
          out: [],
          err: [
            `tide: ${IOS}'s rollout was reverted: publish a fix with tide publish, or use tide rollback`,
          ],
        });
      }
      // A new rollout over a reverted one would drop its guard.
      expect((await publishTo(reverted, iosExport(1), ["--rollout", "50"])).err).toEqual([
        `tide: ${HOLDS(IOS)}`,
      ]);
      expect(reverted.snapshot()).toEqual(before);
    });
  });

  test("a later writer stamps a time after the rolled-out update, even when it was stamped by a clock ahead", async () => {
    for (const goal of ["complete", "revert"]) {
      const store = open();
      const dir = iosExport();
      expect((await publishTo(store, dir)).code).toBe(0);
      const ahead = () => Date.now() + 50_000;
      expect((await publishTo(store, dir, ["--rollout", "50"], { now: ahead })).code).toBe(0);
      const nextAt = createdAtOf(rolloutAt(store, IOS));
      expect((await rolloutTo(store, goal, ONLY_IOS)).code).toBe(0);
      const later = await publishTo(store, dir);
      expect(later.code).toBe(0);
      const createdAt = later.out[0]?.split(" ")[2] ?? "";
      expect(Date.parse(createdAt)).toBeGreaterThan(Date.parse(nextAt));
    }
  });

  test("publish, republish and rollback replace a rollout whole, after the newer of its two sides", async () => {
    const store = open();
    const dir = iosExport();
    expect((await publishTo(store, dir)).code).toBe(0);
    const source = decodeStoredReply(stored(store, IOS));
    if (source.kind !== "manifest") throw new Error("not a manifest");
    // The earlier side is the newer, so a writer that only looked at `new` would stamp too early.
    const now = Date.now();
    const seeded = encodeRollout({
      kind: "rollout",
      percent: 50,
      new: await manifestReply(ID_A, now + 20 * 60_000),
      earlier: await manifestReply(ID_B, now + 30 * 60_000),
    });
    const newest = now + 30 * 60_000;
    const writers: [string, () => ReturnType<typeof cmd>][] = [
      ["publish", () => publishTo(store, dir)],
      ["republish", () => cmd("republish", [source.updateId], writerEnv(store))],
      ["rollback --to", () => cmd("rollback", ["--to", source.updateId], writerEnv(store))],
      [
        "rollback --embedded",
        () => cmd("rollback", ["--embedded", ...TARGET, "--platform", "ios"], writerEnv(store)),
      ],
    ];
    for (const [name, write] of writers) {
      await bucketPut(store, IOS, seeded);
      const result = await write();
      expect([name, result.code, result.err]).toEqual([name, 0, []]);
      const record = stored(store, IOS);
      expect(text(record).startsWith('{"version":1,')).toBe(true);
      const time = result.out[0]?.split(" ")[2] ?? "";
      expect(Date.parse(time)).toBeGreaterThan(newest);
    }
  });

  test("refusals leave the bucket unchanged", async () => {
    const store = open();
    const dir = artifact();
    expect((await publishTo(store, dir)).code).toBe(0);
    const before = store.snapshot();
    const cases: [string[], string, string][] = [
      [["rollout", "50", ...TARGET], `${IOS} holds no rollout`, "plain pointer"],
      [
        ["rollout", "50", "--channel", "beta", "--runtime-version", "1.0.0"],
        "reply/beta/1.0.0/ios does not exist: there is no rollout",
        "absent",
      ],
      [
        ["rollout", "0", ...TARGET],
        "the rollout must be a percentage from 0.01 to 99.99 in steps of 0.01",
        "0",
      ],
      [
        ["rollout", "100", ...TARGET],
        "the rollout must be a percentage from 0.01 to 99.99 in steps of 0.01",
        "100",
      ],
      [
        ["rollout", "12.345", ...TARGET],
        "the rollout must be a percentage from 0.01 to 99.99 in steps of 0.01",
        "three decimals",
      ],
      [
        ["rollout", ...TARGET],
        `give one percentage, complete or revert; ${ROLLOUT_USAGE}`,
        "no goal",
      ],
      [
        ["rollout", "50", "60", ...TARGET],
        `give one percentage, complete or revert; ${ROLLOUT_USAGE}`,
        "two goals",
      ],
      [
        ["rollout", "50", "--channel", "main"],
        `--channel and --runtime-version are required; ${ROLLOUT_USAGE}`,
        "no runtime",
      ],
      [
        ["rollout", "50", ...TARGET, "--platform", "ios", "--platform", "ios"],
        "--platform ios is given twice",
        "repeated platform",
      ],
      [["rollout", "-1", ...TARGET], `unrecognised arguments; ${ROLLOUT_USAGE}`, "negative"],
      [
        ["publish", "--channel", "main", "--from", dir, "--rollout", "-1"],
        `unrecognised arguments; ${PUBLISH_USAGE}`,
        "negative --rollout",
      ],
    ];
    for (const value of ["0", "100", "12.345", "1e1", "+5", "abc", "", "05", "-1"]) {
      cases.push([
        ["publish", "--channel", "main", "--from", dir, `--rollout=${value}`],
        PERCENT,
        `--rollout=${value}`,
      ]);
    }
    for (const [args, message, name] of cases) {
      const result = await run(MAIN, args, env(store.env));
      expect([name, result.code, result.stdout, result.stderr]).toEqual([
        name,
        2,
        "",
        `tide: ${message}\n`,
      ]);
    }
    expect(store.snapshot()).toEqual(before);
    // iOS holds a rollout and Android does not: neither is written.
    expect((await publishTo(store, iosExport(), ["--rollout", "50"])).code).toBe(0);
    const partial = store.snapshot();
    expect((await rolloutTo(store, "90")).err).toEqual([`tide: ${ANDROID} holds no rollout`]);
    // A rollout in progress is not replaced by another.
    expect((await publishTo(store, iosExport(1), ["--rollout", "60"])).err).toEqual([
      `tide: ${HOLDS(IOS)}`,
    ]);
    expect(store.snapshot()).toEqual(partial);
  });

  test("a bucket without reply/no-update, or with one under another identity, refuses tide rollout", async () => {
    const store = open();
    await bucketPut(
      store,
      IOS,
      encodeRollout({
        kind: "rollout",
        percent: 50,
        new: await manifestReply(ID_A, Date.now()),
        earlier: undefined,
      }),
    );
    const before = store.snapshot();
    expect((await rolloutTo(store, "90", ONLY_IOS)).err).toEqual([
      "tide: reply/no-update is absent: tide publish, republish or rollback writes it",
    ]);
    expect(store.snapshot()).toEqual(before);
    await bucketPut(store, NO_UPDATE_KEY, await noUpdateBy(other));
    const moved = store.snapshot();
    expect((await rolloutTo(store, "90", ONLY_IOS)).err).toEqual([
      "tide: this bucket's replies are signed by a different certificate or key ID: a new signing identity needs a new bucket",
    ]);
    expect(store.snapshot()).toEqual(moved);
  });

  test("every copied body must verify under the app's identity, even with a valid reply/no-update", async () => {
    const store = open();
    await bucketPut(store, NO_UPDATE_KEY, await noUpdateBy(main));
    const good = await manifestReply(ID_A, Date.now());
    const earlier = await manifestReply(ID_B, Date.now() - 1000);
    for (const [r, name] of [
      [{ kind: "rollout", percent: 50, new: await resigned(good, other), earlier }, "new reply"],
      [
        { kind: "rollout", percent: 50, new: good, earlier: await resigned(earlier, other) },
        "earlier reply",
      ],
    ] as const) {
      await bucketPut(store, IOS, encodeRollout(r));
      const before = store.snapshot();
      for (const goal of ["90", "complete", "revert"]) {
        const result = await rolloutTo(store, goal, ONLY_IOS);
        expect([goal, result.code, result.err]).toEqual([
          goal,
          2,
          [`tide: ${UNVERIFIED(IOS, name)}`],
        ]);
      }
      expect(store.snapshot()).toEqual(before);
    }
    const dir = iosExport();
    await bucketPut(store, IOS, await seededPointer("manifest", Date.now() - 1000, other));
    expect((await publishTo(store, dir, ["--rollout", "50"])).err).toEqual([
      `tide: ${UNVERIFIED(IOS, "reply")}`,
    ]);
    await bucketPut(
      store,
      IOS,
      encodeRollout({ kind: "rollout", percent: 100, new: await resigned(good, other), earlier }),
    );
    const before = store.snapshot();
    expect((await publishTo(store, dir, ["--rollout", "50"])).err).toEqual([
      `tide: ${UNVERIFIED(IOS, "new reply")}`,
    ]);
    expect(store.snapshot()).toEqual(before);
    // Once every body verifies, both commands go ahead.
    await bucketPut(
      store,
      IOS,
      encodeRollout({ kind: "rollout", percent: 50, new: good, earlier }),
    );
    expect((await rolloutTo(store, "complete", ONLY_IOS)).code).toBe(0);
    expect((await publishTo(store, dir, ["--rollout", "50"])).code).toBe(0);
  });

  test("a rerun of a staged publish skips the target it staged, after verifying both of its sides", async () => {
    const store = open();
    // A partial run: only iOS was staged before the job stopped.
    expect((await publishTo(store, iosExport(), ["--rollout", "50"])).code).toBe(0);
    const ios = stored(store, IOS);
    const line = `${IOS} ${rolloutAt(store, IOS).new.updateId}`;
    const rerun = await publishTo(store, artifact(), ["--rollout", "50"]);
    expect(rerun.code).toBe(0);
    expect(rerun.out[0]?.startsWith(`${line} `)).toBe(true);
    expect(rerun.out[1]?.startsWith(`${ANDROID} ${rolloutAt(store, ANDROID).new.updateId} `)).toBe(
      true,
    );
    expect(stored(store, IOS)).toEqual(ios);

    // The skipped target's sides are verified first: each re-signed by another key is refused.
    const staged = rolloutAt(store, IOS);
    for (const [r, name] of [
      [{ ...staged, new: await resigned(staged.new, other) }, "new reply"],
      [{ ...staged, earlier: await manifestReply(ID_B, 0, { by: other }) }, "earlier reply"],
    ] as const) {
      await bucketPut(store, IOS, encodeRollout(r));
      const before = store.snapshot();
      expect((await publishTo(store, artifact(), ["--rollout", "50"])).err).toEqual([
        `tide: ${UNVERIFIED(IOS, name)}`,
      ]);
      expect(store.snapshot()).toEqual(before);
    }
  });

  test("a rollout record over the size limit on the second target refuses before the first is written", async () => {
    const store = open();
    await bucketPut(store, NO_UPDATE_KEY, await noUpdateBy(main));
    await bucketPut(
      store,
      IOS,
      encodeRollout({
        kind: "rollout",
        percent: 50,
        new: await manifestReply(ID_A, Date.now()),
        earlier: undefined,
      }),
    );
    const padded = async (n: number) =>
      encodeRollout({
        kind: "rollout",
        percent: 50,
        new: await manifestReply(ID_B, Date.now(), { extra: { pad: "x".repeat(n) } }),
        earlier: undefined,
      });
    const size = (await padded(1000)).length;
    const full = await padded(1000 + MAX_REPLY_BYTES - size);
    expect(full.length).toBe(MAX_REPLY_BYTES);
    await bucketPut(store, ANDROID, full);
    const before = store.snapshot();
    expect(await rolloutTo(store, "99.99")).toEqual({
      code: 2,
      out: [],
      err: [`tide: ${ANDROID}: record is too large: over ${MAX_REPLY_BYTES} bytes`],
    });
    expect(store.snapshot()).toEqual(before);
  });
});

describe("on s3", () => {
  const store = STORES.s3;

  test("a PUT held past its retry cannot land on content-hash ETags, since a rollout never returns to bytes it held", async () => {
    s3.contentEtags();
    s3.objects.set("probe", utf8("same"));
    const tag = s3.etag("probe");
    s3.objects.set("probe", utf8("same"));
    expect(s3.etag("probe")).toBe(tag);
    s3.objects.delete("probe");

    const s = store();
    expect((await publishTo(s, iosExport(), ["--rollout", "50"])).code).toBe(0);
    s3.holdPut(IOS);
    expect((await rolloutTo(s, "90", ONLY_IOS)).code).toBe(1);
    expect((await rolloutTo(s, "90", ONLY_IOS)).code).toBe(0);
    expect((await rolloutTo(s, "50", ONLY_IOS)).code).toBe(2);
    expect((await rolloutTo(s, "revert", ONLY_IOS)).code).toBe(0);
    const reverted = stored(s, IOS);
    expect(s3.landHeld(IOS)).toBe(false);
    expect(stored(s, IOS)).toEqual(reverted);
    expect(rolloutAt(s, IOS).percent).toBe(0);
  });

  test("a rerun after a failed second pointer, or a first whose response was lost, writes only what is left", async () => {
    for (const fault of ["hold-android", "drop-ios"] as const) {
      s3.reset();
      const s = store();
      const dir = artifact();
      if (fault === "hold-android") s3.holdPut(ANDROID);
      else s3.dropAfterPut(IOS);
      const first = await publishTo(s, dir, ["--rollout", "50"]);
      expect(first.code).toBe(1);
      const ios = stored(s, IOS);
      s3.puts.length = 0;
      const rerun = await publishTo(s, dir, ["--rollout", "50"]);
      expect([fault, rerun.code, rerun.err]).toEqual([fault, 0, []]);
      expect(s3.puts.filter((k) => k.startsWith("reply/"))).toEqual([ANDROID]);
      expect(stored(s, IOS)).toEqual(ios);
      if (fault === "hold-android") expect(rerun.out[0]).toBe(first.out[0]);
      expect(rerun.out.map((l) => l.split(" ")[0])).toEqual([IOS, ANDROID]);
      expect(rolloutAt(s, ANDROID).percent).toBe(50);

      // Another percentage, or another export, is not this publish's retry.
      const before = s.snapshot();
      expect((await publishTo(s, dir, ["--rollout", "60"])).err).toEqual([
        `tide: ${IOS} already stages this export at 50%: change it with tide rollout`,
      ]);
      const changed = await publishTo(s, dir, ["--rollout", "50"], {
        env: { ...env(s.env), TIDE_ASSET_URL: "https://assets2.example.com" },
      });
      expect(changed.err).toEqual([`tide: ${HOLDS(IOS)}`]);
      expect(s.snapshot()).toEqual(before);
    }
  });

  test("a pointer changed after it was read fails each writer and keeps the other writer's bytes", async () => {
    const s = store();
    const dir = iosExport();
    expect((await publishTo(s, dir)).code).toBe(0);
    const theirs = await seededPointer("rollback", Date.now());
    s3.raceOnPut(IOS, theirs);
    expect((await publishTo(s, dir, ["--rollout", "50"])).err.at(-1)).toBe(`tide: ${STALE(IOS)}`);
    expect(stored(s, IOS)).toEqual(theirs);

    expect((await publishTo(s, dir, ["--rollout", "50"])).code).toBe(0);
    for (const write of [() => rolloutTo(s, "90", ONLY_IOS), () => publishTo(s, dir)]) {
      const racer = await seededPointer("rollback", Date.now() + 1000);
      s3.raceOnPut(IOS, racer);
      const result = await write();
      expect(result.code).toBe(1);
      expect(result.err.at(-1)).toBe(`tide: ${STALE(IOS)}`);
      expect(stored(s, IOS)).toEqual(racer);
      expect((await publishTo(s, dir, ["--rollout", "50"])).code).toBe(0);
    }
  });
});

/** The writer configuration over `store`, without the URLs only publish needs. */
function writerEnv(store: Store): Record<string, string> {
  const { TIDE_SERVER_URL: _s, TIDE_ASSET_URL: _a, ...rest } = env(store.env);
  return rest;
}

/** Stores `bytes` at `key` directly, as a seeded bucket would hold them. */
async function bucketPut(store: Store, key: string, bytes: Uint8Array<ArrayBuffer>) {
  await bucketFromEnv(store.env).put(key, bytes);
}
