import fc from "fast-check";
import { describe, expect, inject, test } from "vitest";

import type {
  BaseRecord,
  ManifestInput,
  Part,
  PartName,
  Signer,
  StoredReply,
} from "../src/index.ts";
import type { CertificateOptions } from "./fixtures.ts";
import { bunzip2 } from "../src/bzip2.ts";
import { base64, decodeBase64 } from "../src/hash.ts";
import {
  MAX_BASE_BYTES,
  MAX_FILTERS_BYTES,
  MAX_REPLY_BYTES,
  LEGACY_MAP_KEY,
  NO_UPDATE_KEY,
  ProtocolError,
  applyBsdiff,
  assetContentType,
  assetHash,
  buildManifest,
  buildNoUpdateAvailable,
  buildRollBackToEmbedded,
  certificatePublicKey,
  codeSigningCertificate,
  contentKey,
  cryptoKeySigner,
  S3Error,
  childElements,
  decodeBaseRecord,
  decodeStoredReply,
  diskKey,
  diskPath,
  encodeMultipart,
  encodeBaseRecord,
  encodeSfvDictionary,
  encodeStoredReply,
  expoSignature,
  parseMultipart,
  parseS3Xml,
  replyKey,
  s3BodyProblem,
  s3ErrorCode,
  s3Target,
  sha256Base64Url,
  signV4,
  storageFromEnv,
  textOf,
  verifyExpoSignature,
} from "../src/index.ts";
import { EMPTY_SHA256 } from "../src/s3.ts";
import { parseSfvDictionary } from "../src/sfv.ts";
import {
  ALGORITHM,
  BOUNDARY,
  EXPO_GOLDEN,
  EXTENSION,
  KNOWN_PATCH,
  RSA_SHA256,
  TIDE_GOLDEN,
  TIDE_REPLY_GOLDEN,
  certificate,
  goldenParts,
  pem,
  replyGoldens,
  signedFixtures,
} from "./fixtures.ts";

declare module "vitest" {
  export interface ProvidedContext {
    fcSeed: number;
    fixtures: Record<string, number[]>; // Every file in test/fixtures, as bytes.
  }
}

function fixture(name: string): Uint8Array<ArrayBuffer> {
  const bytes = inject("fixtures")[name];
  if (bytes === undefined) throw new Error(`test/fixtures/${name} does not exist`);
  return new Uint8Array(bytes);
}
const ascii = (s: string) => new TextEncoder().encode(s);
const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
const hex = (bytes: Uint8Array) =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
/** Passes a malformed value where the types forbid it, as a JavaScript caller could. */
const loose = <T>(value: unknown) => value as T;

async function rejects(run: () => unknown, field: string, message = "") {
  let error: unknown;
  try {
    await run();
  } catch (e) {
    error = e;
  }
  expect(error).toBeInstanceOf(ProtocolError);
  expect(error).toMatchObject({ field });
  expect((error as Error).message).toContain(message);
}

const EMPTY_HASH = "47DEQpj8HBSa-_TImW-5JCeuQeRkm5NMpJWZG3hSuFU";
const PNG_HASH = "SXeQlH1GZnYM4488AOhSxx_bZsroSbro6e3jUnGeFYE";
const PNG_HEX = "497790947d4666760ce38f3c00e852c71fdb66cae849bae8e9ede352719e1581";
// SHA-256 of `console.log("tide 196508");\n`, picked for low-entropy hex so the secrets scan does not read
// the manifest's launch "key" as a credential.
const LAUNCH_HASH = "Z3WH11U_Wifv5ipwZ31aEqIgbdrhYS4nISY3Z6YVAlQ";
const LAUNCH_HEX = "677587d7553f5a27efe62a70677d5a12a2206ddae1612e2721263767a6150254";
const ID = "0f6a9a3e-6c1b-4c4e-9d55-2b8f3f7c1a90";
// Base and patch key variants outside the grammar.
const BAD_PATCH_KEYS = [
  `bases/${ID.toUpperCase()}`,
  `bases/${ID}.json`,
  `bases/${ID.slice(1)}`,
  `bases/${ID}/x`,
  `Bases/${ID}`,
  "bases/",
  "bases/..",
  "bases/../reply/no-update",
  `patches/${PNG_HEX.toUpperCase()}/${LAUNCH_HEX}`,
  `patches/${PNG_HEX}/${LAUNCH_HEX.toUpperCase()}`,
  `patches/${PNG_HEX.slice(1)}/${LAUNCH_HEX}`,
  `patches/${PNG_HEX}/${LAUNCH_HEX.slice(1)}`,
  `patches/${PNG_HEX}/${LAUNCH_HEX}/x`,
  `patches/${PNG_HEX}/${LAUNCH_HEX}.bsdiff`,
  `Patches/${PNG_HEX}/${LAUNCH_HEX}`,
  `patches/${PNG_HEX}`,
  `patches/${PNG_HEX}/`,
  `patches/${PNG_HEX}/../${LAUNCH_HEX}`,
  `patches/../bundles/${PNG_HEX}`,
];

describe("hash", () => {
  test("a fixture file hashes to its SHA-256 and content key", async () => {
    const hash = await sha256Base64Url(fixture("asset.png"));
    expect(hash).toBe(PNG_HASH);
    expect(contentKey(hash)).toBe(PNG_HEX);
  });

  test("empty input hashes to the SHA-256 of zero bytes", async () => {
    const hash = await sha256Base64Url(new Uint8Array());
    expect(hash).toBe(EMPTY_HASH);
    expect(contentKey(hash)).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });

  test("an offset view hashes only its own bytes", async () => {
    const png = fixture("asset.png");
    const larger = new Uint8Array(png.length + 15).fill(0xff);
    larger.set(png, 10);
    expect(await sha256Base64Url(larger.subarray(10, 10 + png.length))).toBe(PNG_HASH);
  });

  test.each([
    ["padding", `${PNG_HASH}=`],
    ["42 characters", PNG_HASH.slice(0, 42)],
    ["44 characters", `${PNG_HASH}A`],
    ["+", `+${PNG_HASH.slice(1)}`],
    ["/", `/${PNG_HASH.slice(1)}`],
    ["a non-canonical last character", `${EMPTY_HASH.slice(0, 42)}V`],
    ["a non-string", 123],
  ])("contentKey rejects %s", async (_, hash) => {
    await rejects(() => contentKey(loose(hash)), "hash");
  });
});

interface Draft {
  input: Record<string, unknown>;
  launch: Record<string, unknown>;
  asset: Record<string, unknown>;
}

/** The input behind manifest.json, as mutable objects a case can break. */
function draft(): Draft {
  const launch: Record<string, unknown> = {
    hash: LAUNCH_HASH,
    contentType: "application/javascript",
    fileExtension: ".bundle",
    url: `https://updates.example.com/bundles/${LAUNCH_HEX}`,
  };
  const asset: Record<string, unknown> = {
    hash: PNG_HASH,
    key: "splash",
    contentType: "image/png",
    fileExtension: ".png",
    url: `https://cdn.example.com/assets/${PNG_HEX}`,
  };
  const input: Record<string, unknown> = {
    id: ID,
    createdAt: new Date("2026-11-19T12:34:56.789Z"),
    runtimeVersion: "1.0.0",
    launchAsset: launch,
    assets: [asset],
    metadata: { branch: "main" },
    extra: {
      expoClient: { name: "Tide Demo", slug: "tide-demo", version: "1.0.0" },
      note: "café ☕",
      flags: [true, null, 1.5],
    },
  };
  return { input, launch, asset };
}

const build = (d: Draft) => buildManifest(loose<ManifestInput>(d.input));
const otherAsset = (key: string) => ({ ...draft().asset, key });
const extra = (d: Draft, value: unknown) => {
  d.input.extra = { value };
};
const holey = (...items: unknown[]) => {
  const a = [...items];
  Reflect.deleteProperty(a, 1);
  return a;
};

/** An array subclass whose `map` returns an array that serialises as `[null]`. */
function sneakyArray(items: unknown[]): unknown[] {
  class Rewritten extends Array<unknown> {
    toJSON() {
      return [null];
    }
  }
  class Sneaky extends Array<unknown> {}
  Object.defineProperty(Sneaky, Symbol.species, { get: () => Rewritten });
  const a = new Sneaky();
  a.push(...items);
  return a;
}

/** An array whose iterator yields nothing, so iterating it would drop every entry. */
function emptyIterator(items: unknown[]): unknown[] {
  return Object.assign([...items], { [Symbol.iterator]: () => [][Symbol.iterator]() });
}

class LyingDate extends Date {
  override toISOString() {
    return "1970-01-01T00:00:00.000Z";
  }
}

