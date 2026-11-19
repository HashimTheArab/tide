import { createServer } from "node:http";
import { gzipSync } from "node:zlib";
import type { ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { MAX_REPLY_BYTES } from "@tide/protocol";

import type { Behaviour, FakeEvent } from "../shared/fake-s3.ts";
import { signV4 } from "../../src/core/s3.ts";
import { FAKE_S3, STALL_BODY } from "../shared/fake-s3.ts";

/** Keys scripted from the start, for the adapter tests. */
export const SCRIPTED = {
  internalError: "script/internal-error",
  accessDenied: "script/access-denied",
  htmlNotFound: "script/html-404",
  redirect: "script/redirect",
  truncatedNoSuchKey: "script/truncated-404",
  gzip: "script/gzip",
  noLength: "script/no-length",
  hang: "script/hang",
  stall: "script/stall",
};

const SIGNED_HEADERS = "host;x-amz-content-sha256;x-amz-date";

export interface FakeS3 {
  readonly endpoint: string;
  readonly objects: Map<string, Uint8Array>;
  arrived(key: string): Promise<void>;
  flushed(key: string): Promise<void>;
  abandoned(key: string): Promise<void>;
  close(): Promise<void>;
}

/**
 * Starts a fake of the S3 GetObject API on a free port. Behaviours are set per key at run time, in process or
 * through the control API under `/_fake/`, which needs no signature.
 */
export async function startFakeS3(): Promise<FakeS3> {
  const objects = new Map<string, Uint8Array>();
  const behaviours = new Map<string, Behaviour>(
    Object.values(SCRIPTED).map((key) => [key, key.slice("script/".length) as Behaviour]),
  );
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
      // As S3 does, a literal + in the path is a space.
      const [bucket = "", ...rest] = url.pathname
        .slice(1)
        .split("/")
        .map((s) => decodeURIComponent(s.replaceAll("+", " ")));
      const key = rest.join("/");
      if (!(await signedCorrectly(req.method ?? "", url, req.headers))) {
        return s3Error(res, 403, "SignatureDoesNotMatch");
      }
      event("arrived", key).resolve();
      res.on("close", () => {
        if (!res.writableFinished) event("abandoned", key).resolve();
      });

      if (bucket !== FAKE_S3.bucket) return s3Error(res, 404, "NoSuchBucket");
      switch (behaviours.get(key)) {
        case "internal-error":
          return s3Error(res, 500, "InternalError");
        case "access-denied":
          return s3Error(res, 403, "AccessDenied");
        case "html-404":
          return res.writeHead(404, { "content-type": "text/html" }).end("<h1>Not Found</h1>");
        case "redirect":
          return res.writeHead(301, { location: `/${FAKE_S3.bucket}/assets/elsewhere` }).end();
        case "truncated-404": {
          const doc = errorDocument("NoSuchKey");
          res.writeHead(404, { "content-type": "application/xml", "content-length": doc.length });
          return res.write(doc.slice(0, doc.indexOf("</Code>") + 7), () => res.destroy());
        }
        case "gzip": {
          const gz = gzipSync(new Uint8Array(65536).map((_, i) => (i * 7919) % 251));
          res.writeHead(200, { "content-encoding": "gzip", "content-length": gz.length });
          return res.write(gz.subarray(0, gz.length >> 1));
        }
        case "no-length":
          res.writeHead(200);
          return res.write("one chunk");
        case "hang":
          return;
        case "stall":
          res.writeHead(500, { "content-type": "application/xml" });
          res.flushHeaders();
          return event("flushed", key).resolve();
        case "stall-body":
          res.writeHead(200, { "content-length": STALL_BODY.size });
          return res.write(new Uint8Array(STALL_BODY.sent), () => event("flushed", key).resolve());
        case "oversize":
          res.writeHead(200, { "content-length": MAX_REPLY_BYTES + 1 });
          res.flushHeaders();
          return event("flushed", key).resolve();
        case undefined:
          break;
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
    arrived: (key) => event("arrived", key).promise,
    flushed: (key) => event("flushed", key).promise,
    abandoned: (key) => event("abandoned", key).promise,
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
