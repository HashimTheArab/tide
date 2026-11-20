import { execFileSync } from "node:child_process";
import { cpSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

import {
  NO_UPDATE_KEY,
  baseKey,
  certificatePublicKey,
  decodeBaseRecord,
  encodeBaseRecord,
  decodeStoredReply,
  parseMultipart,
  s3Fetch,
  s3Target,
  sha256Base64Url,
  verifyExpoSignature,
} from "@tide/protocol";
import { FAKE_S3 } from "@tide/server/test/fake-s3";

import type { Objects } from "./publish-fixture.ts";
import { runEntry } from "../../server/test/node/entry.ts";
import { diskBucket } from "../src/disk.ts";
import {
  assetUrl,
  decodeRecord,
  encodeRecord,
  launchUrl,
  recordKey,
} from "../src/publish-record.ts";
import { publish, recordedKeys } from "../src/publish.ts";
import { run, tempRoot, utf8 } from "./helpers.ts";
import {
  ANDROID,
  ASSET_URL,
  COLLIDING,
  COLLIDING_MD5,
  EXPORT,
  IOS,
  MAIN,
  MISMATCH,
  PNG_MD5,
  SERVER_URL,
  T,
  diskObjects,
  env,
  identity,
  installFakeExpo,
  main,
  noUpdateBy,
  other,
  project,
  s3,
  s3Env,
  s3Snapshot,
  seededPointer,
  signedManifest,
  tree,
  useFixture,
} from "./publish-fixture.ts";

useFixture();

/** Publishes in process to channel `main`; returns the exit code and output lines. */
async function publishIn(
  root: string,
  environment: Record<string, string>,
  args: string[] = [],
  now?: () => number,
) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await publish(["--channel", "main", "--project-root", root, ...args], environment, {
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    ...(now && { now }),
  });
  return { code, out, err };
}

/**
 * Checks a published pointer: the record matches the signed manifest and rebuilds its URLs, and every URL's path is
 * a stored key whose bytes hash to the manifest hash.
 */
async function expectPublished(objects: Objects, key: string) {
  const { reply, manifest } = await signedManifest(objects, key);
  expect(manifest.id).toBe(reply.updateId);
  expect(manifest.runtimeVersion).toBe(key.split("/")[2]);
  expect(reply.manifestFilters).toBe('channel="main"');
  expect(manifest.metadata).toEqual({ channel: "main" });
  const record = decodeRecord(objects.get(`updates/${manifest.id}.json`)!);
  expect(record.updateId).toBe(manifest.id);
  expect(decodeBaseRecord(objects.get(baseKey(manifest.id))!)).toEqual({
    kind: "update",
    updateId: manifest.id,
    runtimeVersion: manifest.runtimeVersion,
    platform: key.split("/")[3],
    launchAsset: { hash: manifest.launchAsset.hash },
  });
  expect(record.createdAt).toBe(manifest.createdAt);
  expect(record.extra).toEqual(manifest.extra);
  expect(launchUrl(record.serverUrl, record.launchAsset.hash)).toBe(manifest.launchAsset.url);
  expect(manifest.launchAsset.url).toMatch(
    /^https:\/\/updates\.example\.com\/bundles\/[0-9a-f]{64}$/,
  );
  expect(record.assets.map((a) => [a.key, a.hash, a.fileExtension])).toEqual(
    manifest.assets.map((a) => [a.key, a.hash, a.fileExtension]),
  );
  for (const [i, a] of manifest.assets.entries()) {
    expect(assetUrl(record.assetUrl, record.assets[i]!.hash)).toBe(a.url);
    expect(a.url).toMatch(/^https:\/\/assets\.example\.com\/assets\/[0-9a-f]{64}$/);
  }
  for (const { url, hash } of [manifest.launchAsset, ...manifest.assets]) {
    const stored = objects.get(new URL(url).pathname.slice(1));
    expect(stored).toBeDefined();
    expect(await sha256Base64Url(new Uint8Array(stored!))).toBe(hash);
  }
  return { reply, manifest };
}

/** A release record of the fixture's PNG key with `hash`. */
async function seededRecord(updateId: string, hash: string) {
  const launch = await sha256Base64Url(utf8("launch"));
  return encodeRecord({
    updateId,
    channel: "main",
    runtimeVersion: "1.0.0",
    platform: "ios",
    createdAt: "2026-01-01T00:00:00.000Z",
    serverUrl: SERVER_URL,
    assetUrl: ASSET_URL,
    launchAsset: { hash: launch },
    assets: [{ key: PNG_MD5, hash, fileExtension: ".png" }],
    extra: {},
  });
}

