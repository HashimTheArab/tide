import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { describe, expect, test } from "vitest";

import {
  NO_UPDATE_KEY,
  applyBsdiff,
  baseKey,
  contentKey,
  encodeBaseRecord,
  patchKey,
  sha256Base64Url,
} from "@tide-ota/protocol";

import type { Bucket } from "../src/bucket.ts";
import type { Platform } from "../src/publish-record.ts";
import type { Objects } from "./publish-fixture.ts";
import { runEntry } from "../../server/test/node/entry.ts";
import { MAX_BSDIFF_INPUT, makeBsdiff } from "../src/bsdiff.ts";
import { diskBucket } from "../src/disk.ts";
import { checkPatch, preparePatches, uploadPatches } from "../src/publish-patch.ts";
import { encodeRecord, recordKey } from "../src/publish-record.ts";
import { execute, publish, recordedKeys, storedContent } from "../src/publish.ts";
import { registerBuild } from "../src/register-build.ts";
import { bucketFromEnv } from "../src/storage.ts";
import { prng, rejection, tempRoot } from "./helpers.ts";
import {
  ASSET_URL,
  IOS,
  SERVER_URL,
  diskObjects,
  env,
  artifact,
  pins,
  s3,
  s3Env,
  serveMain,
  tree,
  useFixture,
} from "./publish-fixture.ts";

useFixture();

const EMBEDDED = "1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed";
const hex = async (bytes: Uint8Array<ArrayBuffer>) => contentKey(await sha256Base64Url(bytes));

/** `n` bytes drawn from `seed`: incompressible, so gzip saves nothing and a small edit makes a small patch. */
function random(seed: number, n = 4096): Uint8Array<ArrayBuffer> {
  const r = prng(seed);
  return Uint8Array.from({ length: n }, () => Math.floor(r() * 256));
}

/** `bytes` with 8 bytes overwritten, chosen by `seed`. */
function edited(bytes: Uint8Array<ArrayBuffer>, seed: number): Uint8Array<ArrayBuffer> {
  const r = prng(seed);
  const out = bytes.slice();
  for (let i = 0; i < 8; i++) out[Math.floor(r() * out.length)] = Math.floor(r() * 256);
  return out;
}

/** An export of the given platforms at runtime 1.0.0, each with its bundle replaced. */
function exportWith(bundles: Partial<Record<Platform, Uint8Array<ArrayBuffer>>>): string {
  const platforms = Object.fromEntries(
    Object.keys(bundles).map((p) => [p, { runtimeVersion: "1.0.0" }]),
  );
  const dir = artifact({ fields: { platforms } });
  for (const [platform, bytes] of Object.entries(bundles)) {
    writeFileSync(join(dir, "dist/_expo/static/js", platform, `index-${platform}.hbc`), bytes);
  }
  return dir;
}

/** Publishes `bundles` in process to channel `main`, one target per given platform. */
async function publishBundles(
  store: Record<string, string>,
  bundles: Partial<Record<Platform, Uint8Array<ArrayBuffer>>>,
) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await publish(["--channel", "main", "--from", exportWith(bundles)], env(store), {
    out: (l) => out.push(l),
    err: (l) => err.push(l),
  });
  return { code, out, err, id: out[0]?.split(" ")[1] };
}

/** Registers an iOS 1.0.0 store build whose embedded bundle is `bundle`. */
async function register(
  store: Record<string, string>,
  bundle: Uint8Array<ArrayBuffer>,
  id = EMBEDDED,
) {
  const dir = tempRoot();
  writeFileSync(join(dir, "app.manifest"), JSON.stringify({ id, assets: [] }));
  writeFileSync(join(dir, "main.jsbundle"), bundle);
  const args = ["--platform", "ios", "--runtime-version", "1.0.0"];
  const files = ["--manifest", join(dir, "app.manifest"), "--bundle", join(dir, "main.jsbundle")];
  const ignore = () => undefined;
  const environment = { ...pins(), ...store };
  await serveMain(store);
  expect(await registerBuild([...args, ...files], environment, { out: ignore, err: ignore })).toBe(
    0,
  );
}

