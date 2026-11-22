// Patch sizes as Tide stores them: makeBsdiff patches that pass the publish self-check, judged by the keep rule.
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

import { sha256Base64Url } from "@tide-ota/protocol";

import type { AppId, ChangeId } from "./apps.ts";
import { makeBsdiff } from "../../../packages/cli/src/bsdiff.ts";
import { checkPatch, keepsPatch } from "../../../packages/cli/src/publish-patch.ts";
import { CHANGES } from "./apps.ts";

/** The bundles a device can be running when the measured update is published. */
export const BASES = {
  ota: "the previous OTA update (the OTA compile base)",
  embedded: "the bundle the release build embeds (the embedded compile base)",
  "older-ota": "an OTA update one release older, from the embedded build's source",
} as const;
export type BaseKind = keyof typeof BASES;

/** The OTA bases once every update is compiled against the embedded bundle; that base never changes, so no chain. */
export const STEADY_BASES = {
  ota: "the previous OTA update, itself delta-compiled against the embedded base",
  "older-ota": "the older OTA update, itself delta-compiled against the embedded base",
} as const;
type SteadyBaseKind = keyof typeof STEADY_BASES;

/** The new bundle, built three ways from the same JS. */
export const TARGETS = {
  plain: "what expo export writes",
  "delta-ota": "the same JS and flags, plus -base-bytecode of the OTA base",
  "delta-embedded": "the same JS and flags, plus -base-bytecode of the embedded base",
} as const;
export type TargetKind = keyof typeof TARGETS;

export const KEEP_RULE =
  "Tide stores a patch only when its bytes times two are at most the gzip-9 size of the new bundle " +
  "(packages/cli/src/publish-patch.ts keepsPatch)";

export interface Bundle {
  readonly bytes: number;
  readonly sha256: string; // Hex.
  readonly gzip9: number;
}

/**
 * A stored patch; reuse, when an OTA base is the target and the device already holds it; or no patch, when the
 * embedded base is the target: the client keys that asset `bundle-<updateId>`, not by hash, so it downloads the bundle.
 */
type PatchSize =
  | { readonly bytes: number; readonly keep: boolean }
  | { readonly reused: true }
  | { readonly noPatch: true };

export type MeasuredTarget = Bundle & { readonly from: Readonly<Record<BaseKind, PatchSize>> };

/** Returns a bundle's size, hex SHA-256 and gzip-9 size. */
export function describe(bytes: Uint8Array): Bundle {
  return {
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    gzip9: gzipSync(bytes, { level: 9 }).length,
  };
}

/**
 * Returns each target's size and the patch to it from each base it differs from. Every patch is Tide's makeBsdiff
 * output and has passed checkPatch against the target's SHA-256; a patch that does not reproduce its target throws.
 */
export async function measureTargets(
  bases: Readonly<Record<BaseKind, Uint8Array<ArrayBuffer>>>,
  targets: Readonly<Record<TargetKind, Uint8Array<ArrayBuffer>>>,
): Promise<Record<TargetKind, MeasuredTarget>> {
  const out: Partial<Record<TargetKind, MeasuredTarget>> = {};
  for (const kind of Object.keys(TARGETS) as TargetKind[]) {
    const bundle = describe(targets[kind]);
    out[kind] = { ...bundle, from: await patchesTo(bases, targets[kind], bundle.gzip9, kind) };
  }
  return out as Record<TargetKind, MeasuredTarget>;
}

/** Returns the patch to `target` from each base, measured and checked as `measureTargets` does. */
export async function patchesTo<K extends BaseKind>(
  bases: Readonly<Record<K, Uint8Array<ArrayBuffer>>>,
  target: Uint8Array<ArrayBuffer>,
  gzip9: number,
  label: string,
): Promise<Record<K, PatchSize>> {
  const hash = await sha256Base64Url(target);
  const from: Partial<Record<K, PatchSize>> = {};
  for (const base of Object.keys(bases) as K[]) {
    if (Buffer.from(bases[base]).equals(target)) {
      from[base] = base === "embedded" ? { noPatch: true } : { reused: true };
      continue;
    }
    const patch = makeBsdiff(bases[base], target);
    await checkPatch(bases[base], patch, { bytes: target, hash }, `${base} to ${label}`);
    from[base] = { bytes: patch.length, keep: keepsPatch(patch.length, gzip9) };
  }
  return from as Record<K, PatchSize>;
}

