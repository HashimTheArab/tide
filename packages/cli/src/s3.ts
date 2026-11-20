import type { S3Config, S3Operation, S3Request } from "@tide/protocol";
import {
  S3Error,
  childElements,
  parseS3Xml,
  readS3Text,
  s3Absent,
  s3BodyProblem,
  s3ErrorCode,
  s3Fetch,
  s3Target,
  textOf,
} from "@tide/protocol";

import type { Bucket, ListEntry, ObjectHeaders } from "./bucket.ts";
import { BucketError, STRONG_ETAG, byteOrder, checkEtag, checkKey, isKey } from "./bucket.ts";

const LIST_PAGE_LIMIT = 8 * 1024 * 1024;
const IMF_FIXDATE = /^[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/;

/**
 * Returns a bucket over an S3-compatible API (R2, AWS S3), path-style. One deadline covers each operation, body
 * included. A 412 on a conditional PUT is a lost race; every other failure is a `BucketError` built by `S3Error`.
 */
export function s3Bucket(config: S3Config, options: { readonly timeoutMs?: number } = {}): Bucket {
  const target = s3Target(config);
  const { timeoutMs = 60_000 } = options;

  /** Sends one request and runs `handle` on its response, both under one deadline. */
  async function call<T>(
    operation: S3Operation,
    request: S3Request,
    handle: (res: Response) => Promise<T>,
  ): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, timeoutMs);
    try {
      return await handle(await s3Fetch(target, request, controller.signal));
    } catch (e) {
      const error =
        e instanceof S3Error
          ? e
          : S3Error.unanswered(operation, controller.signal.aborted, timeoutMs);
      // A mutation that got no answer, a 5xx, or a 200 it cannot read may still have committed.
      const status = error.status;
      const unknown =
        request.method !== "GET" && (status === undefined || status === 200 || status >= 500);
      throw new BucketError(error.message, unknown ? "unknown" : "failed");
    } finally {
      clearTimeout(timer);
    }
  }

  /** Reads an error response's code once and throws the one error it gives. */
  const failure = async (operation: S3Operation, res: Response): Promise<never> => {
    throw new S3Error(operation, { status: res.status, code: await s3ErrorCode(res) });
  };

  function write(key: string, bytes: Uint8Array<ArrayBuffer>): Promise<string>;
  function write(
    key: string,
    bytes: Uint8Array<ArrayBuffer>,
    condition: Record<string, string>,
    headers?: ObjectHeaders,
  ): Promise<string | undefined>;
  async function write(
    key: string,
    bytes: Uint8Array<ArrayBuffer>,
    condition?: Record<string, string>,
    headers?: ObjectHeaders,
  ): Promise<string | undefined> {
    checkKey(key);
    // Always set and signed: fetch would add an unsigned `cache-control: no-cache` to a conditional request, and S3
    // stores whatever arrives. Objects without public headers are records the server reads, never to be cached.
    const sent = {
      ...condition,
      "cache-control": headers?.cacheControl ?? "no-store",
      ...(headers && { "content-type": headers.contentType }),
    };
    return await call(
      "PutObject",
      { method: "PUT", key, body: bytes, headers: sent },
      async (res) => {
        if (res.status === 412 && condition !== undefined) {
          await res.body?.cancel();
          return undefined;
        }
        if (res.status !== 200) return failure("PutObject", res);
        await res.body?.cancel();
        const etag = res.headers.get("etag");
        if (etag === null || !STRONG_ETAG.test(etag)) {
          throw new S3Error("PutObject", { problem: "etag" });
        }
        return etag;
      },
    );
  }

  /** Sends one listing request and runs `handle` on its validated page. */
  const listPage = <T>(
    query: Readonly<Record<string, string>> & { readonly prefix: string },
    handle: (page: Page, res: Response) => T,
  ): Promise<T> =>
    call("ListObjectsV2", { method: "GET", query }, async (res) => {
      if (res.status !== 200) return failure("ListObjectsV2", res);
      const text = await readS3Text(res, LIST_PAGE_LIMIT);
      const page = text === undefined ? undefined : parsePage(text, query.prefix);
      if (page === undefined) throw invalidListing();
      return handle(page, res);
    });

  return {
    async get(key, maxBytes) {
      checkKey(key);
      return await call("GetObject", { method: "GET", key }, async (res) => {
        if (res.status !== 200) return s3Absent("GetObject", res);
        const etag = res.headers.get("etag");
        const size = Number(res.headers.get("content-length"));
        const problem =
          s3BodyProblem(res) ??
          (etag === null || !STRONG_ETAG.test(etag)
            ? "etag"
            : size > maxBytes
              ? "over"
              : undefined);
        if (problem !== undefined || res.body === null || etag === null) {
          await res.body?.cancel(); // Never buffered: the connection is released.
          throw new S3Error("GetObject", { problem: problem ?? "length" });
        }
        return { bytes: await readExactly(res.body, size), etag };
      });
    },

    put: (key, bytes) => write(key, bytes),

    putIfAbsent: (key, bytes, headers) => write(key, bytes, { "if-none-match": "*" }, headers),

    async putIfMatch(key, bytes, etag) {
      checkEtag(etag);
      return await write(key, bytes, { "if-match": etag });
    },

    async delete(key) {
      checkKey(key);
      await call("DeleteObject", { method: "DELETE", key }, async (res) => {
        if (res.status !== 204 && res.status !== 200) return failure("DeleteObject", res);
        await res.body?.cancel();
      });
    },

    async list(prefix) {
      const entries: ListEntry[] = [];
      const sent = new Set<string>();
      let last: string | undefined;
      for (let token: string | undefined; ;) {
        const query = {
          "list-type": "2",
          "encoding-type": "url",
          prefix,
          ...(token !== undefined && { "continuation-token": token }),
        };
        token = await listPage(query, (page) => {
          for (const entry of page.entries) {
            if (!("key" in entry)) continue;
            if (last !== undefined && byteOrder(entry.key, last) <= 0) throw invalidListing();
            last = entry.key;
          }
          if (page.next !== undefined && sent.has(page.next)) throw invalidListing();
          entries.push(...page.entries);
          return page.next;
        });
        if (token === undefined) return entries;
        sent.add(token);
      }
    },

    time: () =>
      listPage(
        { "list-type": "2", "encoding-type": "url", "max-keys": "1", prefix: "reply/no-update" },
        (_, res) => {
          const date = res.headers.get("date");
          const ms = date !== null && IMF_FIXDATE.test(date) ? Date.parse(date) : NaN;
          if (Number.isNaN(ms)) throw new S3Error("ListObjectsV2", { problem: "date" });
          return ms;
        },
      ),
  };
}

