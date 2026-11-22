// OpenSSL, through Node, agrees with the chain goldens' links, CA flags and validity windows.
import { X509Certificate } from "node:crypto";
import { readFileSync } from "node:fs";
import { expect, test } from "vitest";

import { CHAIN_NOW } from "./fixtures.ts";

const read = (name: string) =>
  new X509Certificate(readFileSync(new URL(`fixtures/${name}`, import.meta.url)));
const FILES = [
  "chain-root.pem",
  "chain-intermediate.pem",
  "chain-leaf.pem",
  "chain-short-leaf.pem",
];

test.each([
  ["chain-leaf.pem", "chain-intermediate.pem"],
  ["chain-intermediate.pem", "chain-root.pem"],
  ["chain-short-leaf.pem", "chain-root.pem"],
  ["chain-root.pem", "chain-root.pem"],
])("%s is issued and signed by %s", (child, issuer) => {
  const [c, i] = [read(child), read(issuer)];
  expect(c.checkIssued(i)).toBe(true);
  expect(c.verify(i.publicKey)).toBe(true);
});

test("only the root and the intermediate are CAs, and every window holds CHAIN_NOW", () => {
  const certs = FILES.map(read);
  expect(certs.map((c) => c.ca)).toEqual([true, true, false, false]);
  for (const c of certs) {
    expect(c.validFromDate.getTime()).toBeLessThan(CHAIN_NOW.getTime());
    expect(c.validToDate.getTime()).toBeGreaterThan(CHAIN_NOW.getTime());
  }
});
