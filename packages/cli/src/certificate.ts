import { X509Certificate, createHash, createPublicKey } from "node:crypto";
import { parseArgs } from "node:util";

import type { IssuerPath } from "@tide-ota/protocol";
import {
  MAX_COMMON_NAME,
  MAX_ISSUER_BYTES,
  MAX_SPKI_BYTES,
  ProtocolError,
  certificateAuthorityChain,
  certificateChain,
  decodeBase64,
  issuerPath,
  signedCertificate,
} from "@tide-ota/protocol";

import type { Env, KeySource } from "./keys.ts";
import type { PublishOptions } from "./publish.ts";
import { KeyError, PROBE, RSA, readSmallFile, signingKey, validCertificate } from "./keys.ts";
import { PublishError, sameBytes } from "./publish-record.ts";
import { once, parsed, report, requiredOnce } from "./publish.ts";

// P10's form; its refusals cite only this line unless an argument names a chain flag.
const DIRECT_USAGE = "usage: tide certificate --common-name <name> --validity-years <n>";
export const CERTIFICATE_USAGE = `${DIRECT_USAGE}
       tide certificate --ca [--path-length <n>] --common-name <name> --validity-years <n>
       tide certificate --issuer <chain.pem> --subject-key <public-key.pem> [--ca [--path-length <n>]] --common-name <name> (--validity-years <n> | --validity-days <n>)`;
const CHAIN_FLAG = /^--(?:ca|path-length|issuer|subject-key|validity-days)(?:=|$)/;
const COMMON_NAME = new RegExp(
  `^[\\x21-\\x7E](?:[\\x20-\\x7E]{0,${MAX_COMMON_NAME - 2}}[\\x21-\\x7E])?$`,
);
const YEARS = /^[1-9]\d{0,2}$/;
const MAX_YEARS = 100;
const DAYS = /^[1-9]\d{0,4}$/;
const MAX_DAYS = 36_500;
const PATH_LENGTH = /^[0-7]$/;
const DAY_MS = 86_400_000;
const PUBLIC_KEY =
  /^-----BEGIN PUBLIC KEY-----\r?\n((?:[A-Za-z0-9+/=]+\r?\n)+)-----END PUBLIC KEY-----(?:\r?\n)?$/;

/**
 * Prints a certificate signed by the configured key source on stdout, and its DER SHA-256 on stderr: P10's
 * self-signed code-signing certificate, a CA root, or an intermediate or leaf under `--issuer`. Nothing reaches
 * stdout unless every check passes. Exit 0, or 2 on any refusal.
 */
export async function certificate(
  args: readonly string[],
  env: Env,
  options: PublishOptions & { readonly kmsTimeoutMs?: number },
): Promise<0 | 2> {
  const { out, err, now = Date.now, kmsTimeoutMs = 30_000 } = options;
  try {
    const request = parse(args);
    const { pem, sha256 } =
      request.chain === undefined
        ? await direct(request, signingKey(env, kmsTimeoutMs), now)
        : await chained(request, request.chain, env, kmsTimeoutMs, now());
    out(pem.trimEnd());
    err(`tide: certificate DER SHA-256 ${sha256}`);
    return 0;
  } catch (e) {
    return report(e, options, 2);
  }
}

/** P10's self-signed code-signing certificate. */
async function direct({ commonName, lifetime }: Request, source: KeySource, now: () => number) {
  const spki = await source.publicKey();
  const at = now();
  const notBefore = new Date(Math.floor(at / 1000) * 1000);
  const notAfter = expiry(notBefore, lifetime);
  const pem = await signedCertificate({ spki, commonName, notBefore, notAfter }, source.sign);
  const { key, sha256 } = await validCertificate(pem, "the generated certificate", at);
  const embedded = new X509Certificate(pem).publicKey.export({ type: "spki", format: "der" });
  if (!embedded.equals(spki)) {
    throw new KeyError("the certificate's public key differs from the signing key's");
  }
  if (!(await crypto.subtle.verify(RSA, key, await source.sign(PROBE), PROBE))) {
    throw new KeyError("the signing key does not match the certificate it signed");
  }
  return { pem, sha256 };
}

