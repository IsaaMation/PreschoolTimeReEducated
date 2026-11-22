/* Resumable raw-DEFLATE decoder (RFC 1951), written for reading zip entries a piece at a time.
 *
 *   const inf = new EMU.Inflater(uncompressedSize);   // the size is known from the zip's directory
 *   inf.push(bytes);                                  // add compressed bytes as they arrive (any piece sizes)
 *   inf.finish();                                     // no more compressed bytes will come
 *   inf.run(wantedOut);                               // decode until `wantedOut` bytes of output exist (or input ran out / stream ended)
 *   inf.out, inf.outPos, inf.done, inf.needInput
 *
 * The decoder can stop at any symbol when it runs out of compressed bytes and carry on after the next push(); output that was
 * produced stays in `out` (the whole uncompressed file), so earlier parts can be read again without decoding anything twice.
 * Written from the format description; no code of another decoder was used.
 */
(function (G) {
  'use strict';
  const EMU = G.EMU = G.EMU || {};

  const LBASE = new Uint16Array([3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258, 0, 0]);
  const LEXT = new Uint8Array([0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0, 0, 0]);
  const DBASE = new Uint16Array([1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577, 0, 0]);
  const DEXT = new Uint8Array([0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13, 0, 0]);
  const CLORDER = new Uint8Array([16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15]);

  const HDR = 0, STORED = 1, HUFF = 2, DONE = 3;
  const MARGIN = 8;                        // a symbol needs at most 6 bytes of input; the symbol loop only runs while this much is available
  const HEADER_NEED = 640;                 // a block header (with its code length tables) never needs more input than this

  /** build a one-level lookup table for canonical Huffman codes: entry = (length << 16) | symbol, 0 = no such code */
  function build(lens, n, table) {
    const count = new Uint16Array(16);
    let max = 0;
    for (let i = 0; i < n; i++) { const l = lens[i]; if (l) { count[l]++; if (l > max) max = l; } }
    if (!max) { table.bits = 1; table.t[0] = 0; table.t[1] = 0; return true; }
    let left = 1;
    for (let l = 1; l <= 15; l++) { left = (left << 1) - count[l]; if (left < 0) return false; }      // over-subscribed
    const next = new Uint16Array(16);
    let code = 0;
    for (let l = 1; l <= 15; l++) { code = (code + count[l - 1]) << 1; next[l] = code; }
    const size = 1 << max, t = table.t;
    t.fill(0, 0, size);
    for (let s = 0; s < n; s++) {
      const l = lens[s]; if (!l) continue;
      let c = next[l]++, r = 0;
      for (let k = 0; k < l; k++) { r = (r << 1) | (c & 1); c >>= 1; }       // codes are sent most significant bit first, but bits are read least significant first
      const e = (l << 16) | s;
      for (let i = r; i < size; i += 1 << l) t[i] = e;
    }
    table.bits = max;
    return true;
  }

  let fixedLit = null, fixedDist = null;
  function fixedTables() {
    if (fixedLit) return;
    const l = new Uint8Array(288);
    for (let i = 0; i < 144; i++) l[i] = 8;
    for (let i = 144; i < 256; i++) l[i] = 9;
    for (let i = 256; i < 280; i++) l[i] = 7;
    for (let i = 280; i < 288; i++) l[i] = 8;
    fixedLit = { t: new Int32Array(1 << 9), bits: 0 }; build(l, 288, fixedLit);
    fixedDist = { t: new Int32Array(1 << 5), bits: 0 }; build(new Uint8Array(30).fill(5), 30, fixedDist);
  }

  class Inflater {
    constructor(outSize) {
      this.out = new Uint8Array(outSize);
      this.outSize = outSize; this.outPos = 0;
      this.inb = new Uint8Array(1 << 14); this.inLen = 0; this.inPos = 0;     // compressed bytes received and not yet used up
      this.ended = false;                                                      // no further input will come
      this.bitBuf = 0; this.bitCnt = 0;
      this.state = HDR; this.final = false; this.storedLeft = 0;
      this.lit = { t: new Int32Array(1 << 15), bits: 1 }; this.dist = { t: new Int32Array(1 << 15), bits: 1 };
      this.litT = this.lit; this.distT = this.dist;
      this.done = false; this.needInput = true; this.totalIn = 0;
    }
    /** add compressed bytes */
    push(bytes) {
      const n = bytes.length; if (!n) return;
      if (this.inPos > 0) { this.inb.copyWithin(0, this.inPos, this.inLen); this.inLen -= this.inPos; this.inPos = 0; }   // drop what was used
      if (this.inLen + n + MARGIN > this.inb.length) {
        let sz = this.inb.length; while (sz < this.inLen + n + MARGIN) sz *= 2;
        const nb = new Uint8Array(sz); nb.set(this.inb.subarray(0, this.inLen)); this.inb = nb;
      }
      this.inb.set(bytes, this.inLen); this.inLen += n; this.totalIn += n;
      this.needInput = false;
    }
    /** declare that all compressed bytes have been pushed */
    finish() {
      if (this.ended) return;
      this.ended = true;
      if (this.inLen + MARGIN > this.inb.length) { const nb = new Uint8Array(this.inLen + MARGIN); nb.set(this.inb.subarray(0, this.inLen)); this.inb = nb; }
      this.inb.fill(0, this.inLen, this.inLen + MARGIN);       // zero padding: the symbol loop may look a few bytes ahead
      this.needInput = false;
    }
    fail(msg) { this.done = true; throw new Error('inflate: ' + msg); }

    /** decode until at least `want` output bytes exist, the input is used up (needInput) or the stream ends (done) */
    run(want) {
      if (want > this.outSize) want = this.outSize;
      this.needInput = false;
      while (!this.done && this.outPos < want) {
        if (this.state === HDR) { if (!this.header()) break; }
        else if (this.state === STORED) { if (!this.stored()) break; }
        else if (this.state === HUFF) { if (!this.huff(want)) break; }
        else { this.done = true; }
      }
      if (this.outPos >= this.outSize) this.done = true;
    }
    header() {
      if (this.final) { this.state = DONE; this.done = true; return true; }
      if (!this.ended && this.inLen - this.inPos < HEADER_NEED) { this.needInput = true; return false; }
      const inb = this.inb;
      let bb = this.bitBuf, bc = this.bitCnt, ip = this.inPos;
      const need = n => { while (bc < n) { bb |= inb[ip++] << bc; bc += 8; } };
      const take = n => { need(n); const v = bb & ((1 << n) - 1); bb >>>= n; bc -= n; return v; };
      const fin = take(1), type = take(2);
      if (type === 0) {                                          // stored: skip to the byte boundary, then LEN and NLEN
        const drop = bc & 7; bb >>>= drop; bc -= drop;
        const len = take(16), nlen = take(16);
        if ((len ^ 0xFFFF) !== nlen) this.fail('bad stored block length');
        ip -= bc >> 3;                                           // give back whole bytes that were read ahead
        this.bitBuf = 0; this.bitCnt = 0; this.inPos = ip;
        this.final = !!fin; this.storedLeft = len; this.state = STORED;
        return true;
      }
      if (type === 3) this.fail('bad block type');
      if (type === 1) {
        fixedTables();
        this.litT = fixedLit; this.distT = fixedDist;
      } else {
        const hlit = take(5) + 257, hdist = take(5) + 1, hclen = take(4) + 4;
        if (hlit > 286 || hdist > 30) this.fail('bad code counts');
        const cl = new Uint8Array(19);
        for (let i = 0; i < hclen; i++) cl[CLORDER[i]] = take(3);
        const clT = { t: new Int32Array(1 << 7), bits: 1 };
        if (!build(cl, 19, clT)) this.fail('bad code length code');
        const lens = new Uint8Array(hlit + hdist), total = hlit + hdist;
        let i = 0, prev = 0;
        const mask = (1 << clT.bits) - 1;
        while (i < total) {
          need(clT.bits);
          const e = clT.t[bb & mask], l = e >>> 16;
          if (!l) this.fail('bad code length symbol');
          bb >>>= l; bc -= l;
          const sym = e & 0xFFFF;
          if (sym < 16) { lens[i++] = prev = sym; continue; }
          let rep, val = 0;
          if (sym === 16) { if (!i) this.fail('repeat with nothing to repeat'); val = prev; rep = 3 + take(2); }
          else if (sym === 17) rep = 3 + take(3);
          else rep = 11 + take(7);
          if (i + rep > total) this.fail('too many code lengths');
          while (rep--) lens[i++] = val;
        }
        if (!lens[256]) this.fail('no end-of-block code');
        if (!build(lens.subarray(0, hlit), hlit, this.lit)) this.fail('bad literal/length code');
        if (!build(lens.subarray(hlit), hdist, this.dist)) this.fail('bad distance code');
        this.litT = this.lit; this.distT = this.dist;
      }
      this.bitBuf = bb; this.bitCnt = bc; this.inPos = ip;
      this.final = !!fin; this.state = HUFF;
      return true;
    }
    stored() {
      const n = Math.min(this.storedLeft, this.inLen - this.inPos, this.outSize - this.outPos);
      if (n > 0) {
        this.out.set(this.inb.subarray(this.inPos, this.inPos + n), this.outPos);
        this.inPos += n; this.outPos += n; this.storedLeft -= n;
      }
      if (this.storedLeft === 0) { this.state = HDR; return true; }
      if (this.outPos >= this.outSize) { this.done = true; return true; }
      if (this.ended) this.fail('compressed data ended early');
      this.needInput = true;
      return false;
    }
    huff(want) {
      const inb = this.inb, out = this.out, outSize = this.outSize;
      const lt = this.litT.t, lmask = (1 << this.litT.bits) - 1, dt = this.distT.t, dmask = (1 << this.distT.bits) - 1;
      let bb = this.bitBuf, bc = this.bitCnt, ip = this.inPos, op = this.outPos;
      const limit = this.inLen - MARGIN;                // the symbol loop runs while ip <= limit (a symbol reads at most 6 bytes)
      let result = true, endOfBlock = false, err = null;
      for (; ;) {
        if (op >= want) break;
        if (ip > limit) {
          if (!this.ended) { this.needInput = true; result = false; break; }
          if (ip - (bc >> 3) > this.inLen) { err = 'compressed data ended early'; break; }
        }
        while (bc <= 24) { bb |= inb[ip++] << bc; bc += 8; }
        let e = lt[bb & lmask];
        let l = e >>> 16;
        if (!l) { err = 'bad literal/length code'; break; }
        bb >>>= l; bc -= l;
        let sym = e & 0xFFFF;
        if (sym < 256) {
          if (op >= outSize) { err = 'output larger than the zip entry says'; break; }
          out[op++] = sym; continue;
        }
        if (sym === 256) { endOfBlock = true; break; }
        sym -= 257;
        if (sym > 28) { err = 'bad length symbol'; break; }
        let len = LBASE[sym];
        const eb = LEXT[sym];
        if (eb) { len += bb & ((1 << eb) - 1); bb >>>= eb; bc -= eb; }
        while (bc <= 24) { bb |= inb[ip++] << bc; bc += 8; }
        e = dt[bb & dmask]; l = e >>> 16;
        if (!l) { err = 'bad distance code'; break; }
        bb >>>= l; bc -= l;
        const ds = e & 0xFFFF;
        if (ds > 29) { err = 'bad distance symbol'; break; }
        let dist = DBASE[ds];
        const de = DEXT[ds];
        if (de) {
          while (bc < de) { bb |= inb[ip++] << bc; bc += 8; }
          dist += bb & ((1 << de) - 1); bb >>>= de; bc -= de;
        }
        if (dist > op) { err = 'distance reaches before the start of the data'; break; }
        if (op + len > outSize) { err = 'output larger than the zip entry says'; break; }
        let from = op - dist;
        if (len > 24 && dist >= len) { out.copyWithin(op, from, from + len); op += len; }
        else { const stop = op + len; while (op < stop) out[op++] = out[from++]; }
      }
      this.bitBuf = bb; this.bitCnt = bc; this.inPos = ip; this.outPos = op;
      if (err) this.fail(err);
      if (endOfBlock) { this.state = this.final ? DONE : HDR; if (this.final) this.done = true; }
      return result;
    }
  }

  EMU.Inflater = Inflater;
  /** whole raw-deflate stream in, whole output out (the size must be known) */
  EMU.inflateRaw = (bytes, outSize) => {
    const f = new Inflater(outSize); f.push(bytes); f.finish(); f.run(outSize);
    if (f.outPos !== outSize) throw new Error('inflate: stream ended early');
    return f.out;
  };
  if (typeof module !== 'undefined') module.exports = { Inflater, inflateRaw: EMU.inflateRaw };
})(typeof globalThis !== 'undefined' ? globalThis : this);
