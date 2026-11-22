import {
  X509Certificate,
  createHash,
  createPublicKey,
  generateKeyPair,
  generateKeyPairSync,
} from "node:crypto";
import { readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { KeyObject } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";

import { codeSigningCertificate } from "@tide-ota/protocol";

import type { Tlv } from "../../protocol/src/signature.ts";
import type { Env } from "../src/keys.ts";
import type { FakeKms, KmsFault } from "./fake-kms.ts";
import { readTlv } from "../../protocol/src/signature.ts";
import { certificate } from "../src/certificate.ts";
import { openWriter } from "../src/keys.ts";
import { FAKE_KMS, startFakeKms } from "./fake-kms.ts";
import { expectNoPem, expectRefusal, run, tempRoot } from "./helpers.ts";

const MAIN = fileURLToPath(new URL("../src/main.ts", import.meta.url));
const ARGS = ["--common-name", "Tide test", "--validity-years", "10"];
const PROBE = Buffer.from("tide signing probe");
const BITS = [2048, 3072, 4096] as const;
type Bits = (typeof BITS)[number];
const SIGNING_VARIABLES = [
  "TIDE_SIGNING_KEY_FILE",
  "TIDE_SIGNING_KEY",
  "TIDE_KMS_KEY_ID",
  "TIDE_KMS_REGION",
  "TIDE_KMS_ACCESS_KEY_ID",
  "TIDE_KMS_SECRET_ACCESS_KEY",
  "TIDE_KMS_SESSION_TOKEN",
  "TIDE_KMS_ENDPOINT",
];
const SHA256_WITH_RSA = "300d06092a864886f70d01010b0500";
// Key Usage, critical, digitalSignature only; Extended Key Usage codeSigning, not critical.
const KEY_USAGE = "300e0603551d0f0101ff040403020780";
const EXT_KEY_USAGE = "30130603551d25040c300a06082b06010505070303";
const SELF_SIGNATURE =
  "the generated certificate: certificate has a self-signature that does not verify";
const PROBE_MISMATCH = "the signing key does not match the certificate it signed";

let keys: Record<Bits, KeyObject>;
let other: KeyObject;
let fakes: Record<Bits, FakeKms>;
let kms: FakeKms; // The 2048-bit fake.

const generate = promisify(generateKeyPair);
beforeAll(async () => {
  const pairs = await Promise.all(
    [...BITS, 2048].map((modulusLength) => generate("rsa", { modulusLength })),
  );
  keys = { 2048: pairs[0]!.privateKey, 3072: pairs[1]!.privateKey, 4096: pairs[2]!.privateKey };
  other = pairs[3]!.privateKey;
  const started = await Promise.all(BITS.map((bits) => startFakeKms(keys[bits])));
  fakes = { 2048: started[0]!, 3072: started[1]!, 4096: started[2]! };
  kms = fakes[2048];
});
afterAll(async () => {
  await Promise.all(Object.values(fakes).map((f) => f.close()));
});
afterEach(() => {
  kms.fault(undefined);
  kms.signWith(keys[2048]);
});

const pkcs8 = (key: KeyObject) => key.export({ type: "pkcs8", format: "pem" }).toString();

function keyFile(pem: string): { TIDE_SIGNING_KEY_FILE: string } {
  const path = join(tempRoot(), "signing-key.pem");
  writeFileSync(path, pem);
  return { TIDE_SIGNING_KEY_FILE: path };
}

const kmsEnv = (fake: FakeKms = kms) => ({
  TIDE_KMS_KEY_ID: FAKE_KMS.keyId,
  TIDE_KMS_REGION: FAKE_KMS.region,
  TIDE_KMS_ACCESS_KEY_ID: FAKE_KMS.accessKeyId,
  TIDE_KMS_SECRET_ACCESS_KEY: FAKE_KMS.secretAccessKey,
  TIDE_KMS_ENDPOINT: fake.endpoint,
});

const SOURCES: Record<string, (bits: Bits) => Record<string, string>> = {
  TIDE_SIGNING_KEY_FILE: (bits) => keyFile(pkcs8(keys[bits])),
  TIDE_SIGNING_KEY: (bits) => ({ TIDE_SIGNING_KEY: pkcs8(keys[bits]) }),
  "TIDE_KMS_*": (bits) => kmsEnv(fakes[bits]),
};

/** Runs the command in process, collecting its output lines. */
async function issue(
  env: Env,
  args: readonly string[] = ARGS,
  options: { readonly now?: () => number; readonly kmsTimeoutMs?: number } = {},
) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await certificate(args, env, {
    out: (line) => stdout.push(line),
    err: (line) => stderr.push(line),
    ...options,
  });
  return { code, stdout, stderr, pem: stdout.map((l) => `${l}\n`).join("") };
}

