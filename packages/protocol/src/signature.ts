import { ProtocolError, base64 } from "./hash.ts";
import { encodeSfvDictionary, parseSfvDictionary } from "./sfv.ts";

const ALG = "rsa-v1_5-sha256";
const RSA = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" } as const;

/** Signs exact bytes with RSASSA-PKCS1-v1_5 SHA-256; the caller leaves `bytes` unchanged until `sign` settles. */
export interface Signer {
  readonly keyId: string;
  sign(bytes: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>>;
}

/** Returns a signer over a private RSASSA-PKCS1-v1_5 SHA-256 key, the only key whose digest matches the header. */
export function cryptoKeySigner(key: CryptoKey, keyId: string): Signer {
  checkKey(key, "private", "sign");
  return {
    keyId,
    sign: async (bytes) => new Uint8Array(await crypto.subtle.sign(RSA, key, bytes)),
  };
}

/** Returns the expo-signature header value for `bytes`. The key ID is checked before the signer runs. */
export async function expoSignature(
  bytes: Uint8Array<ArrayBuffer>,
  signer: Signer,
): Promise<string> {
  const keyId: unknown = signer.keyId;
  if (typeof keyId !== "string" || !/^[\x20-\x7E]+$/.test(keyId)) {
    throw new ProtocolError("keyId", "must be non-empty printable ASCII");
  }
  const sig: unknown = await signer.sign(bytes);
  if (!(sig instanceof Uint8Array) || sig.length === 0) {
    throw new ProtocolError("signer", "must resolve non-empty bytes");
  }
  return encodeSfvDictionary({ sig: base64(sig), keyid: keyId, alg: ALG });
}

/**
 * Checks `header` over `bytes` as expo-updates does, but stricter: a non-string `keyid` or `alg` is malformed,
 * where the client would apply the default. `key` must come from trusted configuration, never from the response.
 */
export async function verifyExpoSignature(
  bytes: Uint8Array<ArrayBuffer>,
  header: string,
  key: CryptoKey,
  keyId: string,
): Promise<void> {
  checkKey(key, "public", "verify");
  const members = parseSfvDictionary(header, "signature");
  const member = (name: string, fallback?: string): string => {
    const value = members.has(name) ? members.get(name) : fallback;
    if (typeof value !== "string") throw new ProtocolError("signature", `${name} must be a string`);
    return value;
  };
  const sigText = member("sig");
  const alg = member("alg", ALG);
  const id = member("keyid", "root");
  const sig = decodeBase64(sigText);
  if (sig === undefined) throw new ProtocolError("signature", "sig must be padded base64");
  if (alg !== ALG) throw new ProtocolError("signature.alg", `must be ${ALG}`);
  if (id !== keyId) throw new ProtocolError("signature.keyid", `must be ${keyId}`);
  if (!(await crypto.subtle.verify(RSA, key, sig, bytes))) {
    throw new ProtocolError("signature.sig", "does not match the bytes and key");
  }
}

/** Returns the verify key in the first CERTIFICATE block of `pem`. Dates, usages and the chain are not checked. */
export async function certificatePublicKey(pem: string): Promise<CryptoKey> {
  const block = /-----BEGIN CERTIFICATE-----([^-]*)-----END CERTIFICATE-----/.exec(pem)?.[1];
  if (block === undefined) throw new ProtocolError("certificate", "has no CERTIFICATE block");
  const der = decodeBase64(block.replace(/[\r\n]/g, ""));
  if (der === undefined) throw new ProtocolError("certificate", "must be canonical base64");
  const spki = subjectPublicKeyInfo(der);
  try {
    return await crypto.subtle.importKey("spki", spki, RSA, false, ["verify"]);
  } catch {
    throw new ProtocolError("certificate", "must hold an RSA public key");
  }
}

function checkKey(key: CryptoKey, type: "public" | "private", usage: "sign" | "verify"): void {
  const algorithm: { readonly name: string; readonly hash?: { readonly name: string } } =
    key.algorithm;
  if (
    key.type !== type ||
    algorithm.name !== RSA.name ||
    algorithm.hash?.name !== RSA.hash ||
    !key.usages.includes(usage)
  ) {
    throw new ProtocolError("key", `must be a ${type} ${RSA.name} ${RSA.hash} key for ${usage}`);
  }
}

/** Returns the bytes of non-empty canonical padded base64, or undefined. */
function decodeBase64(text: string): Uint8Array<ArrayBuffer> | undefined {
  if (
    text === "" ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(text)
  ) {
    return undefined;
  }
  const bytes = Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
  return base64(bytes) === text ? bytes : undefined;
}

const SEQUENCE = 0x30;
const INTEGER = 0x02;
const BIT_STRING = 0x03;
const VERSION = 0xa0;
// serial, signature, issuer, validity, subject, subjectPublicKeyInfo
const TBS_TAGS = [INTEGER, SEQUENCE, SEQUENCE, SEQUENCE, SEQUENCE, SEQUENCE];

interface Tlv {
  readonly tag: number;
  readonly start: number;
  readonly body: number;
  readonly end: number;
}

/** Returns the SubjectPublicKeyInfo TLV of an X.509 certificate's DER. */
function subjectPublicKeyInfo(der: Uint8Array<ArrayBuffer>): Uint8Array<ArrayBuffer> {
  const cert = readTlv(der, 0, der.length);
  if (cert.end !== der.length) throw new ProtocolError("certificate", "has bytes after the DER");
  const envelope = sequence(der, cert);
  if (!hasTags(envelope, [SEQUENCE, SEQUENCE, BIT_STRING]) || envelope.length !== 3) {
    throw new ProtocolError(
      "certificate",
      "must be exactly SEQUENCE { tbs, algorithm, signature }",
    );
  }
  const tbs = sequence(der, envelope[0]);
  const fields = tbs[0]?.tag === VERSION ? tbs.slice(1) : tbs;
  const spki = fields[5];
  if (spki === undefined || !hasTags(fields, TBS_TAGS)) {
    throw new ProtocolError("certificate", "has a malformed TBSCertificate");
  }
  return der.slice(spki.start, spki.end);
}

/** Returns the TLVs that exactly fill SEQUENCE `parent`. */
function sequence(der: Uint8Array, parent: Tlv | undefined): Tlv[] {
  if (parent?.tag !== SEQUENCE) throw new ProtocolError("certificate", "expected a DER SEQUENCE");
  const items: Tlv[] = [];
  for (let at = parent.body; at < parent.end;) {
    const item = readTlv(der, at, parent.end);
    items.push(item);
    at = item.end;
  }
  return items;
}

function hasTags(items: readonly Tlv[], tags: readonly number[]): boolean {
  return tags.every((tag, i) => items[i]?.tag === tag);
}

/** Reads one DER TLV inside `limit`: a low tag number and a minimal definite length of at most 4 octets. */
function readTlv(der: Uint8Array, start: number, limit: number): Tlv {
  const byte = (at: number) => {
    if (at >= limit) throw new ProtocolError("certificate", "has truncated DER");
    return der[at] ?? 0;
  };
  const tag = byte(start);
  if ((tag & 0x1f) === 0x1f) throw new ProtocolError("certificate", "has a high DER tag number");
  let length = byte(start + 1);
  let body = start + 2;
  if (length >= 0x80) {
    const octets = length & 0x7f;
    if (octets === 0 || octets > 4 || byte(body) === 0) {
      throw new ProtocolError("certificate", "has a DER length that is not minimal and definite");
    }
    length = 0;
    for (let i = 0; i < octets; i++) length = length * 256 + byte(body++);
    if (length < 0x80) {
      throw new ProtocolError("certificate", "has a DER length that is not minimal and definite");
    }
  }
  if (body + length > limit) throw new ProtocolError("certificate", "has truncated DER");
  return { tag, start, body, end: body + length };
}
