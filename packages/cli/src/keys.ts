import { createPrivateKey, createPublicKey } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs";
import type { KeyObject } from "node:crypto";

import type { Signer } from "@tide-ota/protocol";
import {
  MAX_REPLY_BYTES,
  NO_UPDATE_KEY,
  ProtocolError,
  certificateChain,
  certificateChainAtIssue,
  codeSigningCertificate,
  encodeMultipart,
  expoSignature,
  identityKey,
  parseExpoSignature,
  rootCertificate,
  verifyChainedSignature,
  verifyExpoSignature,
} from "@tide-ota/protocol";

import type { Bucket } from "./bucket.ts";
import type { ProjectExport } from "./publish-export.ts";
import type { Side, Verdict } from "./status.ts";
import { BucketError } from "./bucket.ts";
import { KMS_VARIABLES, kmsSource } from "./keys-kms.ts";
import { writing } from "./pointer.ts";
import { CHAIN_FLAG } from "./publish-export.ts";
import { checkRecord, readRecord } from "./status.ts";
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

/**
 * What the shipped builds trust: their certificate, its verify key and DER SHA-256, and their key ID. In chain mode
 * the certificate is the root they embed.
 */
export interface Identity {
  readonly key: CryptoKey;
  readonly keyId: string;
  readonly pem: string;
  readonly sha256: string;
  readonly source: string; // The variable the certificate came from.
  readonly chain: boolean; // The builds include the reply's certificate_chain.
}

/** A stored `reply/no-update` of this identity, with the ETag it was read under. */
interface NoUpdate {
  readonly etag: string;
  readonly side: Side;
}

