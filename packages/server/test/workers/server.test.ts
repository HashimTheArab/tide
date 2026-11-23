import { SELF, env } from "cloudflare:test";
import { describe, expect, onTestFinished, vi } from "vitest";

import type { ManifestPoint } from "../../src/core/analytics.ts";
import type { SinkFaultHarness } from "../shared/analytics-cases.ts";
import type { Harness } from "../shared/server-cases.ts";
import { analyticsCases, faultySink, sinkFaultCases } from "../shared/analytics-cases.ts";
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
describe("/manifest analytics through the local Analytics Engine binding", () => {
  const analytics: SinkFaultHarness = {
    ...harness,
    capture(fault) {
      // The entry reads the same binding object, so the spy sees its writes and still calls the binding.
      const spy = vi.spyOn(env.ANALYTICS, "writeDataPoint");
      onTestFinished(() => {
        spy.mockRestore();
      });
      if (fault !== undefined) spy.mockImplementation(faultySink(fault));
      return () => spy.mock.calls.map(([point]) => point as ManifestPoint);
    },
  };
  analyticsCases(analytics);
  sinkFaultCases(analytics);
});
