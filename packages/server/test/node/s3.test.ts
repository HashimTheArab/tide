import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { contentKey, sha256Base64Url } from "@tide/protocol";

import type { S3Config } from "../../src/core/s3.ts";
import type { FakeS3 } from "../fakes/s3.ts";
import { s3Store, signV4 } from "../../src/core/s3.ts";
import { FAKE_S3, SCRIPTED, startFakeS3 } from "../fakes/s3.ts";
import { runEntry } from "./entry.ts";

test("signV4 reproduces AWS's published GET Object example", async () => {
  // https://docs.aws.amazon.com/AmazonS3/latest/API/sig-v4-header-based-auth.html, "Example: GET Object".
  const authorization = await signV4(
    {
      method: "GET",
      url: new URL("https://examplebucket.s3.amazonaws.com/test.txt"),
      headers: {
        Host: "examplebucket.s3.amazonaws.com",
        Range: "bytes=0-9",
        "x-amz-content-sha256": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        "x-amz-date": "20130524T000000Z",
      },
    },
    {
      accessKeyId: "AKIAIOSFODNN7EXAMPLE",
      secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
      region: "us-east-1",
      service: "s3",
    },
  );
  expect(authorization).toBe(
    "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request," +
      "SignedHeaders=host;range;x-amz-content-sha256;x-amz-date," +
      "Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41",
  );
});

test.each(["ftp://s3.test", "http://s3.test/bucket", "http://s3.test/?x=1", "http://u:p@s3.test"])(
  "s3Store rejects the endpoint %s",
  (endpoint) => {
    expect(() => s3Store({ ...FAKE_S3, endpoint })).toThrow("S3 endpoint must be");
  },
);

describe("s3Store against a local S3-compatible endpoint", () => {
  let fake: FakeS3;
  let config: S3Config;
  beforeAll(async () => {
    fake = await startFakeS3();
    config = { ...FAKE_S3, endpoint: fake.endpoint };
  });
  afterAll(() => fake.close());

  test("returns the object's bytes and size", async () => {
    const bytes = Uint8Array.from({ length: 256 }, (_, i) => i);
    fake.objects.set("assets/all-bytes", bytes);
    const object = await s3Store(config).get("assets/all-bytes");
    expect(object?.size).toBe(256);
    expect(new Uint8Array(await new Response(object?.body).arrayBuffer())).toEqual(bytes);
  });

  test("NoSuchKey is absent", async () => {
    await expect(s3Store(config).get("assets/missing")).resolves.toBeUndefined();
    await fake.arrived("assets/missing");
  });

  test("a wrong secret is refused by the fake's signature check", async () => {
    const store = s3Store({ ...config, secretAccessKey: "wrong" });
    await expect(store.get("assets/missing")).rejects.toThrow("403 SignatureDoesNotMatch");
  });

  test.each([
    ["403 AccessDenied", SCRIPTED.accessDenied, FAKE_S3.bucket],
    ["500 InternalError", SCRIPTED.internalError, FAKE_S3.bucket],
    ["404 NoSuchBucket", "assets/any", "other"],
    ["404 without an S3 error document", SCRIPTED.htmlNotFound, FAKE_S3.bucket],
  ])("%s is an error, not absence", async (message, key, bucket) => {
    await expect(s3Store({ ...config, bucket }).get(key)).rejects.toThrow(
      `S3 GetObject ${key} failed: ${message}`,
    );
    await fake.arrived(key);
  });

  test("a NoSuchKey document cut off mid-body is an error, not absence", async () => {
    await expect(s3Store(config).get(SCRIPTED.truncatedNoSuchKey)).rejects.toThrow();
  });

  test.each([
    [SCRIPTED.gzip, "returned 200 with content-encoding gzip"],
    [SCRIPTED.noLength, "returned 200 with content-length missing"],
  ])("a 200 for %s is rejected and its body cancelled", async (key, message) => {
    await expect(s3Store(config).get(key)).rejects.toThrow(message);
    await fake.abandoned(key);
  });

  test.each([SCRIPTED.hang, SCRIPTED.stall])(
    "%s times out at the adapter's deadline",
    async (key) => {
      const get = s3Store({ ...config, timeoutMs: 250 }).get(key);
      await fake.arrived(key);
      if (key === SCRIPTED.stall) await fake.flushed(key);
      await expect(get).rejects.toThrow(`S3 GetObject ${key} timed out after 250 ms`);
    },
  );

  test("the node entry starts from TIDE_S3_* and serves the stored bytes", async () => {
    const bytes = new TextEncoder().encode("served from S3");
    const hash = await sha256Base64Url(bytes);
    fake.objects.set(`assets/${contentKey(hash)}`, bytes);
    const port = await runEntry({
      TIDE_S3_ENDPOINT: fake.endpoint,
      TIDE_S3_REGION: FAKE_S3.region,
      TIDE_S3_BUCKET: FAKE_S3.bucket,
      TIDE_S3_ACCESS_KEY_ID: FAKE_S3.accessKeyId,
      TIDE_S3_SECRET_ACCESS_KEY: FAKE_S3.secretAccessKey,
    }).listening;
    const res = await fetch(`http://127.0.0.1:${port}/assets?h=${hash}&ext=png`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(bytes);
  });
});
