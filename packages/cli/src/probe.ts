import { createHash } from "node:crypto";
import { parseArgs } from "node:util";

import type { Part } from "@tide/protocol";
import {
  HEADER_VALUE,
  MAX_REPLY_BYTES,
  ProtocolError,
  UUID,
  assetHash,
  codeSigningCertificate,
  encodeSfvDictionary,
  parseExpoSignature,
  parseMultipart,
  replyKey,
  verifyExpoSignature,
} from "@tide/protocol";

import type { Env } from "./keys.ts";
import { member, read, readSmallFile } from "./keys.ts";
import { urlBase } from "./publish-record.ts";

/** Exit codes by failure class; 1 is left to Node's exit on an uncaught error, so it always means a bug. */
export const PROBE_EXIT = {
  usage: 2,
  unreachable: 3,
  status: 4,
  unparseable: 5,
  signature: 6,
  bundleMissing: 7,
  bundleHash: 8,
} as const;

export const PROBE_USAGE =
  "usage: tide probe --server-url <url> --channel <name> --runtime-version <version> --platform ios|android [--app-id <id>]";

/** Per-request deadlines: the manifest's matches a stock client's read timeout; a bundle may be megabytes. */
const MANIFEST_TIMEOUT_MS = 10_000;
const BUNDLE_TIMEOUT_MS = 60_000;
const CERTIFICATE_FILE = "TIDE_BUILD_CERTIFICATE_FILE";
const CERTIFICATE_PEM = "TIDE_BUILD_CERTIFICATE";
const KEYID = "TIDE_BUILD_KEYID";
const DIRECTIVES = new Set(["rollBackToEmbedded", "noUpdateAvailable"]);
const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** A failed probe. Its message is fixed text and statuses, never a header value, key or response body. */
class ProbeFailure extends Error {
  readonly failure: keyof typeof PROBE_EXIT;

  constructor(failure: keyof typeof PROBE_EXIT, message: string) {
    super(message);
    this.name = "ProbeFailure";
    this.failure = failure;
  }
}

interface Probe {
  readonly manifestUrl: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly key: CryptoKey;
  readonly keyId: string;
}

/**
 * Fetches `/manifest` as a stock client would and verifies the signed part against the pinned certificate and keyid,
 * then a manifest's launch asset against its hash. Returns 0 or the `PROBE_EXIT` code of the first failure.
 */
export async function probe(
  args: readonly string[],
  env: Env,
  io: { readonly out: (line: string) => void; readonly err: (line: string) => void },
  options: { readonly timeoutMs?: number } = {},
): Promise<number> {
  try {
    const config = await configure(args, env);
    for (const line of await check(config, options.timeoutMs)) io.out(line);
    return 0;
  } catch (e) {
    if (!(e instanceof ProbeFailure)) throw e;
    io.err(`tide: ${e.message}`);
    return PROBE_EXIT[e.failure];
  }
}

