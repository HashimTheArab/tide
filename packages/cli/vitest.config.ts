import { defineConfig } from "vitest/config";

// The CLI runs on Node only.
export default defineConfig({ test: { include: ["test/**/*.test.ts"] } });
