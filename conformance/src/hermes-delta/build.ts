// Builds an app's Hermes bundles the way `expo export` and the Android release build do, from a pinned tree.
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import {
  chmodSync,
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { devNull, tmpdir } from "node:os";
import { delimiter, dirname, join, relative } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

import type { AppId, AppPin } from "./apps.ts";
import { tail } from "../stack.ts";

const REPO = fileURLToPath(new URL("../../../", import.meta.url));
const PATCHES = fileURLToPath(new URL("../../hermes-delta/patches/", import.meta.url));
const START = "hermes-delta-start";
// What builds see of the caller: locale, paths and proxies; no credential and no EXPO_PUBLIC_ value of the shell.
const INHERITED = /^(?:PATH|HOME|TMPDIR|LANG|LANGUAGE|TZ|LC_[A-Z]+|(?:HTTPS?|NO|ALL)_PROXY)$/i;
const GIT_USER = ["-c", "user.name=hermes-delta", "-c", "user.email=hermes-delta@localhost"];
// Gradle's paths for the release variant, relative to the project root as the RN Gradle plugin passes them.
const GRADLE = {
  bundle: "android/app/build/generated/assets/react/release/index.android.bundle",
  res: "android/app/build/generated/res/react/release",
  packagerMap:
    "android/app/build/intermediates/sourcemaps/react/release/index.android.bundle.packager.map",
};

/** One app's working tree under the study's work dir, with the log its commands append to. */
export interface Tree {
  readonly pin: AppPin;
  readonly dir: string;
  readonly work: string; // The app's own cache directory.
  readonly log: string;
  readonly tmp: string; // Builds' TMPDIR, so Metro's caches live and die with the tree.
}

/** A hermesc command line as Expo or Gradle ran it, with the input and output it names. */
export interface Hermesc {
  readonly args: readonly string[];
  readonly input: string;
  readonly out: string;
}

/** Applies (or reverses) patch files in the tree, in order. */
export function applyPatches(tree: Pick<Tree, "dir">, patches: readonly string[], reverse = false) {
  for (const patch of patches) git(tree, ["apply", ...(reverse ? ["-R"] : []), patchPath(patch)]);
}

/** Returns the hash of everything the start commit is made from, so a changed pin rebuilds a cached tree. */
function startKey(pin: AppPin): string {
  return createHash("sha256")
    .update(JSON.stringify(pin.source))
    .update(readFileSync(patchPath(pin.patches["dependency-bump"])))
    .digest("hex");
}

/** Returns the app's tree at the start commit, rebuilding it when missing or made from other pinned inputs. */
export async function openTree(app: AppId, pin: AppPin, work: string): Promise<Tree> {
  const appWork = join(work, app);
  const tree = {
    pin,
    dir: join(appWork, "tree"),
    work: appWork,
    log: join(appWork, "log.txt"),
    tmp: join(appWork, "tmp"),
  };
  // A link would make the deletes below reach a directory this cache does not own.
  const stat = lstatSync(appWork, { throwIfNoEntry: false });
  if (stat !== undefined && !stat.isDirectory()) {
    throw new Error(`${appWork} is not a directory; not deleting through it`);
  }
  const key = startKey(pin);
  const keyFile = join(tree.dir, ".git", "hermes-delta-start");
  mkdirSync(tree.tmp, { recursive: true });
  if (existsSync(keyFile) && readFileSync(keyFile, "utf8") === key) return tree;
  // Metro's caches would otherwise name generated files the deleted tree held.
  for (const dir of [tree.dir, tree.tmp]) {
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir);
  }
  const { source } = pin;
  if (source.kind === "tide") {
    for (const [from, to] of Object.entries(source.files)) {
      write(
        join(tree.dir, to),
        execFileSync("git", ["-C", REPO, "show", `${source.commit}:${from}`]),
      );
    }
    for (const [to, text] of Object.entries(source.extra)) write(join(tree.dir, to), text);
    git(tree, ["init", "-q"]);
    git(tree, ["add", "-A"]);
    git(tree, [...GIT_USER, "commit", "-qm", `conformance app at ${source.commit}`]);
  } else {
    git(tree, ["init", "-q"]);
    await run(tree, "git", ["fetch", "-q", "--depth", "1", source.url, source.commit]);
    git(tree, ["checkout", "-q", "FETCH_HEAD"]);
  }
  // Dependencies and build output survive the resets between states.
  writeFileSync(join(tree.dir, ".git", "info", "exclude"), "node_modules/\n.expo/\n");
  git(tree, ["apply", "-R", patchPath(pin.patches["dependency-bump"])]);
  git(tree, [...GIT_USER, "commit", "-qam", "start: the pin with dependency-bump.patch reversed"]);
  git(tree, ["tag", START]);
  writeFileSync(keyFile, key);
  return tree;
}

