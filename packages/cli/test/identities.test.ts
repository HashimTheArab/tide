// Several signing identities on one bucket, one per runtimeVersion: A (key main, keyid main) on 1.0.0 and B (key
// other, keyid b) on 2.0.0, added through reply/no-update alone.
import { KeyObject, createHash } from "node:crypto";
import { appendFileSync, cpSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, onTestFinished, test } from "vitest";

import type { NoUpdateReply } from "@tide-ota/protocol";
import {
  NO_UPDATE_KEY,
  certificatePublicKey,
  contentKey,
  decodeNoUpdate,
  decodeStoredReply,
  encodeIdentityNoUpdate,
  encodeRollout,
  identityKey,
  parseMultipart,
  sha256Base64Url,
  verifyExpoSignature,
} from "@tide-ota/protocol";

import type { Issued } from "./chain-fixture.ts";
import type { Identity, Store } from "./publish-fixture.ts";
import { startServer, storeFromEnv } from "../../server/src/node.ts";
import {
  chainEnv,
  chainExport,
  expectChained,
  generate,
  leaf,
  root,
  served,
} from "./chain-fixture.ts";
import { FAKE_KMS, startFakeKms } from "./fake-kms.ts";
import { tempRoot, utf8 } from "./helpers.ts";
import {
  ANDROID,
  CHAIN_ROOT,
  EXPORT,
  IOS,
  NOT_ADDED,
  OTHER_RUNTIME,
  RESTORE,
  artifact,
  env,
  identity,
  main,
  noUpdateBy,
  other,
  s3,
  s3Snapshot,
  seededPointer,
  STORES,
  cmd,
  useFixture,
} from "./publish-fixture.ts";

useFixture();

const B_IOS = "reply/main/2.0.0/ios";
const B_ANDROID = "reply/main/2.0.0/android";
const CHANGED =
  "reply/no-update was changed by another writer during the publish; it keeps theirs: run again";

/** A signing identity's pins, the export fields its builds carry, and its writer configuration over a store. */
interface Signing {
  readonly keyid: string;
  readonly fields: Record<string, unknown>;
  readonly env: (store: Store) => Record<string, string>;
}

/** A direct identity: `id`'s certificate and key under `keyid`. */
const direct = (id: Identity, keyid: string): Signing => ({
  keyid,
  fields: { certificate: id.certificate, codeSigningMetadata: { keyid, alg: "rsa-v1_5-sha256" } },
  env: (store) => ({
    ...env(store.env, id),
    TIDE_BUILD_KEYID: keyid,
    TIDE_BUILD_CERTIFICATE: id.certificate,
  }),
});

/** A chain-mode identity: builds embedding `rootCa` under `keyid`, signed by `chain`'s first member. */
const chained = (rootCa: Issued, chain: readonly Issued[], keyid: string): Signing => ({
  keyid,
  fields: {
    ...chainExport(rootCa.certificate),
    codeSigningMetadata: { keyid, alg: "rsa-v1_5-sha256" },
  },
  env: (store) => ({
    ...chainEnv(store.env, rootCa.certificate, served(...chain), chain[0]!),
    TIDE_BUILD_KEYID: keyid,
  }),
});

const A = () => direct(main, "main");
const B = () => direct(other, "b");

/**
 * An export of `signing`'s builds at `runtime`. Off 1.0.0 it is the fixture export with other bundle bytes and one more
 * asset, so none of its uploads is already stored.
 */
function exportOf(signing: Signing, runtime: string, platforms = ["ios", "android"]): string {
  let dist = EXPORT;
  if (runtime !== "1.0.0") {
    dist = join(tempRoot(), "dist");
    cpSync(EXPORT, dist, { recursive: true });
    for (const p of ["ios/index-ios.hbc", "android/index-android.hbc"]) {
      appendFileSync(join(dist, "_expo", "static", "js", p), `// ${runtime}\n`);
    }
    const extra = utf8(`an asset of ${runtime}`);
    const md5 = createHash("md5").update(extra).digest("hex");
    writeFileSync(join(dist, "assets", md5), extra);
    const metadata = JSON.parse(readFileSync(join(dist, "metadata.json"), "utf8")) as {
      fileMetadata: Record<string, { assets: object[] }>;
    };
    for (const p of ["ios", "android"]) {
      metadata.fileMetadata[p]!.assets.push({ path: `assets/${md5}`, ext: "png" });
    }
    writeFileSync(join(dist, "metadata.json"), JSON.stringify(metadata));
  }
  const targets = Object.fromEntries(platforms.map((p) => [p, { runtimeVersion: runtime }]));
  return artifact({ dist, fields: { ...signing.fields, platforms: targets } });
}

/** Publishes `dir` to `channel` as `signing`, with `extra` arguments. */
const publishAs = (
  store: Store,
  signing: Signing,
  dir: string,
  extra: string[] = [],
  channel = "main",
) => cmd("publish", ["--channel", channel, "--from", dir, ...extra], signing.env(store));

/** The bytes a request gets: status, the headers that pick and cache a reply, and the body. */
interface Wire {
  readonly status: number;
  readonly contentType: string | null;
  readonly vary: string | null;
  readonly body: string; // base64
}

