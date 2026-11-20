import { KeyObject, createHash, generateKeyPairSync } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";

import type { Signer } from "@tide/protocol";
import type { FakeS3 } from "@tide/server/test/fake-s3";
import {
  certificatePublicKey,
  cryptoKeySigner,
  encodeMultipart,
  encodeStoredReply,
  expoSignature,
  verifyExpoSignature,
} from "@tide/protocol";
import { FAKE_S3, startFakeS3 } from "@tide/server/test/fake-s3";

import type { CertificateOptions } from "../../protocol/test/fixtures.ts";
import type { FakeKms, KmsFault } from "./fake-kms.ts";
import { EXTENSION, RSA_SHA256, certificate } from "../../protocol/test/fixtures.ts";
import { diskBucket } from "../src/disk.ts";
import { KeyError, openWriter } from "../src/keys.ts";
import { FAKE_KMS, startFakeKms } from "./fake-kms.ts";
import {
  expectNoPem,
  expectRefusal,
  expectSuccess,
  fixture,
  rejection,
  run,
  tempRoot,
  utf8,
} from "./helpers.ts";

type KeyPair = Awaited<ReturnType<typeof generate>>;

const DRIVER = fileURLToPath(new URL("open-writer.ts", import.meta.url));
const BOUNDARY = "tide_fixture_boundary";
const PROBE = utf8("tide signing probe");
const DAY = 86_400_000;
const PART = fixture("manifest.json");
const MISMATCH = "the signing key does not match the app's code-signing certificate";
const OTHER_IDENTITY =
  "this bucket's replies are signed by a different certificate or key ID: a new signing identity needs a new bucket";

/** A key pair generated for this run, its certificate and the forms each key source takes. */
interface Identity {
  readonly keys: KeyPair;
  readonly certificate: string;
  readonly fingerprint: string; // Lowercase hex SHA-256 of the certificate DER.
  readonly pkcs8: string;
  readonly pkcs1: string;
  readonly keyObject: KeyObject;
}

const generate = (modulusLength = 2048) =>
  crypto.subtle.generateKey({ ...RSA_SHA256, modulusLength }, true, ["sign", "verify"]);

/** Returns the lowercase hex SHA-256 of a PEM certificate's DER. */
const fingerprintOf = (pem: string) =>
  createHash("sha256")
    .update(Buffer.from(pem.replace(/-----[^-]+-----|\s/g, ""), "base64"))
    .digest("hex");

async function identity(keys?: KeyPair, options: CertificateOptions = {}): Promise<Identity> {
  const pair = keys ?? (await generate());
  const cert = await certificate(pair.publicKey, pair.privateKey, new Date(), options);
  const keyObject = KeyObject.from(pair.privateKey);
  return {
    keys: pair,
    certificate: cert,
    fingerprint: fingerprintOf(cert),
    pkcs8: keyObject.export({ type: "pkcs8", format: "pem" }).toString(),
    pkcs1: keyObject.export({ type: "pkcs1", format: "pem" }).toString(),
    keyObject,
  };
}

let main: Identity; // Key A, the certificate the builds trust.
let other: Identity; // Key B, another app's self-consistent pair.
let s3: FakeS3;
let kms: FakeKms;

beforeAll(async () => {
  [main, other] = await Promise.all([identity(), identity()]);
  [s3, kms] = await Promise.all([startFakeS3(), startFakeKms(main.keyObject)]);
});
afterAll(async () => {
  await Promise.all([s3.close(), kms.close()]);
});
afterEach(() => {
  kms.fault(undefined);
  kms.signWith(main.keyObject);
});

/** Writes `cert` into a fresh project and returns its root and Expo config. */
function project(cert: string, metadata: unknown = { keyid: "main", alg: "rsa-v1_5-sha256" }) {
  const projectRoot = tempRoot();
  mkdirSync(join(projectRoot, "keys"));
  writeFileSync(join(projectRoot, "keys", "certificate.pem"), cert);
  const config = {
    updates: {
      url: "https://updates.example.com/manifest",
      codeSigningCertificate: "./keys/certificate.pem",
      codeSigningMetadata: metadata,
    },
  };
  return { projectRoot, config };
}

/** The build pins for `id` under `keyid`. */
const pins = (id: Identity, keyid = "main") => ({
  TIDE_BUILD_KEYID: keyid,
  TIDE_BUILD_CERTIFICATE_SHA256: id.fingerprint,
});