/** Fails unless the command refused with exactly `message`, printing nothing on stdout. */
function expectRefused(result: Awaited<ReturnType<typeof issue>>, message: string): void {
  expect({ code: result.code, stdout: result.stdout, stderr: result.stderr }).toEqual({
    code: 2,
    stdout: [],
    stderr: [`tide: ${message}`],
  });
}

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");
const derOf = (pem: string) =>
  new Uint8Array(Buffer.from(pem.replace(/-----[^-]+-----|\n/g, ""), "base64"));

/** The TLVs inside constructed `parent`. */
function children(der: Uint8Array, parent: Tlv): Tlv[] {
  const out: Tlv[] = [];
  for (let at = parent.body; at < parent.end;) {
    const t = readTlv(der, at, parent.end);
    out.push(t);
    at = t.end;
  }
  return out;
}

/** The certificate's fields, read with the profile's own DER reader. */
function fields(pem: string) {
  const der = derOf(pem);
  const envelope = children(der, readTlv(der, 0, der.length));
  const [tbs, outer] = envelope;
  const tbsFields = children(der, tbs!);
  const [version, serial, inner, issuer, validity, subject, spki, extensions] = tbsFields;
  const bytes = (t: Tlv | undefined) => der.subarray(t!.start, t!.end);
  const times = children(der, validity!).map((t) => ({
    tag: t.tag,
    text: Buffer.from(der.subarray(t.body, t.end)).toString("latin1"),
  }));
  return {
    der,
    envelope,
    tbsFields,
    version,
    serial,
    inner,
    outer,
    issuer,
    subject,
    spki,
    extensions,
    times,
    bytes,
  };
}

/** Checks the exact profile: v3, serial, algorithms, self-issued names and exactly the two extensions. */
function expectProfile(pem: string, spki: Buffer): void {
  const f = fields(pem);
  expect(f.envelope).toHaveLength(3);
  expect(f.tbsFields).toHaveLength(8);
  expect(hex(f.bytes(f.version))).toBe("a003020102");
  expect(hex(f.bytes(f.inner))).toBe(SHA256_WITH_RSA);
  expect(hex(f.bytes(f.outer))).toBe(SHA256_WITH_RSA);
  const serial = f.der.subarray(f.serial!.body, f.serial!.end);
  expect(f.serial!.tag).toBe(0x02);
  expect(serial.length).toBeLessThanOrEqual(20);
  expect(serial[0]! & 0x80).toBe(0); // Positive.
  expect(serial[0] !== 0 || serial.length === 1).toBe(true); // Minimal.
  expect(serial.some((b) => b !== 0)).toBe(true); // Non-zero.
  expect(hex(f.bytes(f.issuer))).toBe(hex(f.bytes(f.subject)));
  expect(Buffer.from(f.bytes(f.spki)).equals(spki)).toBe(true);
  expect(f.extensions!.tag).toBe(0xa3);
  const [list, ...more] = children(f.der, f.extensions!);
  expect(more).toHaveLength(0);
  expect(list!.tag).toBe(0x30);
  expect(children(f.der, list!).map((e) => hex(f.bytes(e)))).toEqual([KEY_USAGE, EXT_KEY_USAGE]);
  const lines = pem.split("\n");
  expect([lines[0], lines.at(-2), lines.at(-1)]).toEqual([
    "-----BEGIN CERTIFICATE-----",
    "-----END CERTIFICATE-----",
    "",
  ]);
  const body = lines.slice(1, -2);
  expect(body.slice(0, -1).every((l) => l.length === 64)).toBe(true);
  expect(body.at(-1)!.length).toBeGreaterThan(0);
  expect(body.at(-1)!.length).toBeLessThanOrEqual(64);
}

/** The public half of `key` as SubjectPublicKeyInfo DER. */
const spkiOf = (key: KeyObject) =>
  (key.type === "public" ? key : createPublicKey(key)).export({ type: "spki", format: "der" });
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest();

