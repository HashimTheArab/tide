// Chain-mode identities for the write-command tests: a CA root, an intermediate and leaves, generated per run.
import { KeyObject } from "node:crypto";

import {
  certificateChain,
  decodePointer,
  decodeStoredReply,
  parseMultipart,
  verifyChainedSignature,
} from "@tide-ota/protocol";

import type { CertificateOptions } from "../../protocol/test/fixtures.ts";
import { EXTENSION, RSA_SHA256, certificate } from "../../protocol/test/fixtures.ts";
import { utf8 } from "./helpers.ts";
import { ASSET_URL, SERVER_URL } from "./publish-fixture.ts";

export interface Pair {
  readonly publicKey: CryptoKey;
  readonly privateKey: CryptoKey;
}

/** A certificate, its key pair, and the key as the PKCS#8 PEM `TIDE_SIGNING_KEY` takes. */
export interface Issued {
  readonly keys: Pair;
  readonly certificate: string;
  readonly pkcs8: string;
}

const NOT_BEFORE = new Date("2020-01-01T00:00:00Z");
const CA = [EXTENSION.ca(1), EXTENSION.keyCertSignOnly];
const INTERMEDIATE = [EXTENSION.ca(0), EXTENSION.keyCertSignOnly];
const LEAF = [EXTENSION.digitalSignature, EXTENSION.codeSigning];

export const generate = (): Promise<Pair> =>
  crypto.subtle.generateKey(RSA_SHA256, true, ["sign", "verify"]);

const pkcs8 = (key: CryptoKey) =>
  KeyObject.from(key).export({ type: "pkcs8", format: "pem" }).toString();

/** Issues `subject` a certificate under `issuer`'s key, valid from 2020 to 2049 unless `options` say otherwise. */
async function issue(subject: Pair, issuer: Pair, options: CertificateOptions): Promise<Issued> {
  return {
    keys: subject,
    certificate: await certificate(subject.publicKey, issuer.privateKey, NOT_BEFORE, options),
    pkcs8: pkcs8(subject.privateKey),
  };
}

/** A self-signed CA root named `name` (pathLen 1). */
export const root = (keys: Pair, name = "Tide root", options: CertificateOptions = {}) =>
  issue(keys, keys, { subject: name, issuer: name, extensions: CA, ...options });

/** An intermediate CA (pathLen 0) under `above`. */
export const intermediate = (above: Issued, aboveName: string, options: CertificateOptions = {}) =>
  generate().then((keys) =>
    issue(keys, above.keys, {
      subject: "Tide intermediate",
      issuer: aboveName,
      extensions: INTERMEDIATE,
      ...options,
    }),
  );

/** A code-signing leaf under `above`, named `name`. */
export const leaf = (
  above: Issued,
  aboveName: string,
  name: string,
  options: CertificateOptions = {},
) =>
  generate().then((keys) =>
    issue(keys, above.keys, { subject: name, issuer: aboveName, extensions: LEAF, ...options }),
  );

/**
 * A root a direct-signing app could also embed: CA with one Key Usage holding keyCertSign and digitalSignature, and
 * EKU codeSigning, so a direct-signed body verifies under it as a one-certificate chain.
 */
export const dualPurposeRoot = () =>
  generate().then((keys) =>
    issue(keys, keys, {
      subject: "Tide dual",
      issuer: "Tide dual",
      extensions: [EXTENSION.ca(1), EXTENSION.keyUsage("0284"), EXTENSION.codeSigning],
    }),
  );

/** The `certificate_chain` part body serving `members`, leaf first. */
export const served = (...members: Issued[]) => members.map((m) => m.certificate).join("");

/** A chain-mode writer's configuration: pins for `rootPem`, the served chain and the leaf's key, over `store`. */
export const chainEnv = (
  store: Record<string, string>,
  rootPem: string,
  chain: string,
  signer: Issued,
): Record<string, string> => ({
  PATH: process.env.PATH ?? "",
  TIDE_SIGNING_KEY: signer.pkcs8,
  ...chainPins(rootPem),
  TIDE_CERTIFICATE_CHAIN: chain,
  TIDE_SERVER_URL: SERVER_URL,
  TIDE_ASSET_URL: ASSET_URL,
  ...store,
});

/** The chain-mode build pins for `rootPem`, key ID main. */
export const chainPins = (rootPem: string): Record<string, string> => ({
  TIDE_BUILD_KEYID: "main",
  TIDE_BUILD_CERTIFICATE: rootPem,
  TIDE_BUILD_INCLUDE_CERTIFICATE_CHAIN: "true",
});

/** The fields of a chain-mode export embedding `rootPem`. */
export const chainExport = (rootPem: string) => ({
  certificate: rootPem,
  codeSigningIncludeManifestResponseCertificateChain: true,
});

/**
 * Checks a stored record as a chain-mode client would at `at`: every reply's parts are the signed part then a
 * `certificate_chain` holding exactly `chain` (for a rollout, one per side: new, then earlier), which passes over
 * `rootPem` and whose leaf verifies the signed part.
 */
export async function expectChained(
  stored: Uint8Array | undefined,
  key: string,
  rootPem: string,
  chain: string | readonly string[],
  at: number,
): Promise<void> {
  if (stored === undefined) throw new Error(`${key} is absent`);
  const record = key === "reply/no-update" ? decodeStoredReply(stored) : decodePointer(stored);
  const replies =
    record.kind === "rollout"
      ? [record.new, ...(record.earlier === undefined ? [] : [record.earlier])]
      : [record];
  for (const [i, reply] of replies.entries()) {
    const expected = typeof chain === "string" ? chain : chain[i];
    const parts = parseMultipart(reply.body, reply.boundary);
    const signedName = reply.kind === "manifest" ? "manifest" : "directive";
    if (parts.length !== 2 || parts[0]?.name !== signedName) {
      throw new Error(`${key}: parts are not [${signedName}, certificate_chain]`);
    }
    const [signed, part] = parts;
    if (
      signed.signature === undefined ||
      part?.name !== "certificate_chain" ||
      expected === undefined ||
      !Buffer.from(part.body).equals(utf8(expected))
    ) {
      throw new Error(`${key}: the certificate_chain part is not the configured chain`);
    }
    const leafKey = await certificateChain(part.body, rootPem, new Date(at));
    await verifyChainedSignature(signed.body, signed.signature, leafKey);
  }
}
