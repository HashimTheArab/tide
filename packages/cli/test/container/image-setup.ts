import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { TestProject } from "vitest/node";

declare module "vitest" {
  export interface ProvidedContext {
    image: { tag: string };
    rootContext: string[];
  }
}

const ROOT = fileURLToPath(new URL("../../../../", import.meta.url));

/** Builds the image once, outside any test timeout, and removes it afterwards. */
export default function setup(project: TestProject): () => void {
  try {
    execFileSync("docker", ["version"], { stdio: "ignore" });
  } catch {
    throw new Error("the container smoke test needs a running docker");
  }
  const tag = `tide-smoke:${randomUUID()}`;
  execFileSync(
    "docker",
    ["build", "--quiet", "-f", join(ROOT, "packages/server/Dockerfile"), "-t", tag, ROOT],
    { stdio: "inherit" },
  );
  project.provide("image", { tag });
  // A Dockerfile from stdin has no per-Dockerfile ignore file, so this exports what the root .dockerignore admits.
  const context = mkdtempSync(join(tmpdir(), "tide-context-"));
  try {
    execFileSync(
      "docker",
      ["build", "--quiet", "-f", "-", "--output", `type=local,dest=${context}`, ROOT],
      { input: "FROM scratch\nCOPY . /\n", stdio: ["pipe", "ignore", "inherit"] },
    );
    project.provide("rootContext", readdirSync(context, { recursive: true, encoding: "utf8" }));
  } finally {
    rmSync(context, { recursive: true, force: true });
  }
  return () => {
    execFileSync("docker", ["image", "rm", "--force", tag], { stdio: "ignore" });
  };
}
