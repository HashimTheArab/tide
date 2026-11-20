import { ProtocolError, hex, sha256Hex } from "./hash.ts";

/** An S3-compatible bucket, addressed path-style. */
export interface S3Config {
  readonly endpoint: string; // An http(s) origin with no path.
  readonly region: string;
  readonly bucket: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
}

/** A validated `S3Config`, ready for `s3Fetch`. */
export interface S3Target {
  readonly endpoint: URL;
  readonly bucket: string;
  readonly credentials: SigV4Credentials;
}

export interface SigV4Credentials {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly region: string;
  readonly service: string;
}

export interface S3Request {
  readonly method: "GET" | "PUT" | "DELETE";
  readonly key?: string; // Absent: the bucket itself.
  readonly query?: Readonly<Record<string, string>>;
  readonly headers?: Readonly<Record<string, string>>; // Lowercase names; each is signed.
  readonly body?: Uint8Array<ArrayBuffer>;
}

export type S3Operation = "GetObject" | "PutObject" | "DeleteObject" | "ListObjectsV2";

/** Error codes a message may name; S3 defines many more, and any other is reported as unrecognised. */
const S3_ERROR_CODES: ReadonlySet<string> = new Set([
  "AccessDenied",
  "InvalidAccessKeyId",
  "SignatureDoesNotMatch",
  "RequestTimeTooSkewed",
  "NoSuchKey",
  "NoSuchBucket",
  "PreconditionFailed",
  "ConditionalRequestConflict",
  "InvalidArgument",
  "InvalidRequest",
  "XAmzContentSHA256Mismatch",
  "SlowDown",
  "InternalError",
  "ServiceUnavailable",
]);

/** What can be wrong with a 200; each is reported in these fixed words, never with the value received. */
const PROBLEMS = {
  encoding: "an unsupported content-encoding",
  length: "a missing or invalid content-length",
  body: "a body that differs from its content-length",
  over: "a content-length over the caller's limit",
  etag: "a missing or invalid ETag",
  date: "a missing or invalid Date",
  listing: "an invalid listing page",
} as const;
export type S3Problem = keyof typeof PROBLEMS;

type S3Failure =
  | { readonly status: number; readonly code: string | undefined }
  | { readonly problem: S3Problem }
  | { readonly timeoutMs: number }
  | "network";

/**
 * An S3 failure. Its message holds only fixed words, the operation, the HTTP status and an allowlisted error code,
 * so no provider text, key or credential can reach a log.
 */
export class S3Error extends Error {
  readonly status: number | undefined; // Undefined when no response arrived.

  constructor(operation: S3Operation, failure: S3Failure) {
    super(s3Message(operation, failure));
    this.name = "S3Error";
    this.status =
      failure === "network" || "timeoutMs" in failure
        ? undefined
        : "problem" in failure
          ? 200
          : failure.status;
  }

  /** The error for a request that got no response: a timeout when the deadline aborted it, else a network failure. */
  static unanswered(operation: S3Operation, aborted: boolean, timeoutMs: number): S3Error {
    return new S3Error(operation, aborted ? { timeoutMs } : "network");
  }
}

function s3Message(operation: S3Operation, failure: S3Failure): string {
  const what = `S3 ${operation}`;
  if (failure === "network") return `${what} failed: network error`;
  if ("timeoutMs" in failure) return `${what} timed out after ${failure.timeoutMs} ms`;
  if ("problem" in failure) return `${what} returned 200 with ${PROBLEMS[failure.problem]}`;
  const { status, code } = failure;
  if (code === undefined) return `${what} failed: ${status} without an S3 error document`;
  if (S3_ERROR_CODES.has(code)) return `${what} failed: ${status} ${code}`;
  return `${what} failed: ${status} with an unrecognised error code`;
}

export const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const ERROR_BODY_LIMIT = 4096;
const encoder = new TextEncoder();

/** Returns the validated target; no message echoes a value, since a rejected one may carry a credential. */
export function s3Target(config: S3Config): S3Target {
  const endpoint = URL.parse(config.endpoint);
  if (
    !endpoint ||
    !/^https?:$/.test(endpoint.protocol) ||
    endpoint.href !== `${endpoint.origin}/`
  ) {
    throw new ProtocolError(
      "endpoint",
      "must be an http or https origin with no credentials, path or query",
    );
  }
  // One path segment that cannot be a dot segment or carry a query: the request cannot leave the bucket.
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(config.bucket)) {
    throw new ProtocolError(
      "bucket",
      "must be 3 to 63 of a-z, 0-9, . and -, starting and ending alphanumeric",
    );
  }
  return { endpoint, bucket: config.bucket, credentials: sigV4Credentials(config, "s3") };
}

