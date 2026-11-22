// Shared by the tests and the fixture generator; Web APIs only, so it also runs on workerd.
import type {
  Identities,
  NoUpdateReply,
  Part,
  PartName,
  Rollout,
  Signer,
  StoredReply,
} from "../src/index.ts";
import { base64 } from "../src/hash.ts";
import {
  encodeIdentityNoUpdate,
  encodeMultipart,
  encodeRollout,
  encodeSfvDictionary,
  encodeStoredReply,
  expoSignature,
} from "../src/index.ts";

export const BOUNDARY = "tide_fixture_boundary";
/** The rollout new side's boundary, so a reply carrying the wrong side's content-type fails. */
const NEXT_BOUNDARY = "tide_fixture_next";
/** The second identity's boundary, so a reply carrying another identity's content-type fails. */
const SECOND_BOUNDARY = "tide_fixture_second";

interface GoldenPart {
  readonly name: PartName;
  readonly file: string;
  readonly signed?: true;
}

/** A multipart golden: the boundary it is framed with and its parts. */
interface Golden {
  readonly boundary: string;
  readonly parts: readonly GoldenPart[];
}

/** Tide's multipart goldens, signed by the generator with keyid `main` over `certificate.pem`. */
export const TIDE_GOLDEN: Readonly<Record<string, Golden>> = {
  "manifest.multipart": {
    boundary: BOUNDARY,
    parts: [
      { name: "manifest", file: "manifest.json", signed: true },
      { name: "extensions", file: "extensions.json" },
    ],
  },
  "manifest-next.multipart": {
    boundary: NEXT_BOUNDARY,
    parts: [{ name: "manifest", file: "manifest-next.json", signed: true }],
  },
  "rollback.multipart": {
    boundary: BOUNDARY,
    parts: [{ name: "directive", file: "directive-rollback.json", signed: true }],
  },
  "no-update.multipart": {
    boundary: BOUNDARY,
    parts: [{ name: "directive", file: "directive-no-update.json", signed: true }],
  },
};

/** A second direct identity's goldens, signed by the generator with keyid `root` over `second-certificate.pem`. */
export const SECOND_GOLDEN: Readonly<Record<string, Golden>> = {
  "second-no-update.multipart": {
    boundary: SECOND_BOUNDARY,
    parts: [{ name: "directive", file: "directive-no-update.json", signed: true }],
  },
};

/** expo-updates' chain-mode vector: Expo's signature, keyid defaulting to `root`, verified by the chain's leaf. */
export const EXPO_GOLDEN: Readonly<Record<string, Golden>> = {
  "expo.multipart": {
    boundary: BOUNDARY,
    parts: [
      { name: "directive", file: "expo-directive.json", signed: true },
      { name: "certificate_chain", file: "expo-chain.pem" },
    ],
  },
};

/** A chain-mode golden: signed by `signer` from `chainFixtures`, with `keyId` (absent: no keyid member). */
interface ChainGolden extends Golden {
  readonly signer: "leaf" | "shortLeaf";
  readonly keyId: string | undefined;
}

/** Tide's chain-mode goldens; `rotated` is no metadata keyid, since chain mode never compares it. */
export const CHAIN_GOLDEN: Readonly<Record<string, ChainGolden>> = {
  "chain.multipart": {
    boundary: BOUNDARY,
    signer: "leaf",
    keyId: "rotated",
    parts: [
      { name: "manifest", file: "manifest.json", signed: true },
      { name: "certificate_chain", file: "chain-served.pem" },
    ],
  },
  "chain-short.multipart": {
    boundary: BOUNDARY,
    signer: "shortLeaf",
    keyId: undefined,
    parts: [
      { name: "directive", file: "directive-no-update.json", signed: true },
      { name: "certificate_chain", file: "chain-short-leaf.pem" },
    ],
  },
};

/** Returns the parts of a golden, with each signed part's signature from `signature`. */
export async function goldenParts(
  parts: readonly GoldenPart[],
  read: (file: string) => Uint8Array<ArrayBuffer>,
  signature: (body: Uint8Array<ArrayBuffer>, index: number) => Promise<string> | string,
): Promise<Part[]> {
  return Promise.all(
    parts.map(async ({ name, file, signed }, i) => {
      const body = read(file);
      return signed ? { name, body, signature: await signature(body, i) } : { name, body };
    }),
  );
}

