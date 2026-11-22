import { createHash, KeyObject } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, onTestFinished, test } from "vitest";

import {
  NO_UPDATE_KEY,
  buildNoUpdateAvailable,
  cryptoKeySigner,
  encodeMultipart,
  encodeStoredReply,
  expoSignature,
  identityKey,
} from "@tide-ota/protocol";

import type { Issued } from "./chain-fixture.ts";
import type { FakeKms } from "./fake-kms.ts";
import { startServer, storeFromEnv } from "../../server/src/node.ts";
import { probe } from "../src/probe.ts";
import { republish, rollback } from "../src/publish-rollback.ts";
import { publish } from "../src/publish.ts";
import { registerBuild } from "../src/register-build.ts";
import { rollout } from "../src/rollout.ts";
import { bucketFromEnv } from "../src/storage.ts";
import {
  chainEnv,
  chainExport,
  chainPins,
  dualPurposeRoot,
  expectChained,
  generate,
  intermediate,
  leaf,
  root as issueRoot,
  served,
} from "./chain-fixture.ts";
import { FAKE_KMS, startFakeKms } from "./fake-kms.ts";
import { tempRoot, utf8 } from "./helpers.ts";
import {
  ANDROID,
  IOS,
  T,
  artifact,
  diskObjects,
  env,
  main,
  s3,
  s3Env,
  s3Snapshot,
  useFixture,
} from "./publish-fixture.ts";

useFixture();

const OTHER_IDENTITY =
  "this bucket's replies are signed by a different certificate or key ID: a new signing identity needs a new bucket";
const HOUR = 3_600_000;
const SOON = new Date(T + HOUR); // A notAfter the S3 tests' clock passes.
const LATER = T + 2 * HOUR;
const IOS_ONLY = { platforms: { ios: { runtimeVersion: "1.0.0" } } };
const ANDROID_ONLY = { platforms: { android: { runtimeVersion: "1.0.0" } } };
const TARGET = ["--channel", "main", "--runtime-version", "1.0.0"];
const BOUND_ELSEWHERE = async () =>
  `${await identityKey("main")} binds another root or is not one tide writes: a new signing identity needs a new bucket`;

/** The chain-mode identities one file uses; every root but `root2` and `dual` shares the root key. */
interface World {
  readonly root: Issued;
  readonly inter: Issued; // Intermediate under root.
  readonly leafA: Issued; // Under inter.
  readonly leafB: Issued; // Directly under root.
  readonly leafSoon: Issued; // Under root, expires at SOON.
  readonly leafOld: Issued; // Under root, expired in 2025.
  readonly interSoon: Issued; // Intermediate under root, expires at SOON.
  readonly interOld: Issued; // Intermediate under root, expired in 2025.
  readonly leafUnderSoon: Issued; // Under interSoon, valid to 2049.
  readonly leafUnderOld: Issued; // Under an intermediate that expired in 2025.
  readonly root2: Issued; // Another key, the same subject.
  readonly leaf2: Issued; // Under root2.
  readonly twin: Issued; // The root's subject and key in another certificate.
  readonly dual: Issued; // A dual-purpose root.
  readonly leafDual: Issued; // Under dual.
}

let w: World;
let kms: FakeKms;

