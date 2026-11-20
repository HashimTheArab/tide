// Shared by the tests and the fixture generator; Web APIs only, so it also runs on workerd.
import type { Part, PartName, Signer, StoredReply } from "../src/index.ts";
import { base64 } from "../src/hash.ts";
import { encodeMultipart, encodeStoredReply, expoSignature } from "../src/index.ts";

export const BOUNDARY = "tide_fixture_boundary";

interface GoldenPart {
  readonly name: PartName;
  readonly file: string;
  readonly signed?: true;
}

/** Tide's multipart goldens, signed by the generator with keyid `main` over `certificate.pem`. */
export const TIDE_GOLDEN: Readonly<Record<string, readonly GoldenPart[]>> = {
  "manifest.multipart": [
    { name: "manifest", file: "manifest.json", signed: true },
    { name: "extensions", file: "extensions.json" },
  ],
  "rollback.multipart": [{ name: "directive", file: "directive-rollback.json", signed: true }],
  "no-update.multipart": [{ name: "directive", file: "directive-no-update.json", signed: true }],
};

/** expo-updates' chain-mode vector: Expo's signature, keyid defaulting to `root`, verified by the chain's leaf. */
export const EXPO_GOLDEN: Readonly<Record<string, readonly GoldenPart[]>> = {
  "expo.multipart": [
    { name: "directive", file: "expo-directive.json", signed: true },
    { name: "certificate_chain", file: "expo-chain.pem" },
  ],
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

/** Returns each Tide golden's bytes, signed by `signer`. */
export async function signedFixtures(
  read: (file: string) => Uint8Array<ArrayBuffer>,
  signer: Signer,
): Promise<Record<string, Uint8Array<ArrayBuffer>>> {
  const out: Record<string, Uint8Array<ArrayBuffer>> = {};
  for (const [file, parts] of Object.entries(TIDE_GOLDEN)) {
    const signed = await goldenParts(parts, read, (body) => expoSignature(body, signer));
    out[file] = encodeMultipart(signed, BOUNDARY).body;
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
  "rollback.reply.json": {
    multipart: "rollback.multipart",
    reply: { kind: "rollBackToEmbedded", boundary: BOUNDARY },
  },
  "no-update.reply.json": {
    multipart: "no-update.multipart",
    reply: { kind: "noUpdateAvailable", boundary: BOUNDARY },
  },
};

/** Returns each stored reply golden's bytes, wrapping the multiparts `read` returns. */
export function replyGoldens(
  read: (file: string) => Uint8Array<ArrayBuffer>,
): Record<string, Uint8Array<ArrayBuffer>> {
  return Object.fromEntries(
    Object.entries(TIDE_REPLY_GOLDEN).map(([file, { multipart, reply }]) => [
      file,
      encodeStoredReply({ ...reply, body: read(multipart) }),
    ]),
  );
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
/** Certificate extensions a test certificate can carry, each one DER `Extension`. */
export const EXTENSION = {
  digitalSignature: der(SEQUENCE, hexBytes("0603551d0f0101ff040403020780")), // keyUsage critical
  keyCertSignOnly: der(SEQUENCE, hexBytes("0603551d0f0101ff040403020204")),
  digitalSignatureUnusedBits8: der(SEQUENCE, hexBytes("0603551d0f0101ff040403020880")),
  codeSigning: der(SEQUENCE, hexBytes("0603551d250101ff040c300a06082b06010505070303")), // extKeyUsage critical
  serverAuthOnly: der(SEQUENCE, hexBytes("0603551d25040c300a06082b06010505070301")),
  codeSigningAndBoolean: der(
    SEQUENCE,
    hexBytes("0603551d250101ff040f300d06082b060105050703030101ff"),
  ),
  // Expo's project information (1.2.840.113556.1.8000.2554.43437.254.128.102.157.7894389.20439.2.1).
  projectInformation: der(
    SEQUENCE,
    der(0x06, hexBytes("2a864886f71401be40937a82d32d817e810066811d83e1ea75819f570201")),
    der(0x04, der(0x0c, new TextEncoder().encode("project,scope"))),
  ),
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
  readonly issuer?: string; // Default: the subject's name, `Tide test`.
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
  const serial = crypto.getRandomValues(new Uint8Array(16));
  serial[0] = 0x40 | ((serial[0] ?? 0) & 0x3f); // Positive and minimal.
  const tbs = der(
    SEQUENCE,
    ...(options.v1 ? [] : [der(0xa0, der(0x02, new Uint8Array([2])))]),
    der(0x02, serial),
    options.innerAlgorithm ?? ALGORITHM.sha256WithRsa,
    name(options.issuer ?? "Tide test"),
    der(
      SEQUENCE,
      time(options.notBefore ?? now),
      time(options.notAfter ?? new Date("2049-12-31T23:59:59Z")),
    ),
    name("Tide test"),
    new Uint8Array(await crypto.subtle.exportKey("spki", subject)),
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
