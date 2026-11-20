// Fails when docs/ holds a file outside an assets/ or examples/ folder that is not an indexed markdown doc with status
// front matter, or when deploy.md omits a permission the server's S3 credentials need.
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const docsDir = fileURLToPath(new URL("../docs/", import.meta.url));
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

if (errors.length > 0) {
  console.error(`docs check failed:\n${errors.map((e) => `  ${e}`).join("\n")}`);
  process.exit(1);
}
