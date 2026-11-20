import { ProtocolError } from "./hash.ts";

/** Pulls decoded bytes from one bzip2 stream, holding one block at a time. */
export interface Bunzip2Reader {
  /** Fills `into` and returns how many bytes it copied; fewer than `into.length` only at the stream's end. */
  read(into: Uint8Array): number;
  /** Refuses unless every decoded byte was read and the stream ends cleanly at the end of its input. */
  end(): void;
}

const MAX_GROUPS = 6;
const MAX_ALPHA = 258;
const MAX_CODE_LEN = 20;
const GROUP_SIZE = 50;
const MAX_SELECTORS = 18002;

const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, i) => {
  let c = i << 24;
  for (let k = 0; k < 8; k++) c = c & 0x80000000 ? (c << 1) ^ 0x04c11db7 : c << 1;
  return c >>> 0;
});

/** Returns the running bzip2 CRC after `byte`; a block's CRC starts at 0xffffffff and ends inverted. */
export function bzip2CrcStep(crc: number, byte: number): number {
  return ((crc << 8) ^ (CRC_TABLE[((crc >>> 24) ^ byte) & 0xff] ?? 0)) >>> 0;
}

/**
 * Returns a reader over the single bzip2 stream that fills `input` exactly. Every malformed, truncated or
 * CRC-failing stream, and any decoded byte past `limit`, is a ProtocolError on `field`.
 */