/** Writes `pem` to a temp file and returns the file source's variable. */
function keyFile(pem: string): { TIDE_SIGNING_KEY_FILE: string } {
  const path = join(tempRoot(), "signing-key.pem");
  writeFileSync(path, pem);
  return { TIDE_SIGNING_KEY_FILE: path };
}

const kmsEnv = () => ({
  TIDE_KMS_KEY_ID: FAKE_KMS.keyId,
  TIDE_KMS_REGION: FAKE_KMS.region,
  TIDE_KMS_ACCESS_KEY_ID: FAKE_KMS.accessKeyId,
  TIDE_KMS_SECRET_ACCESS_KEY: FAKE_KMS.secretAccessKey,
  TIDE_KMS_ENDPOINT: kms.endpoint,
});

const s3Env = () => ({
  TIDE_S3_ENDPOINT: s3.endpoint,
  TIDE_S3_REGION: FAKE_S3.region,
  TIDE_S3_BUCKET: FAKE_S3.bucket,
  TIDE_S3_ACCESS_KEY_ID: FAKE_S3.accessKeyId,
  TIDE_S3_SECRET_ACCESS_KEY: FAKE_S3.secretAccessKey,
});

/** A stored `reply/no-update` whose directive part is `directiveFile`, signed by `key` under `keyid`. */
async function noUpdateReply(
  key: CryptoKey,
  keyid = "main",
  directiveFile = "directive-no-update.json",
): Promise<Uint8Array<ArrayBuffer>> {
  const body = fixture(directiveFile);
  const signature = await expoSignature(body, cryptoKeySigner(key, keyid));
  return encodeStoredReply({
    kind: "noUpdateAvailable",
    boundary: BOUNDARY,
    body: encodeMultipart([{ name: "directive", body, signature }], BOUNDARY).body,
  });
}

/** Every file under `root` with its bytes. */
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

const s3Objects = () =>
  new Map([...s3.objects].map(([k, v]) => [k, Buffer.from(v).toString("base64")]));

interface Store {
  readonly env: Record<string, string>;
  /** Fails unless the bucket holds what it held when opened and, on S3, got exactly `reads` requests. */
  readonly unchanged: (reads: number) => void;
}

/** Opens a store holding `seed`, on disk or on the S3 fake. */
async function store(kind: "disk" | "s3", seed: Record<string, Uint8Array<ArrayBuffer>>) {
  if (kind === "disk") {
    const root = tempRoot();
    const bucket = diskBucket(root);
    for (const [key, bytes] of Object.entries(seed)) await bucket.put(key, bytes);
    const before = tree(root);
    return {
      env: { TIDE_DISK_DIR: root },
      unchanged: () => {
        expect(tree(root)).toEqual(before);
      },
    } satisfies Store;
  }
  s3.objects.clear();
  for (const [key, bytes] of Object.entries(seed)) s3.objects.set(key, bytes);
  const before = s3Objects();
  const requests = s3.requests;
  return {
    env: s3Env(),
    unchanged: (reads: number) => {
      expect(s3.requests - requests).toBe(reads);
      expect(s3Objects()).toEqual(before);
    },
  } satisfies Store;
}

/**
 * Returns the KeyError `promise` rejects with, failing with fixed text unless its message is exactly `message`, so a
 * failure never prints a message that could hold key text.
 */
async function refusal(promise: Promise<unknown>, message: string): Promise<KeyError> {
  const e = await rejection(promise);
  if (!(e instanceof KeyError) || e.message !== message || e.cause !== undefined) {
    throw new Error(`expected refusal missing: ${message}`);
  }
  return e;
}

