import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

import { tempRoot } from "./helpers.ts";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const README = readFileSync(join(ROOT, "README.md"), "utf8");
const DESIGN = readFileSync(join(ROOT, "docs/design.md"), "utf8");

/** The text from `heading` to the next heading of the same or a higher level. */
const section = (doc: string, heading: string) => {
  const start = doc.indexOf(`\n${heading}\n`);
  expect(start, heading).toBeGreaterThan(-1);
  const level = /^#+/.exec(heading)?.[0] ?? "";
  const end = doc
    .slice(start + heading.length + 2)
    .search(new RegExp(`^#{1,${level.length}} `, "m"));
  return end === -1 ? doc.slice(start) : doc.slice(start, start + heading.length + 2 + end);
};
const variables = (text: string) => new Set(text.match(/\bTIDE_[A-Z0-9_]+\b/g));

test("the docs check rejects an unknown flag on a continued command line", () => {
  const { description } = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
    description: string;
  };
  const check = (flag: string) => {
    const path = join(tempRoot(), "README.md");
    writeFileSync(
      path,
      `# Tide\n\n**${description}**\n\n\`\`\`sh\ntide register-build --platform android \\\n  ${flag} <dir>\n\`\`\`\n`,
    );
    return spawnSync(process.execPath, [join(ROOT, "scripts/check-docs.mjs"), path], {
      encoding: "utf8",
    });
  };
  expect(check("--assets-dir").status).toBe(0);
  const typo = check("--asset-dirr");
  expect(typo.status).toBe(1);
  expect(typo.stderr).toContain("README.md: tide register-build has no --asset-dirr");
});

// expo-updates' codesigning:generate exits without writing anything unless all four flags are given.
test("the README's certificate command is complete and writes the key outside the app", () => {
  const command = /npx expo-updates codesigning:generate((?:[^\n]*\\\n)*[^\n]*)/
    .exec(README)?.[1]
    ?.replaceAll(/\\\n\s*/g, " ");
  const flags = new Map(
    [...(command ?? "").matchAll(/(--[a-z-]+) ("[^"]*"|\S+)/g)].map(([, f, v]) => [f, v]),
  );
  expect(new Set(flags.keys())).toEqual(
    new Set([
      "--certificate-common-name",
      "--certificate-output-directory",
      "--certificate-validity-duration-years",
      "--key-output-directory",
    ]),
  );
  const certificate = /codeSigningCertificate: "\.\/([^"]+)"/.exec(README)?.[1];
  expect(certificate).toBe(`${flags.get("--certificate-output-directory")}/certificate.pem`);
  expect(flags.get("--key-output-directory")).toMatch(/^\.\.\//);
});

// The Node server serves no non-launch assets, so a container needs both signed origins before its first publish.
test("the container quick start names every origin publish signs into manifests", () => {
  const origins = variables(/^\*\*Configuration\.\*\*[^\n]*/m.exec(DESIGN)?.[0] ?? "");
  expect([...origins]).toEqual(["TIDE_SERVER_URL", "TIDE_ASSET_URL"]);
  const container = section(README, "### Container");
  for (const origin of origins) expect(container).toContain(`\`${origin}\``);
  expect(container).toContain("`assets/`");
});

test("the README names every build pin tide probe requires", () => {
  const pins = variables(section(DESIGN, "### `tide probe`"));
  expect(pins.size).toBeGreaterThan(0);
  const operations = section(README, "## Operations");
  for (const pin of pins) expect(operations).toContain(`\`${pin}\``);
});