/** A CA root, or an intermediate or leaf under `--issuer`, checked against the client's chain rules at `at`. */
async function chained(
  { commonName, lifetime }: Request,
  { ca, issuer }: Chain,
  env: Env,
  kmsTimeoutMs: number,
  at: number,
) {
  const date = new Date(at);
  // Strictly before `at`: the client needs notBefore < now on every chain member.
  const notBefore = new Date(Math.floor((at - 1) / 1000) * 1000);
  const notAfter = expiry(notBefore, lifetime);
  const issued = issuer && (await issuedInputs(issuer, date));
  const source = signingKey(env, kmsTimeoutMs);
  const spki = await source.publicKey();
  if (issued !== undefined) {
    if (!sameBytes(issued.path.spki, spki)) {
      throw new KeyError("the --issuer certificate's public key is not the signing key's");
    }
    if (notAfter.getTime() > issued.path.notAfter) {
      const bound = new Date(issued.path.notAfter).toISOString().replace(".000Z", "Z");
      throw new KeyError(
        `the new certificate would expire after a certificate in --issuer, which expires ${bound}: shorten --validity-days or --validity-years`,
      );
    }
  }
  const pem = await signedCertificate(
    {
      spki: issued?.subjectKey ?? spki,
      commonName,
      notBefore,
      notAfter,
      issuer: issued?.path.subject,
      ca,
    },
    source.sign,
  );
  try {
    if (issued === undefined) {
      await certificateAuthorityChain(undefined, pem, date, true);
    } else {
      const served = servedPart(pem, issued.path);
      if (ca === undefined) {
        await certificateChain(served, issued.path.root, date);
      } else {
        await certificateAuthorityChain(served, issued.path.root, date, true);
      }
    }
  } catch (e) {
    if (!(e instanceof ProtocolError)) throw e;
    throw new KeyError(`the generated certificate: ${e.message}`);
  }
  // `cat` of this certificate and the --issuer path must stay readable as the next --issuer.
  if (
    ca !== undefined &&
    issued !== undefined &&
    pem.length + (issued.path.served?.length ?? 0) + issued.path.root.length > MAX_ISSUER_BYTES
  ) {
    throw new KeyError(
      `the generated certificate: with --issuer it would make an --issuer file over ${MAX_ISSUER_BYTES} bytes`,
    );
  }
  const der = new X509Certificate(pem).raw;
  return { pem, sha256: createHash("sha256").update(der).digest("hex") };
}

/** The served part a writer would send: the new certificate, then the issuer path below its root. */
function servedPart(pem: string, path: IssuerPath): Uint8Array {
  const head = new TextEncoder().encode(pem);
  if (path.served === undefined) return head;
  const out = new Uint8Array(head.length + path.served.length);
  out.set(head);
  out.set(path.served, head.length);
  return out;
}

/** Reads and checks `--issuer` and `--subject-key`, before any key source is touched. */
async function issuedInputs({ path, subjectKey }: Issuer, date: Date) {
  const issuerBytes = readInput(path, "--issuer");
  const keyBytes = readInput(subjectKey, "--subject-key");
  const parsedPath = await asIssuer(() => Promise.resolve(issuerPath(issuerBytes)));
  const key = subjectPublicKey(keyBytes);
  // No room reserve here: a leaf is checked by its exact bytes, a CA by its own reserve once issued.
  await asIssuer(() => certificateAuthorityChain(parsedPath.served, parsedPath.root, date, false));
  return { path: parsedPath, subjectKey: key };
}

/** Returns `run()`, reporting a protocol refusal against `--issuer`. */
async function asIssuer<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (e) {
    if (!(e instanceof ProtocolError)) throw e;
    throw new KeyError(`--issuer: ${e.message.slice(e.field.length + 1)}`);
  }
}

function readInput(path: string, flag: string): Buffer {
  const bytes = readSmallFile(path);
  if (bytes === undefined) {
    throw new KeyError(`${flag} unreadable: not a regular file of at most 64 KiB`);
  }
  return bytes;
}

/** Returns the SubjectPublicKeyInfo DER of one canonical PUBLIC KEY block holding an RSA key of 2048 to 4096 bits. */
function subjectPublicKey(bytes: Buffer): Uint8Array<ArrayBuffer> {
  const block = PUBLIC_KEY.exec(bytes.toString("latin1"))?.[1];
  if (block === undefined) throw new KeyError("--subject-key must be one PEM PUBLIC KEY block");
  const der = decodeBase64(block.replace(/\r?\n/g, ""));
  if (der === undefined) throw new KeyError("--subject-key must be canonical base64");
  let exported: Buffer;
  let key;
  try {
    key = createPublicKey({ key: Buffer.from(der), format: "der", type: "spki" });
    exported = key.export({ type: "spki", format: "der" });
  } catch {
    // The caught error is dropped: OpenSSL's text can quote the input.
    throw new KeyError("--subject-key must hold a DER SubjectPublicKeyInfo");
  }
  if (!exported.equals(der)) {
    throw new KeyError("--subject-key must hold a DER SubjectPublicKeyInfo");
  }
  const bits = key.asymmetricKeyDetails?.modulusLength ?? 0;
  if (key.asymmetricKeyType !== "rsa" || bits < 2048 || bits > 4096) {
    throw new KeyError("--subject-key must hold an RSA key of 2048 to 4096 bits");
  }
  if (der.length > MAX_SPKI_BYTES) {
    throw new KeyError(
      `--subject-key must encode in at most ${MAX_SPKI_BYTES} bytes, as a 4096-bit key with exponent 65537 does`,
    );
  }
  return der;
}