async function configure(args: readonly string[], env: Env): Promise<Probe> {
  const usage = (message: string) => new ProbeFailure("usage", message);
  let values;
  try {
    ({ values } = parseArgs({
      args: [...args],
      options: {
        "server-url": { type: "string" },
        channel: { type: "string" },
        "runtime-version": { type: "string" },
        platform: { type: "string" },
        "app-id": { type: "string" },
      },
      strict: true,
      allowPositionals: false,
    }));
  } catch {
    throw usage(`unrecognised arguments; ${PROBE_USAGE}`);
  }
  const { channel, platform } = values;
  const server = values["server-url"];
  const runtime = values["runtime-version"];
  const appId = values["app-id"];
  if (server === undefined || channel === undefined || runtime === undefined) {
    throw usage(`--server-url, --channel and --runtime-version are required; ${PROBE_USAGE}`);
  }
  if (platform !== "ios" && platform !== "android") {
    throw usage("--platform must be ios or android");
  }
  const base = urlBase(server);
  if (base === undefined) {
    throw usage(
      "--server-url must be an https URL with no credentials, query or fragment (http only to a loopback IP)",
    );
  }
  try {
    replyKey(channel, runtime, platform);
  } catch (e) {
    if (!(e instanceof ProtocolError)) throw e;
    const flag = e.field === "channel" ? "--channel" : "--runtime-version";
    throw usage(`${flag} ${e.message.slice(e.field.length + 1)}`);
  }
  if (appId !== undefined && !HEADER_VALUE.test(appId)) {
    throw usage("--app-id must be printable ASCII without edge whitespace");
  }

  const keyId = read(env, KEYID);
  if (keyId === undefined) throw usage(`${KEYID} is not set: set it to the keyid the builds embed`);
  if (!/^[\x20-\x7E]+$/.test(keyId)) throw usage(`${KEYID} must be printable ASCII`);
  const file = read(env, CERTIFICATE_FILE);
  const value = read(env, CERTIFICATE_PEM);
  if ((file === undefined) === (value === undefined)) {
    throw usage(`set exactly one of ${CERTIFICATE_FILE} and ${CERTIFICATE_PEM}`);
  }
  const source = file === undefined ? CERTIFICATE_PEM : CERTIFICATE_FILE;
  const pem = file === undefined ? value : readSmallFile(file)?.toString("utf8");
  if (pem === undefined) {
    throw usage(`${CERTIFICATE_FILE} unreadable: not a regular file of at most 64 KiB`);
  }
  let key: CryptoKey;
  try {
    ({ key } = await codeSigningCertificate(pem, new Date()));
  } catch (e) {
    if (!(e instanceof ProtocolError)) throw e;
    throw usage(`${source}: ${e.message}`);
  }

  return {
    manifestUrl: `${base}/manifest`,
    headers: {
      "expo-protocol-version": "1",
      "expo-platform": platform,
      "expo-runtime-version": runtime,
      "expo-channel-name": channel,
      "expo-expect-signature": `sig, ${encodeSfvDictionary({ keyid: keyId, alg: "rsa-v1_5-sha256" })}`,
      accept: "multipart/mixed",
      ...(appId !== undefined && { "expo-app-id": appId }),
    },
    key,
    keyId,
  };
}

/** Returns the report lines of a passing probe. */
async function check(probe: Probe, timeoutMs?: number): Promise<string[]> {
  const res = await get(
    "GET /manifest",
    probe.manifestUrl,
    probe.headers,
    timeoutMs ?? MANIFEST_TIMEOUT_MS,
  );
  if (res.status !== 200) {
    await res.body?.cancel();
    throw new ProbeFailure("status", `GET /manifest answered ${res.status}`);
  }
  const boundary = boundaryOf(res.headers.get("content-type"));
  if (boundary === undefined) {
    await res.body?.cancel();
    throw new ProbeFailure("unparseable", "the reply is not multipart/mixed with a boundary");
  }
  const body = await readReply(res);
  let parts: Part[];
  try {
    parts = parseMultipart(body, boundary);
  } catch {
    throw new ProbeFailure("unparseable", "the reply is not a valid multipart body");
  }
  const signed = parts.filter((p) => p.name === "manifest" || p.name === "directive");
  const [part] = signed;
  if (part === undefined || signed.length > 1) {
    throw new ProbeFailure("unparseable", "the reply must hold one manifest or directive part");
  }
  await verify(part, probe);
  let json: unknown;
  try {
    json = JSON.parse(utf8.decode(part.body));
  } catch {
    throw new ProbeFailure("unparseable", `the ${part.name} part is not JSON`);
  }

  if (part.name === "directive") {
    const type = member(json, "type");
    if (typeof type !== "string" || !DIRECTIVES.has(type)) {
      throw new ProbeFailure(
        "unparseable",
        "the directive is not rollBackToEmbedded or noUpdateAvailable",
      );
    }
    return [`directive ${type}: signature verified; a directive has no bundle to check`];
  }
  const id = member(json, "id");
  const launch = member(json, "launchAsset");
  const url = member(launch, "url");
  let hash: string;
  try {
    hash = assetHash(member(launch, "hash"), "hash");
  } catch {
    throw new ProbeFailure("unparseable", "the manifest's launchAsset.hash is not a SHA-256");
  }
  if (typeof id !== "string" || !UUID.test(id)) {
    throw new ProbeFailure("unparseable", "the manifest's id is not a lowercase UUID");
  }
  const target = typeof url === "string" ? URL.parse(url) : null;
  if (target === null || !(target.protocol === "https:" || target.protocol === "http:")) {
    throw new ProbeFailure("unparseable", "the manifest's launchAsset.url is not an http(s) URL");
  }
  await checkBundle(target.href, hash, timeoutMs ?? BUNDLE_TIMEOUT_MS);
  return [`manifest ${id}: signature verified`, `launch asset ${hash}: SHA-256 verified`];
}

