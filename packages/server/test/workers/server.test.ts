import { SELF, env } from "cloudflare:test";
import { describe, expect } from "vitest";

import type { Harness } from "../shared/server-cases.ts";
import { bundleCases, manifestCases, serverCases } from "../shared/server-cases.ts";

const harness: Harness = {
  fetch: (path, init) => SELF.fetch(`https://tide.test${path}`, init),
  request: (path, headers) => {
    const request = new Request(`https://tide.test${path}`, { headers });
    expect(request.headers.has("accept")).toBe(Object.hasOwn(headers, "accept"));
    return SELF.fetch(request);
  },
  put: async (key, bytes) => {
    await env.BUCKET.put(key, bytes);
  },
  putRaw: async (path, bytes) => {
    await env.BUCKET.put(path, bytes);
  },
  remove: (key) => env.BUCKET.delete(key),
  // Tide stores objects unencoded, so the R2 adapter must refuse an encoded one.
  putFault: async (key) => {
    await env.BUCKET.put(key, new Uint8Array([1]), { httpMetadata: { contentEncoding: "gzip" } });
  },
};
serverCases(harness);
describe("/manifest", () => {
  manifestCases(harness);
});
describe("/bundles patch negotiation", () => {
  bundleCases(harness);
});
