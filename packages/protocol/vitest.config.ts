import { readdirSync, readFileSync } from "node:fs";
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

import type { FixtureName } from "./test/context.ts";
import { DEFAULT_SEED, FIXTURE_NAMES, parseSeed } from "./test/context.ts";

// Fixtures travel as byte arrays, so workerd sees exactly the committed bytes.
const dir = new URL("test/fixtures/", import.meta.url);
const known: readonly string[] = FIXTURE_NAMES;
for (const file of readdirSync(dir)) {
  if (!known.includes(file)) throw new Error(`test/fixtures/${file} is not in FIXTURE_NAMES`);
}
const fixtures = Object.fromEntries(
  FIXTURE_NAMES.map((name) => [name, [...readFileSync(new URL(name, dir))]]),
) as Record<FixtureName, number[]>;
const seed = process.env.FC_SEED;
const provide = { fcSeed: seed === undefined ? DEFAULT_SEED : parseSeed(seed), fixtures };

// One shared test module runs on both runtimes.
export default defineConfig({
  test: {
    projects: [
      { test: { name: "node", include: ["test/protocol.test.ts"], provide } },
      {
        plugins: [cloudflareTest({ miniflare: { compatibilityDate: "2026-11-01" } })],
        test: { name: "workers", include: ["test/protocol.test.ts"], provide },
      },
    ],
  },
});
