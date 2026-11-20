import { SELF, env } from "cloudflare:test";
import { expect, inject, onTestFinished, test, vi } from "vitest";

declare module "vitest" {
  export interface ProvidedContext {
    fixtures: { noUpdateReply: number[]; noUpdateMultipart: number[] };
    appId: string; // This environment's TIDE_APP_ID.
  }
}

const fixtures = inject("fixtures");
const manifest = (appId: string) =>
  SELF.fetch("https://tide.test/manifest", {
    headers: {
      "expo-platform": "ios",
      "expo-app-id": appId,
      "expo-channel-name": "main",
      "expo-runtime-version": "1",
      "expo-protocol-version": "1",
      accept: "multipart/mixed",
    },
  });

test("/hc answers through the re-exported entry", async () => {
  const res = await SELF.fetch("https://tide.test/hc");
  expect(res.status).toBe(200);
  expect(await res.text()).toBe("ok");
});

test("/manifest serves the environment's bucket and records one point through its dataset", async () => {
  await env.BUCKET.put("reply/no-update", new Uint8Array(fixtures.noUpdateReply));
  const spy = vi.spyOn(env.ANALYTICS, "writeDataPoint");
  onTestFinished(() => {
    spy.mockRestore();
  });
  const res = await manifest(inject("appId"));
  expect(res.status).toBe(200);
  expect(new Uint8Array(await res.arrayBuffer())).toEqual(
    new Uint8Array(fixtures.noUpdateMultipart),
  );
  expect(spy.mock.calls.map(([point]) => point)).toEqual([
    { indexes: ["main"], blobs: ["noUpdateAvailable", "ios", "1", "", "", ""], doubles: [0] },
  ]);
});

test("/manifest refuses another environment's app ID", async () => {
  const res = await manifest("example-app-other");
  expect(res.status).toBe(400);
  expect(await res.text()).toBe("expo-app-id does not match this server\n");
});
