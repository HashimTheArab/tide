import { readFileSync } from "node:fs";
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

const fixture = (name: string) => [
  ...readFileSync(new URL(`../../packages/protocol/test/fixtures/${name}`, import.meta.url)),
];
const fixtures = {
  noUpdateReply: fixture("no-update.reply.json"),
  noUpdateMultipart: fixture("no-update.multipart"),
};

// The same tests run against each named environment, as Wrangler deploys it.
export default defineConfig({
  test: {
    projects: (["staging", "production"] as const).map((environment) => ({
      plugins: [cloudflareTest({ wrangler: { configPath: "./wrangler.jsonc", environment } })],
      test: {
        name: environment,
        include: ["test/**/*.test.ts"],
        provide: { fixtures, appId: `example-app-${environment}` },
      },
    })),
  },
});