beforeAll(async () => {
  const rootKeys = await generate();
  const root = await issueRoot(rootKeys);
  const inter = await intermediate(root, "Tide root");
  const interSoon = await intermediate(root, "Tide root", { notAfter: SOON });
  const interOld = await intermediate(root, "Tide root", {
    notAfter: new Date("2025-01-01T00:00:00Z"),
  });
  const root2 = await issueRoot(await generate());
  const dual = await dualPurposeRoot();
  const leafA = await leaf(inter, "Tide intermediate", "Tide leaf A");
  w = {
    root,
    inter,
    leafA,
    leafB: await leaf(root, "Tide root", "Tide leaf B"),
    leafSoon: await leaf(root, "Tide root", "Tide leaf soon", { notAfter: SOON }),
    leafOld: await leaf(root, "Tide root", "Tide leaf old", {
      notAfter: new Date("2025-01-01T00:00:00Z"),
    }),
    interSoon,
    interOld,
    leafUnderSoon: await leaf(interSoon, "Tide intermediate", "Tide leaf under soon"),
    leafUnderOld: await leaf(interOld, "Tide intermediate", "Tide leaf under old"),
    root2,
    leaf2: await leaf(root2, "Tide root", "Tide leaf 2"),
    twin: await issueRoot(rootKeys, "Tide root", { notAfter: new Date("2048-12-31T23:59:59Z") }),
    dual,
    leafDual: await leaf(dual, "Tide dual", "Tide leaf dual"),
  };
  kms = await startFakeKms(KeyObject.from(leafA.keys.privateKey));
});
afterAll(async () => {
  await kms.close();
});

const STORES = {
  disk: () => {
    const root = tempRoot();
    return { env: { TIDE_DISK_DIR: root }, objects: () => diskObjects(root) };
  },
  s3: () => ({ env: s3Env(), objects: (): ReadonlyMap<string, Uint8Array> => s3.objects }),
};
type Store = ReturnType<(typeof STORES)[keyof typeof STORES]>;
const s3Store = (): Store => STORES.s3();

const COMMANDS = { publish, rollback, republish, rollout, registerBuild };

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

/** A chain-mode writer configuration: the root's pins, the served chain, and the first member's key. */
interface Config {
  readonly root: Issued;
  readonly chain: readonly Issued[]; // Leaf first.
}
const A = (): Config => ({ root: w.root, chain: [w.leafA, w.inter] });
const B = (): Config => ({ root: w.root, chain: [w.leafB] });
const SOON_LEAF = (): Config => ({ root: w.root, chain: [w.leafSoon] });

const configEnv = (store: Store, config: Config) =>
  chainEnv(store.env, config.root.certificate, served(...config.chain), config.chain[0]!);

/** Publishes a chain-mode export of `config`'s root to channel main. */
const publishWith = (
  store: Store,
  config: Config,
  options: { now?: () => number; fields?: Record<string, unknown>; extra?: string[] } = {},
) =>
  cmd(
    "publish",
    [
      ...["--channel", "main"],
      ...[
        "--from",
        artifact({ fields: { ...chainExport(config.root.certificate), ...options.fields } }),
      ],
      ...(options.extra ?? []),
    ],
    configEnv(store, config),
    options.now,
  );

/** Runs `tide rollout <goal>` with `root`'s pins and no signing key. */
const rolloutTo = (
  store: Store,
  root: Issued,
  goal: string,
  now?: () => number,
  extra: string[] = [],
) =>
  cmd(
    "rollout",
    [goal, ...TARGET, ...extra],
    { ...chainPins(root.certificate), ...store.env },
    now,
  );

/** Expects `key` to hold a record whose every reply serves `config`'s chain and verifies at `at`. */
const expectServes = (store: Store, key: string, config: Config, at = Date.now()) =>
  expectChained(
    store.objects().get(key),
    key,
    config.root.certificate,
    served(...config.chain),
    at,
  );

/** The binding bytes the CLI writes for `root` under key ID main. */
function bindingBytes(rootPem: string): string {
  const der = Buffer.from(rootPem.replace(/-----[A-Z ]+-----|\s/g, ""), "base64");
  const sha = createHash("sha256").update(der).digest("hex");
  return JSON.stringify({ version: 1, keyid: "main", root: sha });
}

/** A stored `reply/no-update` signed by `config`'s leaf and serving its chain. */
async function chainedNoUpdate(config: Config): Promise<Uint8Array<ArrayBuffer>> {
  const body = buildNoUpdateAvailable();
  const signature = await expoSignature(
    body,
    cryptoKeySigner(config.chain[0]!.keys.privateKey, "main"),
  );
  return encodeStoredReply({
    kind: "noUpdateAvailable",
    ...encodeMultipart([
      { name: "directive", body, signature },
      { name: "certificate_chain", body: utf8(served(...config.chain)) },
    ]),
  });
}