/** Every stored patch key; each patch applied to its stored base bundle must hash to the bundle it names. */
async function storedPatches(objects: Objects): Promise<string[]> {
  const keys = [...objects.keys()].filter((k) => k.startsWith("patches/")).sort();
  for (const key of keys) {
    const [, from, to] = key.split("/");
    const base = objects.get(`bundles/${from}`)!;
    const target = objects.get(`bundles/${to}`)!;
    expect(await hex(applyBsdiff(base, objects.get(key)!, target.length))).toBe(to);
  }
  return keys;
}

const patchesTo = async (target: Uint8Array<ArrayBuffer>, ...bases: Uint8Array<ArrayBuffer>[]) => {
  const to = await hex(target);
  return (await Promise.all(bases.map(async (b) => patchKey(await hex(b), to)))).sort();
};

/** Seeds an update's release record and base record, and its bundle unless `stored` is false. */
async function seedUpdate(
  root: string,
  u: {
    id: string;
    bundle: Uint8Array<ArrayBuffer>;
    createdAt: string;
    runtime?: string;
    platform?: Platform;
    stored?: boolean;
  },
) {
  const bucket = diskBucket(root);
  const launchAsset = { hash: await sha256Base64Url(u.bundle) };
  const fields = { runtimeVersion: u.runtime ?? "1.0.0", platform: u.platform ?? "ios" };
  const record = encodeRecord({
    ...fields,
    updateId: u.id,
    channel: "main",
    createdAt: u.createdAt,
    serverUrl: SERVER_URL,
    assetUrl: ASSET_URL,
    launchAsset,
    assets: [],
    extra: {},
  });
  await bucket.put(recordKey(u.id), record);
  await bucket.put(
    baseKey(u.id),
    encodeBaseRecord({ kind: "update", updateId: u.id, ...fields, launchAsset }),
  );
  if (u.stored !== false) await bucket.put(`bundles/${contentKey(launchAsset.hash)}`, u.bundle);
}

/** Seeds an embedded base record, without its bundle. */
async function seedEmbedded(
  bucket: Bucket,
  id: string,
  bundle: Uint8Array<ArrayBuffer>,
  platform = "ios",
) {
  const record = encodeBaseRecord({
    kind: "embedded",
    updateId: id,
    runtimeVersion: "1.0.0",
    platform: platform as Platform,
    launchAsset: { hash: await sha256Base64Url(bundle) },
    assets: [],
  });
  await bucket.put(baseKey(id), record);
}

const uuid = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
const minute = (n: number) => new Date(Date.UTC(2026, 0, 1, 0, n)).toISOString();