describe("manifest", () => {
  test("the builder output equals the golden manifest bytes", () => {
    expect(build(draft())).toEqual(fixture("manifest.json"));
  });

  test("a percent-encoded url is emitted byte for byte", () => {
    const d = draft();
    d.launch.url = "https://updates.example.com/bundles/a%2Fb";
    expect(text(build(d))).toContain('"url":"https://updates.example.com/bundles/a%2Fb"');
  });

  test("a __proto__ key in extra stays an own key", () => {
    const d = draft();
    d.input.extra = JSON.parse('{"__proto__":{"a":1}}');
    expect(text(build(d))).toContain('"extra":{"__proto__":{"a":1}}}');
  });

  test("two fields may share one acyclic object", () => {
    const d = draft();
    const shared = { a: [1] };
    d.input.extra = { x: shared, y: shared };
    expect(text(build(d))).toContain('"extra":{"x":{"a":[1]},"y":{"a":[1]}}}');
  });

  test("a Date subclass cannot change createdAt", () => {
    const d = draft();
    d.input.createdAt = new LyingDate("2026-11-19T12:34:56.789Z");
    expect(build(d)).toEqual(fixture("manifest.json"));
  });

  test("an Array subclass cannot change the bytes", () => {
    const d = draft();
    d.input.assets = sneakyArray([d.asset]);
    expect(build(d)).toEqual(fixture("manifest.json"));
    d.input.extra = { value: sneakyArray(["valid"]) };
    expect(text(build(d))).toContain('"extra":{"value":["valid"]}}');
  });

  test("an array's own iterator cannot hide its entries", () => {
    const d = draft();
    d.input.assets = emptyIterator([d.asset]);
    expect(build(d)).toEqual(fixture("manifest.json"));
    d.input.extra = { value: emptyIterator(["valid"]) };
    expect(text(build(d))).toContain('"extra":{"value":["valid"]}}');
  });

  test("a url getter is read once, so the validated value is the one written", () => {
    const d = draft();
    let reads = 0;
    Object.defineProperty(d.launch, "url", {
      get: () => (reads++ === 0 ? "https://a.example/a" : "not a url"),
      enumerable: true,
    });
    expect(text(build(d))).toContain('"url":"https://a.example/a"');
  });

  const uuidBox = loose<string>(Object(ID));
  const urlCase = (url: unknown) => (d: Draft) => {
    d.launch.url = url;
  };
  test.each<[string, string, (d: Draft) => void]>([
    ["a null input", "input", (d) => (d.input = loose(null))],
    ["an undefined input", "input", (d) => (d.input = loose(undefined))],
    ["a non-UUID id", "id", (d) => (d.input.id = "not-a-uuid")],
    ["an uppercase id", "id", (d) => (d.input.id = ID.toUpperCase())],
    ["an id inside an array", "id", (d) => (d.input.id = [ID])],
    ["a boxed id", "id", (d) => (d.input.id = uuidBox)],
    ["an empty runtimeVersion", "runtimeVersion", (d) => (d.input.runtimeVersion = "")],
    ["a numeric runtimeVersion", "runtimeVersion", (d) => (d.input.runtimeVersion = 1)],
    ["an invalid createdAt", "createdAt", (d) => (d.input.createdAt = new Date(Number.NaN))],
    ["an ISO string createdAt", "createdAt", (d) => (d.input.createdAt = "2026-11-19T00:00:00Z")],
    ["a numeric createdAt", "createdAt", (d) => (d.input.createdAt = 0)],
    [
      "a fake Date",
      "createdAt",
      (d) => (d.input.createdAt = Object.create(Date.prototype) as unknown),
    ],
    ["year 10000", "createdAt", (d) => (d.input.createdAt = new Date("+010000-01-01T00:00:00Z"))],
    ["a launchAsset missing hash", "launchAsset.hash", (d) => delete d.launch.hash],
    ["a launchAsset missing url", "launchAsset.url", (d) => delete d.launch.url],
    ["a 42-character hash", "launchAsset.hash", (d) => (d.launch.hash = LAUNCH_HASH.slice(1))],
    ["a 44-character hash", "launchAsset.hash", (d) => (d.launch.hash = `${LAUNCH_HASH}A`)],
    ["a padded hash", "assets[0].hash", (d) => (d.asset.hash = `${PNG_HASH}=`)],
    ["a hash with +", "assets[0].hash", (d) => (d.asset.hash = `+${PNG_HASH.slice(1)}`)],
    ["a key with /", "assets[0].key", (d) => (d.asset.key = "a/b")],
    ["a key with \\", "assets[0].key", (d) => (d.asset.key = "a\\b")],
    ["a key with NUL", "assets[0].key", (d) => (d.asset.key = "a\0b")],
    ["a key with .", "assets[0].key", (d) => (d.asset.key = "a.b")],
    ["an extension with /", "assets[0].fileExtension", (d) => (d.asset.fileExtension = ".p/g")],
    ["an extension with NUL", "assets[0].fileExtension", (d) => (d.asset.fileExtension = ".p\0g")],
    ["two dots", "assets[0].fileExtension", (d) => (d.asset.fileExtension = ".tar.gz")],
    ["a duplicate key", "assets[1].key", (d) => (d.input.assets = [d.asset, d.asset])],
    [
      "a key differing only in case",
      "assets[1].key",
      (d) => (d.input.assets = [d.asset, otherAsset("SPLASH")]),
    ],
    ["the launch key reused", "assets[0].key", (d) => (d.asset.key = LAUNCH_HEX)],
    ["contentType png", "launchAsset.contentType", (d) => (d.launch.contentType = "png")],
    ["contentType image/", "launchAsset.contentType", (d) => (d.launch.contentType = "image/")],
    [
      "a contentType with parameters",
      "launchAsset.contentType",
      (d) => (d.launch.contentType = "image/png; q=1"),
    ],
    ["a numeric contentType", "launchAsset.contentType", (d) => (d.launch.contentType = 5)],
    ["url https://", "launchAsset.url", urlCase("https://")],
    ["url https:example.com/a", "launchAsset.url", urlCase("https:example.com/a")],
    ["a url with a newline", "launchAsset.url", urlCase("https://a.example/x\ny")],
    ["an uppercase scheme", "launchAsset.url", urlCase("HTTPS://a.example/a")],
    ["an ftp url", "launchAsset.url", urlCase("ftp://a.example/a")],
    ["url %zz", "launchAsset.url", urlCase("https://a.example/bundle%zz")],
    ["url %2", "launchAsset.url", urlCase("https://a.example/b%2")],
    ["url credentials", "launchAsset.url", urlCase("https://u:p@a.example/a")],
    ["a URL object", "launchAsset.url", urlCase(new URL("https://a.example/a"))],
    ["metadata as an array", "metadata", (d) => (d.input.metadata = ["stable"])],
    [
      "metadata with an inherited toJSON",
      "metadata",
      (d) =>
        (d.input.metadata = Object.assign(Object.create({ toJSON: () => ({}) }) as object, {
          a: "b",
        })),
    ],
    ["a numeric metadata value", "metadata.branch", (d) => (d.input.metadata = { branch: 1 })],
    [
      "assets with a hole",
      "assets[1]",
      (d) => (d.input.assets = holey(d.asset, otherAsset("k1"), otherAsset("k2"))),
    ],
    ["NaN in extra", "extra.value", (d) => extra(d, Number.NaN)],
    ["undefined in extra", "extra.value", (d) => extra(d, undefined)],
    ["a bigint in extra", "extra.value", (d) => extra(d, 1n)],
    ["a function in extra", "extra.value", (d) => extra(d, () => 1)],
    ["a Date in extra", "extra.value", (d) => extra(d, new Date(0))],
    ["an array with a hole in extra", "extra.value[1]", (d) => extra(d, holey(1, 2, 3))],
    [
      "a hole plus an extra property",
      "extra.value[1]",
      (d) => extra(d, Object.assign(holey(1, 2, 3), { more: 4 })),
    ],
    [
      "a cycle in extra",
      "extra.value.self",
      (d) => {
        const loop: Record<string, unknown> = {};
        loop.self = loop;
        extra(d, loop);
      },
    ],
  ])("buildManifest rejects %s", async (_, field, change) => {
    const d = draft();
    change(d);
    await rejects(() => build(d), field);
  });
});

// Metro's default `assetExts`, then the ones `@expo/metro-config` adds (packages/@expo/metro-config/src/ExpoMetroConfig.ts).
const METRO_ASSET_EXTS = [
  "bmp",
  "gif",
  "jpg",
  "jpeg",
  "png",
  "psd",
  "svg",
  "webp",
  "xml",
  "m4v",
  "mov",
  "mp4",
]
  .concat([
    "mpeg",
    "mpg",
    "webm",
    "aac",
    "aiff",
    "caf",
    "m4a",
    "mp3",
    "wav",
    "html",
    "pdf",
    "yaml",
    "yml",
  ])
  .concat(["otf", "ttf", "zip"]);
const EXPO_ASSET_EXTS = ["woff", "woff2", "heic", "avif", "db"];

describe("assetContentType", () => {
  test.each([
    ["bundle", "application/javascript"],
    ["hbc", "application/javascript"],
    ["png", "image/png"],
    ["PNG", "image/png"],
    ["jpeg", "image/jpeg"],
    ["heic", "image/heic"],
    ["woff2", "font/woff2"],
    ["db", "application/vnd.sqlite3"],
  ])("%s is %s", (ext, type) => {
    expect(assetContentType(ext)).toBe(type);
  });

  test.each(["", "zzz", ".png", "constructor", "__proto__", "toString", "hasOwnProperty"])(
    "%j falls back to application/octet-stream",
    (ext) => {
      expect(assetContentType(ext)).toBe("application/octet-stream");
    },
  );

  test("every extension a default Expo project bundles has a known type", () => {
    for (const ext of [...METRO_ASSET_EXTS, ...EXPO_ASSET_EXTS]) {
      expect(assetContentType(ext), ext).not.toBe("application/octet-stream");
    }
  });

  test("every type passes buildManifest as an asset contentType", () => {
    for (const ext of [...METRO_ASSET_EXTS, ...EXPO_ASSET_EXTS, "bundle", "js", "hbc"]) {
      const d = draft();
      d.asset.contentType = assetContentType(ext);
      expect(text(build(d))).toContain(`"contentType":"${assetContentType(ext)}"`);
    }
  });
});

describe("directives", () => {
  test("noUpdateAvailable equals its golden bytes", () => {
    expect(buildNoUpdateAvailable()).toEqual(fixture("directive-no-update.json"));
  });

  test("rollBackToEmbedded equals its golden bytes", () => {
    const commitTime = new Date("2026-11-19T08:09:10.123Z");
    expect(buildRollBackToEmbedded({ commitTime })).toEqual(fixture("directive-rollback.json"));
  });

  test("rollBackToEmbedded writes commitTime with milliseconds", () => {
    const commitTime = new Date(Date.UTC(2026, 0, 2));
    expect(text(buildRollBackToEmbedded({ commitTime }))).toBe(
      '{"type":"rollBackToEmbedded","parameters":{"commitTime":"2026-01-02T00:00:00.000Z"}}',
    );
  });

  test.each<[string, unknown, string]>([
    ["an invalid commitTime", { commitTime: new Date(Number.NaN) }, "commitTime"],
    ["an ISO string commitTime", { commitTime: "2026-11-19T00:00:00.000Z" }, "commitTime"],
    ["a missing commitTime", {}, "commitTime"],
    ["a null input", null, "input"],
    ["an undefined input", undefined, "input"],
  ])("rollBackToEmbedded rejects %s", async (_, input, field) => {
    await rejects(() => buildRollBackToEmbedded(loose(input)), field);
  });
});

describe("sfv", () => {
  test.each<[Record<string, string>, string]>([
    [{ branchname: "main" }, 'branchname="main"'],
    [
      { branchname: "main", "rollout-group*.v2": "a b" },
      'branchname="main", rollout-group*.v2="a b"',
    ],
    [{ note: 'say "hi" \\ bye' }, 'note="say \\"hi\\" \\\\ bye"'],
    [{}, ""],
  ])("encodes %o", (members, header) => {
    expect(encodeSfvDictionary(members)).toBe(header);
  });

  test.each<[string, Record<string, unknown>, string]>([
    ["an uppercase key", { Branch: "main" }, "Branch"],
    ["a leading digit", { "1branch": "main" }, "1branch"],
    ["a non-ASCII value", { branch: "café" }, "branch"],
    ["a non-string value", { branch: 1 }, "branch"],
  ])("rejects %s", async (_, members, field) => {
    await rejects(() => encodeSfvDictionary(loose(members)), field);
  });

  const str = (text: string) => ({ kind: "string", text });
  test.each<[string, string, [string, object][]]>([
    ["escaped strings", 'a="say \\"hi\\" \\\\ bye"', [["a", str('say "hi" \\ bye')]]],
    ["the empty header", "", []],
    [
      "surrounding and separating whitespace",
      '  a="x" ,\tb="y"\t',
      [
        ["a", str("x")],
        ["b", str("y")],
      ],
    ],
    [
      "parameters, which are dropped",
      'a="x";p=1;q;r="s", b="y"',
      [
        ["a", str("x")],
        ["b", str("y")],
      ],
    ],
    [
      "a repeated key, last wins",
      'a="1", b="2", a="3"',
      [
        ["a", str("3")],
        ["b", str("2")],
      ],
    ],
    [
      "every other item by kind",
      't=tok/en:x, i=-42, d=1.125, bs=:aGk=:, z=::, b=?0, l=("a" b;p=1);q, e=(), bare;p',
      [
        ["t", { kind: "token", text: "tok/en:x" }],
        ["i", { kind: "number" }],
        ["d", { kind: "number" }],
        ["bs", { kind: "bytes" }],
        ["z", { kind: "bytes" }],
        ["b", { kind: "boolean" }],
        ["l", { kind: "inner-list" }],
        ["e", { kind: "inner-list" }],
        ["bare", { kind: "boolean" }],
      ],
    ],
  ])("parses %s", (_, header, members) => {
    expect([...parseSfvDictionary(header, "h")]).toEqual(members);
  });

  test.each<[string, string, string]>([
    ["an uppercase key", 'A="x"', "expected a key"],
    ["a missing value", "a=", "expected an item"],
    ["a trailing comma", 'a="x",', "trailing comma"],
    ["a missing comma", 'a="x" b="y"', "expected ,"],
    ["an unterminated string", 'a="x', "unterminated"],
    ["a bad escape", 'a="\\q"', "bad escape"],
    ["a non-ASCII string", 'a="café"', "bad string character"],
    ["four decimal places", "a=1.2345", "bad number"],
    ["a 16-digit integer", "a=1234567890123456", "bad number"],
    ["a trailing decimal point", "a=1.", "bad number"],
    ["a boolean ?2", "a=?2", "bad boolean"],
    ["an unclosed inner list", "a=(1 2", "expected space or )"],
    ["a comma in an inner list", "a=(1,2)", "expected space or )"],
    ["a bad byte sequence", "a=:ab$:", "bad byte sequence"],
    // Both stock clients decode byte sequences, even in ignored parameters, and neither takes these.
    ["an undecodable byte sequence", "a=:A:", "bad byte sequence"],
    ["an undecodable byte-sequence parameter", 'a="x";p=:A:', "bad byte sequence"],
    ["unpadded base64", "a=:aGk:", "bad byte sequence"],
    ["excess padding", "a=:aGk==:", "bad byte sequence"],
    ["padding mid-sequence", "a=:a=Gk:", "bad byte sequence"],
    ["an RFC 9651 date", "a=@1", "expected an item"],
  ])("parse rejects %s", async (_, header, message) => {
    await rejects(() => parseSfvDictionary(header, "h"), "h", message);
  });
});

const B = BOUNDARY;
const part = (name: PartName, body: Uint8Array<ArrayBuffer>): Part => ({ name, body });
const SIGNATURE = 'sig="a", keyid="main"';
const GOLDEN_PARTS = { ...TIDE_GOLDEN, ...EXPO_GOLDEN };
const GOLDEN = Object.keys(GOLDEN_PARTS);

/** A golden's parts from their source files, each signed part carrying the signature parsed from the golden. */
function golden(file: string): Promise<Part[]> {
  const parsed = parseMultipart(fixture(file), B);
  return goldenParts(GOLDEN_PARTS[file] ?? [], fixture, (_, i) => parsed[i]?.signature ?? "none");
}