describe("certificates from every key source", () => {
  test.each(Object.keys(SOURCES).flatMap((source) => BITS.map((bits) => [source, bits] as const)))(
    "%s at RSA %i passes the profile, Node's parser and the exact DER layout",
    async (source, bits) => {
      const result = await issue(SOURCES[source]!(bits));
      expect(result.code).toBe(0);
      expect(result.stdout).toHaveLength(1);
      const { sha256: fingerprint } = await codeSigningCertificate(result.pem, new Date());
      expect(fingerprint).toBe(hex(sha256(derOf(result.pem))));
      expect(result.stderr).toEqual([`tide: certificate DER SHA-256 ${fingerprint}`]);
      expectProfile(result.pem, spkiOf(keys[bits]));

      // Self-issued (byte-identical names, above) and self-signed. checkIssued is not asked: OpenSSL also wants
      // keyCertSign whenever Key Usage is present, which this digitalSignature-only profile must not assert.
      const x509 = new X509Certificate(result.pem);
      expect(x509.issuer).toBe(x509.subject);
      expect(x509.verify(x509.publicKey)).toBe(true);
      expect(x509.keyUsage).toEqual(["1.3.6.1.5.5.7.3.3"]);
      expect(
        x509.publicKey.export({ type: "spki", format: "der" }).equals(spkiOf(keys[bits])),
      ).toBe(true);
    },
  );

  test("each run gets a fresh serial", async () => {
    const env = SOURCES.TIDE_SIGNING_KEY!(2048);
    const serial = async () => {
      const f = fields((await issue(env)).pem);
      return hex(f.bytes(f.serial));
    };
    expect(await serial()).not.toBe(await serial());
  });
});

describe("flags and clock", () => {
  const env = () => SOURCES.TIDE_SIGNING_KEY!(2048);
  const at = (now: number, years: string, name = "Tide Signing 2028") =>
    issue(env(), ["--common-name", name, "--validity-years", years], { now: () => now });

  test("the common name is the only subject and issuer attribute; milliseconds drop and 29 February rolls over", async () => {
    const now = Date.UTC(2028, 1, 29, 12, 34, 56, 789);
    const result = await at(now, "1");
    expect(result.code).toBe(0);
    await codeSigningCertificate(result.pem, new Date(now));
    const f = fields(result.pem);
    const name = `301c311a301806035504030c11${Buffer.from("Tide Signing 2028").toString("hex")}`;
    expect(hex(f.bytes(f.subject))).toBe(name);
    expect(hex(f.bytes(f.issuer))).toBe(name);
    expect(f.times).toEqual([
      { tag: 0x17, text: "280229123456Z" },
      { tag: 0x17, text: "290301123456Z" },
    ]);
    const x509 = new X509Certificate(result.pem);
    expect(x509.subject).toBe("CN=Tide Signing 2028");
    expect(x509.validFromDate.toISOString()).toBe("2028-02-29T12:34:56.000Z");
    expect(x509.validToDate.toISOString()).toBe("2029-03-01T12:34:56.000Z");
  });

  test("UTCTime before 2050 and GeneralizedTime from 2050", async () => {
    const now = Date.UTC(2048, 5, 1, 0, 0, 0, 1);
    const result = await at(now, "3");
    await codeSigningCertificate(result.pem, new Date(now));
    expect(fields(result.pem).times).toEqual([
      { tag: 0x17, text: "480601000000Z" },
      { tag: 0x18, text: "20510601000000Z" },
    ]);
    expect(new X509Certificate(result.pem).validToDate.toISOString()).toBe(
      "2051-06-01T00:00:00.000Z",
    );
  });

  test("a validity of 100 years ends 100 years from now", async () => {
    const now = Date.now();
    const result = await at(now, "100");
    expect(result.code).toBe(0);
    const [, end] = fields(result.pem).times;
    expect(end!.tag).toBe(0x18);
    expect(new X509Certificate(result.pem).validToDate.getUTCFullYear()).toBe(
      new Date(now).getUTCFullYear() + 100,
    );
  });

  test.each(["A", "x".repeat(64), "Example App (production) #1"])(
    "the common name %j passes",
    async (name) => {
      const result = await at(Date.now(), "1", name);
      expect(result.code).toBe(0);
      expect(new X509Certificate(result.pem).subject).toBe(`CN=${name}`);
    },
  );
});

