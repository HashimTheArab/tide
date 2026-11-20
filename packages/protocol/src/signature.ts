import { ProtocolError, base64, decodeBase64 } from "./hash.ts";
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
  const { sig, keyId: id } = parseExpoSignature(header);
  if (id !== keyId) throw new ProtocolError("signature.keyid", `must be ${keyId}`);
  if (!(await crypto.subtle.verify(RSA, key, sig, bytes))) {
    throw new ProtocolError("signature.sig", "does not match the bytes and key");
  }
}

/** Returns the signature bytes and key ID of an expo-signature header, checked as `verifyExpoSignature` does. */
export function parseExpoSignature(header: string): {
  readonly sig: Uint8Array<ArrayBuffer>;
  readonly keyId: string;
} {
  const members = parseSfvDictionary(header, "signature");
  const member = (name: string, fallback?: string): string => {
    const m = members.get(name);
    const value = m === undefined ? fallback : m.kind === "string" ? m.text : undefined;
    if (value === undefined) throw new ProtocolError("signature", `${name} must be a string`);
    return value;
  };
  // iOS reads the whole dictionary as [String: String], so any other member fails there.
  for (const [name, { kind }] of members) {
    if (kind !== "string" && kind !== "token") {
      throw new ProtocolError("signature", `${name} must be a string or token`);
    }
  }
  const sigText = member("sig");
  const alg = member("alg", ALG);
  const keyId = member("keyid", "root");
  const sig = decodeBase64(sigText);
  if (sig === undefined) throw new ProtocolError("signature", "sig must be padded base64");
  if (alg !== ALG) throw new ProtocolError("signature.alg", `must be ${ALG}`);
  return { sig, keyId };
}

/** Returns the verify key in the first CERTIFICATE block of `pem`. Dates, usages and the chain are not checked. */
export async function certificatePublicKey(pem: string): Promise<CryptoKey> {
  const block = /-----BEGIN CERTIFICATE-----([^-]*)-----END CERTIFICATE-----/.exec(pem)?.[1];
  if (block === undefined) throw new ProtocolError("certificate", "has no CERTIFICATE block");
  const der = decodeBase64(block.replace(/[\r\n]/g, ""));
  if (der === undefined) throw new ProtocolError("certificate", "must be canonical base64");
  return rsaKey(der, parseCertificate(der).spki);
}

/** A direct-signing certificate's verify key, and the lowercase hex SHA-256 of its DER. */
export interface CodeSigningCertificate {
  readonly key: CryptoKey;
  readonly sha256: string;
}

const SHA256_WITH_RSA = "1.2.840.113549.1.1.11";
const KEY_USAGE = "2.5.29.15";
const EXT_KEY_USAGE = "2.5.29.37";
const CODE_SIGNING = "1.3.6.1.5.5.7.3.3";
// Expo's project-scoped certificates; Tide's replies carry no project ID or scope key to check it against.
const EXPO_PROJECT_INFORMATION =
  "1.2.840.113556.1.8000.2554.43437.254.128.102.157.7894389.20439.2.1";

/**
 * Returns `pem` as the one self-signed certificate stock expo-updates trusts for direct signing at `now`: X.509 v3,
 * valid at `now`, sha256WithRSAEncryption, Key Usage digitalSignature, Extended Key Usage codeSigning, no Expo
 * project information, and an RSA key of 2048 to 4096 bits.
 */
