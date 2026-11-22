import { readdirSync, readFileSync } from "node:fs";
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

import { fcSeed } from "./test/fc-seed.ts";

// Fixtures travel as byte arrays, so workerd sees exactly the committed bytes.
const dir = new URL("test/fixtures/", import.meta.url);
const fixtures = Object.fromEntries(
  readdirSync(dir).map((name) => [name, [...readFileSync(new URL(name, dir))]]),
);

const provide = { fcSeed: fcSeed(process.env.FC_SEED), fixtures };

// One shared test module runs on both runtimes.
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "node",
          include: ["test/protocol.test.ts", "test/x509.node.test.ts"],
          provide,
        },
      },
      {
        plugins: [cloudflareTest({ miniflare: { compatibilityDate: "2026-11-01" } })],
        test: { name: "workers", include: ["test/protocol.test.ts"], provide },
      },
    ],
  },
});