/** One app's measurements and the facts needed to rerun and read them. */
export interface AppResult {
  readonly id: AppId;
  readonly title: string;
  readonly source: Readonly<Record<string, string>>;
  readonly platform: "android";
  readonly machine: Readonly<Record<string, string>>;
  readonly tools: unknown;
  readonly export: unknown;
  readonly embedded: unknown;
  readonly delta: { readonly hermescArgs: readonly string[] };
  readonly bases: Readonly<Record<BaseKind, Bundle>>;
  readonly steadyBases: Readonly<Record<SteadyBaseKind, Bundle>>;
  readonly changes: Readonly<Record<ChangeId, ChangeResult>>;
}

/** One change: its patch file, its size in files and lines, and the targets built from it. */
export interface ChangeResult {
  readonly patch: string;
  readonly files: number;
  readonly added: number;
  readonly removed: number;
  readonly targets: Readonly<Record<TargetKind, MeasuredTarget>>;
  readonly steady: Readonly<Record<SteadyBaseKind, PatchSize>>; // To delta-embedded.
}

/** One app's results file: each run writes only its own apps' files, so runs of other apps never race on one. */
export interface Results {
  readonly schema: 3;
  readonly about: string;
  readonly keepRule: string;
  readonly bases: typeof BASES;
  readonly steadyBases: typeof STEADY_BASES;
  readonly targets: typeof TARGETS;
  readonly app: AppResult;
}

/** Writes `results` to `<app id>.json` and its table to `<app id>.md` under `out`; returns the JSON path. */
export function writeResults(out: string, results: Results): string {
  mkdirSync(out, { recursive: true });
  const json = join(out, `${results.app.id}.json`);
  writeFileSync(json, `${JSON.stringify(results, null, 2)}\n`);
  writeFileSync(join(out, `${results.app.id}.md`), renderTable(results));
  return json;
}

const OTHER = { ota: "embedded", embedded: "ota" } as const;
const n = (x: number) => x.toLocaleString("en-US");
const saved = (plain: number, delta: number) =>
  plain === 0 ? (delta === 0 ? "0%" : "n/a") : `${(((plain - delta) / plain) * 100).toFixed(1)}%`;
const download = (t: MeasuredTarget, b: BaseKind) => {
  const p = t.from[b];
  return "reused" in p ? 0 : "noPatch" in p ? t.gzip9 : p.bytes;
};
const size = (p: PatchSize) => ("reused" in p ? "reused" : "noPatch" in p ? "full" : n(p.bytes));
const yn = (p: PatchSize) =>
  "reused" in p ? "reused" : "noPatch" in p ? "full" : p.keep ? "yes" : "no";

