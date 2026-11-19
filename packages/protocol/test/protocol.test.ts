import fc from "fast-check";
import { describe, expect, inject, test } from "vitest";

import type { Header, ManifestInput, Part, PartName } from "../src/index.ts";
import {
  ProtocolError,
  assetHash,
  buildManifest,
  buildNoUpdateAvailable,
  buildRollBackToEmbedded,
  contentKey,
  encodeMultipart,
  encodeSfvDictionary,
  parseMultipart,
  sha256Base64Url,
} from "../src/index.ts";

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

function rejects(run: () => unknown, field: string, message = ""): void {
  let error: unknown;
  try {
    run();
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
  ])("contentKey rejects %s", (_, hash) => {
    rejects(() => contentKey(loose(hash)), "hash");
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
  ])("buildManifest rejects %s", (_, field, change) => {
    const d = draft();
    change(d);
    rejects(() => build(d), field);
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
  ])("rollBackToEmbedded rejects %s", (_, input, field) => {
    rejects(() => buildRollBackToEmbedded(loose(input)), field);
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
  ])("rejects %s", (_, members, field) => {
    rejects(() => encodeSfvDictionary(loose(members)), field);
  });
});

const B = "tide_fixture_boundary";
const TYPES: Record<PartName, string> = {
  manifest: "application/json",
  directive: "application/json",
  extensions: "application/json",
  certificate_chain: "application/x-pem-file",
};
const fixedHeaders = (name: PartName): Header[] => [
  ["Content-Disposition", `form-data; name="${name}"`],
  ["Content-Type", TYPES[name]],
];
const part = (name: PartName, body: Uint8Array<ArrayBuffer>, headers: Header[] = []): Part => ({
  name,
  headers,
  body,
});