/** Returns validated credentials for `service`; a rejected one throws a `ProtocolError` naming the field, never the value. */
export function sigV4Credentials(
  config: Pick<S3Config, "region" | "accessKeyId" | "secretAccessKey">,
  service: string,
): SigV4Credentials {
  const { region, accessKeyId, secretAccessKey } = config;
  if (!/^[a-z0-9-]{1,32}$/.test(region)) {
    throw new ProtocolError("region", "must be 1 to 32 of a-z, 0-9 and -");
  }
  // Header-safe: printable ASCII with no whitespace.
  if (!/^[A-Za-z0-9]{16,128}$/.test(accessKeyId)) {
    throw new ProtocolError("accessKeyId", "must be 16 to 128 of A-Z, a-z and 0-9");
  }
  if (!/^[\x21-\x7E]{16,256}$/.test(secretAccessKey)) {
    throw new ProtocolError("secretAccessKey", "must be 16 to 256 printable ASCII characters");
  }
  return { accessKeyId, secretAccessKey, region, service };
}

/** Signs and sends one S3 request through `awsFetch`. */
export function s3Fetch(
  target: S3Target,
  request: S3Request,
  signal: AbortSignal,
): Promise<Response> {
  // S3 reads a literal + in a path as a space, so each segment is sent in SigV4's encoding.
  const path =
    request.key === undefined
      ? `/${target.bucket}`
      : `/${target.bucket}/${request.key.split("/").map(uriEncode).join("/")}`;
  const query = Object.entries(request.query ?? {})
    .map(([k, v]) => `${uriEncode(k)}=${uriEncode(v)}`)
    .join("&");
  const url = new URL(query === "" ? path : `${path}?${query}`, target.endpoint);
  return awsFetch({ ...request, url }, target.credentials, signal);
}

/**
 * Signs and sends one request with every header given. A 3xx is returned, never followed. Network failures reject
 * with fetch's own error, which the caller replaces with its own.
 */
export async function awsFetch(
  request: {
    readonly method: string;
    readonly url: URL;
    readonly headers?: Readonly<Record<string, string>>; // Lowercase names.
    readonly body?: Uint8Array<ArrayBuffer>;
  },
  credentials: SigV4Credentials,
  signal: AbortSignal,
): Promise<Response> {
  const { method, url, body } = request;
  const signed: Record<string, string> = {
    ...request.headers,
    host: url.host,
    "x-amz-content-sha256": body === undefined ? EMPTY_SHA256 : await sha256Hex(body),
    "x-amz-date": new Date().toISOString().replace(/[-:]|\.\d{3}/g, ""),
  };
  const authorization = await signV4({ method, url, headers: signed }, credentials);
  const { host: _, ...headers } = signed; // fetch sets Host itself.
  return fetch(url, {
    method,
    headers: { ...headers, authorization },
    ...(body === undefined ? {} : { body }),
    redirect: "manual", // workerd has no "error" mode; a 3xx sends no credential to another origin.
    signal,
  });
}

