import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

import { iosDevice, parseSimulators } from "../src/ios.ts";
import { withStack } from "../src/stack.ts";
import { fakeXcrun } from "./harness.ts";

const APP = "dev.tide.conformance.sdk58";
const PHONE = { udid: "A1", name: "iPhone", state: "Shutdown" } as const;
const TABLET = { udid: "B2", name: "iPad", state: "Shutdown" } as const;
const report = (event: string, marker: string) =>
  `2026-11-21 23:16:07.064 I  App[1:2] [com.facebook.react.log:javascript] tide-conformance ${JSON.stringify({ event, marker })}`;

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
// What the driver may ask of simctl; anything else, such as create, erase or delete, fails the test.
const ALLOWED = new Set([
  "list",
  "boot",
  "bootstatus",
  "shutdown",
  "spawn",
  "install",
  "uninstall",
  "launch",
  "terminate",
]);
const lifecycle = (calls: string[][]) =>
  calls.filter(([c]) => c === "boot" || c === "bootstatus" || c === "shutdown");

describe("the iOS device driver", () => {
  test("uses the booted simulator and leaves it booted", async () => {
    const fake = fakeXcrun([PHONE, { ...TABLET, state: "Booted" }]);
    await withStack(async (stack) => {
      const device = await iosDevice(stack, { xcrun: fake.xcrun, simulator: undefined });
      expect(device).toMatchObject({ udid: "B2", name: "iPad", booted: false });
    });
    expect(fake.state().simulators.map((s) => s.state)).toEqual(["Shutdown", "Booted"]);
    expect(lifecycle(fake.calls())).toEqual([]);
    expect(fake.calls().filter(([c = ""]) => !ALLOWED.has(c))).toEqual([]);
  });

  test.each([
    ["the first listed simulator", undefined, "A1"],
    ["the simulator --simulator names", "iPad", "B2"],
    ["the simulator --simulator gives the UDID of", "B2", "B2"],
  ])("boots %s when none is booted, and shuts it down on close", async (_, simulator, udid) => {
    const fake = fakeXcrun([
      { udid: "W1", name: "Watch", state: "Shutdown", runtime: "x.SimRuntime.watchOS-26-5" },
      PHONE,
      TABLET,
    ]);
    await withStack(async (stack) => {
      const device = await iosDevice(stack, { xcrun: fake.xcrun, simulator });
      expect(device).toMatchObject({ udid, booted: true });
      expect(fake.state().simulators.find((s) => s.udid === udid)?.state).toBe("Booted");
    });
    expect(lifecycle(fake.calls())).toEqual([
      ["boot", udid],
      ["bootstatus", udid],
      ["shutdown", udid],
    ]);
    expect(fake.state().simulators.map((s) => s.state)).toEqual([
      "Shutdown",
      "Shutdown",
      "Shutdown",
    ]);
    expect(fake.calls().filter(([c = ""]) => !ALLOWED.has(c))).toEqual([]);
  });

  test("shuts down the simulator it booted when the run fails", async () => {
    const fake = fakeXcrun([PHONE]);
    await expect(
      withStack(async (stack) => {
        await iosDevice(stack, { xcrun: fake.xcrun, simulator: undefined });
        throw new Error("scenario failed");
      }),
    ).rejects.toThrow("scenario failed");
    expect(fake.calls().at(-1)).toEqual(["shutdown", "A1"]);
    expect(fake.state().simulators[0]?.state).toBe("Shutdown");
  });

  test("waits for a boot still running on close, then shuts the simulator down", async () => {
    const fake = fakeXcrun([PHONE]);
    const booting = fake.hold("boot");
    await withStack(async (stack) => {
      // Close refuses its readiness wait once the boot finishes.
      const device = iosDevice(stack, { xcrun: fake.xcrun, simulator: undefined }).catch(
        (e: unknown) => e,
      );
      const { release } = await booting;
      const closing = stack.close();
      await release();
      await closing;
      expect(await device).toBeInstanceOf(Error);
    });
    expect(lifecycle(fake.calls())).toEqual([
      ["boot", "A1"],
      ["shutdown", "A1"],
    ]);
    expect(fake.state().simulators[0]?.state).toBe("Shutdown");
    expect(fake.calls().filter(([c]) => c === "spawn")).toEqual([]);
  });

  test("ends a readiness wait still running on close, then shuts the simulator down", async () => {
    const fake = fakeXcrun([PHONE]);
    const waiting = fake.hold("bootstatus");
    await withStack(async (stack) => {
      const device = iosDevice(stack, { xcrun: fake.xcrun, simulator: undefined }).catch(
        (e: unknown) => e,
      );
      const { pid, release } = await waiting;
      try {
        await stack.close();
        expect(alive(pid)).toBe(false);
      } finally {
        await release();
      }
      expect(await device).toMatchObject({
        message: "xcrun simctl bootstatus A1 failed: was cancelled",
      });
    });
    expect(lifecycle(fake.calls())).toEqual([
      ["boot", "A1"],
      ["bootstatus", "A1"],
      ["shutdown", "A1"],
    ]);
    expect(fake.state().simulators[0]?.state).toBe("Shutdown");
  });

  test("shuts down after a killed boot, which CoreSimulator may finish", async () => {
    const fake = fakeXcrun([PHONE]);
    const booting = fake.hold("boot");
    await withStack(async (stack) => {
      const device = iosDevice(stack, { xcrun: fake.xcrun, simulator: undefined });
      const { pid, release } = await booting;
      process.kill(pid, "SIGKILL");
      await expect(device).rejects.toThrow("simctl boot A1 failed");
      await release();
    });
    // This boot never reached the fake's state, so the shutdown finds it shut down, which is no error.
    expect(lifecycle(fake.calls())).toEqual([
      ["boot", "A1"],
      ["shutdown", "A1"],
    ]);
    expect(fake.state().simulators[0]?.state).toBe("Shutdown");
  });

  test("shuts down nothing after simctl refuses the boot", async () => {
    const fake = fakeXcrun([{ udid: "A1", name: "NoBoot", state: "Shutdown" }]);
    await withStack(async (stack) => {
      await expect(iosDevice(stack, { xcrun: fake.xcrun, simulator: undefined })).rejects.toThrow(
        "Unable to boot device in current state: Booted",
      );
    });
    expect(lifecycle(fake.calls())).toEqual([["boot", "A1"]]);
  });

  test("waits for an install still running on close, then removes the app", async () => {
    const fake = fakeXcrun([{ ...PHONE, state: "Booted" }]);
    const app = join(fake.dir, "App.app");
    writeFileSync(app, APP);
    const installing = fake.hold("install");
    await withStack(async (stack) => {
      const device = await iosDevice(stack, { xcrun: fake.xcrun, simulator: undefined });
      const install = device.install(app, APP);
      const { release } = await installing;
      const streamEnded = device.nextReport().catch((e: unknown) => e);
      const closing = stack.close();
      // Close ends the log stream before it removes apps, so this install finishes during close.
      expect(await streamEnded).toEqual(new Error("simctl log stream ended"));
      await release();
      await closing;
      await install;
      await expect(device.install(app, APP)).rejects.toThrow("the stack is closed");
    });
    expect(fake.calls().at(-1)).toEqual(["uninstall", "A1", APP]);
    expect(fake.state().installed).toEqual({ A1: [] });
  });

  test("removes every other app on close when one uninstall fails", async () => {
    const fake = fakeXcrun([{ ...PHONE, state: "Booted" }]);
    const app = join(fake.dir, "App.app");
    writeFileSync(app, APP);
    await expect(
      withStack(async (stack) => {
        const device = await iosDevice(stack, { xcrun: fake.xcrun, simulator: undefined });
        await expect(device.install(app, "NoUninstall")).rejects.toThrow(
          "simctl uninstall A1 NoUninstall failed",
        );
        await device.install(app, APP);
      }),
    ).rejects.toThrow(
      /^the stack did not close cleanly: .*simctl uninstall A1 NoUninstall failed.*Failed to uninstall/s,
    );
    expect(fake.calls().filter(([c]) => c === "uninstall")).toEqual([
      ["uninstall", "A1", "NoUninstall"],
      ["uninstall", "A1", APP],
      ["uninstall", "A1", "NoUninstall"],
      ["uninstall", "A1", APP],
    ]);
    expect(fake.state().installed).toEqual({ A1: [] });
  });

  test.each([
    [[PHONE], "Missing", "no available iOS simulator is named Missing; found iPhone"],
    [
      [PHONE, { ...TABLET, name: "iPhone" }],
      "iPhone",
      "2 simulators are named iPhone: pass a UDID (A1, B2)",
    ],
    [
      [
        { ...PHONE, state: "Booted" },
        { ...TABLET, state: "Booted" },
      ],
      undefined,
      "2 simulators are booted: pass --simulator to pick one",
    ],
    [[{ ...PHONE, state: "Booting" }], undefined, "simulator iPhone is Booting"],
    [[{ ...PHONE, isAvailable: false }], undefined, "no iOS simulator is booted and none exists"],
  ] as const)("refuses %j with --simulator %s, and boots nothing", async (sims, simulator, why) => {
    const fake = fakeXcrun(sims.map((s) => ({ ...s })));
    await withStack(async (stack) => {
      await expect(iosDevice(stack, { xcrun: fake.xcrun, simulator })).rejects.toThrow(why);
    });
    expect(fake.calls()).toEqual([["list", "devices", "--json"]]);
  });

  test("fails when the log stream ends before it streams", async () => {
    const fake = fakeXcrun([{ udid: "N1", name: "NoLog", state: "Booted" }]);
    await withStack(async (stack) => {
      await expect(iosDevice(stack, { xcrun: fake.xcrun, simulator: undefined })).rejects.toThrow(
        "simctl log stream did not start: An error was encountered processing the command:\nlog: Could not open the log stream",
      );
    });
  });

  test("installs fresh, launches, reads the app's reports in order until the deadline, and removes the app on close", async () => {
    const fake = fakeXcrun([{ ...PHONE, state: "Booted" }]);
    let stream = { pid: 0, ended: false };
    await withStack(async (stack) => {
      const app = join(stack.dir, "App.app");
      writeFileSync(app, APP);
      const device = await iosDevice(stack, { xcrun: fake.xcrun, simulator: undefined });
      await device.install(app, APP);
      await device.install(app, APP);
      expect(fake.calls().filter(([c]) => c === "install" || c === "uninstall")).toEqual([
        ["uninstall", "A1", APP],
        ["install", "A1", app],
        ["uninstall", "A1", APP],
        ["install", "A1", app],
      ]);
      expect(fake.state().installed).toEqual({ A1: [APP] });
      fake.appLogs([report("running", "m1"), "an unrelated line", report("fetched", "m1")]);
      await device.launch(APP);
      expect(await device.nextReport()).toEqual({ event: "running", marker: "m1" });
      expect(await device.nextReport()).toEqual({ event: "fetched", marker: "m1" });
      await expect(device.nextReport(200)).rejects.toThrow(
        "the app logged no report within 200 ms",
      );
      await device.stop(APP);
      await device.stop(APP); // Nothing is running now.
      await expect(device.launch("dev.other")).rejects.toThrow(
        'simctl launch A1 dev.other failed: An error was encountered processing the command:\nThe request to open "dev.other" failed.',
      );
      stream = fake.stream();
      expect(alive(stream.pid)).toBe(true);
    });
    expect(fake.calls().at(-1)).toEqual(["uninstall", "A1", APP]);
    expect(fake.state()).toMatchObject({ installed: { A1: [] }, running: [] });
    expect(fake.state().simulators[0]?.state).toBe("Booted");
    // simctl forwards SIGTERM into the simulator; a SIGKILL would leave the stream running there.
    expect(stream.ended).toBe(false);
    expect(fake.stream().ended).toBe(true);
    expect(alive(stream.pid)).toBe(false);
  });
});

describe("simctl output", () => {
  test("parseSimulators keeps available iOS simulators in listed order", () => {
    const json = JSON.stringify({
      devices: {
        "com.apple.CoreSimulator.SimRuntime.watchOS-26-5": [
          { udid: "W", name: "Watch", state: "Booted", isAvailable: true },
        ],
        "com.apple.CoreSimulator.SimRuntime.iOS-26-5": [
          { udid: "A", name: "iPhone", state: "Shutdown", isAvailable: true, dataPath: "/x" },
          { udid: "B", name: "Old", state: "Shutdown", isAvailable: false },
        ],
        "com.apple.CoreSimulator.SimRuntime.iOS-18-6": [
          { udid: "C", name: "iPad", state: "Booted", isAvailable: true },
        ],
      },
    });
    expect(parseSimulators(json)).toEqual([
      { udid: "A", name: "iPhone", state: "Shutdown" },
      { udid: "C", name: "iPad", state: "Booted" },
    ]);
  });
});
