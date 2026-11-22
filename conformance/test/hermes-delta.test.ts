import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, onTestFinished, test } from "vitest";

import { applyBsdiff } from "@tide-ota/protocol";

import type { Results } from "../src/hermes-delta/measure.ts";
import { makeBsdiff } from "../../packages/cli/src/bsdiff.ts";
import { keepsPatch } from "../../packages/cli/src/publish-patch.ts";
import { APPS, CHANGES } from "../src/hermes-delta/apps.ts";
import {
  claimWork,
  compile,
  hermescIo,
  kotlinArgs,
  numstat,
  openTree,
  retarget,
} from "../src/hermes-delta/build.ts";
import {
  BASES,
  KEEP_RULE,
  TARGETS,
  describe as describeBundle,
  measureTargets,
  renderTable,
  writeResults,
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

/** Returns a new directory removed when the test finishes. */
function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "tide-hermes-delta-"));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
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

  test("a --work holding files the study did not make is refused before anything is deleted", async () => {
    const work = scratch();
    const keep = join(work, "sdk-55", "tree", "keep.txt");
    mkdirSync(dirname(keep), { recursive: true });
    writeFileSync(keep, "mine");
    const run = await bin(["--app", "sdk-55", "--work", work]);
    expect(run).toEqual({
      code: 2,
      stdout: "",
      stderr:
        `hermes-delta: ${work} holds files hermes-delta did not create; pass a new or empty --work; ` +
        "see pnpm hermes-delta --help\n",
    });
    expect(readFileSync(keep, "utf8")).toBe("mine");
    expect(readdirSync(work)).toEqual(["sdk-55"]);
  });

  test("claimWork takes a new or empty directory and one it marked before", () => {
    const root = scratch();
    claimWork(join(root, "new"));
    mkdirSync(join(root, "empty"));
    claimWork(join(root, "empty"));
    for (const dir of ["new", "empty"]) {
      writeFileSync(join(root, dir, "built.txt"), "");
      claimWork(join(root, dir));
    }
    expect(() => claimWork(root)).toThrow(UsageError);
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

  test("compile gives the same bytes under any work dir: hermesc sees only fixed relative names", async () => {
    // A hermes-compiler whose hermesc writes the input name it was given, then the JS, as the real one embeds it.
    const app = scratch();
    const hermesc = join(
      app,
      "node_modules",
      "hermes-compiler",
      "hermesc",
      process.platform === "darwin" ? "osx-bin" : "linux64-bin",
      "hermesc",
    );
    mkdirSync(dirname(hermesc), { recursive: true });
    writeFileSync(
      hermesc,
      `#!/bin/sh
while [ $# -gt 0 ]; do case "$1" in -out) out=$2; shift 2 ;; -*) shift ;; *) in=$1; shift ;; esac; done
{ printf '%s\\n' "$in"; cat "$in"; } > "$out"
`,
    );
    chmodSync(hermesc, 0o755);
    for (const name of ["react-native", "hermes-compiler"]) {
      mkdirSync(join(app, "node_modules", name), { recursive: true });
      writeFileSync(join(app, "node_modules", name, "package.json"), JSON.stringify({ name }));
    }
    writeFileSync(join(app, "package.json"), JSON.stringify({ name: "app" }));
    const js = new TextEncoder().encode("var a = 1;\n");

    const built = [];
    for (const root of [scratch(), scratch()]) {
      const tree = {
        pin: APPS["sdk-55"],
        dir: app,
        work: join(root, "sdk-55"),
        log: join(root, "log"),
        tmp: root,
      };
      built.push(await compile(tree, expo, js, js));
    }

    expect(built[1]).toEqual(built[0]);
    expect(new TextDecoder().decode(built[0]?.hbc)).toBe("index.js\nvar a = 1;\n");
    expect(built[0]?.args.filter((a) => isAbsolute(a.replace(/^-base-bytecode=/, "")))).toEqual([]);
  });
});