describe("KMS requests", () => {
  test("GetPublicKey, then Sign of the TBS digest, then Sign of the probe digest", async () => {
    const before = kms.received.length;
    const result = await issue(kmsEnv());
    expect(result.code).toBe(0);
    const requests = kms.received.slice(before);
    expect(requests.map((r) => r.target)).toEqual(["GetPublicKey", "Sign", "Sign"]);
    const bodies = requests.map((r) => JSON.parse(Buffer.from(r.body).toString("utf8")) as unknown);
    const f = fields(result.pem);
    const tbs = f.bytes(f.envelope[0]);
    const signRequest = (digest: Buffer) => ({
      KeyId: FAKE_KMS.keyId,
      Message: digest.toString("base64"),
      MessageType: "DIGEST",
      SigningAlgorithm: "RSASSA_PKCS1_V1_5_SHA_256",
    });
    expect(bodies).toEqual([
      { KeyId: FAKE_KMS.keyId },
      signRequest(sha256(tbs)),
      signRequest(sha256(PROBE)),
    ]);
  });

  test("a Sign key other than the GetPublicKey key fails the profile's self-signature check", async () => {
    kms.signWith(other);
    expectRefused(await issue(kmsEnv()), SELF_SIGNATURE);
  });

  test("a probe signed by another key is refused after the profile and key checks pass", async () => {
    const before = kms.received.length;
    kms.signWith(other, (digest) => digest.equals(sha256(PROBE)));
    expectRefused(await issue(kmsEnv()), PROBE_MISMATCH);
    expect(kms.received.slice(before).map((r) => r.target)).toEqual([
      "GetPublicKey",
      "Sign",
      "Sign",
    ]);
  });

  test("a Sign failure prints nothing on stdout", async () => {
    kms.fault({ status: 400, header: "AccessDeniedException" }, "Sign");
    expectRefused(await issue(kmsEnv()), "KMS Sign failed: 400 AccessDeniedException");
  });
});

