/** libbzip2's `nblockMAX` at level 9: the most RLE1 bytes one block holds. */
const BLOCK_MAX = 900_000 - 19;
const MAX_RUN = 255; // libbzip2's longest RLE1 run.
const MAX_CODE_LEN = 17; // libbzip2's encoder limit; decoders accept 20.
const GROUP_SIZE = 50;

const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, i) => {
  let c = i << 24;
  for (let k = 0; k < 8; k++) c = c & 0x80000000 ? (c << 1) ^ 0x04c11db7 : c << 1;
  return c >>> 0;
});

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
    for (let i = start; i < at; i++) {
      crc = ((crc << 8) ^ (CRC_TABLE[((crc >>> 24) ^ (input[i] ?? 0)) & 0xff] ?? 0)) >>> 0;
    }
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
 * Returns the start of each cyclic rotation of `bytes` in sorted order. With `sentinel`, a symbol below every byte
 * follows `bytes`, so rotation order is suffix order and the result has `bytes.length + 1` entries, the empty suffix
 * first. Equal rotations, which only a periodic input without a sentinel has, come in an unspecified fixed order.
 */
export function sortRotations(bytes: Uint8Array, sentinel: boolean): Int32Array {
  // Larsson–Sadakane prefix doubling. `order` holds rotations, or -k at the head of k sorted ones; `group` maps each
  // rotation to the index in `order` of the last member of its group, which ranks it by its first h symbols.
  const len = bytes.length;
  const n = len + (sentinel ? 1 : 0);
  const order = new Int32Array(n);
  const group = new Int32Array(n);
  if (n === 0) return order;

  // Bucket by first symbol; the sentinel is symbol 0, byte b is b + 1.
  const next = new Int32Array(258);
  for (const b of bytes) next[b + 2] = (next[b + 2] ?? 0) + 1;
  if (sentinel) next[1] = 1;
  for (let s = 1; s < 258; s++) next[s] = (next[s] ?? 0) + (next[s - 1] ?? 0);
  if (sentinel) {
    order[0] = len;
    next[0] = 1;
  }
  for (let i = 0; i < len; i++) {
    const s = (bytes[i] ?? 0) + 1;
    const at = next[s] ?? 0;
    order[at] = i;
    next[s] = at + 1;
  }
  // `next[s]` is now the end of symbol s's bucket.
  for (let i = 0; i < len; i++) group[i] = (next[(bytes[i] ?? 0) + 1] ?? 0) - 1;
  if (sentinel) group[len] = 0;
  for (let s = 0; s < 257; s++) {
    if ((next[s] ?? 0) - (s === 0 ? 0 : (next[s - 1] ?? 0)) === 1) order[(next[s] ?? 0) - 1] = -1;
  }

  // Rotations still equal after n symbols are identical, so h stops at n.
  for (let h = 1; order[0] !== -n && h < n; h *= 2) {
    let run = 0;
    let i = 0;
    while (i < n) {
      const v = order[i] ?? 0;
      if (v < 0) {
        run -= v;
        i -= v;
        continue;
      }
      if (run > 0) order[i - run] = -run;
      run = 0;
      const size = (group[v] ?? 0) + 1 - i;
      split(order, group, i, size, h);
      i += size;
    }
    if (run > 0) order[i - run] = -run;
  }

  // Sorted positions are all negative; each singleton's group is its index. Unsorted groups keep their members.
  for (let i = 0; i < n; i++) {
    const g = group[i] ?? 0;
    if ((order[g] ?? 0) < 0) order[g] = i;
  }
  return order;
}

/**
 * Sorts the group `order[start, start + size)` by the rank of the rotation h symbols on, splitting it into new
 * groups. Recurses on the smaller side and loops on the larger, so the stack is O(log n) deep.
 */
function split(order: Int32Array, group: Int32Array, start: number, size: number, h: number): void {
  const n = group.length;
  const key = (at: number) => {
    const j = (order[at] ?? 0) + h;
    return group[j >= n ? j - n : j] ?? 0;
  };
  const swap = (a: number, b: number) => {
    const t = order[a] ?? 0;
    order[a] = order[b] ?? 0;
    order[b] = t;
  };
  while (size > 0) {
    const end = start + size;
    if (size < 16) {
      // Selection: move the smallest keys to the front, make them a group, repeat on the rest.
      for (let k = start, j = 0; k < end; k += j) {
        let x = key(k);
        j = 1;
        for (let i = k + 1; i < end; i++) {
          const v = key(i);
          if (v < x) {
            x = v;
            j = 0;
          }
          if (v === x) swap(k + j++, i);
        }
        for (let i = k; i < k + j; i++) group[order[i] ?? 0] = k + j - 1;
        if (j === 1) order[k] = -1;
      }
      return;
    }
    const a = key(start);
    const b = key(start + (size >> 1));
    const c = key(end - 1);
    const x = a < b ? (b < c ? b : a < c ? c : a) : a < c ? a : b < c ? c : b;
    let lt = start;
    let gt = end;
    for (let i = start; i < gt;) {
      const v = key(i);
      if (v < x) swap(lt++, i++);
      else if (v > x) swap(i, --gt);
      else i++;
    }
    // Each part is numbered by its own end at once, so every number stays consistent with the order whichever part
    // is refined first. The upper part's members already hold its end.
    for (let i = start; i < lt; i++) group[order[i] ?? 0] = lt - 1;
    for (let i = lt; i < gt; i++) group[order[i] ?? 0] = gt - 1;
    if (gt - lt === 1) order[lt] = -1;
    if (lt - start < end - gt) {
      split(order, group, start, lt - start, h);
      start = gt;
      size = end - gt;
    } else {
      split(order, group, gt, end - gt, h);
      size = lt - start;
    }
  }
}
