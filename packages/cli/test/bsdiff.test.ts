import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import fc from "fast-check";
import { describe, expect, inject, test } from "vitest";

import { applyBsdiff } from "@tide/protocol";

import type { BundleModule } from "./bundle-fixture.ts";
import { MAX_BSDIFF_INPUT, diffBlocks, makeBsdiff } from "../src/bsdiff.ts";
import { bundleVersions, serialiseBundle } from "./bundle-fixture.ts";
import { fixture, prng } from "./helpers.ts";

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const EMPTY = new Uint8Array();

/** Returns `target` rebuilt from `base` by protocol `applyBsdiff`, as a client would. */
const roundTrip = (base: Uint8Array, target: Uint8Array) =>
  applyBsdiff(base, makeBsdiff(base, target), target.length);

describe("makeBsdiff", () => {
  const GOLDEN = ["text", "binary", "identical", "empty-base", "empty-target"];

  test.each(GOLDEN)("a patch for the golden pair %s reproduces its target", (name) => {
    const base = fixture(`patch-${name}.base`);
    const target = fixture(`patch-${name}.target`);
    expect(sha256(roundTrip(base, target))).toBe(sha256(target));
    expect(diffBlocks(base, target).exhausted).toBe(false);
  });

  test("the same inputs give the same patch bytes, here and on every machine", () => {
    const base = fixture("patch-text.base");
    const target = fixture("patch-text.target");
    const patch = makeBsdiff(base, target);
    expect(makeBsdiff(base, target)).toEqual(patch);
    expect(sha256(patch)).toBe("4b51fd5e031f31e7a62f7479199df71090a53651ca3bb1f8f055c51ae30af73c");
  });

  test("an input over MAX_BSDIFF_INPUT is refused before any work", () => {
    const over = new Uint8Array(MAX_BSDIFF_INPUT + 1);
    const small = over.subarray(0, 1);
    expect(() => makeBsdiff(over, small)).toThrow(RangeError);
    expect(() => makeBsdiff(small, over)).toThrow(RangeError);
  });

  test("a long near-match stops at the work budget and still reproduces its target", () => {
    // Each search follows equal prefixes down to a short match, so the unbounded scan compares about 1.3 n^2 bytes.
    const n = 2 ** 14;
    const base = new Uint8Array(2 * n).fill(0x61);
    base[n - 1] = 0x62;
    const target = new Uint8Array(n).fill(0x61);
    expect(diffBlocks(base, target).exhausted).toBe(true);
    expect(roundTrip(base, target)).toEqual(target);
  });
});

describe("bzip2 blocks, through the extra block of a patch from an empty base", () => {
  const BLOCK_MAX = 900_000 - 19; // libbzip2's most RLE1 bytes per level-9 block.
  /** `n` pseudo-random bytes without two equal neighbours, so RLE1 leaves them as they are. */
  const literals = (n: number) => {
    const r = prng(n);
    const out = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      const b = Math.floor(r() * 256);
      out[i] = i > 0 && b === out[i - 1] ? b ^ 1 : b;
    }
    return out;
  };
  /** `head`, then `length` copies of a byte unlike its neighbours, then one more literal. */
  const withRun = (head: Uint8Array, length: number) => {
    const last = head.at(-1) ?? 0;
    const out = new Uint8Array(head.length + length + 1);
    out.set(head);
    out.fill(last ^ 0x80, head.length, head.length + length);
    out[out.length - 1] = last;
    return out;
  };

  const cases: [string, () => Uint8Array][] = [
    ["several blocks of literals", () => literals(1_000_000)],
    ["a run whose four bytes would cross the cap", () => withRun(literals(BLOCK_MAX - 2), 9)],
    ["a run that ends exactly at the cap", () => withRun(literals(BLOCK_MAX - 5), 9)],
    [
      "a run whose four bytes fit but whose count would not",
      () => withRun(literals(BLOCK_MAX - 4), 4),
    ],
    ...[3, 4, 5, 259, 260].map((n): [string, () => Uint8Array] => [
      `a run of ${n}`,
      () => withRun(literals(7), n),
    ]),
  ];
  test.each(cases)("%s", (_, make) => {
    const target = make();
    expect(sha256(roundTrip(EMPTY, target))).toBe(sha256(target));
  });
});

