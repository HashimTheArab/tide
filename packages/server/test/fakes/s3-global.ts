import type { TestProject } from "vitest/node";

import { startFakeS3 } from "./s3.ts";

/** Starts one fake S3 per test project, so projects running at once never share its scripts or events. */
export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const fake = await startFakeS3();
  project.provide("fakeS3Endpoint", fake.endpoint);
  return () => fake.close();
}
