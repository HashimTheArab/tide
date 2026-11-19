import { readdirSync, readFileSync } from "node:fs";
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// Fixtures travel as byte arrays, so workerd sees exactly the committed bytes.
const dir = new URL("test/fixtures/", import.meta.url);
const fixtures = Object.fromEntries(
  readdirSync(dir).map((name) => [name, [...readFileSync(new URL(name, dir))]]),
);

/** The gate's fast-check seed; `FC_SEED` replays another. */
const DEFAULT_SEED = 20261119;

/** Returns `raw` as a fast-check seed: an integer in the signed 32-bit range fast-check reports. */
function parseSeed(raw: string): number {
  const seed = Number(raw);
  if (!/^-?\d+$/.test(raw) || seed < -(2 ** 31) || seed > 2 ** 31 - 1) {
    throw new Error(`FC_SEED must be an integer from -2147483648 to 2147483647, got ${raw}`);
  }
  return seed;
}

const seed = process.env.FC_SEED;
const provide = { fcSeed: seed === undefined ? DEFAULT_SEED : parseSeed(seed), fixtures };

// One shared test module runs on both runtimes.
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "node",
          include: ["test/protocol.test.ts", "test/generate-fixtures.test.ts"],
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
