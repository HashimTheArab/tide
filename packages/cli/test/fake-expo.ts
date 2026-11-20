// Stands in for a project's `expo` and `expo-updates` executables, which Tide runs but does not ship.
// Usage, through the shims a test writes into node_modules/.bin: node fake-expo.ts <expo|expo-updates> <args...>
// Each run appends {tool, args, env} as one JSON line to fake-expo.log in its working directory, the project root.
import { appendFileSync, cpSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const [tool = "", ...args] = process.argv.slice(2);
const cwd = process.cwd();
appendFileSync(join(cwd, "fake-expo.log"), `${JSON.stringify({ tool, args, env: process.env })}\n`);
const flag = (name: string) => args[args.indexOf(name) + 1] ?? "";

if (tool === "expo" && args[0] === "export") {
  cpSync(fileURLToPath(new URL("fixtures/export", import.meta.url)), flag("--output-dir"), {
    recursive: true,
  });
  console.log("Exported: dist"); // Expo reports progress on stdout.
} else {
  if (tool === "expo") {
    // Expo's setNodeEnv("development") for `expo config`; the runtime resolver sets nothing.
    const unset = (name: string) => process.env[name] === undefined || process.env[name] === "";
    if (unset("NODE_ENV")) process.env.NODE_ENV = "development";
    if (unset("BABEL_ENV")) process.env.BABEL_ENV = process.env.NODE_ENV;
  }
  const appConfig = (await import(pathToFileURL(join(cwd, "app.config.mjs")).href)) as {
    default: () => { [field: string]: unknown; updates?: Record<string, unknown> };
  };
  const config = appConfig.default();
  if (tool === "expo" && args.includes("public")) {
    // As Expo's public config, which leaves out the code-signing fields.
    const {
      codeSigningCertificate: _c,
      codeSigningMetadata: _m,
      ...updates
    } = config.updates ?? {};
    config.updates = updates;
  }
  if (tool === "expo-updates") {
    const platform = config[flag("--platform")] as { runtimeVersion?: unknown } | undefined;
    const runtimeVersion = platform?.runtimeVersion ?? config.runtimeVersion;
    console.log(JSON.stringify({ runtimeVersion, fingerprintSources: null, workflow: "managed" }));
  } else console.log(JSON.stringify(config));
}
