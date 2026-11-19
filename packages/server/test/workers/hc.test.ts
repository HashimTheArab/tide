import { SELF } from "cloudflare:test";
import { expect, test } from "vitest";

test("workers entry serves the health check", async () => {
  const res = await SELF.fetch("https://tide.test/hc");
  expect(res.status).toBe(200);
  expect(await res.text()).toBe("ok");
});
