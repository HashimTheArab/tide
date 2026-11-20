// Stands in for a project's `expo` and `expo-updates` executables, which Tide runs but does not ship.
// Usage, through the shims a test writes into node_modules/.bin: node fake-expo.ts <expo|expo-updates> <args...>
// Each run appends {tool, args, env} as one JSON line to fake-expo.log in its working directory, the project root.
import { appendFileSync, cpSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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
    fileMetadata: Record<string, unknown>;
  };
  for (const name of Object.keys(metadata.fileMetadata)) {
    if (!platforms.includes(name)) delete metadata.fileMetadata[name];
  }
  writeFileSync(join(out, "metadata.json"), JSON.stringify(metadata));
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
