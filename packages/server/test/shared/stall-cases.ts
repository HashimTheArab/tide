import { describe, expect, inject, test } from "vitest";

import {
  NO_UPDATE_KEY,
  baseKey,
  contentKey,
  patchKey,
  replyKey,
  s3Fetch,
  s3Target,
  sha256Base64Url,
} from "@tide-ota/protocol";

import type { Store, StoredObject } from "../../src/core/store.ts";
import type { Behaviour } from "./fake-s3.ts";
import { createApp } from "../../src/core/app.ts";
import { s3Store } from "../../src/core/s3.ts";
import { abortable, readBounded } from "../../src/core/store.ts";
import { FAKE_S3, STALL_BODY, fakeS3Control } from "./fake-s3.ts";
import { baseRecord } from "./server-cases.ts";

const never = () => new Promise<void>(() => undefined);

/**
 * A stream that hands out `chunks` one per read. With `highWaterMark: 0`, `pull` runs only for a pending read, so
 * `pulls` counts reads and `drained` resolves once a read is waiting with nothing left to give.
 */
function probe(
  chunks: readonly Uint8Array[],
  { close = false, cancel }: { close?: boolean; cancel?: () => Promise<void> } = {},
) {
  const queue = [...chunks];
  const drained = Promise.withResolvers<void>();
  const state = { pulls: 0, cancelled: false };
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        state.pulls++;
        const next = queue.shift();
        if (next !== undefined) return controller.enqueue(next);
        if (close) return controller.close();
        drained.resolve();
        return never();
      },
      cancel() {
        state.cancelled = true;
        return cancel?.();
      },
    },
    { highWaterMark: 0 },
  );
  return { body, state, drained: drained.promise };
}

const bytes = (n: number, fill = 7) => new Uint8Array(n).fill(fill);

