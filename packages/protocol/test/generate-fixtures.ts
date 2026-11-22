// Writes certificate.pem, the signed Tide multiparts, the stored replies wrapping them and the chain goldens, with
// fresh keys that never leave memory. `--replies-only` rewraps the committed multiparts without signing.
// Usage: node packages/protocol/test/generate-fixtures.ts [--out <dir>] [--replies-only]
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { cryptoKeySigner } from "../src/index.ts";
import {
  RSA_SHA256,
  certificate,
  chainFixtures,
  replyGoldens,
  signedFixtures,
} from "./fixtures.ts";

const fixtures = fileURLToPath(new URL("fixtures/", import.meta.url));
const { values } = parseArgs({
  options: { out: { type: "string" }, "replies-only": { type: "boolean" } },
});
const out = values.out === undefined ? fixtures : resolve(values.out);
const read = (file: string) => new Uint8Array(readFileSync(resolve(fixtures, file)));

let multiparts: Record<string, Uint8Array<ArrayBuffer>> = {};
if (values["replies-only"] !== true) {
  const keys = await crypto.subtle.generateKey(RSA_SHA256, false, ["sign", "verify"]);
  writeFileSync(
    resolve(out, "certificate.pem"),
    await certificate(keys.publicKey, keys.privateKey, new Date()),
  );
  multiparts = await signedFixtures(read, cryptoKeySigner(keys.privateKey, "main"));
  const pair = () => crypto.subtle.generateKey(RSA_SHA256, false, ["sign", "verify"]);
  const chain = await chainFixtures(read, {
    root: await pair(),
    intermediate: await pair(),
    leaf: await pair(),
    shortLeaf: await pair(),
  });
  for (const [file, bytes] of Object.entries(chain)) writeFileSync(resolve(out, file), bytes);
}
// The replies wrap the multiparts this run signed, so a fresh certificate never leaves a reply over old bytes.
const replies = replyGoldens((file) => multiparts[file] ?? read(file));
for (const [file, bytes] of Object.entries({ ...multiparts, ...replies }))
  writeFileSync(resolve(out, file), bytes);
