// Identities, projects, stores and readers shared by the write-command tests. Keys and certificates are generated
// per run; nothing here is a committed secret.
import { createHash, KeyObject } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach } from "vitest";

import type { FakeS3 } from "@tide/server/test/fake-s3";
import {
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
  sha256Base64Url,
  verifyExpoSignature,
} from "@tide/protocol";
import { FAKE_S3, startFakeS3 } from "@tide/server/test/fake-s3";

import { RSA_SHA256, certificate } from "../../protocol/test/fixtures.ts";
import { launchUrl } from "../src/publish-record.ts";
import { fixture, tempRoot, utf8 } from "./helpers.ts";

const FAKE_EXPO = fileURLToPath(new URL("fake-expo.ts", import.meta.url));
export const MAIN = fileURLToPath(new URL("../src/main.ts", import.meta.url));
export const EXPORT = fileURLToPath(new URL("fixtures/export", import.meta.url));
export const SERVER_URL = "https://updates.example.com";
export const ASSET_URL = "https://assets.example.com";
// The fixture PNG's key: the MD5 of its bytes, which is also its file name in the export.
export const PNG_MD5 = createHash("md5").update(fixture("asset.png")).digest("hex");
export const IOS = "reply/main/1.0.0/ios";
export const ANDROID = "reply/main/1.0.0/android";
export const T = Date.UTC(2030, 0, 1); // A whole second, so the fake's Date header carries it exactly.

export const MISMATCH = "the signing key does not match the app's code-signing certificate";

export type Objects = ReadonlyMap<string, Uint8Array>;

const generate = () => crypto.subtle.generateKey(RSA_SHA256, true, ["sign", "verify"]);

export interface Identity {
  readonly keys: Awaited<ReturnType<typeof generate>>;
  readonly certificate: string;
  readonly pkcs8: string;
  readonly fingerprint: string;
}

export async function identity(notAfter?: Date): Promise<Identity> {
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

// Live bindings, set once per test file by `useFixture`.
export let main: Identity;
export let other: Identity;
export let s3: FakeS3;

/** Generates the main and other identities and starts the S3 fake for this file, resetting the fake per test. */
export function useFixture(): void {
  beforeAll(async () => {
    [main, other, s3] = await Promise.all([identity(), identity(), startFakeS3()]);
  });
  afterAll(async () => {
    await s3.close();
  });
  beforeEach(() => {
    s3.reset();
  });
}

/** Writes `.bin/expo` and `.bin/expo-updates` shims that run the fake under `dir/node_modules`. */
export function installFakeExpo(dir: string): void {
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
export function project(options: { overrides?: object; cert?: string; root?: string } = {}): {
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

export const s3Env = () => ({
  TIDE_S3_ENDPOINT: s3.endpoint,
  TIDE_S3_REGION: FAKE_S3.region,
  TIDE_S3_BUCKET: FAKE_S3.bucket,
  TIDE_S3_ACCESS_KEY_ID: FAKE_S3.accessKeyId,
  TIDE_S3_SECRET_ACCESS_KEY: FAKE_S3.secretAccessKey,
});

/** The publish configuration for `id`, over `store`. */
export const env = (store: Record<string, string>, id = main): Record<string, string> => ({
  PATH: process.env.PATH ?? "",
  TIDE_SIGNING_KEY: id.pkcs8,
  TIDE_BUILD_KEYID: "main",
  TIDE_BUILD_CERTIFICATE_SHA256: main.fingerprint,
  TIDE_SERVER_URL: SERVER_URL,
  TIDE_ASSET_URL: ASSET_URL,
  ...store,
});

/** Every store key in a disk bucket with its bytes. */
export function diskObjects(root: string): Map<string, Uint8Array> {
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
export function tree(root: string): Map<string, string> {
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

export const s3Snapshot = () =>
  new Map([...s3.objects].map(([k, v]) => [k, Buffer.from(v).toString("base64")]));

/** A served manifest, as the tests read it. */
export interface Manifest {
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
}

/** The JSON of a multipart body's `name` part, after its signature verifies against the main certificate. */
export async function signedPart(
  body: Uint8Array<ArrayBuffer>,
  boundary: string,
  name: "manifest" | "directive",
): Promise<unknown> {
  const part = parseMultipart(body, boundary).find((p) => p.name === name);
  if (part?.signature === undefined) throw new Error(`no signed ${name} part`);
  const key = await certificatePublicKey(main.certificate);
  await verifyExpoSignature(part.body, part.signature, key, "main");
  return JSON.parse(new TextDecoder().decode(part.body));
}

/** The manifest JSON a stored pointer serves, after its signature verifies against the main certificate. */
export async function signedManifest(objects: Objects, key: string) {
  const stored = objects.get(key);
  if (stored === undefined) throw new Error(`${key} is absent`);
  const reply = decodeStoredReply(stored);
  if (reply.kind !== "manifest") throw new Error(`${key} is not a manifest`);
  const manifest = (await signedPart(reply.body, reply.boundary, "manifest")) as Manifest;
  return { reply, manifest };
}

/** A pointer reply signed by `by`'s key: a manifest created at `time`, or a rollback committed then. */
export async function seededPointer(kind: "manifest" | "rollback", time: number, by = main) {
  const signer = cryptoKeySigner(by.keys.privateKey, "main");
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
export async function noUpdateBy(id: Identity) {
  const body = utf8('{"type":"noUpdateAvailable"}');
  const signature = await expoSignature(body, cryptoKeySigner(id.keys.privateKey, "main"));
  return encodeStoredReply({
    kind: "noUpdateAvailable",
    ...encodeMultipart([{ name: "directive", body, signature }]),
  });
}
