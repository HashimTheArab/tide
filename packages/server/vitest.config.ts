import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// The same tests prove both runtimes: workerd through the Workers entry, Node through the Node entry.
export default defineConfig({
  test: {
    projects: [
      { test: { name: "node", include: ["test/node/**/*.test.ts"] } },
      {
        plugins: [cloudflareTest({ wrangler: { configPath: "./wrangler.jsonc" } })],
        test: { name: "workers", include: ["test/workers/**/*.test.ts"] },
      },
    ],
  },
});
