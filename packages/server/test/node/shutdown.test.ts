import { once } from "node:events";
import { connect } from "node:net";
import { expect, inject, test } from "vitest";

import { contentKey, s3Fetch, s3Target, sha256Base64Url } from "@tide/protocol";

import { FAKE_S3, fakeS3Control } from "../shared/fake-s3.ts";
import { runEntry } from "./entry.ts";

// Workers has no process signals, so this runs on Node only. The download is a raw keep-alive HTTP/1.1 socket, so
// only the server can end it: a server that waited out its keep-alive timeout would fail on the test timeout.
test.each(["SIGTERM", "SIGINT"] as const)(
  "%s mid-download refuses new connections, finishes the reply, closes the connection and exits 0",
  async (signal) => {
    const endpoint = inject("fakeS3Endpoint");
    const fake = fakeS3Control(endpoint);
    const bundle = Uint8Array.from(
      { length: 64 * 1024 },
      (_, i) => (i * 31 + signal.length) & 0xff,
    );
    const key = `bundles/${contentKey(await sha256Base64Url(bundle))}`;
    const put = await s3Fetch(
      s3Target({ ...FAKE_S3, endpoint }),
      { method: "PUT", key, body: bundle },
      new AbortController().signal,
    );
    await put.body?.cancel();
    expect(put.status).toBe(200);
    await fake.script(key, "pause-body");

    const entry = runEntry({
      TIDE_S3_ENDPOINT: endpoint,
      TIDE_S3_REGION: FAKE_S3.region,
      TIDE_S3_BUCKET: FAKE_S3.bucket,
      TIDE_S3_ACCESS_KEY_ID: FAKE_S3.accessKeyId,
      TIDE_S3_SECRET_ACCESS_KEY: FAKE_S3.secretAccessKey,
    });
    const port = await entry.listening;
    const socket = connect(port, "127.0.0.1");
    socket.write(`GET /${key} HTTP/1.1\r\nhost: tide.test\r\n\r\n`);
    const chunks: Buffer[] = [];
    let received = 0;
    const half = Promise.withResolvers<void>();
    socket.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
      received += chunk.length;
      if (received > bundle.length >> 1) half.resolve();
    });
    const ended = once(socket, "end");
    await half.promise;

    entry.kill(signal);
    await entry.printed(/tide closing\n/);
    await expect(fetch(`http://127.0.0.1:${port}/hc`)).rejects.toThrow();
    await fake.release(key);
    await ended;

    const response = Buffer.concat(chunks);
    const head = response.subarray(0, response.indexOf("\r\n\r\n") + 4).toString("latin1");
    expect(head).toMatch(/^HTTP\/1\.1 200 OK\r\n/);
    expect(head).toContain(`\r\ncontent-length: ${bundle.length}\r\n`);
    expect(new Uint8Array(response.subarray(head.length))).toEqual(bundle);
    expect(await entry.exited).toMatchObject({ code: 0, signal: null });
  },
);
