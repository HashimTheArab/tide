import { defineConfig } from "vitest/config";

import { fcSeed } from "../protocol/test/fc-seed.ts";

// The CLI runs on Node only.
export default defineConfig({
  test: { include: ["test/**/*.test.ts"], provide: { fcSeed: fcSeed(process.env.FC_SEED) } },
});