describe("signatures", () => {
  test.each<[string, () => Record<string, string>]>([
    ["a PKCS#8 file", () => keyFile(main.pkcs8)],
    ["a PKCS#1 file", () => keyFile(main.pkcs1)],
    ["the environment", () => ({ TIDE_SIGNING_KEY: main.pkcs8 })],
    ["KMS", kmsEnv],
  ])(
    "a manifest part signed through %s verifies against the generated certificate",
    async (_, source) => {
      const { projectRoot, config } = project(main.certificate);
      const dir = tempRoot();
      writeFileSync(join(dir, "config.json"), JSON.stringify(config));
      writeFileSync(join(dir, "manifest.json"), PART);
      const result = await run(
        DRIVER,
        [join(dir, "config.json"), projectRoot, join(dir, "manifest.json")],
        { ...pins(main), ...source(), TIDE_DISK_DIR: tempRoot() },
      );
      expectNoPem(result.stdout + result.stderr, main.pkcs8);
      expectNoPem(result.stdout + result.stderr, main.pkcs1);
      expectSuccess(result);
      const header = result.stdout.trimEnd();
      const key = await certificatePublicKey(main.certificate);
      await expect(verifyExpoSignature(PART, header, key, "main")).resolves.toBeUndefined();
      // Byte-identical to the protocol signer over the same key, so every source signs the same bytes.
      expect(header).toBe(await expoSignature(PART, cryptoKeySigner(main.keys.privateKey, "main")));
    },
  );

  test("a part over 8 KiB signs identically through KMS and a file", async () => {
    const large = utf8(JSON.stringify({ padding: "x".repeat(9000) }));
    const { projectRoot, config } = project(main.certificate);
    const headers = [];
    for (const source of [kmsEnv(), keyFile(main.pkcs8)]) {
      const { signer } = await openWriter(
        { ...pins(main), ...source, TIDE_DISK_DIR: tempRoot() },
        { projectRoot, config },
      );
      headers.push(await expoSignature(large, signer));
    }
    expect(headers[0]).toBe(headers[1]);
    const key = await certificatePublicKey(main.certificate);
    await expect(verifyExpoSignature(large, headers[0]!, key, "main")).resolves.toBeUndefined();
  });

  test("the KMS request carries the part's SHA-256 as a DIGEST, and a signed session token", async () => {
    const { projectRoot, config } = project(main.certificate);
    const { signer } = await openWriter(
      {
        ...pins(main),
        ...kmsEnv(),
        TIDE_KMS_SESSION_TOKEN: "tide-session-token",
        TIDE_DISK_DIR: tempRoot(),
      },
      { projectRoot, config },
    );
    await signer.sign(PART);
    const last = kms.last!;
    expect(JSON.parse(Buffer.from(last.body).toString("utf8"))).toEqual({
      KeyId: FAKE_KMS.keyId,
      Message: createHash("sha256").update(PART).digest("base64"),
      MessageType: "DIGEST",
      SigningAlgorithm: "RSASSA_PKCS1_V1_5_SHA_256",
    });
    expect(last.headers["x-amz-security-token"]).toBe("tide-session-token");
    expect(last.headers.authorization).toContain("x-amz-security-token");
  });
});

/** One refusal before the bucket: how it differs from a valid file-source setup, and its exact message. */
interface Refusal {
  readonly kms?: true; // Starts from a complete KMS setup instead of the key file.
  readonly env?: Record<string, string | undefined>;
  readonly cert?: Identity; // The app's certificate, which the pins name.
  readonly metadata?: unknown;
  readonly config?: (config: { updates: Record<string, unknown> }) => unknown;
  readonly fault?: KmsFault;
  readonly message: string;
}

const once = <T>(make: () => T) => {
  let made: { value: T } | undefined;
  return () => (made ??= { value: make() }).value;
};
const ecPem = once(() =>
  generateKeyPairSync("ec", { namedCurve: "P-256" })
    .privateKey.export({ type: "pkcs8", format: "pem" })
    .toString(),
);
const smallPem = once(() =>
  generateKeyPairSync("rsa", { modulusLength: 1024 })
    .privateKey.export({ type: "pkcs8", format: "pem" })
    .toString(),
);
const encryptedPem = () =>
  main.keyObject
    .export({ type: "pkcs8", format: "pem", cipher: "aes-256-cbc", passphrase: "tide" })
    .toString();
const expiredCertificate = once(() =>
  identity(main.keys, {
    notBefore: new Date(Date.now() - 3 * DAY),
    notAfter: new Date(Date.now() - DAY),
  }),
);
const ENDPOINT_RULE =
  "TIDE_KMS_ENDPOINT must be an https origin, or an http origin on a loopback IP address, with no path";