/** A store build with no assets, for register-build. */
function storeBuild(id: string): string[] {
  const dir = tempRoot();
  writeFileSync(join(dir, "app.manifest"), JSON.stringify({ id, commitTime: 1, assets: [] }));
  writeFileSync(join(dir, "index.android.bundle"), "embedded bytes");
  return [
    ...["--platform", "android", "--runtime-version", "1.0.0"],
    ...["--manifest", join(dir, "app.manifest"), "--bundle", join(dir, "index.android.bundle")],
  ];
}

const registerWith = (store: Store, root: Issued, id: string, now?: () => number) =>
  cmd("registerBuild", storeBuild(id), { ...chainPins(root.certificate), ...store.env }, now);

const at = (t: number) => {
  s3.setNow(t);
  return () => t;
};

describe.each(["disk", "s3"] as const)("chain mode on %s", (kind) => {
  test.each([
    ["root and leaf", B],
    ["root, intermediate and leaf", A],
  ])(
    "publish, rollback --embedded and republish store chained bodies (%s) that verify like the client",
    async (_, config) => {
      const store = STORES[kind]();
      const first = await publishWith(store, config());
      expect(first).toMatchObject({ code: 0, err: [] });
      for (const key of [IOS, ANDROID, NO_UPDATE_KEY]) await expectServes(store, key, config());
      const binding = store.objects().get(await identityKey("main"));
      expect(new TextDecoder().decode(binding)).toBe(bindingBytes(w.root.certificate));

      const pinsEnv = configEnv(store, config());
      const back = await cmd("rollback", ["--embedded", ...TARGET], pinsEnv);
      expect(back).toMatchObject({ code: 0, err: [] });
      for (const key of [IOS, ANDROID]) await expectServes(store, key, config());

      const updateId = first.out[0]!.split(" ")[1]!;
      expect(await cmd("republish", [updateId], pinsEnv)).toMatchObject({ code: 0, err: [] });
      await expectServes(store, IOS, config());
    },
  );
});

test("a KMS leaf key signs chained replies like a file key", async () => {
  const store = s3Store();
  const { TIDE_SIGNING_KEY: _, ...rest } = configEnv(store, A());
  const kmsEnv = {
    ...rest,
    TIDE_KMS_KEY_ID: FAKE_KMS.keyId,
    TIDE_KMS_REGION: FAKE_KMS.region,
    TIDE_KMS_ACCESS_KEY_ID: FAKE_KMS.accessKeyId,
    TIDE_KMS_SECRET_ACCESS_KEY: FAKE_KMS.secretAccessKey,
    TIDE_KMS_ENDPOINT: kms.endpoint,
  };
  const dir = artifact({ fields: chainExport(w.root.certificate) });
  expect(await cmd("publish", ["--channel", "main", "--from", dir], kmsEnv)).toMatchObject({
    code: 0,
  });
  for (const key of [IOS, ANDROID, NO_UPDATE_KEY]) await expectServes(store, key, A());
});

