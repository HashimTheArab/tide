// Writes certificate.pem and the signed Tide multiparts with a fresh key that never leaves memory.
// Usage: node packages/protocol/test/generate-fixtures.ts [--out <dir>]
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { cryptoKeySigner } from "../src/index.ts";
import { RSA_SHA256, certificate, signedFixtures } from "./fixtures.ts";

const fixtures = fileURLToPath(new URL("fixtures/", import.meta.url));
const { values } = parseArgs({ options: { out: { type: "string" } } });
const out = values.out === undefined ? fixtures : resolve(values.out);

const keys = await crypto.subtle.generateKey(RSA_SHA256, false, ["sign", "verify"]);
writeFileSync(
  resolve(out, "certificate.pem"),
  await certificate(keys.publicKey, keys.privateKey, new Date()),
);
const read = (file: string) => new Uint8Array(readFileSync(resolve(fixtures, file)));
const files = await signedFixtures(read, cryptoKeySigner(keys.privateKey, "main"));
for (const [file, bytes] of Object.entries(files)) writeFileSync(resolve(out, file), bytes);
