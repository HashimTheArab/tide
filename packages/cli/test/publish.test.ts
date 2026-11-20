import { execFileSync } from "node:child_process";
import { KeyObject, createHash } from "node:crypto";
import {
  chmodSync,
  cpSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";

import type { FakeS3 } from "@tide/server/test/fake-s3";
import {
  NO_UPDATE_KEY,
  buildManifest,
  buildRollBackToEmbedded,
  certificatePublicKey,
  cryptoKeySigner,
  decodeStoredReply,
  diskKey,
  encodeMultipart,
  encodeStoredReply,
  expoSignature,
  parseMultipart,
  s3Fetch,
  s3Target,
  sha256Base64Url,
  verifyExpoSignature,
} from "@tide/protocol";
import { FAKE_S3, startFakeS3 } from "@tide/server/test/fake-s3";

import { RSA_SHA256, certificate } from "../../protocol/test/fixtures.ts";
import { runEntry } from "../../server/test/node/entry.ts";
import { diskBucket } from "../src/disk.ts";
import { assetUrl, decodeRecord, encodeRecord, launchUrl } from "../src/publish-record.ts";
import { publish } from "../src/publish.ts";
import { fixture, run, tempRoot, utf8 } from "./helpers.ts";

const FAKE_EXPO = fileURLToPath(new URL("fake-expo.ts", import.meta.url));
const MAIN = fileURLToPath(new URL("../src/main.ts", import.meta.url));
const EXPORT = fileURLToPath(new URL("fixtures/export", import.meta.url));
const SERVER_URL = "https://updates.example.com";
const ASSET_URL = "https://assets.example.com";
// The fixture PNG's key: the MD5 of its bytes, which is also its file name in the export.
const PNG_MD5 = createHash("md5").update(fixture("asset.png")).digest("hex");
const IOS = "reply/main/1.0.0/ios";
const ANDROID = "reply/main/1.0.0/android";
const T = Date.UTC(2030, 0, 1); // A whole second, so the fake's Date header carries it exactly.
const MD5_COLLISION =
  "d131dd02c5e6eec4693d9a0698aff95c2fcab58712467eab4004583eb8fb7f8955ad340609f4b30283e488832571415a085125e8f7cdc99fd91dbdf280373c5bd8823e3156348f5bae6dacd436c919c6dd53e2b487da03fd02396306d248cda0e99f33420f577ee8ce54b67080a80d1ec69821bcb6a8839396f9652b6ff72a70";
const MISMATCH = "the signing key does not match the app's code-signing certificate";

type Objects = ReadonlyMap<string, Uint8Array>;

const generate = () => crypto.subtle.generateKey(RSA_SHA256, true, ["sign", "verify"]);

interface Identity {
  readonly keys: Awaited<ReturnType<typeof generate>>;
  readonly certificate: string;
  readonly pkcs8: string;
  readonly fingerprint: string;
}

async function identity(notAfter?: Date): Promise<Identity> {
  const keys = await generate();
  const cert = await certificate(
    keys.publicKey,
    keys.privateKey,
    new Date("2020-01-01T00:00:00Z"),
    {
      ...(notAfter && { notAfter }),
    },
  );
  return {
    keys,
    certificate: cert,
    pkcs8: KeyObject.from(keys.privateKey).export({ type: "pkcs8", format: "pem" }).toString(),
    fingerprint: createHash("sha256")
      .update(Buffer.from(cert.replace(/-----[^-]+-----|\s/g, ""), "base64"))
      .digest("hex"),
  };
}

let main: Identity;
let other: Identity;
let s3: FakeS3;

beforeAll(async () => {
  [main, other, s3] = await Promise.all([identity(), identity(), startFakeS3()]);
});
afterAll(async () => {
  await s3.close();
});
beforeEach(() => {
  s3.objects.clear();
  s3.puts.length = 0;
  s3.setNow(undefined);
});

/** Writes `.bin/expo` and `.bin/expo-updates` shims that run the fake under `dir/node_modules`. */
function installFakeExpo(dir: string): void {
  const bin = join(dir, "node_modules", ".bin");
  mkdirSync(bin, { recursive: true });
  for (const tool of ["expo", "expo-updates"]) {
    const shim = join(bin, tool);
    writeFileSync(shim, `#!/bin/sh\nexec '${process.execPath}' '${FAKE_EXPO}' ${tool} "$@"\n`);
    chmodSync(shim, 0o755);
  }
}

/**
 * Returns a project whose app config gives production values only when both NODE_ENV and BABEL_ENV are
 * production; `overrides` are merged over it. The fake Expo tools are installed in it unless `root` is given.
 */
function project(options: { overrides?: object; cert?: string; root?: string } = {}): {
  root: string;
  log: () => { tool: string; args: string[]; env: Record<string, string> }[];
} {
  const root = options.root ?? tempRoot();
  if (options.root === undefined) installFakeExpo(root);
  mkdirSync(join(root, "keys"), { recursive: true });
  writeFileSync(join(root, "keys", "certificate.pem"), options.cert ?? main.certificate);
  writeFileSync(
    join(root, "app.config.mjs"),
    `export default () => {
  const production = process.env.NODE_ENV === "production" && process.env.BABEL_ENV === "production";
  return {
    name: "Fixture",
    slug: "fixture",
    version: "1.0.0",
    runtimeVersion: production ? "1.0.0" : "dev",
    extra: { mode: production ? "production" : "development" },
    updates: {
      url: "https://updates.example.com/manifest",
      codeSigningCertificate: "./keys/certificate.pem",
      codeSigningMetadata: { keyid: "main", alg: "rsa-v1_5-sha256" },
    },
    ...${JSON.stringify(options.overrides ?? {})},
  };
};
`,
  );
  return {
    root,
    log: () =>
      readFileSync(join(root, "fake-expo.log"), "utf8")
        .trimEnd()
        .split("\n")
        .map((l) => JSON.parse(l) as { tool: string; args: string[]; env: Record<string, string> }),
  };
}

const s3Env = () => ({
  TIDE_S3_ENDPOINT: s3.endpoint,
  TIDE_S3_REGION: FAKE_S3.region,
  TIDE_S3_BUCKET: FAKE_S3.bucket,
  TIDE_S3_ACCESS_KEY_ID: FAKE_S3.accessKeyId,
  TIDE_S3_SECRET_ACCESS_KEY: FAKE_S3.secretAccessKey,
});

/** The publish configuration for `id`, over `store`. */
const env = (store: Record<string, string>, id = main): Record<string, string> => ({
  PATH: process.env.PATH ?? "",
  TIDE_SIGNING_KEY: id.pkcs8,
  TIDE_BUILD_KEYID: "main",
  TIDE_BUILD_CERTIFICATE_SHA256: main.fingerprint,
  TIDE_SERVER_URL: SERVER_URL,
  TIDE_ASSET_URL: ASSET_URL,
  ...store,
});

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

/** Every store key in a disk bucket with its bytes. */
function diskObjects(root: string): Map<string, Uint8Array> {
  const out = new Map<string, Uint8Array>();
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      const key = diskKey(relative(root, path));
      if (entry.isDirectory()) walk(path);
      else if (key !== undefined) out.set(key, new Uint8Array(readFileSync(path)));
    }
  };
  walk(root);
  return out;
}

