import { bzip2CrcStep } from "@tide-ota/protocol";

/** libbzip2's `nblockMAX` at level 9: the most RLE1 bytes one block holds. */
const BLOCK_MAX = 900_000 - 19;
const MAX_RUN = 255; // libbzip2's longest RLE1 run.
const MAX_CODE_LEN = 17; // libbzip2's encoder limit; decoders accept 20.
const GROUP_SIZE = 50;

/** Returns `input` as one level-9 bzip2 stream; an empty input gives a stream with no blocks. */
export function bzip2(input: Uint8Array): Uint8Array<ArrayBuffer> {
  const w = bitWriter(input.length);
  for (const c of [0x42, 0x5a, 0x68, 0x39]) w.put(8, c); // "BZh9"
  const block = new Uint8Array(Math.min(BLOCK_MAX, 2 * input.length));
  let combined = 0;
  let at = 0;
  while (at < input.length) {
    // RLE1, one whole token at a time, so no block ends inside a run.
    const start = at;
    let n = 0;
    while (at < input.length) {
      const b = input[at] ?? 0;
      let run = 1;
      while (run < MAX_RUN && at + run < input.length && input[at + run] === b) run++;
      if (run < 4) {
        if (n + run > BLOCK_MAX) break;
        block.fill(b, n, n + run);
        n += run;
      } else {
        if (n + 5 > BLOCK_MAX) break;
        block.fill(b, n, n + 4);
        block[n + 4] = run - 4;
        n += 5;
      }
      at += run;
    }
    let crc = 0xffffffff;
    for (let i = start; i < at; i++) crc = bzip2CrcStep(crc, input[i] ?? 0);
    crc = ~crc >>> 0;
    writeBlock(w, block.subarray(0, n), crc);
    combined = (((combined << 1) | (combined >>> 31)) ^ crc) >>> 0;
  }
  w.put(24, 0x177245);
  w.put(24, 0x385090);
  w.put(16, combined >>> 16);
  w.put(16, combined & 0xffff);
  return w.finish();
}

