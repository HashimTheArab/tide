import { bunzip2 } from "./bzip2.ts";
import { ProtocolError, assetHash } from "./hash.ts";
import { ASSET_KEY, UUID } from "./manifest.ts";
import { checkName } from "./reply.ts";

/** One asset of an embedded build, as the asset key identity check compares it. */
export interface BaseAsset {
  readonly key: string;
  readonly hash: string;
}

interface BaseFields {
  readonly updateId: string;
  readonly runtimeVersion: string;
  readonly platform: "ios" | "android";
  readonly launchAsset: { readonly hash: string };
}

/** What `bases/<updateId>` holds: a launch bundle patches may start from (docs/design.md, Base records). */
export type BaseRecord =
  | (BaseFields & { readonly kind: "update" })
  | (BaseFields & { readonly kind: "embedded"; readonly assets: readonly BaseAsset[] });

/** The largest base record the server reads; encode refuses a larger one. */
export const MAX_BASE_BYTES = 256 * 1024;
/** The largest output `applyBsdiff` may be allowed to build. */
export const MAX_PATCH_OUTPUT = 128 * 1024 * 1024;

const VERSION = 1;
const FIELDS = {
  update: ["kind", "updateId", "runtimeVersion", "platform", "launchAsset"],
  embedded: ["kind", "updateId", "runtimeVersion", "platform", "launchAsset", "assets"],
} as const;

const encoder = new TextEncoder();
const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/**
 * Returns the record bytes: one JSON object, keys in a fixed order, no trailing newline. Embedded assets are sorted
 * by key and exact repeats collapse; two keys equal but for case must share one hash.
 */
export function encodeBaseRecord(record: BaseRecord): Uint8Array<ArrayBuffer> {
  return encode(record).bytes;
}

/** Returns the record `bytes` hold; anything `encodeBaseRecord` would not write byte for byte is refused. */
export function decodeBaseRecord(bytes: Uint8Array): BaseRecord {
  if (bytes.length > MAX_BASE_BYTES) {
    throw new ProtocolError("record", `is too large: over ${MAX_BASE_BYTES} bytes`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(utf8.decode(bytes));
  } catch {
    throw new ProtocolError("record", "is not UTF-8 JSON");
  }
  if (!isObject(parsed)) throw new ProtocolError("record", "must be a JSON object");
  // Version first, so a later layout is reported as unsupported rather than as malformed.
  const { version, ...rest } = parsed;
  if (!Number.isInteger(version)) throw new ProtocolError("version", "must be an integer");
  if (version !== VERSION) throw new ProtocolError("version", "is not supported");
  const canonical = encode(rest);
  if (canonical.bytes.length !== bytes.length || canonical.bytes.some((b, i) => b !== bytes[i])) {
    throw new ProtocolError("record", "is not in the form encodeBaseRecord writes");
  }
  return canonical.record;
}

function encode(input: unknown): { record: BaseRecord; bytes: Uint8Array<ArrayBuffer> } {
  if (!isObject(input)) throw new ProtocolError("record", "must be an object");
  const kind = input.kind;
  if (kind !== "update" && kind !== "embedded") {
    throw new ProtocolError("kind", "must be update or embedded");
  }
  for (const key of Object.keys(input)) {
    if (!(FIELDS[kind] as readonly string[]).includes(key)) {
      throw new ProtocolError(key, `is not a field of an ${kind} base`);
    }
  }
  const { updateId, runtimeVersion, platform, launchAsset } = input;
  if (typeof updateId !== "string" || !UUID.test(updateId)) {
    throw new ProtocolError("updateId", "must be a lowercase UUID");
  }
  if (typeof runtimeVersion !== "string") {
    throw new ProtocolError("runtimeVersion", "must be a string");
  }
  checkName(runtimeVersion, "runtimeVersion");
  if (platform !== "ios" && platform !== "android") {
    throw new ProtocolError("platform", "must be ios or android");
  }
  if (!isObject(launchAsset)) throw new ProtocolError("launchAsset", "must be an object");
  for (const key of Object.keys(launchAsset)) {
    if (key !== "hash") throw new ProtocolError(`launchAsset.${key}`, "is not a field");
  }
  const fields = {
    updateId,
    runtimeVersion,
    platform,
    launchAsset: { hash: assetHash(launchAsset.hash, "launchAsset.hash") },
  } as const;
  const record: BaseRecord =
    kind === "update" ? { kind, ...fields } : { kind, ...fields, assets: baseAssets(input) };
  const bytes = new Uint8Array(encoder.encode(JSON.stringify({ version: VERSION, ...record })));
  if (bytes.length > MAX_BASE_BYTES) {
    throw new ProtocolError("record", `is too large: over ${MAX_BASE_BYTES} bytes`);
  }
  return { record, bytes };
}

/** Returns a sorted copy of the embedded assets, exact repeats collapsed. */
function baseAssets(input: Record<string, unknown>): BaseAsset[] {
  if (!Object.hasOwn(input, "assets")) throw new ProtocolError("assets", "is missing");
  const assets = input.assets;
  if (!Array.isArray(assets)) throw new ProtocolError("assets", "must be an array");
  const entries = assets.map((a: unknown, i) => {
    const field = `assets[${i}]`;
    if (!isObject(a)) throw new ProtocolError(field, "must be an object");
    for (const key of Object.keys(a)) {
      if (key !== "key" && key !== "hash")
        throw new ProtocolError(`${field}.${key}`, "is not a field");
    }
    if (typeof a.key !== "string" || !ASSET_KEY.test(a.key)) {
      throw new ProtocolError(`${field}.key`, "must be 1 to 64 of A-Z, a-z, 0-9, _ and -");
    }
    return { key: a.key, hash: assetHash(a.hash, `${field}.hash`), i };
  });
  entries.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : a.i - b.i));
  const out: BaseAsset[] = [];
  // iOS keeps asset files on a case-insensitive disk, so keys equal but for case must name the same bytes.
  const folded = new Map<string, string>();
  for (const { key, hash, i } of entries) {
    const previous = out.at(-1);
    if (previous?.key === key && previous.hash === hash) continue;
    const other = folded.get(key.toLowerCase());
    if (other !== undefined && other !== hash) {
      throw new ProtocolError(`assets[${i}].key`, "names another hash than an equal key");
    }
    folded.set(key.toLowerCase(), hash);
    out.push({ key, hash });
  }
  return out;
}