/** Frames parts by hand, independently of encodeMultipart. */
function frame(...parts: [headers: string[], body: string][]): Uint8Array<ArrayBuffer> {
  const framed = parts.map(
    ([headers, body]) => `--${B}\r\n${headers.join("\r\n")}\r\n\r\n${body}\r\n`,
  );
  return ascii(`${framed.join("")}--${B}--\r\n`);
}
const DIRECTIVE = [
  'Content-Disposition: form-data; name="directive"',
  "Content-Type: application/json",
];
const MANIFEST = [
  'Content-Disposition: form-data; name="manifest"',
  "Content-Type: application/json",
];

/** A Uint8Array whose slice is a view, as Node's Buffer.slice is. */
class AliasingBytes extends Uint8Array<ArrayBuffer> {
  override slice(start?: number, end?: number) {
    return this.subarray(start, end);
  }
}

describe("multipart", () => {
  test.each(GOLDEN)("encoding the parts of %s gives its bytes", async (file) => {
    expect(encodeMultipart(await golden(file), B)).toEqual({ boundary: B, body: fixture(file) });
  });

  test.each(GOLDEN)("parsing %s gives its parts and exact bodies", async (file) => {
    const parsed = parseMultipart(fixture(file), B);
    expect(parsed).toEqual(await golden(file));
  });

  test("the noUpdateAvailable response carries the builder's directive bytes", () => {
    const [directive] = parseMultipart(fixture("no-update.multipart"), B);
    expect(directive?.name).toBe("directive");
    expect(directive?.body).toEqual(buildNoUpdateAvailable());
  });

  test("the certificate chain part is sent as a PEM file with the chain's exact bytes", () => {
    const parsed = parseMultipart(fixture("expo.multipart"), B);
    expect(text(fixture("expo.multipart"))).toContain(
      'name="certificate_chain"\r\nContent-Type: application/x-pem-file\r\n',
    );
    expect(parsed[1]).toEqual({ name: "certificate_chain", body: fixture("expo-chain.pem") });
  });

  test("parsed bodies do not alias the input", () => {
    const file = fixture("manifest.multipart");
    const source = new AliasingBytes(new ArrayBuffer(file.length + 8));
    source.set(file, 8);
    const parsed = parseMultipart(source.subarray(8), B);
    source.fill(0);
    expect(parsed[0]!.body).toEqual(fixture("manifest.json"));
  });

  test("a signature is written as the lowercase expo-signature line stock iOS clients look up", () => {
    const signed: Part = { name: "manifest", body: ascii("{}"), signature: SIGNATURE };
    const encoded = encodeMultipart([signed], B).body;
    expect(encoded).toEqual(frame([[...MANIFEST, `expo-signature: ${SIGNATURE}`], "{}"]));
    expect(parseMultipart(encoded, B)).toEqual([signed]);
  });

  test("parse reads the signature header in any case", () => {
    const parsed = parseMultipart(frame([[...MANIFEST, `Expo-Signature: ${SIGNATURE}`], "{}"]), B);
    expect(parsed).toEqual([{ name: "manifest", body: ascii("{}"), signature: SIGNATURE }]);
  });

  test("a drawn boundary is 32 hex characters and round-trips", () => {
    const { boundary, body } = encodeMultipart([part("directive", buildNoUpdateAvailable())]);
    expect(boundary).toMatch(/^[0-9a-f]{32}$/);
    expect(parseMultipart(body, boundary)[0]!.body).toEqual(buildNoUpdateAvailable());
  });

  test.each<[string, () => Uint8Array<ArrayBuffer>, string, string]>([
    [
      "a missing closing boundary",
      () => fixture("no-update.multipart").slice(0, -`\r\n--${B}--\r\n`.length),
      "body",
      "missing the closing boundary",
    ],
    [
      "a part without Content-Disposition",
      () => frame([["Content-Type: application/json"], "{}"]),
      "parts[0]",
      "missing Content-Disposition",
    ],
    [
      "duplicate part names",
      () => frame([DIRECTIVE, "{}"], [DIRECTIVE, "{}"]),
      "parts[1]",
      "duplicates another part name",
    ],
    [
      "an unknown part name",
      () => frame([['Content-Disposition: form-data; name="other"', DIRECTIVE[1]!], "{}"]),
      "parts[0]",
      "known part name",
    ],
    [
      "a preamble",
      () => ascii(`preamble\r\n${text(fixture("no-update.multipart"))}`),
      "body",
      "must start",
    ],
    [
      "bytes after the closing boundary",
      () => ascii(`${text(fixture("no-update.multipart"))}x`),
      "body",
      "must end",
    ],
    ["zero parts", () => ascii(`--${B}--\r\n`), "body", "must start"],
    [
      "a wrong Content-Type",
      () => frame([[DIRECTIVE[0]!, "Content-Type: text/plain"], "{}"]),
      "parts[0]",
      "Content-Type",
    ],
    [
      "a non-ASCII header value",
      () => frame([[...DIRECTIVE, "expo-signature: café"], "{}"]),
      "parts[0].headers[2]",
      "ASCII",
    ],
    [
      "a header that is not a part header",
      () => frame([[...DIRECTIVE, "x-note: a"], "{}"]),
      "parts[0].headers[2]",
      "is not a part header",
    ],
    [
      "a header line without a colon",
      () => frame([[...DIRECTIVE, "expo-signature"], "{}"]),
      "parts[0].headers[2]",
      "name: value",
    ],
    [
      "a header name that is not a token",
      () => frame([[...DIRECTIVE, "expo signature: a"], "{}"]),
      "parts[0].headers[2]",
      "RFC 9110 token",
    ],
    [
      "header names differing only in case",
      () => frame([[...DIRECTIVE, "expo-signature: a", "Expo-Signature: b"], "{}"]),
      "parts[0].headers[3]",
      "duplicates",
    ],
    [
      "the boundary mid-line in a body",
      () => frame([DIRECTIVE, `{"note":"x${B}y"}`]),
      "parts[0]",
      "contains the boundary",
    ],
    [
      "the boundary in a header value",
      () => frame([[...DIRECTIVE, `expo-signature: ${B}`], "{}"]),
      "parts[0]",
      "contains the boundary",
    ],
  ])("parse rejects %s", async (_, body, field, message) => {
    await rejects(() => parseMultipart(body(), B), field, message);
  });

  test.each<[string, unknown]>([
    ["an empty boundary", ""],
    ["a boundary inside an array", [B]],
  ])("parse rejects %s", async (_, boundary) => {
    await rejects(
      () => parseMultipart(fixture("no-update.multipart"), loose(boundary)),
      "boundary",
    );
  });

  const json = ascii("{}");
  test.each<[string, () => [Part[], string?], string]>([
    ["zero parts", () => [[]], "parts"],
    ["an unknown part name", () => [[part(loose("other"), json)]], "parts[0].name"],
    [
      "duplicate part names",
      () => [[part("manifest", json), part("manifest", json)]],
      "parts[1].name",
    ],
    ["a boundary inside an array", () => [[part("manifest", json)], loose([B])], "boundary"],
    ["a boundary with a space", () => [[part("manifest", json)], "a b"], "boundary"],
    ["the boundary in a body", () => [[part("manifest", ascii(`{"a":"${B}"}`))], B], "parts[0]"],
    [
      "the boundary only in the signature",
      () => [[{ ...part("manifest", json), signature: `a${B}` }], B],
      "parts[0]",
    ],
    [
      "CRLF in the signature",
      () => [[{ ...part("manifest", json), signature: "a\r\nx-injected: 1" }]],
      "parts[0].signature",
    ],
    [
      "a non-ASCII signature",
      () => [[{ ...part("manifest", json), signature: "café" }]],
      "parts[0].signature",
    ],
    [
      "an empty signature",
      () => [[{ ...part("manifest", json), signature: "" }]],
      "parts[0].signature",
    ],
    [
      "a signature that is not a string",
      () => [[{ ...part("manifest", json), signature: loose({ sig: "a", keyid: "main" }) }]],
      "parts[0].signature",
    ],
    [
      "a header list spread into an object",
      () => [[loose({ ...part("manifest", json), headers: { 0: ["expo-signature", SIGNATURE] } })]],
      "parts[0].headers",
    ],
  ])("encode rejects %s", async (_, args, field) => {
    const [parts, boundary] = args();
    await rejects(() => encodeMultipart(parts, boundary), field);
  });
});

const header = (sig: string, rest = ', keyid="main", alg="rsa-v1_5-sha256"') =>
  `sig="${sig}"${rest}`;
const sigOf = (h: string) => /sig="([^"]*)"/.exec(h)?.[1] ?? "";

/** Returns `make()`'s promise, made on first use, so key generation runs once per file. */
function once<T>(make: () => Promise<T>): () => Promise<T> {
  let made: Promise<T> | undefined;
  return () => (made ??= make());
}
const rsa = (hash: string) => () =>
  crypto.subtle.generateKey({ ...RSA_SHA256, hash }, true, ["sign", "verify"]);
const mainKeys = once(rsa("SHA-256"));
const otherKeys = once(rsa("SHA-256"));
const sha1Keys = once(rsa("SHA-1"));
const ecKeys = once(() =>
  crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]),
);
const mainCertificate = once(async () => {
  const keys = await mainKeys();
  return certificate(keys.publicKey, keys.privateKey, new Date());
});

describe("signature", () => {
  test("expoSignature is the SFV form of the RSA signature and verifies through the certificate", async () => {
    const keys = await mainKeys();
    const body = fixture("manifest.json");
    const raw = new Uint8Array(await crypto.subtle.sign(RSA_SHA256, keys.privateKey, body));
    const h = await expoSignature(body, cryptoKeySigner(keys.privateKey, "main"));
    expect(h).toBe(`sig="${base64(raw)}", keyid="main", alg="rsa-v1_5-sha256"`);
    const key = await certificatePublicKey(await mainCertificate());
    await expect(verifyExpoSignature(body, h, key, "main")).resolves.toBeUndefined();
  });

  test("a header without keyid or alg verifies as root with the default algorithm", async () => {
    const keys = await mainKeys();
    const body = fixture("manifest.json");
    const h = await expoSignature(body, cryptoKeySigner(keys.privateKey, "root"));
    await expect(
      verifyExpoSignature(body, header(sigOf(h), ""), keys.publicKey, "root"),
    ).resolves.toBeUndefined();
  });

  test("parameters, a token member and an earlier duplicate sig do not change the verdict", async () => {
    const keys = await mainKeys();
    const body = fixture("manifest.json");
    const sig = sigOf(await expoSignature(body, cryptoKeySigner(keys.privateKey, "main")));
    const h = `sig="AAAA", sig="${sig}";p=1, keyid="main";q, t=tok`;
    await expect(verifyExpoSignature(body, h, keys.publicKey, "main")).resolves.toBeUndefined();
  });

  test.each<[string, (sig: string) => string, string, string]>([
    [
      "an unknown alg",
      (s) => header(s, ', keyid="main", alg="rsa-v1_5-sha512"'),
      "signature.alg",
      "must be rsa-v1_5-sha256",
    ],
    ["a keyid mismatch", (s) => header(s, ', keyid="other"'), "signature.keyid", "must be main"],
    ["an absent keyid, which means root", (s) => header(s, ""), "signature.keyid", "must be main"],
    ["a header that is not SFV", (s) => `sig="${s}`, "signature", "RFC 8941"],
    ["sig as a token", () => "sig=abc", "signature", "sig must be a string"],
    ["sig as a byte sequence", (s) => `sig=:${s}:`, "signature", "sig must be a string"],
    ["a missing sig", () => 'keyid="main"', "signature", "sig must be a string"],
    ["unpadded base64", (s) => header(s.replace(/=+$/, "")), "signature", "padded base64"],
    ["base64url", () => header("-_-_"), "signature", "padded base64"],
    ["non-canonical base64", () => header("AB=="), "signature", "padded base64"],
    ["an empty sig", () => header(""), "signature", "padded base64"],
    ["keyid as a token", (s) => header(s, ", keyid=root"), "signature", "keyid must be a string"],
    [
      "an undecodable byte-sequence parameter",
      (s) => `${header(s)};p=:A:`,
      "signature",
      "bad byte sequence",
    ],
    // iOS reads the whole dictionary as [String: String], so any member but a string or token fails there.
    [
      "a boolean member",
      (s) => `${header(s)}, flag=?1`,
      "signature",
      "flag must be a string or token",
    ],
    ["a bare key", (s) => `${header(s)}, flag`, "signature", "flag must be a string or token"],
    ["a number member", (s) => `${header(s)}, n=1`, "signature", "n must be a string or token"],
    [
      "a byte-sequence member",
      (s) => `${header(s)}, b=:aGk=:`,
      "signature",
      "b must be a string or token",
    ],
    [
      "an inner-list member",
      (s) => `${header(s)}, l=("a")`,
      "signature",
      "l must be a string or token",
    ],
    [
      "alg as a boolean",
      (s) => header(s, ', keyid="main", alg=?1'),
      "signature",
      "alg must be a string",
    ],
  ])("verify rejects %s", async (_, make, field, message) => {
    const keys = await mainKeys();
    const body = fixture("manifest.json");
    const sig = sigOf(await expoSignature(body, cryptoKeySigner(keys.privateKey, "main")));
    await rejects(
      () => verifyExpoSignature(body, make(sig), keys.publicKey, "main"),
      field,
      message,
    );
  });

  test("verify rejects other bytes and another key's signature", async () => {
    const [keys, other] = [await mainKeys(), await otherKeys()];
    const body = fixture("manifest.json");
    const h = await expoSignature(body, cryptoKeySigner(keys.privateKey, "main"));
    const wrong = fixture("directive-no-update.json");
    await rejects(() => verifyExpoSignature(wrong, h, keys.publicKey, "main"), "signature.sig");
    const byOther = await expoSignature(body, cryptoKeySigner(other.privateKey, "main"));
    await rejects(
      () => verifyExpoSignature(body, byOther, keys.publicKey, "main"),
      "signature.sig",
    );
  });

  test("a SHA-1 signature labelled rsa-v1_5-sha256 never verifies", async () => {
    const sha1 = await sha1Keys();
    const body = fixture("manifest.json");
    const h = header(
      base64(new Uint8Array(await crypto.subtle.sign(RSA_SHA256, sha1.privateKey, body))),
    );
    await rejects(() => verifyExpoSignature(body, h, sha1.publicKey, "main"), "key", "SHA-256");
    const spki = await crypto.subtle.exportKey("spki", sha1.publicKey);
    const asSha256 = await crypto.subtle.importKey("spki", spki, RSA_SHA256, false, ["verify"]);
    await rejects(() => verifyExpoSignature(body, h, asSha256, "main"), "signature.sig");
  });

  test("verify rejects a private key", async () => {
    const keys = await mainKeys();
    await rejects(
      () => verifyExpoSignature(fixture("manifest.json"), header("AAAA"), keys.privateKey, "main"),
      "key",
      "public",
    );
  });

  test("cryptoKeySigner rejects a SHA-1 key and a public key", async () => {
    const [sha1, keys] = [await sha1Keys(), await mainKeys()];
    await rejects(() => cryptoKeySigner(sha1.privateKey, "main"), "key", "SHA-256");
    await rejects(() => cryptoKeySigner(keys.publicKey, "main"), "key", "private");
  });

  test.each<[string, string, string]>([
    ["an empty keyId", "", "keyId"],
    ["a non-ASCII keyId", "clé", "keyId"],
    ["a keyId with a newline", "a\nb", "keyId"],
  ])("expoSignature rejects %s before the signer runs", async (_, keyId, field) => {
    let calls = 0;
    const signer: Signer = {
      keyId,
      sign: () => {
        calls++;
        return Promise.resolve(new Uint8Array([1]));
      },
    };
    await rejects(() => expoSignature(fixture("manifest.json"), signer), field);
    expect(calls).toBe(0);
  });

  test.each<[string, unknown]>([
    ["empty bytes", new Uint8Array()],
    ["an ArrayBuffer", new ArrayBuffer(4)],
    ["a string", "sig"],
  ])("expoSignature rejects a signer resolving %s", async (_, result) => {
    const signer: Signer = { keyId: "main", sign: () => Promise.resolve(loose(result)) };
    await rejects(() => expoSignature(fixture("manifest.json"), signer), "signer");
  });
});

