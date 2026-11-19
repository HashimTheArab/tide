import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { expect, test } from "vitest";

import { readBounded } from "../../src/core/store.ts";
import { stallCases } from "../shared/stall-cases.ts";

stallCases();

// Node only: workerd exposes no heap measure. The abort race must not keep a reaction per chunk.
test("readBounded holds no memory per chunk while reading", async () => {
  setFlagsFromString("--expose-gc");
  const gc = runInNewContext("gc") as () => void;
  const chunks = 100_000;
  let sent = 0;
  let during = 0;
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        if (sent === chunks - 1) {
          gc();
          during = process.memoryUsage().heapUsed;
        }
        if (sent++ < chunks) controller.enqueue(new Uint8Array([1]));
        else controller.close();
      },
    },
    { highWaterMark: 0 },
  );
  gc();
  const before = process.memoryUsage().heapUsed;
  await readBounded({ body, size: chunks }, chunks, new AbortController().signal);
  // The old per-chunk race kept about 550 bytes a chunk, over 50 MiB here.
  expect(during - before).toBeLessThan(16 * 2 ** 20);
});
