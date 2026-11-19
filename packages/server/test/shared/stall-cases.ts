import { describe, expect, inject, test } from "vitest";

import { NO_UPDATE_KEY, replyKey } from "@tide/protocol";

import type { Store, StoredObject } from "../../src/core/store.ts";
import type { Behaviour } from "./fake-s3.ts";
import { createApp } from "../../src/core/app.ts";
import { s3Store } from "../../src/core/s3.ts";
import { abortable, readBounded } from "../../src/core/store.ts";
import { FAKE_S3, STALL_BODY, fakeS3Control } from "./fake-s3.ts";

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
}
