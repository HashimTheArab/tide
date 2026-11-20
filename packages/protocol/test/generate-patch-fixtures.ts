// Writes the patch fixtures: golden base, target and reference bsdiff 4.3 patch triples, corrupt variants of
// patch-text.bsdiff, crafted bzip2 blocks and multiblock.bz2. Deterministic: a rerun rewrites the same bytes.
// Usage: node packages/protocol/test/generate-patch-fixtures.ts --bsdiff <path> [--out <dir>]
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { KNOWN_PATCH } from "./fixtures.ts";

const { values } = parseArgs({ options: { bsdiff: { type: "string" }, out: { type: "string" } } });
if (values.bsdiff === undefined)
  throw new Error("--bsdiff <path to reference bsdiff 4.3> is required");
const bsdiff = resolve(values.bsdiff);
const out = resolve(values.out ?? fileURLToPath(new URL("fixtures/", import.meta.url)));
const at = (file: string) => resolve(out, file);
const write = (file: string, bytes: Uint8Array) => writeFileSync(at(file), bytes);
const bzip2 = (input: Uint8Array, ...args: string[]) =>
  new Uint8Array(execFileSync("bzip2", args, { input, maxBuffer: 1 << 28 }));
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const ascii = (s: string) => new TextEncoder().encode(s);
const byte = (bytes: Uint8Array | readonly number[], i: number) => bytes[i] ?? 0;
const concat = (...parts: Uint8Array[]) => {
  const bytes = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let i = 0;
  for (const p of parts) {
    bytes.set(p, i);
    i += p.length;
  }
  return bytes;
};

/** mulberry32: a fixed sequence for each seed. */
function prng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), s | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32;
  };
}

const WORDS = [
  "value",
  "count",
  "index",
  "render",
  "props",
  "state",
  "bundle",
  "asset",
  "hash",
  "items",
];
function jsLines(seed: number, n: number): string[] {
  const r = prng(seed);
  const pick = () => WORDS[Math.floor(r() * WORDS.length)] ?? "x";
  const num = () => Math.floor(r() * 1000);
  return Array.from({ length: n }, (_, i) =>
    i % 7 === 0
      ? `export function ${pick()}${num()}(${pick()}, ${pick()}) {`
      : i % 7 === 6
        ? "}"
        : `  const ${pick()}${num()} = ${pick()}.${pick()}(${num()}, "${pick()}");`,
  );
}

// Text: deletions, an insertion, a moved block (backward seeks) and edited numbers.
const lines = jsLines(1, 700);
const edited = [...lines];
const moved = edited.splice(500, 60);
edited.splice(100, 30);
edited.splice(300, 0, ...jsLines(2, 40));
edited.splice(50, 0, ...moved);
for (let i = 0; i < edited.length; i += 37) edited[i] = (edited[i] ?? "").replace(/\d/, "9");
const textBase = ascii(lines.join("\n"));
const textTarget = ascii(edited.join("\n"));

// Binary: scattered changes whose diff bytes wrap mod 256, an insertion and a deletion.
const r = prng(3);
const binaryBase = Uint8Array.from({ length: 16384 }, () => Math.floor(r() * 256));
const changed = Uint8Array.from(binaryBase, (b, i) => (i % 97 === 0 ? (b + 200) & 0xff : b));
const binaryTarget = concat(
  changed.subarray(0, 8000),
  Uint8Array.from({ length: 300 }, () => Math.floor(r() * 256)),
  changed.subarray(8000, 12000),
  changed.subarray(12200),
);

const small = ascii(jsLines(4, 60).join("\n"));
const GOLDEN: Record<string, [Uint8Array, Uint8Array]> = {
  text: [textBase, textTarget],
  binary: [binaryBase, binaryTarget],
  identical: [small, small],
  "empty-base": [new Uint8Array(), small],
  "empty-target": [small, new Uint8Array()],
};
for (const [name, [base, target]] of Object.entries(GOLDEN)) {
  write(`patch-${name}.base`, base);
  write(`patch-${name}.target`, target);
  execFileSync(bsdiff, [
    at(`patch-${name}.base`),
    at(`patch-${name}.target`),
    at(`patch-${name}.bsdiff`),
  ]);
}

