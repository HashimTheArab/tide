import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { gzipSync } from "node:zlib";
import type { IncomingHttpHeaders, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { MAX_REPLY_BYTES, signV4 } from "@tide/protocol";

import type { Behaviour, FakeEvent } from "../shared/fake-s3.ts";
import { BEHAVIOURS, FAKE_S3, STALL_BODY } from "../shared/fake-s3.ts";

export { FAKE_S3, WRONG_SECRET } from "../shared/fake-s3.ts";

/** Keys per ListObjectsV2 page, so a handful of keys already needs several pages. */
export const LIST_PAGE = 3;

/** Every request fails this way: a dropped socket, a redirect, or an error document. */
type Failure = "drop" | "redirect" | { readonly status: number; readonly code: string };
/** What goes wrong with the next listing's second page. */
type ListFault = "malformed" | "missing-field" | "common-prefixes" | "repeat-token";

export interface FakeS3 {
  readonly endpoint: string;
  readonly objects: Map<string, Uint8Array>;
  /** Every request that reached the fake, including one refused for its signature. */
  readonly requests: number;
  /** Every continuation token a listing sent, in order. */
  readonly tokens: readonly string[];
  /** Returns the ETag the fake serves for `key`; tags count up and are never derived from the bytes. */
  etag(key: string): string | undefined;
  behave(key: string, behaviour: Behaviour): void;
  failAll(failure: Failure | undefined): void;
  listFault(fault: ListFault | undefined): void;
  setNow(ms: number | undefined): void;
  arrived(key: string): Promise<void>;
  flushed(key: string): Promise<void>;
  abandoned(key: string): Promise<void>;
  close(): Promise<void>;
}

const NAMESPACE = "http://s3.amazonaws.com/doc/2006-03-01/";

/**
 * Starts a fake of S3's GetObject, PutObject (with If-None-Match and If-Match), DeleteObject and ListObjectsV2 on a
 * free port. GET behaviours are set per key at run time, in process or through the control API under `/_fake/`,
 * which needs no signature.
 */
export async function startFakeS3(): Promise<FakeS3> {
  const objects = new Map<string, Uint8Array>();
  // Keyed by the stored array, so an object a test sets directly gets a fresh tag.
  const etags = new WeakMap<Uint8Array, string>();
  let etagCount = 0;
  const etagOf = (bytes: Uint8Array) => {
    let tag = etags.get(bytes);
    if (tag === undefined) etags.set(bytes, (tag = `"fake-${++etagCount}!~/"`));
    return tag;
  };
  const behaviours = new Map<string, Behaviour>(BEHAVIOURS.map((b) => [`script/${b}`, b]));
  const issued = new Map<string, string>(); // continuation token -> last key of its page
  const tokens: string[] = [];
  let requests = 0;
  let failure: Failure | undefined;
  let fault: ListFault | undefined;
  let now: number | undefined;
  const events = new Map<string, PromiseWithResolvers<void>>();
  const event = (name: FakeEvent, key: string) => {
    let e = events.get(`${name} ${key}`);
    if (e === undefined) events.set(`${name} ${key}`, (e = Promise.withResolvers<void>()));
    return e;
  };

  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? ""}`);
      const control = /^\/_fake\/(script|event\/(arrived|flushed|abandoned))\/([^/]+)$/.exec(
        url.pathname,
      );
      if (control !== null) {
        const key = decodeURIComponent(control[3] ?? "");
        if (control[2] !== undefined) await event(control[2] as FakeEvent, key).promise;
        else {
          let behaviour = "";
          for await (const chunk of req) behaviour += String(chunk);
          behaviours.set(key, behaviour as Behaviour);
        }
        return res.writeHead(204).end();
      }
      requests++;
      if (now !== undefined) res.setHeader("date", new Date(now).toUTCString());
      if (failure === "drop") return req.socket.destroy();
      if (failure === "redirect") {
        return res.writeHead(301, { location: `/${FAKE_S3.bucket}/assets/elsewhere` }).end();
      }
      if (failure !== undefined) return s3Error(res, failure.status, failure.code, true);

      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const body = new Uint8Array(Buffer.concat(chunks));
      // As S3 does, a literal + in the path is a space.
      const [bucket = "", ...rest] = url.pathname
        .slice(1)
        .split("/")
        .map((s) => decodeURIComponent(s.replaceAll("+", " ")));
      const key = rest.join("/");
      if (!(await signedCorrectly(req.method ?? "", url, req.headers))) {
        return s3Error(res, 403, "SignatureDoesNotMatch");
      }
      if (createHash("sha256").update(body).digest("hex") !== req.headers["x-amz-content-sha256"]) {
        return s3Error(res, 400, "XAmzContentSHA256Mismatch");
      }
      event("arrived", key).resolve();
      res.on("close", () => {
        if (!res.writableFinished) event("abandoned", key).resolve();
      });
      if (bucket !== FAKE_S3.bucket) return s3Error(res, 404, "NoSuchBucket");

      if (rest.length === 0 && req.method === "GET") return list(url.searchParams, res);
      if (req.method === "PUT") {
        const existing = objects.get(key);
        const ifNoneMatch = req.headers["if-none-match"];
        const ifMatch = req.headers["if-match"];
        if (ifNoneMatch !== undefined && ifNoneMatch !== "*") {
          return s3Error(res, 501, "NotImplemented");
        }
        if (ifNoneMatch !== undefined && existing !== undefined) {
          return s3Error(res, 412, "PreconditionFailed");
        }
        if (ifMatch !== undefined) {
          if (existing === undefined) return s3Error(res, 404, "NoSuchKey"); // As AWS answers.
          if (etagOf(existing) !== ifMatch) return s3Error(res, 412, "PreconditionFailed");
        }
        objects.set(key, body);
        return res.writeHead(200, { etag: etagOf(body) }).end();
      }
      if (req.method === "DELETE") {
        objects.delete(key);
        return res.writeHead(204).end();
      }
      if (req.method !== "GET") return s3Error(res, 405, "MethodNotAllowed");
      return get(key, res);
    })();
  });

  function get(key: string, res: ServerResponse): void {
    const stored = objects.get(key);
    switch (behaviours.get(key)) {
      case "internal-error":
        return s3Error(res, 500, "InternalError");
      case "access-denied":
        return s3Error(res, 403, "AccessDenied");
      case "html-404":
        return void res.writeHead(404, { "content-type": "text/html" }).end("<h1>Not Found</h1>");
      case "redirect":
        return void res.writeHead(301, { location: `/${FAKE_S3.bucket}/assets/elsewhere` }).end();
      case "truncated-404": {
        const doc = errorDocument("NoSuchKey");
        res.writeHead(404, { "content-type": "application/xml", "content-length": doc.length });
        return void res.write(doc.slice(0, doc.indexOf("</Code>") + 7), () => res.destroy());
      }
      case "nested-404":
        return void res
          .writeHead(404)
          .end("<Error><Detail><Code>NoSuchKey</Code></Detail></Error>");
      case "duplicate-404":
        return void res
          .writeHead(404)
          .end("<Error><Code>NoSuchKey</Code><Code>NoSuchKey</Code></Error>");
      case "gzip": {
        const gz = gzipSync(new Uint8Array(65536).map((_, i) => (i * 7919) % 251));
        res.writeHead(200, {
          "content-encoding": "gzip",
          "content-length": gz.length,
          etag: '"gz"',
        });
        return void res.write(gz.subarray(0, gz.length >> 1));
      }
      case "encoding-access-key":
      case "encoding-secret": {
        const encoding =
          behaviours.get(key) === "encoding-secret" ? FAKE_S3.secretAccessKey : FAKE_S3.accessKeyId;
        return void res
          .writeHead(200, { "content-encoding": encoding, "content-length": 1, etag: '"e"' })
          .end("x");
      }
      case "length-secret":
        // Written raw: Node's server would refuse a non-numeric Content-Length.
        res.socket?.end(
          `HTTP/1.1 200 OK\r\nETag: "l"\r\nContent-Length: ${FAKE_S3.secretAccessKey}\r\n\r\n`,
        );
        return;
      case "no-etag":
        return void res.writeHead(200, { "content-length": stored?.length ?? 0 }).end(stored);
      case "no-length":
        res.writeHead(200);
        return void res.write("one chunk");
      case "hang":
        return;
      case "stall":
        res.writeHead(500, { "content-type": "application/xml" });
        res.flushHeaders();
        return event("flushed", key).resolve();
      case "stall-body":
        res.writeHead(200, { "content-length": STALL_BODY.size, etag: '"stall"' });
        return void res.write(new Uint8Array(STALL_BODY.sent), () =>
          event("flushed", key).resolve(),
        );
      case "oversize":
        res.writeHead(200, { "content-length": MAX_REPLY_BYTES + 1, etag: '"big"' });
        res.flushHeaders();
        return event("flushed", key).resolve();
      case undefined:
        break;
    }
    if (stored === undefined) return s3Error(res, 404, "NoSuchKey");
    res.writeHead(200, { "content-length": stored.length, etag: etagOf(stored) }).end(stored);
  }

  function list(params: URLSearchParams, res: ServerResponse): void {
    if (params.get("list-type") !== "2") return s3Error(res, 400, "InvalidArgument");
    const prefix = params.get("prefix") ?? "";
    const maxKeys = Number(params.get("max-keys") ?? 1000);
    const token = params.get("continuation-token");
    let after: string | undefined;
    if (token !== null) {
      tokens.push(token);
      after = issued.get(token);
      if (after === undefined) return s3Error(res, 400, "InvalidArgument");
    }
    const keys = [...objects.keys()]
      .filter((k) => k.startsWith(prefix) && (after === undefined || byteOrder(k, after) > 0))
      .sort(byteOrder);
    const page = keys.slice(0, Math.min(LIST_PAGE, maxKeys));
    const truncated = keys.length > page.length;
    let next = "";
    if (truncated) {
      next = `t${issued.size}+/=`; // A token holding +, / and = must be sent back byte for byte.
      issued.set(next, page.at(-1) ?? "");
    }
    const pageFault = token === null ? undefined : fault;
    if (pageFault === "repeat-token") next = tokens[0] ?? next;
    const isTruncated =
      pageFault === "missing-field"
        ? ""
        : `<IsTruncated>${truncated || pageFault === "repeat-token"}</IsTruncated>`;
    const xml = [
      `<?xml version="1.0" encoding="UTF-8"?>\n<ListBucketResult xmlns="${NAMESPACE}">`,
      `<Name>${FAKE_S3.bucket}</Name>`,
      prefix === "" ? "<Prefix/>" : `<Prefix>${urlEncode(prefix)}</Prefix>`,
      `<KeyCount>${page.length}</KeyCount><MaxKeys>${maxKeys}</MaxKeys>`,
      "<EncodingType>url</EncodingType>",
      pageFault === "malformed" ? isTruncated.replace("</IsTruncated>", "") : isTruncated,
      token === null ? "" : `<ContinuationToken>${token}</ContinuationToken>`,
      next === "" ? "" : `<NextContinuationToken>${next}</NextContinuationToken>`,
      ...page.map((k) => {
        const bytes = objects.get(k) ?? new Uint8Array();
        const etag = etagOf(bytes).replaceAll('"', "&quot;");
        return `<Contents><Key>${urlEncode(k)}</Key><ETag>${etag}</ETag><Size>${bytes.length}</Size></Contents>`;
      }),
      pageFault === "common-prefixes"
        ? "<CommonPrefixes><Prefix>x%2F</Prefix></CommonPrefixes>"
        : "",
      "</ListBucketResult>",
    ].join("");
    res.writeHead(200, { "content-type": "application/xml" }).end(xml);
  }

  server.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));

  return {
    endpoint: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    objects,
    get requests() {
      return requests;
    },
    tokens,
    etag: (key) => {
      const stored = objects.get(key);
      return stored === undefined ? undefined : etagOf(stored);
    },
    behave: (key, behaviour) => {
      behaviours.set(key, behaviour);
    },
    failAll: (f) => {
      failure = f;
    },
    listFault: (f) => {
      fault = f;
    },
    setNow: (ms) => {
      now = ms;
    },
    arrived: (key) => event("arrived", key).promise,
    flushed: (key) => event("flushed", key).promise,
    abandoned: (key) => event("abandoned", key).promise,
    close: () => {
      server.closeAllConnections();
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

/** Checks the declared SignedHeaders, then recomputes the signature over the path, query and those headers. */
async function signedCorrectly(
  method: string,
  url: URL,
  received: IncomingHttpHeaders,
): Promise<boolean> {
  const auth =
    /^AWS4-HMAC-SHA256 Credential=([^/]+)\/(\d{8})\/([^/]+)\/s3\/aws4_request,SignedHeaders=([^,]+),Signature=[0-9a-f]{64}$/.exec(
      String(received.authorization),
    );
  // Every header that changes what the request does must be signed.
  const required = ["host", "if-match", "if-none-match", "x-amz-content-sha256", "x-amz-date"];
  const signedHeaders = required.filter((h) => received[h] !== undefined).join(";");
  if (
    auth?.[1] !== FAKE_S3.accessKeyId ||
    auth[3] !== FAKE_S3.region ||
    auth[4] !== signedHeaders
  ) {
    return false;
  }
  const headers = Object.fromEntries(signedHeaders.split(";").map((h) => [h, String(received[h])]));
  try {
    const expected = await signV4({ method, url, headers }, { ...FAKE_S3, service: "s3" });
    return expected === received.authorization;
  } catch {
    return false; // A malformed escape in the query or path.
  }
}

/** ListObjectsV2's `encoding-type=url`: a space is +, and + is %2B. */
const urlEncode = (s: string) => encodeURIComponent(s).replaceAll("%20", "+");

const byteOrder = (a: string, b: string) => Buffer.compare(Buffer.from(a), Buffer.from(b));

function errorDocument(code: string, leak = false): string {
  // A provider's Message is free text; `leak` puts both credentials in it, which no error may repeat.
  const message = leak ? `${FAKE_S3.accessKeyId} ${FAKE_S3.secretAccessKey}` : "fake";
  return `<?xml version="1.0" encoding="UTF-8"?>\n<Error><Code>${code}</Code><Message>${message}</Message></Error>`;
}

function s3Error(res: ServerResponse, status: number, code: string, leak = false): void {
  res.writeHead(status, { "content-type": "application/xml" }).end(errorDocument(code, leak));
}