/** Resets the tree to the start commit and applies `patches` in order; returns the last one's line counts. */
export function checkout(tree: Tree, patches: readonly string[]) {
  git(tree, ["reset", "-q", "--hard", START]);
  git(tree, ["clean", "-fdq"]);
  let stat = { files: 0, added: 0, removed: 0 };
  for (const patch of patches) {
    git(tree, ["apply", patchPath(patch)]);
    stat = numstat(git(tree, ["apply", "--numstat", patchPath(patch)]));
  }
  return stat;
}

/** Returns `git apply --numstat` output's file count and added and removed lines. */
export function numstat(output: string) {
  const rows = output
    .trim()
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => line.split("\t"));
  const sum = (i: number) => rows.reduce((n, row) => n + (Number(row[i]) || 0), 0);
  return { files: rows.length, added: sum(0), removed: sum(1) };
}

/** Installs the tree's locked dependencies and runs the app's generators, unless the lockfile is already installed. */
export async function install(tree: Tree): Promise<void> {
  const stamp = join(tree.dir, "node_modules", ".hermes-delta-installed");
  const hash = createHash("sha256");
  for (const file of ["package.json", "package-lock.json", "pnpm-lock.yaml"]) {
    const path = join(tree.dir, file);
    if (existsSync(path)) hash.update(file).update(readFileSync(path));
  }
  hash.update(JSON.stringify([tree.pin.install, tree.pin.prepare]));
  const want = hash.digest("hex");
  if (existsSync(stamp) && readFileSync(stamp, "utf8") === want) return;
  for (const [command = "", ...args] of [tree.pin.install, ...tree.pin.prepare]) {
    const at = args.map((a) => (a === "<tree>" ? tree.dir : a));
    await run(tree, command, at, {}, tree.work);
  }
  writeFileSync(stamp, want);
}

/** Returns the environment every build gets: the inherited allowlist, the script's own Node first, and `extra`. */
function buildEnv(tree: Tree, extra: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined && INHERITED.test(name)) env[name] = value;
  }
  env.PATH = [dirname(process.execPath), env.PATH].filter(Boolean).join(delimiter);
  return { ...env, TMPDIR: tree.tmp, CI: "1", ...tree.pin.env, ...extra };
}

/** The variables `tide export` sets for `expo export`. */
export const EXPORT_ENV = { EXPO_NO_DOTENV: "1", NODE_ENV: "production", BABEL_ENV: "production" };

/** Returns the `expo export` arguments for an Android export into `out`. */
export const exportArgs = (out: string) => ["export", "--output-dir", out, "--platform", "android"];

/**
 * Runs `expo export --platform android` as `tide export` does and returns the exported bundle with the one hermesc
 * command Expo ran and a copy of the JS it compiled, captured through Expo's REACT_NATIVE_OVERRIDE_HERMES_DIR lookup.
 */
export async function exportBundle(tree: Tree) {
  const out = mkdtempSync(join(tmpdir(), "hermes-delta-export-"));
  const capture = mkdtempSync(join(tmpdir(), "hermes-delta-capture-"));
  try {
    const hermesc = hermescPath(tree);
    const override = captureOverride(tree.work);
    await run(tree, expoBin(tree), exportArgs(out), {
      ...EXPORT_ENV,
      REACT_NATIVE_OVERRIDE_HERMES_DIR: override,
      HERMES_DELTA_CAPTURE: capture,
      HERMES_DELTA_HERMESC: hermesc,
    });
    const runs = readdirSync(capture);
    if (runs.length !== 1)
      throw new Error(`expo export ran hermesc ${runs.length} times, not once`);
    const args = readFileSync(join(capture, "0", "args"), "utf8")
      .split("\n")
      .slice(0, -1);
    return {
      hbc: bytes(join(out, exportedBundle(out))),
      js: bytes(join(capture, "0", "input.js")),
      hermesc: { args, ...hermescIo(args) },
    };
  } finally {
    for (const dir of [out, capture]) rmSync(dir, { recursive: true, force: true });
  }
}