export function bunzip2(input: Uint8Array, field: string, limit: number): Bunzip2Reader {
  const fail = (rule: string): never => {
    throw new ProtocolError(field, rule);
  };

  // MSB-first bit reader; at most 7 bits stay buffered between reads.
  let at = 0;
  let buf = 0;
  let count = 0;
  const bits = (n: number): number => {
    while (count < n) {
      if (at >= input.length) fail("is truncated");
      buf = (buf << 8) | (input[at++] ?? 0);
      count += 8;
    }
    count -= n;
    const v = (buf >>> count) & ((1 << n) - 1);
    buf &= (1 << count) - 1;
    return v;
  };
  const bits32 = () => ((bits(16) << 16) | bits(16)) >>> 0;

  // Set by the stream header, on first use.
  let max = 0;
  let tt = new Uint32Array(0); // Block bytes in the low 8 bits, inverse BWT links above.
  const selectors = new Uint8Array(MAX_SELECTORS);
  const lengths = new Uint8Array(MAX_GROUPS * MAX_ALPHA);
  const countAt = new Int32Array(MAX_GROUPS * (MAX_CODE_LEN + 1)); // Codes of each length per group.
  const firstAt = new Int32Array(MAX_GROUPS * (MAX_CODE_LEN + 1)); // First canonical code of each length.
  const offsetAt = new Int32Array(MAX_GROUPS * (MAX_CODE_LEN + 1)); // Its index in `perm`.
  const perm = new Uint16Array(MAX_GROUPS * MAX_ALPHA);
  const seqToUnseq = new Uint8Array(256);
  const mtf = new Uint8Array(256);
  const counts = new Int32Array(256);

  let started = false;
  let done = false;
  let combined = 0;
  let produced = 0;
  // The current block's output: inverse BWT walk, then RLE1.
  let inBlock = false;
  let tPos = 0;
  let left = 0;
  let last = -1;
  let run = 0;
  let repeat = 0;
  let crc = 0;
  let expectedCrc = 0;

  function start(): void {
    started = true;
    if (bits(8) !== 0x42 || bits(8) !== 0x5a || bits(8) !== 0x68) fail("is not a bzip2 stream");
    const level = bits(8) - 0x30;
    if (level < 1 || level > 9) fail("has a bad block size");
    max = level * 100_000;
    tt = new Uint32Array(max);
  }

  /** Builds group `g`'s decode table from its code lengths, refusing lengths no prefix code can have. */
  function buildTable(g: number, alphaSize: number): void {
    const base = g * (MAX_CODE_LEN + 1);
    countAt.fill(0, base, base + MAX_CODE_LEN + 1);
    for (let s = 0; s < alphaSize; s++) {
      const len = lengths[g * MAX_ALPHA + s] ?? 0;
      countAt[base + len] = (countAt[base + len] ?? 0) + 1;
    }
    let kraft = 0;
    for (let len = 1; len <= MAX_CODE_LEN; len++) {
      kraft += (countAt[base + len] ?? 0) * 2 ** (MAX_CODE_LEN - len);
    }
    if (kraft > 2 ** MAX_CODE_LEN) fail("has an over-subscribed Huffman table");
    let code = 0;
    let index = 0;
    for (let len = 1; len <= MAX_CODE_LEN; len++) {
      const n = countAt[base + len] ?? 0;
      firstAt[base + len] = code;
      offsetAt[base + len] = index;
      for (let s = 0; s < alphaSize; s++) {
        if (lengths[g * MAX_ALPHA + s] === len) perm[g * MAX_ALPHA + index++] = s;
      }
      code = (code + n) * 2;
    }
  }

  function symbol(g: number): number {
    const base = g * (MAX_CODE_LEN + 1);
    let code = 0;
    for (let len = 1; len <= MAX_CODE_LEN; len++) {
      code = (code << 1) | bits(1);
      const d = code - (firstAt[base + len] ?? 0);
      if (d >= 0 && d < (countAt[base + len] ?? 0)) {
        return perm[g * MAX_ALPHA + (offsetAt[base + len] ?? 0) + d] ?? 0;
      }
    }
    return fail("has an undecodable Huffman code");
  }

  /** Decodes the next block into `tt`; false at the end-of-stream marker, after its checks pass. */
  function nextBlock(): boolean {
    const hi = bits(24);
    const lo = bits(24);
    if (hi === 0x177245 && lo === 0x385090) {
      if (bits32() !== combined) fail("has a bad stream CRC");
      if (buf !== 0) fail("has non-zero padding");
      if (at !== input.length) fail("has data after the stream end");
      return false;
    }
    if (hi !== 0x314159 || lo !== 0x265359) fail("has a bad block marker");
    expectedCrc = bits32();
    if (bits(1) === 1) fail("has a randomised block");
    const origPtr = bits(24);

    let nInUse = 0;
    const used = bits(16);
    for (let i = 0; i < 16; i++) {
      if ((used & (0x8000 >>> i)) === 0) continue;
      const sub = bits(16);
      for (let j = 0; j < 16; j++) if (sub & (0x8000 >>> j)) seqToUnseq[nInUse++] = i * 16 + j;
    }
    if (nInUse === 0) fail("has a block with no symbols");
    const alphaSize = nInUse + 2;

    const nGroups = bits(3);
    if (nGroups < 2 || nGroups > MAX_GROUPS) fail("has a bad Huffman group count");
    const nSelectors = bits(15);
    if (nSelectors < 1 || nSelectors > MAX_SELECTORS) fail("has a bad selector count");
    const groupMtf = [0, 1, 2, 3, 4, 5];
    for (let i = 0; i < nSelectors; i++) {
      let j = 0;
      while (bits(1) === 1) if (++j >= nGroups) fail("has a selector out of range");
      const g = groupMtf[j] ?? 0;
      groupMtf.copyWithin(1, 0, j);
      groupMtf[0] = g;
      selectors[i] = g;
    }
    for (let g = 0; g < nGroups; g++) {
      let len = bits(5);
      for (let s = 0; s < alphaSize; s++) {
        for (;;) {
          if (len < 1 || len > MAX_CODE_LEN) fail("has a bad Huffman code length");
          if (bits(1) === 0) break;
          len += bits(1) === 0 ? 1 : -1;
        }
        lengths[g * MAX_ALPHA + s] = len;
      }
      buildTable(g, alphaSize);
    }

    // Symbols: RUNA and RUNB spell zero runs, then move-to-front indexes, then end of block.
    const eob = nInUse + 1;
    for (let i = 0; i < 256; i++) mtf[i] = i;
    counts.fill(0);
    let selector = 0;
    let groupLeft = 0;
    let group = 0;
    const next = (): number => {
      if (groupLeft === 0) {
        if (selector >= nSelectors) fail("runs out of selectors");
        group = selectors[selector++] ?? 0;
        groupLeft = GROUP_SIZE;
      }
      groupLeft--;
      return symbol(group);
    };
    let nblock = 0;
    let sym = next();
    while (sym !== eob) {
      if (sym <= 1) {
        let n = 0;
        let weight = 1;
        do {
          n += (sym + 1) * weight;
          weight *= 2;
          if (nblock + n > max) fail("has a block longer than its size allows");
          sym = next();
        } while (sym <= 1);
        const uc = seqToUnseq[mtf[0] ?? 0] ?? 0;
        counts[uc] = (counts[uc] ?? 0) + n;
        tt.fill(uc, nblock, nblock + n);
        nblock += n;
        continue;
      }
      if (nblock >= max) fail("has a block longer than its size allows");
      const v = mtf[sym - 1] ?? 0;
      mtf.copyWithin(1, 0, sym - 1);
      mtf[0] = v;
      const uc = seqToUnseq[v] ?? 0;
      counts[uc] = (counts[uc] ?? 0) + 1;
      tt[nblock++] = uc;
      sym = next();
    }
    if (origPtr >= nblock) fail("has a block origin out of range");

    // Inverse BWT: link each byte to the next position in the original order.
    let sum = 0;
    for (let i = 0; i < 256; i++) {
      const c = counts[i] ?? 0;
      counts[i] = sum;
      sum += c;
    }
    for (let i = 0; i < nblock; i++) {
      const uc = (tt[i] ?? 0) & 0xff;
      const to = counts[uc] ?? 0;
      tt[to] = (tt[to] ?? 0) | (i << 8);
      counts[uc] = to + 1;
    }
    tPos = (tt[origPtr] ?? 0) >>> 8;
    left = nblock;
    last = -1;
    run = 0;
    repeat = 0;
    crc = 0xffffffff;
    return true;
  }

  function finishBlock(): void {
    const actual = ~crc >>> 0;
    if (actual !== expectedCrc) fail("has a bad block CRC");
    combined = (((combined << 1) | (combined >>> 31)) ^ actual) >>> 0;
  }

  function read(into: Uint8Array): number {
    if (!started) start();
    let n = 0;
    while (n < into.length && !done) {
      let byte: number;
      if (repeat > 0) {
        repeat--;
        byte = last;
      } else if (left === 0) {
        if (inBlock) finishBlock();
        inBlock = nextBlock();
        done = !inBlock;
        continue;
      } else {
        const entry = tt[tPos] ?? 0;
        byte = entry & 0xff;
        tPos = entry >>> 8;
        left--;
        if (run === 4) {
          // The fifth byte of a run counts its further repeats.
          repeat = byte;
          run = 0;
          continue;
        }
        if (byte === last) run++;
        else {
          last = byte;
          run = 1;
        }
        if (run === 4 && left === 0) fail("has a block that ends inside a run");
      }
      if (produced === limit) fail(`decodes to more than ${limit} bytes`);
      produced++;
      crc = bzip2CrcStep(crc, byte);
      into[n++] = byte;
    }
    return n;
  }

  return {
    read,
    end() {
      if (read(new Uint8Array(1)) !== 0) fail("has data past its end");
    },
  };
}
