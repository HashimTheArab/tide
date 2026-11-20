import { beforeEach, expect, test } from "vitest";

import { NO_UPDATE_KEY, replyKey } from "@tide/protocol";

import type { ManifestPoint } from "../../src/core/analytics.ts";
import type { Harness } from "./server-cases.ts";
import { fixture } from "./fixtures.ts";

export type Fault = "throw" | "hang";

/** One runtime's app with an analytics sink the test observes. */
export interface AnalyticsHarness extends Pick<Harness, "request" | "put" | "putFault"> {
  /** Returns the points written from now until the test ends; with `fault`, each write then fails that way. Once per test. */
  capture(fault?: Fault): () => readonly ManifestPoint[];
}

/** Returns a write that throws, or returns a promise that never settles. */
export function faultySink(fault: Fault): () => unknown {
  switch (fault) {
    case "throw":
      return () => {
        throw new Error("sink failed");
      };
    case "hang":
      return () => new Promise<never>(() => undefined);
  }
}

const RUNTIME = "1.0.0";
const UPDATE_ID = "0f6a9a3e-6c1b-4c4e-9d55-2b8f3f7c1a90"; // manifest.json's id
const EMBEDDED_ID = "6e0c1b9a-3f7d-4a2e-8b5c-9d1e2f3a4b5c";
const ID = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
const encoder = new TextEncoder();

/** Asserts Workers Analytics Engine's per-point limits. */
function expectWithinLimits(point: ManifestPoint) {
  expect(point.indexes).toHaveLength(1);
  expect(encoder.encode(point.indexes[0]).length).toBeLessThanOrEqual(96);
  expect(point.blobs.length).toBeLessThanOrEqual(20);
  expect(point.doubles.length).toBeLessThanOrEqual(20);
  const blobBytes = point.blobs.reduce((n, b) => n + encoder.encode(b).length, 0);
  expect(blobBytes).toBeLessThanOrEqual(16 * 1024);
}

