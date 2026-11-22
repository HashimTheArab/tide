import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { AddressInfo } from "node:net";
import { serve } from "@hono/node-server";
import { afterAll, beforeAll, describe, expect, onTestFinished, test } from "vitest";

import { NO_UPDATE_KEY, contentKey, diskPath, replyKey, sha256Base64Url } from "@tide-ota/protocol";

import type { AnalyticsSink, ManifestPoint } from "../../src/core/analytics.ts";
import type { Harness } from "../shared/server-cases.ts";
import { createApp } from "../../src/core/app.ts";
import { diskStore, startServer, storeFromEnv } from "../../src/node.ts";
import { analyticsCases, faultySink } from "../shared/analytics-cases.ts";
import { fixture } from "../shared/fixtures.ts";
import { bundleCases, manifestCases, serverCases } from "../shared/server-cases.ts";
import { runEntry } from "./entry.ts";

const HASH = "47DEQpj8HBSa-_TImW-5JCeuQeRkm5NMpJWZG3hSuFU";
const KEY = `assets/${contentKey(HASH)}`;

const cleanup: (() => unknown)[] = [];
afterAll(async () => {
  for (const run of cleanup.reverse()) await run();
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "tide-disk-"));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

/** Starts the Node entry's server over a disk store at `root` and returns its base URL. */
async function serveDisk(root: string, appId?: string): Promise<string> {
  const server = await startServer({ port: 0, store: diskStore(root), appId });
  cleanup.push(() => new Promise((resolve) => server.close(resolve)));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

/** Sends exactly `headers`: Node's fetch would add `accept: *\/*` when none is given. */
function exactRequest(url: string, headers: Readonly<Record<string, string>>): Promise<Response> {
  return new Promise((resolve, reject) => {
    request(url, { headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("error", reject);
      res.on("end", () => {
        const h = new Headers();
        for (const [k, v] of Object.entries(res.headers)) if (typeof v === "string") h.set(k, v);
        resolve(new Response(Buffer.concat(chunks), { status: res.statusCode ?? 0, headers: h }));
      });
    })
      .on("error", reject)
      .end();
  });
}

/** Writes `bytes` at a path under `root`, replacing a file or directory already there. */
async function replace(root: string, path: string, bytes?: Uint8Array): Promise<void> {
  await rm(join(root, path), { recursive: true, force: true });
  await mkdir(dirname(join(root, path)), { recursive: true });
  if (bytes === undefined) await mkdir(join(root, path));
  else await writeFile(join(root, path), bytes);
}

describe("node entry with a disk store", () => {
  const root = tempRoot();
  let base = "";
  beforeAll(async () => {
    base = await serveDisk(root, "tide-test");
  });

  const harness: Harness = {
    fetch: (path, init) => fetch(`${base}${path}`, init),
    request: (path, headers) => exactRequest(`${base}${path}`, headers),
    put: (key, bytes) => replace(root, diskPath(key), bytes),
    putRaw: (path, bytes) => replace(root, path, bytes),
    remove: (key) => rm(join(root, diskPath(key)), { recursive: true, force: true }),
    // A directory at the key: the adapter must not report it as absent or stream it.
    putFault: (key) => replace(root, diskPath(key)),
  };
  serverCases(harness);
  describe("/manifest", () => {
    manifestCases(harness);
  });
  describe("/bundles patch negotiation", () => {
    bundleCases(harness);
  });
});

// The Node entry records nothing; this proves the core sink contract on Node.
describe("node app with an analytics sink", () => {
  const root = tempRoot();
  let base = "";
  let sink: AnalyticsSink = () => undefined;
  beforeAll(async () => {
    const app = createApp(diskStore(root), { appId: "tide-test", analytics: (p) => sink(p) });
    const server = await new Promise<ReturnType<typeof serve>>((resolve) => {
      const s = serve({ fetch: app.fetch, port: 0 }, () => resolve(s));
    });
    cleanup.push(() => new Promise((resolve) => server.close(resolve)));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  analyticsCases({
    request: (path, headers) => exactRequest(`${base}${path}`, headers),
    put: (key, bytes) => replace(root, diskPath(key), bytes),
    putFault: (key) => replace(root, diskPath(key)),
    capture(fault) {
      const points: ManifestPoint[] = [];
      const fail = fault === undefined ? undefined : faultySink(fault);
      sink = (point) => {
        points.push(point);
        return fail?.();
      };
      onTestFinished(() => {
        sink = () => undefined;
      });
      return () => points;
    },
  });
});

test("a disk root removed after startup is a 503 that is not cached, and /hc still answers", async () => {
  const root = tempRoot();
  const base = await serveDisk(root);
  rmSync(root, { recursive: true });
  const res = await fetch(`${base}/assets?h=${HASH}`);
  expect(res.status).toBe(503);
  expect(res.headers.get("cache-control")).toBe("no-store");
  expect((await fetch(`${base}/hc`)).status).toBe(200);
});

describe("diskStore", () => {
  test("reads reply keys at their escaped paths", async () => {
    const root = tempRoot();
    const store = diskStore(root);
    const key = replyKey("Main", "1.0.0", "ios");
    await replace(root, diskPath(key), new Uint8Array([1]));
    await replace(root, NO_UPDATE_KEY, new Uint8Array([2]));
    for (const [k, byte] of [
      [key, 1],
      [NO_UPDATE_KEY, 2],
    ] as const) {
      const object = await store.get(k);
      expect(new Uint8Array(await new Response(object?.body).arrayBuffer())).toEqual(
        new Uint8Array([byte]),
      );
    }
    await expect(store.get(replyKey("main", "1.0.0", "ios"))).resolves.toBeUndefined();
  });

  test("rejects a missing root and a root that is a file", () => {
    const root = tempRoot();
    expect(() => diskStore(join(root, "missing"))).toThrow("is not a directory");
    writeFileSync(join(root, "file"), "x");
    expect(() => diskStore(join(root, "file"))).toThrow("is not a directory");
  });

  const hex = contentKey(HASH);
  test.each([
    ["a .. segment", `assets/../${hex}`],
    ["a leading /", `/${KEY}`],
    ["a backslash", `assets\\${hex}`],
    ["an empty segment", `assets//${hex}`],
    ["an unknown prefix", `secrets/${hex}`],
    ["uppercase hex", `assets/${hex.toUpperCase()}`],
    ["the empty key", ""],
    ["a reply key with ..", "reply/../x/ios"],
    ["a 65-character reply name", `reply/${"a".repeat(65)}/1/ios`],
    ["a reply key with five segments", "reply/a/b/ios/x"],
    ["an unknown platform", "reply/a/b/web"],
  ])("rejects %s without touching the disk", async (_, key) => {
    const root = tempRoot();
    const store = diskStore(root);
    // With the root gone, any disk access ends in "unavailable" instead of the grammar error.
    rmSync(root, { recursive: true });
    await expect(store.get(KEY)).rejects.toThrow(`disk store root ${root} unavailable`);
    await expect(store.get(key)).rejects.toThrow("invalid store key");
  });
});

test("a hostname binds the entry to that address only", async () => {
  const server = await startServer({
    port: 0,
    hostname: "127.0.0.1",
    store: diskStore(tempRoot()),
  });
  cleanup.push(() => new Promise((resolve) => server.close(resolve)));
  expect((server.address() as AddressInfo).address).toBe("127.0.0.1");
});

describe("app ID", () => {
  test("the entry rejects a mismatched expo-app-id when TIDE_APP_ID is set", async () => {
    const root = tempRoot();
    const port = await runEntry({ TIDE_DISK_DIR: root, TIDE_APP_ID: "tide-test" }).listening;
    const res = await fetch(`http://127.0.0.1:${port}/manifest`, {
      headers: {
        "expo-platform": "ios",
        "expo-app-id": "other",
        "expo-channel-name": "main",
        "expo-runtime-version": "1",
      },
    });
    expect(res.status).toBe(400);
    expect(await res.text()).toBe("expo-app-id does not match this server\n");
  });

  test("the entry with an empty TIDE_APP_ID accepts any expo-app-id", async () => {
    const root = tempRoot();
    await replace(root, NO_UPDATE_KEY, fixture("no-update.reply.json"));
    const port = await runEntry({ TIDE_DISK_DIR: root, TIDE_APP_ID: "" }).listening;
    const res = await fetch(`http://127.0.0.1:${port}/manifest`, {
      headers: {
        "expo-platform": "ios",
        "expo-app-id": "any",
        "expo-channel-name": "main",
        "expo-runtime-version": "1",
      },
    });
    expect(res.status).toBe(200);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(fixture("no-update.multipart"));
  });

  test.each([" x", "x ", "café"])("createApp rejects the app ID %j", (appId) => {
    expect(() => createApp(diskStore(tempRoot()), { appId })).toThrow("app ID must be");
  });
});

describe("node entry configuration", () => {
  test("starts from TIDE_DISK_DIR and serves the stored bytes", async () => {
    const root = tempRoot();
    const bytes = new TextEncoder().encode("served from disk");
    const hash = await sha256Base64Url(bytes);
    mkdirSync(join(root, "assets"));
    writeFileSync(join(root, "assets", contentKey(hash)), bytes);

    const port = await runEntry({ TIDE_DISK_DIR: root }).listening;
    const res = await fetch(`http://127.0.0.1:${port}/assets?h=${hash}`);
    expect(res.status).toBe(200);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(bytes);
  });

  test("exits before listening when no store is configured", async () => {
    const { code, stdout, stderr } = await runEntry({}).exited;
    expect(code).not.toBe(0);
    expect(stdout).not.toContain("listening");
    expect(stderr).toContain("no store configured: set TIDE_DISK_DIR, or all of TIDE_S3_ENDPOINT");
  });

  test("exits before listening when TIDE_DISK_DIR is missing", async () => {
    const { code, stdout, stderr } = await runEntry({
      TIDE_DISK_DIR: join(tempRoot(), "missing"),
    }).exited;
    expect(code).not.toBe(0);
    expect(stdout).not.toContain("listening");
    expect(stderr).toContain("is not a directory");
  });

  test("storeFromEnv names what is wrong", () => {
    const root = tempRoot();
    writeFileSync(join(root, "file"), "x");
    expect(() =>
      storeFromEnv({ TIDE_S3_ENDPOINT: "http://127.0.0.1:9", TIDE_S3_BUCKET: "b" }),
    ).toThrow(
      "S3 store incomplete: set TIDE_S3_REGION, TIDE_S3_ACCESS_KEY_ID, TIDE_S3_SECRET_ACCESS_KEY",
    );
    expect(() => storeFromEnv({ TIDE_DISK_DIR: root, TIDE_S3_REGION: "auto" })).toThrow("not both");
    expect(() => storeFromEnv({ TIDE_DISK_DIR: join(root, "file") })).toThrow("is not a directory");
    expect(() => storeFromEnv({ TIDE_DISK_DIR: "", TIDE_S3_ENDPOINT: "" })).toThrow(
      "no store configured",
    );
    expect(storeFromEnv({ TIDE_DISK_DIR: root, TIDE_S3_ENDPOINT: "" })).toBeDefined();
  });
});
