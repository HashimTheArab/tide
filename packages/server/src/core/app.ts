import { Hono } from "hono";

import { assetContentType, contentKey } from "@tide/protocol";

import type { Store } from "./store.ts";

// Only a 200 may be cached: a missing object can be uploaded later, and an outage must not stick.
const NO_STORE = { "cache-control": "no-store" };

/** Returns the Tide HTTP app; it uses only web-standard APIs, so every runtime serves the same app. */
export function createApp(store: Store): Hono {
  const app = new Hono();
  app.get("/hc", (c) => c.text("ok"));

  // Serves URLs earlier servers put in signed manifests: `h` is the asset's unpadded base64url SHA-256.
  app.get("/assets", async (c) => {
    const h = c.req.queries("h");
    let key: string;
    try {
      if (h?.length !== 1) throw new Error("one h is required");
      key = `assets/${contentKey(h[0] ?? "")}`;
    } catch {
      return c.text("h must be one 43-character base64url SHA-256\n", 400, NO_STORE);
    }

    let object;
    try {
      object = await store.get(key);
    } catch (e) {
      console.error(`store get ${key} failed`, e);
      return c.text("storage unavailable\n", 503, NO_STORE);
    }
    if (object === undefined) return c.text("not found\n", 404, NO_STORE);

    const ext = c.req.queries("ext");
    const headers = {
      "content-type":
        ext?.length === 1 ? assetContentType(ext[0] ?? "") : "application/octet-stream",
      "content-length": String(object.size),
      "cache-control": "public, max-age=31536000, immutable",
    };
    // Hono answers HEAD through this handler and drops the body without cancelling it.
    if (c.req.method === "HEAD") {
      await object.body.cancel();
      return new Response(null, { headers });
    }
    return new Response(object.body, { headers });
  });

  app.notFound((c) => c.text("not found\n", 404, NO_STORE));
  app.onError((e, c) => {
    console.error(e);
    return c.text("internal error\n", 500, NO_STORE);
  });
  return app;
}