/** The DER of a PEM certificate. */
const derOf = (text: string) => decodeBase64(text.replace(/-----[^-]+-----|\n/g, ""))!;

describe("certificate", () => {
  test.each<[string, (der: Uint8Array<ArrayBuffer>) => string, string]>([
    [
      "no CERTIFICATE block",
      () => "-----BEGIN PUBLIC KEY-----\nAAAA\n-----END PUBLIC KEY-----\n",
      "no CERTIFICATE block",
    ],
    ["bad base64", (d) => pem(d).replace("\n", "\n!"), "canonical base64"],
    ["a space inside the base64", (d) => pem(d).replace("\n", "\n "), "canonical base64"],
    [
      "an empty block",
      () => "-----BEGIN CERTIFICATE-----\n-----END CERTIFICATE-----\n",
      "canonical base64",
    ],
    ["truncated DER", (d) => pem(d.subarray(0, -1)), "truncated"],
    [
      "an indefinite length",
      () => pem(new Uint8Array([0x30, 0x80, 0x00, 0x00])),
      "minimal and definite",
    ],
    [
      "a long-form length below 128",
      () => pem(new Uint8Array([0x30, 0x81, 0x03, 0x02, 0x01, 0x00])),
      "minimal and definite",
    ],
    [
      "a length with a leading zero octet",
      (d) => pem(new Uint8Array([0x30, 0x83, 0x00, ...d.subarray(2)])),
      "minimal and definite",
    ],
    [
      "an extra child in the envelope",
      (d) => pem(rewrap(d, [0x05, 0x00])),
      "exactly SEQUENCE { tbs, algorithm, signature }",
    ],
    [
      "bytes after the certificate",
      (d) => pem(new Uint8Array([...d, 0x00])),
      "bytes after the DER",
    ],
    ["a high tag number", () => pem(new Uint8Array([0x1f, 0x01, 0x00])), "high DER tag number"],
    [
      "an empty TBSCertificate",
      () => pem(new Uint8Array([0x30, 7, 0x30, 0, 0x30, 0, 3, 1, 0])),
      "malformed TBSCertificate",
    ],
    ["a non-sequence envelope", () => pem(new Uint8Array([0x04, 0x00])), "expected a DER SEQUENCE"],
  ])("certificatePublicKey rejects %s", async (_, make, message) => {
    const der = derOf(await mainCertificate());
    await rejects(() => certificatePublicKey(make(der)), "certificate", message);
  });

  test("certificatePublicKey rejects a certificate for an EC key", async () => {
    const ec = await ecKeys();
    const pemText = await certificate(ec.publicKey, (await mainKeys()).privateKey, new Date());
    await rejects(() => certificatePublicKey(pemText), "certificate", "RSA public key");
  });
});

const smallKeys = once(() =>
  crypto.subtle.generateKey({ ...RSA_SHA256, modulusLength: 1024 }, true, ["sign", "verify"]),
);
const DAY = 86_400_000;

describe("codeSigningCertificate", () => {
  test("the committed certificate.pem passes, fingerprinted by the SHA-256 of its DER", async () => {
    const pemText = text(fixture("certificate.pem"));
    const { key, sha256 } = await codeSigningCertificate(pemText, new Date());
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", derOf(pemText)));
    expect(sha256).toBe(hex(digest));
    const body = fixture("manifest.json");
    const [part] = parseMultipart(fixture("manifest.multipart"), B);
    await expect(verifyExpoSignature(body, part!.signature!, key, "main")).resolves.toBeUndefined();
  });

  test.each<[string, CertificateOptions]>([
    ["a GeneralizedTime notAfter from 2050", { notAfter: new Date("2051-01-01T00:00:00Z") }],
    [
      "an algorithm identifier without parameters",
      {
        outerAlgorithm: ALGORITHM.sha256WithRsaNoParameters,
        innerAlgorithm: ALGORITHM.sha256WithRsaNoParameters,
      },
    ],
  ])("a certificate with %s passes", async (_, options) => {
    const keys = await mainKeys();
    const pemText = await certificate(keys.publicKey, keys.privateKey, new Date(), options);
    const { sha256 } = await codeSigningCertificate(pemText, new Date());
    expect(sha256).toBe(hex(new Uint8Array(await crypto.subtle.digest("SHA-256", derOf(pemText)))));
  });

  const now = new Date();
  test.each<[string, CertificateOptions, string]>([
    ["one not valid yet", { notBefore: new Date(now.getTime() + DAY) }, "is not valid yet"],
    [
      "an expired one",
      { notBefore: new Date(now.getTime() - 2 * DAY), notAfter: new Date(now.getTime() - DAY) },
      "has expired",
    ],
    ["no Key Usage", { extensions: [EXTENSION.codeSigning] }, "Key Usage digitalSignature"],
    [
      "Key Usage without digitalSignature",
      { extensions: [EXTENSION.keyCertSignOnly, EXTENSION.codeSigning] },
      "Key Usage digitalSignature",
    ],
    [
      "no Extended Key Usage",
      { extensions: [EXTENSION.digitalSignature] },
      "Extended Key Usage codeSigning",
    ],
    [
      "Extended Key Usage without codeSigning",
      { extensions: [EXTENSION.digitalSignature, EXTENSION.serverAuthOnly] },
      "Extended Key Usage codeSigning",
    ],
    [
      "Expo project information",
      {
        extensions: [
          EXTENSION.digitalSignature,
          EXTENSION.codeSigning,
          EXTENSION.projectInformation,
        ],
      },
      "must not carry Expo project information",
    ],
    // OpenSSL rejects this; Web Crypto alone would accept it.
    [
      "Key Usage twice",
      {
        extensions: [EXTENSION.digitalSignature, EXTENSION.digitalSignature, EXTENSION.codeSigning],
      },
      "repeats an extension",
    ],
    // Apple's certificate parser refuses these two, so iOS would reject every signature.
    [
      "a Key Usage unused-bit count over 7",
      { extensions: [EXTENSION.digitalSignatureUnusedBits8, EXTENSION.codeSigning] },
      "has a malformed extension",
    ],
    [
      "an Extended Key Usage entry that is not an OID",
      { extensions: [EXTENSION.digitalSignature, EXTENSION.codeSigningAndBoolean] },
      "has a malformed extension",
    ],
    ["another issuer name", { issuer: "Other CA" }, "must be self-issued"],
    [
      "an unsupported signature algorithm",
      { outerAlgorithm: ALGORITHM.sha384WithRsa, innerAlgorithm: ALGORITHM.sha384WithRsa },
      "must be signed with sha256WithRSAEncryption",
    ],
    // Web Crypto verifies the TBS under the outer SHA-256 while Node rejects the certificate.
    [
      "an inner SHA-384 identifier under an outer SHA-256 one",
      { innerAlgorithm: ALGORITHM.sha384WithRsa },
      "must name the same signature algorithm",
    ],
    ["version 1", { v1: true }, "must be X.509 v3"],
  ])("rejects %s", async (_, options, message) => {
    const keys = await mainKeys();
    const pemText = await certificate(keys.publicKey, keys.privateKey, now, options);
    await rejects(() => codeSigningCertificate(pemText, now), "certificate", message);
  });

  test("rejects a self-signature made by another key", async () => {
    const [keys, other] = [await mainKeys(), await otherKeys()];
    const pemText = await certificate(keys.publicKey, other.privateKey, now);
    await rejects(
      () => codeSigningCertificate(pemText, now),
      "certificate",
      "self-signature that does not verify",
    );
  });

  test("rejects a 1024-bit key", async () => {
    const small = await smallKeys();
    const pemText = await certificate(small.publicKey, small.privateKey, now);
    await rejects(() => codeSigningCertificate(pemText, now), "certificate", "2048 to 4096 bits");
  });

  test("rejects an EC key", async () => {
    const [ec, keys] = [await ecKeys(), await mainKeys()];
    const pemText = await certificate(ec.publicKey, keys.privateKey, now);
    await rejects(() => codeSigningCertificate(pemText, now), "certificate", "RSA public key");
  });

  test("passes CRLF line ends and blank lines around the block", async () => {
    const pemText = await mainCertificate();
    for (const ok of [pemText.replaceAll("\n", "\r\n"), `\n \n${pemText}\n\n`]) {
      await expect(codeSigningCertificate(ok, new Date())).resolves.toBeDefined();
    }
  });

  test("rejects PEM text the iOS decoder cannot read", async () => {
    const pemText = await mainCertificate();
    for (const bad of [
      `\uFEFF${pemText}`,
      ` ${pemText}`,
      pemText.replace("\n-----END", "-----END"),
      pemText.replace("CERTIFICATE-----\n", "CERTIFICATE----- \n"),
      pemText.replace("-----END CERTIFICATE-----", "-----END CERTIFICATE----- "),
    ]) {
      await rejects(() => codeSigningCertificate(bad, now), "certificate", "exactly one PEM");
    }
  });

  test("rejects two certificates and text around one", async () => {
    const pemText = await mainCertificate();
    for (const bad of [pemText + pemText, `subject=Tide\n${pemText}`]) {
      await rejects(() => codeSigningCertificate(bad, now), "certificate", "exactly one PEM");
    }
  });
});

