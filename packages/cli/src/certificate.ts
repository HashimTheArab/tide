import { X509Certificate } from "node:crypto";
import { parseArgs } from "node:util";

import { signedCertificate } from "@tide-ota/protocol";

import type { Env } from "./keys.ts";
import type { PublishOptions } from "./publish.ts";
import { KeyError, PROBE, RSA, signingKey, validCertificate } from "./keys.ts";
import { PublishError } from "./publish-record.ts";
import { parsed, report, requiredOnce } from "./publish.ts";

export const CERTIFICATE_USAGE =
  "usage: tide certificate --common-name <name> --validity-years <n>";
const COMMON_NAME = /^[\x21-\x7E](?:[\x20-\x7E]{0,62}[\x21-\x7E])?$/;
const YEARS = /^[1-9]\d{0,2}$/;
const MAX_YEARS = 100;

/**
 * Prints a self-signed code-signing certificate signed by the configured key source on stdout, and its DER SHA-256
 * on stderr. Nothing reaches stdout unless the profile, public key and probe checks pass. Exit 0, or 2 on any refusal.
 */
export async function certificate(
  args: readonly string[],
  env: Env,
  options: PublishOptions & { readonly kmsTimeoutMs?: number },
): Promise<0 | 2> {
  const { out, err, now = Date.now, kmsTimeoutMs = 30_000 } = options;
  try {
    const { commonName, years } = parse(args);
    const source = signingKey(env, kmsTimeoutMs);
    const spki = await source.publicKey();
    const at = now();
    const notBefore = new Date(Math.floor(at / 1000) * 1000);
    const notAfter = new Date(notBefore);
    notAfter.setUTCFullYear(notAfter.getUTCFullYear() + years); // 29 February rolls to 1 March.
    const pem = await signedCertificate({ spki, commonName, notBefore, notAfter }, source.sign);
    const { key, sha256 } = await validCertificate(pem, "the generated certificate", at);
    const embedded = new X509Certificate(pem).publicKey.export({ type: "spki", format: "der" });
    if (!embedded.equals(spki)) {
      throw new KeyError("the certificate's public key differs from the signing key's");
    }
    if (!(await crypto.subtle.verify(RSA, key, await source.sign(PROBE), PROBE))) {
      throw new KeyError("the signing key does not match the certificate it signed");
    }
    out(pem.trimEnd());
    err(`tide: certificate DER SHA-256 ${sha256}`);
    return 0;
  } catch (e) {
    return report(e, options, 2);
  }
}

function parse(args: readonly string[]) {
  const { values } = parsed(CERTIFICATE_USAGE, () =>
    parseArgs({
      args: [...args],
      options: {
        "common-name": { type: "string", multiple: true },
        "validity-years": { type: "string", multiple: true },
      },
      strict: true,
      allowPositionals: false,
    }),
  );
  const commonName = requiredOnce(values, "common-name", CERTIFICATE_USAGE);
  const years = requiredOnce(values, "validity-years", CERTIFICATE_USAGE);
  if (!COMMON_NAME.test(commonName)) {
    throw new PublishError(
      "--common-name must be 1 to 64 printable ASCII characters, with no space at either end",
    );
  }
  if (!YEARS.test(years) || Number(years) > MAX_YEARS) {
    throw new PublishError(`--validity-years must be a whole number from 1 to ${MAX_YEARS}`);
  }
  return { commonName, years: Number(years) };
}
