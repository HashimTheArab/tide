import { beforeEach, describe, expect, test } from "vitest";

import type { StoredReply } from "@tide/protocol";
import {
  MAX_REPLY_BYTES,
  NO_UPDATE_KEY,
  certificatePublicKey,
  contentKey,
  decodeStoredReply,
  encodeStoredReply,
  parseMultipart,
  replyKey,
  sha256Base64Url,
  verifyExpoSignature,
} from "@tide/protocol";

import { fixture } from "./fixtures.ts";

/** One runtime's real entry, configured with app ID `tide-test`, and its native way to seed the bucket. */
export interface Harness {
  fetch(path: string, init?: RequestInit): Promise<Response>;
  /** Sends a GET with exactly `headers`, adding none of the client's defaults such as `accept`. */
  request(path: string, headers: Readonly<Record<string, string>>): Promise<Response>;
  /** Stores `bytes` at a logical key, replacing whatever is there. */
  put(key: string, bytes: Uint8Array<ArrayBuffer>): Promise<void>;
  /** Stores `bytes` at a literal native location that no valid key may map to. */
  putRaw(path: string, bytes: Uint8Array<ArrayBuffer>): Promise<void>;
  remove(key: string): Promise<void>;
  /** Seeds an object at `key` that this runtime's store adapter must reject rather than serve or call absent. */
  putFault(key: string): Promise<void>;
}

const IMMUTABLE = "public, max-age=31536000, immutable";
const EMPTY_HASH = "47DEQpj8HBSa-_TImW-5JCeuQeRkm5NMpJWZG3hSuFU";

/** Returns every byte value followed by `label`, so each case stores distinct bytes under its own hash. */
async function asset(label: string) {
  const bytes = new Uint8Array([
    ...Array.from({ length: 256 }, (_, i) => i),
    ...new TextEncoder().encode(label),
  ]);
  const hash = await sha256Base64Url(bytes);
  return { bytes, hash, key: `assets/${contentKey(hash)}` };
}