/** Registers the deadline and bounded-read tests every runtime must pass. */
export function stallCases(): void {
  describe("readBounded", () => {
    const live = () => new AbortController().signal;

    test("returns exactly the stream's bytes", async () => {
      const { body } = probe([bytes(3, 1), bytes(2, 2)], { close: true });
      expect(await readBounded({ body, size: 5 }, 5, live())).toEqual(
        new Uint8Array([1, 1, 1, 2, 2]),
      );
    });

    test("rejects a stream that ends early", async () => {
      const { body } = probe([bytes(3)], { close: true });
      await expect(readBounded({ body, size: 5 }, 5, live())).rejects.toThrow("ended after 3");
    });

    test("rejects a size over the limit without reading", async () => {
      const p = probe([bytes(6)]);
      await expect(readBounded({ body: p.body, size: 6 }, 5, live())).rejects.toThrow(
        "over the 5-byte limit",
      );
      expect(p.state).toEqual({ pulls: 0, cancelled: true });
    });

    test("rejects a stream that passes its size and never ends", async () => {
      const p = probe([bytes(4), bytes(2)]);
      await expect(readBounded({ body: p.body, size: 5 }, 5, live())).rejects.toThrow(
        "longer than its 5 bytes",
      );
      expect(p.state.cancelled).toBe(true);
    });

    test("rejects on abort when every byte arrived but the stream never ends", async () => {
      const p = probe([bytes(5)]);
      const deadline = new AbortController();
      const read = readBounded({ body: p.body, size: 5 }, 5, deadline.signal);
      await p.drained;
      const reason = new Error("deadline");
      deadline.abort(reason);
      await expect(read).rejects.toBe(reason);
      expect(p.state.cancelled).toBe(true);
    });

    test("an aborted signal cancels without reading, even when cancel never settles", async () => {
      const p = probe([bytes(5)], { cancel: never });
      const reason = new Error("deadline");
      await expect(
        readBounded({ body: p.body, size: 5 }, 5, AbortSignal.abort(reason)),
      ).rejects.toBe(reason);
      expect(p.state).toEqual({ pulls: 0, cancelled: true });
    });

    test("a cancel that never settles does not delay the rejection", async () => {
      const p = probe([bytes(2)], { cancel: never });
      const deadline = new AbortController();
      const read = readBounded({ body: p.body, size: 5 }, 5, deadline.signal);
      await p.drained;
      deadline.abort(new Error("deadline"));
      await expect(read).rejects.toThrow("deadline");
      expect(p.state.cancelled).toBe(true);
    });

    test("no promise gains a reaction per chunk, so a long read cannot pile them on the deadline", async () => {
      const chunks = 200;
      const { body } = probe(
        Array.from({ length: chunks }, () => bytes(1)),
        { close: true },
      );
      // Promise.race and explicit .then both subscribe through the observable Promise.prototype.then.
      const subscriptions = new Map<object, number>();
      const then = Reflect.get(Promise.prototype, "then") as (...args: unknown[]) => never;
      Promise.prototype.then = function (this: Promise<unknown>, ...args) {
        subscriptions.set(this, (subscriptions.get(this) ?? 0) + 1);
        return Reflect.apply(then, this, args);
      };
      try {
        await readBounded({ body, size: chunks }, chunks, live());
      } finally {
        Reflect.set(Promise.prototype, "then", then);
      }
      expect(Math.max(0, ...subscriptions.values())).toBeLessThan(2);
    });

    test("a cancel that rejects leaves only the abort reason", async () => {
      // Vitest fails the run on an unhandled rejection, so the cancel's own error must be handled.
      const p = probe([bytes(2)], { cancel: () => Promise.reject(new Error("cancel failed")) });
      const deadline = new AbortController();
      const read = readBounded({ body: p.body, size: 5 }, 5, deadline.signal);
      await p.drained;
      deadline.abort(new Error("deadline"));
      await expect(read).rejects.toThrow("deadline");
    });
  });

  describe("abortable", () => {
    test("rejects at once on an aborted signal and cancels an object that arrives later", async () => {
      const cancelled = Promise.withResolvers<void>();
      const p = probe([bytes(1)], {
        cancel: () => {
          cancelled.resolve();
          return never();
        },
      });
      const later = Promise.withResolvers<StoredObject | undefined>();
      const reason = new Error("deadline");
      await expect(abortable(later.promise, AbortSignal.abort(reason))).rejects.toBe(reason);
      later.resolve({ body: p.body, size: 1 });
      await cancelled.promise;
      expect(p.state.pulls).toBe(0);
    });
  });

  describe("/manifest under one deadline, over a fake S3", () => {
    const endpoint = inject("fakeS3Endpoint");
    const fake = fakeS3Control(endpoint);
    const s3 = s3Store({ ...FAKE_S3, endpoint });
    const key = (channel: string) => replyKey(channel, "1", "ios");

    /** Starts a `/manifest` request for `channel`; `deadlines` counts calls to the deadline factory. */
    const start = (store: Store, channel: string, signal: AbortSignal) => {
      const deadlines = { calls: 0 };
      const app = createApp(store, {
        replyDeadline: () => {
          deadlines.calls++;
          return signal;
        },
      });
      const res = app.request("/manifest", {
        headers: {
          "expo-platform": "ios",
          "expo-channel-name": channel,
          "expo-runtime-version": "1",
        },
      });
      return { res: Promise.resolve(res), deadlines };
    };
    const expect503 = async (res: Promise<Response>) => {
      const r = await res;
      expect(r.status).toBe(503);
      expect(r.headers.get("cache-control")).toBe("no-store");
    };
    const scripted = async (channel: string, behaviour: Behaviour) => {
      await fake.script(key(channel), behaviour);
      return key(channel);
    };

    test("a pointer that never answers is a 503 at the deadline", async () => {
      const k = await scripted("stall-hang", "hang");
      const deadline = new AbortController();
      const { res } = start(s3, "stall-hang", deadline.signal);
      await fake.event("arrived", k);
      deadline.abort(new Error("deadline"));
      await expect503(res);
      await fake.event("abandoned", k);
    });

    test("a pointer whose body stalls is a 503 at the deadline", async () => {
      const k = await scripted("stall-body", "stall-body");
      const deadline = new AbortController();
      const { res } = start(s3, "stall-body", deadline.signal);
      await fake.event("flushed", k);
      deadline.abort(new Error("deadline"));
      await expect503(res);
      await fake.event("abandoned", k);
    });

    test("the deadline reaches the body read when the adapter ignores it", async () => {
      // Like R2 and disk, this store drops the signal, so only the route's read can end the stalled body.
      const pending = Promise.withResolvers<void>();
      const state = { cancelled: false };
      const deaf: Store = {
        async get(k) {
          const object = await s3.get(k);
          if (object === undefined) return undefined;
          const reader = object.body.getReader();
          let delivered = 0;
          const body = new ReadableStream<Uint8Array>(
            {
              async pull(controller) {
                if (delivered === STALL_BODY.sent) pending.resolve();
                const { done, value } = await reader.read();
                if (done) return controller.close();
                delivered += value.length;
                controller.enqueue(value);
              },
              cancel(reason) {
                state.cancelled = true;
                return reader.cancel(reason);
              },
            },
            { highWaterMark: 0 },
          );
          return { body, size: object.size };
        },
      };
      const k = await scripted("stall-deaf", "stall-body");
      const deadline = new AbortController();
      const { res } = start(deaf, "stall-deaf", deadline.signal);
      await pending.promise;
      deadline.abort(new Error("deadline"));
      await expect503(res);
      expect(state.cancelled).toBe(true);
      await fake.event("abandoned", k);
    });

    test("one deadline covers the pointer and the fallback", async () => {
      await fake.script(NO_UPDATE_KEY, "hang");
      const deadline = new AbortController();
      const { res, deadlines } = start(s3, "stall-fallback", deadline.signal);
      await fake.event("arrived", key("stall-fallback"));
      await fake.event("arrived", NO_UPDATE_KEY);
      deadline.abort(new Error("deadline"));
      await expect503(res);
      expect(deadlines.calls).toBe(1);
      await fake.event("abandoned", NO_UPDATE_KEY);
    });

    test("an object declaring more than the limit is a 503 before the deadline", async () => {
      const k = await scripted("stall-oversize", "oversize");
      const { res } = start(s3, "stall-oversize", new AbortController().signal);
      await expect503(res);
      await fake.event("abandoned", k);
    });

    test("an already expired deadline is a 503 at once", async () => {
      const { res } = start(s3, "stall-expired", AbortSignal.abort(new Error("deadline")));
      await expect503(res);
    });
  });

  describe("/bundles patch lookup under its own deadline, over a fake S3", () => {
    const endpoint = inject("fakeS3Endpoint");
    const fake = fakeS3Control(endpoint);
    const s3 = s3Store({ ...FAKE_S3, endpoint });
    const target = s3Target({ ...FAKE_S3, endpoint });
    const utf8 = (text: string) => new Uint8Array(new TextEncoder().encode(text));
    let next = 0;
    const uuid = () => `00000000-0000-4000-9000-${(++next).toString(16).padStart(12, "0")}`;

    type Part = "bundle" | "current" | "requested" | "patch";
    /**
     * Stores, with signed PUTs, a bundle, two base records and a patch of `label`'s own, except `skip`. With
     * `misnamed`, the requested base names the current base's bundle rather than this one.
     */
    const seed = async (label: string, skip: readonly Part[] = [], misnamed = false) => {
      const base = utf8(`${label} base`);
      const bundle = utf8(`${label} bundle`);
      const patch = utf8(`${label} patch`);
      const [baseHash, bundleHash] = await Promise.all([
        sha256Base64Url(base),
        sha256Base64Url(bundle),
      ]);
      const hex = contentKey(bundleHash);
      const current = uuid();
      const requested = uuid();
      const parts: Record<Part, [string, Uint8Array<ArrayBuffer>]> = {
        bundle: [`bundles/${hex}`, bundle],
        current: [baseKey(current), baseRecord(current, baseHash)],
        requested: [baseKey(requested), baseRecord(requested, misnamed ? baseHash : bundleHash)],
        patch: [patchKey(contentKey(baseHash), hex), patch],
      };
      for (const [part, [key, body]] of Object.entries(parts)) {
        if (skip.includes(part as Part)) continue;
        const res = await s3Fetch(
          target,
          { method: "PUT", key, body },
          new AbortController().signal,
        );
        await res.body?.cancel();
        expect([key, res.status]).toEqual([key, 200]);
      }
      const key = (part: Part) => parts[part][0];
      const headers = {
        "a-im": "bsdiff",
        "expo-current-update-id": current,
        "expo-requested-update-id": requested,
      };
      return { key, bundle, patch, path: `/${key("bundle")}`, headers };
    };

    /** Starts a request; `deadlines` counts calls to the patch deadline factory. */
    const start = (
      path: string,
      headers: Record<string, string>,
      signal: AbortSignal,
      { method = "GET", store = s3 }: { method?: string; store?: Store } = {},
    ) => {
      const deadlines = { calls: 0 };
      const app = createApp(store, {
        patchDeadline: () => {
          deadlines.calls++;
          return signal;
        },
      });
      return { res: Promise.resolve(app.request(path, { method, headers })), deadlines };
    };
    const expectFull = async (res: Promise<Response>, bundle: Uint8Array) => {
      const r = await res;
      expect(r.status).toBe(200);
      expect(r.headers.get("im")).toBeNull();
      expect(new Uint8Array(await r.arrayBuffer())).toEqual(bundle);
    };

    test("a 226 body outlives the lookup deadline", async () => {
      const s = await seed("pause patch");
      await fake.script(s.key("patch"), "pause-body");
      const deadline = new AbortController();
      const r = await start(s.path, s.headers, deadline.signal).res;
      expect(r.status).toBe(226);
      deadline.abort(new Error("deadline"));
      await fake.release(s.key("patch"));
      expect(new Uint8Array(await r.arrayBuffer())).toEqual(s.patch);
    });

    test("a 226 cancels the bundle read it does not serve", async () => {
      const s = await seed("unused bundle", ["bundle"]);
      await fake.script(s.key("bundle"), "stall-body");
      const r = await start(s.path, s.headers, new AbortController().signal).res;
      expect(r.status).toBe(226);
      expect(new Uint8Array(await r.arrayBuffer())).toEqual(s.patch);
      await fake.event("abandoned", s.key("bundle"));
    });

    test.each<[string, Part, number]>([
      ["226", "patch", 226],
      ["200", "bundle", 200],
    ])("HEAD on the %s path cancels the stream it holds", async (_, stalled, status) => {
      const s = await seed(`head ${status}`, [stalled]);
      await fake.script(s.key(stalled), "stall-body");
      const { "a-im": aIm, ...ids } = s.headers;
      const headers = status === 226 ? { "a-im": aIm, ...ids } : ids;
      const r = await start(s.path, headers, new AbortController().signal, { method: "HEAD" }).res;
      expect(r.status).toBe(status);
      expect(r.headers.get("content-length")).toBe(String(STALL_BODY.size));
      expect(new Uint8Array(await r.arrayBuffer())).toEqual(new Uint8Array());
      await fake.event("abandoned", s.key(stalled));
    });

    // A scripted key that is never seeded can be waited on with `arrived`; a seeded one only with `flushed`.
    test.each<[string, Part, Behaviour, "arrived" | "flushed"]>([
      ["a current base that never answers", "current", "hang", "arrived"],
      ["a requested base whose body stalls", "requested", "stall-body", "flushed"],
      ["a patch get that never answers", "patch", "hang", "arrived"],
    ])("%s serves the full bundle at the deadline", async (label, stalled, behaviour, wait) => {
      const s = await seed(label, [stalled]);
      await fake.script(s.key(stalled), behaviour);
      const deadline = new AbortController();
      const { res, deadlines } = start(s.path, s.headers, deadline.signal);
      await fake.event(wait, s.key(stalled));
      deadline.abort(new Error("deadline"));
      await expectFull(res, s.bundle);
      expect(deadlines.calls).toBe(1);
      await fake.event("abandoned", s.key(stalled));
    });

    // The deadline never fires here: the full bundle must not wait on a base read once the other rules a patch out.
    test.each<[string, Part, Part, boolean]>([
      ["an unknown current base", "current", "requested", false],
      ["an unknown requested base", "requested", "current", false],
      ["a requested base naming another bundle", "requested", "current", true],
    ])(
      "%s serves the full bundle without waiting on the other base",
      async (label, decided, stalled, misnamed) => {
        const s = await seed(label, misnamed ? [stalled] : [decided, stalled], misnamed);
        await fake.script(s.key(stalled), "hang");
        // The deciding base answers only once the stalled read has reached the fake, so its abandonment is seen.
        const arrived = fake.event("arrived", s.key(stalled));
        const gated: Store = {
          get: async (key, signal) => {
            if (key === s.key(decided)) await arrived;
            return s3.get(key, signal);
          },
        };
        const { res } = start(s.path, s.headers, new AbortController().signal, { store: gated });
        await expectFull(res, s.bundle);
        await fake.event("abandoned", s.key(stalled));
      },
    );

    test.each<[string, Behaviour | undefined, number]>([
      ["fails", "internal-error", 503],
      ["is absent", undefined, 404],
    ])("a bundle that %s ends a lookup in flight", async (label, behaviour, status) => {
      const s = await seed(`bundle ${label}`, ["bundle", "current"]);
      await fake.script(s.key("current"), "hang");
      if (behaviour !== undefined) await fake.script(s.key("bundle"), behaviour);
      // The bundle answers only once the base read has reached the fake.
      const arrived = fake.event("arrived", s.key("current"));
      const gated: Store = {
        get: async (key, signal) => {
          if (key === s.key("bundle")) await arrived;
          return s3.get(key, signal);
        },
      };
      const deadline = new AbortController();
      const r = await start(s.path, s.headers, deadline.signal, { store: gated }).res;
      expect(r.status).toBe(status);
      expect(r.headers.get("cache-control")).toBe("no-store");
      await fake.event("abandoned", s.key("current"));
      expect(deadline.signal.aborted).toBe(false);
    });

    test("an already expired deadline serves the full bundle at once", async () => {
      const s = await seed("expired");
      const { res } = start(s.path, s.headers, AbortSignal.abort(new Error("deadline")));
      await expectFull(res, s.bundle);
    });

    test("a base declaring more than the limit serves the full bundle before the deadline", async () => {
      const s = await seed("oversize base", ["current"]);
      await fake.script(s.key("current"), "oversize");
      const { res } = start(s.path, s.headers, new AbortController().signal);
      await expectFull(res, s.bundle);
      await fake.event("abandoned", s.key("current"));
    });
  });
}
