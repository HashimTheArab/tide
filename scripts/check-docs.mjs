// Fails when docs/ holds a file outside an assets/ or examples/ folder that is not an indexed markdown doc with status
// front matter, when deploy.md omits a permission the server's S3 credentials need, when README.md drifts from the
// tagline, the files it links or the CLI's commands and flags, when the CLI's README misses a command or flag, or when
// agents.md or an example names a command or flag the CLI does not have.
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const docsDir = join(root, "docs");
const index = readFileSync(join(docsDir, "README.md"), "utf8");

/** @type {(dir: string) => string[]} */
const walk = (dir) =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (!entry.isDirectory()) return [path];
    return entry.name === "assets" || entry.name === "examples" ? [] : walk(path);
  });

const errors = [];
for (const path of walk(docsDir)) {
  const rel = relative(docsDir, path);
  if (rel === "README.md" || rel.endsWith(".DS_Store")) continue;
  if (!rel.endsWith(".md")) {
    errors.push(
      `${rel}: only markdown docs belong here; put files in an assets/ or examples/ folder`,
    );
    continue;
  }
  if (!index.includes(`](${rel})`)) {
    errors.push(`${rel}: not linked from docs/README.md`);
  }
  const frontMatter = /^---\n([\s\S]*?)\n---\n/.exec(readFileSync(path, "utf8"))?.[1] ?? "";
  if (!/^status: (draft|decided|superseded)$/m.test(frontMatter)) {
    errors.push(`${rel}: front matter needs status: draft | decided | superseded`);
  }
  if (!/^updated: \d{4}-\d{2}-\d{2}$/m.test(frontMatter)) {
    errors.push(`${rel}: front matter needs updated: YYYY-MM-DD`);
  }
}

// The container's variable table must name each permission the server's S3 credentials need.
const s3Bullet = /^- \*\*S3\*\* \(Node\)[\s\S]*?(?=\n- )/m.exec(
  readFileSync(join(docsDir, "design.md"), "utf8"),
)?.[0];
const permissions = new Set(s3Bullet?.match(/`s3:\w+`/g) ?? []);
if (permissions.size === 0) errors.push("design.md: the S3 bullet names no s3: permission");
const deploy = readFileSync(join(docsDir, "deploy.md"), "utf8");
for (const permission of permissions) {
  if (!deploy.includes(permission)) {
    errors.push(`deploy.md: does not name ${permission}, which the server's S3 credentials need`);
  }
}

// README (or the file argv[2] names): opens with the package description as its tagline, links only to files that exist,
// and names only the CLI commands and flags the CLI's own usage lists, across shell line continuations.
const readme = readFileSync(process.argv[2] ?? join(root, "README.md"), "utf8");
const tagline =
  /** @type {{ description?: string }} */ (
    JSON.parse(readFileSync(join(root, "package.json"), "utf8"))
  ).description ?? "";
if (tagline === "") errors.push("package.json: needs a description, the README's tagline");
if (!readme.startsWith(`# Tide\n\n**${tagline}**\n`)) {
  errors.push(`README.md: must open with "# Tide" and the tagline **${tagline}**`);
}
for (const [, target] of readme.matchAll(/\]\(([^)#\s]+)(?:#[^)]*)?\)/g)) {
  if (!/^[a-z]+:/.test(target) && !existsSync(join(root, target))) {
    errors.push(`README.md: links to ${target}, which does not exist`);
  }
}
const usage = spawnSync(process.execPath, [join(root, "packages/cli/src/main.ts")], {
  encoding: "utf8",
}).stderr;
/** @type {Map<string, Set<string>>} */
const flags = new Map();
for (const [, command, rest] of usage.matchAll(/^(?:usage:)?\s*tide ([a-z-]+)(.*)$/gm)) {
  const known = flags.get(command) ?? new Set();
  for (const [flag] of rest.matchAll(/--[a-z-]+/g)) known.add(flag);
  flags.set(command, known);
}
if (flags.size === 0) errors.push("packages/cli/src/main.ts: printed no usage");
/** Returns the CLI commands `doc` names, adding an error for each command or flag the CLI does not have. */
const commandsIn = (/** @type {string} */ doc, /** @type {string} */ name) => {
  const named = new Set();
  for (const [, command, rest] of doc
    .replaceAll(/\\\n\s*/g, " ")
    .matchAll(/\btide ([a-z][a-z-]*)([^\n`|]*)/g)) {
    const known = flags.get(command);
    if (known === undefined) {
      errors.push(`${name}: names tide ${command}, which the CLI does not have`);
      continue;
    }
    named.add(command);
    for (const [flag] of rest.matchAll(/--[a-z-]+/g)) {
      if (!known.has(flag)) errors.push(`${name}: tide ${command} has no ${flag}`);
    }
  }
  return named;
};
commandsIn(readme, "README.md");
// The CLI's npm README (or the file argv[3] names) lists every command.
const cliNamed = commandsIn(
  readFileSync(process.argv[3] ?? join(root, "packages/cli/README.md"), "utf8"),
  "packages/cli/README.md",
);
for (const command of flags.keys()) {
  if (!cliNamed.has(command)) errors.push(`packages/cli/README.md: does not name tide ${command}`);
}
// The runbook and the examples (or the files from argv[4] on).
const operating =
  process.argv.length > 4
    ? process.argv.slice(4)
    : [
        "agents.md",
        ...readdirSync(join(docsDir, "examples")).map((name) => `examples/${name}`),
      ].map((name) => join(docsDir, name));
for (const path of operating) commandsIn(readFileSync(path, "utf8"), relative(root, path));

if (errors.length > 0) {
  console.error(`docs check failed:\n${errors.map((e) => `  ${e}`).join("\n")}`);
  process.exit(1);
}
