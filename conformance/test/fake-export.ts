// The `expo export` of a fake app's project, without Expo: the CLI tests' fixture export of the named platform, its launch
// bundle reporting marker.js's MARKER. Usage, from the project root: node fake-export.ts export <args...>
import { cpSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { markedBundle } from "./fake-app.ts";

const FIXTURE = fileURLToPath(new URL("../../packages/cli/test/fixtures/export", import.meta.url));
const args = process.argv.slice(2);
const flag = (name: string) => args[args.indexOf(name) + 1] ?? "";
const [out, platform] = [flag("--output-dir"), flag("--platform")];
cpSync(FIXTURE, out, { recursive: true });
const metadata = JSON.parse(readFileSync(join(out, "metadata.json"), "utf8")) as {
  fileMetadata: Record<string, { bundle: string }>;
};
const exported = metadata.fileMetadata[platform];
if (exported === undefined) throw new Error(`the fixture has no ${platform} export`);
metadata.fileMetadata = { [platform]: exported };
writeFileSync(join(out, "metadata.json"), JSON.stringify(metadata));
const marker = /"(.*)"/.exec(readFileSync("marker.js", "utf8"))?.[1] ?? "";
writeFileSync(join(out, exported.bundle), markedBundle(marker));