/** Registers the `/manifest` analytics tests every runtime must pass. */
export function analyticsCases(harness: AnalyticsHarness): void {
  const MANIFEST = fixture("manifest.reply.json");
  const ROLLBACK = fixture("rollback.reply.json");

  /** Sends a stock iOS request for `channel`; an undefined value drops that header. */
  const get = async (channel: string, change: Record<string, string | undefined> = {}) => {
    const all: Record<string, string | undefined> = {
      accept: "multipart/mixed,application/expo+json,application/json",
      "expo-protocol-version": "1",
      "expo-platform": "ios",
      "expo-runtime-version": RUNTIME,
      "expo-channel-name": channel,
      ...change,
    };
    const headers = Object.fromEntries(
      Object.entries(all).filter((e): e is [string, string] => e[1] !== undefined),
    );
    const res = await harness.request("/manifest", headers);
    return { res, body: new Uint8Array(await res.arrayBuffer()) };
  };
  const pointer = (channel: string, record: Uint8Array<ArrayBuffer>, platform = "ios") =>
    harness.put(replyKey(channel, RUNTIME, platform), record);
  /** Returns the one point `send` records. */
  const onePoint = async (send: () => Promise<unknown>) => {
    const points = harness.capture();
    await send();
    expect(points()).toHaveLength(1);
    const [point] = points();
    if (point === undefined) throw new Error("no point");
    expectWithinLimits(point);
    return point;
  };

  beforeEach(async () => {
    await harness.put(NO_UPDATE_KEY, fixture("no-update.reply.json"));
  });

  test("a served manifest records one point in the documented layout", async () => {
    await pointer("an-manifest", MANIFEST);
    const point = await onePoint(() =>
      get("an-manifest", {
        "expo-current-update-id": EMBEDDED_ID,
        "expo-embedded-update-id": EMBEDDED_ID,
        "expo-recent-failed-update-ids": `"${ID(1)}", "${ID(2)}"`,
        "expo-fatal-error": "TypeError: undefined is not a function",
      }),
    );
    expect(point).toEqual({
      indexes: ["an-manifest"],
      blobs: ["manifest", "ios", RUNTIME, EMBEDDED_ID, EMBEDDED_ID, `${ID(1)},${ID(2)}`],
      doubles: [1],
    });
  });

  test("a served rollback records its kind and the platform", async () => {
    await pointer("an-rollback", ROLLBACK, "android");
    const point = await onePoint(() => get("an-rollback", { "expo-platform": "android" }));
    expect(point).toEqual({
      indexes: ["an-rollback"],
      blobs: ["rollBackToEmbedded", "android", RUNTIME, "", "", ""],
      doubles: [0],
    });
  });

  test.each<[string, string | undefined]>([
    ["no pointer", undefined],
    ["a client running the pointer's update", UPDATE_ID],
  ])("no-update for %s records noUpdateAvailable", async (_, current) => {
    const channel = current === undefined ? "an-no-pointer" : "an-current";
    if (current !== undefined) await pointer(channel, MANIFEST);
    const point = await onePoint(() => get(channel, { "expo-current-update-id": current }));
    expect(point).toEqual({
      indexes: [channel],
      blobs: ["noUpdateAvailable", "ios", RUNTIME, current ?? "", "", ""],
      doubles: [0],
    });
  });

  test("a 503 records one point with reply 503", async () => {
    await harness.putFault(replyKey("an-fault", RUNTIME, "ios"));
    let status = 0;
    const point = await onePoint(async () => {
      status = (await get("an-fault")).res.status;
    });
    expect(status).toBe(503);
    expect(point).toEqual({
      indexes: ["an-fault"],
      blobs: ["503", "ios", RUNTIME, "", "", ""],
      doubles: [0],
    });
  });

  // They are answered before the reply decision, so they record nothing.
  test.each<[number, Record<string, string | undefined>]>([
    [400, { "expo-platform": "web" }],
    [400, { "expo-app-id": "other-app" }],
    [400, { "expo-channel-name": undefined }],
    [400, { "expo-runtime-version": "../x" }],
    [406, { "expo-protocol-version": "2" }],
    [406, { accept: "application/json" }],
  ])("a %i for %j records no point", async (status, change) => {
    await pointer("an-rejected", MANIFEST);
    const points = harness.capture();
    expect((await get("an-rejected", change)).res.status).toBe(status);
    expect(points()).toEqual([]);
  });

  const many = Array.from({ length: 200 }, (_, i) => `"${ID(i + 1)}"`).join(", ");
  test.each<[string, Record<string, string>, [string, string, string]]>([
    ["uppercase IDs", { current: UPDATE_ID.toUpperCase() }, [UPDATE_ID, "", ""]],
    ["a non-UUID ID", { current: "not-a-uuid", embedded: `${EMBEDDED_ID}0` }, ["", "", ""]],
    ["an oversized ID", { current: "a".repeat(8000) }, ["", "", ""]],
    ["a non-ASCII ID", { embedded: `${EMBEDDED_ID.slice(0, -1)}é` }, ["", "", ""]],
    ["a repeated ID", { current: `${UPDATE_ID}, ${EMBEDDED_ID}` }, ["", "", ""]],
    ["uppercase failed IDs", { failed: `"${UPDATE_ID.toUpperCase()}"` }, ["", "", UPDATE_ID]],
    [
      "200 failed IDs in 8 KB, of which the first 5 are kept",
      { failed: many },
      ["", "", [1, 2, 3, 4, 5].map(ID).join(",")],
    ],
    [
      "failed IDs with members that are not quoted UUIDs, which are dropped",
      {
        failed: [
          ID(1),
          '"not-a-uuid"',
          `"${ID(2)}";a=1`,
          `"${ID(3).slice(0, -1)}é"`,
          `"${ID(4)}0"`,
          `"${ID(5)}"`,
          `("${ID(6)}")`,
        ].join(", "),
      },
      ["", "", ID(5)],
    ],
    ["an oversized failed list with no UUID", { failed: "x".repeat(8000) }, ["", "", ""]],
  ])("%s are bounded", async (_, values, blobs) => {
    await pointer("an-bounds", MANIFEST);
    const point = await onePoint(() =>
      get("an-bounds", {
        "expo-current-update-id": values.current,
        "expo-embedded-update-id": values.embedded,
        "expo-recent-failed-update-ids": values.failed,
      }),
    );
    expect(point.blobs.slice(3)).toEqual(blobs);
  });

  test("an oversized fatal error records only the flag", async () => {
    await pointer("an-fatal", MANIFEST);
    const point = await onePoint(() =>
      get("an-fatal", { "expo-fatal-error": `Error: ${"x".repeat(8000)}` }),
    );
    expect(point.doubles).toEqual([1]);
    expect(point.blobs.join("")).not.toContain("Error");
  });

  /** A reply as bytes: status, every header but `date`, which marks when it was sent, and the body. */
  const reply = async (channel: string) => {
    const { res, body } = await get(channel, { "expo-current-update-id": EMBEDDED_ID });
    const headers = [...res.headers].filter(([name]) => name !== "date");
    return { status: res.status, headers, body };
  };

  test.each<Fault>(["throw", "hang"])(
    "a sink that %ss leaves 200 and 503 replies byte-identical",
    async (fault) => {
      await pointer("an-sink-ok", MANIFEST);
      await harness.putFault(replyKey("an-sink-503", RUNTIME, "ios"));
      const expected = [await reply("an-sink-ok"), await reply("an-sink-503")];
      expect(expected.map((r) => r.status)).toEqual([200, 503]);
      expect(expected[0]?.body).toEqual(fixture("manifest.multipart"));

      const points = harness.capture(fault);
      expect([await reply("an-sink-ok"), await reply("an-sink-503")]).toEqual(expected);
      expect(points().map((p) => p.blobs[0])).toEqual(["manifest", "503"]);
    },
  );
}