describe("publish stores patches", () => {
  test("register-build, two publishes, and the Node server answers A-IM: bsdiff with a patch that rebuilds the bundle", async () => {
    const root = tempRoot();
    const store = { TIDE_DISK_DIR: root };
    const embedded = random(1);
    const a = edited(embedded, 2);
    const b = edited(a, 3);
    await register(store, embedded);

    const first = await publishBundles(store, { ios: a });
    expect(first.code).toBe(0);
    expect(await storedPatches(diskObjects(root))).toEqual(await patchesTo(a, embedded));
    const second = await publishBundles(store, { ios: b });
    expect(second.code).toBe(0);
    const objects = diskObjects(root);
    expect(await storedPatches(objects)).toEqual(
      [...(await patchesTo(a, embedded)), ...(await patchesTo(b, embedded, a))].sort(),
    );

    const server = runEntry(store);
    const port = await server.listening;
    const bundle = async (target: Uint8Array<ArrayBuffer>, requested: string, current: string) =>
      await fetch(`http://127.0.0.1:${port}/bundles/${await hex(target)}`, {
        headers: {
          "a-im": "bsdiff",
          "expo-current-update-id": current,
          "expo-requested-update-id": requested,
        },
      });
    for (const [current, base] of [
      [EMBEDDED, embedded],
      [first.id!, a],
    ] as const) {
      const res = await bundle(b, second.id!, current);
      expect(res.status).toBe(226);
      expect(res.headers.get("im")).toBe("bsdiff");
      expect(res.headers.get("expo-base-update-id")).toBe(current);
      const patch = new Uint8Array(await res.arrayBuffer());
      expect(await hex(applyBsdiff(base, patch, b.length))).toBe(await hex(b));
    }
    // Nothing patches from the newer bundle back to the older one.
    const full = await bundle(a, first.id!, second.id!);
    expect(full.status).toBe(200);
    expect(full.headers.get("im")).toBeNull();
    expect(new Uint8Array(await full.arrayBuffer())).toEqual(a);
  });

  test("bases are every embedded build and the five newest updates of each target's runtime and platform, by createdAt", async () => {
    const root = tempRoot();
    const common = random(10);
    const next = edited(common, 99);
    const variant = (i: number) => edited(common, 100 + i);
    // createdAt runs against ID order. Newest first: 1, 3 (the new bundle), 5 (repeats 1), 0, 6; then 4 and 2.
    const minutes = [3, 6, 0, 5, 1, 4, 2];
    const bundles = minutes.map((_, i) => (i === 3 ? next : i === 5 ? variant(1) : variant(i)));
    for (const [i, m] of minutes.entries()) {
      await seedUpdate(root, { id: uuid(i), bundle: bundles[i]!, createdAt: minute(m) });
    }
    await seedUpdate(root, {
      id: uuid(20),
      bundle: variant(20),
      createdAt: minute(9),
      runtime: "2.0.0",
    });
    await seedUpdate(root, {
      id: uuid(21),
      bundle: variant(21),
      createdAt: minute(9),
      platform: "android",
    });
    for (const i of [30, 31]) {
      await seedEmbedded(diskBucket(root), uuid(i), variant(i));
      await diskBucket(root).put(`bundles/${await hex(variant(i))}`, variant(i));
    }

    // Android publishes too, so each platform's bases would also patch to the other's bundle if selection crossed.
    const android = edited(variant(21), 7);
    expect((await publishBundles({ TIDE_DISK_DIR: root }, { ios: next, android })).code).toBe(0);
    expect(await storedPatches(diskObjects(root))).toEqual(
      [
        ...(await patchesTo(next, variant(30), variant(31), variant(1), variant(0), variant(6))),
        ...(await patchesTo(android, variant(21))),
      ].sort(),
    );
  });

  test("a patch not under half the gzipped bundle is not stored, and the bundle is still published", async () => {
    const root = tempRoot();
    const base = random(5, 256);
    const next = edited(base, 6);
    const gzipped = gzipSync(next, { level: 9 }).length;
    const patch = makeBsdiff(base, next).length;
    // A patch smaller than the gzipped bundle, yet not well under it.
    expect([gzipped / 2 < patch, patch < gzipped]).toEqual([true, true]);
    await register({ TIDE_DISK_DIR: root }, base);
    expect((await publishBundles({ TIDE_DISK_DIR: root }, { ios: next })).code).toBe(0);
    const objects = diskObjects(root);
    expect(objects.get(`bundles/${await hex(next)}`)).toEqual(next);
    expect(await storedPatches(objects)).toEqual([]);
  });

  test("a new bundle over MAX_BSDIFF_INPUT publishes without a patch", async () => {
    const root = tempRoot();
    const base = random(7);
    await register({ TIDE_DISK_DIR: root }, base);
    const next = new Uint8Array(MAX_BSDIFF_INPUT + 1);
    next.set(base);
    expect((await publishBundles({ TIDE_DISK_DIR: root }, { ios: next })).code).toBe(0);
    const objects = diskObjects(root);
    expect(objects.has(`bundles/${await hex(next)}`)).toBe(true);
    expect(await storedPatches(objects)).toEqual([]);
  });
});

