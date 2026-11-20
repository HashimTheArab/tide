import { defineConfig } from "vitest/config";

// The image smoke test: run by `pnpm test:container` and the CI container job, never by the gate.
export default defineConfig({
  test: {
    include: ["test/container/**/*.smoke.ts"],
    globalSetup: ["test/container/image-setup.ts"],
  },
});
