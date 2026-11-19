// Shared by the config (Node) and the tests (Node and workerd), so it imports nothing runtime-specific.

/** Every file in test/fixtures; the config fails when the folder and this list differ. */
export const FIXTURE_NAMES = [
  "asset.png",
  "chain.pem",
  "manifest.json",
  "directive-no-update.json",
  "directive-rollback.json",
  "manifest.multipart",
  "rollback.multipart",
  "no-update.multipart",
  "certificate.multipart",
] as const;
export type FixtureName = (typeof FIXTURE_NAMES)[number];

declare module "vitest" {
  export interface ProvidedContext {
    fcSeed: number;
    fixtures: Record<FixtureName, number[]>;
  }
}

/** The gate's fast-check seed; `FC_SEED` replays another. */
export const DEFAULT_SEED = 20261119;

/** Returns `raw` as a fast-check seed: an integer in the signed 32-bit range fast-check reports. */
export function parseSeed(raw: string): number {
  const seed = Number(raw);
  if (!/^-?\d+$/.test(raw) || seed < -(2 ** 31) || seed > 2 ** 31 - 1) {
    throw new Error(`FC_SEED must be an integer from -2147483648 to 2147483647, got ${raw}`);
  }
  return seed;
}
