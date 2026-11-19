import type { Store, StoredObject } from "./store.ts";

/** An S3-compatible bucket, read path-style; the credentials need only s3:GetObject and s3:ListBucket. */
export interface S3Config {
  readonly endpoint: string; // An http(s) origin with no path.
  readonly region: string;
  readonly bucket: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly timeoutMs?: number; // Until a 200's headers, or a non-200's error body, have arrived.
}

interface SigV4Credentials {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly region: string;
  readonly service: string;
}

const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const ERROR_BODY_LIMIT = 4096;
const encoder = new TextEncoder();

/** Returns a store that reads objects with signed GetObject requests. */
export function s3Store(config: S3Config): Store {
  const endpoint = new URL(config.endpoint);
  if (!/^https?:$/.test(endpoint.protocol) || endpoint.href !== `${endpoint.origin}/`) {
    throw new Error(
      `S3 endpoint must be an http or https origin with no path, got ${config.endpoint}`,
    );
  }
  const timeoutMs = config.timeoutMs ?? 10_000;
  const credentials = { ...config, service: "s3" };

  return {
    async get(key) {
      const path = [config.bucket, ...key.split("/")].map(uriEncode).join("/");
      const url = new URL(`/${path}`, endpoint);
      const signed = {
        host: url.host,
        "x-amz-content-sha256": EMPTY_SHA256,
        "x-amz-date": new Date().toISOString().replace(/[-:]|\.\d{3}/g, ""),
      };
      const authorization = await signV4({ method: "GET", url, headers: signed }, credentials);
      const { host: _, ...headers } = signed; // fetch sets Host itself.

      const what = `S3 GetObject ${key}`;
      const timeout = new Error(`${what} timed out after ${timeoutMs} ms`);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(timeout), timeoutMs);
      try {
        const res = await fetch(url, {
          headers: { ...headers, authorization },
          redirect: "error",
          signal: controller.signal,
        });
        if (res.status === 200) {
          clearTimeout(timer); // A long download must not be cut off.
          return await objectOf(res, what);
        }
        const code = await errorCode(res);
        if (res.status === 404 && code === "NoSuchKey") return undefined;
        throw new Error(`${what} failed: ${res.status} ${code ?? "without an S3 error document"}`);
      } catch (e) {
        throw controller.signal.aborted ? timeout : e;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

/** Returns the SigV4 `Authorization` value for a request without a query, signing every header given. */
export async function signV4(
  request: { method: string; url: URL; headers: Readonly<Record<string, string>> },
  credentials: SigV4Credentials,
): Promise<string> {
  if (request.url.search !== "") throw new Error("signV4 does not sign a query string");
  const headers = Object.entries(request.headers)
    .map(([k, v]) => [k.toLowerCase(), v.trim().replace(/\s+/g, " ")] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const header = (name: string) => headers.find(([k]) => k === name)?.[1];
  const date = header("x-amz-date");
  const payloadHash = header("x-amz-content-sha256");
  if (date === undefined || !/^\d{8}T\d{6}Z$/.test(date) || payloadHash === undefined) {
    throw new Error("signV4 needs x-amz-date and x-amz-content-sha256 headers");
  }

  const signedHeaders = headers.map(([k]) => k).join(";");
  const canonicalRequest = [
    request.method,
    request.url.pathname
      .split("/")
      .map((s) => uriEncode(decodeURIComponent(s)))
      .join("/"),
    "",
    headers.map(([k, v]) => `${k}:${v}\n`).join(""),
    signedHeaders,
    payloadHash,
  ].join("\n");
  const scope = `${date.slice(0, 8)}/${credentials.region}/${credentials.service}/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    date,
    scope,
    hex(await crypto.subtle.digest("SHA-256", encoder.encode(canonicalRequest))),
  ].join("\n");

  let key = new Uint8Array(encoder.encode(`AWS4${credentials.secretAccessKey}`));
  for (const part of scope.split("/")) key = await hmac(key, part);
  const signature = hex(await hmac(key, stringToSign));
  return `AWS4-HMAC-SHA256 Credential=${credentials.accessKeyId}/${scope},SignedHeaders=${signedHeaders},Signature=${signature}`;
}

async function objectOf(res: Response, what: string): Promise<StoredObject> {
  if (res.body === null) throw new Error(`${what} returned 200 with no body`);
  const length = res.headers.get("content-length");
  const encoding = res.headers.get("content-encoding");
  // Tide stores objects unencoded; fetch would also decode gzip without changing the length.
  const problem =
    encoding !== null && encoding !== "identity"
      ? `content-encoding ${encoding}`
      : length === null || !/^\d+$/.test(length) || !Number.isSafeInteger(Number(length))
        ? `content-length ${length ?? "missing"}`
        : undefined;
  if (problem !== undefined) {
    await res.body.cancel(); // Releases the connection.
    throw new Error(`${what} returned 200 with ${problem}`);
  }
  return { body: res.body, size: Number(length) };
}

/** Returns the S3 error code of a complete error document of at most 4 KiB; a truncated read rejects. */
async function errorCode(res: Response): Promise<string | undefined> {
  if (res.body === null) return undefined;
  const reader: ReadableStreamDefaultReader<Uint8Array> = res.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > ERROR_BODY_LIMIT) {
      await reader.cancel();
      return undefined;
    }
    text += decoder.decode(value, { stream: true });
  }
  text += decoder.decode();
  if (!/^\s*(?:<\?xml[^>]*\?>\s*)?<Error>[\s\S]*<\/Error>\s*$/.test(text)) return undefined;
  return /<Code>([^<]*)<\/Code>/.exec(text)?.[1];
}

async function hmac(key: Uint8Array<ArrayBuffer>, data: string): Promise<Uint8Array<ArrayBuffer>> {
  const k = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, encoder.encode(data)));
}

const hex = (bytes: ArrayBuffer | Uint8Array) =>
  Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, "0")).join("");

/** RFC 3986 encoding, as SigV4 requires: everything but unreserved characters. */
const uriEncode = (s: string) =>
  encodeURIComponent(s).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