/** `notBefore` plus the lifetime; 29 February plus whole years rolls to 1 March. */
function expiry(notBefore: Date, lifetime: Lifetime): Date {
  if ("days" in lifetime) return new Date(notBefore.getTime() + lifetime.days * DAY_MS);
  const out = new Date(notBefore);
  out.setUTCFullYear(out.getUTCFullYear() + lifetime.years);
  return out;
}

type Lifetime = { readonly years: number } | { readonly days: number };

interface Issuer {
  readonly path: string;
  readonly subjectKey: string;
}

interface Chain {
  readonly ca: { readonly pathLen?: number } | undefined;
  readonly issuer: Issuer | undefined;
}

interface Request {
  readonly commonName: string;
  readonly lifetime: Lifetime;
  readonly chain: Chain | undefined; // Undefined: P10's form.
}

function parse(args: readonly string[]): Request {
  const usage = args.some((a) => CHAIN_FLAG.test(a)) ? CERTIFICATE_USAGE : DIRECT_USAGE;
  const { values } = parsed(usage, () =>
    parseArgs({
      args: [...args],
      options: {
        "common-name": { type: "string", multiple: true },
        "validity-years": { type: "string", multiple: true },
        ca: { type: "boolean", multiple: true },
        "path-length": { type: "string", multiple: true },
        issuer: { type: "string", multiple: true },
        "subject-key": { type: "string", multiple: true },
        "validity-days": { type: "string", multiple: true },
      },
      strict: true,
      allowPositionals: false,
    }),
  );
  if (usage === DIRECT_USAGE) {
    const commonName = requiredOnce(values, "common-name", usage);
    const years = requiredOnce(values, "validity-years", usage);
    return {
      commonName: checkName(commonName),
      lifetime: { years: checkYears(years) },
      chain: undefined,
    };
  }
  if ((values.ca?.length ?? 0) > 1) throw new PublishError("--ca is given twice");
  const ca = values.ca !== undefined;
  const pathLength = once(values, "path-length");
  const issuer = once(values, "issuer");
  const subjectKey = once(values, "subject-key");
  if (pathLength !== undefined && !ca) {
    throw new PublishError(`--path-length goes only with --ca; ${usage}`);
  }
  if ((issuer === undefined) !== (subjectKey === undefined)) {
    throw new PublishError(`--issuer and --subject-key go together; ${usage}`);
  }
  const commonName = requiredOnce(values, "common-name", usage);
  const years = once(values, "validity-years");
  const days = once(values, "validity-days");
  if (days !== undefined && issuer === undefined) {
    throw new PublishError(`--validity-days goes only with --issuer; ${usage}`);
  }
  if ((years === undefined) === (days === undefined)) {
    throw new PublishError(
      issuer === undefined
        ? `--validity-years is required; ${usage}`
        : `give exactly one of --validity-years and --validity-days; ${usage}`,
    );
  }
  if (pathLength !== undefined && !PATH_LENGTH.test(pathLength)) {
    throw new PublishError("--path-length must be a whole number from 0 to 7");
  }
  if (days !== undefined && (!DAYS.test(days) || Number(days) > MAX_DAYS)) {
    throw new PublishError(`--validity-days must be a whole number from 1 to ${MAX_DAYS}`);
  }
  return {
    commonName: checkName(commonName),
    lifetime: years === undefined ? { days: Number(days) } : { years: checkYears(years) },
    chain: {
      ca: ca ? (pathLength === undefined ? {} : { pathLen: Number(pathLength) }) : undefined,
      issuer:
        issuer === undefined || subjectKey === undefined ? undefined : { path: issuer, subjectKey },
    },
  };
}

function checkName(commonName: string): string {
  if (!COMMON_NAME.test(commonName)) {
    throw new PublishError(
      `--common-name must be 1 to ${MAX_COMMON_NAME} printable ASCII characters, with no space at either end`,
    );
  }
  return commonName;
}

function checkYears(years: string): number {
  if (!YEARS.test(years) || Number(years) > MAX_YEARS) {
    throw new PublishError(`--validity-years must be a whole number from 1 to ${MAX_YEARS}`);
  }
  return Number(years);
}