/** Returns an app's results as Markdown: one row per change and compile base, then totals of the bytes downloaded. */
export function renderTable(results: Results): string {
  const { app } = results;
  const lines = [
    `# Hermes delta compiles: ${app.title}`,
    "",
    `Generated by \`pnpm hermes-delta\` from the JSON file of the same name beside this file. ${results.about}`,
    "",
    `Patch bytes are Tide's makeBsdiff output, each checked with checkPatch. ${results.keepRule}.`,
    "Each cell gives the patch to the plain bundle, then to the bundle delta-compiled against the compile base;",
    "reused means the base is that bundle, so Tide stores no patch and the device downloads nothing; full means",
    "the embedded base is that bundle, but the client cannot reuse it, so it downloads the bundle (its gzip-9 size).",
    "",
    `Source: ${Object.values(app.source).join(" ")}. Bases: embedded ${n(app.bases.embedded.bytes)} B, ` +
      `OTA ${n(app.bases.ota.bytes)} B, older OTA ${n(app.bases["older-ota"].bytes)} B.`,
    "",
    "| Change | Compile base | From compile base | Saved | From other base | From older OTA | " +
      "Target gzip-9 plain / delta | Kept plain / delta (compile, other, older) |",
    "| --- | --- | --- | --- | --- | --- | --- | --- |",
  ];
  const total = (target: TargetKind, b: BaseKind) =>
    Object.values(app.changes).reduce((sum, c) => sum + download(c.targets[target], b), 0);
  for (const change of Object.keys(CHANGES) as ChangeId[]) {
    const c = app.changes[change];
    for (const base of ["ota", "embedded"] as const) {
      const plain = c.targets.plain;
      const delta = c.targets[`delta-${base}`];
      const pairs = [base, OTHER[base], "older-ota"] as const;
      const cell = (b: BaseKind) => `${size(plain.from[b])} → ${size(delta.from[b])}`;
      const kept = (t: MeasuredTarget) => pairs.map((b) => yn(t.from[b])).join(" ");
      lines.push(
        `| ${change} (+${c.added} −${c.removed}) | ${base} | ${cell(base)} | ` +
          `${saved(download(plain, base), download(delta, base))} | ${cell(OTHER[base])} | ` +
          `${cell("older-ota")} | ${n(plain.gzip9)} / ${n(delta.gzip9)} | ${kept(plain)} / ${kept(delta)} |`,
      );
    }
  }
  for (const base of ["ota", "embedded"] as const) {
    const cell = (b: BaseKind) => `${n(total("plain", b))} → ${n(total(`delta-${base}`, b))}`;
    lines.push(
      `| all changes | ${base} | ${cell(base)} | ${saved(total("plain", base), total(`delta-${base}`, base))} | ` +
        `${cell(OTHER[base])} | ${cell("older-ota")} | | |`,
    );
  }
  // What the client downloads: a patch Tide does not keep costs the full bundle, as no patch does.
  const fetched = (t: MeasuredTarget, p: PatchSize) =>
    "reused" in p ? 0 : "noPatch" in p || !p.keep ? t.gzip9 : p.bytes;
  const rows = (Object.keys(CHANGES) as ChangeId[]).map((change) => {
    const c = app.changes[change];
    const { plain } = c.targets;
    const delta = c.targets["delta-embedded"];
    return {
      name: `${change} (+${c.added} −${c.removed})`,
      plain: (["embedded", "ota", "older-ota"] as const).map((b) => fetched(plain, plain.from[b])),
      delta: [
        fetched(delta, delta.from.embedded),
        fetched(delta, c.steady.ota),
        fetched(delta, c.steady["older-ota"]),
      ],
    };
  });
  const column = (k: "plain" | "delta", i: number) =>
    rows.reduce((sum, r) => sum + (r[k][i] ?? 0), 0);
  lines.push(
    "",
    "With the embedded compile base, once every OTA update is itself delta-compiled against the embedded bundle:",
    "plain bundles from plain bases, then the delta-embedded bundle from the embedded bundle and from those bases.",
    "Each cell is what the client downloads: the patch, or the bundle's gzip-9 size when Tide keeps no patch.",
    "",
    "| Change | From embedded | From OTA base | From older OTA | All bases | Saved |",
    "| --- | --- | --- | --- | --- | --- |",
    ...rows.map((r) => steadyRow(r.name, r.plain, r.delta)),
    steadyRow(
      "all changes",
      [0, 1, 2].map((i) => column("plain", i)),
      [0, 1, 2].map((i) => column("delta", i)),
    ),
    "",
  );
  return lines.join("\n");
}

function steadyRow(name: string, plain: number[], delta: number[]): string {
  const all = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
  const cells = plain.map((p, i) => `${n(p)} → ${n(delta[i] ?? 0)}`);
  return (
    `| ${name} | ${cells.join(" | ")} | ${n(all(plain))} → ${n(all(delta))} | ` +
    `${saved(all(plain), all(delta))} |`
  );
}
