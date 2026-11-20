/*-
 * Copyright 2003-2005 Colin Percival
 * All rights reserved
 *
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted providing that the following conditions
 * are met:
 * 1. Redistributions of source code must retain the above copyright
 *    notice, this list of conditions and the following disclaimer.
 * 2. Redistributions in binary form must reproduce the above copyright
 *    notice, this list of conditions and the following disclaimer in the
 *    documentation and/or other materials provided with the distribution.
 *
 * THIS SOFTWARE IS PROVIDED BY THE AUTHOR ``AS IS'' AND ANY EXPRESS OR
 * IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
 * WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE
 * ARE DISCLAIMED.  IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY
 * DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
 * DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS
 * OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION)
 * HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT,
 * STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING
 * IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE
 * POSSIBILITY OF SUCH DAMAGE.
 */

// The matching below is a port of bsdiff 4.3's search and scan loop, with a work budget added.

import { applyBsdiff } from "@tide/protocol";

import { bzip2, sortRotations } from "./bzip2.ts";

/** The largest base or target `makeBsdiff` takes, which keeps every suffix index far inside an Int32Array. */
export const MAX_BSDIFF_INPUT = 64 * 1024 * 1024;

// Matching may compare this many bytes per input byte, plus a floor, before it writes the rest as extra bytes.
const WORK_PER_BYTE = 32;
const WORK_FLOOR = 2 ** 24;

/**
 * Returns a BSDIFF40 patch from `base` to `target`, which depends only on the input bytes. Throws a RangeError when
 * either is over `MAX_BSDIFF_INPUT`, and an Error if protocol `applyBsdiff` does not turn the patch back into `target`.
 */
export function makeBsdiff(base: Uint8Array, target: Uint8Array): Uint8Array<ArrayBuffer> {
  const blocks = diffBlocks(base, target);
  const ctrl = bzip2(blocks.ctrl);
  const diff = bzip2(blocks.diff);
  const extra = bzip2(blocks.extra);
  const patch = new Uint8Array(32 + ctrl.length + diff.length + extra.length);
  patch.set(new TextEncoder().encode("BSDIFF40"));
  offtout(ctrl.length, patch, 8);
  offtout(diff.length, patch, 16);
  offtout(target.length, patch, 24);
  patch.set(ctrl, 32);
  patch.set(diff, 32 + ctrl.length);
  patch.set(extra, 32 + ctrl.length + diff.length);

  let applied: Uint8Array;
  try {
    applied = applyBsdiff(base, patch, target.length);
  } catch (e) {
    throw new Error("makeBsdiff wrote a patch that applyBsdiff refuses", { cause: e });
  }
  if (applied.length !== target.length || applied.some((b, i) => b !== target[i])) {
    throw new Error("makeBsdiff wrote a patch that does not reproduce the target");
  }
  return patch;
}

/**
 * Returns bsdiff 4.3's uncompressed ctrl, diff and extra blocks; `exhausted` is set when matching hit its work budget
 * and wrote the rest of the target as extra bytes.
 */
