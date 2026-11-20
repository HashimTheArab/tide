import { createPrivateKey } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { KeyObject } from "node:crypto";

import type { Signer } from "@tide/protocol";
import {
  NO_UPDATE_KEY,
  ProtocolError,
  codeSigningCertificate,
  cryptoKeySigner,
  expoSignature,
  verifyExpoSignature,
} from "@tide/protocol";

import type { Bucket } from "./bucket.ts";
import type { Verdict } from "./status.ts";
import { KMS_VARIABLES, kmsSigner } from "./keys-kms.ts";
import { readRecord } from "./status.ts";
import { bucketFromEnv } from "./storage.ts";

/** A refusal to sign. Its message names config fields and variables, never a value or a caught error's text. */
export class KeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KeyError";
  }
}

/** The app whose updates are signed: its root and the `exp` object `expo config --json` prints. */
export interface AppProject {
  readonly projectRoot: string;
  readonly config: unknown;
}

/** What the installed builds trust: the certificate's verify key and the code-signing key ID. */
interface Identity {
  readonly key: CryptoKey;
  readonly keyId: string;
  readonly pem: string;
}

/** A proven signer and the bucket it may write, with the checks a write command repeats before activating. */
export interface Writer {
  readonly signer: Signer;
  readonly bucket: Bucket;
  /** Whether a `reply/no-update` signed under this identity was present when opened. */
  readonly noUpdate: boolean;
  /** Re-reads `reply/no-update`: true when present and signed under this identity, false when absent. */
  checkNoUpdate(): Promise<boolean>;
  /** Refuses unless the certificate is valid at epoch milliseconds `at`. */
  checkCertificate(at: number): Promise<void>;
}

export type Env = Readonly<Record<string, string | undefined>>;

const FILE_LIMIT = 64 * 1024;
const PROBE = new TextEncoder().encode("tide signing probe");
const RSA = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" } as const;
const KEY_FILE = "TIDE_SIGNING_KEY_FILE";
const KEY_PEM = "TIDE_SIGNING_KEY";
const BUILD_KEYID = "TIDE_BUILD_KEYID";
const BUILD_CERTIFICATE = "TIDE_BUILD_CERTIFICATE_SHA256";
const FINGERPRINT = /^(?:[0-9a-f]{64}|[0-9a-f]{2}(?::[0-9a-f]{2}){31})$/i;

/**
 * Returns a signer proven against the app's certificate and the bucket it may write. Every refusal about the key or
 * the app comes before the bucket is constructed; the bucket check then only reads replies.
 */
export async function openWriter(
  env: Env,
  project: AppProject,
  options: { readonly kmsTimeoutMs?: number; readonly now?: () => number } = {},
): Promise<Writer> {
  const { now = Date.now } = options;
  const identity = await appIdentity(env, project, now());
  const signer = verifying(
    keySource(env, identity.keyId, options.kmsTimeoutMs ?? 30_000),
    identity,
  );
  await signer.sign(PROBE);
  const bucket = bucketFromEnv(env);
  return {
    signer,
    bucket,
    noUpdate: await checkBucket(bucket, identity),
    checkNoUpdate: () => checkBucket(bucket, identity),
    checkCertificate: async (at) => {
      await validCertificate(identity.pem, at);
    },
  };
}

/** Returns the certificate checked against the code-signing profile at epoch milliseconds `at`. */
async function validCertificate(pem: string, at: number) {
  try {
    return await codeSigningCertificate(pem, new Date(at));
  } catch (e) {
    if (!(e instanceof ProtocolError)) throw e;
    throw new KeyError(`updates.codeSigningCertificate: ${e.message}`);
  }
}

