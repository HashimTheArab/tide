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
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, onTestFinished, test, vi } from "vitest";

import { applyBsdiff } from "@tide-ota/protocol";

import type { AppId } from "../src/hermes-delta/apps.ts";
import type { EmulatorResults } from "../src/hermes-delta/emulator.ts";
import type { Results } from "../src/hermes-delta/measure.ts";
import { makeBsdiff } from "../../packages/cli/src/bsdiff.ts";
import { keepsPatch } from "../../packages/cli/src/publish-patch.ts";
import { APPS, CHANGES } from "../src/hermes-delta/apps.ts";
import {
  compile,
  hbcVersion,
  hermescIo,
  inspect,
  kotlinArgs,
  numstat,
  openTree,
  parseDump,
  retarget,
} from "../src/hermes-delta/build.ts";
import {
  PATHS,
  applyPatches,
  renderEmulator,
  writeEmulatorResults,
} from "../src/hermes-delta/emulator.ts";
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

const MAIN = fileURLToPath(new URL("../src/hermes-delta/main.ts", import.meta.url));
const PATCHES = fileURLToPath(new URL("../hermes-delta/patches/", import.meta.url));
const SHARED = fileURLToPath(new URL("../apps/shared/", import.meta.url));

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

  test("defaults to every app", () => {
    expect(parseOptions([])).toEqual({ emulator: false, apps: ["sdk-55", "sdk-58", "bluesky"] });
  });

  test("named apps keep table order; no option moves the cache the script deletes and rebuilds", () => {
    expect(parseOptions(["--app", "bluesky", "--app", "sdk-55"])).toEqual({
      emulator: false,
      apps: ["sdk-55", "bluesky"],
    });
    for (const args of [["--work", "w"], ["--out", "o"], ["positional"]]) {
      expect(() => parseOptions(args), args.join(" ")).toThrow(UsageError);
    }
  });
});

describe("pnpm hermes-delta --emulator options", () => {
  test("defaults to both conformance apps and takes an AVD", () => {
    expect(parseOptions(["--emulator"])).toEqual({
      emulator: true,
      apps: ["sdk-55", "sdk-58"],
      avd: undefined,
    });
    expect(parseOptions(["--emulator", "--app", "sdk-58", "--avd", "a"])).toEqual({
      emulator: true,
      apps: ["sdk-58"],
      avd: "a",
    });
  });

  test("refuses the large app, whose source reports nothing, and --avd without --emulator", async () => {
    const run = await bin(["--emulator", "--app", "bluesky"]);
    expect(run.code).toBe(2);
    expect(run.stderr).toBe(
      "hermes-delta: --app must be one of sdk-55, sdk-58 with --emulator; see pnpm hermes-delta --help\n",
    );
    expect(() => parseOptions(["--avd", "a"])).toThrow("--avd is for --emulator");
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
    // As the real hermesc does, the fake embeds the input name it was given.
    const app = fakeHermesc(`{ printf '%s\\n' "$in"; cat "$in"; } > "$out"`);
    const js = new TextEncoder().encode("var a = 1;\n");

    const built = [];
    for (const root of [scratch(), scratch()])
      built.push(await compile(fakeTree(app, root), expo, js, js));

    expect(built[1]).toEqual(built[0]);
    expect(new TextDecoder().decode(built[0]?.hbc)).toBe("index.js\nvar a = 1;\n");
    expect(built[0]?.args.filter((a) => isAbsolute(a.replace(/^-base-bytecode=/, "")))).toEqual([]);
  });

  test("concurrent compiles of two apps under one work dir each compile their own JS", async () => {
    // Each fake hermesc waits until both have started, so neither finishes before the other's compile set up.
    const barrier = scratch();
    const app = fakeHermesc(
      `: > "$BARRIER/$$"\nuntil [ "$(ls "$BARRIER" | wc -l)" -ge 2 ]; do :; done\ncat "$in" > "$out"`,
    );
    const root = scratch();
    const js = ["var a = 1;\n", "var b = 2;\n"].map((s) => new TextEncoder().encode(s));

    const built = await Promise.all(
      (["sdk-55", "bluesky"] as const).map((id, i) =>
        compile(fakeTree(app, root, id, { BARRIER: barrier }), expo, js[i] ?? new Uint8Array()),
      ),
    );

    expect(built.map((b) => new TextDecoder().decode(b.hbc))).toEqual([
      "var a = 1;\n",
      "var b = 2;\n",
    ]);
  });
});

