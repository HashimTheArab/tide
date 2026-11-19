// Node only: runs the documented generator command into a fresh directory and checks what it writes.
import { spawnSync } from "node:child_process";
import { X509Certificate } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import {
  certificatePublicKey,
  encodeMultipart,
  parseMultipart,
  verifyExpoSignature,
} from "../src/index.ts";
import { BOUNDARY, TIDE_GOLDEN, goldenParts } from "./fixtures.ts";

const out = mkdtempSync(join(tmpdir(), "tide-fixtures-"));
const written = (file: string) => new Uint8Array(readFileSync(join(out, file)));
const committed = (file: string) =>
  new Uint8Array(readFileSync(fileURLToPath(new URL(`fixtures/${file}`, import.meta.url))));

beforeAll(() => {
  const script = fileURLToPath(new URL("generate-fixtures.ts", import.meta.url));
  const run = spawnSync(process.execPath, [script, "--out", out], { encoding: "utf8" });
  expect(run.stderr).toBe("");
  expect(run.status).toBe(0);
});
afterAll(() => rmSync(out, { recursive: true }));

describe("generate-fixtures", () => {
  test.each(Object.keys(TIDE_GOLDEN))(
    "%s re-encodes from the committed parts and verifies against the written certificate",
    async (file) => {
      const key = await certificatePublicKey(readFileSync(join(out, "certificate.pem"), "utf8"));
      const parsed = parseMultipart(written(file), BOUNDARY);
      const parts = TIDE_GOLDEN[file] ?? [];
      const expected = await goldenParts(parts, committed, (_, i) => parsed[i]?.signature ?? "");
      expect(encodeMultipart(expected, BOUNDARY).body).toEqual(written(file));
      for (const p of expected.filter((e) => e.signature !== undefined)) {
        await expect(verifyExpoSignature(p.body, p.signature!, key, "main")).resolves.toBe(
          undefined,
        );
      }
    },
  );

  test("the certificate is self-signed, valid for 100 years and for code signing only", () => {
    const path = join(out, "certificate.pem");
    const cert = new X509Certificate(readFileSync(path));
    expect(cert.verify(cert.publicKey)).toBe(true);
    expect(cert.issuer).toBe(cert.subject);
    expect(cert.validFromDate.getTime()).toBeLessThanOrEqual(Date.now());
    // 2050 onwards needs GeneralizedTime; a UTCTime would read back a century early.
    expect(cert.validToDate.getUTCFullYear()).toBe(cert.validFromDate.getUTCFullYear() + 100);
    const ext = spawnSync(
      "openssl",
      ["x509", "-noout", "-ext", "keyUsage,extendedKeyUsage", "-in", path],
      {
        encoding: "utf8",
      },
    );
    expect(ext.stdout.split("\n").map((l) => l.trim())).toEqual([
      "X509v3 Key Usage: critical",
      "Digital Signature",
      "X509v3 Extended Key Usage: critical",
      "Code Signing",
      "",
    ]);
  });
});