/** Returns the JS bundle `expo export --no-bytecode` writes, with `tide export`'s variables. */
export async function exportJs(tree: Tree): Promise<Uint8Array<ArrayBuffer>> {
  const out = mkdtempSync(join(tmpdir(), "hermes-delta-export-"));
  try {
    await run(tree, expoBin(tree), [...exportArgs(out), "--no-bytecode"], EXPORT_ENV);
    return bytes(join(out, exportedBundle(out)));
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}

/** Returns metadata.json's Android bundle path. */
export function exportedBundle(out: string): string {
  const metadata = JSON.parse(readFileSync(join(out, "metadata.json"), "utf8")) as {
    fileMetadata: { android: { bundle: string } };
  };
  return metadata.fileMetadata.android.bundle;
}

/**
 * Writes the hermesc stand-in Expo finds under REACT_NATIVE_OVERRIDE_HERMES_DIR and returns that directory: it saves
 * its arguments and the JS it is given under HERMES_DELTA_CAPTURE, then runs HERMES_DELTA_HERMESC unchanged.
 */
function captureOverride(work: string): string {
  const dir = join(work, "hermesc-override");
  const bin = join(dir, "build", "bin", "hermesc");
  write(
    bin,
    `#!/bin/sh
set -e
n=$(ls "$HERMES_DELTA_CAPTURE" | wc -l | tr -d ' ')
mkdir "$HERMES_DELTA_CAPTURE/$n"
: > "$HERMES_DELTA_CAPTURE/$n/args"
for a in "$@"; do
  printf '%s\\n' "$a" >> "$HERMES_DELTA_CAPTURE/$n/args"
  case "$a" in -*) ;; *.js) cp "$a" "$HERMES_DELTA_CAPTURE/$n/input.js" ;; esac
done
exec "$HERMES_DELTA_HERMESC" "$@"
`,
  );
  chmodSync(bin, 0o755);
  return dir;
}

/** Returns the input file and `-out` file a hermesc command line names. */
export function hermescIo(args: readonly string[]): { input: string; out: string } {
  const at = args.indexOf("-out");
  const out = args[at + 1];
  const inputs = args.filter((a, i) => !a.startsWith("-") && i !== at + 1);
  if (at === -1 || out === undefined || inputs.length !== 1 || inputs[0] === undefined) {
    throw new Error(`hermesc ran with no single input and -out: ${args.join(" ")}`);
  }
  return { input: inputs[0], out };
}

/** Returns `command` compiling `input` to `out` instead, with `-base-bytecode=<base>` appended when given. */
export function retarget(command: Hermesc, input: string, out: string, base?: string): string[] {
  const args = command.args.map((a) => (a === command.input ? input : a === command.out ? out : a));
  return base === undefined ? args : [...args, `-base-bytecode=${base}`];
}

/**
 * Runs `command` again on `js` at the paths it names and returns whether the output equals `expected`: the check
 * that the study compiles exactly as Expo does. Refuses to touch an input directory that already exists.
 */
export async function reproduces(
  tree: Tree,
  command: Hermesc,
  js: Uint8Array,
  expected: Uint8Array,
): Promise<boolean> {
  const dir = dirname(command.input);
  if (existsSync(dir)) throw new Error(`${dir} already exists; not overwriting it`);
  mkdirSync(dir, { recursive: true });
  try {
    writeFileSync(command.input, js);
    await run(tree, hermescPath(tree), command.args);
    return Buffer.from(readFileSync(command.out)).equals(expected);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Compiles `js` with Expo's hermesc command in a new scratch dir, against `base` when given, and returns the bytecode.
 * hermesc embeds the input name, so it runs in that dir on fixed relative names: same bytes anywhere.
 */
export async function compile(
  tree: Tree,
  command: Hermesc,
  js: Uint8Array,
  base?: Uint8Array,
): Promise<{ hbc: Uint8Array<ArrayBuffer>; args: string[] }> {
  const dir = mkdtempSync(join(tmpdir(), "hermes-delta-hermesc-"));
  try {
    writeFileSync(join(dir, "index.js"), js);
    if (base !== undefined) writeFileSync(join(dir, "base.hbc"), base);
    const args = retarget(
      command,
      "index.js",
      "index.hbc",
      base === undefined ? undefined : "base.hbc",
    );
    await run(tree, hermescPath(tree), args, {}, dir);
    return { hbc: bytes(join(dir, "index.hbc")), args };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** What hermesc reads from a bytecode file's header. */
export interface Inspection {
  readonly bytecodeVersion: number;
  readonly sourceHash: string;
  readonly functions: number;
  readonly strings: number;
}

/** Returns the header facts of `hermesc -b -dump-bytecode` output; a dump missing one throws. */
export function parseDump(lines: readonly string[]): Inspection {
  const field = (name: string) => {
    const value = lines
      .find((l) => l.trim().startsWith(`${name}: `))
      ?.trim()
      .slice(name.length + 2);
    if (value === undefined) throw new Error(`the bytecode dump has no ${name}`);
    return value;
  };
  return {
    bytecodeVersion: Number(field("Bytecode version number")),
    sourceHash: field("Source hash"),
    functions: Number(field("Function count")),
    strings: Number(field("String count")),
  };
}

/**
 * Returns what the app's hermesc reads from `hbc` as executable bytecode, disassembled in a scratch dir holding no
 * other file, so a delta compile's base is out of reach. A file hermesc cannot load to the end throws.
 */
export async function inspect(tree: Tree, hbc: Uint8Array): Promise<Inspection> {
  const dir = mkdtempSync(join(tmpdir(), "hermes-delta-inspect-"));
  try {
    writeFileSync(join(dir, "index.hbc"), hbc);
    const child = spawn(hermescPath(tree), ["-b", "-dump-bytecode", "index.hbc"], {
      cwd: dir,
      env: buildEnv(tree, {}),
      stdio: ["ignore", "pipe", "pipe"],
    });
    // The header ends where the string table starts; the rest of the dump is read and dropped.
    const header: string[] = [];
    let inHeader = true;
    createInterface({ input: child.stdout }).on("line", (line) => {
      if (line.startsWith("Global String Table")) inHeader = false;
      if (inHeader) header.push(line);
    });
    let stderr = "";
    child.stderr.setEncoding("utf8").on("data", (s: string) => (stderr += s));
    const [code] = (await once(child, "close")) as [number | null];
    if (code !== 0) throw new Error(`hermesc could not load the bytecode alone: ${stderr.trim()}`);
    return parseDump(header);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Builds the bundle a release APK embeds as the React Native Gradle plugin's createBundleReleaseJsAndAssets task
 * does: the template's bundle command, then hermesc with the plugin's fixed arguments and default flags.
 */
export async function embed(tree: Tree) {
  const flags = gradleFlags(tree);
  const entry = relative(
    tree.dir,
    execFileSync(
      process.execPath,
      ["-e", "require('expo/scripts/resolveAppEntry')", tree.dir, "android", "absolute"],
      { cwd: tree.dir, encoding: "utf8" },
    ).trim(),
  );
  const resolve = createRequire(join(tree.dir, "package.json"));
  const cli = relative(
    tree.dir,
    createRequire(resolve.resolve("expo/package.json")).resolve("@expo/cli"),
  );
  rmSync(join(tree.dir, "android", "app", "build"), { recursive: true, force: true });
  for (const path of [GRADLE.bundle, GRADLE.packagerMap]) {
    mkdirSync(join(tree.dir, dirname(path)), { recursive: true });
  }
  mkdirSync(join(tree.dir, GRADLE.res), { recursive: true });
  const bundleCommand = [
    ...[cli, flags.bundleCommand, "--platform", "android", "--dev", "false", "--reset-cache"],
    ...["--entry-file", entry, "--bundle-output", GRADLE.bundle, "--assets-dest", GRADLE.res],
    ...["--sourcemap-output", GRADLE.packagerMap, "--minify", "false", "--verbose"],
  ];
  await run(tree, process.execPath, bundleCommand);
  const out = `${GRADLE.bundle}.hbc`;
  const args = flags.hermesc.map((a) => (a === BYTECODE ? out : a === BUNDLE ? GRADLE.bundle : a));
  await run(tree, hermescPath(tree), args);
  return {
    hbc: bytes(join(tree.dir, out)),
    bundleCommand: ["node", ...bundleCommand],
    hermescArgs: args,
    flagsFrom: flags.from,
  };
}

const BYTECODE = "<bytecode>";
const BUNDLE = "<bundle>";

/**
 * Returns the hermesc arguments of the RN Gradle plugin's BundleHermesCTask, read from the plugin the app installs,
 * with the default hermesFlags the Expo template leaves alone, and the template's bundle command.
 */
function gradleFlags(tree: Tree) {
  const plugin = dirname(packageJson(tree, "@react-native/gradle-plugin", "react-native"));
  const kotlin = join(
    plugin,
    "react-native-gradle-plugin",
    "src",
    "main",
    "kotlin",
    "com",
    "facebook",
    "react",
  );
  const task = readFileSync(join(kotlin, "tasks", "BundleHermesCTask.kt"), "utf8");
  const extension = readFileSync(join(kotlin, "ReactExtension.kt"), "utf8");
  const fixed =
    /getHermescCommand\([\s\S]*?windowsAwareCommandLine\(\s*hermesCommand,([\s\S]*?)\*hermesFlags/.exec(
      task,
    )?.[1];
  const defaults = /val hermesFlags\b[\s\S]*?\.convention\(listOf\(([^)]*)\)\)/.exec(
    extension,
  )?.[1];
  if (fixed === undefined || defaults === undefined) {
    throw new Error(`cannot read hermesc flags from the RN Gradle plugin at ${plugin}`);
  }
  const template = execFileSync(
    "tar",
    [
      "-xzOf",
      join(dirname(packageJson(tree, "expo")), "template.tgz"),
      "package/android/app/build.gradle",
    ],
    { encoding: "utf8" },
  );
  const react = (/^react \{([\s\S]*?)^\}/m.exec(template)?.[1] ?? "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");
  const bundleCommand = /bundleCommand = "([^"]+)"/.exec(react)?.[1];
  if (bundleCommand === undefined || /\bhermesFlags\b/.test(react)) {
    throw new Error("the Expo template's react block sets hermesFlags or no bundleCommand");
  }
  return {
    bundleCommand,
    hermesc: [...kotlinArgs(fixed), ...kotlinArgs(defaults)],
    from: [
      `${relative(tree.dir, join(kotlin, "tasks", "BundleHermesCTask.kt"))} getHermescCommand`,
      `${relative(tree.dir, join(kotlin, "ReactExtension.kt"))} hermesFlags convention`,
      "expo/template.tgz android/app/build.gradle react { bundleCommand } (no hermesFlags)",
    ],
  };
}

/** Returns the arguments of a Kotlin argument list: string literals, and the bytecode and bundle file paths. */
export function kotlinArgs(list: string): string[] {
  return list
    .split(",")
    .map((a) => a.trim())
    .filter((a) => a !== "")
    .map((a) => {
      if (/^"[^"]*"$/.test(a)) return a.slice(1, -1);
      if (a.startsWith("bytecodeFile.")) return BYTECODE;
      if (a.startsWith("bundleFile.")) return BUNDLE;
      throw new Error(`unexpected hermesc argument in the Gradle plugin: ${a}`);
    });
}

/** Returns the versions and hermesc the app's own dependencies resolve to, and where Expo compiles bytecode. */
export function tools(tree: Tree) {
  const version = (path: string) =>
    (JSON.parse(readFileSync(path, "utf8")) as { version: string }).version;
  const hermesc = hermescPath(tree);
  const about = execFileSync(hermesc, ["-version"], { encoding: "utf8" });
  const metroConfig = dirname(packageJson(tree, "@expo/metro-config", "expo"));
  return {
    versions: {
      expo: version(packageJson(tree, "expo")),
      "@expo/cli": version(packageJson(tree, "@expo/cli", "expo")),
      "@expo/metro-config": version(join(metroConfig, "package.json")),
      "react-native": version(packageJson(tree, "react-native")),
      "hermes-compiler": version(packageJson(tree, "hermes-compiler", "react-native")),
      "@react-native/gradle-plugin": version(
        packageJson(tree, "@react-native/gradle-plugin", "react-native"),
      ),
    },
    hermesc: {
      path: relative(tree.dir, hermesc),
      release: /Hermes release version: (\S+)/.exec(about)?.[1] ?? "unknown",
      bytecodeVersion: Number(/HBC bytecode version: (\d+)/.exec(about)?.[1]),
    },
    serializer: serializerPath(metroConfig),
  };
}

/**
 * Returns the @expo/metro-config files on the bytecode path: the one that runs hermesc and every serializer file that
 * calls into it, and the one gating on the bytecode transform option. Refuses a layout this description misses.
 */
function serializerPath(metroConfig: string) {
  const root = join(metroConfig, "build", "serializer");
  const files = (readdirSync(root, { recursive: true }) as string[]).filter((f) =>
    f.endsWith(".js"),
  );
  const read = (f: string) => readFileSync(join(root, f), "utf8");
  const compile = read("exportHermes.js");
  for (const needle of [
    "buildHermesBundleAsync",
    "REACT_NATIVE_OVERRIDE_HERMES_DIR",
    "'-emit-binary'",
  ]) {
    if (!compile.includes(needle)) throw new Error(`exportHermes.js no longer holds ${needle}`);
  }
  const name = (f: string) => `@expo/metro-config/build/serializer/${f}`;
  const callers = files.filter(
    (f) => f !== "exportHermes.js" && /buildHermesBundleAsync|\.\/exportHermes/.test(read(f)),
  );
  const gates = files.filter((f) => read(f).includes("boolishTransformOption('bytecode')"));
  if (callers.length === 0 || gates.length === 0) {
    throw new Error("cannot find the serializer files that call hermesc and gate on bytecode");
  }
  return {
    compile: `${name("exportHermes.js")} buildHermesBundleAsync`,
    callers: callers.map(name),
    bytecodeGate: gates.map(name),
  };
}

/** Returns the hermesc Expo's exportHermes.js resolves without an override: react-native's hermes-compiler package. */
function hermescPath(tree: Tree): string {
  const bin = { darwin: "osx-bin", linux: "linux64-bin" }[process.platform as string];
  if (bin === undefined) throw new Error(`no hermesc for ${process.platform}`);
  return join(
    dirname(packageJson(tree, "hermes-compiler", "react-native")),
    "hermesc",
    bin,
    "hermesc",
  );
}

/** Returns the package.json path of `name`, resolved from the package `from` resolves to, or from the app. */
function packageJson(tree: Tree, name: string, from?: string): string {
  const app = createRequire(join(tree.dir, "package.json"));
  const base = from === undefined ? app : createRequire(app.resolve(`${from}/package.json`));
  return base.resolve(`${name}/package.json`);
}

const expoBin = (tree: Tree) => join(tree.dir, "node_modules", ".bin", "expo");

const patchPath = (patch: string) => join(PATCHES, patch);

/** Returns a copy of the file at `path` with its own ArrayBuffer. */
function bytes(path: string): Uint8Array<ArrayBuffer> {
  return new Uint8Array(readFileSync(path));
}

function write(path: string, data: string | Uint8Array): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, data);
}

/**
 * Runs git in the tree without the user's or system's config, whose signing, hooks or line endings would change it.
 * Git finds no repository above the tree, even through an inherited GIT_DIR or GIT_WORK_TREE: inside one, `git
 * apply` skips paths outside the tree and still exits 0.
 */
function git(tree: Pick<Tree, "dir">, args: readonly string[]): string {
  const inherited = Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_"));
  return execFileSync("git", ["-C", tree.dir, ...args], {
    encoding: "utf8",
    env: {
      ...Object.fromEntries(inherited),
      GIT_CEILING_DIRECTORIES: dirname(tree.dir),
      GIT_CONFIG_GLOBAL: devNull,
      GIT_CONFIG_NOSYSTEM: "1",
    },
  });
}

/** Runs `command` in `cwd` with the build environment plus `env`, appending its output to the tree's log. */
async function run(
  tree: Tree,
  command: string,
  args: readonly string[],
  env: Record<string, string> = {},
  cwd = tree.dir,
): Promise<void> {
  const fd = openSync(tree.log, "a");
  try {
    writeFileSync(fd, `\n$ ${command} ${args.join(" ")}\n`);
    const child = spawn(command, args, {
      cwd,
      env: buildEnv(tree, env),
      stdio: ["ignore", fd, fd],
    });
    const [code, signal] = (await once(child, "close")) as [number | null, NodeJS.Signals | null];
    if (code !== 0) {
      const name = command.split("/").at(-1);
      throw new Error(
        `${name} ${args[0] ?? ""} ${signal ? `was killed by ${signal}` : `exited ${code}`}:\n${tail(tree.log)}`,
      );
    }
  } finally {
    closeSync(fd);
  }
}