export function diffBlocks(base: Uint8Array, target: Uint8Array) {
  if (base.length > MAX_BSDIFF_INPUT || target.length > MAX_BSDIFF_INPUT) {
    throw new RangeError(`makeBsdiff takes inputs of at most ${MAX_BSDIFF_INPUT} bytes`);
  }
  const oldsize = base.length;
  const newsize = target.length;
  const I = sortRotations(base, true).order;

  // Every byte `search` compares counts; once the budget is spent, matching stops.
  const budget = WORK_PER_BYTE * (oldsize + newsize) + WORK_FLOOR;
  let work = 0;
  const spent = () => work >= budget;
  /** Returns how many bytes `base[o..]` and `target[t..]` share, comparing at most `max`. */
  const common = (o: number, t: number, max: number): number => {
    const limit = Math.min(max, budget - work);
    let i = 0;
    while (i < limit && base[o + i] === target[t + i]) i++;
    work += i < limit ? i + 1 : limit;
    return i;
  };
  const matchlen = (o: number, t: number) => common(o, t, Math.min(oldsize - o, newsize - t));
  let pos = 0;
  /** Returns the longest match for `target[scan..]` and sets `pos` to its start in `base`. */
  const search = (scan: number): number => {
    let st = 0;
    let en = oldsize;
    while (en - st >= 2 && !spent()) {
      const x = st + ((en - st) >>> 1);
      const o = I[x] ?? 0;
      const max = Math.min(oldsize - o, newsize - scan);
      const i = common(o, scan, max);
      if (i < max && (base[o + i] ?? 0) < (target[scan + i] ?? 0)) st = x;
      else en = x;
    }
    const s = I[st] ?? 0;
    const e = I[en] ?? 0;
    const x = matchlen(s, scan);
    const y = matchlen(e, scan);
    pos = x > y ? s : e;
    return x > y ? x : y;
  };

  const ctrl: number[] = []; // Triples of add length, copy length and seek.
  const db = new Uint8Array(newsize);
  const eb = new Uint8Array(newsize);
  let dblen = 0;
  let eblen = 0;
  let scan = 0;
  let len = 0;
  let lastscan = 0;
  let lastpos = 0;
  let lastoffset = 0;
  while (scan < newsize) {
    let oldscore = 0;
    for (let scsc = (scan += len); scan < newsize; scan++) {
      len = search(scan);
      if (spent()) {
        scan = newsize;
        break;
      }
      for (; scsc < scan + len; scsc++) if (base[scsc + lastoffset] === target[scsc]) oldscore++;
      if ((len === oldscore && len !== 0) || len > oldscore + 8) break;
      if (base[scan + lastoffset] === target[scan]) oldscore--;
    }

    if (len !== oldscore || scan === newsize) {
      // Out of budget, nothing is extended: the rest of the target is extra bytes and the seek is zero.
      const out = spent();
      let s = 0;
      let best = 0;
      let lenf = 0;
      for (let i = 0; !out && lastscan + i < scan && lastpos + i < oldsize;) {
        if (base[lastpos + i] === target[lastscan + i]) s++;
        i++;
        if (s * 2 - i > best * 2 - lenf) {
          best = s;
          lenf = i;
        }
      }

      let lenb = 0;
      if (scan < newsize) {
        s = 0;
        best = 0;
        for (let i = 1; scan >= lastscan + i && pos >= i; i++) {
          if (base[pos - i] === target[scan - i]) s++;
          if (s * 2 - i > best * 2 - lenb) {
            best = s;
            lenb = i;
          }
        }
      }

      if (lastscan + lenf > scan - lenb) {
        const overlap = lastscan + lenf - (scan - lenb);
        s = 0;
        best = 0;
        let lens = 0;
        for (let i = 0; i < overlap; i++) {
          if (target[lastscan + lenf - overlap + i] === base[lastpos + lenf - overlap + i]) s++;
          if (target[scan - lenb + i] === base[pos - lenb + i]) s--;
          if (s > best) {
            best = s;
            lens = i + 1;
          }
        }
        lenf += lens - overlap;
        lenb -= lens;
      }

      if (out) pos = lastpos;
      for (let i = 0; i < lenf; i++) {
        db[dblen + i] = (target[lastscan + i] ?? 0) - (base[lastpos + i] ?? 0);
      }
      const copy = scan - lenb - (lastscan + lenf);
      eb.set(target.subarray(lastscan + lenf, lastscan + lenf + copy), eblen);
      dblen += lenf;
      eblen += copy;

      ctrl.push(lenf, copy, pos - lenb - (lastpos + lenf));

      lastscan = scan - lenb;
      lastpos = pos - lenb;
      lastoffset = pos - scan;
    }
  }
  const ctrlBytes = new Uint8Array(8 * ctrl.length);
  ctrl.forEach((x, i) => offtout(x, ctrlBytes, 8 * i));
  return {
    ctrl: ctrlBytes,
    diff: db.slice(0, dblen),
    extra: eb.slice(0, eblen),
    exhausted: spent(),
  };
}

/** Writes `x` at `at` as 8 bytes little-endian sign-magnitude. */
function offtout(x: number, into: Uint8Array, at: number): void {
  let y = Math.abs(x);
  for (let i = 0; i < 8; i++) {
    into[at + i] = y % 256;
    y = Math.floor(y / 256);
  }
  if (x < 0) into[at + 7] = (into[at + 7] ?? 0) | 0x80;
}
