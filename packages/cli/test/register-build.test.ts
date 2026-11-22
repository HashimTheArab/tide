import { chmodSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { beforeEach, describe, expect, onTestFinished, test } from "vitest";

import type { BaseAsset } from "@tide-ota/protocol";
import {
  baseKey,
  contentKey,
  encodeBaseRecord,
  encodeIdentityPointer,
  sha256Base64Url,
} from "@tide-ota/protocol";

import { encodeRecord, recordKey } from "../src/publish-record.ts";
import { publish } from "../src/publish.ts";
import { REGISTER_BUILD_USAGE, registerBuild } from "../src/register-build.ts";
import { bucketFromEnv } from "../src/storage.ts";
import { fixture, run, tempRoot, utf8 } from "./helpers.ts";
import {
  ASSET_URL,
  COLLIDING,
  COLLIDING_MD5,
  EXPORT,
  MAIN,
  PNG_MD5,
  SERVER_URL,
  T,
  artifact,
  directBinding,
  diskObjects,
  entryOf,
  env,
  identitiesNoUpdate,
  identity,
  main,
  noUpdateBy,
  other as otherIdentity,
  pins,
  s3,
  s3Env,
  s3Snapshot,
  seededPointer,
  serveMain,
  tree,
  useFixture,
} from "./publish-fixture.ts";

useFixture();

const ID = "1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed";
const OTHER_ID = "6f9619ff-8b86-4d01-b42d-00cf4fc964ff";
const FONT_MD5 = "75d117bbd0d2fe64c29bb45b5abe285e";
const PNG = fixture("asset.png");
const FONT = new Uint8Array(readFileSync(join(EXPORT, "assets", FONT_MD5)));
const BUNDLE = utf8("embedded hermes bytecode");
const RERUN = "outcome unknown; run register-build again before any other writer";

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

/** A `kind` store serving the main identity, as after the first publish; the S3 fake's puts list starts empty. */
async function served(kind: keyof typeof STORES): Promise<Store> {
  const store = STORES[kind]();
  await serveMain(store.env);
  s3.puts.length = 0;
  return store;
}

interface Build {
  readonly id?: unknown;
  readonly keys?: readonly unknown[];
  readonly files?: Readonly<Record<string, Uint8Array>>; // Paths under the assets directory.
  readonly bundle?: Uint8Array;
}

/**
 * Writes a store build's outputs as Android lays them out: the manifest, the bundle and nested resource folders.
 * By default it embeds the PNG at two scales and the font.
 */
function build({
  id = ID,
  keys = [PNG_MD5, PNG_MD5, FONT_MD5],
  files = { "drawable-mdpi/assets_icon.png": PNG, "raw/assets_font.ttf": FONT },
  bundle = BUNDLE,
}: Build = {}) {
  const root = tempRoot();
  const manifest = join(root, "app.manifest");
  const assets = join(root, "res");
  writeFileSync(
    manifest,
    JSON.stringify({
      id,
      commitTime: 1,
      assets: keys.map((k) => ({ packagerHash: k, type: "png" })),
    }),
  );
  writeFileSync(join(root, "index.android.bundle"), bundle);
  mkdirSync(assets);
  for (const [path, bytes] of Object.entries(files)) {
    mkdirSync(dirname(join(assets, path)), { recursive: true });
    writeFileSync(join(assets, path), bytes);
  }
  return { root, manifest, bundle: join(root, "index.android.bundle"), assets };
}

const args = (b: ReturnType<typeof build>, platform = "android") => [
  ...["--platform", platform, "--runtime-version", "1.0.0"],
  ...["--manifest", b.manifest, "--bundle", b.bundle, "--assets-dir", b.assets],
];

/** Runs register-build in process with the main build pins, or `identity`; returns the exit code and output lines. */
async function register(
  argv: readonly string[],
  store: Store,
  identity: Record<string, string | undefined> = pins(),
) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await registerBuild(
    argv,
    { ...identity, ...store.env },
    {
      out: (l) => out.push(l),
      err: (l) => err.push(l),
    },
  );
  return { code, out, err };
}

/** The base record of `build()` with `assets`, as register-build must store it. */
async function expectedBase(
  assets: readonly BaseAsset[],
  bundle: Uint8Array<ArrayBuffer> = BUNDLE,
) {
  return encodeBaseRecord({
    kind: "embedded",
    updateId: ID,
    runtimeVersion: "1.0.0",
    platform: "android",
    launchAsset: { hash: await sha256Base64Url(bundle) },
    assets,
  });
}

