// `--json` through the bin. A document is asserted as exact stdout bytes, which pin every field, their order and the
// one trailing newline; each expectation is ASCII, so its `JSON.stringify` is the document.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, test } from "vitest";

import type { Rollout } from "@tide-ota/protocol";
import {
  NO_UPDATE_KEY,
  contentKey,
  decodePointer,
  decodeStoredReply,
  encodeRollout,
  sha256Base64Url,
} from "@tide-ota/protocol";

import type { Objects, Store } from "./publish-fixture.ts";
import { decodeRecord, recordKey } from "../src/publish-record.ts";
import { rollback } from "../src/publish-rollback.ts";
import { bucketFromEnv } from "../src/storage.ts";
import { fixture, rejection, run, tempRoot, utf8 } from "./helpers.ts";
import {
  ANDROID,
  IOS,
  MAIN,
  STORES,
  T,
  artifact,
  cmd,
  env,
  identitiesNoUpdate,
  main,
  noUpdateBy,
  other,
  pins,
  s3,
  s3Env,
  seededPointer,
  signedManifest,
  useFixture,
} from "./publish-fixture.ts";

useFixture();

type Env = Record<string, string>;
const UPDATE_ID = "0f6a9a3e-6c1b-4c4e-9d55-2b8f3f7c1a90"; // manifest.json's id, and seededPointer's
const CREATED_AT = "2026-11-19T12:34:56.789Z"; // manifest.json's createdAt
const COMMIT_TIME = "2026-11-19T08:09:10.123Z"; // directive-rollback.json's commitTime
const NEXT_ID = "3b1d7c52-9e4a-4f08-a6c3-71d2e5b98f14"; // manifest-next.json's id
const NEXT_AT = "2026-11-20T08:15:00.000Z"; // manifest-next.json's createdAt
const MANIFEST = fixture("manifest.reply.json"); // Signed for runtime 1.0.0.
const TARGET = ["--channel", "main", "--runtime-version", "1.0.0"];
const KINDS = Object.keys(STORES) as (keyof typeof STORES)[];

const tide = (args: string[], environment: Env) => run(MAIN, args, environment);
const document = (value: unknown) => `${JSON.stringify(value)}\n`;

/** Runs a reader with and without `--json`; fails unless both exit `code` with the same stderr. Returns the document. */
async function reader(command: "status" | "storage", environment: Env, code = 0) {
  const text = await tide([command], environment);
  const json = await tide([command, "--json"], environment);
  expect([json.code, json.stderr]).toEqual([text.code, text.stderr]);
  expect(json.code).toBe(code);
  return json.stdout;
}

/** Stores `bytes` under any name, around the adapter. */
function plant(store: Store, name: string, bytes: Uint8Array): void {
  const root = "TIDE_DISK_DIR" in store.env ? store.env.TIDE_DISK_DIR : undefined;
  if (root === undefined) {
    s3.objects.set(name, bytes);
    return;
  }
  mkdirSync(dirname(join(root, name)), { recursive: true });
  writeFileSync(join(root, name), bytes);
}

/** The golden rollout `name`, at `percent` when given. */
const rolloutOf = (name: string, percent?: number) => {
  const rollout = decodePointer(fixture(name)) as Rollout;
  return encodeRollout({ ...rollout, percent: percent ?? rollout.percent });
};
const named = (key: string) => {
  const [, channel, runtimeVersion, platform] = key.split("/");
  return { key, channel, runtimeVersion, platform };
};
const MANIFEST_SIDE = { kind: "manifest", updateId: UPDATE_ID, time: CREATED_AT, keyid: "main" };
const NEXT_SIDE = { kind: "manifest", updateId: NEXT_ID, time: NEXT_AT, keyid: "main" };
const ROLLBACK_SIDE = {
  kind: "rollBackToEmbedded",
  updateId: null,
  time: COMMIT_TIME,
  keyid: "main",
};