// Built when a test runs, since the keys are generated in beforeAll.
const REFUSALS: Record<string, () => Promise<Refusal> | Refusal> = {
  "no key source": () => ({
    env: { TIDE_SIGNING_KEY_FILE: undefined },
    message: "no signing key: set TIDE_SIGNING_KEY_FILE, TIDE_SIGNING_KEY or TIDE_KMS_KEY_ID",
  }),
  "a file and an environment key": () => ({
    env: { TIDE_SIGNING_KEY: main.pkcs8 },
    message:
      "more than one signing key: TIDE_SIGNING_KEY_FILE, TIDE_SIGNING_KEY are set; set one source",
  }),
  "a file and one KMS variable": () => ({
    env: { TIDE_KMS_REGION: FAKE_KMS.region },
    message:
      "more than one signing key: TIDE_SIGNING_KEY_FILE, TIDE_KMS_REGION are set; set one source",
  }),
  "an incomplete KMS signer": () => ({
    env: { TIDE_SIGNING_KEY_FILE: undefined, TIDE_KMS_KEY_ID: FAKE_KMS.keyId },
    message:
      "KMS signer incomplete: set TIDE_KMS_REGION, TIDE_KMS_ACCESS_KEY_ID, TIDE_KMS_SECRET_ACCESS_KEY",
  }),
  "a KMS endpoint over plain http to a remote host": () => ({
    kms: true,
    env: { TIDE_KMS_ENDPOINT: "http://kms.example.com" },
    message: ENDPOINT_RULE,
  }),
  "a malformed KMS region": () => ({
    kms: true,
    env: { TIDE_KMS_REGION: "us east" },
    message: "TIDE_KMS_REGION: region must be 1 to 32 of a-z, 0-9 and -",
  }),
  "a KMS key ID with a space": () => ({
    kms: true,
    env: { TIDE_KMS_KEY_ID: "alias/a b" },
    message: "TIDE_KMS_KEY_ID must be 1 to 2048 printable ASCII characters",
  }),
  "a malformed KMS access key": () => ({
    kms: true,
    env: { TIDE_KMS_ACCESS_KEY_ID: "short" },
    message: "TIDE_KMS_ACCESS_KEY_ID: accessKeyId must be 16 to 128 of A-Z, a-z and 0-9",
  }),
  "a malformed KMS secret": () => ({
    kms: true,
    env: { TIDE_KMS_SECRET_ACCESS_KEY: "short" },
    message:
      "TIDE_KMS_SECRET_ACCESS_KEY: secretAccessKey must be 16 to 256 printable ASCII characters",
  }),
  "a KMS session token with a space": () => ({
    kms: true,
    env: { TIDE_KMS_SESSION_TOKEN: "a b" },
    message: "TIDE_KMS_SESSION_TOKEN must be 1 to 8192 printable ASCII characters",
  }),
  "KMS access denied": () => ({
    kms: true,
    fault: { status: 400, header: "AccessDeniedException:http://internal.amazon.com/coral/" },
    message: "KMS Sign failed: 400 AccessDeniedException",
  }),
  "TIDE_BUILD_KEYID unset": () => ({
    env: { TIDE_BUILD_KEYID: undefined },
    message: "TIDE_BUILD_KEYID is not set: set it to the keyid the store builds embed",
  }),
  "TIDE_BUILD_CERTIFICATE_SHA256 empty": () => ({
    env: { TIDE_BUILD_CERTIFICATE_SHA256: "" },
    message:
      "TIDE_BUILD_CERTIFICATE_SHA256 is not set: set it to the fingerprint of the certificate the store builds embed",
  }),
  "a malformed fingerprint": () => ({
    env: { TIDE_BUILD_CERTIFICATE_SHA256: "sha256:abc" },
    message: "TIDE_BUILD_CERTIFICATE_SHA256 must be a SHA-256 fingerprint: 64 hex digits",
  }),
  "an app keyid that differs from the build's": () => ({
    metadata: { keyid: "mian" },
    message: "app config updates.codeSigningMetadata.keyid differs from TIDE_BUILD_KEYID",
  }),
  "no codeSigningCertificate": () => ({
    config: ({ updates }) => ({ updates: { ...updates, codeSigningCertificate: undefined } }),
    message: "app config has no updates.codeSigningCertificate: Tide publishes only signed updates",
  }),
  "a missing certificate file": () => ({
    config: ({ updates }) => ({
      updates: { ...updates, codeSigningCertificate: "./nowhere.pem" },
    }),
    message: "updates.codeSigningCertificate is unreadable or over 64 KiB",
  }),
  "a matching certificate not valid yet": async () => ({
    cert: await identity(main.keys, { notBefore: new Date(Date.now() + DAY) }),
    message: "updates.codeSigningCertificate: certificate is not valid yet",
  }),
  "a matching certificate without the codeSigning usage": async () => ({
    cert: await identity(main.keys, { extensions: [EXTENSION.digitalSignature] }),
    message: "updates.codeSigningCertificate: certificate must have Extended Key Usage codeSigning",
  }),
  "a missing keyid": () => ({
    metadata: { alg: "rsa-v1_5-sha256" },
    message: "app config has no updates.codeSigningMetadata.keyid",
  }),
  "an unprintable keyid": () => ({
    metadata: { keyid: "ma\u00efn" },
    message: "app config updates.codeSigningMetadata.keyid must be printable ASCII",
  }),
  "an unsupported alg": () => ({
    metadata: { keyid: "main", alg: "rsa-v1_5-sha512" },
    message: "app config updates.codeSigningMetadata.alg must be rsa-v1_5-sha256",
  }),
  "a directory as the key file": () => ({
    env: { TIDE_SIGNING_KEY_FILE: tempRoot() },
    message: "TIDE_SIGNING_KEY_FILE unreadable: not a regular file of at most 64 KiB",
  }),
  "a certificate where the key belongs": () => ({
    env: keyFile(main.certificate),
    message: "TIDE_SIGNING_KEY_FILE is not a PEM private key",
  }),
  "an encrypted key": () => ({
    env: keyFile(encryptedPem()),
    message: "TIDE_SIGNING_KEY_FILE holds an encrypted key: Tide needs it unencrypted",
  }),
  "an EC key": () => ({
    env: keyFile(ecPem()),
    message: "TIDE_SIGNING_KEY_FILE holds a key of type ec: Tide signs with RSA",
  }),
  "a 1024-bit RSA key": () => ({
    env: keyFile(smallPem()),
    message: "TIDE_SIGNING_KEY_FILE must hold an RSA key of 2048 to 4096 bits",
  }),
  "a truncated environment key": () => ({
    env: { TIDE_SIGNING_KEY_FILE: undefined, TIDE_SIGNING_KEY: main.pkcs8.slice(0, 900) },
    message: "TIDE_SIGNING_KEY is not a PEM private key",
  }),
  "another key than the certificate's": () => ({
    env: keyFile(other.pkcs8),
    message: MISMATCH,
  }),
  "a matching key with an expired certificate": async () => ({
    cert: await expiredCertificate(),
    message: "updates.codeSigningCertificate: certificate has expired",
  }),
};

