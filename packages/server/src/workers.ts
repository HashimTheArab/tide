import { env } from "cloudflare:workers";

import type { Store } from "./core/store.ts";
import { createApp } from "./core/app.ts";

/** Returns a store over an R2 binding; only `get` is reachable, since a binding cannot be made read-only. */
function r2Store(bucket: Pick<R2Bucket, "get">): Store {
  return {
    async get(key) {
      const object = await bucket.get(key);
      if (object === null) return undefined;
      // Tide stores objects unencoded; an encoded one would reach clients as the wrong bytes.
      const encoding = object.httpMetadata?.contentEncoding;
      if (encoding !== undefined && encoding !== "identity") {
        await object.body.cancel();
        throw new Error(`R2 object ${key} has content-encoding ${encoding}`);
      }
      return { body: object.body as ReadableStream<Uint8Array>, size: object.size };
    },
  };
}

export default createApp(r2Store(env.BUCKET), {
  appId: env.TIDE_APP_ID,
  analytics: (point) => env.ANALYTICS.writeDataPoint(point),
});