describe.each(KINDS)("tide status --json on %s", (kind) => {
  test("a plain manifest and rollback, with reply/no-update missing", async () => {
    const store = STORES[kind]();
    const bucket = bucketFromEnv(store.env);
    await bucket.put("reply/Beta/1.0.0/android", MANIFEST);
    await bucket.put("reply/main/2.0.0/ios", fixture("rollback.reply.json"));
    expect(await reader("status", store.env)).toBe(
      document({
        schema: 1,
        pointers: [
          { ...named("reply/Beta/1.0.0/android"), ...MANIFEST_SIDE },
          { ...named("reply/main/2.0.0/ios"), ...ROLLBACK_SIDE },
        ],
        noUpdate: { state: "missing", version: null, entries: [] },
        unreadable: [],
      }),
    );
  });

  test("a rollout reports its percentage and both sides, an absent earlier side as null", async () => {
    const store = STORES[kind]();
    const bucket = bucketFromEnv(store.env);
    const rollouts = {
      "reply/a/1.0.0/ios": rolloutOf("rollout-manifest.reply.json"),
      "reply/b/1.0.0/ios": rolloutOf("rollout-rollback.reply.json", 0),
      "reply/c/1.0.0/ios": rolloutOf("rollout-none.reply.json", 0.01),
      "reply/d/1.0.0/ios": rolloutOf("rollout-none.reply.json", 100),
    };
    for (const [key, bytes] of Object.entries(rollouts)) await bucket.put(key, bytes);
    const reported = (key: string, percent: number, earlier: unknown) => ({
      ...named(key),
      kind: "rollout",
      percent,
      new: NEXT_SIDE,
      earlier,
    });
    expect(await reader("status", store.env)).toBe(
      document({
        schema: 1,
        pointers: [
          reported("reply/a/1.0.0/ios", 12.5, MANIFEST_SIDE),
          reported("reply/b/1.0.0/ios", 0, ROLLBACK_SIDE),
          reported("reply/c/1.0.0/ios", 0.01, null),
          reported("reply/d/1.0.0/ios", 100, null),
        ],
        noUpdate: { state: "missing", version: null, entries: [] },
        unreadable: [],
      }),
    );
  });

  test("two keyids on two runtimes: each side names its own, and a version-3 reply/no-update has one entry each", async () => {
    const store = STORES[kind]();
    const bucket = bucketFromEnv(store.env);
    await bucket.put(IOS, await seededPointer("manifest", T));
    await bucket.put("reply/main/2.0.0/ios", await seededPointer("rollback", T, other, "root"));
    const mixed: Rollout = {
      kind: "rollout",
      percent: 50,
      new: decodeStoredReply(await seededPointer("manifest", T)) as Rollout["new"],
      earlier: decodeStoredReply(
        await seededPointer("rollback", T, other, "root"),
      ) as Rollout["earlier"],
    };
    await bucket.put("reply/mixed/1.0.0/ios", encodeRollout(mixed));
    // An object keyed by keyid would put 9 before 10.
    await bucket.put(
      NO_UPDATE_KEY,
      await identitiesNoUpdate({ root: other, main, "9": main, "10": main }),
    );
    const time = new Date(T).toISOString();
    const byMain = { kind: "manifest", updateId: UPDATE_ID, time, keyid: "main" };
    const byRoot = { kind: "rollBackToEmbedded", updateId: null, time, keyid: "root" };
    expect(await reader("status", store.env)).toBe(
      document({
        schema: 1,
        pointers: [
          { ...named(IOS), ...byMain },
          { ...named("reply/main/2.0.0/ios"), ...byRoot },
          {
            ...named("reply/mixed/1.0.0/ios"),
            kind: "rollout",
            percent: 50,
            new: byMain,
            earlier: byRoot,
          },
        ],
        noUpdate: {
          state: "present",
          version: 3,
          entries: [{ keyid: "10" }, { keyid: "9" }, { keyid: "main" }, { keyid: "root" }],
        },
        unreadable: [],
      }),
    );
  });

  test("a version-1 reply/no-update has the one entry of the keyid it is signed under", async () => {
    const store = STORES[kind]();
    await bucketFromEnv(store.env).put(NO_UPDATE_KEY, await noUpdateBy(other, "root"));
    expect(await reader("status", store.env)).toBe(
      document({
        schema: 1,
        pointers: [],
        noUpdate: { state: "present", version: 1, entries: [{ keyid: "root" }] },
        unreadable: [],
      }),
    );
  });

  test("unreadable records are listed by key, and a name outside the grammar without it; still exit 1", async () => {
    const store = STORES[kind]();
    const bucket = bucketFromEnv(store.env);
    plant(store, "reply/a b/1.0.0/ios", utf8("x"));
    await bucket.put("reply/c/1.0.0/ios", utf8("garbage"));
    await bucket.put(NO_UPDATE_KEY, MANIFEST);
    await bucket.put("reply/zz/1.0.0/ios", MANIFEST);
    expect(await reader("status", store.env, 1)).toBe(
      document({
        schema: 1,
        pointers: [{ ...named("reply/zz/1.0.0/ios"), ...MANIFEST_SIDE }],
        noUpdate: { state: "unreadable", version: null, entries: [] },
        unreadable: [
          { key: null, reason: "an object name outside the key grammar" },
          { key: "reply/c/1.0.0/ios", reason: "not a stored reply" },
          { key: NO_UPDATE_KEY, reason: "holds manifest, which does not fit its key" },
        ],
      }),
    );
  });
});

