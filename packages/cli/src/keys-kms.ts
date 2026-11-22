import { createHash } from "node:crypto";

import {
  ProtocolError,
  awsFetch,
  decodeBase64,
  readS3Text,
  sigV4Credentials,
} from "@tide-ota/protocol";

import type { Env, KeySource } from "./keys.ts";
import { KeyError, isObject, read } from "./keys.ts";

/** The KMS signer's variables; the TIDE_ prefix keeps ambient AWS credentials out. */
export const KMS_VARIABLES = {
  keyId: "TIDE_KMS_KEY_ID",
  region: "TIDE_KMS_REGION",
  accessKeyId: "TIDE_KMS_ACCESS_KEY_ID",
  secretAccessKey: "TIDE_KMS_SECRET_ACCESS_KEY",
  sessionToken: "TIDE_KMS_SESSION_TOKEN",
  endpoint: "TIDE_KMS_ENDPOINT",
} as const;
type KmsField = keyof typeof KMS_VARIABLES;
const REQUIRED = ["keyId", "region", "accessKeyId", "secretAccessKey"] as const;

const ALGORITHM = "RSASSA_PKCS1_V1_5_SHA_256";
const RSA = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" } as const;
const KEY_SPECS: Readonly<Record<string, number>> = {
  RSA_2048: 2048,
  RSA_3072: 3072,
  RSA_4096: 4096,
};
const BODY_LIMIT = 16 * 1024;
/** Error codes a message may name; KMS defines more, and any other is reported as unrecognised. */
const ERROR_CODES: ReadonlySet<string> = new Set([
  "AccessDeniedException",
  "ThrottlingException",
  "DisabledException",
  "KMSInvalidStateException",
  "NotFoundException",
  "InvalidKeyUsageException",
  "KeyUnavailableException",
  "DependencyTimeoutException",
  "KMSInternalException",
  "UnrecognizedClientException",
  "InvalidSignatureException",
  "IncompleteSignature",
  "ExpiredTokenException",
  "ValidationException",
]);

/** Returns the validated KMS target; no message echoes a value, since a rejected one may carry a credential. */
function kmsTarget(env: Env) {
  const value = (field: KmsField) => read(env, KMS_VARIABLES[field]);
  const missing = REQUIRED.filter((field) => value(field) === undefined);
  if (missing.length > 0) {
    throw new KeyError(
      `KMS signer incomplete: set ${missing.map((f) => KMS_VARIABLES[f]).join(", ")}`,
    );
  }
  const required = (field: (typeof REQUIRED)[number]) => value(field) ?? ""; // Present: checked above.
  const keyId = required("keyId");
  if (!/^[\x21-\x7E]{1,2048}$/.test(keyId)) {
    throw new KeyError(`${KMS_VARIABLES.keyId} must be 1 to 2048 printable ASCII characters`);
  }
  let credentials;
  try {
    credentials = sigV4Credentials(
      {
        region: required("region"),
        accessKeyId: required("accessKeyId"),
        secretAccessKey: required("secretAccessKey"),
      },
      "kms",
    );
  } catch (e) {
    if (!(e instanceof ProtocolError)) throw e;
    throw new KeyError(`${KMS_VARIABLES[e.field as KmsField]}: ${e.message}`);
  }
  const sessionToken = value("sessionToken");
  if (sessionToken !== undefined && !/^[\x21-\x7E]{1,8192}$/.test(sessionToken)) {
    throw new KeyError(
      `${KMS_VARIABLES.sessionToken} must be 1 to 8192 printable ASCII characters`,
    );
  }
  return {
    endpoint: kmsEndpoint(value("endpoint"), credentials.region),
    keyId,
    credentials,
    sessionToken,
  };
}

/** HTTPS, or plain HTTP to a loopback IP literal only, so credentials never cross a network in the clear. */
function kmsEndpoint(raw: string | undefined, region: string): URL {
  if (raw === undefined) return new URL(`https://kms.${region}.amazonaws.com`);
  const url = URL.parse(raw);
  const loopback =
    url !== null && (/^127(\.\d{1,3}){3}$/.test(url.hostname) || url.hostname === "[::1]");
  if (
    url === null ||
    url.href !== `${url.origin}/` ||
    !(url.protocol === "https:" || (url.protocol === "http:" && loopback))
  ) {
    throw new KeyError(
      `${KMS_VARIABLES.endpoint} must be an https origin, or an http origin on a loopback IP address, with no path`,
    );
  }
  return url;
}

type Target = ReturnType<typeof kmsTarget>;
type Operation = "Sign" | "GetPublicKey";

/**
 * Returns the KMS key the environment configures: `sign` signs the SHA-256 of each part with `Sign` (`DIGEST`), and
 * `publicKey` reads it with `GetPublicKey`. Every failure rejects with a fixed-text `KeyError`, never a result.
 */
