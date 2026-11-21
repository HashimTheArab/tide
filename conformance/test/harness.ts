// Fixtures the harness tests share: what `tide export` writes without running Expo, and fake Android and iOS tools.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { open } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { onTestFinished } from "vitest";

import { contentKey, sha256Base64Url } from "@tide/protocol";

import type { Platform } from "../src/options.ts";
import type { Stack } from "../src/stack.ts";
import { EXPORT_FILE, encodeProjectExport } from "../../packages/cli/src/publish-export.ts";

const FAKE = fileURLToPath(new URL("fake-android.ts", import.meta.url));
const FAKE_IOS = fileURLToPath(new URL("fake-ios.ts", import.meta.url));
export const FIXTURE_EXPORT = fileURLToPath(
  new URL("../../packages/cli/test/fixtures/export", import.meta.url),
);
export const ANDROID_BUNDLE = "dist/_expo/static/js/android/index-android.hbc";
const BUNDLES: Record<Platform, string> = {
  android: ANDROID_BUNDLE,
  ios: "dist/_expo/static/js/ios/index-ios.hbc",
};
export const MAIN = { channel: "main", runtimeVersion: "1.0.0" } as const;
export const ANDROID = { ...MAIN, platform: "android" } as const;

export const signingMetadata = (stack: Stack) => ({
  keyid: stack.identity.keyId,
  alg: "rsa-v1_5-sha256" as const,
});

/**
 * Writes at `<stack>/<name>` what `tide export` writes for the CLI tests' fixture export of `platform` under the run's
 * identity, without running Expo; `bundle` replaces the platform's launch bundle.
 */
export function fixtureExport(
  stack: Stack,
  name: string,
  bundle?: Uint8Array,
  platform: Platform = "android",
): string {
  const out = join(stack.dir, name);
  cpSync(FIXTURE_EXPORT, join(out, "dist"), { recursive: true });
  if (bundle !== undefined) writeFileSync(join(out, BUNDLES[platform]), bundle);
  const value = {
    certificate: readFileSync(stack.identity.certificateFile, "utf8"),
    codeSigningMetadata: signingMetadata(stack),
    expoClient: { name: "Conformance", slug: "conformance", version: "1.0.0" },
    platforms: { [platform]: { runtimeVersion: MAIN.runtimeVersion } },
  };
  writeFileSync(join(out, EXPORT_FILE), encodeProjectExport(value));
  return out;
}

export const sha256Hex = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
export const hexOf = async (bytes: Uint8Array) =>
  contentKey(await sha256Base64Url(new Uint8Array(bytes)));

interface FakeState {
  running: Record<string, { pid?: number; avd?: string }>;
  installed: string[];
  reverse: string[];
}

/** Writes a fake SDK, removed when the test ends, whose adb and emulator are fake-android.ts over `state`. */
export function fakeSdk(state: Partial<FakeState>, avds: string[] = ["Pixel", "Tablet"]) {
  const sdk = mkdtempSync(join(tmpdir(), "tide-fake-sdk-"));
  onTestFinished(() => rmSync(sdk, { recursive: true, force: true }));
  for (const [dir, tool] of [
    ["platform-tools", "adb"],
    ["emulator", "emulator"],
  ] as const) {
    mkdirSync(join(sdk, dir), { recursive: true });
    const path = join(sdk, dir, tool);
    writeFileSync(path, `#!/bin/sh\nexec '${process.execPath}' '${FAKE}' ${tool} '${sdk}' "$@"\n`);
    chmodSync(path, 0o755);
  }
  writeFileSync(
    join(sdk, "state.json"),
    JSON.stringify({ running: {}, installed: [], reverse: [], ...state }),
  );
  writeFileSync(join(sdk, "avds.txt"), avds.map((a) => `${a}\n`).join(""));
  writeFileSync(join(sdk, "calls.log"), "");
  return {
    sdk,
    state: () => JSON.parse(readFileSync(join(sdk, "state.json"), "utf8")) as FakeState,
    calls: () =>
      readFileSync(join(sdk, "calls.log"), "utf8")
        .trimEnd()
        .split("\n")
        .map((l) => JSON.parse(l) as string[]),
    /** Sets the lines the app logs on each launch. */
    appLogs: (lines: string[]) =>
      writeFileSync(join(sdk, "app.log"), lines.map((l) => `${l}\n`).join("")),
  };
}

interface FakeSimulator {
  udid: string;
  name: string;
  state: "Booted" | "Shutdown" | "Booting";
  runtime?: string; // An iOS runtime unless named.
  isAvailable?: boolean;
}

interface FakeXcrunState {
  simulators: Required<FakeSimulator>[];
  installed: Record<string, string[]>;
  running: string[];
}

/** Writes a fake `bin/xcrun`, removed when the test ends, that is fake-ios.ts over `simulators`. */
export function fakeXcrun(simulators: FakeSimulator[]) {
  const dir = mkdtempSync(join(tmpdir(), "tide-fake-xcrun-"));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  const xcrun = join(dir, "bin", "xcrun");
  mkdirSync(join(dir, "bin"));
  writeFileSync(xcrun, `#!/bin/sh\nexec '${process.execPath}' '${FAKE_IOS}' '${dir}' "$@"\n`);
  chmodSync(xcrun, 0o755);
  const state: FakeXcrunState = {
    simulators: simulators.map((s) => ({
      runtime: "com.apple.CoreSimulator.SimRuntime.iOS-26-5",
      isAvailable: true,
      ...s,
    })),
    installed: {},
    running: [],
  };
  writeFileSync(join(dir, "state.json"), JSON.stringify(state));
  writeFileSync(join(dir, "calls.log"), "");
  writeFileSync(join(dir, "app.log"), "");
  const text = (name: string) => readFileSync(join(dir, name), "utf8");
  return {
    dir,
    xcrun,
    state: () => JSON.parse(text("state.json")) as FakeXcrunState,
    /** Each call's arguments after `simctl`. */
    calls: () =>
      text("calls.log")
        .trimEnd()
        .split("\n")
        .filter((l) => l !== "")
        .map((l) => (JSON.parse(l) as string[]).slice(1)),
    /** Sets the lines the app logs on each launch. */
    appLogs: (lines: string[]) =>
      writeFileSync(join(dir, "app.log"), lines.map((l) => `${l}\n`).join("")),
    /**
     * Holds the next `command` before it reads or changes state; resolves once it is held, with its PID and a release.
     * A test that leaves a held command unreleased fails, since Node rejects a FileHandle closed by GC.
     */
    hold(command: string) {
      const fifo = join(dir, `hold-${command}`);
      execFileSync("mkfifo", [fifo]);
      let state: "waiting" | "held" | "released" = "waiting";
      const opened = open(fifo, "w");
      onTestFinished(async () => {
        const held = state === "held";
        // Opening the read end frees an open still waiting for a fake that never came.
        if (state === "waiting")
          closeSync(openSync(fifo, constants.O_RDONLY | constants.O_NONBLOCK));
        if (state !== "released") await (await opened).close();
        if (held) throw new Error(`the test never released hold-${command}`);
      });
      return opened.then((handle) => {
        state = "held";
        return {
          pid: Number(text(`${command}.pid`)),
          release: () => {
            state = "released";
            return handle.close();
          },
        };
      });
    },
    /** The log stream's PID, and whether SIGTERM ended it. */
    stream: () => ({
      pid: Number(text("stream.pid")),
      ended: existsSync(join(dir, "stream.ended")),
    }),
  };
}
