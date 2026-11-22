// `tide export --base-bytecode`: the launch bundle compiled with the app's hermesc against a fixed base (decision 0002).
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import type { ExportedPlatform } from "./publish-export.ts";
import type { Platform } from "./publish-record.ts";
import { readRegular } from "./publish-export.ts";
import { PublishError } from "./publish-record.ts";

/** Runs `command` in `cwd` with the export's child environment; returns its stdout when `pipe`. */
export type Runner = (
  command: string, // How a refusal names it.
  path: string,
  args: readonly string[],
  cwd: string,
  stdout: "pipe" | "stderr",
) => Promise<string>;

/** A validated `--base-bytecode` file. */
export interface Base {
  readonly bytes: Uint8Array<ArrayBuffer>;
  readonly version: number;
}

export const OVERRIDE_VARIABLE = "REACT_NATIVE_OVERRIDE_HERMES_DIR";
// HBC files open with this magic, then the u32 little-endian bytecode version.
const MAGIC = Uint8Array.of(0xc6, 0x1f, 0xbc, 0x03, 0xc1, 0x03, 0x19, 0x1f);
const HOSTS: Partial<Record<NodeJS.Platform, string>> = { darwin: "osx-bin", linux: "linux64-bin" };

/** Returns the bytecode version of a Hermes bytecode file, or undefined for anything else. */
function bytecodeVersion(bytes: Uint8Array): number | undefined {
  if (bytes.length < 12 || !MAGIC.every((b, i) => bytes[i] === b)) return undefined;
  return new DataView(bytes.buffer, bytes.byteOffset, 12).getUint32(8, true);
}

/** Returns each `<platform>=<file>` value's base, read against `cwd`; every platform must be selected, once. */
export function readBases(
  values: readonly string[],
  platforms: readonly Platform[],
  cwd: string,
): Map<Platform, Base> {
  const given = new Map<Platform, string>();
  for (const value of values) {
    const at = value.indexOf("=");
    const platform = value.slice(0, at);
    if (at === -1 || value.length === at + 1) {
      throw new PublishError("--base-bytecode must be <platform>=<file>");
    }
    if (platform !== "ios" && platform !== "android") {
      throw new PublishError("--base-bytecode platform must be ios or android");
    }
    if (!platforms.includes(platform)) {
      throw new PublishError(`--base-bytecode ${platform} is not a platform this export selects`);
    }
    if (given.has(platform)) throw new PublishError(`--base-bytecode ${platform} is given twice`);
    given.set(platform, value.slice(at + 1));
  }
  const bases = new Map<Platform, Base>();
  for (const [platform, file] of given) {
    const name = `--base-bytecode ${platform}`;
    const bytes = readRegular(resolve(cwd, file), Infinity, name);
    const version = bytecodeVersion(bytes);
    if (version === undefined) throw new PublishError(`${name} is not Hermes bytecode`);
    bases.set(platform, { bytes, version });
  }
  return bases;
}

/**
 * Returns the hermesc Expo would run for the project (`exportHermes.js`, without its override), after checking that it
 * writes every base's bytecode version.
 */