/** Returns the environment and project for `refusal` on a store; the pins name the app's certificate. */
function setup(refusal: Refusal, storeEnv: Record<string, string>) {
  const cert = refusal.cert ?? main;
  const app = project(cert.certificate, refusal.metadata);
  const env: Record<string, string | undefined> = {
    ...pins(cert),
    ...(refusal.kms ? kmsEnv() : keyFile(main.pkcs8)),
    ...storeEnv,
    ...refusal.env,
  };
  for (const [k, v] of Object.entries(env)) if (v === undefined) delete env[k];
  return { env, project: { ...app, config: refusal.config?.(app.config) ?? app.config } };
}

describe.each(["disk", "s3"] as const)("refusals before the bucket on %s", (kind) => {
  const seed = async () => ({
    "reply/no-update": await noUpdateReply(main.keys.privateKey),
    "reply/main/1.0.0/ios": fixture("manifest.reply.json"),
  });

  test("every refusal has its own message", async () => {
    const messages = await Promise.all(
      Object.values(REFUSALS).map(async (make) => (await make()).message),
    );
    expect(new Set(messages).size).toBe(messages.length);
  });

  test.each(Object.keys(REFUSALS))("%s is refused and the bucket is untouched", async (name) => {
    const item = await REFUSALS[name]!();
    if (item.fault !== undefined) kms.fault(item.fault);
    const opened = await store(kind, await seed());
    const { env, project: app } = setup(item, opened.env);
    await refusal(openWriter(env, app), item.message);
    opened.unchanged(0);
  });

  test("a valid setup reads reply/no-update once and writes nothing", async () => {
    const opened = await store(kind, await seed());
    await openWriter(
      { ...pins(main), ...keyFile(main.pkcs8), ...opened.env },
      project(main.certificate),
    );
    opened.unchanged(kind === "s3" ? 1 : 0);
  });
});