const defaultAssets = async () => [
  { key: PNG_MD5, hash: await sha256Base64Url(PNG) },
  { key: FONT_MD5, hash: await sha256Base64Url(FONT) },
];

const bundleKey = async (bytes: Uint8Array<ArrayBuffer> = BUNDLE) =>
  `bundles/${contentKey(await sha256Base64Url(bytes))}`;

describe("register-build to disk", () => {
  test("the bin stores the exact bundle and a base record of the build, finding nested assets by MD5", async () => {
    const store = await served("disk");
    const before = store.objects();
    const b = build();
    writeFileSync(join(b.assets, "raw", "unrelated.txt"), "not an asset");
    const result = await run(MAIN, ["register-build", ...args(b)], { ...pins(), ...store.env });
    const bundle = await bundleKey();
    expect(result).toEqual({ code: 0, stdout: `${baseKey(ID)} ${bundle}\n`, stderr: "" });
    expect(store.objects()).toEqual(
      new Map([
        ...before,
        [baseKey(ID), await expectedBase(await defaultAssets())],
        [bundle, BUNDLE],
      ]),
    );
  });

  test("a manifest without assets needs no --assets-dir", async () => {
    const store = await served("disk");
    const b = build({ keys: [] });
    const result = await register(
      [
        "--platform",
        "android",
        "--runtime-version",
        "1.0.0",
        "--manifest",
        b.manifest,
        "--bundle",
        b.bundle,
      ],
      store,
    );
    expect(result.code).toBe(0);
    expect(store.objects().get(baseKey(ID))).toEqual(await expectedBase([]));
  });

  test("a build whose assets match an export's passes that publish's key check", async () => {
    const store = await served("disk");
    expect((await register(args(build()), store)).code).toBe(0);
    const published = await publish(["--channel", "main", "--from", artifact()], env(store.env), {
      out: () => undefined,
      err: () => undefined,
    });
    expect(published).toBe(0);
  });

  test("the usage lists register-build", async () => {
    const result = await run(MAIN, [], {});
    expect(result.code).toBe(2);
    expect(result.stderr).toContain(`${REGISTER_BUILD_USAGE}\n`);
  });
});