/** Returns each golden's bytes (Tide's by default), signed by `signer`. */
export async function signedFixtures(
  read: (file: string) => Uint8Array<ArrayBuffer>,
  signer: Signer,
  goldens: Readonly<Record<string, Golden>> = TIDE_GOLDEN,
): Promise<Record<string, Uint8Array<ArrayBuffer>>> {
  const out: Record<string, Uint8Array<ArrayBuffer>> = {};
  for (const [file, { boundary, parts }] of Object.entries(goldens)) {
    const signed = await goldenParts(parts, read, (body) => expoSignature(body, signer));
    out[file] = encodeMultipart(signed, boundary).body;
  }
  return out;
}

type Fields<R> = R extends unknown ? Omit<R, "body"> : never;

/** Each stored reply golden: the multipart it wraps and its other fields, as the publisher derives them. */
export const TIDE_REPLY_GOLDEN: Readonly<
  Record<string, { readonly multipart: string; readonly reply: Fields<StoredReply> }>
> = {
  "manifest.reply.json": {
    multipart: "manifest.multipart",
    reply: {
      kind: "manifest",
      updateId: "0f6a9a3e-6c1b-4c4e-9d55-2b8f3f7c1a90", // manifest.json's id
      boundary: BOUNDARY,
      manifestFilters: 'branch="main"', // manifest.json's metadata
    },
  },
  "manifest-next.reply.json": {
    multipart: "manifest-next.multipart",
    reply: {
      kind: "manifest",
      updateId: "3b1d7c52-9e4a-4f08-a6c3-71d2e5b98f14", // manifest-next.json's id
      boundary: NEXT_BOUNDARY,
      manifestFilters: 'branch="next"', // manifest-next.json's metadata
    },
  },
  "rollback.reply.json": {
    multipart: "rollback.multipart",
    reply: { kind: "rollBackToEmbedded", boundary: BOUNDARY },
  },
  "no-update.reply.json": {
    multipart: "no-update.multipart",
    reply: { kind: "noUpdateAvailable", boundary: BOUNDARY },
  },
};

/** The second identity's replies, by name: the multipart each wraps and its other fields. */
const SECOND_REPLY: Readonly<
  Record<string, { readonly multipart: string; readonly reply: Fields<StoredReply> }>
> = {
  "second-no-update": {
    multipart: "second-no-update.multipart",
    reply: { kind: "noUpdateAvailable", boundary: SECOND_BOUNDARY },
  },
};

/** Each rollout golden: its percentage and the reply goldens on each side; no earlier golden means no-update. */
export const TIDE_ROLLOUT_GOLDEN: Readonly<
  Record<string, { readonly percent: number; readonly earlier: string | undefined }>
> = {
  "rollout-manifest.reply.json": { percent: 12.5, earlier: "manifest.reply.json" },
  "rollout-rollback.reply.json": { percent: 50, earlier: "rollback.reply.json" },
  "rollout-none.reply.json": { percent: 0.01, earlier: undefined },
};
/** Every rollout golden's new side. */
export const ROLLOUT_NEW = "manifest-next.reply.json";
// Client IDs whose buckets in the rollout of manifest-next.json's id are pinned: 941 and 8977 of 10,000.
export const CLIENT_LOW = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
export const CLIENT_HIGH = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

type Read = (file: string) => Uint8Array<ArrayBuffer>;

/** The version-3 `reply/no-update` golden: by keyid, the reply golden or second-identity reply it holds. */
export const TIDE_IDENTITIES_GOLDEN = {
  file: "identities-no-update.reply.json",
  entries: { main: "no-update.reply.json", root: "second-no-update" },
} as const;

/** Returns the reply golden or second-identity reply `file`'s fields with the body `read` returns for its multipart. */
export function goldenReply(file: string, read: Read): StoredReply {
  const golden = TIDE_REPLY_GOLDEN[file] ?? SECOND_REPLY[file];
  if (golden === undefined) throw new Error(`${file} is not a reply golden`);
  return { ...golden.reply, body: read(golden.multipart) };
}

/** Returns the rollout golden `file`'s fields, its sides built from the reply goldens. */
export function goldenRollout(file: string, read: Read): Rollout {
  const golden = TIDE_ROLLOUT_GOLDEN[file];
  if (golden === undefined) throw new Error(`${file} is not a rollout golden`);
  const side = (name: string) => goldenReply(name, read) as Rollout["earlier"];
  return {
    kind: "rollout",
    percent: golden.percent,
    new: side(ROLLOUT_NEW) as Rollout["new"],
    earlier: golden.earlier === undefined ? undefined : side(golden.earlier),
  };
}

/** Returns the version-3 golden's entries, each built from the golden it names. */
export function goldenIdentities(read: Read): Identities {
  const entries = Object.entries(TIDE_IDENTITIES_GOLDEN.entries).map(
    ([k, name]) => [k, goldenReply(name, read) as NoUpdateReply] as const,
  );
  return { kind: "identities", entries: new Map(entries) };
}

