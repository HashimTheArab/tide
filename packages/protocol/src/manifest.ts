import { ProtocolError, contentKey, isAssetHash } from "./hash.ts";
import { TOKEN } from "./multipart.ts";

export type JsonValue = string | number | boolean | null | readonly JsonValue[] | JsonObject;
export interface JsonObject {
  readonly [key: string]: JsonValue;
}

/** A manifest asset. `key` is Metro's key and must never name different bytes in any update; publish enforces it. */
export interface Asset {
  readonly hash: string;
  readonly key: string;
  readonly contentType: string;
  readonly fileExtension: string;
  readonly url: string;
}

/** The launch asset; the builder derives its key from `hash`, so the key cannot name other bytes. */
export type LaunchAsset = Omit<Asset, "key">;

export interface ManifestInput {
  readonly id: string;
  readonly createdAt: Date;
  readonly runtimeVersion: string;
  readonly launchAsset: LaunchAsset;
  readonly assets: readonly Asset[];
  readonly metadata: Readonly<Record<string, string>>;
  readonly extra: JsonObject;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// The device stores `key + fileExtension` as a file name; without "." in keys, names are safe and distinct.
const KEY = /^[A-Za-z0-9_-]{1,64}$/;
const FILE_EXTENSION = /^\.[A-Za-z0-9]{1,16}$/;
const MEDIA_TYPE = new RegExp(`^${TOKEN}/${TOKEN}$`);
const NON_EMPTY = /./s;
// 0000-01-01T00:00:00.000Z to 9999-12-31T23:59:59.999Z, where toISOString keeps a four-digit year.
const MIN_TIME = -62_167_219_200_000;
const MAX_TIME = 253_402_300_799_999;
const ROOT = "input";

const encoder = new TextEncoder();

/**
 * Returns the manifest as the exact UTF-8 bytes to sign, store and serve. Inputs are read once, as own data
 * properties of plain objects and arrays, so the bytes are built only from values that were validated.
 */
export function buildManifest(input: ManifestInput): Uint8Array<ArrayBuffer> {
  const m = struct(input, ROOT, [
    "id",
    "createdAt",
    "runtimeVersion",
    "launchAsset",
    "assets",
    "metadata",
    "extra",
  ]);
  const id = matching(m.get("id"), "id", UUID, "a lowercase UUID");
  const createdAt = isoDate(m.get("createdAt"), "createdAt");
  const runtimeVersion = matching(
    m.get("runtimeVersion"),
    "runtimeVersion",
    NON_EMPTY,
    "non-empty",
  );

  const launch = struct(m.get("launchAsset"), "launchAsset", [
    "hash",
    "contentType",
    "fileExtension",
    "url",
  ]);
  const launchHash = assetHash(launch.get("hash"), "launchAsset.hash");
  const launchAsset = {
    hash: launchHash,
    key: contentKey(launchHash),
    ...assetFile(launch, "launchAsset"),
  };

  // Lowercased, because a case-insensitive disk would store two keys differing only in case as one file.
  const keys = new Set([launchAsset.key]);
  const assets = plainArray(m.get("assets"), "assets").map((value, i) => {
    const field = `assets[${i}]`;
    const a = struct(value, field, ["hash", "key", "contentType", "fileExtension", "url"]);
    const hash = assetHash(a.get("hash"), `${field}.hash`);
    const key = matching(a.get("key"), `${field}.key`, KEY, "1 to 64 of A-Z, a-z, 0-9, _ and -");
    if (keys.has(key.toLowerCase()))
      throw new ProtocolError(`${field}.key`, "duplicates another key");
    keys.add(key.toLowerCase());
    return { hash, key, ...assetFile(a, field) };
  });

  const metadata = Object.fromEntries(
    [...plainObject(m.get("metadata"), "metadata")].map(([k, v]) => [
      k,
      string(v, path("metadata", k)),
    ]),
  );
  const extra = jsonObject(m.get("extra"), "extra", new Set());
  return encode({ id, createdAt, runtimeVersion, launchAsset, assets, metadata, extra });
}

/** Returns the noUpdateAvailable directive as the exact UTF-8 bytes to sign and store. */
export function buildNoUpdateAvailable(): Uint8Array<ArrayBuffer> {
  return encode({ type: "noUpdateAvailable" });
}

/** Returns the rollBackToEmbedded directive as the exact UTF-8 bytes to sign and store. */
export function buildRollBackToEmbedded(input: {
  readonly commitTime: Date;
}): Uint8Array<ArrayBuffer> {
  const commitTime = isoDate(struct(input, ROOT, ["commitTime"]).get("commitTime"), "commitTime");
  return encode({ type: "rollBackToEmbedded", parameters: { commitTime } });
}

function encode(value: object): Uint8Array<ArrayBuffer> {
  return encoder.encode(JSON.stringify(value));
}

function assetFile(a: ReadonlyMap<string, unknown>, field: string) {
  return {
    contentType: matching(
      a.get("contentType"),
      `${field}.contentType`,
      MEDIA_TYPE,
      "a type/subtype media type",
    ),
    fileExtension: matching(
      a.get("fileExtension"),
      `${field}.fileExtension`,
      FILE_EXTENSION,
      "a dot and 1 to 16 of A-Z, a-z and 0-9",
    ),
    url: assetUrl(a.get("url"), `${field}.url`),
  };
}

function assetHash(value: unknown, field: string): string {
  if (!isAssetHash(value)) throw new ProtocolError(field, "must be 43 characters of base64url");
  return value;
}

function string(value: unknown, field: string): string {
  if (typeof value !== "string") throw new ProtocolError(field, "must be a string");
  return value;
}

function matching(value: unknown, field: string, rule: RegExp, description: string): string {
  const s = string(value, field);
  if (!rule.test(s)) throw new ProtocolError(field, `must be ${description}`);
  return s;
}

/** The URL goes on the wire verbatim, so it must already be in the form a URL parser would print. */
function assetUrl(value: unknown, field: string): string {
  const raw = string(value, field);
  const url = URL.parse(raw);
  if (url?.href !== raw)
    throw new ProtocolError(field, "must be an absolute URL in canonical form");
  if (/%(?![0-9A-Fa-f]{2})/.test(raw)) throw new ProtocolError(field, "has a malformed % escape");
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new ProtocolError(field, "must be an http or https URL");
  }
  if (url.username !== "" || url.password !== "") {
    throw new ProtocolError(field, "must not carry credentials");
  }
  return raw;
}

