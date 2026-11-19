import type { S3Config } from "@tide/protocol";
import { S3Error, s3Absent, s3BodyProblem, s3Fetch, s3Target } from "@tide/protocol";

import type { Store } from "./store.ts";

/**
 * Returns a store that reads objects with signed GetObject requests; the credentials need only s3:GetObject and
 * s3:ListBucket. `timeoutMs` lasts until a 200's headers, or a non-200's error body, have arrived.
 */
export function s3Store(config: S3Config & { readonly timeoutMs?: number }): Store {
  const target = s3Target(config);
  const timeoutMs = config.timeoutMs ?? 10_000;
  const operation = "GetObject";

  return {
    async get(key, signal) {
      const controller = new AbortController();
      const timer = setTimeout(() => {
        controller.abort();
      }, timeoutMs);
      try {
        const res = await s3Fetch(
          target,
          { method: "GET", key },
          // The caller's signal also ends a body mid-read.
          signal === undefined ? controller.signal : AbortSignal.any([controller.signal, signal]),
        );
        if (res.status === 200) {
          clearTimeout(timer); // A long download must not be cut off.
          const problem = s3BodyProblem(res);
          if (problem !== undefined || res.body === null) {
            await res.body?.cancel(); // Releases the connection.
            throw new S3Error(operation, { problem: problem ?? "length" });
          }
          return { body: res.body, size: Number(res.headers.get("content-length")) };
        }
        return await s3Absent(operation, res);
      } catch (e) {
        if (e instanceof S3Error) throw e;
        if (!controller.signal.aborted && signal?.aborted) throw signal.reason as Error;
        // fetch's own text is not ours to log.
        throw S3Error.unanswered(operation, controller.signal.aborted, timeoutMs);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
