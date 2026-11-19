import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { contentKey, sha256Base64Url } from "@tide/protocol";

import { diskStore, startServer, storeFromEnv } from "../../src/node.ts";
import { serverCases } from "../shared/server-cases.ts";
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
async function serveDisk(root: string): Promise<string> {
  const server = await startServer({ port: 0, store: diskStore(root) });
  cleanup.push(() => new Promise((resolve) => server.close(resolve)));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe("node entry with a disk store", () => {
  const root = tempRoot();
  let base = "";
  beforeAll(async () => {
    base = await serveDisk(root);
  });

  serverCases({
    fetch: (path, init) => fetch(`${base}${path}`, init),
    put: async (key, bytes) => {
      await mkdir(dirname(join(root, key)), { recursive: true });
      await writeFile(join(root, key), bytes);
    },
    // A directory at the key: the adapter must not report it as absent or stream it.
    putFault: async (key) => {
      await mkdir(join(root, key), { recursive: true });
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
  ])("rejects %s without touching the disk", async (_, key) => {
    const root = tempRoot();
    const store = diskStore(root);
    // With the root gone, any disk access ends in "unavailable" instead of the grammar error.
    rmSync(root, { recursive: true });
    await expect(store.get(KEY)).rejects.toThrow(`disk store root ${root} unavailable`);
    await expect(store.get(key)).rejects.toThrow("invalid store key");
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