/**
 * Returns `base` with the BSDIFF40 `patch` applied. Refuses, with a ProtocolError, a malformed, truncated or
 * trailing-garbage patch, one that reads or seeks outside `base`, and one declaring more than `maxOutput` bytes.
 */
export function applyBsdiff(
  base: Uint8Array,
  patch: Uint8Array,
  maxOutput: number,
): Uint8Array<ArrayBuffer> {
  if (!Number.isSafeInteger(maxOutput) || maxOutput < 0 || maxOutput > MAX_PATCH_OUTPUT) {
    throw new ProtocolError("maxOutput", `must be an integer from 0 to ${MAX_PATCH_OUTPUT}`);
  }
  if (patch.length < 32) throw new ProtocolError("patch", "is shorter than its 32-byte header");
  if (String.fromCharCode(...patch.subarray(0, 8)) !== "BSDIFF40") {
    throw new ProtocolError("patch", "does not start with BSDIFF40");
  }
  const ctrlLen = header(patch, 8, "ctrl length");
  const diffLen = header(patch, 16, "diff length");
  const newSize = header(patch, 24, "output size");
  if (32 + ctrlLen + diffLen > patch.length) {
    throw new ProtocolError("patch", "is shorter than its header's block lengths");
  }
  if (newSize > maxOutput) {
    throw new ProtocolError("patch", `declares an output over ${maxOutput} bytes`);
  }

  const out = new Uint8Array(newSize);
  const diffAt = 32 + ctrlLen;
  const extraAt = diffAt + diffLen;
  // A triple that moves nothing makes no progress, so ctrl is capped at one triple per output byte, plus one.
  const ctrl = bunzip2(patch.subarray(32, diffAt), "patch.ctrl", 24 * (newSize + 1));
  const diff = bunzip2(patch.subarray(diffAt, extraAt), "patch.diff", newSize);
  const extra = bunzip2(patch.subarray(extraAt), "patch.extra", newSize);
  const triple = new Uint8Array(24);
  let newPos = 0;
  let oldPos = 0; // Always within [0, base.length].
  while (newPos < newSize) {
    if (ctrl.read(triple) !== 24) {
      throw new ProtocolError("patch.ctrl", "ends before the output is complete");
    }
    const add = offset(triple, 0, false);
    const copy = offset(triple, 8, false);
    const seek = offset(triple, 16, true);
    if (newPos + add > newSize) throw new ProtocolError("patch.ctrl", "adds past the output's end");
    // Reference bspatch skips adds outside the base; bsdiff never writes one, so it is refused here.
    if (oldPos + add > base.length)
      throw new ProtocolError("patch.ctrl", "reads past the base's end");
    if (diff.read(out.subarray(newPos, newPos + add)) !== add) {
      throw new ProtocolError("patch.diff", "ends before the output is complete");
    }
    for (let i = 0; i < add; i++)
      out[newPos + i] = (out[newPos + i] ?? 0) + (base[oldPos + i] ?? 0);
    newPos += add;
    oldPos += add;
    if (newPos + copy > newSize) {
      throw new ProtocolError("patch.ctrl", "copies past the output's end");
    }
    if (extra.read(out.subarray(newPos, newPos + copy)) !== copy) {
      throw new ProtocolError("patch.extra", "ends before the output is complete");
    }
    newPos += copy;
    oldPos += seek;
    if (oldPos < 0 || oldPos > base.length) {
      throw new ProtocolError("patch.ctrl", "seeks outside the base");
    }
  }
  ctrl.end();
  diff.end();
  extra.end();
  return out;
}

/** A header length: non-negative, below 2^53. */
function header(patch: Uint8Array, at: number, name: string): number {
  if ((patch[at + 7] ?? 0) & 0x80) throw new ProtocolError("patch", `has a negative ${name}`);
  return magnitude(patch, at, "patch", name);
}

/** A control value: sign-magnitude, never negative zero; `add` and `copy` lengths are never negative. */
function offset(triple: Uint8Array, at: number, signed: boolean): number {
  const value = magnitude(triple, at, "patch.ctrl", "control value");
  if (((triple[at + 7] ?? 0) & 0x80) === 0) return value;
  if (value === 0) throw new ProtocolError("patch.ctrl", "has a negative zero");
  if (!signed) throw new ProtocolError("patch.ctrl", "has a negative length");
  return -value;
}

/** The 63-bit little-endian magnitude at `at`, refused at 2^53 or more. */
function magnitude(bytes: Uint8Array, at: number, field: string, name: string): number {
  if (((bytes[at + 7] ?? 0) & 0x7f) !== 0 || (bytes[at + 6] ?? 0) >= 0x20) {
    throw new ProtocolError(field, `has a ${name} of 2^53 or more`);
  }
  let value = 0;
  for (let i = 6; i >= 0; i--) value = value * 256 + (bytes[at + i] ?? 0);
  return value;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
