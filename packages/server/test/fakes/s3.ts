import { createServer } from "node:http";
import { gzipSync } from "node:zlib";
import type { ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { signV4 } from "../../src/core/s3.ts";

/** The credentials the fake accepts; any other signature gets 403 SignatureDoesNotMatch. */
export const FAKE_S3 = {
  bucket: "tide",
  region: "auto",
  accessKeyId: "TIDEFAKEACCESSKEY",
  secretAccessKey: "tide-fake-secret",
};

/** Keys with a scripted reply instead of a stored object. */
export const SCRIPTED = {
  internalError: "script/internal-error", // 500 InternalError
  accessDenied: "script/access-denied", // 403 AccessDenied
  htmlNotFound: "script/html-404", // A 404 that is not an S3 error document
  truncatedNoSuchKey: "script/truncated-404", // NoSuchKey, then the connection drops mid-document
  gzip: "script/gzip", // 200 gzip: a valid unfinished prefix of its declared length, never ended
  noLength: "script/no-length", // 200 chunked: one chunk, never ended
  hang: "script/hang", // Never answers
  stall: "script/stall", // 500 headers flushed, then no body
};

const SIGNED_HEADERS = "host;x-amz-content-sha256;x-amz-date";

export interface FakeS3 {
  readonly endpoint: string;
  readonly objects: Map<string, Uint8Array>;
  /** Resolves when a correctly signed request for `key` has arrived. */
  arrived(key: string): Promise<void>;
  /** Resolves when the stall reply's headers have been sent. */
  flushed(key: string): Promise<void>;
  /** Resolves when the reply for `key` closed before it finished, which only the client can cause. */
  abandoned(key: string): Promise<void>;
  close(): Promise<void>;
}

/** Starts the one fake of the S3 GetObject API on a free port. */
export async function startFakeS3(): Promise<FakeS3> {
  const objects = new Map<string, Uint8Array>();
  const events = new Map<string, PromiseWithResolvers<void>>();
  const event = (name: string) => {
    let e = events.get(name);
    if (e === undefined) events.set(name, (e = Promise.withResolvers<void>()));
    return e;
  };

  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? ""}`);
      const [bucket = "", ...rest] = url.pathname.slice(1).split("/").map(decodeURIComponent);
      const key = rest.join("/");
      if (!(await signedCorrectly(req.method ?? "", url, req.headers))) {
        return s3Error(res, 403, "SignatureDoesNotMatch");
      }
      event(`arrived ${key}`).resolve();
      res.on("close", () => {
        if (!res.writableFinished) event(`abandoned ${key}`).resolve();
      });

      if (bucket !== FAKE_S3.bucket) return s3Error(res, 404, "NoSuchBucket");
      switch (key) {
        case SCRIPTED.internalError:
          return s3Error(res, 500, "InternalError");
        case SCRIPTED.accessDenied:
          return s3Error(res, 403, "AccessDenied");
        case SCRIPTED.htmlNotFound:
          return res.writeHead(404, { "content-type": "text/html" }).end("<h1>Not Found</h1>");
        case SCRIPTED.truncatedNoSuchKey: {
          const doc = errorDocument("NoSuchKey");
          res.writeHead(404, { "content-type": "application/xml", "content-length": doc.length });
          return res.write(doc.slice(0, doc.indexOf("</Code>") + 7), () => res.destroy());
        }
        case SCRIPTED.gzip: {
          const gz = gzipSync(new Uint8Array(65536).map((_, i) => (i * 7919) % 251));
          res.writeHead(200, { "content-encoding": "gzip", "content-length": gz.length });
          return res.write(gz.subarray(0, gz.length >> 1));
        }
        case SCRIPTED.noLength:
          res.writeHead(200);
          return res.write("one chunk");
        case SCRIPTED.hang:
          return;
        case SCRIPTED.stall:
          res.writeHead(500, { "content-type": "application/xml" });
          res.flushHeaders();
          return event(`flushed ${key}`).resolve();
      }
      const object = objects.get(key);
      if (object === undefined) return s3Error(res, 404, "NoSuchKey");
      res.writeHead(200, { "content-length": object.length }).end(object);
    })();
  });
  server.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));

  return {
    endpoint: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    objects,
    arrived: (key) => event(`arrived ${key}`).promise,
    flushed: (key) => event(`flushed ${key}`).promise,
    abandoned: (key) => event(`abandoned ${key}`).promise,
    close: () => {
      server.closeAllConnections();
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

/** Checks the declared SignedHeaders, then recomputes the signature over only those received values. */
async function signedCorrectly(
  method: string,
  url: URL,
  received: Record<string, string | string[] | undefined>,
): Promise<boolean> {
  const auth =
    /^AWS4-HMAC-SHA256 Credential=([^/]+)\/(\d{8})\/([^/]+)\/s3\/aws4_request,SignedHeaders=([^,]+),Signature=[0-9a-f]{64}$/.exec(
      String(received.authorization),
    );
  if (
    auth?.[1] !== FAKE_S3.accessKeyId ||
    auth[3] !== FAKE_S3.region ||
    auth[4] !== SIGNED_HEADERS
  ) {
    return false;
  }
  const headers = Object.fromEntries(
    SIGNED_HEADERS.split(";").map((h) => [h, String(received[h])]),
  );
  const expected = await signV4({ method, url, headers }, { ...FAKE_S3, service: "s3" });
  return expected === received.authorization;
}

function errorDocument(code: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<Error><Code>${code}</Code><Message>fake</Message></Error>`;
}

function s3Error(res: ServerResponse, status: number, code: string): void {
  res.writeHead(status, { "content-type": "application/xml" }).end(errorDocument(code));
}