describe("refused before the bucket opens", () => {
  const chainVars = (config: Config) => configEnv(s3Store(), config);
  test.each<
    [string, () => { env: Record<string, string>; fields?: Record<string, unknown> }, string]
  >([
    [
      "a leaf that is not the key source's",
      // Leaf B's chain, signed through leaf A's key.
      () => ({ env: chainEnv(s3Env(), w.root.certificate, served(w.leafB), w.leafA) }),
      "the signing key does not match the served chain's leaf certificate",
    ],
    [
      "an expired intermediate",
      () => ({
        env: { ...chainVars({ root: w.root, chain: [w.leafUnderOld, w.interOld] }) },
      }),
      "TIDE_CERTIFICATE_CHAIN: certificate_chain intermediate 1 has expired",
    ],
    [
      "a chain to another root",
      () => ({ env: chainVars({ root: w.root, chain: [w.leaf2] }) }),
      "TIDE_CERTIFICATE_CHAIN: certificate_chain leaf has a signature that does not verify under its issuer's key",
    ],
    [
      "chain mode without a served chain",
      () => {
        const { TIDE_CERTIFICATE_CHAIN: _, ...rest } = chainVars(B());
        return { env: rest };
      },
      "chain mode: set exactly one of TIDE_CERTIFICATE_CHAIN_FILE and TIDE_CERTIFICATE_CHAIN",
    ],
    [
      "a served chain in direct mode",
      () => ({
        env: { ...env(s3Env()), TIDE_CERTIFICATE_CHAIN: served(w.leafB) },
        fields: { certificate: main.certificate },
      }),
      "TIDE_CERTIFICATE_CHAIN_FILE and TIDE_CERTIFICATE_CHAIN need TIDE_BUILD_INCLUDE_CERTIFICATE_CHAIN=true: the builds ignore a chain",
    ],
    [
      "a direct export under chain pins",
      () => ({ env: chainVars(B()), fields: { certificate: w.root.certificate } }),
      "tide-export.json codeSigningIncludeManifestResponseCertificateChain differs from TIDE_BUILD_INCLUDE_CERTIFICATE_CHAIN",
    ],
    [
      "a chain export under direct pins",
      () => ({ env: env(s3Env()), fields: chainExport(main.certificate) }),
      "tide-export.json codeSigningIncludeManifestResponseCertificateChain differs from TIDE_BUILD_INCLUDE_CERTIFICATE_CHAIN",
    ],
    [
      "an export of another root",
      () => ({ env: chainVars(B()), fields: chainExport(w.root2.certificate) }),
      "tide-export.json certificate differs from TIDE_BUILD_CERTIFICATE",
    ],
    [
      "a pinned root that is not a CA",
      () => ({
        env: { ...chainVars(B()), TIDE_BUILD_CERTIFICATE: main.certificate },
        fields: chainExport(main.certificate),
      }),
      "TIDE_BUILD_CERTIFICATE: root must be a CA with Key Usage keyCertSign",
    ],
    [
      "an export whose chain member is not true",
      () => ({
        env: chainVars(B()),
        fields: {
          ...chainExport(w.root.certificate),
          codeSigningIncludeManifestResponseCertificateChain: false,
        },
      }),
      "tide-export.json codeSigningIncludeManifestResponseCertificateChain must be true when present",
    ],
    [
      "a mode pin that is neither true nor false",
      () => ({ env: { ...chainVars(B()), TIDE_BUILD_INCLUDE_CERTIFICATE_CHAIN: "yes" } }),
      "TIDE_BUILD_INCLUDE_CERTIFICATE_CHAIN must be true or false",
    ],
  ])("%s", async (_, setup, message) => {
    const { env: environment, fields = chainExport(w.root.certificate) } = setup();
    const dir = artifact({ fields });
    const requests = s3.requests;
    const result = await cmd("publish", ["--channel", "main", "--from", dir], environment);
    expect(result).toEqual({ code: 2, out: [], err: [`tide: ${message}`] });
    expect(s3.requests).toBe(requests);
  });
});