/** A proven signer and the bucket it may write, with the checks a write command repeats before activating. */
export interface Writer {
  readonly signer: Signer;
  readonly identity: Identity;
  readonly bucket: Bucket;
  /** `reply/no-update` as opened, undefined when absent. */
  readonly noUpdate: NoUpdate | undefined;
  /** Whether a write must replace `noUpdate`: in chain mode, when it serves another chain than the configured one. */
  readonly renewNoUpdate: boolean;
  /** Creates the chain-mode binding, accepting another writer's of this root; undefined once bound, or direct. */
  readonly bind: (() => Promise<void>) | undefined;
  /** Re-reads `reply/no-update`, refusing one under another identity. */
  readNoUpdate(): Promise<NoUpdate | undefined>;
  /** Refuses unless the certificate, and in chain mode every served certificate, is valid at epoch ms `at`. */
  checkCertificate(at: number): Promise<void>;
  /** Returns the multipart of `body` signed as part `name`, followed in chain mode by the served chain. */
  signedReply(
    name: "manifest" | "directive",
    body: Uint8Array<ArrayBuffer>,
  ): Promise<{ readonly boundary: string; readonly body: Uint8Array<ArrayBuffer> }>;
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
const BUILD_CHAIN = "TIDE_BUILD_INCLUDE_CERTIFICATE_CHAIN";
const CHAIN_FILE = "TIDE_CERTIFICATE_CHAIN_FILE";
const CHAIN_PEM = "TIDE_CERTIFICATE_CHAIN";
const BINDING_LIMIT = 4096;
const OTHER_IDENTITY =
  "this bucket's replies are signed by a different certificate or key ID: a new signing identity needs a new bucket";

/**
 * Returns a signer proven against the builds' pins and the bucket it may write; with `app`, refused unless the export
 * carries the same pins. Every refusal before the bucket is constructed; the bucket check only reads.
 */
export async function openWriter(
  env: Env,
  options: {
    readonly kmsTimeoutMs?: number;
    readonly now?: () => number;
    readonly app?: App;
  } = {},
): Promise<Writer> {
  const { now = Date.now, app } = options;
  const at = now();
  const identity = await buildIdentity(env, at);
  if (app !== undefined) await checkApp(app, identity, at);
  const served = servedChain(env, identity);
  const leaf = served === undefined ? undefined : await chainOf(served, identity, at);
  const source = signingKey(env, options.kmsTimeoutMs ?? 30_000);
  const signer = verifying({ keyId: identity.keyId, sign: source.sign }, identity, leaf);
  await signer.sign(PROBE);
  const bucket = bucketFromEnv(env);
  const { noUpdate, bound } = await checkBucket(bucket, identity);
  const chained = noUpdate?.side.signed.chain;
  return {
    signer,
    identity,
    bucket,
    noUpdate,
    renewNoUpdate:
      served !== undefined && chained !== undefined && !sameBytes(chained, served.bytes),
    bind: bound ? undefined : () => bind(bucket, identity),
    readNoUpdate: () => readNoUpdate(bucket, identity),
    checkCertificate: async (at) => {
      if (served === undefined) await validCertificate(identity.pem, identity.source, at);
      else await chainOf(served, identity, at);
    },
    async signedReply(name, body) {
      const signature = await expoSignature(body, signer);
      return encodeMultipart([
        { name, body, signature },
        ...(served === undefined
          ? []
          : [{ name: "certificate_chain" as const, body: served.bytes }]),
      ]);
    },
  };
}

/** What a writer compares with the pins from an export. */
type App = Pick<ProjectExport, "certificate" | "codeSigningMetadata" | typeof CHAIN_FLAG>;

/**
 * Returns the shipped builds' identity: `TIDE_BUILD_KEYID`, the mode in `TIDE_BUILD_INCLUDE_CERTIFICATE_CHAIN`, and
 * the certificate in exactly one of `TIDE_BUILD_CERTIFICATE_FILE` and `TIDE_BUILD_CERTIFICATE`, checked at epoch
 * milliseconds `now` against the profile, or in chain mode as the root.
 */
export async function buildIdentity(env: Env, now: number): Promise<Identity> {
  const keyId = read(env, BUILD_KEYID);
  if (keyId === undefined) {
    throw new KeyError(`${BUILD_KEYID} is not set: set it to the keyid the builds embed`);
  }
  if (!KEYID.test(keyId)) throw new KeyError(`${BUILD_KEYID} must be printable ASCII`);
  const mode = read(env, BUILD_CHAIN);
  // Unset is the client's default.
  if (mode !== undefined && mode !== "true" && mode !== "false") {
    throw new KeyError(`${BUILD_CHAIN} must be true or false`);
  }
  const chain = mode === "true";
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
  const { key, sha256 } = await (chain ? validRoot : validCertificate)(pem, source, now);
  return { key, keyId, pem, sha256, source, chain };
}

/** Refuses an export whose certificate, key ID or mode is not the shipped builds'. */
async function checkApp(app: App, identity: Identity, now: number): Promise<void> {
  if (app.codeSigningMetadata.keyid !== identity.keyId) {
    throw new KeyError(`tide-export.json codeSigningMetadata.keyid differs from ${BUILD_KEYID}`);
  }
  if ((app[CHAIN_FLAG] === true) !== identity.chain) {
    throw new KeyError(`tide-export.json ${CHAIN_FLAG} differs from ${BUILD_CHAIN}`);
  }
  const check = identity.chain ? validRoot : validCertificate;
  const { sha256 } = await check(app.certificate, "tide-export.json certificate", now);
  if (sha256 !== identity.sha256) {
    throw new KeyError(`tide-export.json certificate differs from ${identity.source}`);
  }
}

/** The configured `certificate_chain` part body and the variable it came from. */
interface Served {
  readonly bytes: Uint8Array<ArrayBuffer>;
  readonly source: string;
}

/** Returns the served chain, required in chain mode and refused in direct mode; its bytes are stored as given. */
function servedChain(env: Env, { chain }: Identity): Served | undefined {
  const file = read(env, CHAIN_FILE);
  const value = read(env, CHAIN_PEM);
  if (!chain) {
    if (file === undefined && value === undefined) return undefined;
    throw new KeyError(
      `${CHAIN_FILE} and ${CHAIN_PEM} need ${BUILD_CHAIN}=true: the builds ignore a chain`,
    );
  }
  if ((file === undefined) === (value === undefined)) {
    throw new KeyError(`chain mode: set exactly one of ${CHAIN_FILE} and ${CHAIN_PEM}`);
  }
  if (value !== undefined) return { bytes: new TextEncoder().encode(value), source: CHAIN_PEM };
  const bytes = readSmallFile(file ?? "");
  if (bytes === undefined) {
    throw new KeyError(`${CHAIN_FILE} unreadable: not a regular file of at most 64 KiB`);
  }
  return { bytes: new Uint8Array(bytes), source: CHAIN_FILE };
}

/** Returns the served chain's leaf key, refused unless the chain over the root passes the client's rules at `at`. */
const chainOf = (served: Served, { pem }: Identity, at: number) =>
  keyChecked(served.source, certificateChain(served.bytes, pem, new Date(at)));

/** Returns the chain-mode root checked as the client reads it at epoch milliseconds `at`. */
export const validRoot = (pem: string, source: string, at: number) =>
  keyChecked(source, rootCertificate(pem, new Date(at)));

/** Returns the certificate checked against the code-signing profile at epoch milliseconds `at`. */
export const validCertificate = (pem: string, source: string, at: number) =>
  keyChecked(source, codeSigningCertificate(pem, new Date(at)));

/** Returns `check`'s result, its protocol refusal as a `KeyError` naming `source`. */
async function keyChecked<T>(source: string, check: Promise<T>): Promise<T> {
  try {
    return await check;
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

/**
 * Wraps `inner` so no signature resolves unless it verifies under the builds' certificate and key ID, or in chain
 * mode under the served `leaf`.
 */
function verifying(inner: Signer, { key, keyId }: Identity, leaf: CryptoKey | undefined): Signer {
  return {
    keyId,
    async sign(bytes) {
      const sig = await inner.sign(bytes);
      try {
        const header = await expoSignature(bytes, { keyId, sign: () => Promise.resolve(sig) });
        if (leaf === undefined) await verifyExpoSignature(bytes, header, key, keyId);
        else await verifyChainedSignature(bytes, header, leaf);
      } catch {
        throw new KeyError(
          leaf === undefined
            ? "the signing key does not match the app's code-signing certificate"
            : "the signing key does not match the served chain's leaf certificate",
        );
      }
      return sig;
    },
  };
}

/**
 * Refuses a bucket whose binding, `reply/no-update` or, without that, any pointer is unreadable or another
 * identity's: every build the bucket serves gets that one reply. `bound` says whether the chain-mode binding exists.
 */
async function checkBucket(
  bucket: Bucket,
  identity: Identity,
): Promise<{ readonly noUpdate: NoUpdate | undefined; readonly bound: boolean }> {
  const bound = await checkBinding(bucket, identity);
  const noUpdate = await readNoUpdate(bucket, identity);
  if (noUpdate !== undefined) return { noUpdate, bound };
  for (const entry of await bucket.list("reply/")) {
    if (!("key" in entry))
      throw new KeyError("reply/ is unreadable: an object name outside the key grammar");
    await checkSigned(
      entry.key,
      (await readRecord(bucket, entry.key)) ?? "absent when read",
      identity,
    );
  }
  return { noUpdate: undefined, bound };
}

/** For a writer that signs nothing, also refuses an absent `reply/no-update` (`absent` says why) or chain binding. */
export async function servingBucket(
  bucket: Bucket,
  identity: Identity,
  absent: string,
): Promise<void> {
  const { noUpdate, bound } = await checkBucket(bucket, identity);
  if (noUpdate === undefined) throw new KeyError(absent);
  if (!bound) {
    throw new KeyError(
      `${await identityKey(identity.keyId)} is absent: tide publish, republish or rollback writes it`,
    );
  }
}

/** Reads `reply/no-update`, refusing it unreadable or under another identity; undefined when absent. */
async function readNoUpdate(bucket: Bucket, identity: Identity): Promise<NoUpdate | undefined> {
  const object = await stored(bucket, NO_UPDATE_KEY, MAX_REPLY_BYTES);
  if (object === undefined) return undefined;
  const verdict = checkRecord(NO_UPDATE_KEY, object.bytes);
  const side = await checkSigned(NO_UPDATE_KEY, verdict, identity);
  return { etag: object.etag, side };
}

/** Returns the binding of `keyId` to the root whose DER SHA-256 is `root`, and its key. */
async function binding(keyId: string, root: string) {
  const json = JSON.stringify({ version: 1, keyid: keyId, root });
  return { key: await identityKey(keyId), bytes: new TextEncoder().encode(json) };
}

/**
 * In chain mode, refuses any binding of the key ID but this root's; true when it binds this root, false when absent.
 * Direct mode reads nothing and returns true.
 */
async function checkBinding(bucket: Bucket, { chain, keyId, sha256 }: Identity): Promise<boolean> {
  if (!chain) return true;
  const { key, bytes } = await binding(keyId, sha256);
  const object = await stored(bucket, key, BINDING_LIMIT);
  if (object === undefined) return false;
  if (sameBytes(object.bytes, bytes)) return true;
  throw new KeyError(
    `${key} binds another root or is not one tide writes: a new signing identity needs a new bucket`,
  );
}

/** Creates this root's binding; another writer's counts only when it is this root's too. */
async function bind(bucket: Bucket, identity: Identity): Promise<void> {
  const { key, bytes } = await binding(identity.keyId, identity.sha256);
  if ((await writing(key, () => bucket.putIfAbsent(key, bytes))) !== undefined) return;
  if (!(await checkBinding(bucket, identity))) {
    throw new KeyError(`${key} was removed by another writer during the publish`);
  }
}

/** Returns the object at `key`, undefined when absent; a failed read refuses. */
async function stored(bucket: Bucket, key: string, limit: number) {
  try {
    return await bucket.get(key, limit);
  } catch (e) {
    throw new KeyError(
      `${key} is unreadable: ${e instanceof BucketError ? e.message : "read failed"}`,
    );
  }
}

/**
 * Refuses a record that is unreadable or any of whose signed parts does not belong to `identity`; returns its first
 * side.
 */
async function checkSigned(key: string, record: Verdict, identity: Identity): Promise<Side> {
  if (typeof record === "string") throw new KeyError(`${key} is unreadable: ${record}`);
  for (const side of record.sides) {
    if (!(await verifies(side, identity))) throw new KeyError(OTHER_IDENTITY);
  }
  const [first] = record.sides;
  if (first === undefined) throw new KeyError(`${key} is unreadable: it holds no reply`);
  return first;
}

/**
 * Refuses unless each of `sides` read at `key` belongs to `identity`. A writer that copies a signed body checks
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

/** True when the side is this identity's, in its mode; chains are judged as of their issue. */
async function verifies({ signed }: Side, identity: Identity): Promise<boolean> {
  const { key, keyId, pem, chain } = identity;
  if ((signed.chain !== undefined) !== chain) return false;
  try {
    if (signed.chain === undefined) {
      await verifyExpoSignature(signed.body, signed.signature, key, keyId);
      return true;
    }
    if (parseExpoSignature(signed.signature).keyId !== keyId) return false;
    const leaf = await certificateChainAtIssue(signed.chain, pem);
    await verifyChainedSignature(signed.body, signed.signature, leaf);
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

/** True when `a` and `b` hold the same bytes. */
export function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

/** True for a JSON object: not null and not an array. */
export function isObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
