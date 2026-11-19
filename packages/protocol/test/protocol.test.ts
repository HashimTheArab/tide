import fc from "fast-check";
import { describe, expect, inject, test } from "vitest";

import type { ManifestInput, Part, PartName, Signer, StoredReply } from "../src/index.ts";
import { base64, decodeBase64 } from "../src/hash.ts";
import {
  MAX_FILTERS_BYTES,
  MAX_REPLY_BYTES,
  NO_UPDATE_KEY,
  ProtocolError,
  assetContentType,
  assetHash,
  buildManifest,
  buildNoUpdateAvailable,
  buildRollBackToEmbedded,
  certificatePublicKey,
  contentKey,
  cryptoKeySigner,
  decodeStoredReply,
  diskPath,
  encodeMultipart,
  encodeSfvDictionary,
  encodeStoredReply,
  expoSignature,
  parseMultipart,
  replyKey,
  sha256Base64Url,
  verifyExpoSignature,
} from "../src/index.ts";
import { parseSfvDictionary } from "../src/sfv.ts";
import {
  BOUNDARY,
  EXPO_GOLDEN,
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
    [`assets/${PNG_HEX}`, `assets/${PNG_HEX}`],
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
    "lock",
    "",
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
