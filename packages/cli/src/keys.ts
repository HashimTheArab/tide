import { createPrivateKey, createPublicKey } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs";
import type { KeyObject } from "node:crypto";

import type { Signer } from "@tide-ota/protocol";
import {
  NO_UPDATE_KEY,
  ProtocolError,
  codeSigningCertificate,
  expoSignature,
  verifyExpoSignature,
} from "@tide-ota/protocol";

import type { Bucket } from "./bucket.ts";
import type { ProjectExport } from "./publish-export.ts";
import type { Side, Verdict } from "./status.ts";
import { KMS_VARIABLES, kmsSource } from "./keys-kms.ts";
import { readRecord } from "./status.ts";
import { bucketFromEnv } from "./storage.ts";

/** A refusal to sign. Its message names config fields and variables, never a value or a caught error's text. */
export class KeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KeyError";
  }
}

/** The code-signing metadata a build embeds, holding nothing else. */
export interface SigningMetadata {
  readonly keyid: string;
  readonly alg?: "rsa-v1_5-sha256";
}

/** What the shipped builds trust: their certificate, its verify key and DER SHA-256, and their key ID. */
export interface Identity {
  readonly key: CryptoKey;
  readonly keyId: string;
  readonly pem: string;
  readonly sha256: string;
  readonly source: string; // The variable the certificate came from.
}

/** A proven signer and the bucket it may write, with the checks a write command repeats before activating. */
export interface Writer {
  readonly signer: Signer;
  readonly identity: Identity;
  readonly bucket: Bucket;
  /** Whether a `reply/no-update` signed under this identity was present when opened. */
  readonly noUpdate: boolean;
  /** Re-reads `reply/no-update`: true when present and signed under this identity, false when absent. */
  checkNoUpdate(): Promise<boolean>;
  /** Refuses unless the certificate is valid at epoch milliseconds `at`. */
  checkCertificate(at: number): Promise<void>;
}

/** The one configured signing key. Writers use only `sign`, so a KMS writer needs only `kms:Sign`. */
export interface KeySource {
  readonly sign: Signer["sign"];
  readonly publicKey: () => Promise<Uint8Array<ArrayBuffer>>; // SubjectPublicKeyInfo DER.
}

export type Env = Readonly<Record<string, string | undefined>>;

const FILE_LIMIT = 64 * 1024;
export const PROBE = new TextEncoder().encode("tide signing probe");
export const RSA = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" } as const;
const KEY_FILE = "TIDE_SIGNING_KEY_FILE";
const KEY_PEM = "TIDE_SIGNING_KEY";
export const BUILD_KEYID = "TIDE_BUILD_KEYID";
const KEYID = /^[\x20-\x7E]+$/;
const CERTIFICATE_FILE = "TIDE_BUILD_CERTIFICATE_FILE";
const CERTIFICATE_PEM = "TIDE_BUILD_CERTIFICATE";

/**
 * Returns a signer proven against the shipped builds' certificate and the bucket it may write; with `app`, refused
 * unless an export carries that same certificate and key ID. Every refusal about the key or identity comes before the
 * bucket is constructed; the bucket check then only reads replies.
 */
export async function openWriter(
  env: Env,
  options: {
    readonly kmsTimeoutMs?: number;
    readonly now?: () => number;
    readonly app?: Pick<ProjectExport, "certificate" | "codeSigningMetadata">;
  } = {},
): Promise<Writer> {
  const { now = Date.now, app } = options;
  const at = now();
  const identity = await buildIdentity(env, at);
  if (app !== undefined) await checkApp(app, identity, at);
  const source = signingKey(env, options.kmsTimeoutMs ?? 30_000);
  const signer = verifying({ keyId: identity.keyId, sign: source.sign }, identity);
  await signer.sign(PROBE);
  const bucket = bucketFromEnv(env);
  return {
    signer,
    identity,
    bucket,
    noUpdate: await checkBucket(bucket, identity),
    checkNoUpdate: () => checkBucket(bucket, identity),
    checkCertificate: async (at) => {
      await validCertificate(identity.pem, identity.source, at);
    },
  };
}

/**
 * Returns the shipped builds' identity: `TIDE_BUILD_KEYID` and the certificate in exactly one of
 * `TIDE_BUILD_CERTIFICATE_FILE` and `TIDE_BUILD_CERTIFICATE`, checked against the profile at epoch milliseconds `now`.
 */
export async function buildIdentity(env: Env, now: number): Promise<Identity> {
  const keyId = read(env, BUILD_KEYID);
  if (keyId === undefined) {
    throw new KeyError(`${BUILD_KEYID} is not set: set it to the keyid the builds embed`);
  }
  if (!KEYID.test(keyId)) throw new KeyError(`${BUILD_KEYID} must be printable ASCII`);
  const file = read(env, CERTIFICATE_FILE);
  const value = read(env, CERTIFICATE_PEM);
  if ((file === undefined) === (value === undefined)) {
    throw new KeyError(`set exactly one of ${CERTIFICATE_FILE} and ${CERTIFICATE_PEM}`);
  }
  const source = file === undefined ? CERTIFICATE_PEM : CERTIFICATE_FILE;
  // Invalid UTF-8 decodes to U+FFFD, which the certificate's PEM pattern refuses.
  const pem = file === undefined ? value : readSmallFile(file)?.toString("utf8");
  if (pem === undefined) {
    throw new KeyError(`${CERTIFICATE_FILE} unreadable: not a regular file of at most 64 KiB`);
  }
  const { key, sha256 } = await validCertificate(pem, source, now);
  return { key, keyId, pem, sha256, source };
}