describe.each(Object.keys(STORES) as (keyof typeof STORES)[])("on %s", (kind) => {
  const open = () => served(kind);

  test("either build certificate source registers, with no signing key", async () => {
    const path = join(tempRoot(), "certificate.pem");
    writeFileSync(path, main.certificate);
    for (const identity of [
      pins(),
      { TIDE_BUILD_KEYID: "main", TIDE_BUILD_CERTIFICATE_FILE: path },
    ]) {
      expect(await register(args(build()), await open(), identity)).toEqual({
        code: 0,
        out: [`${baseKey(ID)} ${await bundleKey()}`],
        err: [],
      });
    }
  });

  test.each<[string, () => Promise<Record<string, string | undefined>>, string]>([
    [
      "no TIDE_BUILD_KEYID",
      () => Promise.resolve({ ...pins(), TIDE_BUILD_KEYID: undefined }),
      "TIDE_BUILD_KEYID is not set: set it to the keyid the builds embed",
    ],
    [
      "neither certificate source",
      () => Promise.resolve({ ...pins(), TIDE_BUILD_CERTIFICATE: undefined }),
      "set exactly one of TIDE_BUILD_CERTIFICATE_FILE and TIDE_BUILD_CERTIFICATE",
    ],
    [
      "both certificate sources",
      () => Promise.resolve({ ...pins(), TIDE_BUILD_CERTIFICATE_FILE: join(tempRoot(), "x.pem") }),
      "set exactly one of TIDE_BUILD_CERTIFICATE_FILE and TIDE_BUILD_CERTIFICATE",
    ],
    [
      "an unreadable certificate file",
      () =>
        Promise.resolve({
          TIDE_BUILD_KEYID: "main",
          TIDE_BUILD_CERTIFICATE_FILE: join(tempRoot(), "absent.pem"),
        }),
      "TIDE_BUILD_CERTIFICATE_FILE unreadable: not a regular file of at most 64 KiB",
    ],
    [
      "an invalid certificate",
      () => Promise.resolve({ ...pins(), TIDE_BUILD_CERTIFICATE: main.pkcs8 }),
      "TIDE_BUILD_CERTIFICATE: certificate must be exactly one PEM CERTIFICATE block",
    ],
    [
      "an expired certificate",
      async () => pins(await identity(new Date("2021-01-01T00:00:00Z"))),
      "TIDE_BUILD_CERTIFICATE: certificate has expired",
    ],
  ])("%s is refused before the bucket is read", async (_, identityOf, message) => {
    const store = await open();
    const before = store.snapshot();
    const requests = s3.requests;
    expect(await register(args(build()), store, await identityOf())).toEqual({
      code: 2,
      out: [],
      err: [`tide: ${message}`],
    });
    expect(s3.requests).toBe(requests);
    expect(store.snapshot()).toEqual(before);
  });

  test("a bucket whose replies are signed under another identity is refused", async () => {
    const store = await open();
    await bucketFromEnv(store.env).put("reply/no-update", await noUpdateBy(otherIdentity));
    const before = store.snapshot();
    expect(await register(args(build()), store)).toEqual({
      code: 2,
      out: [],
      err: [
        "tide: this bucket's replies are signed by a different certificate or key ID: a new signing identity needs a new bucket",
      ],
    });
    expect(store.snapshot()).toEqual(before);
  });

  test("a bucket that serves no identity yet is refused, so the first publish cannot pin another", async () => {
    const store = STORES[kind]();
    expect(await register(args(build()), store)).toEqual({
      code: 2,
      out: [],
      err: [
        "tide: reply/no-update is absent: publish before register-build, so the bucket serves the builds' identity",
      ],
    });
    expect([...store.objects().keys()]).toEqual([]);
  });

  test("an identical re-run succeeds and writes nothing", async () => {
    const store = await open();
    const b = build();
    expect((await register(args(b), store)).code).toBe(0);
    const before = store.snapshot();
    s3.puts.length = 0;
    const again = await register(args(b), store);
    expect(again).toEqual({ code: 0, out: [`${baseKey(ID)} ${await bundleKey()}`], err: [] });
    expect(store.snapshot()).toEqual(before);
    expect(s3.puts).toEqual([]);
  });

  test.each<[string, Build]>([
    ["another bundle", { bundle: utf8("another bundle") }],
    ["other assets", { keys: [PNG_MD5] }],
  ])("%s under a registered ID is refused before any write", async (_, other) => {
    const store = await open();
    expect((await register(args(build()), store)).code).toBe(0);
    const before = store.snapshot();
    s3.puts.length = 0;
    expect(await register(args(build(other)), store)).toEqual({
      code: 2,
      out: [],
      err: [`tide: ${baseKey(ID)} holds another build`],
    });
    expect(store.snapshot()).toEqual(before);
    expect(s3.puts).toEqual([]);
  });

  test.each<[string, () => string[], string]>([
    ...(["--platform", "--runtime-version", "--manifest", "--bundle"] as const).map(
      (option): [string, () => string[], string] => [
        `missing ${option}`,
        () => {
          const given = args(build());
          given.splice(given.indexOf(option), 2);
          return given;
        },
        `${option} is required; ${REGISTER_BUILD_USAGE}`,
      ],
    ),
    ...(["--platform", "--runtime-version", "--manifest", "--bundle", "--assets-dir"] as const).map(
      (option): [string, () => string[], string] => [
        `repeated ${option}`,
        () => {
          const given = args(build());
          return [...given, option, given[given.indexOf(option) + 1]!];
        },
        `${option} is given twice`,
      ],
    ),
    [
      "a positional",
      () => [...args(build()), "extra"],
      `unrecognised arguments; ${REGISTER_BUILD_USAGE}`,
    ],
    [
      "an uppercase update ID",
      () => args(build({ id: ID.toUpperCase() })),
      "the manifest's id is not a lowercase UUID",
    ],
    [
      "a malformed update ID",
      () => args(build({ id: "build-1" })),
      "the manifest's id is not a lowercase UUID",
    ],
    [
      "a numeric update ID",
      () => args(build({ id: 7 })),
      "the manifest's id is not a lowercase UUID",
    ],
    [
      "a bad runtime version",
      () => args(build()).map((a) => (a === "1.0.0" ? "1.0/0" : a)),
      "runtimeVersion must be 1 to 64 of A-Z, a-z, 0-9, ., _, +, -, (, ) and :, and not . or ..",
    ],
    ["a bad platform", () => args(build(), "web"), "--platform must be ios or android"],
    [
      "a packagerHash that is not an MD5",
      () => args(build({ keys: [PNG_MD5.toUpperCase()] })),
      "the manifest's assets[0].packagerHash is not 32 lowercase hex",
    ],
    [
      "an asset with no file",
      () => args(build({ files: { "raw/assets_font.ttf": FONT } })),
      `no file in --assets-dir has the MD5 ${PNG_MD5}`,
    ],
    [
      "a re-encoded asset, as AAPT may write",
      () => {
        const reencoded = new Uint8Array([...PNG, 0]);
        return args(
          build({ files: { "drawable-mdpi/assets_icon.png": reencoded, "raw/f.ttf": FONT } }),
        );
      },
      `no file in --assets-dir has the MD5 ${PNG_MD5}`,
    ],
    [
      "an asset reachable only through a symlink",
      () => {
        const b = build({ files: { "raw/assets_font.ttf": FONT } });
        const outside = join(b.root, "icon.png");
        writeFileSync(outside, PNG);
        symlinkSync(outside, join(b.assets, "raw", "icon.png"));
        return args(b);
      },
      `no file in --assets-dir has the MD5 ${PNG_MD5}`,
    ],
    [
      "assets without --assets-dir",
      () => args(build()).slice(0, -2),
      "the manifest lists assets: give --assets-dir",
    ],
    [
      "an unreadable subdirectory of --assets-dir",
      () => {
        const b = build();
        chmodSync(join(b.assets, "raw"), 0);
        onTestFinished(() => {
          chmodSync(join(b.assets, "raw"), 0o755);
        });
        return args(b);
      },
      '--assets-dir "raw" cannot be listed',
    ],
    [
      "two files with one MD5 and different bytes",
      () => args(build({ files: { "a.bin": COLLIDING[0], "b/b.bin": COLLIDING[1] } })),
      `--assets-dir holds two different files with MD5 ${COLLIDING_MD5}`,
    ],
    [
      "a manifest that is not JSON",
      () => {
        const b = build();
        writeFileSync(b.manifest, "{");
        return args(b);
      },
      "--manifest is not UTF-8 JSON",
    ],
    [
      "a missing bundle",
      () => args(build()).map((a) => (a.endsWith(".bundle") ? `${a}.missing` : a)),
      "--bundle is missing or unreadable",
    ],
  ])("%s is refused before any bucket request", async (_, argv, message) => {
    const store = await open();
    const before = store.snapshot();
    const given = argv();
    const requests = s3.requests;
    expect(await register(given, store)).toEqual({ code: 2, out: [], err: [`tide: ${message}`] });
    expect(s3.requests).toBe(requests);
    expect(store.snapshot()).toEqual(before);
  });

  test.each([
    [
      "a release record",
      recordKey(OTHER_ID),
      async (hash: string) =>
        encodeRecord({
          updateId: OTHER_ID,
          channel: "main",
          runtimeVersion: "1.0.0",
          platform: "ios",
          createdAt: "2026-01-01T00:00:00.000Z",
          serverUrl: SERVER_URL,
          assetUrl: ASSET_URL,
          launchAsset: { hash: await sha256Base64Url(utf8("launch")) },
          // Keys compare case-insensitively, as iOS stores asset files.
          assets: [{ key: PNG_MD5.toUpperCase(), hash, fileExtension: ".png" }],
          extra: {},
        }),
    ],
    [
      "another registered build",
      baseKey(OTHER_ID),
      async (hash: string) =>
        encodeBaseRecord({
          kind: "embedded",
          updateId: OTHER_ID,
          runtimeVersion: "2.0.0",
          platform: "ios",
          launchAsset: { hash: await sha256Base64Url(utf8("launch")) },
          assets: [{ key: PNG_MD5, hash }],
        }),
    ],
  ])(
    "an asset key %s records with another SHA-256 is refused before any write",
    async (_, key, seed) => {
      const store = await open();
      await bucketFromEnv(store.env).put(
        key,
        await seed(await sha256Base64Url(utf8("other bytes"))),
      );
      const before = store.snapshot();
      s3.puts.length = 0;
      const result = await register(args(build()), store);
      expect(result).toEqual({
        code: 2,
        out: [],
        err: [
          `tide: asset key ${PNG_MD5} names different bytes in ${key} and this build: a key must never change its bytes`,
        ],
      });
      expect(store.snapshot()).toEqual(before);
      expect(s3.puts).toEqual([]);
    },
  );

  describe("several keyids", () => {
    const IOS = "reply/main/1.0.0/ios";
    const rootPins = () => ({
      TIDE_BUILD_KEYID: "root",
      TIDE_BUILD_CERTIFICATE: otherIdentity.certificate,
    });
    /** main and root in reply/no-update and a pointer, both bound; `change` replaces objects before the snapshot. */
    async function twoIdentities(change: Record<string, Uint8Array<ArrayBuffer>> = {}) {
      const store = STORES[kind]();
      const bucket = bucketFromEnv(store.env);
      const pointer = new Map([
        ["main", entryOf(await seededPointer("manifest", T, main))],
        ["root", entryOf(await seededPointer("rollback", T, otherIdentity, "root"))],
      ]);
      const seed = {
        "reply/no-update": await identitiesNoUpdate({ main, root: otherIdentity }),
        [IOS]: encodeIdentityPointer(pointer),
        ...Object.fromEntries([
          await directBinding(main),
          await directBinding(otherIdentity, "root"),
        ]),
        ...change,
      };
      for (const [key, bytes] of Object.entries(seed)) await bucket.put(key, bytes);
      s3.puts.length = 0;
      return store;
    }
    const replies = (store: Store) =>
      [...store.objects()].filter(([key]) => key.startsWith("reply/"));

    test("main and root each register on a version-3 bucket, and every reply keeps its bytes", async () => {
      const store = await twoIdentities();
      const before = replies(store);
      expect((await register(args(build()), store)).code).toBe(0);
      expect((await register(args(build({ id: OTHER_ID })), store, rootPins())).code).toBe(0);
      expect(replies(store)).toEqual(before);
    });

    test.each<[string, () => Promise<Record<string, Uint8Array<ArrayBuffer>>>, string]>([
      [
        "main's reply/no-update entry under another certificate",
        async () => ({ "reply/no-update": await identitiesNoUpdate({ main: otherIdentity }) }),
        'reply/no-update: keyid "main" already signs replies in this bucket with another certificate or root: a new signing identity needs its own keyid',
      ],
      [
        "a reply/no-update without main's entry",
        async () => ({ "reply/no-update": await identitiesNoUpdate({ root: otherIdentity }) }),
        'reply/no-update holds no reply for keyid "main": tide publish, republish or rollback writes it',
      ],
    ])("%s is refused", async (_, change, message) => {
      const store = await twoIdentities(await change());
      const before = store.snapshot();
      expect(await register(args(build()), store)).toEqual({
        code: 2,
        out: [],
        err: [`tide: ${message}`],
      });
      expect(store.snapshot()).toEqual(before);
    });

    test("root is refused while a legacy pointer serves main's reply to every keyid", async () => {
      const store = await twoIdentities({ [IOS]: await seededPointer("manifest", T, main) });
      const before = store.snapshot();
      expect(await register(args(build()), store, rootPins())).toEqual({
        code: 2,
        out: [],
        err: [
          `tide: ${IOS} still serves another keyid's reply to every keyid: keyid "root" is served only once tide publish has converted every pointer`,
        ],
      });
      expect(store.snapshot()).toEqual(before);
      expect((await register(args(build()), store)).code).toBe(0);
    });
  });

  test("an unreadable base record refuses, since the key check cannot be proven", async () => {
    const store = await open();
    await bucketFromEnv(store.env).put(baseKey(OTHER_ID), utf8("{}"));
    expect(await register(args(build()), store)).toEqual({
      code: 2,
      out: [],
      err: [`tide: ${baseKey(OTHER_ID)} is unreadable: version must be an integer`],
    });
  });
});