/** Returns the certificate DER with `extra` appended inside its outer SEQUENCE; the outer length takes two octets. */
function rewrap(der: Uint8Array, extra: number[]): Uint8Array<ArrayBuffer> {
  const body = [...der.subarray(4), ...extra];
  return new Uint8Array([0x30, 0x82, body.length >> 8, body.length & 0xff, ...body]);
}

describe("signed goldens", () => {
  test.each(Object.keys(TIDE_GOLDEN))(
    "every signed part of %s verifies against certificate.pem as main",
    async (file) => {
      const key = await certificatePublicKey(text(fixture("certificate.pem")));
      const signed = parseMultipart(fixture(file), B).filter((p) => p.signature !== undefined);
      expect(signed.length).toBe(TIDE_GOLDEN[file]?.filter((p) => p.signed).length);
      for (const p of signed)
        await expect(
          verifyExpoSignature(p.body, p.signature!, key, "main"),
        ).resolves.toBeUndefined();
    },
  );

  test("the generator's fixtures carry the committed parts, signed for its certificate", async () => {
    const keys = await mainKeys();
    const key = await certificatePublicKey(await mainCertificate());
    const files = await signedFixtures(fixture, cryptoKeySigner(keys.privateKey, "main"));
    expect(Object.keys(files)).toEqual(Object.keys(TIDE_GOLDEN));
    const shape = (bytes: Uint8Array<ArrayBuffer>) =>
      parseMultipart(bytes, B).map(({ name, body, signature }) => [name, body, !signature]);
    for (const [file, bytes] of Object.entries(files)) {
      expect(shape(bytes)).toEqual(shape(fixture(file)));
      for (const p of parseMultipart(bytes, B).filter((p) => p.signature !== undefined))
        await expect(
          verifyExpoSignature(p.body, p.signature!, key, "main"),
        ).resolves.toBeUndefined();
    }
  });

  test("the expo-updates directive verifies against the chain's leaf as root", async () => {
    const [directive] = parseMultipart(fixture("expo.multipart"), B);
    const leaf = await certificatePublicKey(text(fixture("expo-chain.pem")));
    await expect(
      verifyExpoSignature(directive!.body, directive!.signature!, leaf, "root"),
    ).resolves.toBeUndefined();
  });

  test("the expo-updates directive with one body byte changed fails", async () => {
    const [directive] = parseMultipart(fixture("expo.multipart"), B);
    const leaf = await certificatePublicKey(text(fixture("expo-chain.pem")));
    const body = new Uint8Array(directive!.body);
    body[10]! ^= 0x01;
    await rejects(
      () => verifyExpoSignature(body, directive!.signature!, leaf, "root"),
      "signature.sig",
    );
  });
});