/** 8 bytes little-endian sign-magnitude, as bsdiff writes offsets. */
function offtout(value: number): Uint8Array {
  const bytes = new Uint8Array(8);
  let m = Math.abs(value);
  for (let i = 0; i < 8; i++) {
    bytes[i] = m % 256;
    m = Math.floor(m / 256);
  }
  if (value < 0 || Object.is(value, -0)) bytes[7] = byte(bytes, 7) | 0x80;
  return bytes;
}
function offtin(bytes: Uint8Array, i: number): number {
  let m = 0;
  for (let k = 6; k >= 0; k--) m = m * 256 + byte(bytes, i + k);
  return byte(bytes, i + 7) & 0x80 ? -m : m;
}

interface Patch {
  ctrl: Uint8Array;
  diff: Uint8Array;
  extra: Uint8Array;
  newSize: number;
}
function parse(patch: Uint8Array): Patch {
  const ctrlLen = offtin(patch, 8);
  const diffLen = offtin(patch, 16);
  return {
    ctrl: patch.subarray(32, 32 + ctrlLen),
    diff: patch.subarray(32 + ctrlLen, 32 + ctrlLen + diffLen),
    extra: patch.subarray(32 + ctrlLen + diffLen),
    newSize: offtin(patch, 24),
  };
}
function build(p: Patch): Uint8Array {
  const header = concat(
    ascii("BSDIFF40"),
    offtout(p.ctrl.length),
    offtout(p.diff.length),
    offtout(p.newSize),
  );
  return concat(header, p.ctrl, p.diff, p.extra);
}
const triplesOf = (ctrl: Uint8Array) => {
  const raw = bzip2(ctrl, "-dc");
  return Array.from({ length: raw.length / 24 }, (_, i) =>
    [0, 8, 16].map((k) => offtin(raw, i * 24 + k)),
  );
};
const ctrlOf = (triples: readonly (readonly number[])[]) =>
  bzip2(concat(...triples.flat().map(offtout)), "-9c");

// Applies to any base of KNOWN_PATCH.minBase bytes or more.
write(
  "patch-known.bsdiff",
  build({
    ctrl: ctrlOf(KNOWN_PATCH.triples),
    diff: bzip2(KNOWN_PATCH.diff, "-9c"),
    extra: bzip2(KNOWN_PATCH.extra, "-9c"),
    newSize: KNOWN_PATCH.newSize,
  }),
);

// Corrupt variants of patch-text.bsdiff.
const text = new Uint8Array(readFileSync(at("patch-text.bsdiff")));
const p = parse(text);
const triples = triplesOf(p.ctrl);
const [x0 = 0] = triples[0] ?? [];
const [x1 = 0] = triples[1] ?? [];
if (x0 === 0 || x1 === 0 || !triples.some((t) => byte(t, 2) < 0)) {
  throw new Error("patch-text.bsdiff no longer has the shape the corrupt variants need");
}
const withTriple = (i: number, k: number, value: number) =>
  build({ ...p, ctrl: ctrlOf(triples.map((t, j) => (j === i ? t.with(k, value) : t))) });
const withHeader = (offset: number, edit: (bytes: Uint8Array) => void) => {
  const bytes = text.slice();
  edit(bytes.subarray(offset, offset + 8));
  return bytes;
};
const withCtrl = (edit: (ctrl: Uint8Array) => void) => {
  const ctrl = p.ctrl.slice();
  edit(ctrl);
  return build({ ...p, ctrl });
};
const zero = [0, 0, 0];