function isoDate(value: unknown, field: string): string {
  let time: number;
  try {
    // Reads the internal time value, so no method of the input runs.
    time = Date.prototype.getTime.call(value as Date);
  } catch {
    throw new ProtocolError(field, "must be a Date");
  }
  if (!(time >= MIN_TIME && time <= MAX_TIME)) {
    throw new ProtocolError(field, "must be a valid Date in the years 0000 to 9999");
  }
  return new Date(time).toISOString();
}

function jsonObject(value: unknown, field: string, ancestors: Set<unknown>): JsonObject {
  return within(value, field, ancestors, () =>
    Object.fromEntries(
      [...plainObject(value, field)].map(([k, v]) => [k, json(v, path(field, k), ancestors)]),
    ),
  );
}

function json(value: unknown, field: string, ancestors: Set<unknown>): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "object") {
    throw new ProtocolError(
      field,
      "must be a string, finite number, boolean, null, array or object",
    );
  }
  if (!readable(field, () => Array.isArray(value))) return jsonObject(value, field, ancestors);
  return within(value, field, ancestors, () =>
    plainArray(value, field).map((v, i) => json(v, `${field}[${i}]`, ancestors)),
  );
}

/** Rejects a cycle; the same acyclic value may still appear in several places. */
function within<T>(value: unknown, field: string, ancestors: Set<unknown>, build: () => T): T {
  if (ancestors.has(value)) throw new ProtocolError(field, "must not contain a cycle");
  ancestors.add(value);
  const built = build();
  ancestors.delete(value);
  return built;
}

/** Reads a plain object with exactly the `names` fields. */
function struct(value: unknown, field: string, names: readonly string[]): Map<string, unknown> {
  const fields = plainObject(value, field);
  for (const key of fields.keys()) {
    if (!names.includes(key)) throw new ProtocolError(path(field, key), "is not a known field");
  }
  for (const name of names) {
    if (!fields.has(name)) throw new ProtocolError(path(field, name), "is missing");
  }
  return fields;
}

/** Own enumerable data properties of an object whose prototype is Object.prototype or null, each read once. */
function plainObject(value: unknown, field: string): Map<string, unknown> {
  return readable(field, () => {
    if (typeof value !== "object" || value === null) {
      throw new ProtocolError(field, "must be a plain object");
    }
    const proto: unknown = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) {
      throw new ProtocolError(field, "must be a plain object");
    }
    const entries = new Map<string, unknown>();
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== "string") throw new ProtocolError(field, "must not have symbol keys");
      const d = dataProperty(value, key, path(field, key));
      if (d.enumerable !== true) throw new ProtocolError(path(field, key), "must be enumerable");
      entries.set(key, d.value);
    }
    return entries;
  });
}

/** Own indexed data properties of an ordinary array without holes or extra properties, each read once. */
function plainArray(value: unknown, field: string): unknown[] {
  return readable(field, () => {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
      throw new ProtocolError(field, "must be a plain array");
    }
    const length: unknown = dataProperty(value, "length", field).value;
    if (typeof length !== "number") throw new ProtocolError(field, "must be a plain array");
    const items: unknown[] = [];
    for (let i = 0; i < length; i++)
      items.push(dataProperty(value, String(i), `${field}[${i}]`).value);
    if (Reflect.ownKeys(value).length !== length + 1) {
      throw new ProtocolError(field, "must not have properties other than its items");
    }
    return items;
  });
}

function dataProperty(value: object, key: string, field: string): PropertyDescriptor {
  const d = Object.getOwnPropertyDescriptor(value, key);
  if (d === undefined) throw new ProtocolError(field, "is missing");
  if (!Object.hasOwn(d, "value")) throw new ProtocolError(field, "must be a data property");
  return d;
}

/** Runs a reflective read; a throwing Proxy trap becomes a ProtocolError for `field`. */
function readable<T>(field: string, read: () => T): T {
  try {
    return read();
  } catch (error) {
    if (error instanceof ProtocolError) throw error;
    throw new ProtocolError(field, "cannot be read");
  }
}

function path(parent: string, key: string): string {
  return parent === ROOT ? key : `${parent}.${key}`;
}