const latin1 = (bytes: Uint8Array) => Array.from(bytes, (b) => String.fromCharCode(b)).join("");
function join(chunks: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

const seed = inject("fcSeed");

describe(`properties (seed ${seed})`, () => {
  const tricky = ["\r\n", "--", "\r\n--", "\r\n\r\n", "b", "tide", "-"].map(ascii);
  const body = fc
    .array(fc.oneof(fc.uint8Array({ maxLength: 32 }), fc.constantFrom(...tricky)), { maxLength: 8 })
    .map(join);
  const parts = fc.uniqueArray(
    fc.record(
      {
        name: fc.constantFrom<PartName>("manifest", "directive", "extensions", "certificate_chain"),
        body,
        signature: fc.stringMatching(/^[!-~](?:[ !-~]{0,40}[!-~])?$/),
      },
      { requiredKeys: ["name", "body"] },
    ),
    { selector: (p) => p.name, minLength: 1, maxLength: 4 },
  );
  const boundary = fc.option(
    fc.oneof(fc.constantFrom("b", "tide", "-"), fc.stringMatching(/^[0-9A-Za-z_-]{1,70}$/)),
    { nil: undefined },
  );

  const TYPES: Record<PartName, string> = {
    manifest: "application/json",
    directive: "application/json",
    extensions: "application/json",
    certificate_chain: "application/x-pem-file",
  };
  /** Everything the encoder writes for a part apart from delimiters. */
  const wire = (p: Part) =>
    `Content-Disposition: form-data; name="${p.name}"\r\nContent-Type: ${TYPES[p.name]}\r\n` +
    (p.signature === undefined ? "" : `expo-signature: ${p.signature}\r\n`) +
    latin1(p.body);

  test("parse(encode(parts)) returns the same names, signatures and body bytes", () => {
    fc.assert(
      fc.property(parts, boundary, (ps, b) => {
        if (b !== undefined && ps.some((p) => wire(p).includes(b))) {
          expect(() => encodeMultipart(ps, b)).toThrow(ProtocolError);
          return;
        }
        const encoded = encodeMultipart(ps, b);
        const parsed = parseMultipart(encoded.body, encoded.boundary);
        expect(parsed).toEqual(ps);
      }),
      { seed },
    );
  });

  test("a signed manifest verifies, and any flipped byte of body or signature fails", async () => {
    const keys = await mainKeys();
    const signer = cryptoKeySigner(keys.privateKey, "main");
    await fc.assert(
      fc.asyncProperty(
        fc.uuid(),
        fc.string({ minLength: 1 }),
        fc.dictionary(fc.string(), fc.jsonValue(), { maxKeys: 4 }),
        fc.boolean(),
        fc.nat(),
        fc.integer({ min: 1, max: 255 }),
        async (id, runtimeVersion, extra, inSignature, at, mask) => {
          const d = draft();
          Object.assign(d.input, { id, runtimeVersion, extra });
          const body = build(d);
          const h = await expoSignature(body, signer);
          await verifyExpoSignature(body, h, keys.publicKey, "main");
          const sig = decodeBase64(sigOf(h))!;
          const flipped = new Uint8Array(inSignature ? sig : body);
          flipped[at % flipped.length]! ^= mask;
          const [b, s] = inSignature ? [body, header(base64(flipped))] : [flipped, h];
          await rejects(() => verifyExpoSignature(b, s, keys.publicKey, "main"), "signature.sig");
        },
      ),
      { seed },
    );
  });

  test("every hash is canonical and keys to its digest", async () => {
    await fc.assert(
      fc.asyncProperty(fc.uint8Array({ maxLength: 256 }), async (bytes) => {
        const copy = new Uint8Array(bytes);
        const hash = await sha256Base64Url(copy);
        expect(assetHash(hash, "hash")).toBe(hash);
        expect(contentKey(hash)).toBe(
          hex(new Uint8Array(await crypto.subtle.digest("SHA-256", copy))),
        );
      }),
      { seed },
    );
  });
});

describe("stored reply", () => {
  const goldenReply = (file: string): StoredReply => {
    const { multipart, reply } = TIDE_REPLY_GOLDEN[file]!;
    return { ...reply, body: fixture(multipart) };
  };
  const manifestReply = () => goldenReply("manifest.reply.json");
  const utf8 = (s: string) => new Uint8Array(new TextEncoder().encode(s));
  /** The manifest golden as a JSON object a case can break, then its UTF-8 bytes. */
  const record = (change: (o: Record<string, unknown>) => void) => {
    const o = JSON.parse(text(fixture("manifest.reply.json"))) as Record<string, unknown>;
    change(o);
    return utf8(JSON.stringify(o));
  };
  /** A manifest reply whose record is exactly `size` bytes, padding an ASCII body. */
  const replyOfSize = (size: number): StoredReply => {
    const overhead = encodeStoredReply({ ...manifestReply(), body: ascii("a") }).length - 1;
    return { ...manifestReply(), body: ascii("a".repeat(size - overhead)) };
  };

  test.each(Object.keys(TIDE_REPLY_GOLDEN))("encoding %s's fields gives its bytes", (file) => {
    expect(encodeStoredReply(goldenReply(file))).toEqual(fixture(file));
  });

  test.each(Object.keys(TIDE_REPLY_GOLDEN))(
    "decoding %s gives its fields and the multipart's exact bytes",
    (file) => {
      const decoded = decodeStoredReply(fixture(file));
      expect(decoded).toEqual(goldenReply(file));
      expect(decoded.body).toEqual(fixture(TIDE_REPLY_GOLDEN[file]!.multipart));
    },
  );

  test("the generator wraps the multiparts it is given", () => {
    const files = replyGoldens(fixture);
    for (const file of Object.keys(TIDE_REPLY_GOLDEN)) expect(files[file]).toEqual(fixture(file));
  });

  const directive = (change: (o: Record<string, unknown>) => void) => {
    const o = JSON.parse(text(fixture("rollback.reply.json"))) as Record<string, unknown>;
    change(o);
    return utf8(JSON.stringify(o));
  };
  test.each<[string, () => Uint8Array, string, string]>([
    ["malformed JSON", () => ascii('{"version":1,'), "record", "is not JSON"],
    ["invalid UTF-8", () => new Uint8Array([0x7b, 0xff, 0x7d]), "record", "is not UTF-8"],
    ["a JSON array", () => ascii("[]"), "record", "must be a JSON object"],
    ["JSON null", () => ascii("null"), "record", "must be a JSON object"],
    ["an empty object", () => ascii("{}"), "version", "is missing"],
    ["a string version", () => record((o) => (o.version = "1")), "version", "must be an integer"],
    ["version 1.5", () => record((o) => (o.version = 1.5)), "version", "must be an integer"],
    [
      "version 2 with every other field invalid",
      () => ascii('{"version":2,"kind":5,"body":5}'),
      "version",
      "is not supported",
    ],
    ["a missing kind", () => record((o) => delete o.kind), "kind", "is missing"],
    ["a missing updateId", () => record((o) => delete o.updateId), "updateId", "is missing"],
    [
      "a missing contentType",
      () => record((o) => delete o.contentType),
      "contentType",
      "is missing",
    ],
    [
      "missing manifestFilters",
      () => record((o) => delete o.manifestFilters),
      "manifestFilters",
      "is missing",
    ],
    ["a missing body", () => record((o) => delete o.body), "body", "is missing"],
    ["an unknown kind", () => record((o) => (o.kind = "patch")), "kind", "must be manifest"],
    ["a numeric updateId", () => record((o) => (o.updateId = 5)), "updateId", "lowercase UUID"],
    [
      "an uppercase updateId",
      () => record((o) => (o.updateId = String(o.updateId).toUpperCase())),
      "updateId",
      "lowercase UUID",
    ],
    [
      "a contentType without a boundary",
      () => record((o) => (o.contentType = "multipart/mixed")),
      "contentType",
      "must be multipart/mixed",
    ],
    [
      "another contentType",
      () => record((o) => (o.contentType = "application/json; boundary=b")),
      "contentType",
      "must be multipart/mixed",
    ],
    [
      "a boundary with a space",
      () => record((o) => (o.contentType = "multipart/mixed; boundary=a b")),
      "contentType",
      "must be multipart/mixed",
    ],
    [
      "numeric manifestFilters",
      () => record((o) => (o.manifestFilters = 1)),
      "manifestFilters",
      "must be a string",
    ],
    ["an empty body", () => record((o) => (o.body = "")), "body", "non-empty string"],
    ["a numeric body", () => record((o) => (o.body = 5)), "body", "non-empty string"],
    [
      "a body with a lone surrogate",
      () => ascii(text(record((o) => (o.body = "X"))).replace('"X"', '"\\ud800"')),
      "body",
      "is not well-formed Unicode",
    ],
    [
      "updateId on a directive",
      () => directive((o) => (o.updateId = "0f6a9a3e-6c1b-4c4e-9d55-2b8f3f7c1a90")),
      "updateId",
      "is not a field of a rollBackToEmbedded reply",
    ],
    [
      "an unknown field",
      () => record((o) => (o.createdAt = "now")),
      "createdAt",
      "is not a field of a manifest reply",
    ],
    [
      "a record one byte over the limit",
      () => new Uint8Array(MAX_REPLY_BYTES + 1),
      "record",
      "is too large",
    ],
  ])("decode rejects %s", async (_, bytes, field, message) => {
    await rejects(() => decodeStoredReply(bytes()), field, message);
  });

  test("decode keeps a leading U+FEFF in the body", () => {
    const body = utf8("﻿--b\r\n");
    const reply: StoredReply = { kind: "noUpdateAvailable", boundary: "b", body };
    expect(decodeStoredReply(encodeStoredReply(reply)).body).toEqual(body);
  });

  const filtersAtLimit = `a="${"x".repeat(MAX_FILTERS_BYTES - 4)}"`;
  test.each([
    "branchname=",
    "a=1",
    "a=?1",
    "a=tok",
    'a="x";p=1',
    'a=("x")',
    "a=:AA==:",
    'a="x", a="y"',
    'a="x" ,b="y"',
    'a="x",b="y"',
    'a="x\r"',
    `a="${"x".repeat(MAX_FILTERS_BYTES - 3)}"`,
  ])("encode and decode reject the filters %j", async (filters) => {
    const reply = { ...manifestReply(), manifestFilters: filters };
    await rejects(() => encodeStoredReply(reply), "manifestFilters");
    await rejects(
      () => decodeStoredReply(record((o) => (o.manifestFilters = filters))),
      "manifestFilters",
    );
  });

  test.each(["", 'a="x"', 'a="x", b="y \\"z\\"", c*.d-e_f="\\\\"', filtersAtLimit])(
    "encode and decode accept the filters %j",
    (filters) => {
      expect(filtersAtLimit.length).toBe(MAX_FILTERS_BYTES);
      const reply = { ...manifestReply(), manifestFilters: filters };
      expect(decodeStoredReply(encodeStoredReply(reply))).toEqual(reply);
    },
  );

  const base = () => ({ ...manifestReply() }) as Record<string, unknown>;
  // Encode checks its output with decode, so each failure names the record field decode reports.
  test.each<[string, () => Record<string, unknown>, string]>([
    ["an unknown kind", () => ({ ...base(), kind: "patch" }), "kind"],
    ["a missing updateId", () => ({ ...base(), updateId: undefined }), "updateId"],
    [
      "an uppercase updateId",
      () => ({ ...base(), updateId: "0F6A9A3E-6C1B-4C4E-9D55-2B8F3F7C1A90" }),
      "updateId",
    ],
    ["a boundary with a space", () => ({ ...base(), boundary: "a b" }), "contentType"],
    ["an empty body", () => ({ ...base(), body: new Uint8Array() }), "body"],
    ["a string body", () => ({ ...base(), body: "--b" }), "body"],
    ["a body that is not UTF-8", () => ({ ...base(), body: new Uint8Array([0xc3]) }), "body"],
    ["a record one byte over the limit", () => replyOfSize(MAX_REPLY_BYTES + 1), "record"],
  ])("encode rejects %s", async (_, reply, field) => {
    const r = reply();
    // An undefined field stands for a missing one.
    for (const [k, v] of Object.entries(r)) if (v === undefined) Reflect.deleteProperty(r, k);
    await rejects(() => encodeStoredReply(loose(r)), field);
  });

  test("encode writes only the fields of the reply's kind", () => {
    const rollback = goldenReply("rollback.reply.json");
    const extra = loose<StoredReply>({ ...rollback, updateId: base().updateId, createdAt: "now" });
    expect(encodeStoredReply(extra)).toEqual(fixture("rollback.reply.json"));
  });

  test("encode accepts a record of exactly the limit", () => {
    const bytes = encodeStoredReply(replyOfSize(MAX_REPLY_BYTES));
    expect(bytes.length).toBe(MAX_REPLY_BYTES);
    expect(decodeStoredReply(bytes)).toEqual(replyOfSize(MAX_REPLY_BYTES));
  });

  const ALL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789._+-";
  test.each<[string, string, string]>([
    ["main", "1.0.0", "reply/main/1.0.0/ios"],
    [ALL.slice(0, 64), ALL.slice(4), `reply/${ALL.slice(0, 64)}/${ALL.slice(4)}/ios`],
    ["...", "a+b", "reply/.../a+b/ios"],
    ["main", "1.0.0(1)", "reply/main/1.0.0(1)/ios"],
    ["main", "exposdk:57.0.0", "reply/main/exposdk:57.0.0/ios"],
  ])("replyKey accepts %s and %s", (channel, runtime, key) => {
    expect(replyKey(channel, runtime, "ios")).toBe(key);
    expect(replyKey(channel, runtime, "android")).toBe(key.replace(/ios$/, "android"));
  });

  test.each<[string, string, string, string]>([
    ["an empty channel", "", "1", "channel"],
    ["65 characters", "a".repeat(65), "1", "channel"],
    ["a /", "a/b", "1", "channel"],
    ["a . channel", ".", "1", "channel"],
    ["a .. channel", "..", "1", "channel"],
    ["a space", "a b", "1", "channel"],
    ["a comma", "a,b", "1", "channel"],
    ["a %", "a%2Fb", "1", "channel"],
    ["non-ASCII", "café", "1", "channel"],
    ["a .. runtime", "main", "..", "runtimeVersion"],
    ["an empty runtime", "main", "", "runtimeVersion"],
  ])("replyKey rejects %s", async (_, channel, runtime, field) => {
    await rejects(() => replyKey(channel, runtime, "ios"), field);
  });

  test("replyKey rejects an unknown platform", async () => {
    await rejects(() => replyKey("main", "1", "web"), "platform");
    await rejects(() => replyKey("main", "1", "IOS"), "platform");
  });

  test.each<[string, string]>([
    ["reply/main/1.0.0/ios", "reply/main/1_2e0_2e0/ios"],
    ["reply/Main/1/android", "reply/_4dain/1/android"],
    ["reply/no-update/1/ios", "reply/no_2dupdate/1/ios"],
    ["reply/a_b/a+b/ios", "reply/a_5fb/a_2bb/ios"],
    ["reply/main/1.0.0(1)/ios", "reply/main/1_2e0_2e0_281_29/ios"],
    ["reply/main/exposdk:57.0.0/ios", "reply/main/exposdk_3a57_2e0_2e0/ios"],
    [NO_UPDATE_KEY, NO_UPDATE_KEY],
    [LEGACY_MAP_KEY, LEGACY_MAP_KEY],
    [`assets/${PNG_HEX}`, `assets/${PNG_HEX}`],
    [`bundles/${PNG_HEX}`, `bundles/${PNG_HEX}`],
    [
      "updates/0f6a9a3e-6c1b-4c4e-9d55-2b8f3f7c1a90.json",
      "updates/0f6a9a3e-6c1b-4c4e-9d55-2b8f3f7c1a90.json",
    ],
    [`bases/${ID}`, `bases/${ID}`],
    [`patches/${PNG_HEX}/${LAUNCH_HEX}`, `patches/${PNG_HEX}/${LAUNCH_HEX}`],
  ])("diskPath maps %s to %s", (key, path) => {
    expect(diskPath(key)).toBe(path);
  });

  test.each([
    "reply/../x/ios",
    `reply/${"a".repeat(65)}/1/ios`,
    "reply/a/b/web",
    "reply/a/b/ios/x",
    "reply/a/b",
    "assets/../x",
    `assets/${PNG_HEX.toUpperCase()}`,
    `bundles/${PNG_HEX.slice(1)}`,
    "updates/0F6A9A3E-6C1B-4C4E-9D55-2B8F3F7C1A90.json",
    "updates/0f6a9a3e-6c1b-4c4e-9d55-2b8f3f7c1a90",
    "updates/../reply/no-update",
    "legacy/Map.json",
    "legacy/map.json/x",
    "legacy/map",
    "lock",
    "",
    ...BAD_PATCH_KEYS,
  ])("diskPath rejects %j", async (key) => {
    await rejects(() => diskPath(key), "key");
  });

  const name = fc.stringMatching(/^[A-Za-z0-9._+-]{1,64}$/).filter((n) => n !== "." && n !== "..");

  test(`diskPath names stay distinct after case folding (seed ${seed})`, () => {
    fc.assert(
      fc.property(name, name, (a, b) => {
        fc.pre(a !== b);
        const [pa, pb] = [diskPath(replyKey(a, "1", "ios")), diskPath(replyKey(b, "1", "ios"))];
        expect(pa.toLowerCase()).not.toBe(pb.toLowerCase());
        expect(pa.split("/")[1]).toMatch(/^[a-z0-9_]+$/);
      }),
      { seed },
    );
  });

  test(`decode(encode(reply)) returns the same fields and body bytes (seed ${seed})`, () => {
    const filters = fc
      .dictionary(
        fc.stringMatching(/^[a-z*][a-z0-9_.*-]{0,8}$/),
        fc.stringMatching(/^[\x20-\x7E]{0,16}$/),
        { maxKeys: 4 },
      )
      .map(encodeSfvDictionary);
    const reply = fc.oneof(
      fc.record({
        kind: fc.constant("manifest" as const),
        updateId: fc.uuid(),
        boundary: fc.stringMatching(/^[0-9A-Za-z_-]{1,70}$/),
        manifestFilters: filters,
        body: fc.string({ unit: "binary", minLength: 1 }).map(utf8),
      }),
      fc.record({
        kind: fc.constantFrom("rollBackToEmbedded" as const, "noUpdateAvailable" as const),
        boundary: fc.stringMatching(/^[0-9A-Za-z_-]{1,70}$/),
        body: fc.string({ unit: "binary", minLength: 1 }).map(utf8),
      }),
    );
    fc.assert(
      fc.property(reply, (r) => {
        const decoded = decodeStoredReply(encodeStoredReply(r));
        expect(decoded).toEqual(r);
        expect(decoded.body).toEqual(r.body);
      }),
      { seed },
    );
  });
});

describe("s3", () => {
  // https://docs.aws.amazon.com/AmazonS3/latest/API/sig-v4-header-based-auth.html, "Examples: Signature Calculations".
  const AWS_EXAMPLE = {
    accessKeyId: "AKIAIOSFODNN7EXAMPLE",
    secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    region: "us-east-1",
    service: "s3",
  };
  const host = "examplebucket.s3.amazonaws.com";
  const signed = (headers: string, signature: string) =>
    `AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request,` +
    `SignedHeaders=${headers},Signature=${signature}`;
  const emptyGet = {
    Host: host,
    "x-amz-content-sha256": EMPTY_SHA256,
    "x-amz-date": "20130524T000000Z",
  };

  test.each<[string, string, string, Record<string, string>, string]>([
    [
      "GET Object",
      "GET",
      "/test.txt",
      { ...emptyGet, Range: "bytes=0-9" },
      signed(
        "host;range;x-amz-content-sha256;x-amz-date",
        "f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41",
      ),
    ],
    [
      "PUT Object",
      "PUT",
      "/test$file.text",
      {
        Host: host,
        Date: "Fri, 24 May 2013 00:00:00 GMT",
        "x-amz-storage-class": "REDUCED_REDUNDANCY",
        "x-amz-content-sha256": "44ce7dd67c959e0d3524ffac1771dfbba87d2b6b4b4e99e42034a8b803f8b072",
        "x-amz-date": "20130524T000000Z",
      },
      signed(
        "date;host;x-amz-content-sha256;x-amz-date;x-amz-storage-class",
        "98ad721746da40c64f1a55b78f14c238d841ea1380cd77a1b5971af0ece108bd",
      ),
    ],
    [
      "GET Bucket Lifecycle",
      "GET",
      "/?lifecycle",
      emptyGet,
      signed(
        "host;x-amz-content-sha256;x-amz-date",
        "fea454ca298b7da1c68078a5d1bdbfbbe0d65c699e0f91ac7a200a0136783543",
      ),
    ],
    ...["/?max-keys=2&prefix=J", "/?prefix=J&max-keys=2"].map(
      (path) =>
        [
          `GET Bucket (List Objects) as ${path}`,
          "GET",
          path,
          emptyGet,
          signed(
            "host;x-amz-content-sha256;x-amz-date",
            "34b48302e7b5fa45bde8084f4b7868a86f0a534bc59db6670ed5711ef69dc6f7",
          ),
        ] as [string, string, string, Record<string, string>, string],
    ),
  ])("signV4 reproduces AWS's %s example", async (_, method, path, headers, expected) => {
    const url = new URL(`https://${host}${path}`);
    expect(await signV4({ method, url, headers }, AWS_EXAMPLE)).toBe(expected);
  });

  const valid = {
    endpoint: "https://s3.example.com",
    region: "auto",
    bucket: "tide",
    accessKeyId: "AKIAIOSFODNN7EXAMPLE",
    secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
  };

  test.each<[string, Partial<typeof valid>, string]>([
    ...["a/b", "..", "x", "//evil.example", "b?x=1", "b#f", "B%2Fc", "Tide"].map(
      (bucket) =>
        [`the bucket ${bucket}`, { bucket }, "bucket"] as [string, Partial<typeof valid>, string],
    ),
    ["a region with /", { region: "us/east" }, "region"],
    ["an access key ID with ,", { accessKeyId: "AKIAIOSFODNN7EX,MPLE" }, "accessKeyId"],
    ["an access key ID of 15 characters", { accessKeyId: "A".repeat(15) }, "accessKeyId"],
    ["a secret of 15 characters", { secretAccessKey: "s".repeat(15) }, "secretAccessKey"],
    ["a secret with a space", { secretAccessKey: "secret with a space" }, "secretAccessKey"],
    ["the endpoint ftp://s3.test", { endpoint: "ftp://s3.test" }, "endpoint"],
  ])("s3Target rejects %s without echoing it", async (_, change, field) => {
    await rejects(() => s3Target({ ...valid, ...change }), field);
    const value = Object.values(change)[0] ?? "";
    let message = "";
    try {
      s3Target({ ...valid, ...change });
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).not.toContain(value);
  });

  test("storageFromEnv names the variable of a rejected field and never its value", () => {
    const env = {
      TIDE_S3_ENDPOINT: valid.endpoint,
      TIDE_S3_REGION: valid.region,
      TIDE_S3_BUCKET: "a/b",
      TIDE_S3_ACCESS_KEY_ID: valid.accessKeyId,
      TIDE_S3_SECRET_ACCESS_KEY: valid.secretAccessKey,
    };
    expect(() => storageFromEnv(env)).toThrow(/^TIDE_S3_BUCKET: bucket must be/);
    expect(storageFromEnv({ ...env, TIDE_S3_BUCKET: "tide" })).toEqual({ s3: valid });
    expect(storageFromEnv({ TIDE_DISK_DIR: "/srv/tide", TIDE_S3_REGION: "" })).toEqual({
      disk: "/srv/tide",
    });
  });

  test("an S3 error names only an allowlisted code", () => {
    expect(new S3Error("GetObject", { status: 403, code: "AccessDenied" }).message).toBe(
      "S3 GetObject failed: 403 AccessDenied",
    );
    expect(new S3Error("PutObject", { status: 403, code: valid.secretAccessKey }).message).toBe(
      "S3 PutObject failed: 403 with an unrecognised error code",
    );
    expect(new S3Error("ListObjectsV2", "network")).toMatchObject({
      message: "S3 ListObjectsV2 failed: network error",
      status: undefined,
    });
  });

  test.each<[string, string]>([
    ["reply/no-update", NO_UPDATE_KEY],
    ["legacy/map.json", LEGACY_MAP_KEY],
    [`assets/${PNG_HEX}`, `assets/${PNG_HEX}`],
    ["reply/_4dain/1_2e0_2e0/ios", "reply/Main/1.0.0/ios"],
    ["reply/main/exposdk_3a57_2e0_2e0/android", "reply/main/exposdk:57.0.0/android"],
    ["reply/no_2dupdate/1/ios", "reply/no-update/1/ios"],
    [`bases/${ID}`, `bases/${ID}`],
    [`patches/${PNG_HEX}/${LAUNCH_HEX}`, `patches/${PNG_HEX}/${LAUNCH_HEX}`],
  ])("diskKey maps %s back to %s", (path, key) => {
    expect(diskKey(path)).toBe(key);
    expect(diskPath(key)).toBe(path);
  });

  test.each([
    "reply/_61/1/ios", // `a` escaped although it needs no escape
    "reply/_4Dain/1/ios", // uppercase hex
    "reply/main/1/web",
    "reply/main",
    "reply",
    ".tide/mutex.sqlite",
    "updates/x.json",
    "reply/Main/1/ios", // the key, not its path
    `patches/${PNG_HEX}`, // a directory the disk walker descends into
  ])("diskKey rejects %j", (path) => {
    expect(diskKey(path)).toBeUndefined();
  });

  test("parseS3Xml reads an empty-element tag as an empty element, and entities as text", () => {
    const doc = (prefix: string) =>
      parseS3Xml(
        `<?xml version="1.0" encoding="UTF-8"?>\n<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">${prefix}<ETag>&quot;a&amp;b&#x21;&#33;&quot;</ETag></ListBucketResult>`,
      );
    for (const spelling of ["<Prefix/>", "<Prefix></Prefix>", "<Prefix />"]) {
      const root = doc(spelling);
      expect(root?.name).toBe("ListBucketResult");
      const [prefix] = childElements(root!, "Prefix");
      expect(textOf(prefix!)).toBe("");
      expect(textOf(childElements(root!, "ETag")[0]!)).toBe('"a&b!!"');
    }
  });

  test.each([
    ["a comment", "<Error><!-- x --><Code>A</Code></Error>"],
    ["CDATA", "<Error><Code><![CDATA[A]]></Code></Error>"],
    ["a DOCTYPE", "<!DOCTYPE Error><Error><Code>A</Code></Error>"],
    ["an unknown attribute", '<Error a="1"><Code>A</Code></Error>'],
    ["another namespace", '<Error xmlns="urn:x"><Code>A</Code></Error>'],
    [
      "a namespace on a child",
      '<Error><Code xmlns="http://s3.amazonaws.com/doc/2006-03-01/">A</Code></Error>',
    ],
    ["a prefixed name", "<s3:Error><Code>A</Code></s3:Error>"],
    ["trailing content", "<Error><Code>A</Code></Error><Error/>"],
    ["an unclosed element", "<Error><Code>A</Error>"],
    ["a bare &", "<Error><Code>A&B</Code></Error>"],
    ["an unknown entity", "<Error><Code>&nbsp;</Code></Error>"],
    ["a reference to NUL", "<Error><Code>&#0;</Code></Error>"],
    ["a processing instruction", "<Error><?x y?><Code>A</Code></Error>"],
  ])("parseS3Xml rejects %s", (_, text) => {
    expect(parseS3Xml(text)).toBeUndefined();
  });

  test("parseS3Xml does not recurse, so deep nesting cannot exhaust the stack", () => {
    const depth = 200_000;
    expect(parseS3Xml(`${"<a>".repeat(depth)}${"</a>".repeat(depth)}`)?.name).toBe("a");
  });

  const errorResponse = (body: string) => new Response(body, { status: 404 });

  test.each<[string, string, string | undefined]>([
    [
      "a NoSuchKey document",
      '<?xml version="1.0" encoding="UTF-8"?>\n<Error><Code>NoSuchKey</Code><Message>m</Message></Error>',
      "NoSuchKey",
    ],
    ["a nested Code", "<Error><Detail><Code>NoSuchKey</Code></Detail></Error>", undefined],
    ["two Code children", "<Error><Code>NoSuchKey</Code><Code>NoSuchKey</Code></Error>", undefined],
    ["a Code holding an element", "<Error><Code><b>NoSuchKey</b></Code></Error>", undefined],
    ["a truncated document", "<Error><Code>NoSuchKey</Code>", undefined],
    ["another root", "<Result><Code>NoSuchKey</Code></Result>", undefined],
    ["HTML", "<h1>Not Found</h1>", undefined],
    [
      "more than 4 KiB",
      `<Error><Code>NoSuchKey</Code><Message>${"m".repeat(4096)}</Message></Error>`,
      undefined,
    ],
  ])("s3ErrorCode of %s", async (_, body, code) => {
    expect(await s3ErrorCode(errorResponse(body))).toBe(code);
  });

  test("s3BodyProblem never echoes a header value", () => {
    const res = (headers: Record<string, string>) => new Response("x", { headers });
    expect(s3BodyProblem(res({ "content-length": "1" }))).toBeUndefined();
    expect(
      s3BodyProblem(res({ "content-length": "1", "content-encoding": "identity" })),
    ).toBeUndefined();
    const problem = s3BodyProblem(
      res({ "content-length": "1", "content-encoding": valid.accessKeyId }),
    );
    expect(problem).toBe("encoding");
    const message = new S3Error("GetObject", { problem: problem! }).message;
    expect(message).toBe("S3 GetObject returned 200 with an unsupported content-encoding");
    expect(s3BodyProblem(res({ "content-length": "x1" }))).toBe("length");
  });
});

describe("base record", () => {
  const EMBEDDED_ID = "7c0e1f52-3a9d-4b8e-8f21-5d6c4b3a2e10";
  const UPDATE: BaseRecord = {
    kind: "update",
    updateId: ID,
    runtimeVersion: "1.0.0",
    platform: "ios",
    launchAsset: { hash: LAUNCH_HASH },
  };
  const EMBEDDED: BaseRecord = {
    kind: "embedded",
    updateId: EMBEDDED_ID,
    runtimeVersion: "1.0.0(1)",
    platform: "android",
    launchAsset: { hash: LAUNCH_HASH },
    assets: [
      { key: "Ab12", hash: PNG_HASH }, // Equal to ab12 but for case, with the same hash: both kept.
      { key: "ab12", hash: PNG_HASH },
      { key: "icon_2x", hash: EMPTY_HASH },
    ],
  };
  const golden = (file: string) => text(fixture(file));
  const embedded = (assets: unknown) => loose<BaseRecord>({ ...EMBEDDED, assets });

  test.each<[string, BaseRecord]>([
    ["base-update.json", UPDATE],
    ["base-embedded.json", EMBEDDED],
  ])("%s decodes to its fields and re-encodes to the same bytes", (file, record) => {
    expect(decodeBaseRecord(fixture(file))).toEqual(record);
    expect(encodeBaseRecord(record)).toEqual(fixture(file));
  });

  const update = golden("base-update.json");
  const emb = golden("base-embedded.json");
  test.each<[string, string, string, string]>([
    [
      "a reordered key",
      update.replace(`"kind":"update","updateId":"${ID}"`, `"updateId":"${ID}","kind":"update"`),
      "record",
      "is not in the form",
    ],
    ["an extra key", update.replace(/}$/, ',"note":"x"}'), "record", "is not in the form"],
    ["a missing key", update.replace(',"platform":"ios"', ""), "platform", ""],
    ["a trailing newline", `${update}\n`, "record", "is not in the form"],
    ["inner whitespace", update.replace('"version":1,', '"version": 1,'), "record", "is not in"],
    ["an escaped character", update.replace('"ios"', '"\\u0069os"'), "record", "is not in"],
    ["a non-canonical number", update.replace('"version":1,', '"version":1.0,'), "record", ""],
    ["version 2", update.replace('"version":1', '"version":2'), "version", "is not supported"],
    ['version "1"', update.replace('"version":1', '"version":"1"'), "version", "an integer"],
    ["no version", update.replace('"version":1,', ""), "version", "an integer"],
    ["an array", "[]", "record", "must be a JSON object"],
    ["an uppercase UUID", update.replace(ID, ID.toUpperCase()), "updateId", ""],
    ["a bad runtime version", update.replace('"1.0.0"', '"1 0"'), "runtimeVersion", ""],
    ["a bad platform", update.replace('"ios"', '"web"'), "platform", ""],
    [
      "a non-canonical hash",
      update.replace(LAUNCH_HASH, `${LAUNCH_HASH.slice(0, 42)}R`),
      "launchAsset.hash",
      "",
    ],
    ["an unknown kind", update.replace('"update"', '"build"'), "kind", ""],
    ["an update with assets", update.replace(/}$/, ',"assets":[]}'), "record", "is not in the"],
    [
      "an extra launchAsset key",
      update.replace(`"hash":"${LAUNCH_HASH}"`, `"hash":"${LAUNCH_HASH}","x":1`),
      "record",
      "is not in the form",
    ],
    [
      "an extra asset key",
      emb.replace(`{"key":"ab12","hash":"${PNG_HASH}"`, `{"key":"ab12","hash":"${PNG_HASH}","x":1`),
      "record",
      "is not in the form",
    ],
    ["an embedded build without assets", emb.replace(/,"assets":.*}$/, "}"), "assets", "an array"],
    [
      "unsorted assets",
      emb.replace('{"key":"Ab12"', '{"key":"zz","hash":"' + PNG_HASH + '"},{"key":"Ab12"'),
      "record",
      "is not in the form",
    ],
    [
      "a repeated asset",
      emb.replace('{"key":"Ab12"', `{"key":"Ab12","hash":"${PNG_HASH}"},{"key":"Ab12"`),
      "record",
      "is not in the form",
    ],
    [
      "keys equal but for case with two hashes",
      emb.replace(`{"key":"ab12","hash":"${PNG_HASH}"}`, `{"key":"ab12","hash":"${EMPTY_HASH}"}`),
      "assets[1].key",
      "names another hash",
    ],
  ])("decode refuses %s", async (_, record, field, message) => {
    await rejects(() => decodeBaseRecord(ascii(record)), field, message);
  });

  test("decode refuses a record over the cap before parsing it, and non-UTF-8", async () => {
    await rejects(
      () => decodeBaseRecord(new Uint8Array(MAX_BASE_BYTES + 1).fill(0x20)),
      "record",
      "is too large",
    );
    const bad = ascii(update);
    bad[bad.indexOf(0x69)] = 0xff; // The `i` of "ios".
    await rejects(() => decodeBaseRecord(bad), "record", "is not UTF-8 JSON");
  });

  test("encode collapses repeated key-and-hash entries and leaves its input as it was", () => {
    const assets = [
      { key: "icon_2x", hash: EMPTY_HASH },
      { key: "ab12", hash: PNG_HASH },
      { key: "Ab12", hash: PNG_HASH },
      { key: "icon_2x", hash: EMPTY_HASH }, // Expo lists one entry per scale.
      { key: "Ab12", hash: PNG_HASH },
    ];
    const before = structuredClone(assets);
    expect(encodeBaseRecord(embedded(assets))).toEqual(fixture("base-embedded.json"));
    expect(assets).toEqual(before);
  });

  test.each<[string, unknown, string, string]>([
    [
      "one key with two hashes",
      [
        { key: "a", hash: PNG_HASH },
        { key: "a", hash: EMPTY_HASH },
      ],
      "assets[1].key",
      "names another hash",
    ],
    [
      "keys equal but for case with two hashes",
      [
        { key: "ab", hash: PNG_HASH },
        { key: "Ab", hash: EMPTY_HASH },
      ],
      "assets[0].key",
      "names another hash",
    ],
    ["assets that are not an array", {}, "assets", "must be an array"],
    ["an asset that is not an object", ["a"], "assets[0]", "must be an object"],
    ["a bad asset key", [{ key: "a.b", hash: PNG_HASH }], "assets[0].key", ""],
    ["an asset without a hash", [{ key: "a" }], "assets[0].hash", ""],
    [
      "a record over the cap",
      Array.from({ length: 2100 }, (_, i) => ({ key: `k${i}`.padEnd(64, "x"), hash: PNG_HASH })),
      "record",
      "is too large",
    ],
  ])("encode refuses %s", async (_, assets, field, message) => {
    await rejects(() => encodeBaseRecord(embedded(assets)), field, message);
  });

  test.each<[string, Record<string, unknown>, string]>([
    ["a numeric runtime version", { runtimeVersion: 1 }, "runtimeVersion"],
    ["a launch asset that is not an object", { launchAsset: "x" }, "launchAsset"],
  ])("encode refuses %s", async (_, change, field) => {
    await rejects(() => encodeBaseRecord(loose({ ...UPDATE, ...change })), field);
  });

  test(`decode(encode(r)) sorts assets and collapses repeats (seed ${seed})`, () => {
    const asset = fc.record({
      key: fc.stringMatching(/^[A-Za-z0-9_-]{1,64}$/),
      hash: fc.constantFrom(PNG_HASH, EMPTY_HASH, LAUNCH_HASH),
    });
    // Distinct keys after case folding, then exact repeats of some, in any order.
    const input = fc
      .tuple(
        fc.uniqueArray(asset, { selector: (a) => a.key.toLowerCase(), maxLength: 8 }),
        fc.array(fc.nat(), { maxLength: 6 }),
      )
      .chain(([unique, picks]) => {
        const repeats = unique.length === 0 ? [] : picks.map((i) => unique[i % unique.length]!);
        const all = [...unique, ...repeats].map((a) => ({ ...a }));
        return fc
          .shuffledSubarray(all, { minLength: all.length, maxLength: all.length })
          .map((assets) => ({ unique, assets }));
      });
    fc.assert(
      fc.property(input, ({ unique, assets }) => {
        const before = structuredClone(assets);
        const sorted = [...unique].sort((a, b) => (a.key < b.key ? -1 : 1));
        expect(decodeBaseRecord(encodeBaseRecord(embedded(assets)))).toEqual(embedded(sorted));
        expect(assets).toEqual(before);
      }),
      { seed },
    );
  });

  test(`a one-byte change to a golden refuses or re-encodes to itself (seed ${seed})`, () => {
    fc.assert(
      fc.property(
        fc.constantFrom("base-update.json", "base-embedded.json"),
        fc.nat(),
        fc.integer({ min: 1, max: 255 }),
        (file, at, mask) => {
          const bytes = fixture(file);
          bytes[at % bytes.length]! ^= mask;
          let record: BaseRecord;
          try {
            record = decodeBaseRecord(bytes);
          } catch (e) {
            expect(e).toBeInstanceOf(ProtocolError);
            return;
          }
          expect(encodeBaseRecord(record)).toEqual(bytes);
        },
      ),
      { seed },
    );
  });
});