test("a signing error wins over a missing TIDE_DISK_DIR", async () => {
  const { projectRoot, config } = project(main.certificate);
  await refusal(
    openWriter(
      { ...pins(main), ...keyFile(other.pkcs8), TIDE_DISK_DIR: join(tempRoot(), "missing") },
      { projectRoot, config },
    ),
    MISMATCH,
  );
});

// 0xA0 is no-break space in Latin-1, which the PEM pattern's \s would accept.
test("a certificate file that is not UTF-8 is refused", async () => {
  const { projectRoot, config } = project(main.certificate);
  const bytes = Buffer.concat([Buffer.from([0xa0]), Buffer.from(main.certificate)]);
  writeFileSync(join(projectRoot, "keys", "certificate.pem"), bytes);
  await refusal(
    openWriter({ ...pins(main), ...keyFile(main.pkcs8) }, { projectRoot, config }),
    "updates.codeSigningCertificate: certificate must be exactly one PEM CERTIFICATE block",
  );
});

describe.each(["disk", "s3"] as const)("build pins on an empty %s bucket", (kind) => {
  test("a renewed certificate is refused while the builds pin an expired one of the same key", async () => {
    const expired = await expiredCertificate();
    const opened = await store(kind, {});
    const { projectRoot, config } = project(main.certificate);
    await refusal(
      openWriter(
        { ...pins(expired), ...keyFile(main.pkcs8), ...opened.env },
        { projectRoot, config },
      ),
      "app code-signing certificate differs from TIDE_BUILD_CERTIFICATE_SHA256",
    );
    opened.unchanged(0);
    // With the app and the pin both naming the expired certificate, the profile refuses it.
    const app = project(expired.certificate);
    await refusal(
      openWriter({ ...pins(expired), ...keyFile(main.pkcs8), ...opened.env }, app),
      "updates.codeSigningCertificate: certificate has expired",
    );
    opened.unchanged(0);
  });

  test("an app keyid of mian is refused while the builds pin main", async () => {
    const opened = await store(kind, {});
    const { projectRoot, config } = project(main.certificate, { keyid: "mian" });
    await refusal(
      openWriter({ ...pins(main), ...keyFile(main.pkcs8), ...opened.env }, { projectRoot, config }),
      "app config updates.codeSigningMetadata.keyid differs from TIDE_BUILD_KEYID",
    );
    opened.unchanged(0);
  });
});

describe.each(["disk", "s3"] as const)("bucket identity on %s", (kind) => {
  test.each<[string, () => Promise<Uint8Array<ArrayBuffer>>, () => Identity, string, string]>([
    [
      "pins, config and key all moved to key B",
      () => noUpdateReply(main.keys.privateKey),
      () => other,
      "main",
      OTHER_IDENTITY,
    ],
    [
      "pins and config moved to keyid mian with key A",
      () => noUpdateReply(main.keys.privateKey),
      () => main,
      "mian",
      OTHER_IDENTITY,
    ],
    [
      "an undecodable record",
      () => Promise.resolve(utf8("garbage")),
      () => main,
      "main",
      "reply/no-update is unreadable: not a stored reply",
    ],
    [
      "a signed rollback in a noUpdateAvailable wrapper",
      () => noUpdateReply(main.keys.privateKey, "main", "directive-rollback.json"),
      () => main,
      "main",
      "reply/no-update is unreadable: directive type is not noUpdateAvailable",
    ],
  ])("%s is refused after one read", async (_, reply, id, keyid, message) => {
    const opened = await store(kind, { "reply/no-update": await reply() });
    const moved = id();
    const app = project(moved.certificate, { keyid });
    await refusal(
      openWriter({ ...pins(moved, keyid), ...keyFile(moved.pkcs8), ...opened.env }, app),
      message,
    );
    opened.unchanged(kind === "s3" ? 1 : 0);
  });

  test("key A under main passes, and so does an empty bucket", async () => {
    for (const seed of [{ "reply/no-update": await noUpdateReply(main.keys.privateKey) }, {}]) {
      const opened = await store(kind, seed);
      const { signer } = await openWriter(
        { ...pins(main), ...keyFile(main.pkcs8), ...opened.env },
        project(main.certificate),
      );
      expect(signer.keyId).toBe("main");
      opened.unchanged(kind === "s3" ? 1 : 0);
    }
  });
});

