import { expect, test } from "vitest";

import { contentKey, sha256Base64Url } from "@tide/protocol";

/** One runtime's real entry and its native way to seed the bucket. */
export interface Harness {
  fetch(path: string, init?: RequestInit): Promise<Response>;
  put(key: string, bytes: Uint8Array<ArrayBuffer>): Promise<void>;
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
