import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

import { applyBsdiff } from "@tide-ota/protocol";

import type { Results } from "../src/hermes-delta/measure.ts";
import { makeBsdiff } from "../../packages/cli/src/bsdiff.ts";
import { keepsPatch } from "../../packages/cli/src/publish-patch.ts";
import { APPS, CHANGES } from "../src/hermes-delta/apps.ts";
import { hermescIo, kotlinArgs, numstat, retarget } from "../src/hermes-delta/build.ts";
import {
  BASES,
  KEEP_RULE,
  TARGETS,
  describe as describeBundle,
  measureTargets,
  renderTable,
} from "../src/hermes-delta/measure.ts";
import { USAGE, UsageError, parseOptions } from "../src/hermes-delta/options.ts";

const REPO = fileURLToPath(new URL("../../", import.meta.url));
const MAIN = fileURLToPath(new URL("../src/hermes-delta/main.ts", import.meta.url));
const PATCHES = fileURLToPath(new URL("../hermes-delta/patches/", import.meta.url));

/** Returns `n` bytes from a fixed linear congruential sequence, so the inputs are the same every run. */
function noise(n: number, seed: number): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(n);
  let x = seed;
  for (let i = 0; i < n; i++) {
    x = (Math.imul(x, 1103515245) + 12345) >>> 0;
    out[i] = x >>> 24;
  }
  return out;
}