describe(`properties (seed ${inject("fcSeed")})`, () => {
  const seed = inject("fcSeed");
  const bytes = (maxLength: number) => fc.uint8Array({ maxLength });
  const edit = fc.record({
    kind: fc.constantFrom("insert", "delete", "replace", "move"),
    at: fc.nat(),
    to: fc.nat(),
    length: fc.integer({ min: 1, max: 64 }),
    data: fc.uint8Array({ minLength: 1, maxLength: 32 }),
  });
  type Edit = typeof edit extends fc.Arbitrary<infer T> ? T : never;
  /** Returns `base` with each edit applied in turn; positions wrap to the current length. */
  const edited = (base: Uint8Array, edits: readonly Edit[]) => {
    const b = [...base];
    for (const e of edits) {
      const at = b.length === 0 ? 0 : e.at % b.length;
      const cut = b.slice(at, at + e.length);
      if (e.kind === "insert") b.splice(at, 0, ...e.data);
      else if (e.kind === "delete") b.splice(at, e.length);
      else if (e.kind === "replace") b.splice(at, e.data.length, ...e.data);
      else {
        b.splice(at, e.length);
        b.splice(b.length === 0 ? 0 : e.to % (b.length + 1), 0, ...cut);
      }
    }
    return Uint8Array.from(b);
  };
  /** Runs over a two-byte alphabet: RLE1 edges and periodic BWT blocks. */
  const runs = fc
    .array(
      fc.record({ byte: fc.constantFrom(0x61, 0x62), length: fc.integer({ min: 1, max: 600 }) }),
      {
        maxLength: 16,
      },
    )
    .map((rs) => Uint8Array.from(rs.flatMap((r) => Array<number>(r.length).fill(r.byte))));
  const smallEdits = (base: fc.Arbitrary<Uint8Array>) =>
    fc
      .tuple(base, fc.array(edit, { minLength: 1, maxLength: 6 }))
      .map(([b, es]) => [b, edited(b, es)] as const);
  const pairs = fc.oneof(
    fc.tuple(bytes(1024), bytes(1024)),
    bytes(1024).map((b) => [b, b] as const),
    fc.tuple(
      fc.uint8Array({ max: 127, maxLength: 512 }),
      fc.uint8Array({ min: 128, maxLength: 512 }),
    ),
    smallEdits(bytes(4096)),
    fc.tuple(fc.constant(EMPTY), bytes(1024)),
    fc.tuple(bytes(1024), fc.constant(EMPTY)),
    fc.tuple(runs, runs),
    smallEdits(runs),
  );

  test("a patch from any base reproduces its target, and the same inputs give the same bytes", () => {
    fc.assert(
      fc.property(pairs, ([base, target]) => {
        const patch = makeBsdiff(base, target);
        expect(applyBsdiff(base, patch, target.length)).toEqual(target);
        expect(makeBsdiff(base, target)).toEqual(patch);
      }),
      { seed },
    );
  });
});

describe("a Metro-shaped bundle", () => {
  const { v1, v2 } = bundleVersions();
  const base = serialiseBundle(v1);
  const target = serialiseBundle(v2);

  test("version 2 renumbers most retained modules and their dependency references", () => {
    const ids = (list: readonly BundleModule[]) => new Map(list.map((m, i) => [m.path, i]));
    const [before, after] = [ids(v1), ids(v2)];
    const refs = (m: BundleModule, of: Map<string, number>) =>
      m.deps
        .filter((d) => after.has(d))
        .map((d) => of.get(d))
        .join();
    const kept = v1.filter((m) => after.has(m.path));
    const linked = kept.filter((m) => m.deps.some((d) => after.has(d)));
    const moved = kept.filter((m) => before.get(m.path) !== after.get(m.path));
    const relinked = linked.filter((m) => refs(m, before) !== refs(m, after));
    expect(base.length).toBeGreaterThanOrEqual(2 * 1024 * 1024);
    expect(target.length).toBeGreaterThanOrEqual(2 * 1024 * 1024);
    expect(moved.length / kept.length).toBeGreaterThan(0.9);
    expect(relinked.length / linked.length).toBeGreaterThan(0.9);
  });

  test("the patch is under a tenth of the gzipped target", () => {
    const patch = makeBsdiff(base, target);
    expect(sha256(applyBsdiff(base, patch, target.length))).toBe(sha256(target));
    expect(patch.length * 10).toBeLessThan(gzipSync(target, { level: 9 }).length);
  });
});
