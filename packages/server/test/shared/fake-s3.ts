// The fake S3's credentials and its control API, through fetch only, so workerd tests can drive it too.

/** The credentials the fake accepts; any other signature gets 403 SignatureDoesNotMatch. */
export const FAKE_S3 = {
  bucket: "tide",
  region: "auto",
  accessKeyId: "TIDEFAKEACCESSKEY",
  secretAccessKey: "tide-fake-secret",
};

/** A secret that passes configuration checks but is not the fake's. */
export const WRONG_SECRET = "not-the-fake-secret-0123456789";

/** What `stall-body` declares and what it sends before it stops. */
export const STALL_BODY = { size: 64, sent: 32 };

/** Scripted replies in place of a stored object; the fake also serves each one at `script/<behaviour>`. */
export const BEHAVIOURS = [
  "internal-error", // 500 InternalError
  "access-denied", // 403 AccessDenied
  "html-404", // A 404 that is not an S3 error document
  "redirect", // 301 to another path
  "truncated-404", // NoSuchKey, then the connection drops mid-document
  "gzip", // 200 gzip: a valid unfinished prefix of its declared length, never ended
  "no-length", // 200 chunked: one chunk, never ended
  "hang", // Never answers
  "stall", // 500 headers flushed, then no body
  "stall-body", // 200 declaring STALL_BODY.size, then STALL_BODY.sent bytes and nothing more
  "pause-body", // 200 with the stored object's first half; the rest follows `release`
  "oversize", // 200 declaring MAX_IDENTITIES_BYTES + 1, the largest record limit, headers flushed, no body
  "nested-404", // 404 whose only Code is inside another element
  "duplicate-404", // 404 with two Code children
  "encoding-access-key", // 200 whose Content-Encoding is the access key ID
  "encoding-secret", // 200 whose Content-Encoding is the secret
  "length-secret", // 200 whose Content-Length is the secret
  "no-etag", // 200 with the stored body and no ETag
] as const;
export type Behaviour = (typeof BEHAVIOURS)[number];

/** Points in a request's life a test can wait for. */
export type FakeEvent =
  | "arrived" // A correctly signed request reached the fake.
  | "flushed" // A stalling reply's headers, and any partial body, were sent.
  | "abandoned"; // The reply closed before it finished, which only the client can cause.

/** Returns a client for the control API of the fake at `endpoint`. */
export function fakeS3Control(endpoint: string) {
  const call = async (method: string, path: string, body?: string) => {
    const res = await fetch(
      `${endpoint}/_fake/${path}`,
      body === undefined ? { method } : { method, body },
    );
    await res.body?.cancel();
    if (res.status !== 204) throw new Error(`fake S3 ${method} ${path} answered ${res.status}`);
  };
  return {
    /** Makes every later request for `key` get `behaviour`. */
    script: (key: string, behaviour: Behaviour) =>
      call("PUT", `script/${encodeURIComponent(key)}`, behaviour),
    /** Sends the rest of every `pause-body` reply for `key`, now and later. */
    release: (key: string) => call("PUT", `release/${encodeURIComponent(key)}`),
    /** Resolves once `event` has happened for `key`. */
    event: (event: FakeEvent, key: string) =>
      call("GET", `event/${event}/${encodeURIComponent(key)}`),
  };
}