describe("GetPublicKey refusals", () => {
  const spki = (key: KeyObject) => spkiOf(key).toString("base64");
  const valid = () => ({
    KeyId: FAKE_KMS.arn,
    KeySpec: "RSA_2048",
    KeyUsage: "SIGN_VERIFY",
    PublicKey: spki(keys[2048]),
    SigningAlgorithms: ["RSASSA_PKCS1_V1_5_SHA_256"],
  });
  const reply = (fields: Record<string, unknown>) => ({
    reply: JSON.stringify({ ...valid(), ...fields }),
  });
  const without = (name: string) => {
    const r: Record<string, unknown> = valid();
    delete r[name];
    return { reply: JSON.stringify(r) };
  };
  const once = <T>(make: () => T) => {
    let made: { value: T } | undefined;
    return () => (made ??= { value: make() }).value;
  };
  const small = once(() => generateKeyPairSync("rsa", { modulusLength: 1024 }).publicKey);
  const ec = once(() => generateKeyPairSync("ec", { namedCurve: "P-256" }).publicKey);
  const INVALID_KEY = "KMS GetPublicKey returned 200 with an invalid public key";
  const INVALID_REPLY = "KMS GetPublicKey returned 200 with an invalid reply";
  const SPEC = "KMS key must have key spec RSA_2048, RSA_3072 or RSA_4096";
  const ALGORITHM = "KMS key must allow the signing algorithm RSASSA_PKCS1_V1_5_SHA_256";

  test("a hand-built valid reply passes, so each refusal below fails on its own field", async () => {
    kms.fault(reply({}), "GetPublicKey");
    expect((await issue(kmsEnv())).code).toBe(0);
  });

  // [name, fault, message, a value the message must not echo]
  test.each<[string, () => KmsFault, string, string | (() => string)]>([
    [
      "ENCRYPT_DECRYPT usage",
      () => reply({ KeyUsage: "ENCRYPT_DECRYPT" }),
      "KMS key must have key usage SIGN_VERIFY",
      "ENCRYPT_DECRYPT",
    ],
    [
      "no key usage",
      () => without("KeyUsage"),
      "KMS key must have key usage SIGN_VERIFY",
      FAKE_KMS.arn,
    ],
    ["an ECC spec", () => reply({ KeySpec: "ECC_NIST_P256" }), SPEC, "ECC_NIST_P256"],
    ["an RSA_1024 spec", () => reply({ KeySpec: "RSA_1024" }), SPEC, "RSA_1024"],
    ["an inherited spec name", () => reply({ KeySpec: "toString" }), SPEC, "toString"],
    ["no signing algorithms", () => without("SigningAlgorithms"), ALGORITHM, FAKE_KMS.arn],
    [
      "only RSASSA-PSS",
      () => reply({ SigningAlgorithms: ["RSASSA_PSS_SHA_256"] }),
      ALGORITHM,
      "PSS",
    ],
    [
      "a 1024-bit key under RSA_2048",
      () => reply({ PublicKey: spki(small()) }),
      INVALID_KEY,
      () => spki(small()).slice(0, 24),
    ],
    [
      "a 2048-bit key under RSA_3072",
      () => reply({ KeySpec: "RSA_3072" }),
      INVALID_KEY,
      () => spki(keys[2048]).slice(0, 24),
    ],
    [
      "an EC SubjectPublicKeyInfo",
      () => reply({ PublicKey: spki(ec()) }),
      INVALID_KEY,
      () => spki(ec()).slice(0, 24),
    ],
    [
      "base64 missing its last character",
      () => reply({ PublicKey: spki(keys[2048]).slice(0, -1) }),
      INVALID_KEY,
      "MII",
    ],
    ["a public key that is not a string", () => reply({ PublicKey: 7 }), INVALID_KEY, "7"],
    [
      "bytes after the SubjectPublicKeyInfo",
      () =>
        reply({
          PublicKey: Buffer.concat([spkiOf(keys[2048]), Buffer.from([0])]).toString("base64"),
        }),
      INVALID_KEY,
      "MII",
    ],
    ["a reply that is not JSON", () => ({ reply: "not json" }), INVALID_REPLY, "not json"],
    ["a JSON array", () => ({ reply: "[]" }), INVALID_REPLY, "[]"],
    ["an oversized reply", () => "oversize", INVALID_REPLY, "xxxx"],
    [
      "access denied in the header",
      () => ({ status: 400, header: "AccessDeniedException:http://internal.amazon.com/coral/" }),
      "KMS GetPublicKey failed: 400 AccessDeniedException",
      "internal.amazon.com",
    ],
    [
      "a missing key in the body",
      () => ({ status: 400, body: '{"__type":"com.amazonaws.kms#NotFoundException"}' }),
      "KMS GetPublicKey failed: 400 NotFoundException",
      "com.amazonaws",
    ],
    [
      "an unrecognised code carrying the secret",
      () => ({ status: 400, header: FAKE_KMS.secretAccessKey }),
      "KMS GetPublicKey failed: 400 with an unrecognised error code",
      FAKE_KMS.secretAccessKey,
    ],
    [
      "an error that is not a KMS document",
      () => ({ status: 502, body: "<html>bad gateway</html>" }),
      "KMS GetPublicKey failed: 502 without a KMS error document",
      "bad gateway",
    ],
    [
      "a dropped connection",
      () => "drop",
      "KMS GetPublicKey failed: network error",
      FAKE_KMS.accessKeyId,
    ],
  ])("%s is refused before any Sign", async (_, fault, message, echoed) => {
    const before = kms.received.length;
    kms.fault(fault(), "GetPublicKey");
    const result = await issue(kmsEnv());
    expectRefused(result, message);
    expect(result.stderr.join("\n")).not.toContain(typeof echoed === "string" ? echoed : echoed());
    expect(kms.received.slice(before).map((r) => r.target)).toEqual(["GetPublicKey"]);
  });

  test("a wrong secret is refused by the fake's SigV4 check", async () => {
    expectRefused(
      await issue({ ...kmsEnv(), TIDE_KMS_SECRET_ACCESS_KEY: "not-the-fake-kms-secret" }),
      "KMS GetPublicKey failed: 400 InvalidSignatureException",
    );
  });

  test("a stalled reply times out", async () => {
    kms.fault("stall", "GetPublicKey");
    expectRefused(
      await issue(kmsEnv(), ARGS, { kmsTimeoutMs: 200 }),
      "KMS GetPublicKey timed out after 200 ms",
    );
  });

  test("a redirect is refused and not followed", async () => {
    const elsewhere = await startFakeKms(keys[2048]);
    try {
      kms.fault({ redirect: `${elsewhere.endpoint}/` }, "GetPublicKey");
      expectRefused(
        await issue(kmsEnv()),
        "KMS GetPublicKey failed: 307 without a KMS error document",
      );
      expect(elsewhere.requests).toBe(0);
    } finally {
      await elsewhere.close();
    }
  });

  test("an endpoint outside the rule is refused before any request", async () => {
    const before = kms.requests;
    expectRefused(
      await issue({ ...kmsEnv(), TIDE_KMS_ENDPOINT: "http://10.0.0.1" }),
      "TIDE_KMS_ENDPOINT must be an https origin, or an http origin on a loopback IP address, with no path",
    );
    expect(kms.requests).toBe(before);
  });
});

