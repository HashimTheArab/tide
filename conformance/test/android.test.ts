import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, onTestFinished, test } from "vitest";

import { androidDevice, parseDevices, parseReport } from "../src/android.ts";
import { withStack } from "../src/stack.ts";

const FAKE = fileURLToPath(new URL("fake-android.ts", import.meta.url));
const PKG = "dev.tide.conformance.sdk55";
const running = (r: string, marker: string) =>
  `tide-conformance ${JSON.stringify({ event: "running", marker, updateId: r, embedded: true })}`;

interface FakeState {
  running: Record<string, { pid?: number; avd?: string }>;
  installed: string[];
  reverse: string[];
}

/** Writes a fake SDK, removed when the test ends, whose adb and emulator are fake-android.ts over `state`. */
function fakeSdk(state: Partial<FakeState>, avds: string[] = ["Pixel", "Tablet"]) {
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

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const emulatorStarts = (calls: string[][]) =>
  calls.filter(([tool, first]) => tool === "emulator" && first !== "-list-avds");

describe("the Android device driver", () => {
  test("uses the running emulator, maps the Tide port and leaves the emulator running", async () => {
    const fake = fakeSdk({ running: { "emulator-5560": {} } });
    await withStack(async (stack) => {
      const device = await androidDevice(stack, {
        sdk: fake.sdk,
        serial: undefined,
        avd: undefined,
      });
      expect(device).toMatchObject({ serial: "emulator-5560", abi: "x86_64", booted: false });
      await device.reverse(4321);
      expect(fake.state().reverse).toEqual(["tcp:4321"]);
    });
    expect(fake.state()).toMatchObject({ running: { "emulator-5560": {} }, reverse: [] });
    expect(emulatorStarts(fake.calls())).toEqual([]);
    expect(fake.calls().filter((c) => c.includes("emu"))).toEqual([]);
  });

  test.each([
    ["the first AVD", undefined, "Pixel"],
    ["the AVD --avd names", "Tablet", "Tablet"],
  ])(
    "boots %s read-only when no emulator runs, and shuts it down on close",
    async (_, avd, name) => {
      const fake = fakeSdk({});
      let pid = 0;
      let serial = "";
      await withStack(async (stack) => {
        const device = await androidDevice(stack, { sdk: fake.sdk, serial: undefined, avd });
        serial = device.serial;
        expect(device.booted).toBe(true);
        const [start] = emulatorStarts(fake.calls());
        const port = device.serial.slice("emulator-".length);
        expect(start).toEqual([
          "emulator",
          ...["-avd", name, "-port", port, "-read-only", "-no-snapshot"],
          ...["-no-window", "-no-audio", "-no-boot-anim"],
        ]);
        pid = fake.state().running[device.serial]?.pid ?? 0;
        expect(alive(pid)).toBe(true);
      });
      expect(fake.calls().at(-1)).toEqual(["adb", "-s", serial, "emu", "kill"]);
      expect(fake.state().running).toEqual({});
      expect(alive(pid)).toBe(false);
    },
  );

  test("shuts down the emulator it booted when the run fails", async () => {
    const fake = fakeSdk({});
    let pid = 0;
    await expect(
      withStack(async (stack) => {
        const device = await androidDevice(stack, {
          sdk: fake.sdk,
          serial: undefined,
          avd: undefined,
        });
        pid = fake.state().running[device.serial]?.pid ?? 0;
        expect(alive(pid)).toBe(true);
        throw new Error("scenario failed");
      }),
    ).rejects.toThrow("scenario failed");
    expect(pid).not.toBe(0);
    expect(alive(pid)).toBe(false);
  });

  test("fails at once, leaving no adb wait behind, when the emulator it boots exits before registering", async () => {
    const fake = fakeSdk({}, ["Crash"]);
    const failed = withStack((stack) =>
      androidDevice(stack, { sdk: fake.sdk, serial: undefined, avd: undefined }),
    );
    await expect(failed).rejects.toThrow(
      "exited while booting:\nx86_64 emulation currently requires hardware acceleration",
    );
    const wait = Number(readFileSync(join(fake.sdk, "wait.pid"), "utf8"));
    onTestFinished(() => {
      if (wait > 0 && alive(wait)) process.kill(wait, "SIGKILL");
    });
    expect(Number.isInteger(wait) && wait > 0).toBe(true);
    expect(alive(wait)).toBe(false);
  });

  test("refuses an AVD that does not exist, and boots nothing", async () => {
    await withStack(async (stack) => {
      const fake = fakeSdk({});
      await expect(
        androidDevice(stack, { sdk: fake.sdk, serial: undefined, avd: "Missing" }),
      ).rejects.toThrow("no AVD is named Missing; found Pixel, Tablet");
      await expect(
        androidDevice(stack, { sdk: fakeSdk({}, []).sdk, serial: undefined, avd: undefined }),
      ).rejects.toThrow("no emulator is running and no AVD exists");
      expect(emulatorStarts(fake.calls())).toEqual([]);
    });
  });

  test("needs ANDROID_SERIAL to pick one of several running emulators", async () => {
    await withStack(async (stack) => {
      const fake = fakeSdk({ running: { "emulator-5554": {}, "emulator-5556": {} } });
      const options = { sdk: fake.sdk, avd: undefined };
      await expect(androidDevice(stack, { ...options, serial: undefined })).rejects.toThrow(
        "2 emulators are running: set ANDROID_SERIAL to pick one",
      );
      await expect(androidDevice(stack, { ...options, serial: "emulator-5558" })).rejects.toThrow(
        "ANDROID_SERIAL emulator-5558 is not an attached device",
      );
      const device = await androidDevice(stack, { ...options, serial: "emulator-5556" });
      expect(device.serial).toBe("emulator-5556");
    });
  });

  test("installs fresh, launches, and reads the app's reports in order until the deadline", async () => {
    await withStack(async (stack) => {
      const fake = fakeSdk({ running: { "emulator-5554": {} }, installed: [PKG] });
      const apk = join(stack.dir, "app.apk");
      writeFileSync(apk, PKG);
      const device = await androidDevice(stack, {
        sdk: fake.sdk,
        serial: undefined,
        avd: undefined,
      });
      await device.install(apk, PKG);
      // logcat starts beside these calls, so its own call may land anywhere among them.
      const calls = fake
        .calls()
        .map((c) => c.slice(3).join(" "))
        .filter((c) => !c.startsWith("logcat "));
      expect(calls.slice(calls.indexOf(`shell pm list packages ${PKG}`))).toEqual([
        `shell pm list packages ${PKG}`,
        `uninstall ${PKG}`,
        `install ${apk}`,
      ]);
      fake.appLogs([
        running("u1", "m1"),
        "an unrelated line",
        'tide-conformance {"event":"check","marker":"m1","result":"none"}',
      ]);
      await device.launch(PKG);
      expect(await device.nextReport()).toEqual({
        event: "running",
        marker: "m1",
        updateId: "u1",
        embedded: true,
      });
      expect(await device.nextReport()).toEqual({ event: "check", marker: "m1", result: "none" });
      await expect(device.nextReport(200)).rejects.toThrow(
        "the app logged no report within 200 ms",
      );
      await expect(device.launch("dev.other")).rejects.toThrow("launching dev.other failed");
    });
  });
});

describe("adb output", () => {
  test("parseDevices reads each serial and state", () => {
    const out = "List of devices attached\nemulator-5554\tdevice\nemulator-5556\toffline\n\n";
    expect([...parseDevices(out)]).toEqual([
      ["emulator-5554", "device"],
      ["emulator-5556", "offline"],
    ]);
  });

  test.each([
    ['tide-conformance {"event":"check","marker":"m","result":"none"}', true],
    ['I ReactNativeJS: tide-conformance {"event":"check","marker":"m"}', true],
    ["tide-conformance not json", false],
    ['tide-conformance {"event":"check"}', false],
    ['tide-conformance ["event"]', false],
    ["Running application main", false],
  ])("parseReport(%j) finds a report: %s", (line, found) => {
    expect(parseReport(line) !== undefined).toBe(found);
  });
});