describe("openTree", () => {
  test("reuses a cached tree and its build temp dir, and rebuilds both when a pinned input changes", async () => {
    const work = scratch();
    const pin = APPS["sdk-55"];
    if (pin.source.kind !== "tide") throw new Error("sdk-55 is pinned to this repository");
    const first = await openTree("sdk-55", pin, work);
    const built = [join(first.dir, "built.txt"), join(first.tmp, "metro-cache")];
    for (const path of built) writeFileSync(path, "");
    await openTree("sdk-55", pin, work);
    for (const path of built) expect(existsSync(path), path).toBe(true);

    const marker = 'export const MARKER = "moved";\n';
    const moved = {
      ...pin,
      source: { ...pin.source, extra: { ...pin.source.extra, "marker.js": marker } },
    };
    const tree = await openTree("sdk-55", moved, work);

    for (const path of built) expect(existsSync(path), path).toBe(false);
    expect(readFileSync(join(tree.dir, "marker.js"), "utf8")).toBe(marker);
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
    expect(measured.plain.from.ota).toMatchObject({ keep: true });
    expect(measured.plain.from.embedded).toMatchObject({ keep: false });
  });

  test("a target identical to a base is reuse, as Tide skips a base sharing its launch hash", async () => {
    const ota = noise(4096, 5);
    const embedded = noise(4096, 6);
    const changed = ota.slice();
    changed[100] = (changed[100] ?? 0) ^ 0xff;
    const bases = { ota, embedded, "older-ota": changed };

    const measured = await measureTargets(bases, {
      plain: ota.slice(),
      "delta-ota": changed.slice(),
      "delta-embedded": embedded.slice(),
    });

    expect(measured.plain.from).toEqual({
      ota: { reused: true },
      embedded: { bytes: makeBsdiff(embedded, ota).length, keep: false },
      "older-ota": { bytes: makeBsdiff(changed, ota).length, keep: true },
    });
    expect(measured["delta-ota"].from["older-ota"]).toEqual({ reused: true });
    expect(measured["delta-embedded"].from.embedded).toEqual({ reused: true });
  });
});

/** One app's results: one-line and feature are `change`; the dependency bump's plain bundle is the OTA base. */
function sample(): Results {
  const sized = { bytes: 1000, sha256: "00", gzip9: 400 };
  const patch = (bytes: number, gzip9: number) => ({ bytes, keep: keepsPatch(bytes, gzip9) });
  const target = (ota: number | "reused", embedded: number, older: number, gzip9 = 400) => ({
    ...sized,
    gzip9,
    from: {
      ota: ota === "reused" ? ({ reused: true } as const) : patch(ota, gzip9),
      embedded: patch(embedded, gzip9),
      "older-ota": patch(older, gzip9),
    },
  });
  const change = (plainOta: number | "reused", deltaOta: number) => ({
    patch: "x.patch",
    files: 1,
    added: 1,
    removed: 1,
    targets: {
      plain: target(plainOta, 300, 150),
      "delta-ota": target(deltaOta, 320, 140),
      "delta-embedded": target(120, 200, 160),
    },
  });
  return {
    schema: 2,
    about: "About.",
    keepRule: KEEP_RULE,
    bases: BASES,
    targets: TARGETS,
    app: {
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
      changes: {
        "one-line": change(100, 50),
        "dependency-bump": change("reused", 20),
        feature: change(100, 50),
      },
    },
  };
}

test("renderTable prints one row per change and compile base, then totals counting reuse as no download", () => {
  const lines = renderTable(sample()).split("\n");
  expect(lines[0]).toBe("# Hermes delta compiles: App");
  expect(lines).toContain(
    "| one-line (+1 −1) | ota | 100 → 50 | 50.0% | 300 → 320 | 150 → 140 | 400 / 400 | yes no yes / yes no yes |",
  );
  expect(lines).toContain(
    "| one-line (+1 −1) | embedded | 300 → 200 | 33.3% | 100 → 120 | 150 → 160 | 400 / 400 | no yes yes / yes yes yes |",
  );
  expect(lines).toContain(
    "| dependency-bump (+1 −1) | ota | reused → 20 | n/a | 300 → 320 | 150 → 140 | 400 / 400 | reused no yes / yes no yes |",
  );
  expect(lines).toContain(
    "| dependency-bump (+1 −1) | embedded | 300 → 200 | 33.3% | reused → 120 | 150 → 160 | 400 / 400 | no reused yes / yes yes yes |",
  );
  expect(lines).toContain("| all changes | ota | 200 → 120 | 40.0% | 900 → 960 | 450 → 420 | | |");
  expect(lines).toContain(
    "| all changes | embedded | 900 → 600 | 33.3% | 200 → 360 | 450 → 480 | | |",
  );
});

test("writeResults writes only its own app's files, so runs of other apps never overwrite them", () => {
  const out = scratch();
  writeFileSync(join(out, "bluesky.json"), "another run's results\n");
  const results = sample();

  expect(writeResults(out, results)).toBe(join(out, "sdk-55.json"));

  expect(readdirSync(out).toSorted()).toEqual(["bluesky.json", "sdk-55.json", "sdk-55.md"]);
  expect(readFileSync(join(out, "bluesky.json"), "utf8")).toBe("another run's results\n");
  expect(readFileSync(join(out, "sdk-55.json"), "utf8")).toBe(
    `${JSON.stringify(results, null, 2)}\n`,
  );
  expect(readFileSync(join(out, "sdk-55.md"), "utf8")).toBe(renderTable(results));
});