describe("leaf rotation under the same root", () => {
  test("publish, rollout and register-build accept bodies the old leaf signed, and reply/no-update is renewed once", async () => {
    const store = s3Store();
    expect(await publishWith(store, A())).toMatchObject({ code: 0 });
    const android = store.objects().get(ANDROID);
    s3.puts.length = 0;
    const staged = await publishWith(store, B(), { fields: IOS_ONLY, extra: ["--rollout", "10"] });
    expect(staged).toMatchObject({ code: 0, err: [] });
    expect(s3.puts.filter((k) => k === NO_UPDATE_KEY)).toHaveLength(1);
    await expectServes(store, NO_UPDATE_KEY, B());
    expect(store.objects().get(ANDROID)).toEqual(android);
    // The rollout keeps leaf A's reply as its earlier side.
    const chains = [served(w.leafB), served(w.leafA, w.inter)];
    await expectChained(store.objects().get(IOS), IOS, w.root.certificate, chains, Date.now());

    expect(await rolloutTo(store, w.root, "50", undefined, ["--platform", "ios"])).toMatchObject({
      code: 0,
      err: [],
    });
    expect(await registerWith(store, w.root, "1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed")).toMatchObject(
      {
        code: 0,
        err: [],
      },
    );
    s3.puts.length = 0;
    expect(await publishWith(store, B(), { fields: ANDROID_ONLY })).toMatchObject({ code: 0 });
    expect(s3.puts).not.toContain(NO_UPDATE_KEY);
  });

  test("with the clock past the old leaf's notAfter, register-build and publish still accept the bucket", async () => {
    const store = s3Store();
    expect(await publishWith(store, SOON_LEAF(), { now: at(T) })).toMatchObject({ code: 0 });
    const android = store.objects().get(ANDROID);
    const now = at(LATER);
    expect(
      await registerWith(store, w.root, "1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed", now),
    ).toMatchObject({ code: 0, err: [] });
    expect(await publishWith(store, B(), { now, fields: IOS_ONLY })).toMatchObject({
      code: 0,
      err: [],
    });
    await expectServes(store, IOS, B(), LATER);
    await expectServes(store, NO_UPDATE_KEY, B(), LATER);
    expect(store.objects().get(ANDROID)).toEqual(android);
  });

  test("rollouts keep and move bodies whose own leaf has expired: only the served chain is checked", async () => {
    const store = s3Store();
    expect(await publishWith(store, SOON_LEAF(), { now: at(T) })).toMatchObject({ code: 0 });
    const now = at(LATER);
    const staged = await publishWith(store, B(), { now, extra: ["--rollout", "10"] });
    expect(staged).toMatchObject({ code: 0, err: [] });
    const chains = [served(w.leafB), served(w.leafSoon)];
    await expectChained(store.objects().get(IOS), IOS, w.root.certificate, chains, T);
    expect(await rolloutTo(store, w.root, "20", now)).toMatchObject({ code: 0, err: [] });
    expect(await rolloutTo(store, w.root, "revert", now)).toMatchObject({ code: 0, err: [] });
  });

  test("a rollout whose new reply's leaf has expired refuses to rise or complete, and still reverts", async () => {
    const store = s3Store();
    expect(await publishWith(store, B(), { now: at(T) })).toMatchObject({ code: 0 });
    const staged = await publishWith(store, SOON_LEAF(), {
      now: at(T),
      extra: ["--rollout", "10"],
    });
    expect(staged).toMatchObject({ code: 0, err: [] });
    const now = at(LATER);
    const before = s3Snapshot();
    for (const goal of ["20", "complete"]) {
      expect(await rolloutTo(store, w.root, goal, now)).toEqual({
        code: 2,
        out: [],
        err: [`tide: ${IOS}'s new reply: certificate_chain leaf has expired`],
      });
    }
    expect(s3Snapshot()).toEqual(before);
    expect(await rolloutTo(store, w.root, "revert", now)).toMatchObject({ code: 0, err: [] });
  });

  test("a missing reply/no-update is recreated over pointers an expired leaf signed, which keep their bytes", async () => {
    const store = s3Store();
    expect(await publishWith(store, SOON_LEAF(), { now: at(T) })).toMatchObject({ code: 0 });
    s3.objects.delete(NO_UPDATE_KEY);
    const android = store.objects().get(ANDROID);
    const result = await publishWith(store, B(), { now: at(LATER), fields: IOS_ONLY });
    expect(result).toMatchObject({ code: 0, err: [] });
    await expectServes(store, NO_UPDATE_KEY, B(), LATER);
    expect(store.objects().get(ANDROID)).toEqual(android);
  });

  test("revert and a rerun at the reached percentage need no bucket clock", async () => {
    const store = s3Store();
    expect(await publishWith(store, B(), { now: at(T) })).toMatchObject({ code: 0 });
    const staged = await publishWith(store, B(), { now: at(T), extra: ["--rollout", "10"] });
    expect(staged).toMatchObject({ code: 0, err: [] });
    s3.setNow(Number.NaN); // Every Date header is now unreadable.
    for (const goal of ["10", "revert"]) {
      expect(await rolloutTo(store, w.root, goal, () => T)).toMatchObject({ code: 0, err: [] });
    }
  });

  test.each(["local", "bucket"])(
    "a new chain that expires by the %s clock after the first pointer rises stops the second",
    async (clock) => {
      const store = s3Store();
      expect(await publishWith(store, B(), { now: at(T) })).toMatchObject({ code: 0 });
      const staged = await publishWith(store, SOON_LEAF(), {
        now: at(T),
        extra: ["--rollout", "10"],
      });
      expect(staged).toMatchObject({ code: 0, err: [] });
      const android = store.objects().get(ANDROID);
      const from = s3.puts.length;
      const risen = () => s3.puts.slice(from).includes(IOS);
      if (clock === "bucket") s3.onPut(IOS, () => s3.setNow(LATER));
      const now = () => (clock === "local" && risen() ? LATER : T);
      const result = await rolloutTo(store, w.root, "20", now);
      expect(result).toMatchObject({
        code: 1,
        err: [`tide: ${ANDROID}'s new reply: certificate_chain leaf has expired`],
      });
      expect(result.out).toEqual([expect.stringMatching(/^reply\/main\/1\.0\.0\/ios .* 20$/)]);
      expect(risen()).toBe(true);
      expect(store.objects().get(ANDROID)).toEqual(android);
    },
  );
});