const createdAt = async (objects: Objects, key: string) =>
  (await signedManifest(objects, key)).manifest.createdAt;

describe("publish to disk", () => {
  test("the tide bin publishes from another directory, and the real Node server serves each pointer", async () => {
    // A workspace: the tools are installed at its root, two levels above the app.
    const workspace = tempRoot();
    installFakeExpo(workspace);
    const app = project({ root: join(workspace, "apps", "app") });
    const bucket = tempRoot();
    const result = await run(
      MAIN,
      ["publish", "--channel", "main", "--project-root", app.root],
      env({ TIDE_DISK_DIR: bucket }),
      tempRoot(),
    );
    expect(result.stderr).not.toContain("tide:");
    expect(result.code).toBe(0);

    const objects = diskObjects(bucket);
    const ios = await expectPublished(objects, IOS);
    const android = await expectPublished(objects, ANDROID);
    // Export progress goes to stderr; stdout is one line per pointer written.
    expect(result.stdout).toBe(
      `${IOS} ${ios.manifest.id} ${ios.manifest.createdAt}\n${ANDROID} ${android.manifest.id} ${android.manifest.createdAt}\n`,
    );
    expect([...objects.keys()].filter((k) => k.startsWith("reply/")).sort()).toEqual(
      [ANDROID, IOS, NO_UPDATE_KEY].sort(),
    );
    expect(ios.manifest.assets.map((a) => [a.key, a.contentType])).toEqual([
      [PNG_MD5, "image/png"],
      ["75d117bbd0d2fe64c29bb45b5abe285e", "font/ttf"],
      ["f64cfef467216a023648b79c60d829a3", "text/html"], // Listed twice in the export, once here.
    ]);

    const server = runEntry({ TIDE_DISK_DIR: bucket });
    const port = await server.listening;
    const request = (platform: string, current?: string) =>
      fetch(`http://127.0.0.1:${port}/manifest`, {
        headers: {
          "expo-platform": platform,
          "expo-channel-name": "main",
          "expo-runtime-version": "1.0.0",
          "expo-protocol-version": "1",
          accept: "multipart/mixed",
          ...(current && { "expo-current-update-id": current }),
        },
      });
    for (const [platform, published] of [
      ["ios", ios],
      ["android", android],
    ] as const) {
      const res = await request(platform);
      expect(res.status).toBe(200);
      expect(res.headers.get("expo-manifest-filters")).toBe('channel="main"');
      expect(res.headers.get("content-type")).toBe(
        `multipart/mixed; boundary=${published.reply.boundary}`,
      );
      expect(new Uint8Array(await res.arrayBuffer())).toEqual(published.reply.body);
      // The signed launch URL, on this server, serves bytes with the signed hash.
      const { pathname } = new URL(published.manifest.launchAsset.url);
      const bundle = await fetch(`http://127.0.0.1:${port}${pathname}`);
      expect(bundle.status).toBe(200);
      const bytes = new Uint8Array(await bundle.arrayBuffer());
      expect(await sha256Base64Url(bytes)).toBe(published.manifest.launchAsset.hash);
    }

    const res = await request("ios", ios.manifest.id);
    const noUpdate = decodeStoredReply(objects.get(NO_UPDATE_KEY)!);
    const body = new Uint8Array(await res.arrayBuffer());
    expect(body).toEqual(noUpdate.body);
    const directive = parseMultipart(body, noUpdate.boundary).find((p) => p.name === "directive")!;
    await verifyExpoSignature(
      directive.body,
      directive.signature!,
      await certificatePublicKey(main.certificate),
      "main",
    );
    expect(new TextDecoder().decode(directive.body)).toBe('{"type":"noUpdateAvailable"}');
  });

  test("createdAt passes a previous manifest's createdAt and a rollback's commitTime set ahead of the clock", async () => {
    const root = tempRoot();
    const ahead = Math.floor(Date.now() / 1000) * 1000 + 3_600_000;
    const bucket = diskBucket(root);
    await bucket.put(IOS, await seededPointer("manifest", ahead));
    await bucket.put(ANDROID, await seededPointer("rollback", ahead + 5000));
    const { code } = await publishIn(project().root, env({ TIDE_DISK_DIR: root }));
    expect(code).toBe(0);
    const objects = diskObjects(root);
    expect(await createdAt(objects, IOS)).toBe(new Date(ahead + 1).toISOString());
    expect(await createdAt(objects, ANDROID)).toBe(new Date(ahead + 5001).toISOString());
  });

  test("publish refuses with no signing key or a mismatched key, leaving the bucket byte for byte", async () => {
    const root = tempRoot();
    const app = project();
    expect((await publishIn(app.root, env({ TIDE_DISK_DIR: root }))).code).toBe(0);
    const before = tree(root);
    const { TIDE_SIGNING_KEY: _, ...noKey } = env({ TIDE_DISK_DIR: root });
    expect(await publishIn(app.root, noKey)).toMatchObject({
      code: 2,
      err: ["tide: no signing key: set TIDE_SIGNING_KEY_FILE, TIDE_SIGNING_KEY or TIDE_KMS_KEY_ID"],
    });
    expect(await publishIn(app.root, env({ TIDE_DISK_DIR: root }, other))).toMatchObject({
      code: 2,
      err: [`tide: ${MISMATCH}`],
    });
    expect(tree(root)).toEqual(before);
  });

  describe("asset key identity", () => {
    test("a key recorded for another SHA-256 is refused before any write", async () => {
      const root = tempRoot();
      const id = "6f9619ff-8b86-4d01-b42d-00cf4fc964ff";
      await diskBucket(root).put(
        `updates/${id}.json`,
        await seededRecord(id, await sha256Base64Url(utf8("other bytes"))),
      );
      const before = tree(root);
      expect(await publishIn(project().root, env({ TIDE_DISK_DIR: root }))).toMatchObject({
        code: 2,
        err: [
          `tide: asset key ${PNG_MD5} names different bytes in updates/${id}.json and this export (ios): a key must never change its bytes`,
        ],
      });
      expect(tree(root)).toEqual(before);
    });

    test("two retained records that disagree are refused even when the last one matches the export", async () => {
      const root = tempRoot();
      const png = readFileSync(join(EXPORT, "assets", PNG_MD5));
      const [first, last] = [
        "00000000-0000-4000-8000-000000000000",
        "ffffffff-ffff-4fff-8fff-ffffffffffff",
      ];
      const bucket = diskBucket(root);
      await bucket.put(
        `updates/${first}.json`,
        await seededRecord(first, await sha256Base64Url(utf8("other bytes"))),
      );
      await bucket.put(
        `updates/${last}.json`,
        await seededRecord(last, await sha256Base64Url(new Uint8Array(png))),
      );
      const before = tree(root);
      expect(await publishIn(project().root, env({ TIDE_DISK_DIR: root }))).toMatchObject({
        code: 2,
        err: [
          `tide: asset key ${PNG_MD5} names different bytes in updates/${first}.json and updates/${last}.json: a key must never change its bytes`,
        ],
      });
      expect(tree(root)).toEqual(before);
    });

    test("a key a registered build records for another SHA-256 is refused before any write", async () => {
      const root = tempRoot();
      const id = "6f9619ff-8b86-4d01-b42d-00cf4fc964ff";
      await diskBucket(root).put(
        baseKey(id),
        encodeBaseRecord({
          kind: "embedded",
          updateId: id,
          runtimeVersion: "1.0.0",
          platform: "android",
          launchAsset: { hash: await sha256Base64Url(utf8("embedded")) },
          assets: [{ key: PNG_MD5, hash: await sha256Base64Url(utf8("other bytes")) }],
        }),
      );
      const before = tree(root);
      expect(await publishIn(project().root, env({ TIDE_DISK_DIR: root }))).toMatchObject({
        code: 2,
        err: [
          `tide: asset key ${PNG_MD5} names different bytes in ${baseKey(id)} and this export (ios): a key must never change its bytes`,
        ],
      });
      expect(tree(root)).toEqual(before);
    });

    test("a base record that names another ID is refused", async () => {
      const root = tempRoot();
      const id = "6f9619ff-8b86-4d01-b42d-00cf4fc964ff";
      const base = encodeBaseRecord({
        kind: "update",
        updateId: "00000000-0000-4000-8000-000000000000",
        runtimeVersion: "1.0.0",
        platform: "ios",
        launchAsset: { hash: await sha256Base64Url(utf8("launch")) },
      });
      await diskBucket(root).put(baseKey(id), base);
      const before = tree(root);
      expect(await publishIn(project().root, env({ TIDE_DISK_DIR: root }))).toMatchObject({
        code: 2,
        err: [`tide: ${baseKey(id)} is unreadable: its updateId differs from its name`],
      });
      expect(tree(root)).toEqual(before);
    });

    test("an unreadable release record is refused, since the check cannot be proven", async () => {
      const root = tempRoot();
      const id = "6f9619ff-8b86-4d01-b42d-00cf4fc964ff";
      const record = await seededRecord(id, await sha256Base64Url(utf8("x")));
      await diskBucket(root).put(`updates/${id}.json`, new Uint8Array([...record, 0x0a]));
      const before = tree(root);
      expect(await publishIn(project().root, env({ TIDE_DISK_DIR: root }))).toMatchObject({
        code: 2,
        err: [`tide: updates/${id}.json is unreadable: record is not in the form tide writes`],
      });
      expect(tree(root)).toEqual(before);
    });
  });

  describe("Expo environment and runtime", () => {
    test("every Expo tool runs in production mode without TIDE_ variables or dotenv files", async () => {
      const root = tempRoot();
      const app = project();
      expect((await publishIn(app.root, env({ TIDE_DISK_DIR: root }))).code).toBe(0);
      const log = app.log();
      expect(log.map((l) => [l.tool, l.args[0]])).toEqual([
        ["expo", "config"],
        ["expo", "config"],
        ["expo-updates", "runtimeversion:resolve"],
        ["expo-updates", "runtimeversion:resolve"],
        ["expo", "export"],
      ]);
      for (const { env: seen } of log) {
        expect(Object.keys(seen).filter((k) => k.startsWith("TIDE_"))).toEqual([]);
        expect([seen.EXPO_NO_DOTENV, seen.NODE_ENV, seen.BABEL_ENV]).toEqual([
          "1",
          "production",
          "production",
        ]);
      }
      // The app config gives "dev" and development values outside production mode.
      const { manifest } = await expectPublished(diskObjects(root), IOS);
      expect(manifest.extra.expoClient.extra).toEqual({ mode: "production" });
      expect(manifest.extra.expoClient.updates).toEqual({
        url: "https://updates.example.com/manifest",
      });
    });

    test("a caller's BABEL_ENV reaches every Expo tool alike", async () => {
      const root = tempRoot();
      const app = project();
      const result = await publishIn(app.root, {
        ...env({ TIDE_DISK_DIR: root }),
        BABEL_ENV: "staging",
      });
      expect(result.code).toBe(0);
      expect(new Set(app.log().map((l) => l.env.BABEL_ENV))).toEqual(new Set(["staging"]));
      // Config, runtime and export agree on the non-production branch.
      const { manifest } = await expectPublished(diskObjects(root), "reply/main/dev/ios");
      expect(manifest.extra.expoClient.extra).toEqual({ mode: "development" });
    });

    test("each platform's runtime version lands on its own pointer", async () => {
      const root = tempRoot();
      const app = project({
        overrides: { ios: { runtimeVersion: "2.0.0" }, android: { runtimeVersion: "3.0.0(1)" } },
      });
      expect((await publishIn(app.root, env({ TIDE_DISK_DIR: root }))).code).toBe(0);
      const objects = diskObjects(root);
      await expectPublished(objects, "reply/main/2.0.0/ios");
      await expectPublished(objects, "reply/main/3.0.0(1)/android");
    });

    test("--runtime-version overrides every platform without running the resolver", async () => {
      const root = tempRoot();
      const app = project();
      const result = await publishIn(app.root, env({ TIDE_DISK_DIR: root }), [
        "--runtime-version",
        "9.9.9",
      ]);
      expect(result.code).toBe(0);
      const objects = diskObjects(root);
      await expectPublished(objects, "reply/main/9.9.9/ios");
      await expectPublished(objects, "reply/main/9.9.9/android");
      expect(app.log().filter((l) => l.tool === "expo-updates")).toEqual([]);
    });

    test.each<[string, object, string]>([
      [
        "no runtime version",
        { runtimeVersion: null },
        "no ios runtime version: set runtimeVersion or pass --runtime-version",
      ],
      [
        "a runtime version outside the key grammar",
        { runtimeVersion: "1.0/2" },
        "runtimeVersion must be 1 to 64 of A-Z, a-z, 0-9, ., _, +, -, (, ) and :, and not . or ..",
      ],
    ])("%s is refused with nothing written", async (_, overrides, message) => {
      const root = tempRoot();
      expect(await publishIn(project({ overrides }).root, env({ TIDE_DISK_DIR: root }))).toEqual({
        code: 2,
        out: [],
        err: [`tide: ${message}`],
      });
      expect(tree(root)).toEqual(new Map());
    });
  });

  describe("configuration", () => {
    test.each<[string, Record<string, string>, string]>([
      [
        "a missing server URL",
        { TIDE_SERVER_URL: "" },
        "TIDE_SERVER_URL is not set: Tide writes it into every manifest",
      ],
      [
        "a plain http asset URL",
        { TIDE_ASSET_URL: "http://assets.example.com" },
        "TIDE_ASSET_URL must be an https URL with no credentials, query or fragment (http only to a loopback IP)",
      ],
      [
        "a server URL with a query",
        { TIDE_SERVER_URL: "https://updates.example.com/?v=1" },
        "TIDE_SERVER_URL must be an https URL with no credentials, query or fragment (http only to a loopback IP)",
      ],
    ])("%s is refused before Expo runs", async (_, change, message) => {
      const root = tempRoot();
      const app = project();
      expect(await publishIn(app.root, { ...env({ TIDE_DISK_DIR: root }), ...change })).toEqual({
        code: 2,
        out: [],
        err: [`tide: ${message}`],
      });
      expect(readdirSync(app.root)).not.toContain("fake-expo.log");
      expect(tree(root)).toEqual(new Map());
    });

    test("a channel outside the key grammar is refused before Expo runs", async () => {
      const root = tempRoot();
      const app = project();
      expect(await publishIn(app.root, env({ TIDE_DISK_DIR: root }), ["--channel", ".."])).toEqual({
        code: 2,
        out: [],
        err: [
          "tide: channel must be 1 to 64 of A-Z, a-z, 0-9, ., _, +, -, (, ) and :, and not . or ..",
        ],
      });
      expect(readdirSync(app.root)).not.toContain("fake-expo.log");
      expect(tree(root)).toEqual(new Map());
    });

    test("an http URL to a loopback IP is accepted and its trailing / dropped", async () => {
      const root = tempRoot();
      const result = await publishIn(
        project().root,
        { ...env({ TIDE_DISK_DIR: root }), TIDE_ASSET_URL: "http://127.0.0.1:9000/cdn/" },
        ["--platform", "ios", "--runtime-version", "1.0.0", "--export-dir", EXPORT],
      );
      expect(result.code).toBe(0);
      const { manifest } = await signedManifest(diskObjects(root), IOS);
      for (const a of manifest.assets) {
        expect(a.url).toMatch(/^http:\/\/127\.0\.0\.1:9000\/cdn\/assets\/[0-9a-f]{64}$/);
      }
    });

    test("a project without Expo installed is refused", async () => {
      const root = tempRoot();
      const app = project({ root: join(tempRoot(), "app") });
      expect(await publishIn(app.root, env({ TIDE_DISK_DIR: root }))).toEqual({
        code: 2,
        out: [],
        err: [
          "tide: expo is not installed in the project: add expo and expo-updates to its dependencies",
        ],
      });
    });

    test("an Expo tool that fails refuses the publish", async () => {
      const root = tempRoot();
      const app = project();
      writeFileSync(join(app.root, "app.config.mjs"), 'throw new Error("broken config");\n');
      expect(await publishIn(app.root, env({ TIDE_DISK_DIR: root }))).toEqual({
        code: 2,
        out: [],
        err: ["tide: expo config failed with exit code 1"],
      });
      expect(tree(root)).toEqual(new Map());
    });
  });

  describe("export refusals", () => {
    const metadataOf = (dir: string) =>
      JSON.parse(readFileSync(join(dir, "metadata.json"), "utf8")) as {
        fileMetadata: Record<string, { bundle: string; assets: { path: string; ext: string }[] }>;
      };
    const writeMetadata = (dir: string, metadata: object) => {
      writeFileSync(join(dir, "metadata.json"), JSON.stringify(metadata));
    };
    const pngPath = (dir: string) => join(dir, "assets", PNG_MD5);

    test.each<[string, (dir: string) => void, string]>([
      [
        "a path with ..",
        (dir) => {
          const m = metadataOf(dir);
          m.fileMetadata.ios!.bundle = "../outside.hbc";
          writeMetadata(dir, m);
        },
        "export metadata.json fileMetadata.ios.bundle must be a relative path inside the export",
      ],
      [
        "a missing platform",
        (dir) => {
          const m = metadataOf(dir);
          delete m.fileMetadata.android;
          writeMetadata(dir, m);
        },
        "export has no android bundle: metadata.json fileMetadata.android is missing",
      ],
      [
        "an asset replaced after export",
        (dir) => {
          writeFileSync(pngPath(dir), "replaced");
        },
        "export metadata.json fileMetadata.ios.assets[0].path does not hash to the key in its name: the file changed after expo export",
      ],
      [
        "an asset path in neither supported form",
        (dir) => {
          const m = metadataOf(dir);
          m.fileMetadata.ios!.assets[0]!.path = "images/splash.png";
          writeMetadata(dir, m);
        },
        "export metadata.json fileMetadata.ios.assets[0].path is not assets/<md5> or www.bundle/<md5>.<ext>",
      ],
      [
        "an asset symlinked outside the export",
        (dir) => {
          const outside = join(tempRoot(), "splash");
          cpSync(pngPath(dir), outside);
          rmSync(pngPath(dir));
          symlinkSync(outside, pngPath(dir));
        },
        "export metadata.json fileMetadata.ios.assets[0].path resolves outside the export directory",
      ],
      [
        "metadata.json symlinked outside the export",
        (dir) => {
          const outside = join(tempRoot(), "metadata.json");
          cpSync(join(dir, "metadata.json"), outside);
          rmSync(join(dir, "metadata.json"));
          symlinkSync(outside, join(dir, "metadata.json"));
        },
        "export metadata.json resolves outside the export directory",
      ],
      [
        "a FIFO in place of an asset",
        (dir) => {
          rmSync(pngPath(dir));
          execFileSync("mkfifo", [pngPath(dir)]);
        },
        "export metadata.json fileMetadata.ios.assets[0].path is not a regular file",
      ],
      [
        "one MD5 key on two files with different bytes",
        (dir) => {
          const key = COLLIDING_MD5;
          writeFileSync(join(dir, "assets", key), COLLIDING[0]);
          writeFileSync(join(dir, "www.bundle", `${key}.bin`), COLLIDING[1]);
          const m = metadataOf(dir);
          m.fileMetadata.ios!.assets.push(
            { path: `assets/${key}`, ext: "bin" },
            { path: `www.bundle/${key}.bin`, ext: "bin" },
          );
          writeMetadata(dir, m);
        },
        "export metadata.json fileMetadata.ios.assets[5] lists key 79054025255fb1a26e4bc422aef54eb4 for two different files",
      ],
    ])("%s is refused with nothing written", async (_, damage, message) => {
      const dir = join(tempRoot(), "export");
      cpSync(EXPORT, dir, { recursive: true });
      damage(dir);
      const root = tempRoot();
      const result = await publishIn(project().root, env({ TIDE_DISK_DIR: root }), [
        "--runtime-version",
        "1.0.0",
        "--export-dir",
        dir,
      ]);
      expect(result).toEqual({ code: 2, out: [], err: [`tide: ${message}`] });
      expect(tree(root)).toEqual(new Map());
    });
  });

  test("the record scan keeps only the requested records, though it indexes every record's keys", async () => {
    const bucket = diskBucket(tempRoot());
    const [a, b] = ["6f9619ff-8b86-4d01-b42d-00cf4fc96401", "6f9619ff-8b86-4d01-b42d-00cf4fc96402"];
    const hash = await sha256Base64Url(utf8("png"));
    for (const id of [a, b]) await bucket.putIfAbsent(recordKey(id), await seededRecord(id, hash));
    const { keys, records } = await recordedKeys(bucket, { wanted: [recordKey(a)] });
    expect([...records.keys()]).toEqual([recordKey(a)]);
    expect(keys.get(PNG_MD5)?.hash).toBe(hash);
  });
});

