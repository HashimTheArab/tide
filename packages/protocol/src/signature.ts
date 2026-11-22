import { ProtocolError, base64, decodeBase64, sha256Hex } from "./hash.ts";
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
  await verifySig(sig, bytes, key);
}

/** Checks `header` over `bytes` as a chain-mode client does: like `verifyExpoSignature`, with `keyid` ignored. */
export async function verifyChainedSignature(
  bytes: Uint8Array<ArrayBuffer>,
  header: string,
  leaf: CryptoKey,
): Promise<void> {
  checkKey(leaf, "public", "verify");
  await verifySig(parseExpoSignature(header).sig, bytes, leaf);
}

async function verifySig(
  sig: Uint8Array<ArrayBuffer>,
  bytes: Uint8Array<ArrayBuffer>,
  key: CryptoKey,
): Promise<void> {
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
const BASIC_CONSTRAINTS = "2.5.29.19";
const SUBJECT_KEY_ID = "2.5.29.14";
const AUTHORITY_KEY_ID = "2.5.29.35";
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
  const fail = (message: string) => new ProtocolError("certificate", message);
  const der = pemCertificateDer(pem, "*", fail);
  const { cert, key, notBefore, notAfter } = await checkedCertificate(der, fail);
  if (!equal(der, cert.issuer, bytesOf(der, cert.subject))) {
    throw fail("must be self-issued");
  }
  if (now.getTime() < notBefore) throw fail("is not valid yet");
  if (now.getTime() > notAfter) throw fail("has expired");
  const extensions = extensionsOf(der, cert.extensions);
  const value = (id: string) => {
    const ext = extensions.get(id);
    return ext && der.subarray(ext.value.body, ext.value.end);
  };
  if (!digitalSignature(value(KEY_USAGE))) {
    throw fail("must have Key Usage digitalSignature");
  }
  if (!extendedKeyUsages(value(EXT_KEY_USAGE)).includes(CODE_SIGNING)) {
    throw fail("must have Extended Key Usage codeSigning");
  }
  if (extensions.has(EXPO_PROJECT_INFORMATION)) {
    throw fail("must not carry Expo project information");
  }
  if (!(await signedBy(der, cert, key))) throw fail("has a self-signature that does not verify");
  return { key, sha256: await sha256Hex(der) };
}

/**
 * Returns the DER of `pem`, exactly one CERTIFICATE block with each delimiter alone on its line, as iOS decodes.
 * `lines` is `+` to refuse blank lines inside the block, which Android's PEM reader takes for the end of headers.
 */
function pemCertificateDer(
  pem: string,
  lines: "*" | "+",
  fail: (message: string) => ProtocolError,
): Uint8Array<ArrayBuffer> {
  const one = new RegExp(`^(?:[\\t\\n\\r ]*\\n)?${pemBlock(lines)}(?:\\r?\\n[\\t\\n\\r ]*)?$`);
  const block = one.exec(pem)?.[1];
  if (block === undefined) throw fail("must be exactly one PEM CERTIFICATE block");
  const der = decodeBase64(block.replace(/\r?\n/g, ""));
  if (der === undefined) throw fail("must be canonical base64");
  return der;
}

const pemBlock = (lines: "*" | "+") =>
  `-----BEGIN CERTIFICATE-----\\r?\\n((?:[A-Za-z0-9+/=]${lines}\\r?\\n)${lines})-----END CERTIFICATE-----`;

/** A certificate that passed the checks both profiles share, with its verify key and validity in epoch ms. */
interface CheckedCertificate {
  readonly cert: Certificate;
  readonly key: CryptoKey;
  readonly notBefore: number;
  readonly notAfter: number;
}

