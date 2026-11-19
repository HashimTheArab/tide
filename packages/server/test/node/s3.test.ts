import { afterAll, beforeAll, describe, expect, test } from "vitest";

import type { S3Config } from "@tide/protocol";
import { contentKey, sha256Base64Url } from "@tide/protocol";

import type { FakeS3 } from "../fakes/s3.ts";
import type { Behaviour } from "../shared/fake-s3.ts";
import { s3Store } from "../../src/core/s3.ts";
import { startFakeS3 } from "../fakes/s3.ts";
import { FAKE_S3, WRONG_SECRET } from "../shared/fake-s3.ts";
import { runEntry } from "./entry.ts";

/** The key the fake serves `behaviour` at from the start. */
const scripted = (behaviour: Behaviour) => `script/${behaviour}`;

test.each([
  "ftp://s3.test",
  "http://s3.test/bucket",
  "http://s3.test/?x=1",
  "http://u:p@s3.test",
  "not a url",
])("s3Store rejects the endpoint %s", (endpoint) => {
  expect(() => s3Store({ ...FAKE_S3, endpoint })).toThrow("endpoint must be");
});

test("a rejected TIDE_S3_ENDPOINT stops the node entry without echoing its secrets", async () => {
  const mark = "leak"; // Stands in for the user, password and signature.
  const endpoint = new URL(`https://s3.test/b?X-Amz-Signature=${mark}`);
  endpoint.username = mark;
  endpoint.password = mark;
  const { code, stdout, stderr } = await runEntry({
    TIDE_S3_ENDPOINT: endpoint.href,
    TIDE_S3_REGION: FAKE_S3.region,
    TIDE_S3_BUCKET: FAKE_S3.bucket,
    TIDE_S3_ACCESS_KEY_ID: FAKE_S3.accessKeyId,
    TIDE_S3_SECRET_ACCESS_KEY: FAKE_S3.secretAccessKey,
  }).exited;
  expect(code).not.toBe(0);
  expect(stdout).not.toContain("listening");
  expect(stderr).not.toContain(mark);
  expect(stderr).toContain("TIDE_S3_ENDPOINT: endpoint must be");
});

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
    const store = s3Store({ ...config, secretAccessKey: WRONG_SECRET });
    const before = fake.requests;
    await expect(store.get("assets/missing")).rejects.toThrow(
      "S3 GetObject failed: 403 SignatureDoesNotMatch",
    );
    expect(fake.requests).toBe(before + 1);
  });

  test("an invalid bucket fails construction", () => {
    expect(() => s3Store({ ...config, bucket: "a/b" })).toThrow("bucket must be");
  });

  test.each([
    ["403 AccessDenied", scripted("access-denied"), FAKE_S3.bucket],
    ["500 InternalError", scripted("internal-error"), FAKE_S3.bucket],
    ["404 NoSuchBucket", "assets/any", "other"],
    ["404 without an S3 error document", scripted("html-404"), FAKE_S3.bucket],
    ["301 without an S3 error document", scripted("redirect"), FAKE_S3.bucket],
    ["404 without an S3 error document", scripted("nested-404"), FAKE_S3.bucket],
    ["404 without an S3 error document", scripted("duplicate-404"), FAKE_S3.bucket],
  ])("%s is an error, not absence", async (message, key, bucket) => {
    const get = s3Store({ ...config, bucket }).get(key);
    await expect(get).rejects.toMatchObject({ message: `S3 GetObject failed: ${message}` });
    await fake.arrived(key);
  });

  test("a key with + reaches its object, which S3 would read as a space if sent literally", async () => {
    const bytes = new TextEncoder().encode("plus");
    fake.objects.set("reply/a+b/1+2/ios", bytes);
    const object = await s3Store(config).get("reply/a+b/1+2/ios");
    expect(new Uint8Array(await new Response(object?.body).arrayBuffer())).toEqual(bytes);
  });

  test.each([scripted("encoding-access-key"), scripted("encoding-secret")])(
    "a 200 for %s names neither credential",
    async (key) => {
      const error = await s3Store(config)
        .get(key)
        .then(
          () => undefined,
          (e: unknown) => e as Error,
        );
      expect(error?.message).toBe("S3 GetObject returned 200 with an unsupported content-encoding");
      expect(error?.message).not.toContain(FAKE_S3.accessKeyId);
      expect(error?.message).not.toContain(FAKE_S3.secretAccessKey);
      expect(error?.cause).toBeUndefined();
    },
  );

  test("a NoSuchKey document cut off mid-body is an error, not absence", async () => {
    await expect(s3Store(config).get(scripted("truncated-404"))).rejects.toThrow();
  });

  test.each([
    [scripted("gzip"), "returned 200 with an unsupported content-encoding"],
    [scripted("no-length"), "returned 200 with a missing or invalid content-length"],
  ])("a 200 for %s is rejected and its body cancelled", async (key, message) => {
    await expect(s3Store(config).get(key)).rejects.toThrow(message);
    await fake.abandoned(key);
  });

  test.each([scripted("hang"), scripted("stall")])(
    "%s times out at the adapter's deadline",
    async (key) => {
      const get = s3Store({ ...config, timeoutMs: 250 }).get(key);
      await fake.arrived(key);
      if (key === scripted("stall")) await fake.flushed(key);
      await expect(get).rejects.toMatchObject({ message: "S3 GetObject timed out after 250 ms" });
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