async function bin(args: string[]) {
  const proc = spawn(process.execPath, [MAIN, ...args], { stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  proc.stdout.setEncoding("utf8").on("data", (s: string) => (stdout += s));
  proc.stderr.setEncoding("utf8").on("data", (s: string) => (stderr += s));
  const [code] = (await once(proc, "close")) as [number | null];
  return { code, stdout, stderr };
}

describe("pnpm hermes-delta options", () => {
  test("--help prints the usage and builds nothing", async () => {
    expect(await bin(["--help"])).toEqual({ code: 0, stdout: `${USAGE}\n`, stderr: "" });
  });

  test("an unknown app is a usage error before anything starts", async () => {
    const run = await bin(["--app", "nope"]);
    expect(run.code).toBe(2);
    expect(run.stderr).toBe(
      "hermes-delta: --app must be one of sdk-55, sdk-58, bluesky; see pnpm hermes-delta --help\n",
    );
  });

  test("defaults to every app and the gitignored cache", () => {
    expect(parseOptions([], "/elsewhere")).toEqual({
      apps: ["sdk-55", "sdk-58", "bluesky"],
      work: join(REPO, ".cache", "hermes-delta"),
    });
  });

  test("named apps keep table order, and --work resolves against the caller's directory", () => {
    expect(parseOptions(["--app", "bluesky", "--app", "sdk-55", "--work", "w"], "/x")).toEqual({
      apps: ["sdk-55", "bluesky"],
      work: "/x/w",
    });
    expect(() => parseOptions(["--out", "o"], "/x")).toThrow(UsageError);
    expect(() => parseOptions(["positional"], "/x")).toThrow(UsageError);
  });
});

describe("the pinned changes", () => {
  test.each(Object.keys(APPS) as (keyof typeof APPS)[])(
    "%s has a committed, well-formed patch for the previous update and every change",
    (app) => {
      const patches = APPS[app].patches;
      expect(Object.keys(patches).toSorted()).toEqual(
        [...Object.keys(CHANGES), "previous"].toSorted(),
      );
      for (const patch of Object.values(patches)) {
        const path = join(PATCHES, patch);
        expect(existsSync(path), path).toBe(true);
        // Outside any repository: inside one, git apply ignores paths outside the current directory.
        const stat = numstat(
          execFileSync("git", ["apply", "--numstat", path], { cwd: tmpdir(), encoding: "utf8" }),
        );
        expect(stat.files, path).toBeGreaterThan(0);
      }
    },
  );

  test("numstat sums added and removed lines and counts binary files as zero lines", () => {
    expect(numstat("1\t1\tApp.js\n97\t0\tUpdateDetails.js\n-\t-\timage.png\n")).toEqual({
      files: 3,
      added: 98,
      removed: 1,
    });
  });
});

describe("hermesc command lines", () => {
  const expo = {
    args: [
      "-emit-binary",
      "-out",
      "/t/expo-bundler-1/index.hbc",
      "/t/expo-bundler-1/index.js",
      "-O",
    ],
    input: "/t/expo-bundler-1/index.js",
    out: "/t/expo-bundler-1/index.hbc",
  };

  test("hermescIo finds Expo's input and -out files", () => {
    expect(hermescIo(expo.args)).toEqual({ input: expo.input, out: expo.out });
    expect(() => hermescIo(["-emit-binary", "-out", "a.hbc", "a.js", "b.js"])).toThrow(
      "no single input",
    );
  });

  test("retarget keeps Expo's flags, moves the paths and appends -base-bytecode last", () => {
    expect(retarget(expo, "/w/index.js", "/w/index.hbc")).toEqual([
      "-emit-binary",
      "-out",
      "/w/index.hbc",
      "/w/index.js",
      "-O",
    ]);
    expect(retarget(expo, "/w/index.js", "/w/index.hbc", "/w/base.hbc")).toEqual([
      "-emit-binary",
      "-out",
      "/w/index.hbc",
      "/w/index.js",
      "-O",
      "-base-bytecode=/w/base.hbc",
    ]);
  });

  test("kotlinArgs reads the Gradle plugin's hermesc arguments and refuses one it does not know", () => {
    const task = `
        "-w",
        "-emit-binary",
        "-max-diagnostic-width=80",
        "-out",
        bytecodeFile.cliPath(rootFile),
        bundleFile.cliPath(rootFile),
        `;
    expect(kotlinArgs(task)).toEqual([
      "-w",
      "-emit-binary",
      "-max-diagnostic-width=80",
      "-out",
      "<bytecode>",
      "<bundle>",
    ]);
    expect(kotlinArgs(`"-O", "-output-source-map"`)).toEqual(["-O", "-output-source-map"]);
    expect(() => kotlinArgs(`"-O", extraFlag`)).toThrow("unexpected hermesc argument");
  });
});

describe("measureTargets", () => {
  test("every size is makeBsdiff's patch, which protocol applyBsdiff turns back into the target", async () => {
    const ota = noise(64 * 1024, 1);
    const embedded = noise(64 * 1024, 2);
    const olderOta = ota.slice();
    olderOta.set(noise(4096, 3), 1000);
    const plain = ota.slice();
    plain[500] = (plain[500] ?? 0) ^ 0xff;
    const deltaOta = plain.slice();
    const deltaEmbedded = embedded.slice();
    deltaEmbedded.set(noise(256, 4), 9000);
    const bases = { ota, embedded, "older-ota": olderOta };
    const targets = { plain, "delta-ota": deltaOta, "delta-embedded": deltaEmbedded };

    const measured = await measureTargets(bases, targets);

    for (const kind of Object.keys(TARGETS) as (keyof typeof TARGETS)[]) {
      const target = targets[kind];
      expect(measured[kind]).toMatchObject(describeBundle(target));
      for (const base of Object.keys(BASES) as (keyof typeof BASES)[]) {
        const patch = makeBsdiff(bases[base], target);
        expect(applyBsdiff(bases[base], patch, target.length)).toEqual(target);
        expect(measured[kind].from[base]).toEqual({
          bytes: patch.length,
          keep: keepsPatch(patch.length, measured[kind].gzip9),
        });
      }
    }
    // Noise does not compress, so a patch between unrelated bundles is about as big as the bundle: not kept.
    expect(measured.plain.from.ota.keep).toBe(true);
    expect(measured.plain.from.embedded.keep).toBe(false);
  });
});

test("renderTable prints one row per change and compile base, then totals from the raw numbers", () => {
  const sized = { bytes: 1000, sha256: "00", gzip9: 400 };
  const target = (ota: number, embedded: number, older: number, gzip9 = 400) => ({
    ...sized,
    gzip9,
    from: {
      ota: { bytes: ota, keep: keepsPatch(ota, gzip9) },
      embedded: { bytes: embedded, keep: keepsPatch(embedded, gzip9) },
      "older-ota": { bytes: older, keep: keepsPatch(older, gzip9) },
    },
  });
  const change = {
    patch: "x.patch",
    files: 1,
    added: 1,
    removed: 1,
    targets: {
      plain: target(100, 300, 150),
      "delta-ota": target(50, 320, 140),
      "delta-embedded": target(120, 200, 160),
    },
  };
  const results: Results = {
    schema: 1,
    about: "About.",
    keepRule: KEEP_RULE,
    bases: BASES,
    targets: TARGETS,
    apps: [
      {
        id: "sdk-55",
        title: "App",
        source: { commit: "abc" },
        platform: "android",
        machine: {},
        tools: {},
        export: {},
        embedded: {},
        delta: { hermescArgs: [] },
        bases: { ota: sized, embedded: sized, "older-ota": sized },
        changes: { "one-line": change, "dependency-bump": change, feature: change },
      },
    ],
  };
  const lines = renderTable(results).split("\n");
  expect(lines).toContain(
    "| one-line (+1 −1) | ota | 100 → 50 | 50.0% | 300 → 320 | 150 → 140 | 400 / 400 | yes no yes / yes no yes |",
  );
  expect(lines).toContain(
    "| one-line (+1 −1) | embedded | 300 → 200 | 33.3% | 100 → 120 | 150 → 160 | 400 / 400 | no yes yes / yes yes yes |",
  );
  expect(lines).toContain("| all changes | ota | 300 → 150 | 50.0% | 900 → 960 | 450 → 420 | | |");
  expect(lines).toContain(
    "| all changes | embedded | 900 → 600 | 33.3% | 300 → 360 | 450 → 480 | | |",
  );
});