describe("KMS failures", () => {
  /** Opens a KMS writer on an empty disk bucket. */
  const open = (env: Record<string, string> = {}, kmsTimeoutMs?: number) =>
    openWriter(
      { ...pins(main), ...kmsEnv(), TIDE_DISK_DIR: tempRoot(), ...env },
      project(main.certificate),
      kmsTimeoutMs === undefined ? {} : { kmsTimeoutMs },
    );
  const secrets = [FAKE_KMS.secretAccessKey, FAKE_KMS.accessKeyId];
  const expectClean = (e: Error) => {
    for (const s of secrets) expect(e.message).not.toContain(s);
  };

  test("a wrong secret is refused by the fake's SigV4 check", async () => {
    expectClean(
      await refusal(
        open({ TIDE_KMS_SECRET_ACCESS_KEY: "not-the-fake-kms-secret" }),
        "KMS Sign failed: 400 InvalidSignatureException",
      ),
    );
  });

  test("a captured request replayed with another body is refused", async () => {
    await open();
    const { headers, body } = kms.last!;
    const changed = utf8(Buffer.from(body).toString("utf8").replace("DIGEST", "RAW"));
    const send = (extra: Record<string, string>) =>
      fetch(kms.endpoint, {
        method: "POST",
        headers: {
          "content-type": String(headers["content-type"]),
          "x-amz-target": String(headers["x-amz-target"]),
          "x-amz-date": String(headers["x-amz-date"]),
          "x-amz-content-sha256": String(headers["x-amz-content-sha256"]),
          authorization: String(headers.authorization),
          ...extra,
        },
        body: changed,
      });
    for (const res of [
      await send({}),
      await send({ "x-amz-content-sha256": createHash("sha256").update(changed).digest("hex") }),
    ]) {
      expect(res.status).toBe(400);
      expect(res.headers.get("x-amzn-errortype")).toMatch(/^InvalidSignatureException:/);
      await res.body?.cancel();
    }
  });

  const signature = async () =>
    Buffer.from(await crypto.subtle.sign(RSA_SHA256, main.keys.privateKey, PROBE)).toString(
      "base64",
    );
  const reply = async (fields: Record<string, unknown>) =>
    JSON.stringify({
      KeyId: FAKE_KMS.arn,
      Signature: await signature(),
      SigningAlgorithm: "RSASSA_PKCS1_V1_5_SHA_256",
      ...fields,
    });

  test("a hand-built valid reply passes, so the malformed ones below fail on their own field", async () => {
    kms.fault({ reply: await reply({}) });
    await expect(open()).resolves.toMatchObject({ signer: { keyId: "main" } });
  });

  test.each<[string, () => Promise<KmsFault> | KmsFault, string]>([
    [
      "access denied in the header",
      () => ({ status: 400, header: "AccessDeniedException:http://internal.amazon.com/coral/" }),
      "KMS Sign failed: 400 AccessDeniedException",
    ],
    [
      "throttling in the body's __type",
      () => ({ status: 400, body: '{"__type":"com.amazonaws.kms#ThrottlingException"}' }),
      "KMS Sign failed: 400 ThrottlingException",
    ],
    [
      "a disabled key in the body's code",
      () => ({ status: 400, body: '{"code":"DisabledException"}' }),
      "KMS Sign failed: 400 DisabledException",
    ],
    [
      "an internal error",
      () => ({ status: 500, header: "KMSInternalException" }),
      "KMS Sign failed: 500 KMSInternalException",
    ],
    [
      "a key pending deletion",
      () => ({ status: 400, body: '{"__type":"KMSInvalidStateException:x"}' }),
      "KMS Sign failed: 400 KMSInvalidStateException",
    ],
    [
      "an unrecognised code carrying the secret",
      () => ({ status: 400, header: FAKE_KMS.secretAccessKey }),
      "KMS Sign failed: 400 with an unrecognised error code",
    ],
    [
      "an error that is not a KMS document",
      () => ({ status: 502, body: "<html>bad gateway</html>" }),
      "KMS Sign failed: 502 without a KMS error document",
    ],
    ["a dropped connection", () => "drop", "KMS Sign failed: network error"],
    [
      "a 200 that is not JSON",
      () => ({ reply: "not json" }),
      "KMS Sign returned 200 with an invalid reply",
    ],
    [
      "a 200 without Signature",
      () => ({ reply: JSON.stringify({ SigningAlgorithm: "RSASSA_PKCS1_V1_5_SHA_256" }) }),
      "KMS Sign returned 200 with an invalid reply",
    ],
    [
      "a 200 with unpadded base64",
      async () => ({
        reply: await reply({ Signature: (await signature()).replace(/=+$/, "") + "A" }),
      }),
      "KMS Sign returned 200 with an invalid reply",
    ],
    [
      "a 200 with another algorithm",
      async () => ({ reply: await reply({ SigningAlgorithm: "RSASSA_PSS_SHA_256" }) }),
      "KMS Sign returned 200 with an invalid reply",
    ],
    ["an oversized 200", () => "oversize", "KMS Sign returned 200 with an invalid reply"],
  ])("%s is an error, never a signature", async (_, fault, message) => {
    kms.fault(await fault());
    expectClean(await refusal(open(), message));
  });

  test("a stalled reply times out", async () => {
    kms.fault("stall");
    await refusal(open({}, 200), "KMS Sign timed out after 200 ms");
  });

  test("a redirect is an error and is not followed", async () => {
    const elsewhere = await startFakeKms(main.keyObject);
    try {
      kms.fault({ redirect: `${elsewhere.endpoint}/` });
      await refusal(open(), "KMS Sign failed: 307 without a KMS error document");
      expect(elsewhere.requests).toBe(0);
    } finally {
      await elsewhere.close();
    }
  });

  test.each(["http://localhost:8080", "http://10.0.0.1", "https://kms.example.com/path"])(
    "the endpoint %s is refused before any request",
    async (endpoint) => {
      const before = kms.requests;
      await refusal(
        open({ TIDE_KMS_ENDPOINT: endpoint }),
        "TIDE_KMS_ENDPOINT must be an https origin, or an http origin on a loopback IP address, with no path",
      );
      expect(kms.requests).toBe(before);
    },
  );

  test("a KMS key that does not match the certificate is refused at the probe", async () => {
    kms.signWith(other.keyObject);
    await refusal(open(), MISMATCH);
  });

  test("a key switched after the probe is caught on the next signature", async () => {
    const { signer }: { signer: Signer } = await open();
    kms.signWith(other.keyObject);
    await refusal(signer.sign(PART), MISMATCH);
  });
});