describe("refusals print nothing on stdout", () => {
  const ecPem = () =>
    generateKeyPairSync("ec", { namedCurve: "P-256" })
      .privateKey.export({ type: "pkcs8", format: "pem" })
      .toString();
  const smallPem = () =>
    generateKeyPairSync("rsa", { modulusLength: 1024 })
      .privateKey.export({ type: "pkcs8", format: "pem" })
      .toString();
  const encryptedPem = () =>
    keys[2048]
      .export({ type: "pkcs8", format: "pem", cipher: "aes-256-cbc", passphrase: "tide" })
      .toString();
  const file = () => SOURCES.TIDE_SIGNING_KEY_FILE!(2048);

  test.each<[string, () => Env, readonly string[], string]>([
    [
      "no key source",
      () => ({}),
      ARGS,
      "no signing key: set TIDE_SIGNING_KEY_FILE, TIDE_SIGNING_KEY or TIDE_KMS_KEY_ID",
    ],
    [
      "empty key variables",
      () => ({ TIDE_SIGNING_KEY: "", TIDE_KMS_KEY_ID: "" }),
      ARGS,
      "no signing key: set TIDE_SIGNING_KEY_FILE, TIDE_SIGNING_KEY or TIDE_KMS_KEY_ID",
    ],
    [
      "a file and a KMS key",
      () => ({ ...file(), ...kmsEnv() }),
      ARGS,
      "more than one signing key: TIDE_SIGNING_KEY_FILE, TIDE_KMS_KEY_ID, TIDE_KMS_REGION, TIDE_KMS_ACCESS_KEY_ID, TIDE_KMS_SECRET_ACCESS_KEY, TIDE_KMS_ENDPOINT are set; set one source",
    ],
    [
      "an encrypted key",
      () => ({ TIDE_SIGNING_KEY: encryptedPem() }),
      ARGS,
      "TIDE_SIGNING_KEY holds an encrypted key: Tide needs it unencrypted",
    ],
    [
      "an EC key",
      () => keyFile(ecPem()),
      ARGS,
      "TIDE_SIGNING_KEY_FILE holds a key of type ec: Tide signs with RSA",
    ],
    [
      "a 1024-bit key",
      () => ({ TIDE_SIGNING_KEY: smallPem() }),
      ARGS,
      "TIDE_SIGNING_KEY must hold an RSA key of 2048 to 4096 bits",
    ],
    [
      "an incomplete KMS signer",
      () => ({ TIDE_KMS_KEY_ID: FAKE_KMS.keyId }),
      ARGS,
      "KMS signer incomplete: set TIDE_KMS_REGION, TIDE_KMS_ACCESS_KEY_ID, TIDE_KMS_SECRET_ACCESS_KEY",
    ],
    [
      "no common name",
      file,
      ["--validity-years", "1"],
      "--common-name is required; usage: tide certificate --common-name <name> --validity-years <n>",
    ],
    [
      "no validity",
      file,
      ["--common-name", "a"],
      "--validity-years is required; usage: tide certificate --common-name <name> --validity-years <n>",
    ],
    [
      "a repeated common name",
      file,
      [...ARGS, "--common-name", "b"],
      "--common-name is given twice",
    ],
    [
      "an unknown flag",
      file,
      [...ARGS, "--out", "x"],
      "unrecognised arguments; usage: tide certificate --common-name <name> --validity-years <n>",
    ],
    [
      "a positional",
      file,
      [...ARGS, "certificate.pem"],
      "unrecognised arguments; usage: tide certificate --common-name <name> --validity-years <n>",
    ],
    ...["", " leading", "trailing ", "x".repeat(65), "Tidé", "tab\there", "line\nbreak"].map(
      (name): [string, () => Env, readonly string[], string] => [
        `the common name ${JSON.stringify(name)}`,
        file,
        ["--common-name", name, "--validity-years", "1"],
        "--common-name must be 1 to 64 printable ASCII characters, with no space at either end",
      ],
    ),
    ...["0", "101", "1.5", "01", "x", "", "1e1", "999"].map(
      (years): [string, () => Env, readonly string[], string] => [
        `the validity ${JSON.stringify(years)}`,
        file,
        ["--common-name", "a", "--validity-years", years],
        "--validity-years must be a whole number from 1 to 100",
      ],
    ),
  ])("%s exits 2", async (_, env, args, message) => {
    expectRefused(await issue(env(), args), message);
  });
});