const CORRUPT: Record<string, Uint8Array> = {
  "bad-magic": withHeader(0, (h) => (h[7] = 0x31)),
  "short-header": text.slice(0, 31),
  "negative-ctrl-len": withHeader(8, (h) => (h[7] = byte(h, 7) | 0x80)),
  "negative-new-size": withHeader(24, (h) => (h[7] = byte(h, 7) | 0x80)),
  "ctrl-len-past-patch": withHeader(8, (h) => h.set(offtout(text.length))),
  "length-2-53": withHeader(16, (h) => h.set(offtout(2 ** 53))),
  "oversize-new-size": withHeader(24, (h) => h.set(offtout(2 ** 40))),
  "negative-add": withTriple(0, 0, -x0),
  "add-past-output": withTriple(0, 0, p.newSize + 1),
  "copy-past-output": withTriple(0, 1, p.newSize + 1),
  "negative-zero-seek": withTriple(0, 2, -0),
  "seek-before-base": withTriple(0, 2, -(x0 + 1)),
  "read-past-base": withTriple(0, 2, textBase.length - x0),
  "leftover-triple": build({ ...p, ctrl: ctrlOf([...triples, zero]) }),
  "zero-progress": build({
    ...p,
    ctrl: ctrlOf([...Array.from({ length: p.newSize + 2 }, () => zero), ...triples]),
  }),
  "unused-diff-byte": build({
    ...p,
    diff: bzip2(concat(bzip2(p.diff, "-dc"), new Uint8Array(1)), "-9c"),
  }),
  "truncated-extra": text.slice(0, -10),
  "truncated-diff": withHeader(16, (h) => h.set(offtout(Math.floor(p.diff.length / 2)))),
  "bad-block-crc": withCtrl((c) => (c[10] = byte(c, 10) ^ 0x01)),
  "bad-stream-crc": withCtrl((c) => flipStreamCrc(c)),
  "randomised-block": withCtrl((c) => (c[14] = byte(c, 14) | 0x80)),
  "trailing-byte": concat(text, new Uint8Array(1)),
  "second-stream": concat(text, bzip2(new Uint8Array(), "-9c")),
};
for (const [name, bytes] of Object.entries(CORRUPT)) write(`patch-bad-${name}.bsdiff`, bytes);

/** Flips the first bit of the stream CRC that follows the end-of-stream marker. */
function flipStreamCrc(stream: Uint8Array): void {
  const bit = (i: number) => (byte(stream, i >> 3) >> (7 - (i & 7))) & 1;
  const total = stream.length * 8;
  for (let start = total - 80; start > total - 88; start--) {
    let marker = 0n;
    for (let i = 0; i < 48; i++) marker = (marker << 1n) | BigInt(bit(start + i));
    if (marker === 0x177245385090n) {
      const i = (start + 48) >> 3;
      stream[i] = byte(stream, i) ^ (0x80 >> ((start + 48) & 7));
      return;
    }
  }
  throw new Error("no end-of-stream marker");
}

// Crafted blocks bzip2 never writes: an unused Huffman group, and a run of four with no count byte.
const ctrlData = bzip2(p.ctrl, "-dc");
const extraGroup = craftStream(rle1(ctrlData), ctrlData, "copy");
const badGroup = craftStream(rle1(ctrlData), ctrlData, "over-subscribed");
if (sha256(bzip2(extraGroup, "-dc")) !== sha256(ctrlData))
  throw new Error("crafted stream is wrong");
write("patch-text-extra-group.bsdiff", build({ ...p, ctrl: extraGroup }));
write("patch-bad-huffman-unused.bsdiff", build({ ...p, ctrl: badGroup }));
const run = ascii("xaaaa");
const runControl = craftStream(rle1(run), run);
if (sha256(bzip2(runControl, "-dc")) !== sha256(run)) throw new Error("crafted stream is wrong");
write("bzip2-run-control.bz2", runControl);
write("bzip2-run-at-block-end.bz2", craftStream(run, run)); // No RLE1: the run's count byte is missing.

// Several level-1 blocks, with runs long enough to need RLE1 counts.
const multi = ascii(
  jsLines(5, 6000)
    .map((l, i) => (i % 50 === 0 ? `${l}${"x".repeat(300 + i)}` : l))
    .join("\n"),
);
write("multiblock.bz2", bzip2(multi, "-1c"));
process.stdout.write(`multiblock.bz2: ${multi.length} bytes, SHA-256 ${sha256(multi)}\n`);