/** The golden multipart files and the parts they hold. */
function golden(): [string, Part[]][] {
  return [
    [
      "manifest.multipart",
      [
        part("manifest", fixture("manifest.json")),
        part("extensions", ascii('{"assetRequestHeaders":{}}')),
      ],
    ],
    ["rollback.multipart", [part("directive", fixture("directive-rollback.json"))]],
    ["no-update.multipart", [part("directive", fixture("directive-no-update.json"))]],
    [
      "certificate.multipart",
      [part("manifest", fixture("manifest.json")), part("certificate_chain", fixture("chain.pem"))],
    ],
  ];
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

/** A Uint8Array whose slice is a view, as Node's Buffer.slice is. */
class AliasingBytes extends Uint8Array<ArrayBuffer> {
  override slice(start?: number, end?: number) {
    return this.subarray(start, end);
  }
}

describe("multipart", () => {
  test.each(golden())("encoding the parts of %s gives its bytes", (file, parts) => {
    expect(encodeMultipart(parts, B)).toEqual({ boundary: B, body: fixture(file) });
  });

  test.each(golden())("parsing %s gives its headers and bodies", (file, parts) => {
    const parsed = parseMultipart(fixture(file), B);
    expect(parsed.map((p) => p.name)).toEqual(parts.map((p) => p.name));
    expect(parsed.map((p) => p.headers)).toEqual(parts.map((p) => fixedHeaders(p.name)));
    parsed.forEach((p, i) => expect(p.body).toEqual(parts[i]!.body));
  });

  test("the noUpdateAvailable response carries the builder's directive bytes", () => {
    const [directive] = parseMultipart(fixture("no-update.multipart"), B);
    expect(directive!.headers).toEqual([
      ["Content-Disposition", 'form-data; name="directive"'],
      ["Content-Type", "application/json"],
    ]);
    expect(directive!.body).toEqual(buildNoUpdateAvailable());
  });

  test("the certificate chain part is sent as a PEM file", () => {
    const parsed = parseMultipart(fixture("certificate.multipart"), B);
    expect(parsed[1]!.headers[1]).toEqual(["Content-Type", "application/x-pem-file"]);
    expect(parsed[1]!.body).toEqual(fixture("chain.pem"));
  });

  test("parsed bodies do not alias the input", () => {
    const file = fixture("manifest.multipart");
    const source = new AliasingBytes(new ArrayBuffer(file.length + 8));
    source.set(file, 8);
    const parsed = parseMultipart(source.subarray(8), B);
    source.fill(0);
    expect(parsed[0]!.body).toEqual(fixture("manifest.json"));
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
      () => frame([[...DIRECTIVE, "x-note: café"], "{}"]),
      "parts[0].headers[2]",
      "ASCII",
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
      () => frame([[...DIRECTIVE, `x-note: ${B}`], "{}"]),
      "parts[0]",
      "contains the boundary",
    ],
  ])("parse rejects %s", (_, body, field, message) => {
    rejects(() => parseMultipart(body(), B), field, message);
  });

  test.each<[string, unknown]>([
    ["an empty boundary", ""],
    ["a boundary inside an array", [B]],
  ])("parse rejects %s", (_, boundary) => {
    rejects(() => parseMultipart(fixture("no-update.multipart"), loose(boundary)), "boundary");
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
      "the boundary only in a header value",
      () => [[part("manifest", json, [["x-note", `a${B}`]])], B],
      "parts[0]",
    ],
    [
      "CRLF in a header value",
      () => [[part("manifest", json, [["x-a", "a\r\nb"]])]],
      "parts[0].headers[2]",
    ],
    [
      "a reserved header name",
      () => [[part("manifest", json, [["content-type", "text/plain"]])]],
      "parts[0].headers[2]",
    ],
    [
      "a non-ASCII header value",
      () => [[part("manifest", json, [["x-note", "café"]])]],
      "parts[0].headers[2]",
    ],
    [
      "header names differing only in case",
      () => [
        [
          part("manifest", json, [
            ["expo-signature", "a"],
            ["Expo-Signature", "b"],
          ]),
        ],
      ],
      "parts[0].headers[3]",
    ],
  ])("encode rejects %s", (_, args, field) => {
    const [parts, boundary] = args();
    rejects(() => encodeMultipart(parts, boundary), field);
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
  const headers = fc
    .uniqueArray(
      fc.tuple(
        fc.stringMatching(/^[A-Za-z][A-Za-z0-9-]{0,11}$/),
        fc.stringMatching(/^[!-~](?:[ !-~]{0,20}[!-~])?$/),
      ),
      { selector: ([name]) => name.toLowerCase(), maxLength: 3 },
    )
    .filter((hs) => hs.every(([n]) => !/^content-(type|disposition)$/i.test(n)));
  const parts = fc.uniqueArray(
    fc.record({
      name: fc.constantFrom<PartName>("manifest", "directive", "extensions", "certificate_chain"),
      headers,
      body,
    }),
    { selector: (p) => p.name, minLength: 1, maxLength: 4 },
  );
  const boundary = fc.option(
    fc.oneof(fc.constantFrom("b", "tide", "-"), fc.stringMatching(/^[0-9A-Za-z_-]{1,70}$/)),
    { nil: undefined },
  );

  /** Everything the encoder writes for a part apart from delimiters. */
  const wire = (p: Part) =>
    [...fixedHeaders(p.name), ...p.headers].map(([n, v]) => `${n}: ${v}\r\n`).join("") +
    latin1(p.body);

  test("parse(encode(parts)) returns the same names, headers and body bytes", () => {
    fc.assert(
      fc.property(parts, boundary, (ps, b) => {
        if (b !== undefined && ps.some((p) => wire(p).includes(b))) {
          expect(() => encodeMultipart(ps, b)).toThrow(ProtocolError);
          return;
        }
        const encoded = encodeMultipart(ps, b);
        const parsed = parseMultipart(encoded.body, encoded.boundary);
        expect(parsed.map((p) => p.name)).toEqual(ps.map((p) => p.name));
        expect(parsed.map((p) => p.headers)).toEqual(
          ps.map((p) => [...fixedHeaders(p.name), ...p.headers]),
        );
        parsed.forEach((p, i) => expect(p.body).toEqual(ps[i]!.body));
      }),
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