/** Verifies the part's expo-signature over its exact bytes, as a client configured for code signing does. */
async function verify(part: Part, { key, keyId }: Probe): Promise<void> {
  const fail = (message: string) =>
    new ProbeFailure("signature", `the ${part.name} part ${message}`);
  if (part.signature === undefined) throw fail("has no expo-signature");
  let signedBy: string;
  try {
    signedBy = parseExpoSignature(part.signature).keyId;
  } catch {
    throw fail("has a malformed expo-signature");
  }
  if (signedBy !== keyId) throw fail(`is signed under another keyid than ${KEYID}`);
  try {
    await verifyExpoSignature(part.body, part.signature, key, keyId);
  } catch {
    throw fail("does not verify under the pinned certificate");
  }
}

/** Fetches the launch asset and compares its SHA-256, streamed, with the manifest's hash. */
async function checkBundle(url: string, hash: string, timeoutMs: number): Promise<void> {
  const label = "GET launch asset";
  const res = await get(label, url, {}, timeoutMs);
  if (res.status !== 200) {
    await res.body?.cancel();
    if (res.status === 404) throw new ProbeFailure("bundleMissing", `${label} answered 404`);
    throw new ProbeFailure("status", `${label} answered ${res.status}`);
  }
  const digest = createHash("sha256");
  try {
    for await (const chunk of bodyOf(res)) digest.update(chunk);
  } catch {
    throw new ProbeFailure("unreachable", `${label} failed: the body did not arrive in time`);
  }
  const got = digest.digest("base64url");
  if (got !== hash) {
    throw new ProbeFailure(
      "bundleHash",
      "the launch asset's SHA-256 differs from the manifest's hash",
    );
  }
}

/** Sends one GET whose deadline also covers reading its body. */
async function get(
  label: string,
  url: string,
  headers: Readonly<Record<string, string>>,
  timeoutMs: number,
): Promise<Response> {
  const signal = AbortSignal.timeout(timeoutMs);
  try {
    return await fetch(url, { headers, signal });
  } catch {
    // The caught error is dropped: its text can quote the URL or the peer.
    throw new ProbeFailure(
      "unreachable",
      signal.aborted
        ? `${label} failed: no reply within ${timeoutMs} ms`
        : `${label} failed: the server could not be reached`,
    );
  }
}

/** Returns the reply body, refusing one over the size the server ever serves. */
async function readReply(res: Response): Promise<Uint8Array<ArrayBuffer>> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for await (const chunk of bodyOf(res)) {
      size += chunk.length;
      if (size > MAX_REPLY_BYTES) break;
      chunks.push(chunk);
    }
  } catch {
    throw new ProbeFailure("unreachable", "GET /manifest failed: the body did not arrive in time");
  }
  // Breaking out of the loop has already cancelled the rest of the body.
  if (size > MAX_REPLY_BYTES) {
    throw new ProbeFailure("unparseable", `the reply is over ${MAX_REPLY_BYTES} bytes`);
  }
  const body = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    body.set(c, at);
    at += c.length;
  }
  return body;
}

/** Returns the boundary of a `multipart/mixed` Content-Type, unquoted, or undefined. */
function boundaryOf(contentType: string | null): string | undefined {
  const [type = "", ...params] = (contentType ?? "").split(";");
  if (type.trim().toLowerCase() !== "multipart/mixed") return undefined;
  for (const param of params) {
    const eq = param.indexOf("=");
    if (eq !== -1 && param.slice(0, eq).trim().toLowerCase() === "boundary") {
      return param
        .slice(eq + 1)
        .trim()
        .replace(/^"(.*)"$/, "$1");
    }
  }
  return undefined;
}

/** The response body; a reply without one reads as empty. */
const bodyOf = (res: Response): ReadableStream<Uint8Array> => res.body ?? new ReadableStream();
