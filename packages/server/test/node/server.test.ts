import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  closeSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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
import { CLIENT_LOW, fixture } from "../shared/fixtures.ts";
import { bundleCases, manifestCases, serverCases } from "../shared/server-cases.ts";
import { ENTRY, runEntry } from "./entry.ts";

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

// The core sink contract on Node; the entry's own sink only writes each point out.
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

/** Sends one stock iOS request for `channel` to the server at `base`. */
function manifestRequest(base: string, channel: string, change: Record<string, string> = {}) {
  return exactRequest(`${base}/manifest`, {
    accept: "multipart/mixed",
    "expo-protocol-version": "1",
    "expo-platform": "ios",
    "expo-runtime-version": "1.0.0",
    "expo-channel-name": channel,
    ...change,
  });
}

describe("the node entry's analytics lines", () => {
  /** Starts the entry over a bucket whose `main` channel serves the golden manifest. */
  async function start(env: Record<string, string>) {
    const root = tempRoot();
    await replace(root, diskPath(replyKey("main", "1.0.0", "ios")), fixture("manifest.reply.json"));
    const entry = runEntry({ TIDE_DISK_DIR: root, ...env });
    return { root, entry, base: `http://127.0.0.1:${await entry.listening}` };
  }
  async function expectManifest(res: Response) {
    expect(res.status).toBe(200);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(fixture("manifest.multipart"));
  }

  test("each check that reaches the reply decision is one line, and no other line starts with {", async () => {
    const started = Date.now();
    const { root, entry, base } = await start({ TIDE_ANALYTICS: "stdout" });
    const put = (key: string, golden?: string) =>
      replace(root, diskPath(key), golden === undefined ? undefined : fixture(golden));
    await put(replyKey("staged", "1.0.0", "ios"), "rollout-manifest.reply.json");
    await put(replyKey("fault", "1.0.0", "ios"));
    await put(NO_UPDATE_KEY, "identities-no-update.reply.json");
    const embedded = "6e0c1b9a-3f7d-4a2e-8b5c-9d1e2f3a4b5c";
    const failed = [1, 2].map((n) => `00000000-0000-4000-8000-00000000000${n}`);
    const statuses: number[] = [];
    for (const [channel, change] of [
      [
        "main",
        {
          "eas-client-id": CLIENT_LOW,
          "expo-current-update-id": embedded,
          "expo-embedded-update-id": embedded,
          "expo-recent-failed-update-ids": failed.map((id) => `"${id}"`).join(", "),
          "expo-fatal-error": "TypeError: undefined is not a function",
        },
      ],
      ["main", { "expo-platform": "web" }],
      ["main", { "expo-protocol-version": "2" }],
      ["none", { "expo-expect-signature": 'sig, keyid="other", alg="rsa-v1_5-sha256"' }],
      ["staged", { "eas-client-id": CLIENT_LOW }],
      ["fault", {}],
    ] as const) {
      statuses.push((await manifestRequest(base, channel, change)).status);
    }
    expect(statuses).toEqual([200, 400, 406, 404, 200, 503]);
    await entry.printed(/"fault".*\n/);
    entry.kill("SIGTERM");
    const { code, stdout } = await entry.exited;
    expect(code).toBe(0);
    const times: string[] = [];
    const timeless = stdout.replaceAll(/"time":"([^"]*)"/g, (_, time: string) => {
      times.push(time);
      return '"time":"<ISO ms Z>"';
    });
    for (const time of times) {
      expect(new Date(time).toISOString()).toBe(time);
      expect(Date.parse(time)).toBeGreaterThanOrEqual(started);
      expect(Date.parse(time)).toBeLessThanOrEqual(Date.now());
    }
    const point = (index: string, reply: string, side: string) =>
      `{"schema":1,"time":"<ISO ms Z>","indexes":["${index}"],"blobs":["${reply}","ios","1.0.0","","","","${side}"],"doubles":[0]}`;
    const lines = timeless.split("\n");
    expect(lines).toEqual([
      `tide listening on port ${await entry.listening}`,
      `{"schema":1,"time":"<ISO ms Z>","indexes":["main"],"blobs":["manifest","ios","1.0.0","${embedded}","${embedded}","${failed.join()}","none"],"doubles":[1]}`,
      point("staged", "manifest", "new"),
      point("fault", "503", "none"),
      "tide closing",
      "",
    ]);
    const design = readFileSync(new URL("../../../../docs/design.md", import.meta.url), "utf8");
    expect(design).toContain(`\`\`\`json\n${lines[1]}\n\`\`\`\n`);
  });

  test.each<Record<string, string>>([{}, { TIDE_ANALYTICS: "" }])(
    "with %j there are none",
    async (env) => {
      const { entry, base } = await start(env);
      await expectManifest(await manifestRequest(base, "main"));
      entry.kill("SIGTERM");
      const { code, stdout } = await entry.exited;
      expect(code).toBe(0);
      expect(stdout).toMatch(/^tide listening on port \d+\ntide closing\n$/);
    },
  );

  test.each(["1", "STDOUT"])("TIDE_ANALYTICS=%j exits 1 before listening", async (value) => {
    const entry = runEntry({ TIDE_DISK_DIR: tempRoot(), TIDE_ANALYTICS: value });
    expect(await entry.exited).toEqual({
      code: 1,
      signal: null,
      stdout: "",
      stderr: "tide: TIDE_ANALYTICS must be stdout, or unset\n",
    });
  });

  // Node writes to these synchronously, so a slow one would hold replies.
  test.each([
    ["a file", () => join(tempRoot(), "out.log")],
    ["a device", () => "/dev/null"],
  ])("stdout that is %s exits 1 before listening", async (_, path) => {
    const out = openSync(path(), "w");
    const child = spawn(process.execPath, [ENTRY], {
      env: { TIDE_DISK_DIR: tempRoot(), TIDE_ANALYTICS: "stdout", PORT: "0" },
      stdio: ["ignore", out, "pipe"],
    });
    onTestFinished(() => void child.kill("SIGKILL"));
    closeSync(out);
    let stderr = "";
    child.stderr!.setEncoding("utf8").on("data", (s: string) => (stderr += s));
    expect(await once(child, "close")).toEqual([1, null]);
    expect(stderr).toBe("tide: TIDE_ANALYTICS=stdout needs stdout to be a pipe or a socket\n");
  });

  test("a closed reader changes no reply and SIGTERM still exits 0", async () => {
    const { entry, base } = await start({ TIDE_ANALYTICS: "stdout" });
    const closed = once(entry.stdout, "close");
    entry.stdout.destroy();
    await closed;
    for (let i = 0; i < 20; i++) await expectManifest(await manifestRequest(base, "main"));
    entry.kill("SIGTERM");
    expect(await entry.exited).toMatchObject({ code: 0, signal: null, stderr: "" });
  });

  test("a stalled reader changes no reply, holds a bounded number of points and is written to again", async () => {
    const { entry, base } = await start({ TIDE_ANALYTICS: "stdout" });
    const [stalled, resumed] = [crypto.randomUUID(), crypto.randomUUID()];
    const failed = Array.from({ length: 5 }, () => `"${crypto.randomUUID()}"`).join(", ");
    const check = (id: string) =>
      manifestRequest(base, "main", {
        "expo-current-update-id": id,
        "expo-recent-failed-update-ids": failed,
      });
    entry.stdout.pause();
    const requests = 4000;
    for (let sent = 0; sent < requests; sent += 50) {
      const replies = Array.from({ length: 50 }, () => check(stalled));
      for (const reply of replies) await expectManifest(await reply);
    }
    entry.stdout.resume();
    // Every line still held comes before the first one written after the reader resumed.
    let written: string | undefined;
    void entry.printed(new RegExp(`^[^]*"${resumed}"[^\\n]*\\n`)).then(([all]) => (written = all));
    while (written === undefined) await expectManifest(await check(resumed));
    const points = written.split("\n").filter((line) => line.startsWith("{"));
    for (const line of points) expect(JSON.parse(line)).toMatchObject({ schema: 1 });
    const held = points.filter((line) => line.includes(stalled));
    const bytes = held.join("\n").length;
    expect(held.length).toBeGreaterThan(0);
    // The process's 64 KiB buffer, this reader's and the pipe's between them.
    expect(bytes).toBeLessThan(512 * 1024);
    expect((bytes / held.length) * requests).toBeGreaterThan(1024 * 1024);
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