/** Returns an app dir whose hermes-compiler hermesc runs `body` with `$in` and `$out` set from its arguments. */
function fakeHermesc(body: string): string {
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
${body}
`,
  );
  chmodSync(hermesc, 0o755);
  for (const name of ["react-native", "hermes-compiler"]) {
    mkdirSync(join(app, "node_modules", name), { recursive: true });
    writeFileSync(join(app, "node_modules", name, "package.json"), JSON.stringify({ name }));
  }
  writeFileSync(join(app, "package.json"), JSON.stringify({ name: "app" }));
  return app;
}

/** Returns `id`'s tree at `app` under the work dir `root`, its builds given `env`. */
function fakeTree(app: string, root: string, id: AppId = "sdk-55", env = {}) {
  mkdirSync(join(root, id), { recursive: true });
  return {
    pin: { ...APPS[id], env },
    dir: app,
    work: join(root, id),
    log: join(root, id, "log"),
    tmp: root,
  };
}

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

  test("refuses an app dir that links out of the cache and deletes nothing through it", async () => {
    const work = scratch();
    const outside = scratch();
    const precious = join(outside, "tmp", "precious");
    mkdirSync(dirname(precious));
    writeFileSync(precious, "keep");
    symlinkSync(outside, join(work, "sdk-55"));

    await expect(openTree("sdk-55", APPS["sdk-55"], work)).rejects.toThrow("not a directory");

    expect(readFileSync(precious, "utf8")).toBe("keep");
    expect(readdirSync(outside)).toEqual(["tmp"]);
  });

  test("builds the start commit under a git config that signs every commit and tag", async () => {
    const config = join(scratch(), "gitconfig");
    writeFileSync(
      config,
      "[commit]\n\tgpgsign = true\n[tag]\n\tgpgsign = true\n[gpg]\n\tprogram = false\n",
    );
    vi.stubEnv("GIT_CONFIG_GLOBAL", config);
    onTestFinished(() => {
      vi.unstubAllEnvs();
    });

    const tree = await openTree("sdk-55", APPS["sdk-55"], scratch());

    expect(execFileSync("git", ["-C", tree.dir, "tag"], { encoding: "utf8" })).toBe(
      "hermes-delta-start\n",
    );
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

  test("a target identical to an OTA base is reuse; one identical to the embedded base gets no patch", async () => {
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
    // The embedded launch asset is keyed bundle-<updateId>, not by hash, so the client downloads the full bundle.
    expect(measured["delta-embedded"].from.embedded).toEqual({ noPatch: true });
  });
});

/** One app's results: one-line and feature are `change`; the dependency bump's plain bundle is the OTA base. */
function sample(bumpFromEmbedded: number | "full" = 200): Results {
  const sized = { bytes: 1000, sha256: "00", gzip9: 400 };
  const from = (p: number | "reused" | "full", gzip9: number) =>
    p === "reused"
      ? ({ reused: true } as const)
      : p === "full"
        ? ({ noPatch: true } as const)
        : { bytes: p, keep: keepsPatch(p, gzip9) };
  const target = (
    ota: number | "reused",
    embedded: number | "full",
    older: number,
    gzip9 = 400,
  ) => ({
    ...sized,
    gzip9,
    from: {
      ota: from(ota, gzip9),
      embedded: from(embedded, gzip9),
      "older-ota": from(older, gzip9),
    },
  });
  const change = (
    plainOta: number | "reused",
    deltaOta: number,
    deltaEmbedded: number | "full" = 200,
  ) => ({
    patch: "x.patch",
    files: 1,
    added: 1,
    removed: 1,
    targets: {
      plain: target(plainOta, 300, 150),
      "delta-ota": target(deltaOta, 320, 140),
      "delta-embedded": target(120, deltaEmbedded, 160),
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
        "dependency-bump": change("reused", 20, bumpFromEmbedded),
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

test("renderTable shows a target equal to the embedded base as a full download of its gzip-9 size", () => {
  const lines = renderTable(sample("full")).split("\n");
  expect(lines).toContain(
    "| dependency-bump (+1 −1) | embedded | 300 → full | -33.3% | reused → 120 | 150 → 160 | 400 / 400 | no reused yes / full yes yes |",
  );
  expect(lines).toContain(
    "| all changes | embedded | 900 → 800 | 11.1% | 200 → 360 | 450 → 480 | | |",
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

describe("bytecode inspection", () => {
  const header = (version: number) => {
    const bytes = new Uint8Array(16);
    const view = new DataView(bytes.buffer);
    view.setBigUint64(0, 0x1f1903c103bc1fc6n, true);
    view.setUint32(8, version, true);
    return bytes;
  };

  test("hbcVersion reads the version after the HBC magic and refuses any other file", () => {
    expect(hbcVersion(header(99))).toBe(99);
    expect(() => hbcVersion(new TextEncoder().encode("var a = 1;\n"))).toThrow(
      "not a Hermes bytecode file",
    );
    expect(() => hbcVersion(header(99).slice(0, 8))).toThrow("not a Hermes bytecode file");
  });

  test("parseDump reads hermesc's header and refuses a dump without one", () => {
    const dump = [
      "Bytecode File Information:",
      "  Bytecode version number: 99",
      "  Source hash: 6c8184fc",
      "  Function count: 61189",
      "  String count: 156152",
      "  String Kind Entry count: 7",
    ];
    expect(parseDump(dump)).toEqual({
      bytecodeVersion: 99,
      sourceHash: "6c8184fc",
      functions: 61189,
      strings: 156152,
    });
    expect(() => parseDump(dump.slice(0, 4))).toThrow("the bytecode dump has no String count");
  });

  test("inspect loads the file alone: hermesc sees no other file, and only the header is read", async () => {
    // The fake reports the files beside its input as the source hash, and a later count the header must not take.
    const app = fakeHermesc(
      `printf 'Bytecode File Information:\\n  Bytecode version number: 99\\n  Source hash: %s\\n' "$(ls)"
printf '  Function count: 2\\n  String count: 3\\nGlobal String Table:\\n  Function count: 7\\n'`,
    );

    expect(await inspect(fakeTree(app, scratch()), header(99))).toEqual({
      bytecodeVersion: 99,
      sourceHash: "index.hbc",
      functions: 2,
      strings: 3,
    });
  });

  test("inspect throws when hermesc cannot load the file", async () => {
    const app = fakeHermesc(`echo "bad bytecode" >&2; exit 1`);
    await expect(inspect(fakeTree(app, scratch()), header(99))).rejects.toThrow(
      "hermesc could not load the bytecode alone: bad bytecode",
    );
  });
});

describe("the emulator check", () => {
  test("applyPatches applies and reverses the conformance patches in an app dir inside another repository", () => {
    // Git run inside a repository would skip every path outside the app dir and still exit 0.
    const repo = scratch();
    execFileSync("git", ["init", "-q"], { cwd: repo });
    const app = join(repo, "app");
    mkdirSync(app);
    const original = readFileSync(join(SHARED, "App.js"));
    writeFileSync(join(app, "App.js"), original);
    const patches = ["conformance/previous.patch", "conformance/feature.patch"];

    applyPatches(app, patches);
    expect(readFileSync(join(app, "App.js"), "utf8")).toContain("<UpdateDetails />");
    expect(existsSync(join(app, "UpdateDetails.js"))).toBe(true);

    applyPatches(app, patches.toReversed(), true);
    expect(readFileSync(join(app, "App.js"))).toEqual(original);
    expect(readdirSync(app)).toEqual(["App.js"]);
  });

  const inspection = { bytecodeVersion: 99, sourceHash: "ab", functions: 10, strings: 20 };
  const sample: EmulatorResults = {
    schema: 1,
    about: "About.",
    app: { id: "sdk-58", title: "App", platform: "android" },
    device: { abi: "arm64-v8a" },
    tools: {},
    deltaArgs: ["-emit-binary", "-out", "index.hbc", "index.js", "-O", "-base-bytecode=base.hbc"],
    bytecodeVersions: { embedded: 99, base: 99 },
    deltas: [
      {
        marker: "delta-58-1",
        delta: { bytes: 1500, sha256: "11", alone: { ...inspection, strings: 21 } },
        plain: { bytes: 1400, sha256: "22", alone: inspection },
        patchFromBase: { plain: 900, delta: 90 },
      },
    ],
    baseRequested: false,
    paths: {
      "other-ota-patch": { pass: true, saw: "delta-58-1 ran on a device on older-58" },
      "other-ota-full": { pass: false, why: "the app reported nothing\n  got []" },
      "embedded-patch": { pass: true, saw: "delta-58-2 ran on a device on embedded-58" },
      "embedded-full": { pass: false, why: "not run: build failed" },
    },
  };

  test("renderEmulator prints one row per path, failures by their first line, then each bundle loaded alone", () => {
    const lines = renderEmulator(sample).split("\n");
    expect(lines[0]).toBe("# Hermes delta compiles on an emulator: App");
    expect(lines).toContain(
      `| ${PATHS["other-ota-patch"]} | pass: delta-58-1 ran on a device on older-58 |`,
    );
    expect(lines).toContain(`| ${PATHS["other-ota-full"]} | fail: the app reported nothing |`);
    expect(lines).toContain(`| ${PATHS["embedded-full"]} | fail: not run: build failed |`);
    expect(lines).toContain("| delta-58-1 | plain | 1,400 | 99 | 10 | 20 | 900 |");
    expect(lines).toContain("| delta-58-1 | delta | 1,500 | 99 | 10 | 21 | 90 |");
  });

  test("writeEmulatorResults writes only its own app's files beside the measurements", () => {
    const out = scratch();
    writeFileSync(join(out, "sdk-58.json"), "the measurements\n");

    expect(writeEmulatorResults(out, sample)).toBe(join(out, "emulator-sdk-58.json"));

    expect(readdirSync(out).toSorted()).toEqual([
      "emulator-sdk-58.json",
      "emulator-sdk-58.md",
      "sdk-58.json",
    ]);
    expect(readFileSync(join(out, "emulator-sdk-58.json"), "utf8")).toBe(
      `${JSON.stringify(sample, null, 2)}\n`,
    );
    expect(readFileSync(join(out, "emulator-sdk-58.md"), "utf8")).toBe(renderEmulator(sample));
  });
});