function writeBlock(w: BitWriter, block: Uint8Array, crc: number): void {
  const n = block.length;
  const order = sortRotations(block, false);

  const seq = new Int16Array(256).fill(-1); // Byte to its index among the bytes in use.
  for (const b of block) seq[b] = 0;
  let nInUse = 0;
  for (let b = 0; b < 256; b++) if (seq[b] === 0) seq[b] = nInUse++;

  // Move-to-front over the last column; zero runs become RUNA (0) and RUNB (1) digits, bijective base 2.
  const syms = new Uint16Array(n + 1);
  const mtf = Uint8Array.from({ length: nInUse }, (_, i) => i);
  let nSyms = 0;
  let zeros = 0;
  let origPtr = 0;
  const flush = () => {
    if (zeros === 0) return;
    for (let z = zeros - 1; ; z = (z - 2) >>> 1) {
      syms[nSyms++] = z & 1;
      if (z < 2) break;
    }
    zeros = 0;
  };
  for (let i = 0; i < n; i++) {
    const r = order[i] ?? 0;
    if (r === 0) origPtr = i;
    const s = seq[block[(r === 0 ? n : r) - 1] ?? 0] ?? 0;
    if (mtf[0] === s) {
      zeros++;
      continue;
    }
    flush();
    let prev = mtf[0] ?? 0;
    mtf[0] = s;
    let j = 1;
    for (; mtf[j] !== s; j++) {
      const next = mtf[j] ?? 0;
      mtf[j] = prev;
      prev = next;
    }
    mtf[j] = prev;
    syms[nSyms++] = j + 1;
  }
  flush();
  const alphaSize = nInUse + 2;
  syms[nSyms++] = alphaSize - 1; // End of block.

  // One Huffman table, written into both of the two slots the format requires; every selector names it.
  const freq = new Int32Array(alphaSize);
  for (let i = 0; i < nSyms; i++) {
    const s = syms[i] ?? 0;
    freq[s] = (freq[s] ?? 0) + 1;
  }
  const lengths = codeLengths(freq);
  const codes = new Int32Array(alphaSize);
  let code = 0;
  for (let len = 1; len <= MAX_CODE_LEN; len++) {
    for (let s = 0; s < alphaSize; s++) if (lengths[s] === len) codes[s] = code++;
    code <<= 1;
  }

  w.put(24, 0x314159);
  w.put(24, 0x265359);
  w.put(16, crc >>> 16);
  w.put(16, crc & 0xffff);
  w.put(1, 0); // Not randomised.
  w.put(24, origPtr);
  let ranges = 0;
  for (let b = 0; b < 256; b++) if ((seq[b] ?? -1) >= 0) ranges |= 0x8000 >>> (b >> 4);
  w.put(16, ranges);
  for (let r = 0; r < 16; r++) {
    if ((ranges & (0x8000 >>> r)) === 0) continue;
    let used = 0;
    for (let j = 0; j < 16; j++) if ((seq[r * 16 + j] ?? -1) >= 0) used |= 0x8000 >>> j;
    w.put(16, used);
  }
  w.put(3, 2);
  const nSelectors = Math.ceil(nSyms / GROUP_SIZE);
  w.put(15, nSelectors);
  for (let i = 0; i < nSelectors; i++) w.put(1, 0);
  for (let t = 0; t < 2; t++) {
    let curr = lengths[0] ?? 0;
    w.put(5, curr);
    for (let s = 0; s < alphaSize; s++) {
      const len = lengths[s] ?? 0;
      for (; curr < len; curr++) w.put(2, 2);
      for (; curr > len; curr--) w.put(2, 3);
      w.put(1, 0);
    }
  }
  for (let i = 0; i < nSyms; i++) {
    const s = syms[i] ?? 0;
    w.put(lengths[s] ?? 0, codes[s] ?? 0);
  }
}

/**
 * Returns Huffman code lengths of at most 17 bits for every symbol, from a two-queue build over `max(freq, 1)` with
 * ties broken by symbol and leaves before internal nodes, so the result depends only on `freq`.
 */
function codeLengths(freq: Int32Array): Int32Array {
  const n = freq.length;
  const weight = Array.from(freq, (f) => Math.max(1, f));
  const leaves = Array.from({ length: n }, (_, i) => i);
  const nodeWeight = new Float64Array(2 * n - 1);
  const parent = new Int32Array(2 * n - 1);
  const depth = new Int32Array(2 * n - 1);
  for (;;) {
    leaves.sort((a, b) => (weight[a] ?? 0) - (weight[b] ?? 0) || a - b);
    for (let i = 0; i < n; i++) nodeWeight[i] = weight[i] ?? 0;
    let leaf = 0;
    let inner = n;
    const take = (made: number): number => {
      const l = leaves[leaf];
      if (l !== undefined && (inner >= made || (nodeWeight[l] ?? 0) <= (nodeWeight[inner] ?? 0))) {
        leaf++;
        return l;
      }
      return inner++;
    };
    for (let made = n; made < 2 * n - 1; made++) {
      const a = take(made);
      const b = take(made);
      nodeWeight[made] = (nodeWeight[a] ?? 0) + (nodeWeight[b] ?? 0);
      parent[a] = made;
      parent[b] = made;
    }
    // A parent is made after its children, so walking down from the root sets each depth after its parent's.
    depth[2 * n - 2] = 0;
    let longest = 0;
    for (let i = 2 * n - 3; i >= 0; i--) {
      depth[i] = (depth[parent[i] ?? 0] ?? 0) + 1;
      if (i < n) longest = Math.max(longest, depth[i] ?? 0);
    }
    if (longest <= MAX_CODE_LEN) return depth.slice(0, n);
    for (let i = 0; i < n; i++) weight[i] = Math.max(1, (weight[i] ?? 0) >> 1);
  }
}

