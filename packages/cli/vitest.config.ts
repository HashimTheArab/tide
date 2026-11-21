import { defineConfig } from "vitest/config";

import { fcSeed } from "../protocol/test/fc-seed.ts";

// The CLI runs on Node only.
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    provide: { fcSeed: fcSeed(process.env.FC_SEED) },
    // Pure-JS bsdiff and bzip2 over megabytes miss the 5 s default on a loaded machine.
    testTimeout: 30_000,
  },
});
