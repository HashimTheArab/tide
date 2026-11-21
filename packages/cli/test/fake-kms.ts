import { constants, createHash, privateEncrypt } from "node:crypto";
import { createServer } from "node:http";
import type { KeyObject } from "node:crypto";
import type { IncomingHttpHeaders, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { signV4 } from "@tide-ota/protocol";

/** The fake's KMS key and credentials; a request signed with any other secret gets InvalidSignatureException. */
export const FAKE_KMS = {
  keyId: "alias/tide-test",
  arn: "arn:aws:kms:us-east-1:111122223333:key/1234abcd-12ab-34cd-56ef-1234567890ab",
  region: "us-east-1",
  accessKeyId: "TIDEFAKEKMSACCESSKEY",
  secretAccessKey: "tide-fake-kms-secret",
} as const;

/** How every later request fails, after its signature checks pass. */
export type KmsFault =
  | { readonly status: number; readonly header?: string; readonly body?: string } // An error reply
  | { readonly reply: string } // 200 with this body
  | { readonly redirect: string } // 307 to this URL
  | "drop" // The connection closes with no reply
  | "stall" // 200 headers flushed, then no body
  | "oversize"; // 200 chunked, longer than any KMS reply

/** A request the fake accepted, as received. */
interface Received {
  readonly headers: IncomingHttpHeaders;
  readonly body: Uint8Array<ArrayBuffer>;
}

export interface FakeKms {
  readonly endpoint: string;
  /** Every request that reached the fake, including one refused for its signature. */
  readonly requests: number;
  /** The last request whose signature verified. */
  readonly last: Received | undefined;
  fault(fault: KmsFault | undefined): void;
  /** Signs every later request with `key`. */
  signWith(key: KeyObject): void;
  close(): Promise<void>;
}

const ALGORITHM = "RSASSA_PKCS1_V1_5_SHA_256";
// DER DigestInfo prefix for SHA-256 (RFC 8017 9.2).
const SHA256_DIGEST_INFO = Buffer.from("3031300d060960864801650304020105000420", "hex");
const SIGNED = ["content-type", "host", "x-amz-content-sha256", "x-amz-date", "x-amz-target"];

/** Starts a fake of the KMS `Sign` API on 127.0.0.1 that signs with `key`, the private key of the generated pair. */
export async function startFakeKms(key: KeyObject): Promise<FakeKms> {
  let signing = key;
  let fault: KmsFault | undefined;
  let requests = 0;
  let last: Received | undefined;

  const server = createServer((req, res) => {
    void (async () => {
      requests++;
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const body = new Uint8Array(Buffer.concat(chunks));
      const bodyHash = createHash("sha256").update(body).digest("hex");
      if (
        req.headers["x-amz-content-sha256"] !== bodyHash ||
        !(await signedCorrectly(req.method ?? "", req.url ?? "", req.headers))
      ) {
        return kmsError(res, 400, "InvalidSignatureException");
      }
      if (
        req.headers["x-amz-target"] !== "TrentService.Sign" ||
        req.headers["content-type"] !== "application/x-amz-json-1.1"
      ) {
        return kmsError(res, 400, "UnknownOperationException");
      }
      last = { headers: req.headers, body };
      let request: Record<string, unknown>;
      try {
        request = JSON.parse(Buffer.from(body).toString("utf8")) as Record<string, unknown>;
      } catch {
        return kmsError(res, 400, "SerializationException");
      }
      if (request.KeyId !== FAKE_KMS.keyId) return kmsError(res, 400, "NotFoundException");
      const message =
        typeof request.Message === "string" ? Buffer.from(request.Message, "base64") : undefined;
      const digest =
        request.MessageType === "DIGEST" && message?.length === 32
          ? message
          : request.MessageType === "RAW" && message !== undefined && message.length <= 4096
            ? createHash("sha256").update(message).digest()
            : undefined;
      if (request.SigningAlgorithm !== ALGORITHM || digest === undefined) {
        return kmsError(res, 400, "ValidationException");
      }

      if (fault === "drop") return req.socket.destroy();
      if (fault === "stall") return res.writeHead(200).flushHeaders();
      if (fault === "oversize") {
        res.writeHead(200, { "content-type": "application/x-amz-json-1.1" });
        return res.end("x".repeat(20 * 1024));
      }
      if (fault !== undefined && "redirect" in fault) {
        return res.writeHead(307, { location: fault.redirect }).end();
      }
      if (fault !== undefined && "status" in fault) {
        const headers = fault.header === undefined ? {} : { "x-amzn-errortype": fault.header };
        return res.writeHead(fault.status, headers).end(fault.body ?? "");
      }
      if (fault !== undefined) return res.writeHead(200).end(fault.reply);
      const signature = privateEncrypt(
        { key: signing, padding: constants.RSA_PKCS1_PADDING },
        Buffer.concat([SHA256_DIGEST_INFO, digest]),
      );
      res.writeHead(200, { "content-type": "application/x-amz-json-1.1" });
      res.end(
        JSON.stringify({
          KeyId: FAKE_KMS.arn,
          Signature: signature.toString("base64"),
          SigningAlgorithm: ALGORITHM,
        }),
      );
    })();
  });
  server.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const { port } = server.address() as AddressInfo;

  return {
    endpoint: `http://127.0.0.1:${port}`,
    get requests() {
      return requests;
    },
    get last() {
      return last;
    },
    fault: (f) => {
      fault = f;
    },
    signWith: (k) => {
      signing = k;
    },
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => {
          resolve();
        });
      }),
  };
}

/**
 * True when the request carries exactly the signed headers Tide sends and its SigV4 signature, recomputed from the
 * received headers with the fake's secret, matches.
 */
async function signedCorrectly(
  method: string,
  path: string,
  headers: IncomingHttpHeaders,
): Promise<boolean> {
  const authorization = headers.authorization ?? "";
  const names = /SignedHeaders=([^,]*)/.exec(authorization)?.[1]?.split(";") ?? [];
  const expected = [
    ...SIGNED,
    ...(headers["x-amz-security-token"] === undefined ? [] : ["x-amz-security-token"]),
  ].sort();
  if (names.join(";") !== expected.join(";")) return false;
  const signed: Record<string, string> = {};
  for (const name of names) {
    const value = headers[name];
    if (typeof value !== "string") return false;
    signed[name] = value;
  }
  try {
    const expectedAuthorization = await signV4(
      { method, url: new URL(path, `http://${headers.host ?? ""}`), headers: signed },
      { ...FAKE_KMS, service: "kms" },
    );
    return authorization === expectedAuthorization;
  } catch {
    return false;
  }
}

/** Sends a KMS error as AWS JSON 1.1 does: the code in `X-Amzn-Errortype` and in the body's `__type`. */
function kmsError(res: ServerResponse, status: number, code: string): void {
  res.writeHead(status, {
    "content-type": "application/x-amz-json-1.1",
    "x-amzn-errortype": `${code}:http://internal.amazon.com/coral/com.amazon.coral.service/`,
  });
  res.end(JSON.stringify({ __type: `com.amazonaws.kms#${code}`, message: "refused by the fake" }));
}
