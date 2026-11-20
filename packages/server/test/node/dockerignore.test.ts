import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

const ROOT = fileURLToPath(new URL("../../../../", import.meta.url));

// The image context is an allowlist of files by name, so an untracked source file or secret can never enter it.
test("Dockerfile.dockerignore admits exactly the tracked manifests and runtime sources", () => {
  const lines = readFileSync(new URL("../../Dockerfile.dockerignore", import.meta.url), "utf8")
    .split("\n")
    .filter((l) => l !== "" && !l.startsWith("#"));
  const tracked = execFileSync(
    "git",
    [
      "ls-files",
      "--",
      "package.json",
      "pnpm-lock.yaml",
      "pnpm-workspace.yaml",
      "packages/*/package.json",
      "examples/*/package.json",
      ":(glob)packages/server/src/**/*.ts",
      ":(glob)packages/protocol/src/**/*.ts",
    ],
    { cwd: ROOT, encoding: "utf8" },
  )
    .split("\n")
    .filter(Boolean);
  expect(tracked).toContain("packages/server/src/node.ts");
  expect(tracked).toContain("packages/protocol/src/index.ts");
  expect(lines[0]).toBe("*");
  expect(lines.slice(1).sort()).toEqual(tracked.map((f) => `!${f}`).sort());
});

// A builder that reads only the root .dockerignore must fail closed, not send the checkout.
test("the root .dockerignore admits nothing", () => {
  const lines = readFileSync(join(ROOT, ".dockerignore"), "utf8")
    .split("\n")
    .filter((l) => l !== "" && !l.startsWith("#"));
  expect(lines).toEqual(["*"]);
});