/** Every file under `root`, `.tide/` included, as base64. */
function tree(root: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else out.set(relative(root, path), readFileSync(path).toString("base64"));
    }
  };
  walk(root);
  return out;
}

const s3Snapshot = () =>
  new Map([...s3.objects].map(([k, v]) => [k, Buffer.from(v).toString("base64")]));

/** The manifest JSON a stored pointer serves, after its signature verifies against the main certificate. */
async function signedManifest(objects: Objects, key: string) {
  const reply = decodeStoredReply(objects.get(key)!);
  if (reply.kind !== "manifest") throw new Error(`${key} is not a manifest`);
  const part = parseMultipart(reply.body, reply.boundary).find((p) => p.name === "manifest")!;
  await verifyExpoSignature(
    part.body,
    part.signature!,
    await certificatePublicKey(main.certificate),
    "main",
  );
  const manifest = JSON.parse(new TextDecoder().decode(part.body)) as {
    id: string;
    createdAt: string;
    runtimeVersion: string;
    launchAsset: { hash: string; url: string };
    assets: {
      hash: string;
      key: string;
      fileExtension: string;
      contentType: string;
      url: string;
    }[];
    metadata: Record<string, string>;
    extra: { expoClient: Record<string, unknown> };
  };
  return { reply, manifest };
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

/** A pointer reply signed by the main key: a manifest created at `time`, or a rollback committed then. */
async function seededPointer(kind: "manifest" | "rollback", time: number) {
  const signer = cryptoKeySigner(main.keys.privateKey, "main");
  if (kind === "rollback") {
    const body = buildRollBackToEmbedded({ commitTime: new Date(time) });
    const multipart = encodeMultipart([
      { name: "directive", body, signature: await expoSignature(body, signer) },
    ]);
    return encodeStoredReply({ kind: "rollBackToEmbedded", ...multipart });
  }
  const hash = await sha256Base64Url(utf8("seeded"));
  const id = "0f6a9a3e-6c1b-4c4e-9d55-2b8f3f7c1a90";
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
    extra: {},
  });
  const multipart = encodeMultipart([
    { name: "manifest", body, signature: await expoSignature(body, signer) },
  ]);
  return encodeStoredReply({ kind: "manifest", updateId: id, manifestFilters: "", ...multipart });
}

/** A stored `reply/no-update` signed by `id`'s key. */
async function noUpdateBy(id: Identity) {
  const body = utf8('{"type":"noUpdateAvailable"}');
  const signature = await expoSignature(body, cryptoKeySigner(id.keys.privateKey, "main"));
  return encodeStoredReply({
    kind: "noUpdateAvailable",
    ...encodeMultipart([{ name: "directive", body, signature }]),
  });
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
          // A known MD5 collision: two 128-byte blocks with one digest.
          const block = (diff: Record<number, number>) => {
            const bytes = Buffer.from(MD5_COLLISION, "hex");
            for (const [i, b] of Object.entries(diff)) bytes[Number(i)] = b;
            return bytes;
          };
          const key = "79054025255fb1a26e4bc422aef54eb4";
          writeFileSync(join(dir, "assets", key), block({}));
          writeFileSync(
            join(dir, "www.bundle", `${key}.bin`),
            block({ 19: 0x07, 45: 0xf1, 59: 0x72, 83: 0x34, 109: 0x28, 123: 0xab }),
          );
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
        ids.set(`updates/${(await expectPublished(objects, key)).manifest.id}.json`, key);
      }
      return [...objects.keys()].map((k) => (ids.has(k) ? `record of ${ids.get(k)}` : k)).sort();
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
    expect(s3.puts.filter((k) => !k.startsWith("updates/"))).toEqual([IOS, ANDROID]);
    expect(s3.puts.filter((k) => k.startsWith("updates/"))).toHaveLength(2);
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