export async function codeSigningCertificate(
  pem: string,
  now: Date,
): Promise<CodeSigningCertificate> {
  const block =
    /^\s*-----BEGIN CERTIFICATE-----\r?\n([A-Za-z0-9+/=\r\n]*)-----END CERTIFICATE-----\s*$/.exec(
      pem,
    )?.[1];
  if (block === undefined) {
    throw new ProtocolError("certificate", "must be exactly one PEM CERTIFICATE block");
  }
  const der = decodeBase64(block.replace(/\r?\n/g, ""));
  if (der === undefined) throw new ProtocolError("certificate", "must be canonical base64");
  const cert = parseCertificate(der);
  const fail = (message: string) => new ProtocolError("certificate", message);
  if (cert.version === undefined || !equal(der, cert.version, V3)) {
    throw fail("must be X.509 v3");
  }
  if (
    !equal(
      der,
      cert.innerAlgorithm,
      der.subarray(cert.outerAlgorithm.start, cert.outerAlgorithm.end),
    )
  ) {
    throw fail("must name the same signature algorithm in the TBSCertificate and outside it");
  }
  const algorithm = sequence(der, cert.outerAlgorithm);
  if (
    algorithm[0]?.tag !== OID ||
    oid(der, algorithm[0]) !== SHA256_WITH_RSA ||
    algorithm.length > 2 ||
    (algorithm[1] !== undefined && !equal(der, algorithm[1], NULL))
  ) {
    throw fail("must be signed with sha256WithRSAEncryption");
  }
  if (!equal(der, cert.issuer, der.subarray(cert.subject.start, cert.subject.end))) {
    throw fail("must be self-issued");
  }
  const validity = sequence(der, cert.validity);
  const [notBefore, notAfter] = validity.map((t) => time(der, t));
  if (notBefore === undefined || notAfter === undefined || validity.length !== 2) {
    throw fail("has a malformed validity");
  }
  if (now.getTime() < notBefore) throw fail("is not valid yet");
  if (now.getTime() > notAfter) throw fail("has expired");
  const extensions = extensionsOf(der, cert.extensions);
  if (!digitalSignature(extensions.get(KEY_USAGE))) {
    throw fail("must have Key Usage digitalSignature");
  }
  if (!extendedKeyUsages(extensions.get(EXT_KEY_USAGE)).includes(CODE_SIGNING)) {
    throw fail("must have Extended Key Usage codeSigning");
  }
  if (extensions.has(EXPO_PROJECT_INFORMATION)) {
    throw fail("must not carry Expo project information");
  }
  const key = await rsaKey(der, cert.spki);
  const { modulusLength: bits } = key.algorithm as { readonly modulusLength?: number };
  if (bits === undefined || bits < 2048 || bits > 4096)
    throw fail("must hold an RSA key of 2048 to 4096 bits");
  const signature = der.subarray(cert.signature.body, cert.signature.end);
  if (
    signature[0] !== 0 ||
    !(await crypto.subtle.verify(
      RSA,
      key,
      signature.slice(1),
      der.slice(cert.tbs.start, cert.tbs.end),
    ))
  ) {
    throw fail("has a self-signature that does not verify");
  }
  return { key, sha256: hexOf(new Uint8Array(await crypto.subtle.digest("SHA-256", der))) };
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

const SEQUENCE = 0x30;
const INTEGER = 0x02;
const BIT_STRING = 0x03;
const OCTET_STRING = 0x04;
const OID = 0x06;
const BOOLEAN = 0x01;
const VERSION = 0xa0;
const EXTENSIONS = 0xa3;
const V3 = new Uint8Array([VERSION, 3, INTEGER, 1, 2]);
const NULL = new Uint8Array([0x05, 0]);
// serial, signature, issuer, validity, subject, subjectPublicKeyInfo
const TBS_TAGS = [INTEGER, SEQUENCE, SEQUENCE, SEQUENCE, SEQUENCE, SEQUENCE];
// issuerUniqueID, subjectUniqueID, extensions: each optional, in this order.
const TBS_TAIL = [0x81, 0x82, EXTENSIONS];

interface Tlv {
  readonly tag: number;
  readonly start: number;
  readonly body: number;
  readonly end: number;
}

interface Certificate {
  readonly tbs: Tlv;
  readonly version: Tlv | undefined;
  readonly innerAlgorithm: Tlv;
  readonly issuer: Tlv;
  readonly validity: Tlv;
  readonly subject: Tlv;
  readonly spki: Tlv;
  readonly extensions: Tlv | undefined;
  readonly outerAlgorithm: Tlv;
  readonly signature: Tlv;
}

/** Returns the fields of an X.509 certificate's DER. */
function parseCertificate(der: Uint8Array<ArrayBuffer>): Certificate {
  const cert = readTlv(der, 0, der.length);
  if (cert.end !== der.length) throw new ProtocolError("certificate", "has bytes after the DER");
  const envelope = sequence(der, cert);
  const [tbsTlv, outerAlgorithm, signature] = envelope;
  if (
    !hasTags(envelope, [SEQUENCE, SEQUENCE, BIT_STRING]) ||
    envelope.length !== 3 ||
    tbsTlv === undefined ||
    outerAlgorithm === undefined ||
    signature === undefined
  ) {
    throw new ProtocolError(
      "certificate",
      "must be exactly SEQUENCE { tbs, algorithm, signature }",
    );
  }
  const tbs = sequence(der, tbsTlv);
  const version = tbs[0]?.tag === VERSION ? tbs[0] : undefined;
  const fields = version === undefined ? tbs : tbs.slice(1);
  const [, innerAlgorithm, issuer, validity, subject, spki] = fields;
  const tail = fields.slice(6).map((f) => f.tag);
  if (
    innerAlgorithm === undefined ||
    issuer === undefined ||
    validity === undefined ||
    subject === undefined ||
    spki === undefined ||
    !hasTags(fields, TBS_TAGS) ||
    tail.some((tag, i) => TBS_TAIL.indexOf(tag) <= TBS_TAIL.indexOf(tail[i - 1] ?? -1))
  ) {
    throw new ProtocolError("certificate", "has a malformed TBSCertificate");
  }
  return {
    tbs: tbsTlv,
    version,
    innerAlgorithm,
    issuer,
    validity,
    subject,
    spki,
    extensions: fields.slice(6).find((f) => f.tag === EXTENSIONS),
    outerAlgorithm,
    signature,
  };
}

/** Imports the SubjectPublicKeyInfo at `spki` as an RSASSA-PKCS1-v1_5 SHA-256 verify key. */
async function rsaKey(der: Uint8Array<ArrayBuffer>, spki: Tlv): Promise<CryptoKey> {
  try {
    return await crypto.subtle.importKey("spki", der.slice(spki.start, spki.end), RSA, false, [
      "verify",
    ]);
  } catch {
    throw new ProtocolError("certificate", "must hold an RSA public key");
  }
}

/** Returns each extension's value (the DER inside its OCTET STRING) by dotted OID; a repeated OID is refused. */
function extensionsOf(der: Uint8Array, wrapper: Tlv | undefined): Map<string, Uint8Array> {
  const out = new Map<string, Uint8Array>();
  if (wrapper === undefined) return out;
  const malformed = () => new ProtocolError("certificate", "has a malformed extension");
  const inner = readTlv(der, wrapper.body, wrapper.end);
  if (inner.end !== wrapper.end) throw malformed();
  for (const extension of sequence(der, inner)) {
    const items = sequence(der, extension);
    const [id, second, third] = items;
    const value = items.length === 3 ? third : second;
    if (
      id?.tag !== OID ||
      value?.tag !== OCTET_STRING ||
      items.length > 3 ||
      (items.length === 3 && second?.tag !== BOOLEAN)
    ) {
      throw malformed();
    }
    const name = oid(der, id);
    // RFC 5280 4.2: a certificate must not include more than one instance of an extension.
    if (out.has(name)) throw new ProtocolError("certificate", "repeats an extension");
    out.set(name, der.subarray(value.body, value.end));
  }
  return out;
}

/** True when a Key Usage value asserts digitalSignature, bit 0: the top bit after the unused-bit count. */
function digitalSignature(value: Uint8Array | undefined): boolean {
  if (value === undefined) return false;
  const bits = readTlv(value, 0, value.length);
  return (
    bits.tag === BIT_STRING &&
    bits.end === value.length &&
    bits.end - bits.body >= 2 &&
    ((value[bits.body + 1] ?? 0) & 0x80) !== 0
  );
}

/** Returns the OIDs in an Extended Key Usage value, or none when it is absent. */
function extendedKeyUsages(value: Uint8Array | undefined): string[] {
  if (value === undefined) return [];
  const outer = readTlv(value, 0, value.length);
  if (outer.end !== value.length)
    throw new ProtocolError("certificate", "has a malformed extension");
  return sequence(value, outer).map((t) => (t.tag === OID ? oid(value, t) : ""));
}

/** Returns the dotted form of the OBJECT IDENTIFIER at `tlv`. */
function oid(der: Uint8Array, tlv: Tlv): string {
  const arcs: number[] = [];
  let arc = 0;
  for (let at = tlv.body; at < tlv.end; at++) {
    const byte = der[at] ?? 0;
    if (arc === 0 && byte === 0x80) throw new ProtocolError("certificate", "has a malformed OID");
    arc = arc * 128 + (byte & 0x7f);
    if (arc > Number.MAX_SAFE_INTEGER / 128) {
      throw new ProtocolError("certificate", "has a malformed OID");
    }
    if ((byte & 0x80) === 0) {
      arcs.push(arc);
      arc = 0;
    }
  }
  const [first] = arcs;
  if (first === undefined || arc !== 0)
    throw new ProtocolError("certificate", "has a malformed OID");
  const top = Math.min(2, Math.floor(first / 40));
  return [top, first - top * 40, ...arcs.slice(1)].join(".");
}

/** Returns a UTCTime or GeneralizedTime in `Z` form as epoch milliseconds, or undefined. */
function time(der: Uint8Array, tlv: Tlv): number | undefined {
  const text = String.fromCharCode(...der.subarray(tlv.body, tlv.end));
  const m =
    tlv.tag === 0x17
      ? /^(\d\d)(\d\d)(\d\d)(\d\d)(\d\d)(\d\d)Z$/.exec(text)
      : tlv.tag === 0x18
        ? /^(\d{4})(\d\d)(\d\d)(\d\d)(\d\d)(\d\d)Z$/.exec(text)
        : null;
  if (m === null) return undefined;
  const [y, mo, d, h, mi, s] = m.slice(1).map(Number) as [
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  // RFC 5280 4.1.2.5.1: a two-digit year of 50 or more is 19YY.
  const year = tlv.tag === 0x17 ? (y >= 50 ? 1900 : 2000) + y : y;
  const date = new Date(Date.UTC(year, mo - 1, d, h, mi, s));
  const same =
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === mo - 1 &&
    date.getUTCDate() === d &&
    date.getUTCHours() === h &&
    date.getUTCMinutes() === mi &&
    date.getUTCSeconds() === s;
  return same ? date.getTime() : undefined;
}

/** True when the TLV at `tlv` is exactly `bytes`. */
function equal(der: Uint8Array, tlv: Tlv, bytes: Uint8Array): boolean {
  const own = der.subarray(tlv.start, tlv.end);
  return own.length === bytes.length && own.every((b, i) => b === bytes[i]);
}

const hexOf = (bytes: Uint8Array) =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

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