/** Registers the server behaviour tests every runtime must pass. */
export function serverCases(harness: Harness): void {
  const get = async (path: string, init?: RequestInit) => {
    const res = await harness.fetch(path, init);
    return { res, body: new Uint8Array(await res.arrayBuffer()) };
  };

  test("/hc answers ok", async () => {
    const { res, body } = await get("/hc");
    expect(res.status).toBe(200);
    expect(new TextDecoder().decode(body)).toBe("ok");
  });

  test("/assets streams the stored bytes with an immutable cache and their length", async () => {
    const a = await asset("bytes");
    await harness.put(a.key, a.bytes);
    const { res, body } = await get(`/assets?h=${a.hash}`);
    expect(res.status).toBe(200);
    expect(body).toEqual(a.bytes);
    expect(res.headers.get("cache-control")).toBe(IMMUTABLE);
    expect(res.headers.get("content-length")).toBe(String(a.bytes.length));
    expect(res.headers.get("content-type")).toBe("application/octet-stream");
  });

  test.each([
    ["png", "image/png"],
    ["PNG", "image/png"],
    ["heic", "image/heic"], // An Expo default outside Metro's list.
    ["bundle", "application/javascript"],
    ["zzz", "application/octet-stream"],
    ["", "application/octet-stream"],
  ])("ext=%s is served as %s", async (ext, type) => {
    const a = await asset(`ext ${ext}`);
    await harness.put(a.key, a.bytes);
    const { res, body } = await get(`/assets?h=${a.hash}&ext=${ext}&platform=ios`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe(type);
    expect(body).toEqual(a.bytes);
  });

  test("a repeated ext is served as application/octet-stream", async () => {
    const a = await asset("two exts");
    await harness.put(a.key, a.bytes);
    const { res } = await get(`/assets?h=${a.hash}&ext=png&ext=jpg`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/octet-stream");
  });

  test("HEAD /assets answers the same headers with no body", async () => {
    const a = await asset("head");
    await harness.put(a.key, a.bytes);
    const { res, body } = await get(`/assets?h=${a.hash}&ext=png`, { method: "HEAD" });
    expect(res.status).toBe(200);
    expect(body.length).toBe(0);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("cache-control")).toBe(IMMUTABLE);
    expect(res.headers.get("content-length")).toBe(String(a.bytes.length));
  });

  test.each([
    ["no h", ""],
    ["an empty h", "h="],
    ["42 characters", `h=${EMPTY_HASH.slice(0, 42)}`],
    ["44 characters", `h=${EMPTY_HASH}A`],
    ["= padding", `h=${encodeURIComponent(`${EMPTY_HASH}=`)}`],
    ["a +", `h=${encodeURIComponent(`+${EMPTY_HASH.slice(1)}`)}`],
    ["a /", `h=${encodeURIComponent(`/${EMPTY_HASH.slice(1)}`)}`],
    ["non-zero trailing bits", `h=${EMPTY_HASH.slice(0, 42)}V`],
    ["64 hex characters", `h=${"e3b0c442".repeat(8)}`],
    ["a repeated h", `h=${EMPTY_HASH}&h=${EMPTY_HASH}`],
    ["only the legacy asset parameter", "asset=foo.png"],
  ])("/assets with %s is 400 and not cached", async (_, query) => {
    const { res } = await get(`/assets?${query}`);
    expect(res.status).toBe(400);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  test("/assets for a well-formed hash with no object is 404 and not cached", async () => {
    const a = await asset("absent");
    const { res } = await get(`/assets?h=${a.hash}`);
    expect(res.status).toBe(404);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  test("a store fault is a 503 that is not cached, and /hc still answers", async () => {
    const a = await asset("fault");
    await harness.putFault(a.key);
    const { res } = await get(`/assets?h=${a.hash}`);
    expect(res.status).toBe(503);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect((await get("/hc")).res.status).toBe(200);
  });
}

const RUNTIME = "1.0.0";
const BOUNDARY = "tide_fixture_boundary";
const UPDATE_ID = "0f6a9a3e-6c1b-4c4e-9d55-2b8f3f7c1a90"; // manifest.json's id
const EMBEDDED_ID = "6e0c1b9a-3f7d-4a2e-8b5c-9d1e2f3a4b5c";
const STOCK_ACCEPT = "multipart/mixed,application/expo+json,application/json";

/** Registers the `/manifest` behaviour tests every runtime must pass. */
export function manifestCases(harness: Harness): void {
  const MANIFEST = fixture("manifest.reply.json");
  const ROLLBACK = fixture("rollback.reply.json");
  const NO_UPDATE = fixture("no-update.reply.json");

  /** The headers a stock iOS client sends for `channel`; an undefined value drops that header. */
  const headers = (channel: string, change: Record<string, string | undefined> = {}) => {
    const all: Record<string, string | undefined> = {
      accept: STOCK_ACCEPT,
      "expo-protocol-version": "1",
      "expo-platform": "ios",
      "expo-runtime-version": RUNTIME,
      "expo-channel-name": channel,
      ...change,
    };
    return Object.fromEntries(
      Object.entries(all).filter((e): e is [string, string] => e[1] !== undefined),
    );
  };
  const get = async (channel: string, change?: Record<string, string | undefined>) => {
    const res = await harness.request("/manifest", headers(channel, change));
    return { res, body: new Uint8Array(await res.arrayBuffer()) };
  };
  const pointer = (channel: string, record: Uint8Array<ArrayBuffer>, platform = "ios") =>
    harness.put(replyKey(channel, RUNTIME, platform), record);
  const multipart = (record: Uint8Array) => decodeStoredReply(record).body;

  /** Asserts a 200 that carries `record`'s exact body and the reply headers. */
  const expectReply = ({ res, body }: { res: Response; body: Uint8Array }, record: Uint8Array) => {
    const reply = decodeStoredReply(record);
    expect(res.status).toBe(200);
    expect(body).toEqual(reply.body);
    expect(res.headers.get("content-type")).toBe(`multipart/mixed; boundary=${BOUNDARY}`);
    expect(res.headers.get("expo-protocol-version")).toBe("1");
    expect(res.headers.get("expo-sfv-version")).toBe("0");
    expect(res.headers.get("cache-control")).toBe("private, max-age=0");
    expect(res.headers.get("expo-manifest-filters")).toBe(
      reply.kind === "manifest" ? reply.manifestFilters : null,
    );
  };
  const expectFailure = ({ res }: { res: Response }, status: number) => {
    expect(res.status).toBe(status);
    expect(res.headers.get("cache-control")).toBe("no-store");
  };

  // Workers storage is isolated per file, not per test, so each case uses its own channel.
  beforeEach(async () => {
    await harness.put(NO_UPDATE_KEY, NO_UPDATE);
  });

  test("a manifest pointer serves its stored bytes, and the manifest verifies against the certificate", async () => {
    await pointer("m-served", MANIFEST);
    const got = await get("m-served");
    expectReply(got, MANIFEST);
    expect(got.res.headers.get("expo-manifest-filters")).toBe('branch="main"');
    expect(got.body).toEqual(fixture("manifest.multipart"));
    const [manifest] = parseMultipart(got.body, BOUNDARY);
    expect(manifest?.name).toBe("manifest");
    const key = await certificatePublicKey(new TextDecoder().decode(fixture("certificate.pem")));
    await expect(
      verifyExpoSignature(
        manifest?.body ?? new Uint8Array(),
        manifest?.signature ?? "",
        key,
        "main",
      ),
    ).resolves.toBeUndefined();
  });

  describe("a rollback pointer", () => {
    test("serves the signed directive without filters", async () => {
      await pointer("rb-served", ROLLBACK);
      const got = await get("rb-served");
      expectReply(got, ROLLBACK);
      expect(got.body).toEqual(fixture("rollback.multipart"));
    });

    // The client may have a downloaded OTA update queued; applying the directive's commitTime stops it launching.
    test("serves the directive to a client running its embedded update", async () => {
      await pointer("rb-embedded", ROLLBACK);
      const got = await get("rb-embedded", {
        "expo-current-update-id": EMBEDDED_ID,
        "expo-embedded-update-id": EMBEDDED_ID,
      });
      expectReply(got, ROLLBACK);
      expect(got.body).toEqual(fixture("rollback.multipart"));
    });

    test("serves the directive to a client running another update", async () => {
      await pointer("rb-other", ROLLBACK);
      const ids = { "expo-current-update-id": UPDATE_ID, "expo-embedded-update-id": EMBEDDED_ID };
      expectReply(await get("rb-other", ids), ROLLBACK);
    });
  });

  test("no pointer serves the stored no-update bytes", async () => {
    const got = await get("no-pointer");
    expectReply(got, NO_UPDATE);
    expect(got.body).toEqual(fixture("no-update.multipart"));
  });

  test.each([UPDATE_ID, UPDATE_ID.toUpperCase()])(
    "a client already running the pointer's update %s gets no-update",
    async (current) => {
      await pointer("m-current", MANIFEST);
      expectReply(await get("m-current", { "expo-current-update-id": current }), NO_UPDATE);
    },
  );

  test("a client running another update gets the manifest", async () => {
    await pointer("m-other", MANIFEST);
    expectReply(await get("m-other", { "expo-current-update-id": EMBEDDED_ID }), MANIFEST);
  });

  test("iOS and Android replies under one channel and runtime are each served", async () => {
    await pointer("two-platforms", MANIFEST, "ios");
    await pointer("two-platforms", ROLLBACK, "android");
    expectReply(await get("two-platforms"), MANIFEST);
    expectReply(await get("two-platforms", { "expo-platform": "android" }), ROLLBACK);
  });

  test("channel no-update has its own pointer beside the fallback", async () => {
    await pointer("no-update", MANIFEST);
    expectReply(await get("no-update"), MANIFEST);
    expectReply(await get("no-update-other"), NO_UPDATE);
  });

  test("channels differing only in case have their own pointers", async () => {
    await pointer("Case", MANIFEST);
    await pointer("case", ROLLBACK);
    expectReply(await get("Case"), MANIFEST);
    expectReply(await get("case"), ROLLBACK);
  });

  test.each(["e".repeat(64), "a.b_c+d-e", "..."])("channel %s reaches its pointer", async (c) => {
    await pointer(c, MANIFEST);
    expectReply(await get(c), MANIFEST);
  });

  test.each<[string, Record<string, string | undefined>]>([
    ["a missing expo-platform", { "expo-platform": undefined }],
    ["an empty expo-platform", { "expo-platform": "" }],
    ["expo-platform IOS", { "expo-platform": "IOS" }],
    ["expo-platform web", { "expo-platform": "web" }],
    ["a mismatched expo-app-id", { "expo-app-id": "other-app" }],
    ["a missing expo-channel-name", { "expo-channel-name": undefined }],
    ["a missing expo-runtime-version", { "expo-runtime-version": undefined }],
  ])("%s is 400 and not cached", async (_, change) => {
    await pointer("bad-request", MANIFEST);
    expectFailure(await get("bad-request", change), 400);
  });

  test("a missing channel names the header", async () => {
    const { body } = await get("x", { "expo-channel-name": undefined });
    expect(new TextDecoder().decode(body)).toBe("expo-channel-name is missing\n");
  });

  test.each(["tide-test", ""])("expo-app-id %j is served", async (id) => {
    await pointer("app-id", MANIFEST);
    expectReply(await get("app-id", { "expo-app-id": id }), MANIFEST);
  });

  test.each<[string, Record<string, string | undefined>]>([
    ["expo-protocol-version 0", { "expo-protocol-version": "0" }],
    ["expo-protocol-version 2", { "expo-protocol-version": "2" }],
    ["accept application/expo+json", { accept: "application/expo+json" }],
    ["accept application/json", { accept: "application/json" }],
  ])("%s is 406 and not cached", async (_, change) => {
    await pointer("not-acceptable", MANIFEST);
    expectFailure(await get("not-acceptable", change), 406);
  });

  test.each<[string, Record<string, string | undefined>]>([
    ["no accept", { accept: undefined }],
    ["an empty accept, which is no accept", { accept: "" }],
    ["accept */*", { accept: "*/*" }],
    ["accept multipart/*", { accept: "multipart/*" }],
    ["accept Multipart/Mixed", { accept: "Multipart/Mixed" }],
    [
      "accept multipart/mixed;q=0, which parameters do not change",
      { accept: "multipart/mixed;q=0" },
    ],
    ["no expo-protocol-version", { "expo-protocol-version": undefined }],
    ["an empty expo-protocol-version, which is none", { "expo-protocol-version": "" }],
  ])("%s is served", async (_, change) => {
    await pointer("acceptable", MANIFEST);
    expectReply(await get("acceptable", change), MANIFEST);
  });

  // Each case seeds the manifest where a naive join of the headers would point, and must not be served it.
  test.each<[string, string, string]>([
    ["a channel with /", "a/b", RUNTIME],
    ["channel ..", "..", RUNTIME],
    ["channel .", ".", RUNTIME],
    ["a channel that normalises to another", "x/../escape", RUNTIME],
    ["a channel with a space", "a b", RUNTIME],
    ["a 65-character channel", "f".repeat(65), RUNTIME],
    ["a repeated channel header", "a, b", RUNTIME],
    ["runtime ../x", "main", "../x"],
  ])("%s cannot reach a stored key", async (_, channel, runtime) => {
    await harness.putRaw(`reply/${channel}/${runtime}/ios`, MANIFEST);
    if (channel === "x/../escape") await pointer("escape", MANIFEST);
    const got = await get(channel, { "expo-runtime-version": runtime });
    expectFailure(got, 400);
    expect(got.body).not.toEqual(multipart(MANIFEST));
  });

  describe("503, not cached", () => {
    test("no pointer and no stored no-update", async () => {
      await harness.remove(NO_UPDATE_KEY);
      expectFailure(await get("no-fallback"), 503);
    });

    test("a current client and no stored no-update", async () => {
      await pointer("current-no-fallback", MANIFEST);
      await harness.remove(NO_UPDATE_KEY);
      expectFailure(await get("current-no-fallback", { "expo-current-update-id": UPDATE_ID }), 503);
    });

    const utf8 = (text: string) => new Uint8Array(new TextEncoder().encode(text));
    const unknownVersion = utf8(
      new TextDecoder().decode(MANIFEST).replace('"version":1', '"version":2'),
    );
    test.each<[string, Uint8Array<ArrayBuffer>]>([
      ["malformed JSON", utf8('{"version":1,')],
      ["an unknown version", unknownVersion],
      ["the wrong kind", NO_UPDATE],
      ["one byte over the limit", new Uint8Array(MAX_REPLY_BYTES + 1)],
    ])("%s at the pointer", async (_, record) => {
      await pointer("bad-pointer", record);
      expectFailure(await get("bad-pointer"), 503);
    });

    test.each<[string, Uint8Array<ArrayBuffer>]>([
      ["malformed JSON", utf8('{"version":1,')],
      ["an unknown version", unknownVersion],
      ["the wrong kind", ROLLBACK],
    ])("%s at reply/no-update", async (_, record) => {
      await harness.put(NO_UPDATE_KEY, record);
      expectFailure(await get("bad-fallback"), 503);
    });

    test("a store fault at the pointer", async () => {
      await harness.putFault(replyKey("fault", RUNTIME, "ios"));
      expectFailure(await get("fault"), 503);
    });

    test("a store fault at reply/no-update", async () => {
      await harness.putFault(NO_UPDATE_KEY);
      expectFailure(await get("fault-fallback"), 503);
    });
  });

  test("a record of exactly the limit is served", async () => {
    const reply = decodeStoredReply(MANIFEST) as Extract<StoredReply, { kind: "manifest" }>;
    const overhead = encodeStoredReply({ ...reply, body: new Uint8Array([0x61]) }).length - 1;
    const body = new Uint8Array(MAX_REPLY_BYTES - overhead).fill(0x61);
    const record = encodeStoredReply({ ...reply, body });
    expect(record.length).toBe(MAX_REPLY_BYTES);
    await pointer("at-limit", record);
    const got = await get("at-limit");
    expect(got.res.status).toBe(200);
    expect(got.body).toEqual(body);
  });
}