test("a failed status listing exits 2 with nothing on stdout", async () => {
  s3.failAll({ status: 500, code: "InternalError" });
  expect(await reader("status", s3Env(), 2)).toBe("");
});

/** A content key under `prefix` and its bytes. */
const content = async (prefix: "assets" | "bundles", text: string) => ({
  key: `${prefix}/${contentKey(await sha256Base64Url(utf8(text)))}`,
  bytes: utf8(text),
});

describe.each(KINDS)("tide storage --json on %s", (kind) => {
  test("an empty bucket", async () => {
    expect(await reader("storage", STORES[kind]().env)).toBe(
      document({ schema: 1, unreferenced: [], count: 0, totalBytes: "0" }),
    );
  });

  test("keys and names outside the grammar, escaped so no control or non-ASCII byte reaches a terminal", async () => {
    const store = STORES[kind]();
    const { key, bytes } = await content("bundles", "orphan");
    await bucketFromEnv(store.env).put(key, bytes);
    const odd = "assets/\u001b[31m\u2603\u007f\u{1f600}x";
    plant(store, odd, utf8("odd"));
    const stdout = await reader("storage", store.env);
    expect(stdout).toBe(
      '{"schema":1,"unreferenced":[{"name":"assets/\\u001b[31m\\u2603\\u007f\\ud83d\\ude00x","isKey":false,"size":"3"},' +
        `{"name":"${key}","isKey":true,"size":"6"}],"count":2,"totalBytes":"9"}\n`,
    );
    expect(JSON.parse(stdout)).toMatchObject({ unreferenced: [{ name: odd }, { name: key }] });
  });
});

test("a storage total past 2^53 is exact", async () => {
  const [a, b] = [await content("assets", "a"), await content("bundles", "b")];
  for (const { key, bytes } of [a, b]) {
    s3.objects.set(key, bytes);
    s3.listSize(key, "9007199254740991");
  }
  expect(await reader("storage", s3Env())).toBe(
    document({
      schema: 1,
      unreferenced: [a, b].map(({ key }) => ({ name: key, isKey: true, size: "9007199254740991" })),
      count: 2,
      totalBytes: "18014398509481982",
    }),
  );
});

test("a failed storage scan exits 1 with nothing on stdout", async () => {
  const key = recordKey(UPDATE_ID);
  s3.objects.set(key, utf8("{}"));
  s3.objects.set((await content("assets", "orphan")).key, utf8("orphan"));
  expect(await reader("storage", s3Env(), 1)).toBe("");
});

/** The writers' document for `pointers`. */
const written = (complete: boolean, pointers: unknown[]) =>
  document({ schema: 1, complete, pointers });

/** The pointer entry of the manifest stored at `key`. */
async function stamped(objects: Objects, key: string) {
  const { manifest } = await signedManifest(objects, key);
  return { key, updateId: manifest.id, time: manifest.createdAt };
}

const newIdOf = (store: Store, key: string) => {
  const pointer = decodePointer(store.objects().get(key)!);
  if (pointer.kind !== "rollout") throw new Error(`${key} holds no rollout`);
  return pointer.new.updateId;
};
const createdAtOf = (store: Store, id: string) =>
  decodeRecord(store.objects().get(recordKey(id))!).createdAt;

