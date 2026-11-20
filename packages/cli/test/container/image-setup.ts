import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { TestProject } from "vitest/node";

declare module "vitest" {
  export interface ProvidedContext {
    image: { tag: string; base: string; saved: string }; // `saved` is the `docker image save` archive.
  }
}

const ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const DOCKERFILE = join(ROOT, "packages/server/Dockerfile");

/** Builds the image once, outside any test timeout, and removes it afterwards. */
export default function setup(project: TestProject): () => void {
  try {
    execFileSync("docker", ["version"], { stdio: "ignore" });
  } catch {
    throw new Error("the container smoke test needs a running docker");
  }
  const bases = [...readFileSync(DOCKERFILE, "utf8").matchAll(/^FROM (\S+)/gm)].map((m) => m[1]);
  const base = bases[0];
  if (base === undefined || !bases.every((b) => b === base) || !base.includes("@sha256:")) {
    throw new Error("every Dockerfile stage must use one base pinned by digest");
  }
  const tag = `tide-smoke:${randomUUID()}`;
  const dir = mkdtempSync(join(tmpdir(), "tide-image-"));
  const saved = join(dir, "image.tar");
  try {
    execFileSync("docker", ["pull", "--quiet", base], { stdio: "inherit" });
    execFileSync("docker", ["build", "--quiet", "-f", DOCKERFILE, "-t", tag, ROOT], {
      stdio: "inherit",
    });
    execFileSync("docker", ["image", "save", "-o", saved, tag]);
  } catch (e) {
    rmSync(dir, { recursive: true, force: true });
    throw e;
  }
  project.provide("image", { tag, base, saved });
  return () => {
    rmSync(dir, { recursive: true, force: true });
    execFileSync("docker", ["image", "rm", "--force", tag], { stdio: "ignore" });
  };
}