describe("applyBsdiff", () => {
  const MAX_OUTPUT = 128 * 1024 * 1024;
  const sha256 = async (bytes: Uint8Array<ArrayBuffer>) =>
    hex(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)));
  const GOLDEN = ["text", "binary", "identical", "empty-base", "empty-target"];

  test.each(GOLDEN)("the reference patch %s reproduces its target", async (name) => {
    const target = fixture(`patch-${name}.target`);
    const out = applyBsdiff(
      fixture(`patch-${name}.base`),
      fixture(`patch-${name}.bsdiff`),
      target.length,
    );
    expect(await sha256(out)).toBe(await sha256(target));
  });

  test.each(GOLDEN.filter((name) => name !== "empty-target"))(
    "the reference patch %s refuses a maxOutput one below its target",
    async (name) => {
      const max = fixture(`patch-${name}.target`).length - 1;
      await rejects(
        () => applyBsdiff(fixture(`patch-${name}.base`), fixture(`patch-${name}.bsdiff`), max),
        "patch",
        `declares an output over ${max} bytes`,
      );
    },
  );

  test.each([Number.NaN, Number.POSITIVE_INFINITY, -1, 1.5, 2 ** 53])(
    "refuses a maxOutput of %s, which would not cap the output",
    async (max) => {
      await rejects(
        () => applyBsdiff(fixture("patch-text.base"), fixture("patch-text.bsdiff"), max),
        "maxOutput",
        "must be a non-negative safe integer",
      );
    },
  );

  test("a ctrl block with an unused, valid Huffman group still reproduces the target", async () => {
    const out = applyBsdiff(
      fixture("patch-text.base"),
      fixture("patch-text-extra-group.bsdiff"),
      MAX_OUTPUT,
    );
    expect(await sha256(out)).toBe(await sha256(fixture("patch-text.target")));
  });

  test.each<[string, string, string]>([
    ["bad-magic", "patch", "does not start with BSDIFF40"],
    ["short-header", "patch", "is shorter than its 32-byte header"],
    ["negative-ctrl-len", "patch", "has a negative ctrl length"],
    ["negative-new-size", "patch", "has a negative output size"],
    ["ctrl-len-past-patch", "patch", "is shorter than its header's block lengths"],
    ["length-2-53", "patch", "has a diff length of 2^53 or more"],
    ["oversize-new-size", "patch", `declares an output over ${MAX_OUTPUT} bytes`],
    ["negative-add", "patch.ctrl", "has a negative length"],
    ["negative-zero-seek", "patch.ctrl", "has a negative zero"],
    ["add-past-output", "patch.ctrl", "adds past the output's end"],
    ["copy-past-output", "patch.ctrl", "copies past the output's end"],
    ["seek-before-base", "patch.ctrl", "seeks outside the base"],
    ["read-past-base", "patch.ctrl", "reads past the base's end"],
    ["leftover-triple", "patch.ctrl", "has data past its end"],
    ["zero-progress", "patch.ctrl", "decodes to more than"],
    ["unused-diff-byte", "patch.diff", "has data past its end"],
    ["truncated-extra", "patch.extra", "is truncated"],
    ["truncated-diff", "patch.diff", "is truncated"],
    ["bad-block-crc", "patch.ctrl", "has a bad block CRC"],
    ["bad-stream-crc", "patch.ctrl", "has a bad stream CRC"],
    ["randomised-block", "patch.ctrl", "has a randomised block"],
    ["huffman-unused", "patch.ctrl", "has an over-subscribed Huffman table"],
    ["trailing-byte", "patch.extra", "has data after the stream end"],
    ["second-stream", "patch.extra", "has data after the stream end"],
  ])("refuses patch-bad-%s.bsdiff", async (name, field, message) => {
    const patch = fixture(`patch-bad-${name}.bsdiff`);
    await rejects(() => applyBsdiff(fixture("patch-text.base"), patch, MAX_OUTPUT), field, message);
  });

  /** bspatch's loop over KNOWN_PATCH, written out for one base. */
  function knownTarget(base: Uint8Array): Uint8Array {
    const out = new Uint8Array(KNOWN_PATCH.newSize);
    let [newPos, oldPos, diffPos, extraPos] = [0, 0, 0, 0];
    for (const [add, copy, seek] of KNOWN_PATCH.triples) {
      for (let i = 0; i < add; i++) {
        out[newPos + i] = KNOWN_PATCH.diff[diffPos + i]! + base[oldPos + i]!;
      }
      out.set(KNOWN_PATCH.extra.subarray(extraPos, extraPos + copy), newPos + add);
      [newPos, oldPos, diffPos, extraPos] = [
        newPos + add + copy,
        oldPos + add + seek,
        diffPos + add,
        extraPos + copy,
      ];
    }
    return out;
  }

  test(`a patch with known triples applies to any base long enough (seed ${seed})`, () => {
    const patch = fixture("patch-known.bsdiff");
    fc.assert(
      fc.property(fc.uint8Array({ minLength: KNOWN_PATCH.minBase, maxLength: 256 }), (base) => {
        expect(applyBsdiff(base, patch, KNOWN_PATCH.newSize)).toEqual(knownTarget(base));
      }),
      { seed },
    );
    const short = new Uint8Array(KNOWN_PATCH.minBase - 1);
    expect(() => applyBsdiff(short, patch, KNOWN_PATCH.newSize)).toThrow(ProtocolError);
  });

  test(`a flipped, inserted or cut byte yields bytes or a ProtocolError (seed ${seed})`, () => {
    const name = fc.constantFrom("text", "binary", "identical", "empty-base", "empty-target");
    const edit = fc.oneof(
      fc.record({ op: fc.constant("flip"), at: fc.nat(), mask: fc.integer({ min: 1, max: 255 }) }),
      fc.record({
        op: fc.constant("insert"),
        at: fc.nat(),
        mask: fc.integer({ min: 0, max: 255 }),
      }),
      fc.record({ op: fc.constant("cut"), at: fc.nat(), mask: fc.constant(0) }),
    );
    fc.assert(
      fc.property(name, edit, (n, { op, at, mask }) => {
        const patch = fixture(`patch-${n}.bsdiff`);
        const i = at % patch.length;
        const edited =
          op === "flip"
            ? patch.map((b, j) => (j === i ? b ^ mask : b))
            : op === "insert"
              ? join([patch.subarray(0, i), new Uint8Array([mask]), patch.subarray(i)])
              : patch.slice(0, i);
        try {
          expect(applyBsdiff(fixture(`patch-${n}.base`), edited, MAX_OUTPUT)).toBeInstanceOf(
            Uint8Array,
          );
        } catch (e) {
          expect(e).toBeInstanceOf(ProtocolError);
        }
      }),
      { seed },
    );
  });
});