/** Checks X.509 v3, sha256WithRSAEncryption, a well-formed validity and an RSA key of 2048 to 4096 bits. */
async function checkedCertificate(
  der: Uint8Array<ArrayBuffer>,
  fail: (message: string) => ProtocolError,
): Promise<CheckedCertificate> {
  const cert = parseCertificate(der);
  if (cert.version === undefined || !equal(der, cert.version, V3)) {
    throw fail("must be X.509 v3");
  }
  if (!equal(der, cert.innerAlgorithm, bytesOf(der, cert.outerAlgorithm))) {
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
  const validity = sequence(der, cert.validity);
  const [notBefore, notAfter] = validity.map((t) => time(der, t));
  if (notBefore === undefined || notAfter === undefined || validity.length !== 2) {
    throw fail("has a malformed validity");
  }
  const key = await rsaKey(der, cert.spki);
  const { modulusLength: bits } = key.algorithm as { readonly modulusLength?: number };
  if (bits === undefined || bits < 2048 || bits > 4096) {
    throw fail("must hold an RSA key of 2048 to 4096 bits");
  }
  return { cert, key, notBefore, notAfter };
}

/** True when the signature of the certificate `der` verifies under `key`. */
async function signedBy(der: Uint8Array<ArrayBuffer>, cert: Certificate, key: CryptoKey) {
  const signature = der.subarray(cert.signature.body, cert.signature.end);
  return (
    signature[0] === 0 &&
    crypto.subtle.verify(RSA, key, signature.slice(1), der.slice(cert.tbs.start, cert.tbs.end))
  );
}

/** Largest `certificate_chain` part body Tide reads. */
export const MAX_CHAIN_BYTES = 32_768;
/** Most certificates a `certificate_chain` part may serve; the embedded root makes the chain one longer. */
export const MAX_CHAIN_CERTIFICATES = 8;

const CHAIN_GRAMMAR = "must be PEM CERTIFICATE blocks separated by single line ends";

/**
 * Returns the DER of each block of a `certificate_chain` part body, leaf first. Stricter than the client: the body
 * is ASCII and holds nothing but blocks, separated by one line end, with one optional trailing line end.
 */
function readCertificateChain(body: Uint8Array): Uint8Array<ArrayBuffer>[] {
  const fail = (message: string) => new ProtocolError("certificate_chain", message);
  if (body.length === 0 || body.length > MAX_CHAIN_BYTES) {
    throw fail(`must be 1 to ${MAX_CHAIN_BYTES} bytes`);
  }
  let text = "";
  for (const byte of body) {
    if (byte > 0x7f) throw fail(CHAIN_GRAMMAR);
    text += String.fromCharCode(byte);
  }
  const block = new RegExp(`${pemBlock("+")}(\\r?\\n)?`, "y");
  const ders: Uint8Array<ArrayBuffer>[] = [];
  while (block.lastIndex < text.length) {
    const m = block.exec(text);
    if (m === null || (m[2] === undefined && block.lastIndex !== text.length)) {
      throw fail(CHAIN_GRAMMAR);
    }
    if (ders.length === MAX_CHAIN_CERTIFICATES) {
      throw fail(`must serve 1 to ${MAX_CHAIN_CERTIFICATES} certificates`);
    }
    const der = decodeBase64((m[1] ?? "").replace(/\r?\n/g, ""));
    if (der === undefined) throw fail("must be canonical base64");
    ders.push(der);
  }
  return ders;
}

/**
 * Returns the leaf's verify key when the `certificate_chain` part body `served` (undefined: no part) followed by
 * `root` is a chain both expo-updates clients accept in chain mode at `now`, under Tide's stricter profile. `root`
 * is the PEM the app embeds and must come from trusted configuration; with nothing served it is also the leaf.
 */
export async function certificateChain(
  served: Uint8Array | undefined,
  root: string,
  now: Date,
): Promise<CryptoKey> {
  // A NaN instant would pass every validity comparison.
  if (Number.isNaN(now.getTime())) throw new ProtocolError("now", "must be a valid Date");
  const fail = (message: string) => new ProtocolError("certificate_chain", message);
  const ders = served === undefined ? [] : readCertificateChain(served);
  const rootDer = pemCertificateDer(root, "+", (message) => fail(`root ${message}`));
  const members: Member[] = [];
  for (const [i, der] of ders.entries()) {
    members.push(await chainMember(der, now, i === 0 ? "leaf" : `intermediate ${i}`));
  }
  const top = await chainMember(rootDer, now, "root");
  const leaf = members[0] ?? top;
  members.push(top);

  for (const [i, child] of members.entries()) {
    const issuer = members[i + 1];
    if (issuer === undefined) break;
    if (!same(child.issuer, issuer.subject)) {
      throw fail(`${child.role} is not issued by the certificate above it`);
    }
    if (!(await signedBy(child.der, child.cert, issuer.key))) {
      throw fail(`${child.role} has a signature that does not verify under its issuer's key`);
    }
    // Apple's trust evaluation links a child's authority key ID to its issuer's subject key ID.
    if (
      child.authorityKeyId &&
      issuer.subjectKeyId &&
      !same(child.authorityKeyId, issuer.subjectKeyId)
    ) {
      throw fail(`${child.role} names another authority key identifier than its issuer's`);
    }
  }
  for (const [i, m] of members.entries()) {
    if (members.some((o, j) => j > i && same(o.subject, m.subject))) {
      throw fail(`${m.role} has the subject of another certificate in the chain`);
    }
  }
  if (!same(top.issuer, top.subject)) throw fail("root must be self-issued");
  if (!(await signedBy(top.der, top.cert, top.key))) {
    throw fail("root has a self-signature that does not verify");
  }

  if (members.length > 1) {
    const isCa = (m: Member) => m.ca && hasKeyUsage(m.keyUsage, KEY_CERT_SIGN);
    if (!isCa(top)) throw fail("root must be a CA with Key Usage keyCertSign");
    let maxPathLen = top.pathLen;
    // Android's walk, from the intermediate under the root down to the one above the leaf.
    for (const m of members.slice(1, -1).reverse()) {
      if (!isCa(m)) throw fail(`${m.role} must be a CA with Key Usage keyCertSign`);
      if (maxPathLen <= 0) throw fail(`${m.role} exceeds the path length its issuers allow`);
      maxPathLen = Math.min(maxPathLen - 1, m.pathLen);
    }
  }
  if (!hasKeyUsage(leaf.keyUsage, DIGITAL_SIGNATURE)) {
    throw fail("leaf must have Key Usage digitalSignature");
  }
  if (!leaf.extendedKeyUsages.includes(CODE_SIGNING)) {
    throw fail("leaf must have Extended Key Usage codeSigning");
  }
  // The client makes every certificate below one with project information carry it too, then checks the leaf's
  // against the reply's EAS project, which Tide's replies never name. Checked last, so every client rule runs first.
  const carrier = members.find((m) => m.project);
  if (carrier) throw fail(`${carrier.role} must not carry Expo project information`);
  return leaf.key;
}

const DIGITAL_SIGNATURE = 0;
const KEY_CERT_SIGN = 5;

/** A chain member's fields that the chain rules read. */
interface Member {
  readonly role: string;
  readonly der: Uint8Array<ArrayBuffer>;
  readonly cert: Certificate;
  readonly issuer: Uint8Array;
  readonly subject: Uint8Array;
  readonly key: CryptoKey;
  readonly ca: boolean;
  readonly pathLen: number; // Infinity when absent.
  readonly keyUsage: KeyUsage | undefined;
  readonly extendedKeyUsages: readonly string[];
  readonly subjectKeyId: Uint8Array | undefined;
  readonly authorityKeyId: Uint8Array | undefined;
  readonly project: boolean; // Carries Expo project information.
}

/** Returns `der` as a chain member that passes Tide's chain profile at `now`; errors name the member's role. */
async function chainMember(der: Uint8Array<ArrayBuffer>, now: Date, role: string): Promise<Member> {
  try {
    return await member(der, now, role);
  } catch (e) {
    // The shared DER parser reports against `certificate`.
    if (e instanceof ProtocolError && e.field === "certificate") {
      throw new ProtocolError(
        "certificate_chain",
        `${role} ${e.message.slice(e.field.length + 1)}`,
      );
    }
    throw e;
  }
}

async function member(der: Uint8Array<ArrayBuffer>, now: Date, role: string): Promise<Member> {
  const fail = (message: string) => new ProtocolError("certificate_chain", `${role} ${message}`);
  const { cert, key, notBefore, notAfter } = await checkedCertificate(der, fail);
  // iOS finds the extensions by position, which a unique ID would shift.
  if (sequence(der, cert.tbs).length !== (cert.extensions === undefined ? 7 : 8)) {
    throw fail("must not carry a unique identifier");
  }
  const serial = der.subarray(cert.serial.body, cert.serial.end); // RFC 5280 4.1.2.2
  if (!minimalUnsigned(serial, 20) || (serial.length === 1 && serial[0] === 0)) {
    throw fail("must have a minimal positive serial number of 1 to 20 octets");
  }
  for (const field of ["issuer", "subject"] as const) {
    if (!validName(der, cert[field])) {
      throw fail(`must have a non-empty ${field} of single-attribute RDNs with string values`);
    }
  }
  // Android's bounds are inclusive and iOS's exclusive, so both accept only a strictly inner instant.
  if (now.getTime() <= notBefore) throw fail("is not valid yet");
  if (now.getTime() >= notAfter) throw fail("has expired");

  const extensions = chainExtensions(der, cert.extensions, fail);
  for (const [id, scope] of IOS_LOOKUPS) {
    const found = iosFindOid(der, scope === "tbs" ? cert.tbs : cert.extensions, id);
    if (found !== extensions.get(id)?.id.start) {
      throw fail("has a field that hides an extension from the iOS client");
    }
  }
  const value = (id: string) => {
    const ext = extensions.get(id);
    return ext && der.subarray(ext.value.body, ext.value.end);
  };
  const malformed = () => fail("has a malformed extension");
  const usage = value(KEY_USAGE);
  const ekus = value(EXT_KEY_USAGE);
  const usages = ekus === undefined ? [] : extendedKeyUsages(ekus);
  if (ekus !== undefined && usages.length === 0) throw malformed();
  const ski = value(SUBJECT_KEY_ID);
  const aki = value(AUTHORITY_KEY_ID);
  return {
    role,
    der,
    cert,
    issuer: bytesOf(der, cert.issuer),
    subject: bytesOf(der, cert.subject),
    key,
    ...basicConstraints(value(BASIC_CONSTRAINTS), malformed),
    keyUsage: usage === undefined ? undefined : keyUsage(usage, malformed),
    extendedKeyUsages: usages,
    subjectKeyId: ski === undefined ? undefined : subjectKeyId(ski, malformed),
    authorityKeyId: aki === undefined ? undefined : authorityKeyId(aki, malformed),
    project: extensions.has(EXPO_PROJECT_INFORMATION),
  };
}

/** True when `a` and `b` hold the same bytes. */
function same(a: Uint8Array, b: Uint8Array | undefined): boolean {
  return b !== undefined && a.length === b.length && a.every((x, i) => x === b[i]);
}

/** True for a minimal non-negative INTEGER body of 1 to `maxOctets` octets. */
function minimalUnsigned(body: Uint8Array, maxOctets: number): boolean {
  const [first = 0x80, second = 0] = body;
  return (
    body.length <= maxOctets &&
    (first & 0x80) === 0 &&
    !(first === 0 && body.length > 1 && (second & 0x80) === 0)
  );
}

const PRINTABLE = /^[A-Za-z0-9 '()+,\-./:=?]+$/;
const UTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** True for a non-empty Name whose RDNs each hold one attribute with a non-empty UTF8String or PrintableString. */
function validName(der: Uint8Array, name: Tlv): boolean {
  const rdns = sequence(der, name);
  return (
    rdns.length > 0 &&
    rdns.every((rdn) => {
      const set = rdn.tag === SET ? children(der, rdn) : [];
      const attribute = set.length === 1 && set[0]?.tag === SEQUENCE ? sequence(der, set[0]) : [];
      const [type, value] = attribute;
      if (attribute.length !== 2 || type?.tag !== OID || value === undefined) return false;
      oid(der, type); // Refuses a malformed OID.
      const text = der.subarray(value.body, value.end);
      if (text.length === 0) return false;
      if (value.tag === PRINTABLE_STRING) return PRINTABLE.test(String.fromCharCode(...text));
      if (value.tag !== UTF8_STRING) return false;
      try {
        UTF8.decode(text);
        return true;
      } catch {
        return false;
      }
    })
  );
}

// Each extension a chain member may carry, and whether it may be critical.
const CHAIN_EXTENSIONS: Readonly<Record<string, boolean>> = {
  [BASIC_CONSTRAINTS]: true,
  [KEY_USAGE]: true,
  [EXT_KEY_USAGE]: true,
  [SUBJECT_KEY_ID]: false,
  [AUTHORITY_KEY_ID]: false,
  [EXPO_PROJECT_INFORMATION]: false, // Refused by a later chain rule, after the client's rules.
};

/** Returns a chain member's extensions by dotted OID, refusing any outside `CHAIN_EXTENSIONS`. */
function chainExtensions(
  der: Uint8Array,
  wrapper: Tlv | undefined,
  fail: (message: string) => ProtocolError,
): Map<string, Extension> {
  const out = extensionsOf(der, wrapper);
  if (wrapper !== undefined && out.size === 0) throw fail("has a malformed extension");
  for (const [name, { critical }] of out) {
    // DER omits a FALSE critical flag.
    if (critical !== undefined && !equal(der, critical, TRUE)) {
      throw fail("has a malformed extension");
    }
    const mayBeCritical = CHAIN_EXTENSIONS[name];
    if (mayBeCritical === undefined) throw fail("has an extension Tide does not allow");
    if (critical !== undefined && !mayBeCritical) {
      throw fail("marks an extension critical that must not be");
    }
  }
  return out;
}

// What iOS reads through ASN1Decoder's `findOid`, and where it searches: the whole TBSCertificate or the extensions.
const IOS_LOOKUPS: readonly (readonly [string, "tbs" | "extensions"])[] = [
  [KEY_USAGE, "tbs"],
  [BASIC_CONSTRAINTS, "extensions"],
  [EXT_KEY_USAGE, "extensions"],
  [EXPO_PROJECT_INFORMATION, "extensions"],
];

/**
 * Returns the offset of the first OID equal to `target` in iOS's depth-first search under `parent`. iOS also reads
 * an OCTET STRING's contents as DER when they parse; contents only a lenient reader would parse are not searched.
 */
function iosFindOid(der: Uint8Array, parent: Tlv | undefined, target: string): number | undefined {
  if (parent === undefined) return undefined;
  for (const child of children(der, parent)) {
    if (child.tag === OID) {
      if (iosOid(der, child) === target) return child.start;
      continue;
    }
    if (child.tag === OCTET_STRING) {
      try {
        iosFindOid(der, child, ""); // No OID decodes to "", so this only parses the contents.
      } catch {
        continue;
      }
    } else if ((child.tag & 0x20) === 0) {
      continue;
    }
    const found = iosFindOid(der, child, target);
    if (found !== undefined) return found;
  }
  return undefined;
}

/** Returns the OID at `tlv` as iOS's ASN1Decoder prints it: lenient, with 64-bit arcs. */
function iosOid(der: Uint8Array, tlv: Tlv): string | undefined {
  if (tlv.body === tlv.end) return undefined;
  const first = der[tlv.body] ?? 0;
  let text = `${Math.floor(first / 40)}.${first % 40}`;
  let arc = 0n;
  for (let at = tlv.body + 1; at < tlv.end; at++) {
    const byte = der[at] ?? 0;
    arc = BigInt.asIntN(64, (arc << 7n) | BigInt(byte & 0x7f));
    if ((byte & 0x80) === 0) {
      text += `.${arc}`;
      arc = 0n;
    }
  }
  return text;
}

/**
 * Returns a Basic Constraints value (absent: not a CA): cA only as TRUE, and a minimal pathLen of 0 to 2^31-1 only
 * with cA. pathLen is Infinity when absent.
 */
function basicConstraints(
  value: Uint8Array | undefined,
  malformed: () => ProtocolError,
): { readonly ca: boolean; readonly pathLen: number } {
  if (value === undefined) return { ca: false, pathLen: Infinity };
  const outer = readTlv(value, 0, value.length);
  if (outer.end !== value.length) throw malformed();
  const items = sequence(value, outer);
  const [flag] = items;
  const ca = flag?.tag === BOOLEAN;
  if (flag !== undefined && ca && !equal(value, flag, TRUE)) throw malformed();
  const length = items[ca ? 1 : 0];
  if (items.length > (ca ? 2 : 0) || (length !== undefined && length.tag !== INTEGER)) {
    throw malformed();
  }
  if (length === undefined) return { ca, pathLen: Infinity };
  const body = value.subarray(length.body, length.end);
  if (!minimalUnsigned(body, 4)) throw malformed();
  return { ca, pathLen: body.reduce((n, b) => n * 256 + b, 0) };
}

/** A Key Usage BIT STRING: its declared bit count and content bytes. */
interface KeyUsage {
  readonly bits: number;
  readonly bytes: Uint8Array;
}

/** Returns a strict DER Key Usage value: unused count 0 to 7, 0 when empty, and zero padding bits. */
function keyUsage(value: Uint8Array, malformed: () => ProtocolError): KeyUsage {
  const tlv = readTlv(value, 0, value.length);
  if (tlv.tag !== BIT_STRING || tlv.end !== value.length || tlv.body === tlv.end) throw malformed();
  const unused = value[tlv.body] ?? 0;
  const bytes = value.subarray(tlv.body + 1, tlv.end);
  // iOS reads the first byte whole, so a set padding bit would count there and not on Android.
  if (
    unused > 7 ||
    (bytes.length === 0 && unused > 0) ||
    ((bytes.at(-1) ?? 0) & ((1 << unused) - 1)) !== 0
  ) {
    throw malformed();
  }
  return { bits: bytes.length * 8 - unused, bytes };
}

/** True when Key Usage bit `n` is declared and set. */
function hasKeyUsage(usage: KeyUsage | undefined, n: number): boolean {
  return (
    usage !== undefined && n < usage.bits && ((usage.bytes[n >> 3] ?? 0) & (0x80 >> (n & 7))) !== 0
  );
}

/** Returns a Subject Key Identifier: an OCTET STRING of 1 to 64 octets. */
function subjectKeyId(value: Uint8Array, malformed: () => ProtocolError): Uint8Array {
  const tlv = readTlv(value, 0, value.length);
  const length = tlv.end - tlv.body;
  if (tlv.tag !== OCTET_STRING || tlv.end !== value.length || length < 1 || length > 64) {
    throw malformed();
  }
  return value.subarray(tlv.body, tlv.end);
}

/** Returns an Authority Key Identifier's keyIdentifier; the issuer and serial form is refused. */
function authorityKeyId(value: Uint8Array, malformed: () => ProtocolError): Uint8Array {
  const outer = readTlv(value, 0, value.length);
  const items = outer.end === value.length ? sequence(value, outer) : [];
  const [id] = items;
  const length = id === undefined ? 0 : id.end - id.body;
  if (items.length !== 1 || id?.tag !== KEY_IDENTIFIER || length < 1 || length > 64) {
    throw malformed();
  }
  return value.subarray(id.body, id.end);
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
const SET = 0x31;
const UTF8_STRING = 0x0c;
const PRINTABLE_STRING = 0x13;
const KEY_IDENTIFIER = 0x80; // [0] IMPLICIT, primitive.
const VERSION = 0xa0;
const EXTENSIONS = 0xa3;
const V3 = new Uint8Array([VERSION, 3, INTEGER, 1, 2]);
const NULL = new Uint8Array([0x05, 0]);
// serial, signature, issuer, validity, subject, subjectPublicKeyInfo
const TBS_TAGS = [INTEGER, SEQUENCE, SEQUENCE, SEQUENCE, SEQUENCE, SEQUENCE];
// issuerUniqueID, subjectUniqueID, extensions: each optional, in this order.
const TBS_TAIL = [0x81, 0x82, EXTENSIONS];

export interface Tlv {
  readonly tag: number;
  readonly start: number;
  readonly body: number;
  readonly end: number;
}

interface Certificate {
  readonly tbs: Tlv;
  readonly version: Tlv | undefined;
  readonly serial: Tlv;
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
  const [serial, innerAlgorithm, issuer, validity, subject, spki] = fields;
  const tail = fields.slice(6).map((f) => f.tag);
  if (
    serial === undefined ||
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
    serial,
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

/** One extension: its OID, its critical flag when present, and the OCTET STRING holding its value. */
interface Extension {
  readonly id: Tlv;
  readonly critical: Tlv | undefined;
  readonly value: Tlv;
}

/** Returns each extension by dotted OID; a repeated OID is refused. */
function extensionsOf(der: Uint8Array, wrapper: Tlv | undefined): Map<string, Extension> {
  const out = new Map<string, Extension>();
  if (wrapper === undefined) return out;
  const malformed = () => new ProtocolError("certificate", "has a malformed extension");
  const inner = readTlv(der, wrapper.body, wrapper.end);
  if (inner.end !== wrapper.end) throw malformed();
  for (const extension of sequence(der, inner)) {
    const items = sequence(der, extension);
    const [id, second, third] = items;
    const critical = items.length === 3 ? second : undefined;
    const value = items.length === 3 ? third : second;
    if (
      id?.tag !== OID ||
      value?.tag !== OCTET_STRING ||
      items.length > 3 ||
      (critical !== undefined && critical.tag !== BOOLEAN)
    ) {
      throw malformed();
    }
    const name = oid(der, id);
    // RFC 5280 4.2: a certificate must not include more than one instance of an extension.
    if (out.has(name)) throw new ProtocolError("certificate", "repeats an extension");
    out.set(name, { id, critical, value });
  }
  return out;
}

/** True when a Key Usage value asserts digitalSignature, bit 0: the top bit after the unused-bit count. */
function digitalSignature(value: Uint8Array | undefined): boolean {
  if (value === undefined) return false;
  const bits = readTlv(value, 0, value.length);
  // Apple's parser refuses the whole certificate for an unused-bit count over 7.
  if (bits.tag === BIT_STRING && (value[bits.body] ?? 0) > 7) {
    throw new ProtocolError("certificate", "has a malformed extension");
  }
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
  // Apple's parser refuses the whole certificate for any entry that is not an OID.
  return sequence(value, outer).map((t) => {
    if (t.tag !== OID) throw new ProtocolError("certificate", "has a malformed extension");
    return oid(value, t);
  });
}

/** Returns the dotted form of the OBJECT IDENTIFIER at `tlv`. */
export function oid(der: Uint8Array, tlv: Tlv): string {
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
export function time(der: Uint8Array, tlv: Tlv): number | undefined {
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
  return same(bytesOf(der, tlv), bytes);
}

/** Returns the whole TLV at `tlv`, header included. */
const bytesOf = (der: Uint8Array, tlv: Tlv) => der.subarray(tlv.start, tlv.end);

/** Returns the TLVs that exactly fill SEQUENCE `parent`. */
function sequence(der: Uint8Array, parent: Tlv | undefined): Tlv[] {
  if (parent?.tag !== SEQUENCE) throw new ProtocolError("certificate", "expected a DER SEQUENCE");
  return children(der, parent);
}

/** Returns the TLVs that exactly fill the contents of `parent`. */
function children(der: Uint8Array, parent: Tlv): Tlv[] {
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
export function readTlv(der: Uint8Array, start: number, limit: number): Tlv {
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

/** What a self-signed direct-signing certificate names; each date is whole seconds from 1950 through 9999. */
export interface SelfSignedFields {
  readonly spki: Uint8Array; // SubjectPublicKeyInfo DER, embedded as given.
  readonly commonName: string; // The subject's and issuer's only attribute.
  readonly notBefore: Date;
  readonly notAfter: Date;
}

const COMMON_NAME = "2.5.4.3";
const TRUE = new Uint8Array([BOOLEAN, 1, 0xff]);
const DIGITAL_SIGNATURE_ONLY = new Uint8Array([BIT_STRING, 2, 7, 0x80]);

/**
 * Returns the PEM of a v3 certificate whose TBSCertificate `sign` signs with RSASSA-PKCS1-v1_5 SHA-256; its only
 * extensions are critical Key Usage digitalSignature and Extended Key Usage codeSigning.
 */
export async function selfSignedCertificate(
  { spki, commonName, notBefore, notAfter }: SelfSignedFields,
  sign: Signer["sign"],
): Promise<string> {
  const algorithm = derTlv(SEQUENCE, derOid(SHA256_WITH_RSA), NULL);
  const cn = new TextEncoder().encode(commonName);
  const name = derTlv(
    SEQUENCE,
    derTlv(SET, derTlv(SEQUENCE, derOid(COMMON_NAME), derTlv(UTF8_STRING, cn))),
  );
  const random = crypto.getRandomValues(new Uint8Array(16));
  random[0] = 0x40 | ((random[0] ?? 0) & 0x3f); // Positive, and 16 octets once minimal.
  const tbs = derTlv(
    SEQUENCE,
    V3,
    derTlv(INTEGER, random),
    algorithm,
    name, // Issuer, the same bytes as the subject.
    derTlv(SEQUENCE, derTime(notBefore), derTime(notAfter)),
    name,
    spki,
    derTlv(
      EXTENSIONS,
      derTlv(
        SEQUENCE,
        derTlv(SEQUENCE, derOid(KEY_USAGE), TRUE, derTlv(OCTET_STRING, DIGITAL_SIGNATURE_ONLY)),
        derTlv(
          SEQUENCE,
          derOid(EXT_KEY_USAGE),
          derTlv(OCTET_STRING, derTlv(SEQUENCE, derOid(CODE_SIGNING))),
        ),
      ),
    ),
  );
  const signature = await sign(tbs);
  const der = derTlv(SEQUENCE, tbs, algorithm, derTlv(BIT_STRING, new Uint8Array([0]), signature));
  const lines = base64(der).match(/.{1,64}/g) ?? [];
  return `-----BEGIN CERTIFICATE-----\n${lines.join("\n")}\n-----END CERTIFICATE-----\n`;
}

/** Returns one DER TLV with a minimal definite length, as `readTlv` reads; `tag` must have a low tag number. */
export function derTlv(tag: number, ...contents: readonly Uint8Array[]): Uint8Array<ArrayBuffer> {
  const length = contents.reduce((n, c) => n + c.length, 0);
  const octets: number[] = [];
  for (let n = length; n > 0; n = Math.floor(n / 256)) octets.unshift(n % 256);
  const head = [tag, ...(length < 0x80 ? [length] : [0x80 | octets.length, ...octets])];
  const out = new Uint8Array(head.length + length);
  out.set(head);
  let at = head.length;
  for (const c of contents) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

/** Returns the dotted OID `dotted`, which the caller keeps valid, as a DER OBJECT IDENTIFIER. */
export function derOid(dotted: string): Uint8Array<ArrayBuffer> {
  const [top = 0, second = 0, ...rest] = dotted.split(".").map(Number);
  const bytes: number[] = [];
  for (const arc of [top * 40 + second, ...rest]) {
    const group = [arc % 128];
    for (let n = Math.floor(arc / 128); n > 0; n = Math.floor(n / 128)) {
      group.unshift(0x80 | (n % 128));
    }
    bytes.push(...group);
  }
  return derTlv(OID, new Uint8Array(bytes));
}

/** Returns `date` in `Z` form as RFC 5280 requires: UTCTime through 2049, GeneralizedTime from 2050. */
export function derTime(date: Date): Uint8Array<ArrayBuffer> {
  const year = date.getUTCFullYear();
  if (
    !Number.isFinite(date.getTime()) ||
    date.getTime() % 1000 !== 0 ||
    year < 1950 ||
    year > 9999
  ) {
    throw new ProtocolError("certificate", "time must be whole seconds from 1950 through 9999");
  }
  const digits = new TextEncoder().encode(date.toISOString().replace(/[-:T]|\.\d+/g, ""));
  return year < 2050 ? derTlv(0x17, digits.subarray(2)) : derTlv(0x18, digits);
}
