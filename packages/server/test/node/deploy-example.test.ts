import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { parse } from "yaml";

const ROOT = fileURLToPath(new URL("../../../../", import.meta.url));

interface Job {
  concurrency: { "cancel-in-progress": boolean; queue?: string };
  steps: { run?: string; "working-directory"?: string }[];
}
const { jobs } = parse(readFileSync(join(ROOT, "docs/examples/deploy-workers.yml"), "utf8")) as {
  jobs: Record<string, Job>;
};

// A rerun of an older commit must queue behind the pending head, not replace it.
test("each deploy job queues its runs instead of replacing a pending one", () => {
  expect(
    Object.entries(jobs).map(([name, { concurrency }]) => [
      name,
      concurrency["cancel-in-progress"],
      concurrency.queue,
    ]),
  ).toEqual([
    ["staging", false, "max"],
    ["production", false, "max"],
  ]);
});

// The workspace root has neither Wrangler nor its config; the operator project has both.
test("each Wrangler step runs where pnpm exec finds Wrangler and wrangler.jsonc", () => {
  const steps = Object.values(jobs).flatMap((job) =>
    job.steps.filter((step) => step.run?.includes("wrangler") === true),
  );
  expect(steps).toHaveLength(2);
  for (const step of steps) {
    const dir = join(ROOT, step["working-directory"] ?? ".");
    expect([
      existsSync(join(dir, "node_modules/.bin/wrangler")),
      existsSync(join(dir, "wrangler.jsonc")),
    ]).toEqual([true, true]);
  }
});
