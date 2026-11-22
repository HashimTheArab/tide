// Opens a writer as a write command will, from the process environment, and prints the expo-signature of a part.
// Usage: node open-writer.ts <app.json> <part>, where app.json holds an export's certificate and codeSigningMetadata.
// A refusal prints `tide: <message>` and exits 2.
import { readFileSync } from "node:fs";

import { expoSignature } from "@tide-ota/protocol";

import type { ProjectExport } from "../src/publish-export.ts";
import { BucketError } from "../src/bucket.ts";
import { KeyError, openWriter } from "../src/keys.ts";

const [appPath = "", partPath = ""] = process.argv.slice(2);
const app = JSON.parse(readFileSync(appPath, "utf8")) as Pick<
  ProjectExport,
  "certificate" | "codeSigningMetadata"
>;
try {
  const { signer } = await openWriter(process.env, { app });
  const part = new Uint8Array(readFileSync(partPath));
  process.stdout.write(`${await expoSignature(part, signer)}\n`);
} catch (e) {
  if (!(e instanceof KeyError || e instanceof BucketError)) throw e;
  process.stderr.write(`tide: ${e.message}\n`);
  process.exitCode = 2;
}