/** The writer configuration over `store`, without the URLs only publish needs. */
function writerEnv(store: Store): Env {
  const { TIDE_SERVER_URL: _s, TIDE_ASSET_URL: _a, ...rest } = env(store.env);
  return rest;
}
const rolloutEnv = (store: Store): Env => ({ ...pins(), ...store.env });

const publishing = (dir: string, ...extra: string[]) => [
  ...["publish", "--channel", "main", "--from", dir],
  ...extra,
];
const ok = (stdout: string) => ({ code: 0, stdout, stderr: "" });

describe.each(KINDS)("write commands with --json on %s", (kind) => {
  test("publish, republish and both rollbacks report each pointer's update ID and time", async () => {
    const store = STORES[kind]();
    const published = await tide(publishing(artifact(), "--json"), env(store.env));
    const ios = await stamped(store.objects(), IOS);
    const android = await stamped(store.objects(), ANDROID);
    expect(published).toEqual(ok(written(true, [ios, android])));

    const republished = await tide(
      ["republish", ios.updateId, "--channel", "beta", "--json"],
      writerEnv(store),
    );
    const beta = await stamped(store.objects(), "reply/beta/1.0.0/ios");
    expect(republished).toEqual(ok(written(true, [beta])));

    const embedded = await tide(
      ["rollback", "--json", "--embedded", ...TARGET, "--platform", "ios"],
      writerEnv(store),
    );
    const { pointers } = JSON.parse(embedded.stdout) as { pointers: { time: string }[] };
    const stored = await tide(["status"], store.env);
    expect(stored.stdout).toContain(`main 1.0.0 ios rollBackToEmbedded - ${pointers[0]?.time}\n`);
    expect(embedded).toEqual(
      ok(written(true, [{ key: IOS, updateId: null, time: pointers[0]?.time }])),
    );

    const back = await tide(["rollback", "--to", ios.updateId, "--json"], writerEnv(store));
    expect(back).toEqual(ok(written(true, [await stamped(store.objects(), IOS)])));
  });

  test("publish --rollout and rollout report what they wrote, and a run with nothing to write an empty list", async () => {
    const store = STORES[kind]();
    const dir = artifact();
    const staged = await tide(publishing(dir, "--rollout", "0.01", "--json"), env(store.env));
    const [ios, android] = [newIdOf(store, IOS), newIdOf(store, ANDROID)];
    expect(staged).toEqual(
      ok(
        written(true, [
          { key: IOS, updateId: ios, time: createdAtOf(store, ios) },
          { key: ANDROID, updateId: android, time: createdAtOf(store, android) },
        ]),
      ),
    );
    const rerun = await tide(publishing(dir, "--rollout", "0.01", "--json"), env(store.env));
    expect(rerun).toEqual(ok(written(true, [])));

    const raise = (goal: string, ...extra: string[]) =>
      tide(["rollout", goal, ...TARGET, ...extra, "--json"], rolloutEnv(store));
    expect(await raise("12.5", "--platform", "ios")).toEqual(
      ok(written(true, [{ key: IOS, updateId: ios, percent: 12.5 }])),
    );
    // iOS is at its goal, so this run writes only Android.
    expect(await raise("12.5")).toEqual(
      ok(written(true, [{ key: ANDROID, updateId: android, percent: 12.5 }])),
    );
    expect(await raise("12.5")).toEqual(ok(written(true, [])));
    expect(await raise("complete", "--platform", "ios")).toEqual(
      ok(written(true, [{ key: IOS, updateId: ios, percent: 100 }])),
    );
    expect(await raise("revert", "--platform", "android")).toEqual(
      ok(written(true, [{ key: ANDROID, updateId: android, percent: 0 }])),
    );
  });

  test("a refusal exits 2 with the same stderr as without --json and nothing on stdout", async () => {
    const store = STORES[kind]();
    expect((await tide(publishing(artifact()), env(store.env))).code).toBe(0);
    const refused: [string[], Env][] = [
      [publishing(artifact({ fields: { version: 2 } })), env(store.env)],
      [publishing(artifact()), env(store.env, other)],
      [["rollout", "50", ...TARGET], rolloutEnv(store)],
      [
        ["rollback", "--embedded", "--channel", "typo", "--runtime-version", "1.0.0"],
        writerEnv(store),
      ],
      [["rollback", "--to", UPDATE_ID], writerEnv(store)],
      [["republish", UPDATE_ID], writerEnv(store)],
    ];
    const before = new Map(store.objects());
    for (const [args, environment] of refused) {
      const text = await tide(args, environment);
      expect(text.code, args[0]).toBe(2);
      expect(await tide([...args, "--json"], environment)).toEqual({ ...text, stdout: "" });
      expect(text.stderr).toMatch(/^tide: /);
    }
    expect(new Map(store.objects())).toEqual(before);
  });
});

