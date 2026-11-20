// Opens a writer as a write command will, from the process environment, and prints the expo-signature of a part.
// Usage: node open-writer.ts <config.json> <projectRoot> <part>
// A refusal prints `tide: <message>` and exits 2.
import { readFileSync } from "node:fs";

import { expoSignature } from "@tide/protocol";

import { BucketError } from "../src/bucket.ts";
import { KeyError, openWriter } from "../src/keys.ts";

const [configPath = "", projectRoot = "", partPath = ""] = process.argv.slice(2);
const config: unknown = JSON.parse(readFileSync(configPath, "utf8"));
try {
  const { signer } = await openWriter(process.env, { projectRoot, config });
  const part = new Uint8Array(readFileSync(partPath));
  process.stdout.write(`${await expoSignature(part, signer)}\n`);
} catch (e) {
  if (!(e instanceof KeyError || e instanceof BucketError)) throw e;
  process.stderr.write(`tide: ${e.message}\n`);
  process.exitCode = 2;
}
