// `tide export --base-bytecode`: Expo compiles the launch bundle with the app's hermesc against a fixed base (decision 0002).
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import type { ExportedPlatform } from "./publish-export.ts";
import type { Platform } from "./publish-record.ts";
import { readRegular } from "./publish-export.ts";
import { PublishError, platformOf } from "./publish-record.ts";

/** Runs `command` in `cwd` with the export's child environment; returns its stdout when `pipe`. */
export type Runner = (
  command: string, // How a refusal names it.
  path: string,
  args: readonly string[],
  cwd: string,
  stdout: "pipe" | "stderr",
) => Promise<string>;

/** A validated `--base-bytecode` file, for the export's one platform. */
export interface Base {
  readonly platform: Platform;
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

/**
 * Returns the `<platform>=<file>` value's base, read against `cwd`, or undefined without one. Expo gives hermesc no
 * platform, so a based export selects exactly that one platform.
 */
export function readBase(
  values: readonly string[],
  platforms: readonly Platform[],
  passEnv: readonly string[],
  cwd: string,
): Base | undefined {
  const [value] = values;
  if (value === undefined) return undefined;
  // `--pass-env` is the only way a caller's override reaches Expo, which must find the wrapper.
  if (passEnv.includes(OVERRIDE_VARIABLE)) {
    throw new PublishError(
      `--base-bytecode compiles with the app's hermesc from react-native and hermes-compiler; drop --pass-env ${OVERRIDE_VARIABLE}`,
    );
  }
  const at = value.indexOf("=");
  if (at === -1 || value.length === at + 1) {
    throw new PublishError("--base-bytecode must be <platform>=<file>");
  }
  const platform = platformOf(value.slice(0, at), "--base-bytecode platform");
  if (values.length > 1 || platforms.length > 1) {
    throw new PublishError(
      "--base-bytecode compiles one platform: give one base and one --platform, and export each platform on its own",
    );
  }
  if (platform !== platforms[0]) {
    throw new PublishError(`--base-bytecode ${platform} is not the platform this export selects`);
  }
  const name = `--base-bytecode ${platform}`;
  const bytes = readRegular(resolve(cwd, value.slice(at + 1)), Infinity, name);
  const version = bytecodeVersion(bytes);
  if (version === undefined) throw new PublishError(`${name} is not Hermes bytecode`);
  return { platform, bytes, version };
}

/** The app's hermesc and the base it was checked against. */
export interface Compiler {
  readonly hermesc: string;
  readonly base: Base;
}

/** Returns the hermesc Expo would run for the project (`exportHermes.js`), after checking it writes the base's version. */
export async function appHermesc(projectRoot: string, base: Base, run: Runner): Promise<Compiler> {
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
  const about = await run("hermesc -version", hermesc, ["-version"], tmpdir(), "pipe");
  const version = /HBC bytecode version: (\d+)/.exec(about)?.[1];
  if (version === undefined) throw new PublishError("hermesc -version printed no bytecode version");
  if (base.version !== Number(version)) {
    throw new PublishError(
      `--base-bytecode ${base.platform} is bytecode version ${base.version}; the app's hermesc writes ${version}`,
    );
  }
  return { hermesc, base };
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
 * Writes, under the returned override directory, the hermesc Expo finds: `hermesc` with Expo's arguments plus
 * `-base-bytecode` of the checked base bytes, leaving a mark that Expo ran it.
 */
export function deltaWrapper({ hermesc, base }: Compiler): Wrapper {
  const scratch = mkdtempSync(join(tmpdir(), "tide-hermes-"));
  const override = join(scratch, "override");
  mkdirSync(join(override, "build", "bin"), { recursive: true });
  writeFileSync(join(scratch, "base.hbc"), base.bytes);
  const bin = join(override, "build", "bin", "hermesc");
  writeFileSync(
    bin,
    `#!/bin/sh
: > ${quote(join(scratch, "ran"))} || exit
exec ${quote(hermesc)} "$@" ${quote(`-base-bytecode=${join(scratch, "base.hbc")}`)}
`,
  );
  chmodSync(bin, 0o755);
  return { scratch, override, base };
}

interface Wrapper {
  readonly scratch: string; // Removed by the caller.
  readonly override: string; // The REACT_NATIVE_OVERRIDE_HERMES_DIR value.
  readonly base: Base;
}

/** A POSIX shell single-quoted literal of `s`. */
const quote = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;

/** Refuses unless Expo ran the wrapper and wrote each launch bundle as bytecode of the base's version. */
export function checkDelta(
  platforms: readonly ExportedPlatform[],
  { scratch, base }: Wrapper,
): void {
  if (!existsSync(join(scratch, "ran"))) {
    throw new PublishError(`expo export did not run hermesc through ${OVERRIDE_VARIABLE}`);
  }
  for (const { bundle } of platforms) {
    if (bytecodeVersion(bundle.bytes) !== base.version) {
      throw new PublishError(
        `the ${base.platform} launch bundle is not Hermes bytecode version ${base.version}`,
      );
    }
  }
}
