import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, expect, test } from "vitest";

import { startServer } from "../../src/node.ts";

let server: Awaited<ReturnType<typeof startServer>>;
let base: string;

beforeAll(async () => {
  server = await startServer(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

test("node entry serves the health check", async () => {
  const res = await fetch(`${base}/hc`);
  expect(res.status).toBe(200);
  expect(await res.text()).toBe("ok");
});
