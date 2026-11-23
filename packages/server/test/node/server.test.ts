import { once } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
import { analyticsCases, faultySink, sinkFaultCases } from "../shared/analytics-cases.ts";
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

// The entry's own sink cannot be made to fail on demand, so this proves the core contract on Node.
describe("node app with a failing analytics sink", () => {
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

  sinkFaultCases({
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

/** Returns the point of one stdout line, after checking the fields the Node sink adds. */
function pointOf(line: string, since: number): ManifestPoint {
  const { schema, time, ...point } = JSON.parse(line) as ManifestPoint & {
    schema: unknown;
    time: string;
  };
  expect(schema).toBe(1);
  expect(new Date(time).toISOString()).toBe(time);
  expect(Date.parse(time)).toBeGreaterThanOrEqual(since);
  expect(Date.parse(time)).toBeLessThanOrEqual(Date.now());
  return point;
}

// The Workers project runs these cases against its binding, so a line here holds the point written there.
describe("node entry with TIDE_ANALYTICS=stdout", () => {
  const root = tempRoot();
  const started = Date.now();
  let base = "";
  let entry: ReturnType<typeof runEntry>;
  let taken = 0; // Characters of stdout the cases have accounted for.
  beforeAll(async () => {
    entry = runEntry(
      { TIDE_DISK_DIR: root, TIDE_APP_ID: "tide-test", TIDE_ANALYTICS: "stdout" },
      (kill) => cleanup.push(kill),
    );
    const [banner, port] = await entry.printed(/^tide listening on port (\d+)\n/);
    taken = banner.length;
    base = `http://127.0.0.1:${port}`;
    await replace(
      root,
      diskPath(replyKey("marker", "1.0.0", "ios")),
      fixture("manifest.reply.json"),
    );
  });

  analyticsCases({
    request: (path, headers) => exactRequest(`${base}${path}`, headers),
    put: (key, bytes) => replace(root, diskPath(key), bytes),
    putFault: (key) => replace(root, diskPath(key)),
    capture: () => async () => {
      // Lines keep their order, so one marker's line shows that every earlier request's has arrived.
      const marker = crypto.randomUUID();
      await manifestRequest(base, "marker", { "expo-current-update-id": marker });
      const [stdout] = await entry.printed(new RegExp(`^[^]*"${marker}"[^\n]*\n`));
      const lines = stdout.slice(taken).split("\n").slice(0, -1);
      taken = stdout.length;
      expect(lines.pop()).toContain(marker);
      return lines.map((line) => pointOf(line, started));
    },
  });
});

describe("the node entry's analytics lines", () => {
  /** Starts the entry over a bucket whose `main` channel serves the golden manifest. */
  async function start(env: Record<string, string>) {
    const root = tempRoot();
    await replace(root, diskPath(replyKey("main", "1.0.0", "ios")), fixture("manifest.reply.json"));
    const entry = runEntry({ TIDE_DISK_DIR: root, ...env });
    return { entry, base: `http://127.0.0.1:${await entry.listening}` };
  }
  async function expectManifest(res: Response) {
    expect(res.status).toBe(200);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(fixture("manifest.multipart"));
  }

  test("the documented line is stdout's only line starting with {", async () => {
    const { entry, base } = await start({ TIDE_ANALYTICS: "stdout" });
    await expectManifest(await manifestRequest(base, "main"));
    await entry.printed(/^\{.*\n/m);
    entry.kill("SIGTERM");
    const { code, stdout, stderr } = await entry.exited;
    expect([code, stderr]).toEqual([0, ""]);
    const line = stdout.replace(/^tide listening on port \d+\n/, "").replace(/tide closing\n$/, "");
    pointOf(line, 0);
    const documented = line.replace(/"time":"[^"]+"/, '"time":"<ISO ms Z>"');
    const design = readFileSync(new URL("../../../../docs/design.md", import.meta.url), "utf8");
    expect(design).toContain(`\`\`\`json\n${documented}\`\`\`\n`);
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

  test.each(["1", "true", "STDOUT", "stdout ", "stderr"])(
    "TIDE_ANALYTICS=%j exits 1 before listening",
    async (value) => {
      const entry = runEntry({ TIDE_DISK_DIR: tempRoot(), TIDE_ANALYTICS: value });
      expect(await entry.exited).toEqual({
        code: 1,
        signal: null,
        stdout: "",
        stderr: "tide: TIDE_ANALYTICS must be stdout, or unset\n",
      });
    },
  );

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
    for (const line of points) pointOf(line, 0);
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
