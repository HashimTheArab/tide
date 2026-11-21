import { defineConfig } from "vitest/config";

// The harness runs on the host, so its tests run on Node only; none needs a device.
export default defineConfig({ test: { include: ["test/**/*.test.ts"] } });
