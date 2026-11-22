import { createHash } from "node:crypto";
import { parseArgs } from "node:util";

import type { Part, StoredReply } from "@tide-ota/protocol";
import {
  HEADER_VALUE,
  MAX_IDENTITIES_BYTES,
  ProtocolError,
  UUID,
  assetHash,
  certificateChain,
  encodeSfvDictionary,
  parseMultipart,
  parseSfvDictionary,
  readLimited,
  replyKey,
  verifyChainedSignature,
  verifyExpoSignature,
} from "@tide-ota/protocol";

import type { Env } from "./keys.ts";
import { BUILD_KEYID, KeyError, buildIdentity, isObject, member } from "./keys.ts";
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
  mismatch: 9,
} as const;

export const PROBE_USAGE =
  "usage: tide probe --server-url <url> --channel <name> --runtime-version <version> --platform ios|android [--app-id <id>]";

/** Per-request deadlines: the manifest's matches a stock client's read timeout; a bundle may be megabytes. */
const MANIFEST_TIMEOUT_MS = 10_000;
const BUNDLE_TIMEOUT_MS = 60_000;
const DIRECTIVES = {
  rollBackToEmbedded: true,
  noUpdateAvailable: true,
} satisfies Record<Exclude<StoredReply["kind"], "manifest">, true>;
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
  readonly runtimeVersion: string;
  readonly key: CryptoKey;
  readonly keyId: string;
  readonly root: string | undefined; // Chain mode: the root the builds embed.
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

  let identity;
  try {
    identity = await buildIdentity(env, Date.now());
  } catch (e) {
    if (!(e instanceof KeyError)) throw e;
    throw usage(e.message);
  }
  const { key, keyId, chain, pem } = identity;

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
    runtimeVersion: runtime,
    key,
    keyId,
    root: chain ? pem : undefined,
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
  // A stock client reads a reply without it as a legacy manifest and rejects it.
  if (res.headers.get("expo-protocol-version") !== "1") {
    await res.body?.cancel();
    throw new ProbeFailure("unparseable", "the reply's expo-protocol-version is not 1");
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
  const chain = parts.find((p) => p.name === "certificate_chain");
  await verify(part, chain, probe);
  let json: unknown;
  try {
    json = JSON.parse(utf8.decode(part.body));
  } catch {
    throw new ProbeFailure("unparseable", `the ${part.name} part is not JSON`);
  }

  if (part.name === "directive") {
    const type = member(json, "type");
    if (typeof type !== "string" || !Object.hasOwn(DIRECTIVES, type)) {
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
  // A client never launches an update built for another runtime, so a misrouted pointer must fail here.
  if (member(json, "runtimeVersion") !== probe.runtimeVersion) {
    throw new ProbeFailure(
      "mismatch",
      "the manifest is for another runtime version than requested",
    );
  }
  if (excluded(res.headers.get("expo-manifest-filters"), member(json, "metadata"))) {
    throw new ProbeFailure(
      "mismatch",
      "the manifest's metadata does not match expo-manifest-filters",
    );
  }
  const target = typeof url === "string" ? URL.parse(url) : null;
  if (target === null || !(target.protocol === "https:" || target.protocol === "http:")) {
    throw new ProbeFailure("unparseable", "the manifest's launchAsset.url is not an http(s) URL");
  }
  await checkBundle(target.href, hash, timeoutMs ?? BUNDLE_TIMEOUT_MS);
  return [`manifest ${id}: signature verified`, `launch asset ${hash}: SHA-256 verified`];
}

/**
 * Verifies the part's expo-signature over its exact bytes, as a client configured for code signing does; in chain
 * mode under the leaf of the served `chain` over the pinned root, now, with the keyid ignored.
 */
async function verify(part: Part, chain: Part | undefined, { key, keyId, root }: Probe) {
  const fail = (message: string) =>
    new ProbeFailure("signature", `the ${part.name} part ${message}`);
  if (part.signature === undefined) throw fail("has no expo-signature");
  if (root !== undefined) {
    if (chain === undefined)
      throw new ProbeFailure("signature", "the reply has no certificate_chain part");
    let leaf;
    try {
      leaf = await certificateChain(chain.body, root, new Date());
    } catch (e) {
      if (!(e instanceof ProtocolError)) throw e;
      // The message names roles and rules only, never reply data.
      throw new ProbeFailure(
        "signature",
        `the reply's certificate chain fails the client's rules: ${e.message}`,
      );
    }
    try {
      await verifyChainedSignature(part.body, part.signature, leaf);
    } catch (e) {
      if (!(e instanceof ProtocolError)) throw e;
      throw fail(
        e.field === "signature.sig"
          ? "does not verify under the served leaf"
          : "has a malformed expo-signature",
      );
    }
    return;
  }
  try {
    await verifyExpoSignature(part.body, part.signature, key, keyId);
  } catch (e) {
    if (!(e instanceof ProtocolError)) throw e;
    throw fail(
      e.field === "signature.keyid"
        ? `is signed under another keyid than ${BUILD_KEYID}`
        : e.field === "signature.sig"
          ? "does not verify under the pinned certificate"
          : "has a malformed expo-signature",
    );
  }
}

/**
 * True when a stock client would drop the manifest: a filter names a metadata key (iOS ignores its case) whose value
 * differs. A missing header or metadata filters nothing.
 */
function excluded(header: string | null, metadata: unknown): boolean {
  if (header === null) return false;
  let filters;
  try {
    filters = parseSfvDictionary(header, "expo-manifest-filters");
  } catch {
    filters = undefined;
  }
  if (filters === undefined || [...filters.values()].some((m) => m.kind !== "string")) {
    throw new ProbeFailure(
      "unparseable",
      "the reply's expo-manifest-filters is not a dictionary of strings",
    );
  }
  if (!isObject(metadata)) return false;
  return Object.entries(metadata).some(([key, value]) => {
    const filter = filters.get(key.toLowerCase());
    return filter?.kind === "string" && value !== filter.text;
  });
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
  let body: Uint8Array<ArrayBuffer> | undefined;
  try {
    body = await readLimited(res, MAX_IDENTITIES_BYTES);
  } catch {
    throw new ProbeFailure("unreachable", "GET /manifest failed: the body did not arrive in time");
  }
  if (body === undefined) {
    throw new ProbeFailure("unparseable", `the reply is over ${MAX_IDENTITIES_BYTES} bytes`);
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