/** Returns each stored reply, rollout and version-3 golden's bytes, wrapping the multiparts `read` returns. */
export function replyGoldens(read: Read): Record<string, Uint8Array<ArrayBuffer>> {
  const out: Record<string, Uint8Array<ArrayBuffer>> = {};
  for (const file of Object.keys(TIDE_REPLY_GOLDEN))
    out[file] = encodeStoredReply(goldenReply(file, read));
  for (const file of Object.keys(TIDE_ROLLOUT_GOLDEN))
    out[file] = encodeRollout(goldenRollout(file, read));
  out[TIDE_IDENTITIES_GOLDEN.file] = encodeIdentityNoUpdate(goldenIdentities(read).entries);
  return out;
}

export const RSA_SHA256 = {
  name: "RSASSA-PKCS1-v1_5",
  modulusLength: 2048,
  publicExponent: new Uint8Array([1, 0, 1]),
  hash: "SHA-256",
} as const;

const hexBytes = (hex: string) => Uint8Array.from(hex.match(/../g) ?? [], (h) => parseInt(h, 16));

/** Returns one DER TLV with a minimal definite length. */
function der(tag: number, ...contents: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const length = contents.reduce((n, c) => n + c.length, 0);
  const lengthBytes: number[] = [];
  for (let n = length; n > 0; n = Math.floor(n / 256)) lengthBytes.unshift(n % 256);
  const head = length < 0x80 ? [length] : [0x80 | lengthBytes.length, ...lengthBytes];
  const out = new Uint8Array(1 + head.length + length);
  out.set([tag, ...head]);
  let at = 1 + head.length;
  for (const c of contents) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

const SEQUENCE = 0x30;
/** Signature AlgorithmIdentifiers a test certificate can name. */
export const ALGORITHM = {
  sha256WithRsa: der(SEQUENCE, hexBytes("06092a864886f70d01010b0500")),
  sha256WithRsaNoParameters: der(SEQUENCE, hexBytes("06092a864886f70d01010b")),
  sha384WithRsa: der(SEQUENCE, hexBytes("06092a864886f70d01010c0500")),
} as const;
const name = (cn: string) =>
  der(
    SEQUENCE,
    der(0x31, der(SEQUENCE, hexBytes("0603550403"), der(0x0c, new TextEncoder().encode(cn)))),
  );
const hexExtension = (oid: string, critical: boolean, value: Uint8Array) =>
  der(SEQUENCE, hexBytes(oid), ...(critical ? [hexBytes("0101ff")] : []), der(0x04, value));
const keyUsage = (bits: string) => hexExtension("0603551d0f", true, der(0x03, hexBytes(bits)));
/** Expo project information holding `text` as a UTF8String. */
const project = (text: string) =>
  hexExtension(
    "061e2a864886f71401be40937a82d32d817e810066811d83e1ea75819f570201",
    false,
    der(0x0c, new TextEncoder().encode(text)),
  );

/** Certificate extensions a test certificate can carry, each one DER `Extension`. */
export const EXTENSION = {
  /** Critical Key Usage with these BIT STRING contents (unused-bit count first), as hex. */
  keyUsage,
  digitalSignature: keyUsage("0780"),
  keyCertSignOnly: keyUsage("0204"),
  digitalSignatureUnusedBits8: keyUsage("0880"),
  codeSigning: der(SEQUENCE, hexBytes("0603551d250101ff040c300a06082b06010505070303")), // extKeyUsage critical
  serverAuthOnly: der(SEQUENCE, hexBytes("0603551d25040c300a06082b06010505070301")),
  codeSigningAndBoolean: der(
    SEQUENCE,
    hexBytes("0603551d250101ff040f300d06082b060105050703030101ff"),
  ),
  project,
  projectInformation: project("project,scope"),
  /** Basic Constraints cA, critical, with an optional pathLen of 0 to 127. */
  ca: (pathLen?: number) =>
    hexExtension(
      "0603551d13",
      true,
      der(
        SEQUENCE,
        hexBytes("0101ff"),
        ...(pathLen === undefined ? [] : [der(0x02, Uint8Array.of(pathLen))]),
      ),
    ),
  subjectKeyId: (id: Uint8Array) => hexExtension("0603551d0e", false, der(0x04, id)),
  authorityKeyId: (id: Uint8Array) =>
    hexExtension("0603551d23", false, der(SEQUENCE, der(0x80, id))),
  /** Authority Key Identifier in the issuer-and-serial form: a directoryName and serial 1. */
  authorityIssuerSerial: hexExtension(
    "0603551d23",
    false,
    der(SEQUENCE, der(0xa1, der(0xa4, name("Tide root"))), der(0x82, Uint8Array.of(1))),
  ),
  /** Noncritical name constraints permitting one DNS subtree. */
  nameConstraints: hexExtension(
    "0603551d1e",
    false,
    der(SEQUENCE, der(0xa0, der(SEQUENCE, der(0x82, new TextEncoder().encode("example.com"))))),
  ),
  /** A critical extension under OID 1.2.3.4. */
  unknownCritical: hexExtension("06032a0304", true, der(0x05)),
} as const;
// Expo's code-signing profile.
const CODE_SIGNING = [EXTENSION.digitalSignature, EXTENSION.codeSigning];

/** RFC 5280 4.1.2.5: UTCTime through 2049, GeneralizedTime from 2050. */
const time = (date: Date) => {
  const digits = date.toISOString().replace(/[-:T]|\.\d+/g, "");
  return date.getUTCFullYear() < 2050
    ? der(0x17, new TextEncoder().encode(digits.slice(2)))
    : der(0x18, new TextEncoder().encode(digits));
};

/** What a test certificate differs in; each default gives Expo's direct-signing profile. */
export interface CertificateOptions {
  readonly notBefore?: Date; // Default: `now`.
  readonly notAfter?: Date; // Default: the end of 2049.
  readonly v1?: true; // No version field and no extensions.
  readonly subject?: string | Uint8Array; // A common name, or a whole Name's DER. Default: `Tide test`.
  readonly issuer?: string | Uint8Array; // Default: `Tide test`.
  readonly serial?: Uint8Array; // The INTEGER's contents, as given. Default: 16 random octets, positive.
  readonly issuerUniqueId?: true; // A one-octet issuerUniqueID before the extensions.
  readonly outerAlgorithm?: Uint8Array;
  readonly innerAlgorithm?: Uint8Array;
  readonly extensions?: readonly Uint8Array[];
}

/**
 * Returns a PEM X.509 code-signing certificate for `subject` signed by `issuer` with SHA-256. Self-signed when
 * `issuer` is `subject`'s private key.
 */
export async function certificate(
  subject: CryptoKey,
  issuer: CryptoKey,
  now: Date,
  options: CertificateOptions = {},
): Promise<string> {
  const random = crypto.getRandomValues(new Uint8Array(16));
  random[0] = 0x40 | ((random[0] ?? 0) & 0x3f); // Positive and minimal.
  const nameOf = (n: string | Uint8Array) => (typeof n === "string" ? name(n) : n);
  const tbs = der(
    SEQUENCE,
    ...(options.v1 ? [] : [der(0xa0, der(0x02, new Uint8Array([2])))]),
    der(0x02, options.serial ?? random),
    options.innerAlgorithm ?? ALGORITHM.sha256WithRsa,
    nameOf(options.issuer ?? "Tide test"),
    der(
      SEQUENCE,
      time(options.notBefore ?? now),
      time(options.notAfter ?? new Date("2049-12-31T23:59:59Z")),
    ),
    nameOf(options.subject ?? "Tide test"),
    new Uint8Array(await crypto.subtle.exportKey("spki", subject)),
    ...(options.issuerUniqueId ? [der(0x81, Uint8Array.of(0, 1))] : []),
    ...(options.v1 ? [] : [der(0xa3, der(SEQUENCE, ...(options.extensions ?? CODE_SIGNING)))]),
  );
  const signature = new Uint8Array(await crypto.subtle.sign(RSA_SHA256, issuer, tbs));
  return pem(
    der(
      SEQUENCE,
      tbs,
      options.outerAlgorithm ?? ALGORITHM.sha256WithRsa,
      der(0x03, new Uint8Array([0]), signature),
    ),
  );
}

/** Returns `bytes` as a PEM block with 64-character lines. */
export function pem(bytes: Uint8Array, label = "CERTIFICATE"): string {
  const lines = base64(bytes).match(/.{1,64}/g) ?? [];
  return `-----BEGIN ${label}-----\n${lines.join("\n")}\n-----END ${label}-----\n`;
}

/** The chain goldens' validity window, so the tests verify them at a fixed instant inside it. */
export const CHAIN_VALIDITY = {
  notBefore: new Date("2026-11-01T00:00:00Z"),
  notAfter: new Date("2046-11-01T00:00:00Z"),
} as const;
/** The instant the chain tests verify at, strictly inside `CHAIN_VALIDITY`. */
export const CHAIN_NOW = new Date("2031-01-01T00:00:00Z");

/** Returns a key identifier for `key`: the first 20 octets of its SPKI's SHA-256. */
export async function keyId(key: CryptoKey): Promise<Uint8Array<ArrayBuffer>> {
  const spki = await crypto.subtle.exportKey("spki", key);
  return new Uint8Array(await crypto.subtle.digest("SHA-256", spki)).slice(0, 20);
}

interface KeyPair {
  readonly publicKey: CryptoKey;
  readonly privateKey: CryptoKey;
}

/** The keys behind the chain goldens. */
export interface ChainKeys {
  readonly root: KeyPair;
  readonly intermediate: KeyPair;
  readonly leaf: KeyPair;
  readonly shortLeaf: KeyPair;
}

/** Returns an expo-signature header over `body` by `key`, with `keyid` only when `keyId` is given. */
async function chainSignature(
  body: Uint8Array<ArrayBuffer>,
  key: CryptoKey,
  keyId: string | undefined,
): Promise<string> {
  const sig = base64(new Uint8Array(await crypto.subtle.sign(RSA_SHA256, key, body)));
  const alg = "rsa-v1_5-sha256";
  return encodeSfvDictionary(keyId === undefined ? { sig, alg } : { sig, keyid: keyId, alg });
}

/**
 * Returns the chain goldens from `keys`: a CA root (pathLen 1), an intermediate (pathLen 0) linked by key
 * identifiers, a leaf under it, a leaf directly under the root, and the multiparts in `CHAIN_GOLDEN`.
 */
export async function chainFixtures(
  read: Read,
  keys: ChainKeys,
): Promise<Record<string, Uint8Array<ArrayBuffer>>> {
  const [rootId, intermediateId] = [
    await keyId(keys.root.publicKey),
    await keyId(keys.intermediate.publicKey),
  ];
  const issue = (subject: KeyPair, issuer: KeyPair, options: CertificateOptions) =>
    certificate(subject.publicKey, issuer.privateKey, CHAIN_NOW, { ...CHAIN_VALIDITY, ...options });
  const pems = {
    "chain-root.pem": await issue(keys.root, keys.root, {
      subject: "Tide root",
      issuer: "Tide root",
      extensions: [EXTENSION.ca(1), EXTENSION.keyCertSignOnly, EXTENSION.subjectKeyId(rootId)],
    }),
    "chain-intermediate.pem": await issue(keys.intermediate, keys.root, {
      subject: "Tide intermediate",
      issuer: "Tide root",
      extensions: [
        EXTENSION.ca(0),
        EXTENSION.keyCertSignOnly,
        EXTENSION.subjectKeyId(intermediateId),
        EXTENSION.authorityKeyId(rootId),
      ],
    }),
    "chain-leaf.pem": await issue(keys.leaf, keys.intermediate, {
      subject: "Tide leaf",
      issuer: "Tide intermediate",
      extensions: [...CODE_SIGNING, EXTENSION.authorityKeyId(intermediateId)],
    }),
    "chain-short-leaf.pem": await issue(keys.shortLeaf, keys.root, {
      subject: "Tide short leaf",
      issuer: "Tide root",
    }),
  };
  const out: Record<string, Uint8Array<ArrayBuffer>> = {};
  // The certificate_chain part's body, leaf first.
  const served = pems["chain-leaf.pem"] + pems["chain-intermediate.pem"];
  for (const [file, text] of Object.entries({ ...pems, "chain-served.pem": served })) {
    out[file] = new TextEncoder().encode(text);
  }
  const own = (file: string) => out[file] ?? read(file);
  for (const [file, { boundary, parts, signer, keyId }] of Object.entries(CHAIN_GOLDEN)) {
    const key = keys[signer].privateKey;
    const signed = await goldenParts(parts, own, (body) => chainSignature(body, key, keyId));
    out[file] = encodeMultipart(signed, boundary).body;
  }
  return out;
}

/** `patch-known.bsdiff`: these control triples, diff and extra bytes; it applies to any base of 64 or more bytes. */
export const KNOWN_PATCH = {
  minBase: 64,
  newSize: 100,
  triples: [
    [16, 8, 10],
    [20, 4, -40], // A backward seek.
    [30, 0, 28], // Seeks to byte 64, the end of the shortest base.
    [0, 22, -64],
  ],
  diff: Uint8Array.from({ length: 66 }, (_, i) => (i * 37 + 11) & 0xff),
  extra: Uint8Array.from({ length: 34 }, (_, i) => (i * 53 + 7) & 0xff),
} as const;