describe("a write that fails after writes began", () => {
  // Each fault is set once per run, so the text run and the --json run meet the same one.
  test.each([
    [
      "a stale ETag",
      (bytes: Uint8Array) => s3.raceOnPut(ANDROID, bytes),
      `tide: ${ANDROID} was changed by another writer since it was read; it keeps theirs\n`,
    ],
    [
      "a lost response",
      () => s3.dropAfterPut(ANDROID),
      `tide: ${ANDROID}: S3 PutObject failed: network error; outcome unknown; check with tide status\n`,
    ],
  ])("%s on the second pointer lists only the first, exit 1", async (name, fault, stderr) => {
    const theirs = await seededPointer("rollback", Date.now());
    const args = publishing(artifact());
    fault(theirs);
    expect(await tide(args, env(s3Env()))).toMatchObject({ code: 1, stderr });

    s3.reset();
    fault(theirs);
    const result = await tide([...args, "--json"], env(s3Env()));
    expect(result).toEqual({
      code: 1,
      stdout: written(false, [await stamped(s3.objects, IOS)]),
      stderr,
    });
    const second = s3.objects.get(ANDROID);
    if (name === "a stale ETag") expect(second).toEqual(theirs);
    else expect((await signedManifest(s3.objects, ANDROID)).manifest.runtimeVersion).toBe("1.0.0");
  });

  test("a rerun of a half-written publish --rollout lists only the pointer it wrote", async () => {
    const dir = artifact();
    s3.holdPut(ANDROID);
    const first = await tide(publishing(dir, "--rollout", "50", "--json"), env(s3Env()));
    const ios = newIdOf(STORES.s3(), IOS);
    const store = STORES.s3();
    expect([first.code, first.stdout]).toEqual([
      1,
      written(false, [{ key: IOS, updateId: ios, time: createdAtOf(store, ios) }]),
    ]);
    const rerun = await tide(publishing(dir, "--rollout", "50", "--json"), env(s3Env()));
    const android = newIdOf(store, ANDROID);
    expect(rerun).toEqual(
      ok(written(true, [{ key: ANDROID, updateId: android, time: createdAtOf(store, android) }])),
    );
  });

  test("a second rollout write that loses its race lists only the first", async () => {
    const store = STORES.s3();
    expect((await tide(publishing(artifact(), "--rollout", "50"), env(s3Env()))).code).toBe(0);
    const ios = newIdOf(store, IOS);
    s3.raceOnPut(ANDROID, await seededPointer("rollback", Date.now()));
    expect(await tide(["rollout", "complete", ...TARGET, "--json"], rolloutEnv(store))).toEqual({
      code: 1,
      stdout: written(false, [{ key: IOS, updateId: ios, percent: 100 }]),
      stderr: `tide: ${ANDROID} was changed by another writer since it was read; it keeps theirs\n`,
    });
  });

  test("a lost reply/no-update race, before any pointer, is an incomplete document with no pointers", async () => {
    s3.raceOnPut(NO_UPDATE_KEY, await noUpdateBy(other, "root"));
    expect(await tide(publishing(artifact(), "--json"), env(s3Env()))).toEqual({
      code: 1,
      stdout: written(false, []),
      stderr:
        "tide: reply/no-update was changed by another writer during the publish; it keeps theirs: run again\n",
    });
    expect(s3.puts).not.toContain(IOS);
  });
});

