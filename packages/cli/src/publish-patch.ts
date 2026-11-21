import { gzipSync } from "node:zlib";

import {
  ProtocolError,
  applyBsdiff,
  contentKey,
  patchKey,
  sha256Base64Url,
} from "@tide-ota/protocol";

import type { Bucket } from "./bucket.ts";
import type { Platform } from "./publish-record.ts";
import { MAX_BSDIFF_INPUT, makeBsdiff } from "./bsdiff.ts";
import { writing } from "./pointer.ts";
import { PublishError } from "./publish-record.ts";

/** How many of a runtime and platform's newest OTA updates a publish patches from, beside every embedded build. */
const PATCH_UPDATE_BASES = 5;

/** A registered base of a publish target's runtime and platform; `createdAt` is an update's release record time. */
export interface PatchBase {
  readonly key: string; // bases/<updateId>
  readonly kind: "update" | "embedded";
  readonly runtimeVersion: string;
  readonly platform: Platform;
  readonly hash: string;
  readonly createdAt: string | undefined;
}

interface PatchTarget {
  readonly runtime: string;
  readonly platform: Platform;
  readonly bundle: { readonly bytes: Uint8Array; readonly hash: string };
}

/** Patches by store key, each applied to its base and hash-checked. */
type Patches = Map<string, Uint8Array<ArrayBuffer>>;

/**
 * Returns the patches to store for each target's new bundle, from every embedded build and the newest
 * `PATCH_UPDATE_BASES` updates of its runtime and platform. `stored` is the `bundles/` listing by key, with sizes.
 * Refuses a base whose bundle is not stored and a patch that fails its self-check; writes nothing.
 */
export async function preparePatches(
  bucket: Bucket,
  targets: readonly PatchTarget[],
  bases: readonly PatchBase[],
  stored: ReadonlyMap<string, number>,
): Promise<Patches> {
  const patches: Patches = new Map();
  for (const t of targets) {
    const toHex = contentKey(t.bundle.hash);
    const pair = bases.filter((b) => b.runtimeVersion === t.runtime && b.platform === t.platform);
    const newest = pair
      .filter((b) => b.kind === "update")
      .toSorted((a, b) => order(b.createdAt, a.createdAt) || order(b.key, a.key))
      .slice(0, PATCH_UPDATE_BASES);
    // The patch key is per bundle pair: bases sharing a launch hash share one patch.
    const from = new Map<string, PatchBase>();
    for (const b of [...pair.filter((b) => b.kind === "embedded"), ...newest]) {
      if (b.hash !== t.bundle.hash && !from.has(b.hash)) from.set(b.hash, b);
    }
    let gzipped: number | undefined;
    for (const [hash, base] of from) {
      const fromHex = contentKey(hash);
      const key = patchKey(fromHex, toHex);
      if (patches.has(key) || (await bucket.list(key)).some((e) => "key" in e && e.key === key)) {
        continue;
      }
      const bundleKey = `bundles/${fromHex}`;
      const size = stored.get(bundleKey);
      // Checked before the size cap, so an oversized new bundle cannot hide a missing base.
      if (size === undefined) throw missing(base, bundleKey);
      if (size > MAX_BSDIFF_INPUT || t.bundle.bytes.length > MAX_BSDIFF_INPUT) continue;
      const object = await bucket.get(bundleKey, MAX_BSDIFF_INPUT);
      if (object === undefined) throw missing(base, bundleKey);
      const patch = makeBsdiff(object.bytes, t.bundle.bytes);
      await checkPatch(object.bytes, patch, t.bundle, key);
      // gzip is the encoding every client accepts; a patch must save at least half of that transfer.
      gzipped ??= gzipSync(t.bundle.bytes, { level: 9 }).length;
      if (patch.length * 2 <= gzipped) patches.set(key, patch);
    }
  }
  return patches;
}

/** Refuses `patch` unless protocol `applyBsdiff` turns `base` into bytes whose SHA-256 is `target.hash`. */
export async function checkPatch(
  base: Uint8Array,
  patch: Uint8Array,
  target: { readonly bytes: Uint8Array; readonly hash: string },
  key: string,
): Promise<void> {
  let reason;
  try {
    const applied = applyBsdiff(base, patch, target.bytes.length);
    if ((await sha256Base64Url(applied)) === target.hash) return;
    reason = "the result does not hash to the new bundle";
  } catch (e) {
    if (!(e instanceof ProtocolError)) throw e;
    reason = e.message;
  }
  throw new PublishError(`${key} failed its self-check: ${reason}`);
}

/** Stores each patch; a lost create holds the same bytes, since `makeBsdiff` depends only on its inputs. */
export async function uploadPatches(bucket: Bucket, patches: Patches): Promise<void> {
  for (const [key, bytes] of patches) {
    await writing(
      key,
      () => bucket.putIfAbsent(key, bytes),
      "a late copy is the same checked patch",
    );
  }
}

const order = (a = "", b = "") => (a < b ? -1 : a > b ? 1 : 0);

const missing = (base: PatchBase, bundleKey: string) =>
  new PublishError(`${base.key} names ${bundleKey}, which is not stored`);