/** Refuses an export whose certificate or key ID is not the shipped builds'. */
async function checkApp(
  app: Pick<ProjectExport, "certificate" | "codeSigningMetadata">,
  identity: Identity,
  now: number,
): Promise<void> {
  if (app.codeSigningMetadata.keyid !== identity.keyId) {
    throw new KeyError(`tide-export.json codeSigningMetadata.keyid differs from ${BUILD_KEYID}`);
  }
  const { sha256 } = await validCertificate(app.certificate, "tide-export.json certificate", now);
  if (sha256 !== identity.sha256) {
    throw new KeyError(`tide-export.json certificate differs from ${identity.source}`);
  }
}

/** Returns the certificate checked against the code-signing profile at epoch milliseconds `at`. */
export async function validCertificate(pem: string, source: string, at: number) {
  try {
    return await codeSigningCertificate(pem, new Date(at));
  } catch (e) {
    if (!(e instanceof ProtocolError)) throw e;
    throw new KeyError(`${source}: ${e.message}`);
  }
}

/** Returns the modulus length when `spki` is exactly the DER of an RSA public key as WebCrypto re-exports it. */
export async function rsaKeyBits(spki: Uint8Array<ArrayBuffer>): Promise<number | undefined> {
  try {
    const key = await crypto.subtle.importKey("spki", spki, RSA, true, ["verify"]);
    const again = new Uint8Array(await crypto.subtle.exportKey("spki", key));
    if (!Buffer.from(again).equals(spki)) return undefined;
    return (key.algorithm as { readonly modulusLength?: number }).modulusLength;
  } catch {
    return undefined;
  }
}

/**
 * Returns `{keyid}` or `{keyid, alg}` from code-signing metadata, a new object holding no other member. `field` names
 * the metadata in each refusal.
 */
export function signingMetadata(metadata: unknown, field: string): SigningMetadata {
  const keyid = member(metadata, "keyid");
  // Expo would fall back to "root"; an implicit key ID is refused instead.
  if (keyid === undefined) throw new KeyError(`${field}.keyid is missing`);
  if (typeof keyid !== "string" || !KEYID.test(keyid)) {
    throw new KeyError(`${field}.keyid must be printable ASCII`);
  }
  const alg = member(metadata, "alg");
  if (alg === undefined) return { keyid };
  if (alg !== "rsa-v1_5-sha256") throw new KeyError(`${field}.alg must be rsa-v1_5-sha256`);
  return { keyid, alg };
}

/** Returns the one configured key source; every refusal names variables, never a value. */
export function signingKey(env: Env, kmsTimeoutMs: number): KeySource {
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
    return pemSource(bytes, KEY_FILE);
  }
  if (pem !== undefined) return pemSource(pem, KEY_PEM);
  return kmsSource(env, kmsTimeoutMs);
}

/** Returns the key source over an unencrypted PKCS#8 or PKCS#1 RSA private key of 2048 to 4096 bits. */
function pemSource(pem: string | Buffer, source: string): KeySource {
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
  const signing = key.toCryptoKey(RSA, false, ["sign"]);
  const spki = new Uint8Array(createPublicKey(key).export({ type: "spki", format: "der" }));
  return {
    sign: async (bytes) => new Uint8Array(await crypto.subtle.sign(RSA, signing, bytes)),
    publicKey: () => Promise.resolve(spki),
  };
}

/** Wraps `inner` so no signature resolves unless it verifies under the builds' certificate and key ID. */
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
export async function checkBucket(bucket: Bucket, identity: Identity): Promise<boolean> {
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

/** Refuses a record that is unreadable or any of whose signed parts does not verify under `identity`. */
async function checkSigned(key: string, record: Verdict, identity: Identity): Promise<void> {
  if (typeof record === "string") throw new KeyError(`${key} is unreadable: ${record}`);
  for (const side of record.sides) {
    if (!(await verifies(side, identity))) {
      throw new KeyError(
        "this bucket's replies are signed by a different certificate or key ID: a new signing identity needs a new bucket",
      );
    }
  }
}

/**
 * Refuses unless each of `sides` read at `key` verifies under `identity`. A writer that copies a signed body checks
 * it here, since a valid `reply/no-update` stops `checkBucket` before any pointer.
 */
export async function checkCopied(
  key: string,
  sides: readonly Side[],
  identity: Identity,
): Promise<void> {
  for (const side of sides) {
    if (!(await verifies(side, identity))) {
      throw new KeyError(
        `${key}: a reply it copies does not verify under this app's certificate and key ID`,
      );
    }
  }
}

async function verifies({ signed }: Side, { key, keyId }: Identity): Promise<boolean> {
  try {
    await verifyExpoSignature(signed.body, signed.signature, key, keyId);
    return true;
  } catch {
    return false;
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