describe("another identity's bucket", () => {
  const ID = "1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed";

  /** Every writer, configured for `config`, over `store`; each must refuse with `message` and write nothing. */
  async function everyWriterRefuses(store: Store, config: Config, message: string) {
    const writerEnv = configEnv(store, config);
    const pinsOnly = { ...chainPins(config.root.certificate), ...store.env };
    const results = [
      await publishWith(store, config),
      await cmd("rollback", ["--embedded", ...TARGET], writerEnv),
      await cmd("republish", ["0f6a9a3e-6c1b-4c4e-9d55-2b8f3f7c1a90"], writerEnv),
      await cmd("rollout", ["complete", ...TARGET], pinsOnly),
      await cmd("registerBuild", storeBuild(ID), pinsOnly),
    ];
    for (const result of results)
      expect(result).toEqual({ code: 2, out: [], err: [`tide: ${message}`] });
  }

  test("a bucket whose bodies chain to another root is refused by every writer", async () => {
    const store = s3Store();
    expect(await publishWith(store, { root: w.root2, chain: [w.leaf2] })).toMatchObject({
      code: 0,
    });
    const before = s3Snapshot();
    await everyWriterRefuses(store, B(), await BOUND_ELSEWHERE());
    expect(s3Snapshot()).toEqual(before);
    // Without the binding, the bodies themselves refuse.
    s3.objects.delete(await identityKey("main"));
    await everyWriterRefuses(store, B(), OTHER_IDENTITY);
  });

  test("a renewed root of the same subject and key is another identity: the binding names the exact root", async () => {
    const store = s3Store();
    expect(await publishWith(store, B())).toMatchObject({ code: 0 });
    const before = s3Snapshot();
    await everyWriterRefuses(store, { root: w.twin, chain: [w.leafB] }, await BOUND_ELSEWHERE());
    expect(s3Snapshot()).toEqual(before);
  });

  test("chained replies without their binding are refused, so the root's twin cannot bind the bucket", async () => {
    const store = s3Store();
    expect(await publishWith(store, B())).toMatchObject({ code: 0 });
    s3.objects.delete(await identityKey("main"));
    const before = s3Snapshot();
    const message = `${await identityKey("main")} is absent but the bucket holds chained replies: restore it; it binds the root they were published under`;
    await everyWriterRefuses(store, { root: w.twin, chain: [w.leafB] }, message);
    expect(s3Snapshot()).toEqual(before);
  });

  test("a direct-signed bucket under chain pins, and a chained bucket under direct pins, are refused", async () => {
    const direct = s3Store();
    expect(
      await cmd("publish", ["--channel", "main", "--from", artifact()], env(direct.env)),
    ).toMatchObject({ code: 0 });
    expect(await publishWith(direct, B())).toEqual({
      code: 2,
      out: [],
      err: [`tide: ${OTHER_IDENTITY}`],
    });
    s3.reset();
    const chained = s3Store();
    expect(await publishWith(chained, B())).toMatchObject({ code: 0 });
    expect(
      await cmd("publish", ["--channel", "main", "--from", artifact()], env(chained.env)),
    ).toEqual({ code: 2, out: [], err: [`tide: ${OTHER_IDENTITY}`] });
  });

  test("a dual-purpose root's direct-signed bodies are not its chained identity", async () => {
    const store = s3Store();
    const direct = {
      ...env(store.env, w.dual),
      TIDE_BUILD_CERTIFICATE: w.dual.certificate,
    };
    const dir = artifact({ fields: { certificate: w.dual.certificate } });
    expect(await cmd("publish", ["--channel", "main", "--from", dir], direct)).toMatchObject({
      code: 0,
      err: [],
    });
    const config = { root: w.dual, chain: [w.leafDual] };
    expect(await publishWith(store, config)).toEqual({
      code: 2,
      out: [],
      err: [`tide: ${OTHER_IDENTITY}`],
    });
  });
});

