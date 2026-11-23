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

test("the docs check requires the CLI README to name every command, tide certificate among them", () => {
  const cli = readFileSync(join(ROOT, "packages/cli/README.md"), "utf8");
  expect(cli).toContain("tide certificate --common-name <name> --validity-years <n>");
  const check = (text: string) => {
    const path = join(tempRoot(), "README.md");
    writeFileSync(path, text);
    return spawnSync(
      process.execPath,
      [join(ROOT, "scripts/check-docs.mjs"), join(ROOT, "README.md"), path],
      { encoding: "utf8" },
    );
  };
  expect(check(cli).status).toBe(0);
  const missing = check(cli.replaceAll("tide certificate", "tide"));
  expect(missing.status).toBe(1);
  expect(missing.stderr).toContain("packages/cli/README.md: does not name tide certificate");
});

test.each(["probe", "stats"])("the README names every variable tide %s reads", (command) => {
  const names = variables(section(DESIGN, `### \`tide ${command}\``));
  expect(names.size).toBeGreaterThan(0);
  const operations = section(README, "## Operations");
  for (const name of names) expect(operations).toContain(`\`${name}\``);
});

test("the docs check rejects a command or flag the runbook or an example names and the CLI lacks", () => {
  const check = (name: string, text: string) => {
    const path = join(tempRoot(), name);
    writeFileSync(path, text);
    const [readme, cli] = [join(ROOT, "README.md"), join(ROOT, "packages/cli/README.md")];
    return spawnSync(process.execPath, [join(ROOT, "scripts/check-docs.mjs"), readme, cli, path], {
      encoding: "utf8",
    });
  };
  const runbook = readFileSync(join(ROOT, "docs/agents.md"), "utf8");
  const example = readFileSync(join(ROOT, "docs/examples/revert-rollouts.yml"), "utf8");
  expect(check("agents.md", runbook).status).toBe(0);
  expect(check("revert.yml", example).status).toBe(0);
  for (const [name, text, problem] of [
    [
      "agents.md",
      `${runbook}\n`.replace("tide rollout revert", "tide revert"),
      "names tide revert",
    ],
    [
      "agents.md",
      runbook.replace("rollout revert --platform", "rollout revert --only"),
      "tide rollout has no --only",
    ],
    [
      "revert.yml",
      example.replace("--max-failed-share", "--max-share"),
      "tide stats has no --max-share",
    ],
    ["revert.yml", example.replace("tide rollout revert", "tide pause"), "names tide pause"],
  ] as const) {
    const { status, stderr } = check(name, text);
    expect(status).toBe(1);
    expect(stderr).toContain(`${name}: ${problem}`);
  }
});