/** Returns the SigV4 `Authorization` value for a request, signing its query and every header given. */
export async function signV4(
  request: { method: string; url: URL; headers: Readonly<Record<string, string>> },
  credentials: SigV4Credentials,
): Promise<string> {
  const headers = Object.entries(request.headers)
    .map(([k, v]) => [k.toLowerCase(), v.trim().replace(/\s+/g, " ")] as const)
    .sort(([a], [b]) => compare(a, b));
  const header = (name: string) => headers.find(([k]) => k === name)?.[1];
  const date = header("x-amz-date");
  const payloadHash = header("x-amz-content-sha256");
  if (date === undefined || !/^\d{8}T\d{6}Z$/.test(date) || payloadHash === undefined) {
    throw new Error("signV4 needs x-amz-date and x-amz-content-sha256 headers");
  }
  const search = request.url.search.slice(1);
  const query = (search === "" ? [] : search.split("&"))
    .map((pair) => {
      const eq = pair.indexOf("=");
      const [name, value] = eq === -1 ? [pair, ""] : [pair.slice(0, eq), pair.slice(eq + 1)];
      return [uriEncode(decodeURIComponent(name)), uriEncode(decodeURIComponent(value))] as const;
    })
    .sort(([an, av], [bn, bv]) => compare(an, bn) || compare(av, bv));

  const signedHeaders = headers.map(([k]) => k).join(";");
  const canonicalRequest = [
    request.method,
    request.url.pathname
      .split("/")
      .map((s) => uriEncode(decodeURIComponent(s)))
      .join("/"),
    query.map(([n, v]) => `${n}=${v}`).join("&"),
    headers.map(([k, v]) => `${k}:${v}\n`).join(""),
    signedHeaders,
    payloadHash,
  ].join("\n");
  const scope = `${date.slice(0, 8)}/${credentials.region}/${credentials.service}/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    date,
    scope,
    await sha256Hex(new Uint8Array(encoder.encode(canonicalRequest))),
  ].join("\n");

  let key = new Uint8Array(encoder.encode(`AWS4${credentials.secretAccessKey}`));
  for (const part of scope.split("/")) key = await hmac(key, part);
  const signature = hex(await hmac(key, stringToSign));
  return `AWS4-HMAC-SHA256 Credential=${credentials.accessKeyId}/${scope},SignedHeaders=${signedHeaders},Signature=${signature}`;
}

/** Returns what makes a 200 unusable as one whole unencoded object, or undefined. */
export function s3BodyProblem(res: Response): S3Problem | undefined {
  const encoding = res.headers.get("content-encoding");
  // Tide stores objects unencoded; fetch would also decode gzip without changing the length.
  if (encoding !== null && encoding !== "identity") return "encoding";
  const length = res.headers.get("content-length");
  if (
    res.body === null ||
    length === null ||
    !/^\d+$/.test(length) ||
    !Number.isSafeInteger(Number(length))
  ) {
    return "length";
  }
  return undefined;
}

/**
 * Returns the `Code` of a complete S3 error document of at most 4 KiB: root `Error` with exactly one direct,
 * text-only `Code` child. Anything else is undefined; a body that fails mid-read rejects.
 */
export async function s3ErrorCode(res: Response): Promise<string | undefined> {
  const root = parseS3Xml((await readS3Text(res, ERROR_BODY_LIMIT)) ?? "");
  if (root?.name !== "Error") return undefined;
  const codes = childElements(root, "Code");
  const code = codes.length === 1 && codes[0] !== undefined ? textOf(codes[0]) : undefined;
  return code === "" ? undefined : code;
}

/** Returns undefined for a 404 `NoSuchKey`, the one non-200 that means absence; any other response throws. */
export async function s3Absent(operation: S3Operation, res: Response): Promise<undefined> {
  const code = await s3ErrorCode(res);
  if (res.status === 404 && code === "NoSuchKey") return undefined;
  throw new S3Error(operation, { status: res.status, code });
}

/**
 * Returns a body of at most `limit` bytes as text, or undefined when it is absent, longer, or not valid UTF-8; the
 * read stops at the limit. A body that fails mid-read rejects.
 */
export async function readS3Text(res: Response, limit: number): Promise<string | undefined> {
  if (res.body === null) return undefined;
  const bytes = await readLimited(res, limit);
  if (bytes === undefined) return undefined;
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    return undefined;
  }
}

/** Returns the body's bytes, empty when absent, or undefined once it passes `limit`, cancelling the rest. */
export async function readLimited(
  res: Response,
  limit: number,
): Promise<Uint8Array<ArrayBuffer> | undefined> {
  if (res.body === null) return new Uint8Array(0);
  const reader: ReadableStreamDefaultReader<Uint8Array> = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      return undefined;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    bytes.set(c, at);
    at += c.byteLength;
  }
  return bytes;
}

export interface XmlElement {
  readonly name: string;
  readonly children: readonly (XmlElement | string)[];
}

const S3_NAMESPACE = "http://s3.amazonaws.com/doc/2006-03-01/";
const XML_DECLARATION = /<\?xml [^<>?]*\?>/y;
const WHITESPACE = /[ \t\r\n]*/y;
const ELEMENT_NAME = /[A-Za-z_][A-Za-z0-9._-]*/y; // No colon: prefixed names are rejected.
const TAG_REST = /(?:[ \t\r\n]+xmlns="([^"<&]*)")?[ \t\r\n]*(\/?)>/y;
const ENTITIES: Readonly<Record<string, string>> = {
  lt: "<",
  gt: ">",
  amp: "&",
  quot: '"',
  apos: "'",
};

/**
 * Returns the element tree of one S3 response document, or undefined. Strict: an optional XML declaration, elements
 * and text with the predefined entities and character references; no comments, CDATA, DOCTYPE, processing
 * instructions, prefixed names, or attributes other than the S3 namespace on the root.
 */
export function parseS3Xml(text: string): XmlElement | undefined {
  let at = 0;
  const skip = (re: RegExp) => {
    re.lastIndex = at;
    if (re.test(text)) at = re.lastIndex;
  };
  skip(XML_DECLARATION);
  skip(WHITESPACE);
  const open: { name: string; children: (XmlElement | string)[] }[] = [];
  let root: XmlElement | undefined;
  while (root === undefined) {
    const parent = open.at(-1);
    if (text[at] !== "<") {
      const end = text.indexOf("<", at);
      if (parent === undefined || end === -1) return undefined;
      const decoded = decodeText(text.slice(at, end));
      if (decoded === undefined) return undefined;
      parent.children.push(decoded);
      at = end;
    } else if (text.startsWith("</", at)) {
      if (parent === undefined || !text.startsWith(`</${parent.name}`, at)) return undefined;
      at += parent.name.length + 2;
      skip(WHITESPACE);
      if (text[at] !== ">") return undefined;
      at++;
      open.pop();
      if (open.length === 0) root = parent;
    } else {
      ELEMENT_NAME.lastIndex = at + 1;
      const name = ELEMENT_NAME.exec(text)?.[0];
      if (name === undefined) return undefined;
      TAG_REST.lastIndex = ELEMENT_NAME.lastIndex;
      const rest = TAG_REST.exec(text);
      if (rest === null) return undefined;
      const xmlns = rest[1];
      if (xmlns !== undefined && (parent !== undefined || xmlns !== S3_NAMESPACE)) return undefined;
      at = TAG_REST.lastIndex;
      const element = { name, children: [] };
      parent?.children.push(element);
      if (rest[2] !== "/") open.push(element);
      else if (parent === undefined) root = element;
    }
  }
  skip(WHITESPACE);
  return at === text.length ? root : undefined;
}

function decodeText(raw: string): string | undefined {
  if (raw.includes("]]>")) return undefined;
  const [first = "", ...rest] = raw.split("&");
  let text = first;
  for (const part of rest) {
    const m = /^(?:([a-z]+)|#([0-9]{1,7})|#x([0-9a-fA-F]{1,6}));/.exec(part);
    if (m === null) return undefined;
    const [ref, name, dec, hexDigits] = m;
    const point = dec !== undefined ? Number(dec) : parseInt(hexDigits ?? "", 16);
    const char =
      name !== undefined
        ? ENTITIES[name]
        : point === 0x9 ||
            point === 0xa ||
            point === 0xd ||
            (point >= 0x20 && point <= 0xd7ff) ||
            (point >= 0xe000 && point <= 0xfffd) ||
            (point >= 0x10000 && point <= 0x10ffff)
          ? String.fromCodePoint(point)
          : undefined;
    if (char === undefined) return undefined;
    text += char + part.slice(ref.length);
  }
  return text;
}

/** Returns the direct children of `element` named `name`. */
export function childElements(element: XmlElement, name: string): XmlElement[] {
  return element.children.filter((c): c is XmlElement => typeof c !== "string" && c.name === name);
}

/** Returns the text of an element holding only text ("" when empty), or undefined. */
export function textOf(element: XmlElement): string | undefined {
  let text = "";
  for (const c of element.children) {
    if (typeof c !== "string") return undefined;
    text += c;
  }
  return text;
}

// The TIDE_ prefix keeps ambient AWS credentials out.
const S3_VARS = {
  endpoint: "TIDE_S3_ENDPOINT",
  region: "TIDE_S3_REGION",
  bucket: "TIDE_S3_BUCKET",
  accessKeyId: "TIDE_S3_ACCESS_KEY_ID",
  secretAccessKey: "TIDE_S3_SECRET_ACCESS_KEY",
} as const satisfies Record<keyof S3Config, string>;

/** Returns the store the environment configures: TIDE_DISK_DIR, or every TIDE_S3_* variable. Empty means unset. */
export function storageFromEnv(
  env: Readonly<Record<string, string | undefined>>,
): { readonly disk: string } | { readonly s3: S3Config } {
  const read = (name: string) => (env[name] === "" ? undefined : env[name]);
  const disk = read("TIDE_DISK_DIR");
  const names = Object.values(S3_VARS);
  const missing = names.filter((name) => read(name) === undefined);

  if (missing.length === names.length) {
    if (disk !== undefined) return { disk };
    throw new Error(`no store configured: set TIDE_DISK_DIR, or all of ${names.join(", ")}`);
  }
  if (disk !== undefined) throw new Error("set TIDE_DISK_DIR or the TIDE_S3_* variables, not both");
  if (missing.length > 0) throw new Error(`S3 store incomplete: set ${missing.join(", ")}`);
  const config = Object.fromEntries(
    Object.entries(S3_VARS).map(([field, name]) => [field, read(name)]),
  ) as Record<keyof S3Config, string>;
  try {
    s3Target(config);
  } catch (e) {
    if (!(e instanceof ProtocolError)) throw e;
    throw new Error(`${S3_VARS[e.field as keyof S3Config]}: ${e.message}`);
  }
  return { s3: config };
}

/** RFC 3986 encoding, as SigV4 requires: everything but unreserved characters. */
const uriEncode = (s: string): string =>
  encodeURIComponent(s).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );

async function hmac(key: Uint8Array<ArrayBuffer>, data: string): Promise<Uint8Array<ArrayBuffer>> {
  const k = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, encoder.encode(data)));
}

const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
