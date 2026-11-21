import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, onTestFinished, test } from "vitest";

import { EXPO_VERSIONS, SCENARIOS, USAGE, parseRun } from "../src/options.ts";

const MAIN = fileURLToPath(new URL("../src/main.ts", import.meta.url));
const ALL_SCENARIOS = Object.keys(SCENARIOS);

/** Runs the conformance bin with `TMPDIR` set to a fresh empty directory, which it returns too. */
async function conformance(args: string[]) {
  const tmp = mkdtempSync(join(tmpdir(), "tide-conformance-test-"));
  onTestFinished(() => rmSync(tmp, { recursive: true, force: true }));
  const proc = spawn(process.execPath, [MAIN, ...args], {
    env: { PATH: process.env.PATH ?? "", TMPDIR: tmp },
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
    [
      ["--platform", "android"],
      "no full, patch-ota, corrupt-patch, rollback, patch-embedded scenario exists yet",
    ],
    [["--platform", "android", "--scenario", "full"], "no full scenario exists yet"],
    [["--platform", "ios", "--scenario", "embedded"], "no ios device driver exists yet"],
  ])("%j exits 1 before creating anything: %s", async (args, message) => {
    const result = await conformance(args);
    expect(result).toMatchObject({ code: 1, stdout: "", tmpEntries: [] });
    expect(result.stderr).toMatch(new RegExp(`^conformance: ${message}`));
  });
});