describe("refusals before any write", () => {
  test.each<[string, (root: string, next: Uint8Array<ArrayBuffer>) => Promise<string>]>([
    [
      "an embedded build whose bundle is not stored",
      async (root, next) => {
        const base = edited(next, 1);
        await seedEmbedded(diskBucket(root), EMBEDDED, base);
        return `${baseKey(EMBEDDED)} names bundles/${await hex(base)}, which is not stored`;
      },
    ],
    [
      "an update whose bundle is not stored",
      async (root, next) => {
        const base = edited(next, 1);
        await seedUpdate(root, { id: uuid(1), bundle: base, createdAt: minute(1), stored: false });
        return `${baseKey(uuid(1))} names bundles/${await hex(base)}, which is not stored`;
      },
    ],
    [
      "an update base without a release record",
      async (root, next) => {
        await seedUpdate(root, { id: uuid(1), bundle: edited(next, 1), createdAt: minute(1) });
        await diskBucket(root).delete(recordKey(uuid(1)));
        return `${baseKey(uuid(1))} has no release record ${recordKey(uuid(1))}`;
      },
    ],
  ])("%s", async (_, seed) => {
    const root = tempRoot();
    const next = random(40);
    const expected = await seed(root, next);
    const before = tree(root);
    expect(await publishBundles({ TIDE_DISK_DIR: root }, { ios: next })).toMatchObject({
      code: 2,
      out: [],
      err: [`tide: ${expected}`],
    });
    expect(tree(root)).toEqual(before);
  });

  test("a missing Android base refuses after iOS built its patch, so neither platform writes", async () => {
    const root = tempRoot();
    const ios = random(41);
    const android = random(42);
    await register({ TIDE_DISK_DIR: root }, edited(ios, 1));
    await seedEmbedded(diskBucket(root), uuid(2), edited(android, 1), "android");
    const before = tree(root);
    expect(await publishBundles({ TIDE_DISK_DIR: root }, { ios, android })).toMatchObject({
      code: 2,
      err: [
        `tide: ${baseKey(uuid(2))} names bundles/${await hex(edited(android, 1))}, which is not stored`,
      ],
    });
    expect(tree(root)).toEqual(before);
  });

  test("a missing base refuses even when the new bundle is too large to patch", async () => {
    const root = tempRoot();
    const next = new Uint8Array(MAX_BSDIFF_INPUT + 1);
    await seedEmbedded(diskBucket(root), EMBEDDED, random(43));
    const before = tree(root);
    expect(await publishBundles({ TIDE_DISK_DIR: root }, { ios: next })).toMatchObject({
      code: 2,
      err: [
        `tide: ${baseKey(EMBEDDED)} names bundles/${await hex(random(43))}, which is not stored`,
      ],
    });
    expect(tree(root)).toEqual(before);
  });

  test("a self-check failure on the second target exits 2 with the bucket unchanged", async () => {
    const root = tempRoot();
    const store = { TIDE_DISK_DIR: root };
    const [ios, android] = [random(44), random(45)];
    await register(store, edited(ios, 1));
    await seedEmbedded(diskBucket(root), uuid(2), edited(android, 1), "android");
    await diskBucket(root).put(`bundles/${await hex(edited(android, 1))}`, edited(android, 1));
    const bucket = diskBucket(root);
    const targets = [
      {
        runtime: "1.0.0",
        platform: "ios",
        bundle: { bytes: ios, hash: await sha256Base64Url(ios) },
      },
      // The bytes are not the ones the hash names, as if the generator had built the wrong output.
      {
        runtime: "1.0.0",
        platform: "android",
        bundle: { bytes: android, hash: await sha256Base64Url(random(46)) },
      },
    ] as const;
    const before = tree(root);
    const err: string[] = [];
    const code = await execute({ out: () => undefined, err: (l) => err.push(l) }, async () => {
      const { bases } = await recordedKeys(bucket, { targets });
      const patches = await preparePatches(bucket, targets, bases, await storedContent(bucket));
      return () => uploadPatches(bucket, patches);
    });
    expect(code).toBe(2);
    const key = patchKey(await hex(edited(android, 1)), await hex(random(46)));
    expect(err).toEqual([
      `tide: ${key} failed its self-check: the result does not hash to the new bundle`,
    ]);
    expect(tree(root)).toEqual(before);
  });
});