/** Reads the identity from the app config, checked against the build pins and the certificate profile at `now`. */
async function appIdentity(
  env: Env,
  { projectRoot, config }: AppProject,
  now: number,
): Promise<Identity> {
  const updates = member(config, "updates");
  const certificatePath = member(updates, "codeSigningCertificate");
  if (typeof certificatePath !== "string" || certificatePath === "") {
    throw new KeyError(
      "app config has no updates.codeSigningCertificate: Tide publishes only signed updates",
    );
  }
  const metadata = member(updates, "codeSigningMetadata");
  const keyId = member(metadata, "keyid");
  // Expo would fall back to "root"; an implicit key ID is refused instead.
  if (keyId === undefined) {
    throw new KeyError("app config has no updates.codeSigningMetadata.keyid");
  }
  if (typeof keyId !== "string" || !/^[\x20-\x7E]+$/.test(keyId)) {
    throw new KeyError("app config updates.codeSigningMetadata.keyid must be printable ASCII");
  }
  const alg = member(metadata, "alg");
  if (alg !== undefined && alg !== "rsa-v1_5-sha256") {
    throw new KeyError("app config updates.codeSigningMetadata.alg must be rsa-v1_5-sha256");
  }
  const buildKeyId = read(env, BUILD_KEYID);
  if (buildKeyId === undefined) {
    throw new KeyError(`${BUILD_KEYID} is not set: set it to the keyid the store builds embed`);
  }
  const buildCertificate = read(env, BUILD_CERTIFICATE);
  if (buildCertificate === undefined) {
    throw new KeyError(
      `${BUILD_CERTIFICATE} is not set: set it to the fingerprint of the certificate the store builds embed`,
    );
  }
  if (!FINGERPRINT.test(buildCertificate)) {
    throw new KeyError(`${BUILD_CERTIFICATE} must be a SHA-256 fingerprint: 64 hex digits`);
  }
  if (keyId !== buildKeyId) {
    throw new KeyError(`app config updates.codeSigningMetadata.keyid differs from ${BUILD_KEYID}`);
  }
  // Invalid UTF-8 decodes to U+FFFD, which the certificate's PEM pattern refuses.
  const pem = readSmallFile(join(projectRoot, certificatePath))?.toString("utf8");
  if (pem === undefined) {
    throw new KeyError("updates.codeSigningCertificate is unreadable or over 64 KiB");
  }
  const certificate = await validCertificate(pem, now);
  if (certificate.sha256 !== buildCertificate.replaceAll(":", "").toLowerCase()) {
    throw new KeyError(`app code-signing certificate differs from ${BUILD_CERTIFICATE}`);
  }
  return { key: certificate.key, keyId, pem };
}

/** Returns the signer for the one configured key source. */
function keySource(env: Env, keyId: string, kmsTimeoutMs: number): Signer {
  const file = read(env, KEY_FILE);
  const pem = read(env, KEY_PEM);
  const kms = Object.values(KMS_VARIABLES).filter((name) => read(env, name) !== undefined);
  const sources = [file !== undefined, pem !== undefined, kms.length > 0].filter(Boolean).length;
  if (sources === 0) {
    throw new KeyError(`no signing key: set ${KEY_FILE}, ${KEY_PEM} or ${KMS_VARIABLES.keyId}`);
  }
  if (sources > 1) {
    const named = [file && KEY_FILE, pem && KEY_PEM, ...kms].filter(Boolean);
    throw new KeyError(`more than one signing key: ${named.join(", ")} are set; set one source`);
  }
  if (file !== undefined) {
    const bytes = readSmallFile(file);
    if (bytes === undefined) {
      throw new KeyError(`${KEY_FILE} unreadable: not a regular file of at most 64 KiB`);
    }
    return pemSigner(bytes, KEY_FILE, keyId);
  }
  if (pem !== undefined) return pemSigner(pem, KEY_PEM, keyId);
  return kmsSigner(env, keyId, kmsTimeoutMs);
}

