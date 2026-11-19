import { ProtocolError, assetHash, contentKey } from "./hash.ts";
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

// Every asset extension a default Expo project bundles (Metro's `assetExts` plus Expo's), and the launch bundle's.
const CONTENT_TYPES = new Map(
  Object.entries({
    bundle: "application/javascript",
    js: "application/javascript",
    hbc: "application/javascript",
    bmp: "image/bmp",
    gif: "image/gif",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    png: "image/png",
    psd: "image/vnd.adobe.photoshop",
    svg: "image/svg+xml",
    webp: "image/webp",
    heic: "image/heic",
    avif: "image/avif",
    xml: "application/xml",
    html: "text/html",
    pdf: "application/pdf",
    yaml: "application/yaml",
    yml: "application/yaml",
    zip: "application/zip",
    db: "application/vnd.sqlite3",
    m4v: "video/x-m4v",
    mov: "video/quicktime",
    mp4: "video/mp4",
    mpeg: "video/mpeg",
    mpg: "video/mpeg",
    webm: "video/webm",
    aac: "audio/aac",
    aiff: "audio/x-aiff",
    caf: "audio/x-caf",
    m4a: "audio/mp4",
    mp3: "audio/mpeg",
    wav: "audio/wav",
    otf: "font/otf",
    ttf: "font/ttf",
    woff: "font/woff",
    woff2: "font/woff2",
  }),
);

/** Returns the media type for a bare file extension (`png`, no dot); `application/octet-stream` when unknown. */
export function assetContentType(ext: string): string {
  return CONTENT_TYPES.get(ext.toLowerCase()) ?? "application/octet-stream";
}

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

const encoder = new TextEncoder();

/**
 * Returns the manifest as the exact UTF-8 bytes to sign, store and serve. Each input field is read once and the
 * bytes are built from fresh objects holding only validated values, so no input method shapes the output.
 */
export function buildManifest(input: ManifestInput): Uint8Array<ArrayBuffer> {
  const m = object(input, "input");
  const id = matching(m.id, "id", UUID, "a lowercase UUID");
  const createdAt = isoDate(m.createdAt, "createdAt");
  const runtimeVersion = matching(m.runtimeVersion, "runtimeVersion", NON_EMPTY, "non-empty");

  const launch = object(m.launchAsset, "launchAsset");
  const launchHash = assetHash(launch.hash, "launchAsset.hash");
  const launchAsset = {
    hash: launchHash,
    key: contentKey(launchHash),
    ...assetFile(launch, "launchAsset"),
  };

  // Lowercased, because a case-insensitive disk would store two keys differing only in case as one file.
  const keys = new Set([launchAsset.key]);
  const assets = array(m.assets, "assets", (value, field) => {
    const a = object(value, field);
    const hash = assetHash(a.hash, `${field}.hash`);
    const key = matching(a.key, `${field}.key`, KEY, "1 to 64 of A-Z, a-z, 0-9, _ and -");
    if (keys.has(key.toLowerCase()))
      throw new ProtocolError(`${field}.key`, "duplicates another key");
    keys.add(key.toLowerCase());
    return { hash, key, ...assetFile(a, field) };
  });

  const metadata = Object.fromEntries(
    Object.entries(object(m.metadata, "metadata")).map(([k, v]) => [k, string(v, `metadata.${k}`)]),
  );
  const extra = jsonObject(m.extra, "extra", new Set());
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
  const commitTime = isoDate(object(input, "input").commitTime, "commitTime");
  return encode({ type: "rollBackToEmbedded", parameters: { commitTime } });
}

function encode(value: object): Uint8Array<ArrayBuffer> {
  // The copy types the bytes as ArrayBuffer-backed under Workers types too, where the server compiles this.
  return new Uint8Array(encoder.encode(JSON.stringify(value)));
}

function assetFile(a: Readonly<Record<string, unknown>>, field: string) {
  return {
    contentType: matching(
      a.contentType,
      `${field}.contentType`,
      MEDIA_TYPE,
      "a type/subtype media type",
    ),
    fileExtension: matching(
      a.fileExtension,
      `${field}.fileExtension`,
      FILE_EXTENSION,
      "a dot and 1 to 16 of A-Z, a-z and 0-9",
    ),
    url: assetUrl(a.url, `${field}.url`),
  };
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

/** Formats from the internal time value, so a Date subclass cannot change the text. */
function isoDate(value: unknown, field: string): string {
  let iso = "";
  try {
    iso = new Date(Date.prototype.getTime.call(value as Date)).toISOString();
  } catch {
    // Not a Date, or an invalid one.
  }
  if (!/^\d{4}-/.test(iso)) {
    throw new ProtocolError(field, "must be a valid Date in the years 0000 to 9999");
  }
  return iso;
}

/** An object whose prototype is Object.prototype or null, so a Date, array or class instance is rejected. */
function object(value: unknown, field: string): Readonly<Record<string, unknown>> {
  const proto: unknown =
    typeof value === "object" && value !== null && Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    throw new ProtocolError(field, "must be a plain object");
  }
  return value as Readonly<Record<string, unknown>>;
}

/** Copies own indexed entries, so neither a subclass nor an iterator can change them; a hole reads as undefined. */
function array<T>(value: unknown, field: string, item: (v: unknown, field: string) => T): T[] {
  if (!Array.isArray(value)) throw new ProtocolError(field, "must be an array");
  const own = value as unknown[];
  return Array.from({ length: own.length }, (_, i) =>
    item(Object.hasOwn(own, i) ? own[i] : undefined, `${field}[${i}]`),
  );
}

function jsonObject(value: unknown, field: string, ancestors: Set<unknown>): JsonObject {
  return within(value, field, ancestors, () =>
    Object.fromEntries(
      Object.entries(object(value, field)).map(([k, v]) => [
        k,
        json(v, `${field}.${k}`, ancestors),
      ]),
    ),
  );
}

function json(value: unknown, field: string, ancestors: Set<unknown>): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) {
    return within(value, field, ancestors, () =>
      array(value, field, (v, at) => json(v, at, ancestors)),
    );
  }
  if (typeof value === "object") return jsonObject(value, field, ancestors);
  throw new ProtocolError(field, "must be a string, finite number, boolean, null, array or object");
}

/** Rejects a cycle; the same acyclic value may still appear in several places. */
function within<T>(value: unknown, field: string, ancestors: Set<unknown>, build: () => T): T {
  if (ancestors.has(value)) throw new ProtocolError(field, "must not contain a cycle");
  ancestors.add(value);
  const built = build();
  ancestors.delete(value);
  return built;
}