describe("no PEM text in output", () => {
  /** Runs the driver against an empty disk bucket unless `env` names another. */
  async function drive(env: Record<string, string>, cert: string) {
    const { projectRoot, config } = project(cert);
    const dir = tempRoot();
    writeFileSync(join(dir, "config.json"), JSON.stringify(config));
    writeFileSync(join(dir, "manifest.json"), PART);
    return run(DRIVER, [join(dir, "config.json"), projectRoot, join(dir, "manifest.json")], {
      TIDE_DISK_DIR: tempRoot(),
      ...env,
    });
  }

  test.each(["TIDE_SIGNING_KEY_FILE", "TIDE_SIGNING_KEY"] as const)(
    "refusals through %s never print the key",
    async (source) => {
      const env = (pem: string) =>
        source === "TIDE_SIGNING_KEY_FILE" ? keyFile(pem) : { TIDE_SIGNING_KEY: pem };
      const expired = await expiredCertificate();
      const bucket = tempRoot();
      await diskBucket(bucket).put("reply/no-update", await noUpdateReply(other.keys.privateKey));
      const cases: [pem: string, cert: Identity, extra: Record<string, string>, message: string][] =
        [
          [ecPem(), main, {}, `${source} holds a key of type ec: Tide signs with RSA`],
          [smallPem(), main, {}, `${source} must hold an RSA key of 2048 to 4096 bits`],
          [encryptedPem(), main, {}, `${source} holds an encrypted key: Tide needs it unencrypted`],
          [main.pkcs8.slice(0, 900), main, {}, `${source} is not a PEM private key`],
          [other.pkcs8, main, {}, MISMATCH],
          [main.pkcs8, expired, {}, "updates.codeSigningCertificate: certificate has expired"],
          [
            main.pkcs8,
            main,
            pins(other),
            "app code-signing certificate differs from TIDE_BUILD_CERTIFICATE_SHA256",
          ],
          [main.pkcs8, main, { TIDE_DISK_DIR: bucket }, OTHER_IDENTITY],
        ];
      for (const [pem, cert, extra, message] of cases) {
        const result = await drive({ ...pins(cert), ...env(pem), ...extra }, cert.certificate);
        expectNoPem(result.stdout + result.stderr, pem);
        expectRefusal(result, message);
      }
    },
  );
});
