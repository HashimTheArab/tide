// Stands in for a project's `expo` and `expo-updates` executables, which Tide runs but does not ship.
// Usage, through the shims a test writes into node_modules/.bin: node fake-expo.ts <expo|expo-updates> <args...>
// Each run appends {tool, args, env} as one JSON line to fake-expo.log in its working directory, the project root.
// `export` compiles each platform's JS (`// <platform>` and the project's app.js) with the hermesc Expo would find.
import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

interface Config {
  [field: string]: unknown;
  updates?: Record<string, unknown>;
}

const [tool = "", ...args] = process.argv.slice(2);
const cwd = process.cwd();
appendFileSync(join(cwd, "fake-expo.log"), `${JSON.stringify({ tool, args, env: process.env })}\n`);
const flag = (name: string) => args[args.indexOf(name) + 1] ?? "";

if (tool === "expo" && args[0] === "export") {
  const out = flag("--output-dir");
  cpSync(fileURLToPath(new URL("fixtures/export", import.meta.url)), out, { recursive: true });
  // As SDK 57's exporter: metadata for the selected platforms only, and the project's public/ folder copied in.
  const platforms = args.filter((_, i) => args[i - 1] === "--platform");
  const metadata = JSON.parse(readFileSync(join(out, "metadata.json"), "utf8")) as {
    fileMetadata: Record<string, { bundle: string }>;
  };
  for (const name of Object.keys(metadata.fileMetadata)) {
    if (!platforms.includes(name)) delete metadata.fileMetadata[name];
  }
  writeFileSync(join(out, "metadata.json"), JSON.stringify(metadata));
  const hermesc = hermescPath();
  for (const [platform, { bundle }] of Object.entries(metadata.fileMetadata)) {
    if (hermesc !== undefined) writeFileSync(join(out, bundle), compile(hermesc, platform));
  }
  if (existsSync(join(cwd, "public"))) cpSync(join(cwd, "public"), out, { recursive: true });
  writeFileSync(join(out, "unreferenced.txt"), "not named by metadata.json\n");
  console.log("Exported: dist"); // Expo reports progress on stdout.
} else {
  if (tool === "expo") {
    // Expo's setNodeEnv("development") for `expo config`; the runtime resolver sets nothing.
    const unset = (name: string) => process.env[name] === undefined || process.env[name] === "";
    if (unset("NODE_ENV")) process.env.NODE_ENV = "development";
    if (unset("BABEL_ENV")) process.env.BABEL_ENV = process.env.NODE_ENV;
  }
  const appConfig = (await import(pathToFileURL(join(cwd, "app.config.mjs")).href)) as {
    default: () => Config;
  };
  const config = appConfig.default();
  if (tool === "expo" && args.includes("public")) {
    // As Expo's getConfig with isPublicConfig: no hooks, native config or code-signing fields.
    delete config._internal;
    delete config.hooks;
    for (const native of [config.ios, config.android] as (Config | undefined)[])
      delete native?.config;
    delete config.updates?.codeSigningCertificate;
    delete config.updates?.codeSigningMetadata;
  }
  if (tool === "expo-updates") {
    const platform = config[flag("--platform")] as { runtimeVersion?: unknown } | undefined;
    const runtimeVersion = platform?.runtimeVersion ?? config.runtimeVersion;
    console.log(JSON.stringify({ runtimeVersion, fingerprintSources: null, workflow: "managed" }));
  } else console.log(JSON.stringify(config));
}

/**
 * Returns the hermesc @expo/metro-config's exportHermes.js would run, resolved from the real project directory as
 * resolve-from does, or undefined when the project has no react-native (the fixture bundles are copied as they are).
 */
function hermescPath(): string | undefined {
  const resolve = (from: string, name: string) =>
    dirname(createRequire(join(from, "package.json")).resolve(`${name}/package.json`));
  let rn: string;
  try {
    rn = resolve(realpathSync(cwd), "react-native");
  } catch {
    return undefined;
  }
  const host = process.platform === "darwin" ? "osx-bin" : "linux64-bin";
  // FAKE_EXPO_IGNORES_OVERRIDE stands in for an Expo that no longer reads the variable.
  const override =
    process.env.FAKE_EXPO_IGNORES_OVERRIDE === undefined
      ? process.env.REACT_NATIVE_OVERRIDE_HERMES_DIR
      : undefined;
  const found = [
    override === undefined ? "" : `${override}/build/bin/hermesc`,
    `${rn}/ReactAndroid/hermes-engine/build/hermes/bin/hermesc`,
    `${resolve(rn, "hermes-compiler")}/hermesc/${host}/hermesc`,
    `${rn}/sdks/hermesc/${host}/hermesc`,
  ].find((path) => existsSync(path));
  if (found === undefined) throw new Error("Cannot find the hermesc executable.");
  return found;
}

/** Compiles the platform's JS as exportHermes.js does: in a temporary directory, with Expo's arguments. */
function compile(hermesc: string, platform: string): Buffer {
  const dir = mkdtempSync(join(tmpdir(), "expo-bundler-"));
  try {
    const app = join(cwd, "app.js");
    writeFileSync(
      join(dir, "index.js"),
      `// ${platform}\n${existsSync(app) ? readFileSync(app, "utf8") : ""}`,
    );
    const args = ["-emit-binary", "-out", join(dir, "index.hbc"), join(dir, "index.js"), "-O"];
    const { status } = spawnSync(hermesc, args, { stdio: "inherit" });
    if (status !== 0) throw new Error(`hermesc exited ${status}`);
    return readFileSync(join(dir, "index.hbc"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