describe("validity checks before each write", () => {
  test("an intermediate that expires between the plan and the first pointer write refuses it", async () => {
    const store = s3Store();
    s3.setNow(T);
    const now = () => (s3.puts.some((k) => k.startsWith("updates/")) ? LATER : T);
    const config = { root: w.root, chain: [w.leafUnderSoon, w.interSoon] };
    const result = await publishWith(store, config, { now });
    expect(result).toEqual({
      code: 1,
      out: [],
      err: ["tide: TIDE_CERTIFICATE_CHAIN: certificate_chain intermediate 1 has expired"],
    });
    expect(s3.puts).not.toContain(IOS);
    expect(s3.puts).not.toContain(ANDROID);
  });

  test("a chain that expires during uploads stops before reply/no-update, which keeps its bytes", async () => {
    const store = s3Store();
    expect(await publishWith(store, B(), { now: at(T), fields: IOS_ONLY })).toMatchObject({
      code: 0,
    });
    const noUpdate = store.objects().get(NO_UPDATE_KEY);
    s3.puts.length = 0;
    // The Android bundle is the only upload; the clock passes the intermediate's notAfter once it lands.
    const now = () => (s3.puts.some((k) => k.startsWith("bundles/")) ? LATER : T);
    const config = { root: w.root, chain: [w.leafUnderSoon, w.interSoon] };
    const result = await publishWith(store, config, { now });
    expect(result).toEqual({
      code: 1,
      out: [],
      err: ["tide: TIDE_CERTIFICATE_CHAIN: certificate_chain intermediate 1 has expired"],
    });
    expect(s3.puts.some((k) => k.startsWith("bundles/"))).toBe(true);
    expect(store.objects().get(NO_UPDATE_KEY)).toEqual(noUpdate);
    expect(s3.puts).not.toContain(NO_UPDATE_KEY);
    expect(s3.puts).not.toContain(ANDROID);
  });

  test("a renewal whose response is lost fails, and the rerun writes no reply/no-update", async () => {
    const store = s3Store();
    expect(await publishWith(store, A())).toMatchObject({ code: 0 });
    s3.dropAfterPut(NO_UPDATE_KEY);
    expect((await publishWith(store, B())).code).toBe(1);
    await expectServes(store, NO_UPDATE_KEY, B());
    s3.puts.length = 0;
    expect(await publishWith(store, B())).toMatchObject({ code: 0, err: [] });
    expect(s3.puts).not.toContain(NO_UPDATE_KEY);
  });

  test("a renewal another writer won is kept when it is this identity's, and refused under another root", async () => {
    const store = s3Store();
    expect(await publishWith(store, A())).toMatchObject({ code: 0 });
    const theirs = await chainedNoUpdate(B());
    s3.raceOnPut(NO_UPDATE_KEY, theirs);
    expect(await publishWith(store, SOON_LEAF())).toMatchObject({ code: 0, err: [] });
    expect(store.objects().get(NO_UPDATE_KEY)).toEqual(theirs);

    const foreign = await chainedNoUpdate({ root: w.root2, chain: [w.leaf2] });
    s3.raceOnPut(NO_UPDATE_KEY, foreign);
    const result = await publishWith(store, A());
    expect(result).toEqual({ code: 1, out: [], err: [`tide: ${OTHER_IDENTITY}`] });
    expect(s3.objects.get(NO_UPDATE_KEY)).toEqual(foreign);
  });
});