test("only signing-key variables are read, so build pins and a broken bucket configuration are ignored", async () => {
  for (const source of [SOURCES.TIDE_SIGNING_KEY_FILE!(2048), kmsEnv()]) {
    const read = new Set<string>();
    const env = new Proxy(
      {
        ...source,
        TIDE_DISK_DIR: join(tempRoot(), "missing"),
        TIDE_S3_ENDPOINT: "not a url",
        TIDE_S3_BUCKET: "",
        TIDE_BUILD_KEYID: "\u0000",
        TIDE_BUILD_CERTIFICATE: "not a certificate",
      },
      {
        get: (target, name, receiver) => {
          if (typeof name === "string") read.add(name);
          return Reflect.get(target, name, receiver) as unknown;
        },
      },
    );
    expect((await issue(env)).code).toBe(0);
    expect([...read].filter((name) => !SIGNING_VARIABLES.includes(name))).toEqual([]);
  }
});

describe.each(Object.keys(SOURCES))("a certificate from %s", (source) => {
  test("lets a writer with the same key source pass its signing probe", async () => {
    const env = SOURCES[source]!(2048);
    const result = await issue(env);
    expect(result.code).toBe(0);
    const before = kms.received.length;
    // A writer needs only kms:Sign: GetPublicKey is denied for the writer's part.
    kms.fault({ status: 400, header: "AccessDeniedException" }, "GetPublicKey");
    const { signer } = await openWriter({
      ...env,
      TIDE_BUILD_KEYID: "main",
      TIDE_BUILD_CERTIFICATE: result.pem,
      TIDE_DISK_DIR: tempRoot(),
    });
    expect(signer.keyId).toBe("main");
    const writes = kms.received.slice(before).map((r) => r.target);
    expect(writes).toEqual(source === "TIDE_KMS_*" ? ["Sign"] : []);
  });
});

describe("the tide bin", () => {
  test("prints the PEM on stdout and the fingerprint on stderr, and writes no file", async () => {
    const [cwd, home, tmp] = [tempRoot(), tempRoot(), tempRoot()];
    const pem = pkcs8(keys[2048]);
    const result = await run(
      MAIN,
      ["certificate", ...ARGS],
      { PATH: process.env.PATH ?? "", HOME: home, TMPDIR: tmp, TIDE_SIGNING_KEY: pem },
      cwd,
    );
    expect(result.code).toBe(0);
    const { sha256: fingerprint } = await codeSigningCertificate(result.stdout, new Date());
    expect(result.stderr).toBe(`tide: certificate DER SHA-256 ${fingerprint}\n`);
    expectProfile(result.stdout, spkiOf(keys[2048]));
    expectNoPem(result.stderr, pem);
    const keyLines = pem.split("\n").filter((l) => l.length >= 16 && !l.startsWith("-----"));
    expect(keyLines.some((l) => result.stdout.includes(l))).toBe(false);
    for (const dir of [cwd, home, tmp]) expect(readdirSync(dir)).toEqual([]);
  });

  test("a refusal prints no key text and nothing on stdout", async () => {
    const pem = generateKeyPairSync("ec", { namedCurve: "P-256" })
      .privateKey.export({ type: "pkcs8", format: "pem" })
      .toString();
    const result = await run(MAIN, ["certificate", ...ARGS], { TIDE_SIGNING_KEY: pem });
    expectNoPem(result.stdout + result.stderr, pem);
    expectRefusal(result, "TIDE_SIGNING_KEY holds a key of type ec: Tide signs with RSA");
  });

  test("with no arguments lists the command", async () => {
    const result = await run(MAIN, [], {});
    expect(result.code).toBe(2);
    expect(result.stderr.split("\n")).toContain(
      "usage: tide certificate --common-name <name> --validity-years <n>",
    );
  });
});
