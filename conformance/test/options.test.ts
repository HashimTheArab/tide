import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, onTestFinished, test } from "vitest";

import { EXPO_VERSIONS, SCENARIOS, USAGE, parseRun } from "../src/options.ts";
import { fakeSdk, fakeXcrun } from "./harness.ts";

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
      simulator: undefined,
    });
  });

  test("--avd names the AVD to boot", () => {
    expect(parseRun(["--platform", "android", "--avd", "Pixel_9"])).toMatchObject({
      avd: "Pixel_9",
    });
  });

  test("--simulator names the simulator to use", () => {
    expect(parseRun(["--platform", "ios", "--simulator", "iPhone 17"])).toMatchObject({
      simulator: "iPhone 17",
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
      simulator: undefined,
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
    [["--platform", "ios", "--avd", "Pixel"], "--avd is for --platform android"],
    [["--platform", "android", "--simulator", "iPhone"], "--simulator is for --platform ios"],
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

  test("--platform android exits 1 before creating anything without ANDROID_HOME", async () => {
    const result = await conformance(["--platform", "android"]);
    expect(result).toMatchObject({ code: 1, stdout: "", tmpEntries: [] });
    expect(result.stderr).toMatch(/^conformance: set ANDROID_HOME to the Android SDK/);
  });

  test("a version whose Gradle build fails prints a line per scenario, and the next version still builds", async () => {
    const fake = fakeSdk({ running: { "emulator-5554": {} } });
    const bin = join(fake.sdk, "bin");
    const tool = join(fake.sdk, "tool");
    const gradleLog = join(fake.sdk, "gradle.log");
    mkdirSync(bin);
    // npm ci links in expo, whose prebuild links in a gradlew that fails in the 55 app and builds nothing in the 58.
    // All are links to one script, since macOS checks each new executable on its first run, which is slow.
    writeFileSync(
      tool,
      `#!/bin/sh
case "$(basename "$0")" in
npm) mkdir -p node_modules/.bin && ln -s '${tool}' node_modules/.bin/expo ;;
expo) mkdir -p android && ln -s '${tool}' android/gradlew ;;
gradlew) echo "$(pwd) $1" >> "$GRADLE_LOG"
  case "$(pwd)" in */app-55/android) echo "FAILURE: Build failed with an exception."; exit 1;; esac ;;
esac
`,
    );
    chmodSync(tool, 0o755);
    symlinkSync(tool, join(bin, "npm"));
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

  test("a version whose Xcode build fails prints a line per scenario, the next still builds, and the booted simulator stays booted", async () => {
    const fake = fakeXcrun([{ udid: "A1", name: "iPhone", state: "Booted" }]);
    const bin = join(fake.dir, "bin");
    const tool = join(fake.dir, "tool");
    const buildLog = join(fake.dir, "xcodebuild.log");
    // npm ci links in expo, whose prebuild writes a workspace; xcodebuild fails in the 55 app and builds no .app in the
    // 58. All are links to one script, since macOS checks each new executable on its first run, which is slow.
    writeFileSync(
      tool,
      `#!/bin/sh
case "$(basename "$0")" in
npm) mkdir -p node_modules/.bin && ln -s '${tool}' node_modules/.bin/expo ;;
expo) mkdir -p ios/App.xcworkspace ;;
xcodebuild) echo "$(pwd) $*" >> "$BUILD_LOG"
  case "$(pwd)" in */app-55) echo "** BUILD FAILED **"; exit 65;; esac
  mkdir -p derived/Build/Products/Release-iphonesimulator ;;
esac
`,
    );
    chmodSync(tool, 0o755);
    for (const name of ["npm", "pod", "xcodebuild"]) symlinkSync(tool, join(bin, name));
    const result = await conformance(["--platform", "ios"], {
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      BUILD_LOG: buildLog,
    });
    expect(result.code).toBe(1);
    const lines = result.stdout.trimEnd().split("\n");
    expect(lines.slice(0, ALL_SCENARIOS.length)).toEqual(
      ALL_SCENARIOS.map(
        (s) => `ios expo-updates 55 ${s}: fail: not run: xcodebuild build exited 65:`,
      ),
    );
    const noApp = "/derived/Build/Products/Release-iphonesimulator holds 0 .app entries, not 1";
    expect(lines.slice(ALL_SCENARIOS.length).map((l) => l.replace(/ \/\S*\/app-58/, " "))).toEqual(
      ALL_SCENARIOS.map((s) => `ios expo-updates 58 ${s}: fail: not run: ${noApp}`),
    );
    expect(result.stderr).toContain("** BUILD FAILED **");
    // Each build runs in its app dir, for the simulator's own architecture and without signing.
    expect(
      readFileSync(buildLog, "utf8")
        .trimEnd()
        .split("\n")
        .map((line) => line.replace(/\/\S*\/(app-\d+)\b/g, "$1")),
    ).toEqual(
      ["55", "58"].map((v) =>
        [
          `app-${v} build -workspace app-${v}/ios/App.xcworkspace -scheme App`,
          `-configuration Release -destination id=A1 -derivedDataPath app-${v}/derived`,
          "ONLY_ACTIVE_ARCH=YES CODE_SIGNING_ALLOWED=NO",
        ].join(" "),
      ),
    );
    expect(fake.state().simulators[0]?.state).toBe("Booted");
    expect(fake.calls().filter(([c]) => c === "boot" || c === "shutdown")).toEqual([]);
    expect(fake.stream().ended).toBe(true);
    expect(result.tmpEntries).toEqual([]);
  });
});