const invalidListing = () => new S3Error("ListObjectsV2", { problem: "listing" });

/** Returns exactly `size` bytes, or throws when the body is longer or shorter. */
async function readExactly(
  body: ReadableStream<Uint8Array>,
  size: number,
): Promise<Uint8Array<ArrayBuffer>> {
  const out = new Uint8Array(size);
  const reader = body.getReader();
  let at = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value.length > size - at) {
      await reader.cancel();
      at = -1;
      break;
    }
    out.set(value, at);
    at += value.length;
  }
  if (at !== size) throw new S3Error("GetObject", { problem: "body" });
  return out;
}

interface Page {
  readonly entries: readonly ListEntry[];
  readonly next: string | undefined; // The continuation token of a truncated page.
}

/** Returns a ListObjectsV2 page for `prefix`, or undefined when it breaks any rule of a flat, URL-encoded listing. */
function parsePage(text: string, prefix: string): Page | undefined {
  const root = parseS3Xml(text);
  if (root?.name !== "ListBucketResult") return undefined;
  const only = (name: string) => {
    const found = childElements(root, name);
    return found.length === 1 && found[0] !== undefined ? textOf(found[0]) : undefined;
  };
  const truncated = only("IsTruncated");
  if ((truncated !== "true" && truncated !== "false") || only("EncodingType") !== "url") {
    return undefined;
  }
  const echoed = only("Prefix");
  // No delimiter is sent, so a group would hide keys.
  if (
    echoed === undefined ||
    decodeName(echoed) !== prefix ||
    childElements(root, "CommonPrefixes").length > 0
  ) {
    return undefined;
  }
  const contents = childElements(root, "Contents");
  const keyCount = childElements(root, "KeyCount");
  if (
    keyCount.length > 1 ||
    (keyCount[0] !== undefined && textOf(keyCount[0]) !== String(contents.length))
  ) {
    return undefined;
  }
  const entries: ListEntry[] = [];
  for (const c of contents) {
    const keys = childElements(c, "Key");
    const raw = keys.length === 1 && keys[0] !== undefined ? textOf(keys[0]) : undefined;
    if (raw === undefined) return undefined;
    const name = decodeName(raw);
    if (name !== undefined && !name.startsWith(prefix)) return undefined;
    entries.push(name !== undefined && isKey(name) ? { key: name } : { unknown: raw });
  }
  let next: string | undefined;
  if (truncated === "true") {
    next = only("NextContinuationToken");
    if (next === undefined || next === "") return undefined;
  }
  return { entries, next };
}

/** `encoding-type=url` names: + is a space, then percent-decoded as UTF-8. */
function decodeName(raw: string): string | undefined {
  try {
    return decodeURIComponent(raw.replaceAll("+", " "));
  } catch {
    return undefined;
  }
}