describe("bunzip2", () => {
  const MULTIBLOCK_LENGTH = 627_995;
  const MULTIBLOCK_SHA256 = "234067970bb655e627e7ebf13a0cf75863107d2480e6151501f1ab889e5411ac";
  const decode = (file: string, limit: number, chunks: readonly number[] = [limit + 1]) => {
    const reader = bunzip2(fixture(file), "stream", limit);
    const parts: Uint8Array[] = [];
    for (let i = 0; ; i++) {
      const into = new Uint8Array(chunks[i % chunks.length]!);
      const n = reader.read(into);
      parts.push(into.subarray(0, n));
      if (n < into.length) break;
    }
    reader.end();
    return join(parts);
  };
  const sha256 = async (bytes: Uint8Array<ArrayBuffer>) =>
    hex(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)));

  test("several blocks decode to their SHA-256 in one read", async () => {
    const out = decode("multiblock.bz2", MULTIBLOCK_LENGTH);
    expect(out.length).toBe(MULTIBLOCK_LENGTH);
    expect(await sha256(out)).toBe(MULTIBLOCK_SHA256);
  });

  test(`several blocks decode to their SHA-256 in reads of any size (seed ${seed})`, async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.integer({ min: 1, max: 200_000 }), { minLength: 1, maxLength: 8 }),
        async (chunks) => {
          expect(await sha256(decode("multiblock.bz2", MULTIBLOCK_LENGTH, chunks))).toBe(
            MULTIBLOCK_SHA256,
          );
        },
      ),
      { seed, numRuns: 20 },
    );
  });

  test("a stream that decodes past its limit refuses", async () => {
    await rejects(
      () => decode("multiblock.bz2", MULTIBLOCK_LENGTH - 1),
      "stream",
      `decodes to more than ${MULTIBLOCK_LENGTH - 1} bytes`,
    );
  });

  test("a block may end after a run's count byte, but not before it", async () => {
    expect(text(decode("bzip2-run-control.bz2", 5))).toBe("xaaaa");
    await rejects(
      () => decode("bzip2-run-at-block-end.bz2", 5),
      "stream",
      "has a block that ends inside a run",
    );
  });
});
