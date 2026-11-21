import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, onTestFinished, test } from "vitest";

import { EXPO_VERSIONS, SCENARIOS, USAGE, parseRun } from "../src/options.ts";
import { fakeSdk } from "./harness.ts";

const MAIN = fileURLToPath(new URL("../src/main.ts", import.meta.url));
const ALL_SCENARIOS = Object.keys(SCENARIOS);

/** Runs the conformance bin with `TMPDIR` set to a fresh empty directory, which it returns too, and `env`. */
async function conformance(args: string[], env: Record<string, string> = {}) {
  const tmp = mkdtempSync(join(tmpdir(), "tide-conformance-test-"));
  onTestFinished(() => rmSync(tmp, { recursive: true, force: true }));
  const proc = spawn(process.execPath, [MAIN, ...args], {
    env: { PATH: process.env.PATH ?? "", TMPDIR: tmp, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  proc.stdout.setEncoding("utf8").on("data", (s: string) => (stdout += s));
  proc.stderr.setEncoding("utf8").on("data", (s: string) => (stderr += s));
  const [code] = (await once(proc, "close")) as [number | null];
  return { code, stdout, stderr, tmpEntries: readdirSync(tmp) };
}

describe("parseRun", () => {
  test("every version and scenario runs unless named", () => {
    expect(parseRun(["--platform", "android"])).toEqual({
      platform: "android",
      versions: ["55", "58"],
      scenarios: ALL_SCENARIOS,
      avd: undefined,
    });
  });

  test("--avd names the AVD to boot", () => {
    expect(parseRun(["--platform", "android", "--avd", "Pixel_9"])).toMatchObject({
      avd: "Pixel_9",
    });
  });

  test("named versions and scenarios run in table order, once each", () => {
    expect(
      parseRun([
        "--platform",
        "ios",
        "--expo",
        "58",
        "--scenario",
        "rollback",
        "--scenario",
        "full",
        "--scenario",
        "rollback",
      ]),
    ).toEqual({
      platform: "ios",
      versions: ["58"],
      scenarios: ["full", "rollback"],
      avd: undefined,
    });
  });

  test.each([["--help"], ["-h"], ["--platform", "nope", "--help"]])(
    "%s asks for help",
    (...args) => {
      expect(parseRun(args)).toBe("help");
    },
  );

  test.each([
    [[], "--platform must be android or ios"],
    [["--platform", "windows"], "--platform must be android or ios"],
    [["--platform", "android", "--platform", "ios"], "give --platform once"],
    [["--platform", "android", "--expo", "57"], "--expo must be one of 55, 58"],
    [
      ["--platform", "android", "--scenario", "x"],
      `--scenario must be one of ${ALL_SCENARIOS.join(", ")}`,
    ],
    [["--platform", "android", "extra"], "unrecognised arguments"],
    [["--platform", "android", "--device", "x"], "unrecognised arguments"],
  ])("%j is a usage error: %s", (args, message) => {
    expect(() => parseRun(args)).toThrow(message);
  });

  test("the usage lists every platform, version and scenario", () => {
    for (const name of ["android", "ios", ...Object.keys(EXPO_VERSIONS), ...ALL_SCENARIOS]) {
      expect(USAGE).toMatch(new RegExp(`\\b${name}\\b`));
    }
    expect(USAGE).toContain("55.0.31");
    expect(USAGE).toContain("58.0.1");
  });
});

describe("the conformance bin", () => {
  test("--help prints the usage and exits 0", async () => {
    expect(await conformance(["--help"])).toEqual({
      code: 0,
      stdout: `${USAGE}\n`,
      stderr: "",
      tmpEntries: [],
    });
  });

  test.each([
    [["--platform", "windows"], "--platform must be android or ios"],
    [["--platform", "android", "--expo", "54"], "--expo must be one of 55, 58"],
    [["--platform", "android", "--scenario", "nope"], "--scenario must be one of"],
  ])("%j exits 2 before creating anything", async (args, message) => {
    const result = await conformance(args);
    expect(result.code).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toMatch(
      new RegExp(`^conformance: ${message}.*; see pnpm conformance --help\\n$`),
    );
    expect(result.tmpEntries).toEqual([]);
  });

  test.each([
    [["--platform", "android"], "set ANDROID_HOME to the Android SDK"],
    [["--platform", "ios", "--scenario", "embedded"], "no ios device driver exists yet"],
  ])("%j exits 1 before creating anything: %s", async (args, message) => {
    const result = await conformance(args);
    expect(result).toMatchObject({ code: 1, stdout: "", tmpEntries: [] });
    expect(result.stderr).toMatch(new RegExp(`^conformance: ${message}`));
  });

  test("a version whose Gradle build fails prints a line per scenario, and the next version still builds", async () => {
    const fake = fakeSdk({ running: { "emulator-5554": {} } });
    const bin = join(fake.sdk, "bin");
    const gradleLog = join(fake.sdk, "gradle.log");
    mkdirSync(bin);
    // npm ci installs an expo whose prebuild writes a gradlew that fails in the 55 app and builds nothing in the 58.
    writeFileSync(
      join(bin, "npm"),
      `#!/bin/sh
mkdir -p node_modules/.bin
cat > node_modules/.bin/expo <<'EXPO'
#!/bin/sh
mkdir -p android
cat > android/gradlew <<'GRADLE'
#!/bin/sh
echo "$(pwd) $1" >> "$GRADLE_LOG"
case "$(pwd)" in */app-55/android) echo "FAILURE: Build failed with an exception."; exit 1;; esac
GRADLE
chmod +x android/gradlew
EXPO
chmod +x node_modules/.bin/expo
`,
    );
    chmodSync(join(bin, "npm"), 0o755);
    const result = await conformance(["--platform", "android"], {
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      ANDROID_HOME: fake.sdk,
      GRADLE_LOG: gradleLog,
    });
    expect(result.code).toBe(1);
    expect(result.stdout).toBe(
      [
        ...ALL_SCENARIOS.map(
          (s) => `android expo-updates 55 ${s}: fail: not run: gradlew assembleRelease exited 1:`,
        ),
        ...ALL_SCENARIOS.map(
          (s) => `android expo-updates 58 ${s}: fail: not run: unzip -q exited 9:`,
        ),
      ]
        .map((line) => `${line}\n`)
        .join(""),
    );
    expect(result.stderr).toContain("FAILURE: Build failed with an exception.");
    expect(
      readFileSync(gradleLog, "utf8")
        .trimEnd()
        .split("\n")
        .map((line) => line.split("/").slice(-2).join("/")),
    ).toEqual(["app-55/android assembleRelease", "app-58/android assembleRelease"]);
    expect(result.tmpEntries).toEqual([]);
  });
});
