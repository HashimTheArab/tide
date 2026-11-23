// The CLI tests' fake `expo export`, its one launch bundle reporting marker.js's MARKER.
// Usage, from the project root: node fake-export.ts export <args...>
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { markedBundle } from "./fake-app.ts";

const out = process.argv[process.argv.indexOf("--output-dir") + 1] ?? "";
process.argv.splice(2, 0, "expo");
await import("../../packages/cli/test/fake-expo.ts");
const { fileMetadata } = JSON.parse(readFileSync(join(out, "metadata.json"), "utf8")) as {
  fileMetadata: Record<string, { bundle: string }>;
};
const marker = /"(.*)"/.exec(readFileSync("marker.js", "utf8"))?.[1] ?? "";
for (const { bundle } of Object.values(fileMetadata)) {
  writeFileSync(join(out, bundle), markedBundle(marker));
}
