import { SELF, env } from "cloudflare:test";

import { serverCases } from "../shared/server-cases.ts";

serverCases({
  fetch: (path, init) => SELF.fetch(`https://tide.test${path}`, init),
  put: async (key, bytes) => {
    await env.BUCKET.put(key, bytes);
  },
  // Tide stores objects unencoded, so the R2 adapter must refuse an encoded one.
  putFault: async (key) => {
    await env.BUCKET.put(key, new Uint8Array([1]), { httpMetadata: { contentEncoding: "gzip" } });
  },
});