describe("register-build on S3", () => {
  const store = () => STORES.s3();
  beforeEach(() => served("s3"));

  test("a bases/ listing that fails is a refusal with no PUT", async () => {
    s3.onList("updates/", () => s3.failAll({ status: 500, code: "InternalError" }));
    expect(await register(args(build()), store())).toEqual({
      code: 2,
      out: [],
      err: ["tide: S3 ListObjectsV2 failed: 500 InternalError"],
    });
    expect(s3.puts).toEqual([]);
  });

  test("both creates are conditional: a racing identical base succeeds, other bytes fail, a raced bundle is kept", async () => {
    const b = build();
    const base = await expectedBase(await defaultAssets());
    const theirs = utf8("another writer's bytes");
    s3.raceOnPut(await bundleKey(), theirs);
    s3.raceOnPut(baseKey(ID), base);
    expect(await register(args(b), store())).toEqual({
      code: 0,
      out: [`${baseKey(ID)} ${await bundleKey()}`],
      err: [],
    });
    expect(s3.objects.get(await bundleKey())).toEqual(theirs);
    expect(s3.puts).toEqual([await bundleKey(), baseKey(ID)]);

    s3.reset();
    await served("s3");
    s3.raceOnPut(baseKey(ID), theirs);
    expect(await register(args(b), store())).toEqual({
      code: 1,
      out: [],
      err: [`tide: ${baseKey(ID)} holds another build`],
    });
    expect(s3.objects.get(baseKey(ID))).toEqual(theirs);
  });

  test("a lost bundle response stops before the base, and the re-run completes it", async () => {
    const bundle = await bundleKey();
    s3.dropAfterPut("bundles/");
    expect(await register(args(build()), store())).toEqual({
      code: 1,
      out: [],
      err: [`tide: ${bundle}: S3 PutObject failed: network error; ${RERUN}`],
    });
    expect(s3.puts).toEqual([bundle]);
    s3.puts.length = 0;
    expect((await register(args(build()), store())).code).toBe(0);
    expect(s3.puts).toEqual([bundle, baseKey(ID)]);
    expect(s3.objects.get(baseKey(ID))).toEqual(await expectedBase(await defaultAssets()));
  });

  test("a lost base response exits 1, and the re-run writes nothing", async () => {
    s3.dropAfterPut("bases/");
    expect(await register(args(build()), store())).toEqual({
      code: 1,
      out: [],
      err: [`tide: ${baseKey(ID)}: S3 PutObject failed: network error; ${RERUN}`],
    });
    s3.puts.length = 0;
    expect((await register(args(build()), store())).code).toBe(0);
    expect(s3.puts).toEqual([]);
  });

  test("a base PUT that commits after its connection drops is closed by the re-run", async () => {
    const b = build();
    s3.holdPut("bases/");
    expect((await register(args(b), store())).code).toBe(1);
    expect(s3.objects.has(baseKey(ID))).toBe(false);
    expect((await register(args(b), store())).code).toBe(0);
    const stored = s3.objects.get(baseKey(ID));
    expect(stored).toEqual(await expectedBase(await defaultAssets()));
    expect(s3.landHeld("bases/")).toBe(false);
    expect(s3.objects.get(baseKey(ID))).toBe(stored);
  });

  test("a late base that lands after a conflicting publish makes the next publish refuse, naming both", async () => {
    // The build embeds one of two files with one MD5; the export ships the other.
    const b = build({ keys: [COLLIDING_MD5], files: { "raw/block.bin": COLLIDING[0] } });
    const dir = artifact({ fields: { platforms: { ios: { runtimeVersion: "1.0.0" } } } });
    const exported = join(dir, "dist");
    writeFileSync(join(exported, "assets", COLLIDING_MD5), COLLIDING[1]);
    const metadata = JSON.parse(readFileSync(join(exported, "metadata.json"), "utf8")) as {
      fileMetadata: { ios: { assets: object[] } };
    };
    metadata.fileMetadata.ios.assets.push({ path: `assets/${COLLIDING_MD5}`, ext: "bin" });
    writeFileSync(join(exported, "metadata.json"), JSON.stringify(metadata));
    const errors: string[] = [];
    const publishIos = () =>
      publish(["--channel", "main", "--from", dir], env(s3Env()), {
        out: () => undefined,
        err: (l) => errors.push(l),
      });

    s3.holdPut("bases/");
    expect((await register(args(b), store())).code).toBe(1);
    expect(await publishIos()).toBe(0);
    const record = [...s3.objects.keys()].find((k) => k.startsWith("updates/"))!;
    expect(s3.landHeld("bases/")).toBe(true);
    errors.length = 0;
    expect(await publishIos()).toBe(2);
    expect(errors).toEqual([
      `tide: asset key ${COLLIDING_MD5} names different bytes in ${record} and ${baseKey(ID)}: a key must never change its bytes`,
    ]);
  });
});
