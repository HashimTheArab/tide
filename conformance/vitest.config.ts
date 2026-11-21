import { defineConfig } from "vitest/config";

// The harness runs on the host, so its tests run on Node only; none needs a device.
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // The tests spawn the CLI and fake SDK tools, which miss the 5 s default on a loaded machine.
    testTimeout: 30_000,
  },
});