test("an uncaught error after the first pointer prints it as incomplete, and still rejects", async () => {
  s3.setNow(T);
  expect(
    await cmd("publish", ["--channel", "main", "--from", artifact()], env(s3Env()), () => T),
  ).toMatchObject({ code: 0 });
  s3.puts.length = 0;
  const out: string[] = [];
  const err: string[] = [];
  const now = () => {
    if (s3.puts.includes(IOS)) throw new Error("clock");
    return T;
  };
  const rolling = rollback(["--embedded", ...TARGET, "--json"], writerEnv(STORES.s3()), {
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    now,
  });
  expect((await rejection(rolling)).message).toBe("clock");
  const time = new Date(T + 1).toISOString();
  expect({ out, err }).toEqual({
    out: [written(false, [{ key: IOS, updateId: null, time }]).trimEnd()],
    err: [],
  });
  expect(s3.puts).not.toContain(ANDROID);
});

// Literal text, not the constants, so a refusal's text cannot change with them.
const USAGE = {
  publish:
    "usage: tide publish --from <dir> --channel <name> [--rollout <percent>] [--add-identity]",
  rollout:
    "usage: tide rollout <percent>|complete|revert --channel <name> --runtime-version <version> [--platform ios|android]...",
  rollback:
    "usage: tide rollback --embedded --channel <name> --runtime-version <version> [--platform ios|android]...\n       tide rollback --to <updateId> [--to <updateId>]...",
  republish: "usage: tide republish <updateId>... [--channel <name>] [--runtime-version <version>]",
  probe:
    "usage: tide probe --server-url <url> --channel <name> --runtime-version <version> --platform ios|android [--app-id <id>]",
};

describe("usage", () => {
  test.each<[keyof typeof USAGE, string]>([
    ["publish", "--from and --channel are required"],
    ["rollout", "give one percentage, complete or revert"],
    ["rollback", "give --embedded or --to"],
    ["republish", "give at least one update ID"],
    ["probe", "--server-url, --channel and --runtime-version are required"],
  ])(
    "%s refuses missing and unknown arguments in the same text, with --json or without",
    async (command, missing) => {
      const refusal = (message: string) => ({
        code: 2,
        stdout: "",
        stderr: `tide: ${message}; ${USAGE[command]}\n`,
      });
      expect(await tide([command], {})).toEqual(refusal(missing));
      expect(await tide([command, "--json"], {})).toEqual(refusal(missing));
      expect(await tide([command, "--nope"], {})).toEqual(refusal("unrecognised arguments"));
      expect(await tide([command, "--nope", "--json"], {})).toEqual(
        refusal("unrecognised arguments"),
      );
    },
  );

  test("a bad argument or command prints the listing without the new flags; no command adds them", async () => {
    const environment = { TIDE_DISK_DIR: tempRoot() };
    const none = await tide([], environment);
    const legacy = await tide(["nope"], environment);
    expect(legacy).toMatchObject({ code: 2, stdout: "" });
    expect(
      legacy.stderr.startsWith("usage: tide status\nusage: tide storage\nusage: tide export "),
    ).toBe(true);
    for (const text of Object.values(USAGE)) expect(legacy.stderr).toContain(`\n${text}\n`);
    expect(legacy.stderr).not.toContain("--json");
    expect(legacy.stderr).not.toContain("--rollout-side");
    for (const args of [
      ["status", "--"],
      ["status", "x"],
      ["status", "--json", "x"],
      ["status", "--json", "--json"],
      ["storage", "--Json"],
      ["nope", "--json"],
    ]) {
      expect(await tide(args, environment)).toEqual(legacy);
    }
    expect(none).toEqual({
      code: 2,
      stdout: "",
      stderr: `${legacy.stderr}       tide status --json
       tide storage --json
       tide publish ... --json
       tide rollout ... --json
       tide rollback ... --json
       tide republish ... --json
       tide probe ... [--rollout-side new --rollout-update <updateId>] [--json]
`,
    });
  });

  test("commands without a document refuse --json", async () => {
    for (const command of ["export", "register-build", "certificate"]) {
      const result = await tide([command, "--json"], {});
      expect([command, result.code, result.stdout]).toEqual([command, 2, ""]);
    }
  });
});
