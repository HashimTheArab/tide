// Stands in for an app's hermesc, which Tide runs but does not ship.
// Usage, through the shim `installFakeHermes` writes: node fake-hermesc.ts <log> <hermesc args...>
// Each run appends {args, cwd, env} as one JSON line to <log>. `-version` prints FAKE_VERSION; a compile writes fakeHbc.
import { createHash } from "node:crypto";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const FAKE_VERSION = 99;
const MAGIC = [0xc6, 0x1f, 0xbc, 0x03, 0xc1, 0x03, 0x19, 0x1f];
const PAYLOAD = 64 * 1024;

/**
 * Returns a fake Hermes bytecode file: one fixed incompressible payload with the JS, and the base's SHA-256 when
 * given, written at fixed offsets. Any two outputs differ in a few dozen bytes, so a bsdiff between them is small.
 */
export function fakeHbc(
  js: Uint8Array,
  base?: Uint8Array,
  version = FAKE_VERSION,
): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(12 + PAYLOAD);
  out.set(MAGIC);
  new DataView(out.buffer).setUint32(8, version, true);
  for (let i = 0; i * 32 < PAYLOAD; i++) {
    out.set(createHash("sha256").update(`fake-hermesc ${i}`).digest(), 12 + i * 32);
  }
  out.set(js.subarray(0, 1024), 12 + 1024);
  if (base !== undefined) out.set(createHash("sha256").update(base).digest(), 12 + 32 * 1024);
  return out;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [log = "", ...args] = process.argv.slice(2);
  appendFileSync(log, `${JSON.stringify({ args, cwd: process.cwd(), env: process.env })}\n`);
  if (args[0] === "-version") {
    console.log(`Hermes JavaScript compiler.\n  HBC bytecode version: ${FAKE_VERSION}`);
  } else {
    const out = args[args.indexOf("-out") + 1] ?? "";
    const input = args.find((a, i) => !a.startsWith("-") && args[i - 1] !== "-out") ?? "";
    const base = args.find((a) => a.startsWith("-base-bytecode="))?.slice("-base-bytecode=".length);
    writeFileSync(
      out,
      fakeHbc(readFileSync(input), base === undefined ? undefined : readFileSync(base)),
    );
  }
}
