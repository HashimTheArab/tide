// Shared by the tests and the fixture generator; Web APIs only, so it also runs on workerd.
import type { Part, PartName, Signer } from "../src/index.ts";
import { base64 } from "../src/hash.ts";
import { encodeMultipart, expoSignature } from "../src/index.ts";

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
const SHA256_WITH_RSA = der(SEQUENCE, hexBytes("06092a864886f70d01010b0500"));
const NAME = der(
  SEQUENCE,
  der(
    0x31,
    der(SEQUENCE, hexBytes("0603550403"), der(0x0c, new TextEncoder().encode("Tide test"))),
  ),
);
// keyUsage critical digitalSignature; extKeyUsage critical codeSigning: Expo's code-signing profile.
const EXTENSIONS = der(
  0xa3,
  der(
    SEQUENCE,
    der(SEQUENCE, hexBytes("0603551d0f0101ff040403020780")),
    der(SEQUENCE, hexBytes("0603551d250101ff040c300a06082b06010505070303")),
  ),
);

/** UTCTime, which RFC 5280 allows through 2049. */
const utcTime = (date: Date) =>
  der(0x17, new TextEncoder().encode(date.toISOString().replace(/^\d\d|[-:T]|\.\d+/g, "")));
const NOT_AFTER = new Date("2049-12-31T23:59:59Z");

/**
 * Returns a PEM X.509 code-signing certificate for `subject` signed by `issuer`, valid from `now` through 2049.
 * Self-signed when `issuer` is `subject`'s private key.
 */
export async function certificate(
  subject: CryptoKey,
  issuer: CryptoKey,
  now: Date,
): Promise<string> {
  const serial = crypto.getRandomValues(new Uint8Array(16));
  serial[0] = 0x40 | ((serial[0] ?? 0) & 0x3f); // Positive and minimal.
  const tbs = der(
    SEQUENCE,
    der(0xa0, der(0x02, new Uint8Array([2]))),
    der(0x02, serial),
    SHA256_WITH_RSA,
    NAME,
    der(SEQUENCE, utcTime(now), utcTime(NOT_AFTER)),
    NAME,
    new Uint8Array(await crypto.subtle.exportKey("spki", subject)),
    EXTENSIONS,
  );
  const signature = new Uint8Array(await crypto.subtle.sign(RSA_SHA256, issuer, tbs));
  return pem(der(SEQUENCE, tbs, SHA256_WITH_RSA, der(0x03, new Uint8Array([0]), signature)));
}

/** Returns `bytes` as a PEM CERTIFICATE block with 64-character lines. */
export function pem(bytes: Uint8Array): string {
  const lines = base64(bytes).match(/.{1,64}/g) ?? [];
  return `-----BEGIN CERTIFICATE-----\n${lines.join("\n")}\n-----END CERTIFICATE-----\n`;
}
