import type { Context } from "hono";
import { Hono } from "hono";

import type { BaseRecord, StoredReply } from "@tide/protocol";
import {
  HEADER_VALUE,
  MAX_BASE_BYTES,
  MAX_REPLY_BYTES,
  NO_UPDATE_KEY,
  ProtocolError,
  UUID,
  assetContentType,
  baseKey,
  contentKey,
  decodeBaseRecord,
  decodeStoredReply,
  patchKey,
  replyKey,
} from "@tide/protocol";

import type { AnalyticsSink, ManifestPoint } from "./analytics.ts";
import type { Store, StoredObject } from "./store.ts";
import { manifestPoint } from "./analytics.ts";
import { abortable, discard, readBounded } from "./store.ts";

// Only a 200 may be cached: a missing object can be uploaded later, and an outage must not stick.
const NO_STORE = { "cache-control": "no-store" };
const IMMUTABLE = "public, max-age=31536000, immutable";
const CONTENT_HEX = /^[0-9a-f]{64}$/; // A bundle key's SHA-256, as stored.
// Media-type parameters and q-values are ignored: stock clients send multipart/mixed, the only type Tide stores.
const ACCEPTS_MULTIPART = /multipart\/mixed|multipart\/\*|\*\/\*/;
const QVALUE = /^(?:0(?:\.[0-9]{0,3})?|1(?:\.0{0,3})?)$/; // RFC 9110 12.4.2.
const QUOTED = /"(?:[^"\\]|\\[\s\S]?)*(?:"|$)/g; // A quoted-string, to the end when unterminated.
const NO_PATCH = new Error("no patch"); // Thrown by a lookup that found nothing without a fault.

export interface AppOptions {
  /** When set and not empty, a request whose `expo-app-id` is present and differs is rejected. */
  readonly appId?: string | undefined;
  /** Returns the one deadline covering every store read of a `/manifest` request. */
  readonly replyDeadline?: () => AbortSignal;
  /** Returns the deadline of a `/bundles` request's patch lookup; past it the full bundle is served. */
  readonly patchDeadline?: () => AbortSignal;
  /** Receives a data point per `/manifest` request that reaches the reply decision. */
  readonly analytics?: AnalyticsSink | undefined;
}

/** Returns the Tide HTTP app; it uses only web-standard APIs, so every runtime serves the same app. */
export function createApp(store: Store, options: AppOptions = {}): Hono {
  // The patch deadline keeps the full-bundle fallback well inside Android's 10 s read timeout.
  const {
    replyDeadline = () => AbortSignal.timeout(10_000),
    patchDeadline = () => AbortSignal.timeout(2_000),
  } = options;
  const appId = options.appId === "" ? undefined : options.appId; // Empty is unset.
  // A received header value never has edge whitespace, so such an app ID could never match.
  if (appId !== undefined && !HEADER_VALUE.test(appId)) {
    throw new Error("app ID must be printable ASCII without edge whitespace");
  }
  /** Hands `point` to the sink without waiting; a failure is logged without values and never reaches the reply. */
  const record = (point: ManifestPoint) => {
    if (options.analytics === undefined) return;
    const failed = (e: unknown) => {
      console.error(`analytics sink failed: ${e instanceof Error ? e.name : typeof e}`);
    };
    try {
      void Promise.resolve(options.analytics(point)).catch(failed);
    } catch (e) {
      failed(e);
    }
  };
  const app = new Hono();
  app.get("/hc", (c) => c.text("ok"));

  /** Returns the record at `key` read through `decode`, or undefined when there is none. */
  const readRecord = async <T>(
    key: string,
    limit: number,
    decode: (bytes: Uint8Array) => T,
    signal: AbortSignal,
  ): Promise<T | undefined> => {
    try {
      const object = await abortable(store.get(key, signal), signal);
      if (object === undefined) return undefined;
      return decode(await readBounded(object, limit, signal));
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
    let reply: StoredReply | undefined;
    try {
      const pointer = await readRecord(key, MAX_REPLY_BYTES, decodeStoredReply, signal);
      if (pointer?.kind === "noUpdateAvailable") throw new Error(`${key} holds noUpdateAvailable`);
      // A rollback is always served: the client applies it only when its commitTime is newer than what it runs.
      const current = header("expo-current-update-id")?.toLowerCase();
      if (pointer !== undefined && (pointer.kind !== "manifest" || current !== pointer.updateId)) {
        reply = pointer;
      } else {
        const noUpdate = await readRecord(
          NO_UPDATE_KEY,
          MAX_REPLY_BYTES,
          decodeStoredReply,
          signal,
        );
        if (noUpdate === undefined) throw new Error(`${NO_UPDATE_KEY} is missing`);
        if (noUpdate.kind !== "noUpdateAvailable") {
          throw new Error(`${NO_UPDATE_KEY} holds ${noUpdate.kind}`);
        }
        reply = noUpdate;
      }
    } catch (e) {
      console.error(`/manifest for ${key} failed`, e);
    }
    record(
      manifestPoint({
        reply: reply?.kind ?? "503",
        platform,
        runtime: runtime ?? "",
        channel: channel ?? "",
        currentUpdateId: header("expo-current-update-id"),
        embeddedUpdateId: header("expo-embedded-update-id"),
        recentFailedUpdateIds: header("expo-recent-failed-update-ids"),
        fatalError: header("expo-fatal-error"),
      }),
    );
    if (reply === undefined) return c.text("storage unavailable\n", 503, NO_STORE);
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

  /** Returns `object` as the reply; HEAD gets the headers only, and the stream is cancelled without waiting. */
  const send = (
    c: Context,
    object: StoredObject,
    status: 200 | 226,
    headers: Record<string, string>,
  ) => {
    headers["content-length"] = String(object.size);
    // Hono answers HEAD through the GET handler and drops the body without cancelling it.
    if (c.req.method === "HEAD") {
      discard(object.body);
      return new Response(null, { status, headers });
    }
    return new Response(object.body, { status, headers });
  };

  /** Serves the object at `key` as immutable `contentType`; only a 200 may be cached. */
  const serveObject = async (c: Context, key: string, contentType: string) => {
    let object;
    try {
      object = await store.get(key);
    } catch (e) {
      console.error(`store get ${key} failed`, e);
      return c.text("storage unavailable\n", 503, NO_STORE);
    }
    if (object === undefined) return c.text("not found\n", 404, NO_STORE);
    return send(c, object, 200, { "content-type": contentType, "cache-control": IMMUTABLE });
  };

  /** Returns the base record for `updateId`, or undefined when there is none; a record of another ID rejects. */
  const readBase = (updateId: string, signal: AbortSignal): Promise<BaseRecord | undefined> =>
    readRecord(
      baseKey(updateId),
      MAX_BASE_BYTES,
      (bytes) => {
        const record = decodeBaseRecord(bytes);
        // The codec never sees the key, so only here can a record filed under another ID be caught.
        if (record.updateId !== updateId) throw new Error(`it holds update ${record.updateId}`);
        return record;
      },
      signal,
    );

  /**
   * Returns the object at `key`, or rejects once `signal` aborts first. The store gets a signal that `signal` aborts
   * only until the get settles: an adapter may keep it on the body, and the deadline must not cut a patch on the wire.
   */
  const getBeforeDeadline = async (key: string, signal: AbortSignal) => {
    const own = new AbortController();
    const abort = () => {
      own.abort(signal.reason);
    };
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
    const get = store.get(key, own.signal).finally(() => {
      signal.removeEventListener("abort", abort);
    });
    try {
      return await abortable(get, signal);
    } catch (e) {
      throw new Error(`reading ${key} failed`, { cause: e });
    }
  };

  /** Resolves the stored patch from `current`'s base to bundle `hex`, or undefined; never rejects. */
  const findPatch = async (
    hex: string,
    { current, requested }: PatchRequest,
    answered: AbortSignal,
  ): Promise<StoredObject | undefined> => {
    const settled = new AbortController(); // Ends a base read once its sibling has decided.
    const signal = AbortSignal.any([patchDeadline(), answered, settled.signal]);
    // Either base alone can rule a patch out, so neither waits on the other to say so.
    const usable = async (
      read: Promise<BaseRecord | undefined>,
      ok: (r: BaseRecord) => boolean,
    ) => {
      const record = await read;
      if (record === undefined || !ok(record)) throw NO_PATCH;
      return record;
    };
    try {
      const [from] = await Promise.all([
        usable(readBase(current, signal), () => true),
        usable(readBase(requested, signal), (r) => contentKey(r.launchAsset.hash) === hex),
      ]);
      return await getBeforeDeadline(patchKey(contentKey(from.launchAsset.hash), hex), signal);
    } catch (e) {
      // Every fault falls back to the full bundle, which is always correct; only a patch is lost.
      if (e !== NO_PATCH && !answered.aborted) {
        console.error(`patch lookup for bundles/${hex} failed`, e);
      }
      return undefined;
    } finally {
      settled.abort();
    }
  };

  // Every manifest's launch asset URL. The bundle read alone decides 404 and 503; a patch only replaces a 200.
  app.get("/bundles/:hex", async (c) => {
    const hex = c.req.param("hex");
    if (!CONTENT_HEX.test(hex)) {
      return c.text("the path must end in 64 lowercase hex characters\n", 400, NO_STORE);
    }
    const key = `bundles/${hex}`;
    const read = store.get(key);
    const request = patchRequest(c);
    const answered = new AbortController();
    const lookup =
      request === undefined ? Promise.resolve(undefined) : findPatch(hex, request, answered.signal);
    /** Ends the lookup without waiting; a patch it already found is cancelled. */
    const abandon = () => {
      answered.abort();
      void lookup.then((patch) => {
        if (patch !== undefined) discard(patch.body);
      });
    };

    let object;
    try {
      object = await read;
    } catch (e) {
      abandon();
      console.error(`store get ${key} failed`, e);
      return c.text("storage unavailable\n", 503, NO_STORE);
    }
    if (object === undefined) {
      abandon();
      return c.text("not found\n", 404, NO_STORE);
    }
    const patch = await lookup;
    if (request === undefined || patch === undefined) {
      return send(c, object, 200, {
        "content-type": assetContentType("bundle"),
        "cache-control": IMMUTABLE,
      });
    }
    discard(object.body);
    // The body is a BSDIFF40 patch, not script; the client does not check its type.
    return send(c, patch, 226, {
      "content-type": "application/octet-stream",
      im: "bsdiff",
      "expo-base-update-id": request.current,
      "cache-control": "private, no-store",
      vary: "A-IM, Expo-Current-Update-ID",
    });
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
    const ext = c.req.queries("ext");
    return await serveObject(c, key, assetContentType(ext?.length === 1 ? (ext[0] ?? "") : ""));
  });

  app.notFound((c) => c.text("not found\n", 404, NO_STORE));
  app.onError((e, c) => {
    console.error(e);
    return c.text("internal error\n", 500, NO_STORE);
  });
  return app;
}

interface PatchRequest {
  readonly current: string; // Lowercase UUIDs.
  readonly requested: string;
}

/** Returns the update IDs of a request that accepts a bsdiff patch, or undefined. */
function patchRequest(c: Context): PatchRequest | undefined {
  if (!acceptsBsdiff(c.req.header("a-im") ?? "")) return undefined;
  // Clients send lowercase IDs; a repeated header arrives joined with ", " and fails the grammar.
  const current = c.req.header("expo-current-update-id")?.toLowerCase() ?? "";
  const requested = c.req.header("expo-requested-update-id")?.toLowerCase() ?? "";
  if (!UUID.test(current) || !UUID.test(requested)) return undefined;
  return { current, requested };
}

/**
 * Returns whether an `A-IM` value lists `bsdiff` with no q parameter or a valid one above zero (RFC 3229 10.5.3).
 * Other parameters are ignored; a malformed q declines.
 */
function acceptsBsdiff(value: string): boolean {
  // Quoted strings are emptied first, so a quoted parameter cannot list an item.
  return value
    .replace(QUOTED, '""')
    .split(",")
    .some((item) => {
      const [name = "", ...params] = item.split(";");
      if (name.trim().toLowerCase() !== "bsdiff") return false;
      return params.every((param) => {
        const eq = param.indexOf("=");
        if ((eq === -1 ? param : param.slice(0, eq)).trim().toLowerCase() !== "q") return true;
        const q = param.slice(eq + 1).trim();
        return eq !== -1 && QVALUE.test(q) && Number(q) > 0;
      });
    });
}
