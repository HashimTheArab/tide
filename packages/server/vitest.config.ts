import { readdirSync, readFileSync } from "node:fs";
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// The protocol's golden fixtures travel as byte arrays, so workerd sees exactly the committed bytes.
const dir = new URL("../protocol/test/fixtures/", import.meta.url);
const fixtures = Object.fromEntries(
  readdirSync(dir).map((name) => [name, [...readFileSync(new URL(name, dir))]]),
);
// Each project starts its own fake S3 and receives its endpoint.
const globalSetup = ["test/fakes/s3-global.ts"];

// The same tests prove both runtimes: workerd through the Workers entry, Node through the Node entry.
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "node",
          include: ["test/node/**/*.test.ts"],
          provide: { fixtures },
          globalSetup,
        },
      },
      {
        plugins: [
          cloudflareTest({
            wrangler: { configPath: "./wrangler.jsonc" },
            miniflare: { bindings: { TIDE_APP_ID: "tide-test" } },
          }),
        ],
        test: {
          name: "workers",
          include: ["test/workers/**/*.test.ts"],
          provide: { fixtures },
          globalSetup,
        },
      },
    ],
  },
});
