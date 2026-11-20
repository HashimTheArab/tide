/** An object's bytes and their length; the stream must be consumed or cancelled. */
export interface StoredObject {
  readonly body: ReadableStream<Uint8Array>;
  readonly size: number;
}

/** The server's read-only view of the bucket. */
export interface Store {
  /**
   * Resolves undefined only when the object does not exist; every other failure rejects. `signal` lets an adapter
   * release its I/O early; callers still race the result through `abortable`.
   */
  get(key: string, signal?: AbortSignal): Promise<StoredObject | undefined>;
}

/** Returns `get`'s result, or rejects with the reason once `signal` aborts; a later object has its body cancelled. */
export function abortable(
  get: Promise<StoredObject | undefined>,
  signal: AbortSignal,
): Promise<StoredObject | undefined> {
  const aborted = Promise.withResolvers<never>();
  const abort = () => {
    aborted.reject(signal.reason as Error);
  };
  if (signal.aborted) abort();
  else signal.addEventListener("abort", abort, { once: true });
  const settled = get.finally(() => {
    signal.removeEventListener("abort", abort);
  });
  settled.then(
    (object) => {
      if (signal.aborted && object !== undefined) discard(object.body);
    },
    () => undefined,
  );
  return Promise.race([settled, aborted.promise]);
}

/**
 * Returns exactly `object.size` bytes. Rejects, cancelling the body, when the size is over `limit`, when the stream
 * delivers more or fewer bytes than its size, or when `signal` aborts, even if the stream never ends.
 */
export async function readBounded(
  object: StoredObject,
  limit: number,
  signal: AbortSignal,
): Promise<Uint8Array<ArrayBuffer>> {
  const { body, size } = object;
  if (signal.aborted) {
    discard(body);
    throw signal.reason as Error;
  }
  if (size > limit) {
    discard(body);
    throw new Error(`object of ${size} bytes is over the ${limit}-byte limit`);
  }
  const out = new Uint8Array(size);
  const reader = body.getReader();
  const cancel = () => {
    discard(reader);
  };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    let at = 0;
    for (;;) {
      const { done, value } = await reader.read();
      // Cancelling resolves a pending read as done, so check abort before treating it as EOF.
      signal.throwIfAborted();
      if (done) {
        if (at !== size) throw new Error(`object ended after ${at} of its ${size} bytes`);
        return out;
      }
      // Checked before copying, so memory never passes `size` and an over-long stream need not end.
      if (value.length > size - at) throw new Error(`object is longer than its ${size} bytes`);
      out.set(value, at);
      at += value.length;
    }
  } catch (e) {
    discard(reader);
    throw e;
  } finally {
    signal.removeEventListener("abort", cancel);
  }
}

/** Starts cancelling without waiting: a source's `cancel` may never settle, and must not delay a reply. */
export function discard(stream: { cancel(): Promise<void> }): void {
  stream.cancel().catch(() => undefined);
}
