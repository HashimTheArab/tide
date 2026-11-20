/** The gate's fast-check seed. */
const DEFAULT_SEED = 20261119;

/** Returns the seed `FC_SEED` names, an integer in the signed 32-bit range fast-check reports, or the gate's. */
export function fcSeed(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_SEED;
  const seed = Number(raw);
  if (!/^-?\d+$/.test(raw) || seed < -(2 ** 31) || seed > 2 ** 31 - 1) {
    throw new Error(`FC_SEED must be an integer from -2147483648 to 2147483647, got ${raw}`);
  }
  return seed;
}