/** Returns a signer over an unencrypted PKCS#8 or PKCS#1 RSA private key of 2048 to 4096 bits. */
function pemSigner(pem: string | Buffer, source: string, keyId: string): Signer {
  // Read from the PEM itself: OpenSSL reports a missing passphrase as a cancelled prompt.
  if (/-----BEGIN ENCRYPTED |^Proc-Type: *4,ENCRYPTED/m.test(pem.toString())) {
    throw new KeyError(`${source} holds an encrypted key: Tide needs it unencrypted`);
  }
  let key: KeyObject;
  try {
    // An empty passphrase, so OpenSSL never prompts on the terminal.
    key = createPrivateKey({ key: pem, format: "pem", passphrase: "" });
  } catch {
    // The caught error is dropped: OpenSSL's text can quote the input.
    throw new KeyError(`${source} is not a PEM private key`);
  }
  if (key.asymmetricKeyType !== "rsa") {
    throw new KeyError(
      `${source} holds a key of type ${key.asymmetricKeyType}: Tide signs with RSA`,
    );
  }
  const bits = key.asymmetricKeyDetails?.modulusLength ?? 0;
  if (bits < 2048 || bits > 4096) {
    throw new KeyError(`${source} must hold an RSA key of 2048 to 4096 bits`);
  }
  return cryptoKeySigner(key.toCryptoKey(RSA, false, ["sign"]), keyId);
}

/** Wraps `inner` so no signature resolves unless it verifies under the app's certificate and key ID. */
function verifying(inner: Signer, { key, keyId }: Identity): Signer {
  return {
    keyId,
    async sign(bytes) {
      const sig = await inner.sign(bytes);
      try {
        const header = await expoSignature(bytes, { keyId, sign: () => Promise.resolve(sig) });
        await verifyExpoSignature(bytes, header, key, keyId);
      } catch {
        throw new KeyError("the signing key does not match the app's code-signing certificate");
      }
      return sig;
    },
  };
}

/**
 * Refuses a bucket whose `reply/no-update` is unreadable or signed under another identity: every build the bucket
 * serves gets that one reply, so all of them trust one certificate and key ID. Without one, every pointer must
 * verify instead, so only a new bucket or one of this identity's gets it repaired. Returns whether it exists.
 */
async function checkBucket(bucket: Bucket, identity: Identity): Promise<boolean> {
  const record = await readRecord(bucket, NO_UPDATE_KEY);
  if (record !== undefined) {
    await checkSigned(NO_UPDATE_KEY, record, identity);
    return true;
  }
  for (const entry of await bucket.list("reply/")) {
    if (!("key" in entry))
      throw new KeyError("reply/ is unreadable: an object name outside the key grammar");
    await checkSigned(
      entry.key,
      (await readRecord(bucket, entry.key)) ?? "absent when read",
      identity,
    );
  }
  return false;
}

/** Refuses a record that is unreadable or whose signed part does not verify under `identity`. */
async function checkSigned(
  key: string,
  record: Verdict,
  { key: verifyKey, keyId }: Identity,
): Promise<void> {
  if (typeof record === "string") throw new KeyError(`${key} is unreadable: ${record}`);
  try {
    await verifyExpoSignature(record.signed.body, record.signed.signature, verifyKey, keyId);
  } catch {
    throw new KeyError(
      "this bucket's replies are signed by a different certificate or key ID: a new signing identity needs a new bucket",
    );
  }
}

/** Returns the file's bytes if it is a regular file of at most 64 KiB, else undefined. */
export function readSmallFile(path: string): Buffer | undefined {
  let fd: number;
  try {
    // Non-blocking, so a FIFO cannot hang the open.
    fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
  } catch {
    return undefined;
  }
  try {
    const stat = fstatSync(fd);
    return stat.isFile() && stat.size <= FILE_LIMIT ? readFileSync(fd) : undefined;
  } catch {
    return undefined;
  } finally {
    closeSync(fd);
  }
}

/** Returns the variable `name`; empty counts as unset for every signing variable. */
export function read(env: Env, name: string): string | undefined {
  return env[name] === "" ? undefined : env[name];
}

/** Returns the own field `name` of a plain object, or undefined. */
export function member(value: unknown, name: string): unknown {
  return isObject(value) && Object.hasOwn(value, name) ? value[name] : undefined;
}

/** True for a JSON object: not null and not an array. */
export function isObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