describe("checkPatch", () => {
  const base = random(50);
  const target = edited(base, 51);
  const patch = makeBsdiff(base, target);
  const key = patchKey("0".repeat(64), "1".repeat(64));

  test("a patch that rebuilds the target passes", async () => {
    await checkPatch(base, patch, { bytes: target, hash: await sha256Base64Url(target) }, key);
  });

  test("a patch built for another target is refused", async () => {
    const other = edited(base, 52);
    const e = await rejection(
      checkPatch(
        base,
        makeBsdiff(base, other),
        { bytes: target, hash: await sha256Base64Url(target) },
        key,
      ),
    );
    expect(e.message).toBe(
      `${key} failed its self-check: the result does not hash to the new bundle`,
    );
  });

  test("a truncated patch is refused with the applier's reason", async () => {
    const e = await rejection(
      checkPatch(
        base,
        patch.subarray(0, -1),
        { bytes: target, hash: await sha256Base64Url(target) },
        key,
      ),
    );
    expect(e.name).toBe("PublishError");
    expect(e.message).toMatch(new RegExp(`^${key} failed its self-check: patch\\.extra `));
  });
});

describe("patches on S3", () => {
  const embedded = random(60);
  const next = edited(embedded, 61);

  test("patches land after bundles and assets and before reply/no-update, records, bases and pointers", async () => {
    // Seeded rather than registered, since registering needs the reply/no-update this publish must write.
    const bucket = bucketFromEnv(s3Env());
    await seedEmbedded(bucket, EMBEDDED, embedded);
    await bucket.put(`bundles/${await hex(embedded)}`, embedded);
    s3.puts.length = 0;
    expect((await publishBundles(s3Env(), { ios: next })).code).toBe(0);
    const [key] = await patchesTo(next, embedded);
    const at = (match: (k: string) => boolean) => s3.puts.flatMap((k, i) => (match(k) ? [i] : []));
    const content = at((k) => /^(?:bundles|assets)\//.test(k));
    const patch = at((k) => k === key);
    const noUpdate = at((k) => k === NO_UPDATE_KEY);
    const records = at((k) => /^(?:updates|bases)\//.test(k));
    const pointer = at((k) => k === IOS);
    expect([patch.length, noUpdate.length]).toEqual([1, 1]);
    for (const [earlier, later] of [
      [content, patch],
      [patch, noUpdate],
      [noUpdate, records],
      [records, pointer],
    ]) {
      expect(Math.max(...earlier!)).toBeLessThan(Math.min(...later!));
    }
    expect(await storedPatches(s3.objects)).toEqual([key]);

    // A second publish of the same bundle finds the patch stored and puts none.
    s3.puts.length = 0;
    expect((await publishBundles(s3Env(), { ios: next })).code).toBe(0);
    expect(s3.puts.filter((k) => k.startsWith("patches/"))).toEqual([]);
  });

  test("a patch PUT with an unknown outcome exits 1 before any record or pointer", async () => {
    await register(s3Env(), embedded);
    s3.puts.length = 0;
    s3.dropAfterPut("patches/");
    const result = await publishBundles(s3Env(), { ios: next });
    const [key] = await patchesTo(next, embedded);
    expect(result).toMatchObject({
      code: 1,
      out: [],
      err: [
        `tide: ${key}: S3 PutObject failed: network error; outcome unknown; a late copy is the same checked patch`,
      ],
    });
    expect(s3.puts.filter((k) => /^(?:reply|updates|bases)\//.test(k))).toEqual([]);
    expect(s3.objects.has(IOS)).toBe(false);
  });

  test("a patch another writer created first is kept, since it holds the same bytes", async () => {
    await register(s3Env(), embedded);
    const [key] = await patchesTo(next, embedded);
    const theirs = makeBsdiff(embedded, next);
    s3.raceOnPut(key!, theirs);
    s3.puts.length = 0;
    expect((await publishBundles(s3Env(), { ios: next })).code).toBe(0);
    expect(s3.puts.filter((k) => k === key)).toEqual([key]);
    expect(s3.objects.get(key!)).toBe(theirs);
    expect(s3.objects.has(IOS)).toBe(true);
  });

  test("a base bundle listed over MAX_BSDIFF_INPUT is never read and gets no patch", async () => {
    await register(s3Env(), embedded);
    const bundleKey = `bundles/${await hex(embedded)}`;
    s3.listSize(bundleKey, String(MAX_BSDIFF_INPUT + 1));
    s3.behave(bundleKey, "internal-error");
    expect((await publishBundles(s3Env(), { ios: next })).code).toBe(0);
    expect(await storedPatches(s3.objects)).toEqual([]);
    expect(s3.objects.has(IOS)).toBe(true);
  });
});