describe("publish to S3", () => {
  test("the same publish stores the disk publish's keys, and a second one uploads no existing object", async () => {
    const app = project();
    const disk = tempRoot();
    expect((await publishIn(app.root, env({ TIDE_DISK_DIR: disk }))).code).toBe(0);
    expect((await publishIn(app.root, env(s3Env()))).code).toBe(0);
    // Update IDs are fresh per publish, so each record is named by the pointer that serves it.
    const named = async (objects: Objects) => {
      const ids = new Map<string, string>();
      for (const key of [IOS, ANDROID]) {
        const { id } = (await expectPublished(objects, key)).manifest;
        ids.set(recordKey(id), `record of ${key}`);
        ids.set(baseKey(id), `base of ${key}`);
      }
      return [...objects.keys()].map((k) => ids.get(k) ?? k).sort();
    };
    expect(await named(s3.objects)).toEqual(await named(diskObjects(disk)));

    const served = async (key: string) => {
      const res = await s3Fetch(
        s3Target({ ...FAKE_S3, endpoint: s3.endpoint }),
        { method: "GET", key },
        new AbortController().signal,
      );
      await res.body?.cancel();
      return [res.headers.get("content-type"), res.headers.get("cache-control")];
    };
    const png = (await signedManifest(s3.objects, IOS)).manifest.assets[0]!;
    expect(await served(new URL(png.url).pathname.slice(1))).toEqual([
      "image/png",
      "public, max-age=31536000, immutable",
    ]);
    // A record the server reads is never cached by a public domain.
    expect(await served(IOS)).toEqual([null, "no-store"]);

    const first = {
      ios: await createdAt(s3.objects, IOS),
      android: await createdAt(s3.objects, ANDROID),
    };
    s3.puts.length = 0;
    expect((await publishIn(app.root, env(s3Env()))).code).toBe(0);
    // Repeat publishes upload no bundle or asset.
    expect(s3.puts.filter((k) => !/^(?:updates|bases)\//.test(k))).toEqual([IOS, ANDROID]);
    expect(s3.puts.filter((k) => k.startsWith("updates/"))).toHaveLength(2);
    expect(s3.puts.filter((k) => k.startsWith("bases/"))).toHaveLength(2);
    expect((await createdAt(s3.objects, IOS)) > first.ios).toBe(true);
    expect((await createdAt(s3.objects, ANDROID)) > first.android).toBe(true);
  });

  describe("clock", () => {
    test("a clock a minute ahead publishes, with createdAt from the checked sample on every platform", async () => {
      s3.setNow(T);
      // The local clock moves on once writing starts; createdAt must not follow it.
      const now = () => (s3.puts.length === 0 ? T + 60_000 : T + 90_000);
      expect((await publishIn(project().root, env(s3Env()), [], now)).code).toBe(0);
      const expected = new Date(T + 60_000).toISOString();
      expect(await createdAt(s3.objects, IOS)).toBe(expected);
      expect(await createdAt(s3.objects, ANDROID)).toBe(expected);
    });

    test.each([T + 60_001, T - 60_001])(
      "a local clock at %d refuses the publish",
      async (local) => {
        s3.setNow(T);
        expect(await publishIn(project().root, env(s3Env()), [], () => local)).toMatchObject({
          code: 2,
          err: [
            "tide: the local clock differs from the bucket's by more than a minute: fix the clock",
          ],
        });
        expect(s3.puts).toEqual([]);
      },
    );

    test("a certificate that has expired by the bucket's clock but not the local one is refused", async () => {
      const expiry = T + 3_600_000;
      const expiring = await identity(new Date(expiry));
      const app = project({ cert: expiring.certificate });
      s3.setNow(expiry + 20_000);
      const result = await publishIn(
        app.root,
        { ...env(s3Env(), expiring), TIDE_BUILD_CERTIFICATE_SHA256: expiring.fingerprint },
        [],
        () => expiry - 20_000,
      );
      expect(result).toMatchObject({
        code: 2,
        err: ["tide: updates.codeSigningCertificate: certificate has expired"],
      });
      expect(s3.puts).toEqual([]);
    });

    test.each(["local", "bucket"])(
      "a certificate that expires by the %s clock after the first pointer stops the second",
      async (clock) => {
        const expiry = T + 3_600_000;
        const expiring = await identity(new Date(expiry));
        const app = project({ cert: expiring.certificate });
        s3.setNow(T);
        // Once the first pointer lands, one clock passes expiry while the other stays behind it.
        if (clock === "bucket") s3.onPut(IOS, () => s3.setNow(expiry + 1000));
        const now = () => (clock === "local" && s3.puts.includes(IOS) ? expiry + 1000 : T);
        const result = await publishIn(
          app.root,
          { ...env(s3Env(), expiring), TIDE_BUILD_CERTIFICATE_SHA256: expiring.fingerprint },
          [],
          now,
        );
        expect(result.code).toBe(1);
        expect(result.err).toEqual([
          "tide: updates.codeSigningCertificate: certificate has expired",
        ]);
        expect(result.out).toHaveLength(1);
        expect(result.out[0]).toMatch(/^reply\/main\/1\.0\.0\/ios /);
        expect(s3.objects.has(IOS)).toBe(true);
        expect(s3.puts).not.toContain(ANDROID);
      },
    );

    test("a certificate that expires by the local clock while the bucket's time is read stops the next pointer", async () => {
      const expiry = T + 3_600_000;
      const expiring = await identity(new Date(expiry));
      const app = project({ cert: expiring.certificate });
      s3.setNow(T);
      let landed: number | undefined;
      s3.onPut(IOS, () => {
        landed = s3.requests;
      });
      // The local clock passes expiry during the first request after the iOS pointer: the bucket time read.
      const now = () => (landed !== undefined && s3.requests > landed ? expiry + 1000 : T);
      const result = await publishIn(
        app.root,
        { ...env(s3Env(), expiring), TIDE_BUILD_CERTIFICATE_SHA256: expiring.fingerprint },
        [],
        now,
      );
      expect(result).toMatchObject({
        code: 1,
        err: ["tide: updates.codeSigningCertificate: certificate has expired"],
      });
      expect(s3.objects.has(IOS)).toBe(true);
      expect(s3.puts).not.toContain(ANDROID);
    });
  });

  describe("other writers", () => {
    const theirs = utf8("another writer's reply");

    test("a pointer changed after it was read fails the publish and keeps the other writer's bytes", async () => {
      const app = project();
      expect((await publishIn(app.root, env(s3Env()))).code).toBe(0);
      s3.raceOnPut(IOS, theirs);
      const result = await publishIn(app.root, env(s3Env()));
      expect(result).toMatchObject({
        code: 1,
        out: [],
        err: [`tide: ${IOS} was changed by another writer since it was read; it keeps theirs`],
      });
      expect(s3.objects.get(IOS)).toEqual(theirs);
      expect(s3.puts.filter((k) => k === ANDROID)).toHaveLength(1); // Only the first publish's.
    });

    test("a pointer created by another writer during a first publish is kept", async () => {
      s3.raceOnPut(IOS, theirs);
      const result = await publishIn(project().root, env(s3Env()));
      expect(result.code).toBe(1);
      expect(s3.objects.get(IOS)).toEqual(theirs);
      expect(s3.puts).not.toContain(ANDROID);
    });

    test("a reply/no-update created under another key fails the publish before any pointer", async () => {
      s3.raceOnPut(NO_UPDATE_KEY, await noUpdateBy(other));
      const result = await publishIn(project().root, env(s3Env()));
      expect(result).toMatchObject({
        code: 1,
        err: [
          "tide: this bucket's replies are signed by a different certificate or key ID: a new signing identity needs a new bucket",
        ],
      });
      expect(s3.puts.filter((k) => k.startsWith("reply/main/"))).toEqual([]);
    });

    test("each update's release and base records are written before its pointer", async () => {
      expect((await publishIn(project().root, env(s3Env()))).code).toBe(0);
      for (const key of [IOS, ANDROID]) {
        const { id } = (await signedManifest(s3.objects, key)).manifest;
        const order = [recordKey(id), baseKey(id), key].map((k) => s3.puts.indexOf(k));
        expect(order.every((at, i) => at >= 0 && (i === 0 || at > order[i - 1]!))).toBe(true);
      }
    });

    test("a failed base write leaves every pointer unchanged", async () => {
      const app = project();
      expect((await publishIn(app.root, env(s3Env()))).code).toBe(0);
      const before = [IOS, ANDROID].map((k) => s3.objects.get(k));
      s3.puts.length = 0;
      s3.dropAfterPut("bases/");
      const result = await publishIn(app.root, env(s3Env()));
      expect(result.code).toBe(1);
      expect(result.err).toHaveLength(1);
      expect(result.err[0]).toMatch(
        /^tide: bases\/[0-9a-f-]{36}: S3 PutObject failed: network error; outcome unknown; no pointer names it yet$/,
      );
      expect([IOS, ANDROID].map((k) => s3.objects.get(k))).toEqual(before);
      expect(s3.puts.filter((k) => k.startsWith("reply/"))).toEqual([]);
    });

    test("a pointer whose response is lost may be live, and references only stored objects", async () => {
      s3.dropAfterPut(IOS);
      const result = await publishIn(project().root, env(s3Env()));
      expect(result.code).toBe(1);
      expect(result.err).toEqual([
        `tide: ${IOS}: S3 PutObject failed: network error; outcome unknown; check with tide status`,
      ]);
      expect(s3.puts.filter((k) => k === IOS)).toHaveLength(1);
      expect(s3.puts).not.toContain(ANDROID);
      await expectPublished(s3.objects, IOS);
    });
  });

  test("a repeated --platform is refused before any bucket call", async () => {
    const requests = s3.requests;
    expect(
      await publishIn(project().root, env(s3Env()), ["--platform", "ios", "--platform", "ios"]),
    ).toEqual({ code: 2, out: [], err: ["tide: --platform ios is given twice"] });
    expect(s3.requests).toBe(requests);
    expect(s3Snapshot()).toEqual(new Map());
  });
});