/** One `/manifest` request of a signing build. */
interface Ask {
  readonly keyid: string;
  readonly runtime: string;
  readonly platform?: string;
  readonly channel?: string;
  readonly current?: string;
}

/** Starts the real Node server over `store`; returns what it answers each request. */
async function serve(store: Store) {
  const server = await startServer({ port: 0, store: storeFromEnv(store.env) });
  onTestFinished(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return async (ask: Ask): Promise<Wire> => {
    const res = await fetch(`${base}/manifest`, {
      headers: {
        "expo-platform": ask.platform ?? "ios",
        "expo-channel-name": ask.channel ?? "main",
        "expo-runtime-version": ask.runtime,
        "expo-protocol-version": "1",
        accept: "multipart/mixed",
        "expo-expect-signature": `sig, keyid="${ask.keyid}", alg="rsa-v1_5-sha256"`,
        ...(ask.current && { "expo-current-update-id": ask.current }),
      },
    });
    const body = Buffer.from(await res.arrayBuffer()).toString("base64");
    return {
      status: res.status,
      contentType: res.headers.get("content-type"),
      vary: res.headers.get("vary"),
      body,
    };
  };
}

/** Every request the identity tests make, by a label. */
const ASKS: Readonly<Record<string, Ask>> = Object.fromEntries(
  ["main", "b"].flatMap((keyid) => [
    [`${keyid} 1.0.0 ios`, { keyid, runtime: "1.0.0" }],
    [`${keyid} 1.0.0 android`, { keyid, runtime: "1.0.0", platform: "android" }],
    [`${keyid} 2.0.0 ios`, { keyid, runtime: "2.0.0" }],
    [`${keyid} 2.0.0 android`, { keyid, runtime: "2.0.0", platform: "android" }],
    [`${keyid} none`, { keyid, runtime: "1.0.0", channel: "none" }],
  ]),
);

/** What the server answers every request in `ASKS`. */
async function views(store: Store): Promise<Record<string, Wire>> {
  const get = await serve(store);
  const out: Record<string, Wire> = {};
  for (const [label, ask] of Object.entries(ASKS)) out[label] = await get(ask);
  return out;
}

/** The wire form of a stored reply, picked by keyid when `byKeyId`. */
function wireOf(reply: { boundary: string; body: Uint8Array }, byKeyId: boolean): Wire {
  return {
    status: 200,
    contentType: `multipart/mixed; boundary=${reply.boundary}`,
    vary: byKeyId ? "Expo-Expect-Signature" : null,
    body: Buffer.from(reply.body).toString("base64"),
  };
}

/** The stored pointer at `key` as served, every keyid alike. */
const pointerWire = (store: Store, key: string) =>
  wireOf(decodeStoredReply(stored(store, key)), false);

/** `keyid`'s entry of the stored version-3 `reply/no-update` as served. */
const entryWire = (store: Store, keyid: string) => wireOf(entry(store, keyid), true);

/** The keyids of the stored version-3 `reply/no-update`, in keyid order. */
function keyids(store: Store): string[] {
  const record = decodeNoUpdate(stored(store, NO_UPDATE_KEY));
  if (record.kind !== "identities") throw new Error("reply/no-update is version 1");
  return [...record.entries.keys()];
}

/** `keyid`'s entry in the stored version-3 `reply/no-update`. */
function entry(store: Store, keyid: string): NoUpdateReply {
  const record = decodeNoUpdate(stored(store, NO_UPDATE_KEY));
  if (record.kind !== "identities") throw new Error("reply/no-update is version 1");
  const found = record.entries.get(keyid);
  if (found === undefined) throw new Error(`reply/no-update has no entry for ${keyid}`);
  return found;
}

function stored(store: Store, key: string): Uint8Array<ArrayBuffer> {
  const bytes = store.objects().get(key);
  if (bytes === undefined) throw new Error(`${key} is absent`);
  return new Uint8Array(bytes);
}

/** The update ID a stored manifest pointer serves. */
function updateIdAt(store: Store, key: string): string {
  const reply = decodeStoredReply(stored(store, key));
  if (reply.kind !== "manifest") throw new Error(`${key} is not a manifest`);
  return reply.updateId;
}

/** Fails unless `reply`'s directive verifies under `id`'s certificate and `keyid`. */
async function expectSignedBy(reply: NoUpdateReply, id: Identity, keyid: string) {
  const [part] = parseMultipart(reply.body, reply.boundary);
  if (part?.signature === undefined) throw new Error("no signed directive");
  const key = await certificatePublicKey(id.certificate);
  await expect(verifyExpoSignature(part.body, part.signature, key, keyid)).resolves.toBeUndefined();
}

/** A publishes on 1.0.0; B adds itself on 2.0.0. Returns the version-1 `reply/no-update` A's publish left. */
async function twoIdentities(store: Store) {
  expect(await publishAs(store, A(), exportOf(A(), "1.0.0"))).toMatchObject({ code: 0, err: [] });
  const legacy = stored(store, NO_UPDATE_KEY);
  const added = await publishAs(store, B(), exportOf(B(), "2.0.0"), ["--add-identity"]);
  expect(added).toMatchObject({ code: 0, err: [] });
  return { legacy };
}

describe.each(Object.keys(STORES) as (keyof typeof STORES)[])("two identities on %s", (kind) => {
  const open = () => STORES[kind]();

  test("B adds itself on its own runtime: A's reply is kept byte for byte, and each keyid is served its own", async () => {
    const store = open();
    expect(await publishAs(store, A(), exportOf(A(), "1.0.0"))).toMatchObject({ code: 0 });
    const before = new Map(store.objects());
    const legacy = stored(store, NO_UPDATE_KEY);
    const ownedByA = await views(store);
    const dirB = exportOf(B(), "2.0.0");

    expect(await publishAs(store, B(), dirB)).toEqual({
      code: 2,
      out: [],
      err: [`tide: ${NOT_ADDED("b")}`],
    });
    expect(new Map(store.objects())).toEqual(before);
    const added = await publishAs(store, B(), dirB, ["--add-identity"]);
    expect(added).toMatchObject({ code: 0, err: [] });
    expect(added.out.map((l) => l.split(" ")[0])).toEqual([B_IOS, B_ANDROID]);

    // reply/no-update is {b: B's, main: A's exact version-1 reply}; nothing else of A's changed.
    const bEntry = entry(store, "b");
    await expectSignedBy(bEntry, other, "b");
    const expected = new Map([
      ["b", bEntry],
      ["main", decodeStoredReply(legacy) as NoUpdateReply],
    ]);
    expect(stored(store, NO_UPDATE_KEY)).toEqual(encodeIdentityNoUpdate(expected));
    for (const [key, bytes] of before)
      if (key !== NO_UPDATE_KEY) expect(stored(store, key)).toEqual(bytes);
    expect([...store.objects().keys()].filter((k) => k.startsWith("identities/"))).toEqual([]);
    // A CLI of 0.1.0 to P12 reads reply/no-update with the version-1 decoder, so it refuses rather than overwrites.
    expect(() => decodeStoredReply(stored(store, NO_UPDATE_KEY))).toThrow(
      "version is not supported",
    );

    const now = await views(store);
    for (const label of ["main 1.0.0 ios", "main 1.0.0 android"])
      expect(now[label]).toEqual(ownedByA[label]);
    expect(now["main none"]).toEqual({ ...ownedByA["main none"], vary: "Expo-Expect-Signature" });
    expect(now["b none"]).toEqual(entryWire(store, "b"));
    expect(now["b 2.0.0 ios"]).toEqual(pointerWire(store, B_IOS));
    expect(now["b 2.0.0 android"]).toEqual(pointerWire(store, B_ANDROID));

    const get = await serve(store);
    const onA = { keyid: "main", runtime: "1.0.0", current: updateIdAt(store, IOS) };
    expect(await get(onA)).toEqual(entryWire(store, "main"));
    const onB = { keyid: "b", runtime: "2.0.0", current: updateIdAt(store, B_IOS) };
    expect(await get(onB)).toEqual(entryWire(store, "b"));
    expect((await get({ keyid: "other", runtime: "1.0.0", channel: "none" })).status).toBe(404);
  });

  test("--add-identity is a no-op once the entry exists, and A's next publish changes only A's pointers", async () => {
    const store = open();
    await twoIdentities(store);
    const fallback = stored(store, NO_UPDATE_KEY);
    s3.puts.length = 0;
    const again = await publishAs(store, B(), exportOf(B(), "2.0.0"), ["--add-identity"]);
    expect(again).toMatchObject({ code: 0, err: [] });
    const pointers = (keys: string[]) => keys.map((k) => stored(store, k));
    const [aPointers, bPointers] = [pointers([IOS, ANDROID]), pointers([B_IOS, B_ANDROID])];
    expect(await publishAs(store, A(), exportOf(A(), "1.0.0"))).toMatchObject({ code: 0, err: [] });
    expect(stored(store, NO_UPDATE_KEY)).toEqual(fallback);
    if (kind === "s3") expect(s3.puts).not.toContain(NO_UPDATE_KEY);
    expect(pointers([B_IOS, B_ANDROID])).toEqual(bPointers);
    for (const [i, key] of [IOS, ANDROID].entries())
      expect(stored(store, key)).not.toEqual(aPointers[i]);
  });

  test("a third identity merges onto both entries, copying each byte for byte", async () => {
    const store = open();
    await twoIdentities(store);
    const before = decodeNoUpdate(stored(store, NO_UPDATE_KEY));
    const third = direct(await identity(), "c");
    const dir = exportOf(third, "3.0.0");
    expect(await publishAs(store, third, dir)).toEqual({
      code: 2,
      out: [],
      err: [`tide: ${NOT_ADDED("c")}`],
    });
    expect(await publishAs(store, third, dir, ["--add-identity"])).toMatchObject({
      code: 0,
      err: [],
    });
    const after = decodeNoUpdate(stored(store, NO_UPDATE_KEY));
    if (before.kind !== "identities" || after.kind !== "identities")
      throw new Error("not version 3");
    expect([...after.entries.keys()]).toEqual(["b", "c", "main"]);
    for (const keyid of ["b", "main"])
      expect(after.entries.get(keyid)).toEqual(before.entries.get(keyid));
  });

  test("--add-identity on an empty bucket writes the version-1 reply/no-update a plain publish writes", async () => {
    const directive = (s: Store) => {
      const reply = decodeStoredReply(stored(s, NO_UPDATE_KEY));
      return parseMultipart(reply.body, reply.boundary).map(({ name, body, signature }) => [
        name,
        body,
        signature,
      ]);
    };
    const plain = open();
    expect(await publishAs(plain, A(), exportOf(A(), "1.0.0"))).toMatchObject({ code: 0 });
    const expected = directive(plain);
    const adding = open();
    if (kind === "s3") s3.reset();
    expect(await publishAs(adding, A(), exportOf(A(), "1.0.0"), ["--add-identity"])).toMatchObject({
      code: 0,
    });
    expect(directive(adding)).toEqual(expected);
  });
});

describe("one identity per runtime", () => {
  const store = () => STORES.s3();
  const ALL = ["--channel", "main", "--runtime-version", "1.0.0"];

  /** Refuses `run` with the runtime refusal of `key`, the bucket unchanged and nothing written. */
  async function refused(run: () => Promise<{ code: number; err: string[] }>, message: string) {
    const before = s3Snapshot();
    s3.puts.length = 0;
    const result = await run();
    expect(result).toMatchObject({ code: 2, err: [`tide: ${message}`] });
    expect(s3Snapshot()).toEqual(before);
    expect(s3.puts).toEqual([]);
  }

  test("every writer and register-build refuses B on A's runtime, whatever channel holds A's pointer", async () => {
    const s = store();
    await twoIdentities(s);
    const aIos = updateIdAt(s, IOS);
    const writer = B().env(s);
    const pinsOnly = { TIDE_BUILD_KEYID: "b", TIDE_BUILD_CERTIFICATE: other.certificate, ...s.env };
    await refused(
      () => publishAs(s, B(), exportOf(B(), "1.0.0"), ["--add-identity"], "beta"),
      OTHER_RUNTIME(ANDROID),
    );
    await refused(() => cmd("rollback", ["--embedded", ...ALL], writer), OTHER_RUNTIME(IOS));
    await refused(() => cmd("rollback", ["--to", aIos], writer), OTHER_RUNTIME(IOS));
    await refused(() => cmd("republish", [aIos, "--channel", "beta"], writer), OTHER_RUNTIME(IOS));
    await refused(
      () =>
        cmd(
          "registerBuild",
          [...storeBuild(), "--platform", "android", "--runtime-version", "1.0.0"],
          pinsOnly,
        ),
      OTHER_RUNTIME(ANDROID),
    );
  });

  test.each([
    ["new", "main", "b"],
    ["earlier", "b", "main"],
  ])("a rollout at the target whose %s side is A's refuses B", async (_, newBy, earlierBy) => {
    const s = store();
    await twoIdentities(s);
    const signer = { main, b: other } as Record<string, Identity>;
    const target = "reply/beta/1.0.0/ios";
    const next = decodeStoredReply(
      await seededPointer("manifest", Date.now(), signer[newBy], newBy),
    );
    const earlier = decodeStoredReply(
      await seededPointer("rollback", Date.now(), signer[earlierBy], earlierBy),
    );
    if (next.kind !== "manifest" || earlier.kind !== "rollBackToEmbedded")
      throw new Error("not seeded");
    s3.objects.set(target, encodeRollout({ kind: "rollout", percent: 50, new: next, earlier }));
    await refused(
      () => publishAs(s, B(), exportOf(B(), "1.0.0", ["ios"]), [], "beta"),
      OTHER_RUNTIME(target),
    );
  });

  test("an unreadable pointer of the target runtime refuses, since its owner is unknown", async () => {
    const s = store();
    await twoIdentities(s);
    s3.objects.set("reply/x/3.0.0/ios", utf8("garbage"));
    await refused(
      () => publishAs(s, B(), exportOf(B(), "3.0.0", ["ios"]), [], "beta"),
      "reply/x/3.0.0/ios is unreadable: not a stored reply",
    );
  });

  test("a target that was A's when read refuses, even when it is gone before the listing", async () => {
    const s = store();
    await twoIdentities(s);
    s3.onGet(IOS, () => s3.objects.delete(IOS));
    s3.puts.length = 0;
    const result = await publishAs(s, B(), exportOf(B(), "1.0.0", ["ios"]));
    expect(result).toMatchObject({ code: 2, err: [`tide: ${OTHER_RUNTIME(IOS)}`] });
    expect(s3.objects.has(IOS)).toBe(false);
    expect(s3.puts).toEqual([]);
  });

  test("A's pointers and unreadable pointers of other runtimes block neither B's publish, rollout nor register-build", async () => {
    const s = store();
    await twoIdentities(s);
    s3.objects.set("reply/x/1.0.0/ios", utf8("garbage"));
    s3.objects.set("reply/x/2.0.0/web", utf8("a name outside the key grammar"));
    const dir = exportOf(B(), "2.0.0");
    expect(await publishAs(s, B(), dir, ["--rollout", "10"])).toMatchObject({ code: 0, err: [] });
    const pinsOnly = { TIDE_BUILD_KEYID: "b", TIDE_BUILD_CERTIFICATE: other.certificate, ...s.env };
    const target = ["--channel", "main", "--runtime-version", "2.0.0"];
    expect(await cmd("rollout", ["complete", ...target], pinsOnly)).toMatchObject({
      code: 0,
      err: [],
    });
    const build = [...storeBuild(), "--platform", "android", "--runtime-version", "2.0.0"];
    expect(await cmd("registerBuild", build, pinsOnly)).toMatchObject({ code: 0, err: [] });
  });
});

describe("writers that sign nothing new, and identities that cannot be added", () => {
  const store = () => STORES.s3();

  test("rollback, republish, rollout and register-build without an entry name --add-identity", async () => {
    const s = store();
    await twoIdentities(s);
    const third = direct(await identity(), "c");
    const writer = third.env(s);
    const pinsOnly = {
      TIDE_BUILD_KEYID: "c",
      TIDE_BUILD_CERTIFICATE: writer.TIDE_BUILD_CERTIFICATE!,
      ...s.env,
    };
    const target = ["--channel", "main", "--runtime-version", "3.0.0"];
    const before = s3Snapshot();
    for (const result of [
      await cmd("rollback", ["--embedded", ...target], writer),
      await cmd("republish", [updateIdAt(s, B_IOS)], writer),
      await cmd("rollout", ["complete", ...target], pinsOnly),
      await cmd(
        "registerBuild",
        [...storeBuild(), "--platform", "ios", "--runtime-version", "3.0.0"],
        pinsOnly,
      ),
    ]) {
      expect(result).toEqual({ code: 2, out: [], err: [`tide: ${NOT_ADDED("c")}`] });
    }
    expect(s3Snapshot()).toEqual(before);
  });

  test.each<[string, () => Promise<Uint8Array<ArrayBuffer>>, string]>([
    [
      "a 17th identity",
      async () => {
        const entries = new Map<string, NoUpdateReply>();
        for (let i = 0; i < 16; i++) {
          const keyid = `k${String(i).padStart(2, "0")}`;
          entries.set(keyid, decodeStoredReply(await noUpdateBy(main, keyid)) as NoUpdateReply);
        }
        return encodeIdentityNoUpdate(entries);
      },
      "reply/no-update: identities must be an array of 1 to 16 entries",
    ],
    [
      "a legacy keyid over 4 KiB",
      () => noUpdateBy(main, "k".repeat(5000)),
      "reply/no-update: identities[1].keyid is longer than 4096 bytes escaped",
    ],
  ])("%s refuses before any write", async (_, fallback, message) => {
    const s = store();
    s3.objects.set(NO_UPDATE_KEY, await fallback());
    const before = s3Snapshot();
    const result = await publishAs(s, B(), exportOf(B(), "2.0.0"), ["--add-identity"]);
    expect(result).toEqual({ code: 2, out: [], err: [`tide: ${message}`] });
    expect(s3Snapshot()).toEqual(before);
    expect(s3.puts).toEqual([]);
  });
});

/** A store build with no assets, for register-build: its manifest and bundle arguments. */
function storeBuild(): string[] {
  const dir = tempRoot();
  writeFileSync(
    join(dir, "app.manifest"),
    JSON.stringify({ id: "1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed", commitTime: 1, assets: [] }),
  );
  writeFileSync(join(dir, "index.bundle"), "embedded bytes");
  return ["--manifest", join(dir, "app.manifest"), "--bundle", join(dir, "index.bundle")];
}

describe("chain-mode identities", () => {
  let ca: Issued;
  let leaves: Issued[];
  beforeAll(async () => {
    ca = await root(await generate(), "Tide root");
    leaves = [
      await leaf(ca, "Tide root", "Tide leaf 1"),
      await leaf(ca, "Tide root", "Tide leaf 2"),
    ];
  });
  const store = () => STORES.s3();

  test("a chained B binds its root before reply/no-update, and its entry carries its chain", async () => {
    const s = store();
    expect(await publishAs(s, A(), exportOf(A(), "1.0.0"))).toMatchObject({ code: 0 });
    const legacy = stored(s, NO_UPDATE_KEY);
    s3.puts.length = 0;
    const b = chained(ca, [leaves[0]!], "b");
    expect(await publishAs(s, b, exportOf(b, "2.0.0"), ["--add-identity"])).toMatchObject({
      code: 0,
      err: [],
    });
    const binding = await identityKey("b");
    expect(s3.puts.indexOf(binding)).toBeGreaterThanOrEqual(0);
    expect(s3.puts.indexOf(binding)).toBeLessThan(s3.puts.indexOf(NO_UPDATE_KEY));
    await expectChained(
      stored(s, NO_UPDATE_KEY),
      NO_UPDATE_KEY,
      ca.certificate,
      served(leaves[0]!),
      Date.now(),
      "b",
    );
    expect(entry(s, "main")).toEqual(decodeStoredReply(legacy));
  });

  test("a chained A's renewal rewrites only A's entry, and a one-entry version-3 record stays version 3", async () => {
    const s = store();
    const a1 = chained(ca, [leaves[0]!], "main");
    expect(await publishAs(s, a1, exportOf(a1, "1.0.0"))).toMatchObject({ code: 0 });
    // As a one-entry version-3 record: renewal keeps the version read.
    const one = new Map([["main", decodeStoredReply(stored(s, NO_UPDATE_KEY)) as NoUpdateReply]]);
    s3.objects.set(NO_UPDATE_KEY, encodeIdentityNoUpdate(one));
    const a2 = chained(ca, [leaves[1]!], "main");
    expect(await publishAs(s, a2, exportOf(a2, "1.0.0"))).toMatchObject({ code: 0, err: [] });
    expect(keyids(s)).toEqual(["main"]);
    await expectChained(
      stored(s, NO_UPDATE_KEY),
      NO_UPDATE_KEY,
      ca.certificate,
      served(leaves[1]!),
      Date.now(),
    );

    expect(await publishAs(s, B(), exportOf(B(), "2.0.0"), ["--add-identity"])).toMatchObject({
      code: 0,
    });
    const bEntry = entry(s, "b");
    expect(await publishAs(s, a1, exportOf(a1, "1.0.0"))).toMatchObject({ code: 0, err: [] });
    await expectChained(
      stored(s, NO_UPDATE_KEY),
      NO_UPDATE_KEY,
      ca.certificate,
      served(leaves[0]!),
      Date.now(),
    );
    expect(entry(s, "b")).toEqual(bEntry);
  });

  test("a chain keyid stays reserved when B's first publish stops after its binding", async () => {
    const s = store();
    expect(await publishAs(s, A(), exportOf(A(), "1.0.0"))).toMatchObject({ code: 0 });
    const b = chained(ca, [leaves[0]!], "b");
    const dir = exportOf(b, "2.0.0");
    const binding = await identityKey("b");
    s3.dropAfterPut(binding);
    expect((await publishAs(s, b, dir, ["--add-identity"])).code).toBe(1);
    expect(s3.objects.has(binding)).toBe(true);
    expect(decodeStoredReply(stored(s, NO_UPDATE_KEY)).kind).toBe("noUpdateAvailable");
    const before = s3Snapshot();
    const directB = direct(other, "b");
    expect(await publishAs(s, directB, exportOf(directB, "2.0.0"), ["--add-identity"])).toEqual({
      code: 2,
      out: [],
      err: [`tide: ${CHAIN_ROOT(binding, "b")}`],
    });
    expect(s3Snapshot()).toEqual(before);
    expect(await publishAs(s, b, dir, ["--add-identity"])).toMatchObject({ code: 0, err: [] });
  });
});

describe("B's first publish interrupted after each write", () => {
  let ca: Issued;
  let chain: Issued;
  beforeAll(async () => {
    ca = await root(await generate(), "Tide root");
    chain = await leaf(ca, "Tide root", "Tide leaf");
  });
  const B_CHAINED = () => chained(ca, [chain], "b");

  // In commit order. A dropped PUT commits, then its response is lost.
  const WRITES: readonly [string, (dir: string) => Promise<string>][] = [
    ["bundle", async (dir) => `bundles/${contentKey(await launchHash(dir))}`],
    ["asset", async () => `assets/${contentKey(await sha256Base64Url(utf8("an asset of 2.0.0")))}`],
    ["chain binding", () => identityKey("b")],
    ["reply/no-update", () => Promise.resolve(NO_UPDATE_KEY)],
    ["release record", () => Promise.resolve("updates/")],
    ["base record", () => Promise.resolve("bases/")],
    ["pointer", () => Promise.resolve(B_IOS)],
  ];
  const CONVERTED = WRITES.findIndex(([name]) => name === "reply/no-update");

  test.each(WRITES.map(([name], i) => [name, i] as const))(
    "after the %s, A keeps its bytes until the conversion lands, and the rerun converges",
    async (_, i) => {
      const s = STORES.s3();
      expect(await publishAs(s, A(), exportOf(A(), "1.0.0"))).toMatchObject({ code: 0 });
      const legacy = stored(s, NO_UPDATE_KEY);
      const before = new Map(s3.objects);
      const pre = await views(s);
      const b = B_CHAINED();
      const dir = exportOf(b, "2.0.0");
      const fault = await WRITES[i]![1](dir);
      s3.dropAfterPut(fault);
      s3.puts.length = 0;
      expect((await publishAs(s, b, dir, ["--add-identity"])).code).toBe(1);

      // The fault hit the intended PUT, which committed, and nothing later in the commit order was attempted.
      const hit = s3.puts.findIndex((k) =>
        fault.endsWith("/") ? k.startsWith(fault) : k === fault,
      );
      expect(hit).toBe(s3.puts.length - 1);
      const key = s3.puts[hit]!;
      if (key === NO_UPDATE_KEY) {
        expect(before.get(key)).toEqual(legacy);
        expect(entry(s, "main")).toEqual(decodeStoredReply(legacy));
        await expectChained(stored(s, key), key, ca.certificate, served(chain), Date.now(), "b");
      } else {
        expect(before.has(key)).toBe(false);
        expect(s3.objects.has(key)).toBe(true);
      }

      const now = await views(s);
      if (i < CONVERTED) expect(now).toEqual(pre);
      else {
        for (const label of ["main 1.0.0 ios", "main 1.0.0 android"])
          expect(now[label]).toEqual(pre[label]);
        expect(now["main none"]).toEqual(entryWire(s, "main"));
        expect(now["b none"]).toEqual(entryWire(s, "b"));
        expect(now["b 2.0.0 ios"]).toEqual(
          s3.objects.has(B_IOS) ? pointerWire(s, B_IOS) : entryWire(s, "b"),
        );
      }

      expect(await publishAs(s, b, dir, ["--add-identity"])).toMatchObject({ code: 0, err: [] });
      expect(entry(s, "main")).toEqual(decodeStoredReply(legacy));
      for (const [k, bytes] of before)
        if (k !== NO_UPDATE_KEY) expect(s3.objects.get(k)).toEqual(bytes);
      const after = await views(s);
      for (const label of ["main 1.0.0 ios", "main 1.0.0 android"])
        expect(after[label]).toEqual(pre[label]);
      expect(after["main none"]).toEqual(entryWire(s, "main"));
      expect(after["b none"]).toEqual(entryWire(s, "b"));
      expect(after["b 2.0.0 ios"]).toEqual(pointerWire(s, B_IOS));
      expect(after["b 2.0.0 android"]).toEqual(pointerWire(s, B_ANDROID));
    },
  );
});

/** The launch hash of the iOS bundle in export `dir`. */
async function launchHash(dir: string): Promise<string> {
  return await sha256Base64Url(
    new Uint8Array(
      readFileSync(join(dir, "dist", "_expo", "static", "js", "ios", "index-ios.hbc")),
    ),
  );
}

describe("recovery of a lost reply/no-update", () => {
  const store = () => STORES.s3();

  test("with pointers of both keyids every writer asks for the restore, and restoring lets both publish", async () => {
    const s = store();
    await twoIdentities(s);
    const saved = stored(s, NO_UPDATE_KEY);
    s3.objects.delete(NO_UPDATE_KEY);
    const before = s3Snapshot();
    expect(await publishAs(s, A(), exportOf(A(), "1.0.0"))).toEqual({
      code: 2,
      out: [],
      err: [`tide: ${RESTORE(B_ANDROID)}`],
    });
    const added = await publishAs(s, B(), exportOf(B(), "2.0.0"), ["--add-identity"]);
    expect(added).toEqual({ code: 2, out: [], err: [`tide: ${RESTORE(ANDROID)}`] });
    expect(s3Snapshot()).toEqual(before);

    s3.objects.set(NO_UPDATE_KEY, saved);
    expect(await publishAs(s, A(), exportOf(A(), "1.0.0"))).toMatchObject({ code: 0, err: [] });
    expect(await publishAs(s, B(), exportOf(B(), "2.0.0"))).toMatchObject({ code: 0, err: [] });
    expect(stored(s, NO_UPDATE_KEY)).toEqual(saved);
    const now = await views(s);
    expect(now["main none"]).toEqual(entryWire(s, "main"));
    expect(now["b none"]).toEqual(entryWire(s, "b"));
  });

  test("with no copy left, dropping B's pointers lets A recreate version 1 and B add itself again", async () => {
    const s = store();
    await twoIdentities(s);
    for (const key of [NO_UPDATE_KEY, B_IOS, B_ANDROID]) s3.objects.delete(key);
    expect(await publishAs(s, A(), exportOf(A(), "1.0.0"))).toMatchObject({ code: 0, err: [] });
    const added = await publishAs(s, B(), exportOf(B(), "2.0.0"), ["--add-identity"]);
    expect(added).toMatchObject({ code: 0, err: [] });
    const now = await views(s);
    expect(now["main none"]).toEqual(entryWire(s, "main"));
    expect(now["main 1.0.0 ios"]).toEqual(pointerWire(s, IOS));
    expect(now["b none"]).toEqual(entryWire(s, "b"));
    expect(now["b 2.0.0 ios"]).toEqual(pointerWire(s, B_IOS));
  });

  // B converted but its first pointer never landed, so the pointers alone look like a bucket that never converted.
  test("restoring the converted record keeps B's entry when B's first pointer never landed", async () => {
    const s = store();
    expect(await publishAs(s, A(), exportOf(A(), "1.0.0"))).toMatchObject({ code: 0 });
    const dir = exportOf(B(), "2.0.0");
    s3.holdPut(B_IOS);
    expect((await publishAs(s, B(), dir, ["--add-identity"])).code).toBe(1);
    expect(s3.objects.has(B_IOS)).toBe(false);
    const saved = stored(s, NO_UPDATE_KEY);
    s3.objects.delete(NO_UPDATE_KEY);

    s3.objects.set(NO_UPDATE_KEY, saved);
    // A writes first, while every pointer is its own: the write that would drop B's entry.
    expect(await publishAs(s, A(), exportOf(A(), "1.0.0"))).toMatchObject({ code: 0, err: [] });
    expect(stored(s, NO_UPDATE_KEY)).toEqual(saved);
    expect(await publishAs(s, B(), dir, ["--add-identity"])).toMatchObject({ code: 0, err: [] });
    expect(stored(s, NO_UPDATE_KEY)).toEqual(saved);
    const now = await views(s);
    expect(now["b 2.0.0 ios"]).toEqual(pointerWire(s, B_IOS));
    expect(now["b none"]).toEqual(entryWire(s, "b"));
    expect(now["main none"]).toEqual(entryWire(s, "main"));
  });

  test("without the restore, A recreates version 1 and B must add itself again, never silently", async () => {
    const s = store();
    expect(await publishAs(s, A(), exportOf(A(), "1.0.0"))).toMatchObject({ code: 0 });
    const dir = exportOf(B(), "2.0.0");
    s3.holdPut(B_IOS);
    expect((await publishAs(s, B(), dir, ["--add-identity"])).code).toBe(1);
    s3.objects.delete(NO_UPDATE_KEY);
    expect(await publishAs(s, A(), exportOf(A(), "1.0.0"))).toMatchObject({ code: 0, err: [] });
    expect(decodeStoredReply(stored(s, NO_UPDATE_KEY)).kind).toBe("noUpdateAvailable");
    expect(await publishAs(s, B(), dir)).toEqual({
      code: 2,
      out: [],
      err: [`tide: ${NOT_ADDED("b")}`],
    });
    expect(await publishAs(s, B(), dir, ["--add-identity"])).toMatchObject({ code: 0, err: [] });
    expect(keyids(s)).toEqual(["b", "main"]);
  });
});

describe("lost races on reply/no-update", () => {
  let kms: Awaited<ReturnType<typeof startFakeKms>>;
  beforeAll(async () => {
    kms = await startFakeKms(KeyObject.from(other.keys.privateKey));
  });
  afterAll(async () => {
    await kms.close();
  });
  /** B signing through KMS, so a test can count its signatures. */
  const kmsB = (): Signing => ({
    ...B(),
    env: (s) => {
      const { TIDE_SIGNING_KEY: _, ...rest } = B().env(s);
      return {
        ...rest,
        TIDE_KMS_KEY_ID: FAKE_KMS.keyId,
        TIDE_KMS_REGION: FAKE_KMS.region,
        TIDE_KMS_ACCESS_KEY_ID: FAKE_KMS.accessKeyId,
        TIDE_KMS_SECRET_ACCESS_KEY: FAKE_KMS.secretAccessKey,
        TIDE_KMS_ENDPOINT: kms.endpoint,
      };
    },
  });
  /** Publishes A, then B through KMS with `winner` stored first at reply/no-update; returns B's result and signatures. */
  async function race(winner?: (legacy: NoUpdateReply) => Promise<Uint8Array>) {
    s3.reset();
    const s = STORES.s3();
    expect(await publishAs(s, A(), exportOf(A(), "1.0.0"))).toMatchObject({ code: 0 });
    const legacy = decodeStoredReply(stored(s, NO_UPDATE_KEY)) as NoUpdateReply;
    const theirs = winner && (await winner(legacy));
    if (theirs !== undefined) s3.raceOnPut(NO_UPDATE_KEY, theirs);
    const signed = kms.requests;
    const dir = exportOf(B(), "2.0.0");
    const result = await publishAs(s, kmsB(), dir, ["--add-identity"]);
    return { s, dir, result, theirs, signatures: kms.requests - signed };
  }

  test("adding against a winner without B's entry keeps the winner, signs nothing more, and the rerun merges", async () => {
    const plain = await race();
    expect(plain.result).toMatchObject({ code: 0 });
    const third = await identity();
    const { s, dir, result, theirs, signatures } = await race(async (legacy) =>
      encodeIdentityNoUpdate(
        new Map([
          ["c", decodeStoredReply(await noUpdateBy(third, "c")) as NoUpdateReply],
          ["main", legacy],
        ]),
      ),
    );
    expect(result).toEqual({ code: 1, out: [], err: [`tide: ${CHANGED}`] });
    expect(signatures).toBe(plain.signatures);
    expect(stored(s, NO_UPDATE_KEY)).toEqual(theirs);
    expect(s3.objects.has(B_IOS)).toBe(false);
    expect(await publishAs(s, kmsB(), dir, ["--add-identity"])).toMatchObject({ code: 0, err: [] });
    const merged = decodeNoUpdate(stored(s, NO_UPDATE_KEY));
    const winner = decodeNoUpdate(theirs!);
    if (merged.kind !== "identities" || winner.kind !== "identities")
      throw new Error("not version 3");
    expect([...merged.entries.keys()]).toEqual(["b", "c", "main"]);
    for (const keyid of ["c", "main"])
      expect(merged.entries.get(keyid)).toEqual(winner.entries.get(keyid));
  });

  test("a winner holding B's own entry is kept and the publish goes on, signing nothing more", async () => {
    const plain = await race();
    const { s, result, theirs, signatures } = await race(async (legacy) =>
      encodeIdentityNoUpdate(
        new Map([
          ["b", decodeStoredReply(await noUpdateBy(other, "b")) as NoUpdateReply],
          ["main", legacy],
        ]),
      ),
    );
    expect(result).toMatchObject({ code: 0, err: [] });
    expect(signatures).toBe(plain.signatures);
    expect(stored(s, NO_UPDATE_KEY)).toEqual(theirs);
  });
});