/** bzip2's first stage: runs of 4 to 259 equal bytes become 4 bytes and a count. */
function rle1(data: Uint8Array): Uint8Array {
  const s: number[] = [];
  for (let i = 0; i < data.length;) {
    let n = 1;
    const b = byte(data, i);
    while (n < 259 && i + n < data.length && data[i + n] === b) n++;
    if (n >= 4) s.push(b, b, b, b, n - 4);
    else for (let k = 0; k < n; k++) s.push(b);
    i += n;
  }
  return Uint8Array.from(s);
}

/**
 * Returns a one-block bzip2 stream over the RLE1 output `s`, its CRC taken over `decoded`. Every code has one length;
 * `extra` adds a third Huffman group that no selector names.
 */
function craftStream(
  s: Uint8Array,
  decoded: Uint8Array,
  extra?: "copy" | "over-subscribed",
): Uint8Array {
  const bits: number[] = [];
  const put = (value: number, n: number) => {
    for (let i = n - 1; i >= 0; i--) bits.push(Math.floor(value / 2 ** i) % 2);
  };
  const n = s.length;
  const rotations = Array.from({ length: n }, (_, i) => i).sort((a, b) => {
    for (let k = 0; k < n; k++) {
      const d = byte(s, (a + k) % n) - byte(s, (b + k) % n);
      if (d !== 0) return d;
    }
    return 0;
  });
  const last = rotations.map((i) => byte(s, (i + n - 1) % n));
  const used = [...new Set(last)].sort((a, b) => a - b);
  const mtf = used.map((_, i) => i);
  const syms: number[] = [];
  let zeros = 0;
  // A zero run in bijective base 2: RUNA is digit 1, RUNB digit 2, least significant first.
  const flush = () => {
    for (let z = zeros - 1; zeros > 0; z = (z - 2) >> 1) {
      syms.push(z & 1);
      if (z < 2) break;
    }
    zeros = 0;
  };
  for (const b of last) {
    const j = mtf.indexOf(used.indexOf(b));
    if (j === 0) {
      zeros++;
      continue;
    }
    flush();
    mtf.unshift(...mtf.splice(j, 1));
    syms.push(j + 1);
  }
  flush();
  syms.push(used.length + 1);

  const alpha = used.length + 2;
  const len = Math.max(1, Math.ceil(Math.log2(alpha)));
  const tables = [len, len, ...(extra === undefined ? [] : [extra === "copy" ? len : 1])];
  let crc = 0xffffffff;
  for (const b of decoded) crc = ((crc << 8) ^ crcByte((crc >>> 24) ^ b)) >>> 0;
  crc = ~crc >>> 0;

  for (const c of ascii("BZh9")) put(c, 8);
  put(0x314159, 24);
  put(0x265359, 24);
  put(crc, 32);
  put(0, 1);
  put(rotations.indexOf(0), 24);
  const ranges = new Set(used.map((b) => b >> 4));
  for (let i = 0; i < 16; i++) put(ranges.has(i) ? 1 : 0, 1);
  for (let i = 0; i < 16; i++) {
    if (!ranges.has(i)) continue;
    for (let j = 0; j < 16; j++) put(used.includes(i * 16 + j) ? 1 : 0, 1);
  }
  put(tables.length, 3);
  const nSelectors = Math.ceil(syms.length / 50);
  put(nSelectors, 15);
  for (let i = 0; i < nSelectors; i++) put(0, 1);
  for (const length of tables) {
    put(length, 5);
    for (let k = 0; k < alpha; k++) put(0, 1); // Every symbol keeps the starting length.
  }
  for (const sym of syms) put(sym, len); // Equal lengths: each symbol's code is its index.
  put(0x177245, 24);
  put(0x385090, 24);
  put(crc, 32);
  while (bits.length % 8 !== 0) bits.push(0);
  return Uint8Array.from({ length: bits.length / 8 }, (_, i) =>
    bits.slice(i * 8, i * 8 + 8).reduce((v, b) => v * 2 + b, 0),
  );
}

function crcByte(index: number): number {
  let c = (index & 0xff) << 24;
  for (let k = 0; k < 8; k++) c = c & 0x80000000 ? (c << 1) ^ 0x04c11db7 : c << 1;
  return c >>> 0;
}