interface BitWriter {
  put(n: number, value: number): void; // `n` is at most 24 bits; `value` is below 2^n.
  finish(): Uint8Array<ArrayBuffer>; // Pads the last byte with zeros.
}

function bitWriter(sizeHint: number): BitWriter {
  let bytes = new Uint8Array(Math.max(64, sizeHint >> 2));
  let length = 0;
  let buf = 0;
  let count = 0; // At most 7 bits stay in `buf` between calls.
  const byte = (b: number) => {
    if (length === bytes.length) {
      const grown = new Uint8Array(bytes.length * 2);
      grown.set(bytes);
      bytes = grown;
    }
    bytes[length++] = b;
  };
  return {
    put(n, value) {
      buf = (buf << n) | value;
      count += n;
      while (count >= 8) {
        count -= 8;
        byte((buf >>> count) & 0xff);
      }
      buf &= (1 << count) - 1;
    },
    finish() {
      if (count > 0) byte((buf << (8 - count)) & 0xff);
      count = 0;
      return bytes.slice(0, length);
    },
  };
}

/**
 * Returns the start of each cyclic rotation of `bytes` in sorted order, in O(n log n) for any input. With `sentinel`,
 * a symbol below every byte follows `bytes`, so rotation order is suffix order and the result has `bytes.length + 1`
 * entries, the empty suffix first. Equal rotations, which only a periodic input without a sentinel has, come in an
 * unspecified fixed order.
 */
export function sortRotations(bytes: Uint8Array, sentinel: boolean): Int32Array {
  // Prefix doubling: each round counting-sorts by (rank of the first h symbols, rank of the next h).
  const len = bytes.length;
  const n = len + (sentinel ? 1 : 0);
  const sa = new Int32Array(n);
  let rank = new Int32Array(n);
  let tmp = new Int32Array(n);
  const cnt = new Int32Array(Math.max(258, n + 1));
  for (let i = 0; i < len; i++) rank[i] = (bytes[i] ?? 0) + 1; // The sentinel is rank 0.
  for (let i = 0; i < n; i++) tmp[i] = i;
  let classes = 258;
  for (let h = 0; ; h = h === 0 ? 1 : 2 * h) {
    // `tmp` lists rotations in order of their second key; a stable sort by the first key orders them by both.
    cnt.fill(0, 0, classes);
    for (let i = 0; i < n; i++) {
      const r = rank[i] ?? 0;
      cnt[r] = (cnt[r] ?? 0) + 1;
    }
    for (let c = 1; c < classes; c++) cnt[c] = (cnt[c] ?? 0) + (cnt[c - 1] ?? 0);
    for (let i = n - 1; i >= 0; i--) {
      const j = tmp[i] ?? 0;
      const r = rank[j] ?? 0;
      const at = (cnt[r] ?? 0) - 1;
      cnt[r] = at;
      sa[at] = j;
    }
    // Renumber densely; a rotation's class is now its first 2h symbols (its first symbol in round 0).
    let c = 0;
    for (let i = 0; i < n; i++) {
      const a = sa[i] ?? 0;
      const b = sa[i - 1] ?? 0;
      const ah = a + h < n ? a + h : a + h - n;
      const bh = b + h < n ? b + h : b + h - n;
      if (i > 0 && (rank[a] !== rank[b] || (h > 0 && rank[ah] !== rank[bh]))) c++;
      tmp[a] = c;
    }
    [rank, tmp] = [tmp, rank];
    classes = c + 1;
    // Rotations still equal after n symbols are identical.
    const next = h === 0 ? 1 : 2 * h;
    if (classes >= n || next >= n) return sa;
    for (let i = 0; i < n; i++) {
      const j = (sa[i] ?? 0) - next;
      tmp[i] = j < 0 ? j + n : j;
    }
  }
}