export function kmsSource(env: Env, timeoutMs: number): KeySource {
  const target = kmsTarget(env);
  return {
    sign: async (bytes) => {
      // Hashed before any await, as the Signer contract lets the caller reuse `bytes` once this settles.
      const digest = createHash("sha256").update(bytes).digest("base64");
      const text = await call(target, "Sign", timeoutMs, {
        Message: digest,
        MessageType: "DIGEST",
        SigningAlgorithm: ALGORITHM,
      });
      const signature = replySignature(text);
      if (signature === undefined) {
        throw new KeyError("KMS Sign returned 200 with an invalid reply");
      }
      return signature;
    },
    publicKey: async () => await replyPublicKey(await call(target, "GetPublicKey", timeoutMs)),
  };
}

/** Sends one KMS request for `target`'s key and returns a 200's body, undefined when absent, oversize or not UTF-8. */
async function call(
  target: Target,
  operation: Operation,
  timeoutMs: number,
  fields: Readonly<Record<string, string>> = {},
): Promise<string | undefined> {
  const body = new TextEncoder().encode(JSON.stringify({ KeyId: target.keyId, ...fields }));
  const signal = AbortSignal.timeout(timeoutMs);
  let res: Response;
  let text: string | undefined;
  try {
    res = await awsFetch(
      {
        method: "POST",
        url: target.endpoint,
        headers: {
          "content-type": "application/x-amz-json-1.1",
          "x-amz-target": `TrentService.${operation}`,
          ...(target.sessionToken === undefined
            ? {}
            : { "x-amz-security-token": target.sessionToken }),
        },
        body,
      },
      target.credentials,
      signal,
    );
    text = await readS3Text(res, BODY_LIMIT);
  } catch {
    throw new KeyError(
      signal.aborted
        ? `KMS ${operation} timed out after ${timeoutMs} ms`
        : `KMS ${operation} failed: network error`,
    );
  }
  if (res.status !== 200) throw new KeyError(failure(operation, res, text));
  return text;
}

/** Returns a reply's JSON object, or undefined. */
function replyObject(text: string | undefined): Readonly<Record<string, unknown>> | undefined {
  try {
    const json: unknown = JSON.parse(text ?? "");
    return isObject(json) ? json : undefined;
  } catch {
    return undefined;
  }
}

/** Returns the signature in a 200's JSON body, or undefined when any field is missing or malformed. */
function replySignature(text: string | undefined): Uint8Array<ArrayBuffer> | undefined {
  const reply = replyObject(text);
  if (reply?.SigningAlgorithm !== ALGORITHM || typeof reply.Signature !== "string")
    return undefined;
  return decodeBase64(reply.Signature);
}

/** Returns the SubjectPublicKeyInfo of a `GetPublicKey` reply for an RSA signing key that Tide can use. */
async function replyPublicKey(text: string | undefined): Promise<Uint8Array<ArrayBuffer>> {
  const reply = replyObject(text);
  if (reply === undefined)
    throw new KeyError("KMS GetPublicKey returned 200 with an invalid reply");
  if (reply.KeyUsage !== "SIGN_VERIFY") {
    throw new KeyError("KMS key must have key usage SIGN_VERIFY");
  }
  const spec = reply.KeySpec;
  const bits =
    typeof spec === "string" && Object.hasOwn(KEY_SPECS, spec) ? (KEY_SPECS[spec] ?? 0) : 0;
  if (bits === 0) throw new KeyError("KMS key must have key spec RSA_2048, RSA_3072 or RSA_4096");
  const algorithms = reply.SigningAlgorithms;
  if (!Array.isArray(algorithms) || !algorithms.includes(ALGORITHM)) {
    throw new KeyError(`KMS key must allow the signing algorithm ${ALGORITHM}`);
  }
  const spki = typeof reply.PublicKey === "string" ? decodeBase64(reply.PublicKey) : undefined;
  if (spki === undefined || !(await isRsaSpki(spki, bits))) {
    throw new KeyError("KMS GetPublicKey returned 200 with an invalid public key");
  }
  return spki;
}

/** True when `spki` is exactly the DER of an RSA public key of `bits`, as WebCrypto re-exports it. */
async function isRsaSpki(spki: Uint8Array<ArrayBuffer>, bits: number): Promise<boolean> {
  try {
    const key = await crypto.subtle.importKey("spki", spki, RSA, true, ["verify"]);
    const { modulusLength } = key.algorithm as { readonly modulusLength?: number };
    const again = new Uint8Array(await crypto.subtle.exportKey("spki", key));
    return modulusLength === bits && Buffer.from(again).equals(spki);
  } catch {
    return false;
  }
}

/** Returns the fixed message for a non-200, naming the error code only when it is allowlisted. */
function failure(operation: Operation, res: Response, text: string | undefined): string {
  const what = `KMS ${operation} failed: ${res.status}`;
  let raw = res.headers.get("x-amzn-errortype") ?? undefined;
  if (raw === undefined || raw === "") {
    const doc = replyObject(text);
    raw = [doc?.__type, doc?.code].find((v): v is string => typeof v === "string");
  }
  // AWS JSON 1.1 sends `Code:<uri>` in the header and `<namespace>#Code` in the body.
  const code = raw?.split(":")[0]?.split("#").at(-1);
  if (code === undefined || code === "") return `${what} without a KMS error document`;
  if (ERROR_CODES.has(code)) return `${what} ${code}`;
  return `${what} with an unrecognised error code`;
}