describe("tide probe in chain mode", () => {
  const quiet = { out: () => undefined, err: () => undefined };

  /** Serves a disk bucket holding a chain-mode publish of `config`; returns the probe's server URL. */
  async function serving(config: Config): Promise<string> {
    const root = tempRoot();
    const server = await startServer({ port: 0, store: storeFromEnv({ TIDE_DISK_DIR: root }) });
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    onTestFinished(() => new Promise<void>((resolve) => server.close(() => resolve())));
    const store = { env: { TIDE_DISK_DIR: root }, objects: () => diskObjects(root) };
    const write = { ...configEnv(store, config), TIDE_SERVER_URL: base };
    const dir = artifact({ fields: chainExport(config.root.certificate) });
    expect(await publish(["--channel", "main", "--from", dir], write, quiet)).toBe(0);
    return base;
  }

  async function probing(base: string, probeEnv: Record<string, string>, channel = "main") {
    const out: string[] = [];
    const err: string[] = [];
    const args = [
      "--server-url",
      base,
      "--channel",
      channel,
      "--runtime-version",
      "1.0.0",
      "--platform",
      "ios",
    ];
    const code = await probe(args, probeEnv, { out: (l) => out.push(l), err: (l) => err.push(l) });
    return { code, out, err };
  }

  test("a chained reply passes; another root, a reply without a chain and an expired served leaf exit 6", async () => {
    const base = await serving(A());
    expect(await probing(base, chainPins(w.root.certificate))).toMatchObject({ code: 0, err: [] });
    expect(await probing(base, chainPins(w.root2.certificate))).toEqual({
      code: 6,
      out: [],
      err: [
        "tide: the reply's certificate chain fails the client's rules: certificate_chain intermediate 1 has a signature that does not verify under its issuer's key",
      ],
    });

    // The dual-purpose root's direct-signed reply has no chain for a chain-mode build.
    const root = tempRoot();
    const server = await startServer({ port: 0, store: storeFromEnv({ TIDE_DISK_DIR: root }) });
    onTestFinished(() => new Promise<void>((resolve) => server.close(() => resolve())));
    const directBase = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const direct = {
      ...env({ TIDE_DISK_DIR: root }, w.dual),
      TIDE_BUILD_CERTIFICATE: w.dual.certificate,
      TIDE_SERVER_URL: directBase,
    };
    const dir = artifact({ fields: { certificate: w.dual.certificate } });
    expect(await publish(["--channel", "main", "--from", dir], direct, quiet)).toBe(0);
    expect(await probing(directBase, chainPins(w.dual.certificate))).toEqual({
      code: 6,
      out: [],
      err: ["tide: the reply has no certificate_chain part"],
    });

    // A reply/no-update serving a leaf that has since expired.
    await bucketFromEnv({ TIDE_DISK_DIR: root }).put(
      NO_UPDATE_KEY,
      await chainedNoUpdate({ root: w.root, chain: [w.leafOld] }),
    );
    expect(await probing(directBase, chainPins(w.root.certificate), "none")).toEqual({
      code: 6,
      out: [],
      err: [
        "tide: the reply's certificate chain fails the client's rules: certificate_chain leaf has expired",
      ],
    });
  });
});
