import { Hono } from "hono";

import type { StoredReply } from "@tide/protocol";
import {
  HEADER_VALUE,
  MAX_REPLY_BYTES,
  NO_UPDATE_KEY,
  ProtocolError,
  assetContentType,
  contentKey,
  decodeStoredReply,
  replyKey,
} from "@tide/protocol";

import type { Store } from "./store.ts";
import { abortable, readBounded } from "./store.ts";

// Only a 200 may be cached: a missing object can be uploaded later, and an outage must not stick.
const NO_STORE = { "cache-control": "no-store" };
// Media-type parameters and q-values are ignored: stock clients send multipart/mixed, the only type Tide stores.
const ACCEPTS_MULTIPART = /multipart\/mixed|multipart\/\*|\*\/\*/;

export interface AppOptions {
  /** When set and not empty, a request whose `expo-app-id` is present and differs is rejected. */
  readonly appId?: string | undefined;
  /** Returns the one deadline covering every store read of a `/manifest` request. */
  readonly replyDeadline?: () => AbortSignal;
}

/** Returns the Tide HTTP app; it uses only web-standard APIs, so every runtime serves the same app. */
export function createApp(store: Store, options: AppOptions = {}): Hono {
  const { replyDeadline = () => AbortSignal.timeout(10_000) } = options;
  const appId = options.appId === "" ? undefined : options.appId; // Empty is unset.
  // A received header value never has edge whitespace, so such an app ID could never match.
  if (appId !== undefined && !HEADER_VALUE.test(appId)) {
    throw new Error("app ID must be printable ASCII without edge whitespace");
  }
  const app = new Hono();
  app.get("/hc", (c) => c.text("ok"));

  /** Returns the decoded reply at `key`, or undefined when there is none. */
  const read = async (key: string, signal: AbortSignal): Promise<StoredReply | undefined> => {
    try {
      const object = await abortable(store.get(key, signal), signal);
      if (object === undefined) return undefined;
      return decodeStoredReply(await readBounded(object, MAX_REPLY_BYTES, signal));
    } catch (e) {
      throw new Error(`reading ${key} failed`, { cause: e });
    }
  };

  app.get("/manifest", async (c) => {
    // An empty value is absent: workerd drops empty header values, and both runtimes must agree.
    const header = (name: string) => {
      const value = c.req.header(name);
      return value === "" ? undefined : value;
    };
    const platform = header("expo-platform");
    if (platform !== "ios" && platform !== "android") {
      return c.text("expo-platform must be ios or android\n", 400, NO_STORE);
    }
    const requestAppId = header("expo-app-id");
    if (appId !== undefined && requestAppId !== undefined && requestAppId !== appId) {
      return c.text("expo-app-id does not match this server\n", 400, NO_STORE);
    }
    const version = header("expo-protocol-version");
    if (version !== undefined && version !== "1") {
      return c.text("expo-protocol-version must be 1\n", 406, NO_STORE);
    }
    const accept = header("accept");
    if (accept !== undefined && !ACCEPTS_MULTIPART.test(accept.toLowerCase())) {
      return c.text("accept must allow multipart/mixed\n", 406, NO_STORE);
    }
    // No default channel: a misconfigured app sees a 400 in its logs rather than a silent no-update.
    const channel = header("expo-channel-name");
    const runtime = header("expo-runtime-version");
    let key: string;
    try {
      key = replyKey(channel ?? "", runtime ?? "", platform);
    } catch (e) {
      if (!(e instanceof ProtocolError)) throw e;
      const name = e.field === "channel" ? "expo-channel-name" : "expo-runtime-version";
      const value = e.field === "channel" ? channel : runtime;
      const problem =
        value === undefined ? "is missing" : "must be 1 to 64 of A-Z, a-z, 0-9, ., _, + and -";
      return c.text(`${name} ${problem}\n`, 400, NO_STORE);
    }

    const signal = replyDeadline();
    let reply: StoredReply;
    try {
      const pointer = await read(key, signal);
      if (pointer?.kind === "noUpdateAvailable") throw new Error(`${key} holds noUpdateAvailable`);
      // A rollback is always served: the client applies it only when its commitTime is newer than what it runs.
      const current = header("expo-current-update-id")?.toLowerCase();
      if (pointer !== undefined && (pointer.kind !== "manifest" || current !== pointer.updateId)) {
        reply = pointer;
      } else {
        const noUpdate = await read(NO_UPDATE_KEY, signal);
        if (noUpdate === undefined) throw new Error(`${NO_UPDATE_KEY} is missing`);
        if (noUpdate.kind !== "noUpdateAvailable") {
          throw new Error(`${NO_UPDATE_KEY} holds ${noUpdate.kind}`);
        }
        reply = noUpdate;
      }
    } catch (e) {
      console.error(`/manifest for ${key} failed`, e);
      return c.text("storage unavailable\n", 503, NO_STORE);
    }
    const headers: Record<string, string> = {
      "content-type": `multipart/mixed; boundary=${reply.boundary}`,
      "expo-protocol-version": "1",
      "expo-sfv-version": "0",
      "cache-control": "private, max-age=0",
    };
    // Sent even when empty: a client keeps earlier filters when the header is absent.
    if (reply.kind === "manifest") headers["expo-manifest-filters"] = reply.manifestFilters;
    return new Response(reply.body, { headers });
  });

  // Serves URLs earlier servers put in signed manifests: `h` is the asset's unpadded base64url SHA-256.
  app.get("/assets", async (c) => {
    const h = c.req.queries("h");
    let key: string;
    try {
      key = `assets/${contentKey(h?.length === 1 ? (h[0] ?? "") : "")}`;
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
      "content-type": assetContentType(ext?.length === 1 ? (ext[0] ?? "") : ""),
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