export async function appHermesc(
  projectRoot: string,
  bases: ReadonlyMap<Platform, Base>,
  run: Runner,
): Promise<string> {
  const host = HOSTS[process.platform];
  if (host === undefined) {
    throw new PublishError(
      "--base-bytecode runs the app's hermesc, which Tide supports on macOS and Linux",
    );
  }
  // Expo's resolve-from starts at the real directory, so a symlinked app finds its real ancestors' node_modules.
  let root: string;
  try {
    root = realpathSync(projectRoot);
  } catch {
    throw new PublishError("--project-root is missing or unreadable");
  }
  const rn = packageRoot(root, "react-native");
  const compiler = packageRoot(rn, "hermes-compiler");
  const hermesc = [
    join(rn, "ReactAndroid", "hermes-engine", "build", "hermes", "bin", "hermesc"),
    join(compiler, "hermesc", host, "hermesc"),
    join(rn, "sdks", "hermesc", host, "hermesc"),
  ].find((path) => existsSync(path));
  if (hermesc === undefined) {
    throw new PublishError("no hermesc is installed under react-native or hermes-compiler");
  }
  const cwd = mkdtempSync(join(tmpdir(), "tide-hermesc-"));
  let about: string;
  try {
    about = await run("hermesc -version", hermesc, ["-version"], cwd, "pipe");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
  const version = /HBC bytecode version: (\d+)/.exec(about)?.[1];
  if (version === undefined) throw new PublishError("hermesc -version printed no bytecode version");
  for (const [platform, base] of bases) {
    if (base.version !== Number(version)) {
      throw new PublishError(
        `--base-bytecode ${platform} is bytecode version ${base.version}; the app's hermesc writes ${version}`,
      );
    }
  }
  return hermesc;
}

/** Returns the directory of `name`'s package.json, resolved from `from` as Node and Expo resolve it. */
function packageRoot(from: string, name: string): string {
  try {
    return dirname(createRequire(join(from, "package.json")).resolve(`${name}/package.json`));
  } catch {
    throw new PublishError(`${name} is not installed in the project: --base-bytecode needs it`);
  }
}

/**
 * Writes the hermesc Expo finds under the returned override directory: it runs `hermesc` with Expo's arguments, then
 * keeps the arguments (NUL-separated), the input JS and the output in a new directory under `capture`.
 */
export function captureWrapper(scratch: string, hermesc: string): Wrapper {
  const override = join(scratch, "override");
  const capture = join(scratch, "capture");
  mkdirSync(join(override, "build", "bin"), { recursive: true });
  mkdirSync(capture);
  const bin = join(override, "build", "bin", "hermesc");
  writeFileSync(
    bin,
    `#!/bin/sh
run=$(mktemp -d ${quote(join(capture, "run.XXXXXX"))}) || exit
printf '%s\\0' "$@" > "$run/args" || exit
${quote(hermesc)} "$@" || exit
out= next=
for a in "$@"; do
  if [ -n "$next" ]; then out=$a; next=
  elif [ "$a" = -out ]; then next=1
  else case $a in -*) ;; *) cp -- "$a" "$run/input" || exit ;; esac
  fi
done
cp -- "$out" "$run/output"
`,
  );
  chmodSync(bin, 0o755);
  return { hermesc, scratch, override, capture };
}

interface Wrapper {
  readonly hermesc: string; // The app's own, which the wrapper runs.
  readonly scratch: string;
  readonly override: string; // The REACT_NATIVE_OVERRIDE_HERMES_DIR value.
  readonly capture: string;
}

/** A POSIX shell single-quoted literal of `s`. */
const quote = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;

/**
 * Returns `files` with each based platform's launch bundle compiled again against its base: the JS and flags of the
 * one captured run that wrote Expo's bundle, plus `-base-bytecode`. Refuses a bundle path the export also uses for
 * another file, a bundle that is not bytecode, and one no single capture wrote.
 */
export async function deltaCompile(
  {
    platforms: exported,
    files,
  }: {
    readonly platforms: readonly (ExportedPlatform & { readonly platform: Platform })[];
    readonly files: ReadonlyMap<string, Uint8Array<ArrayBuffer>>;
  },
  bases: ReadonlyMap<Platform, Base>,
  { hermesc, scratch, capture }: Wrapper,
  run: Runner,
): Promise<Map<string, Uint8Array<ArrayBuffer>>> {
  const runs = readdirSync(capture).flatMap((name) => {
    const dir = join(capture, name);
    if (!existsSync(join(dir, "output"))) return [];
    const args = readFileSync(join(dir, "args"), "utf8").split("\0").slice(0, -1);
    return [{ dir, args, output: readFileSync(join(dir, "output")) }];
  });
  const out = new Map(files);
  for (const { platform, bundle, paths } of exported) {
    const base = bases.get(platform);
    if (base === undefined) continue;
    const shared =
      paths.bundle === "metadata.json" ||
      exported.some(
        (other) =>
          (other.platform !== platform && other.paths.bundle === paths.bundle) ||
          other.paths.assets.includes(paths.bundle),
      );
    if (shared) {
      throw new PublishError(
        `the ${platform} launch bundle ${paths.bundle} is also another file of the export, which --base-bytecode would change`,
      );
    }
    if (bytecodeVersion(bundle.bytes) === undefined) {
      throw new PublishError(`the ${platform} launch bundle is not Hermes bytecode`);
    }
    const matches = runs.filter((r) => r.output.equals(bundle.bytes));
    const [match] = matches;
    if (match === undefined || matches.length > 1) {
      throw new PublishError(
        `expo export compiled the ${platform} launch bundle in ${matches.length} hermesc runs Tide saw, not 1`,
      );
    }
    const dir = mkdtempSync(join(scratch, "compile-"));
    writeFileSync(join(dir, "index.js"), readFileSync(join(match.dir, "input")));
    writeFileSync(join(dir, "base.hbc"), base.bytes);
    // Fixed relative names: hermesc embeds the input path, so the bytes depend only on the JS, flags and base.
    await run(
      "hermesc",
      hermesc,
      [...retarget(match.args), "-base-bytecode=base.hbc"],
      dir,
      "stderr",
    );
    const compiled = readRegular(join(dir, "index.hbc"), Infinity, "the delta-compiled bundle");
    if (bytecodeVersion(compiled) !== base.version) {
      throw new PublishError(`hermesc did not write bytecode version ${base.version}`);
    }
    out.set(paths.bundle, compiled);
  }
  return out;
}

/** Returns Expo's hermesc arguments reading `index.js` and writing `index.hbc`. */
function retarget(args: readonly string[]): string[] {
  const out = args.indexOf("-out");
  const inputs = args.flatMap((a, i) => (a.startsWith("-") || i === out + 1 ? [] : [i]));
  if (out === -1 || out + 1 >= args.length || inputs.length !== 1) {
    throw new PublishError("expo export ran hermesc without one input and one -out");
  }
  return args.map((a, i) => (i === out + 1 ? "index.hbc" : i === inputs[0] ? "index.js" : a));
}
