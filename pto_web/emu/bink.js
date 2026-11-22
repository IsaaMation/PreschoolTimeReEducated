/* Bink 1 video (revisions f, g, h, i; with alpha plane) and Bink audio (DCT and RDFT) decoder, pure JavaScript.
 *
 *   const f = new EMU.BinkFile(uint8Array)             // whole .bik file
 *   f.width, f.height, f.frames, f.fpsNum, f.fpsDen, f.hasAlpha, f.audioTracks[{rate, channels, useDct, id}]
 *   const pk = f.packet(n)                              // 0-based frame -> { video: Uint8Array, audio: [Uint8Array|null, ...] }
 *   const dec = new EMU.BinkVideoDecoder(f)             // keeps the previous frame for inter prediction
 *   dec.decode(pk.video)                                // -> dec.planes = { y, u, v, a } with strides dec.strides
 *   const aud = new EMU.BinkAudioDecoder(rate, channels, useDct, version)
 *   aud.decode(pk.audio[t])                             // -> array of Float32Array (one per channel), samples in -1..1
 *
 * The bitstream handling follows the format as implemented in FFmpeg's libavcodec/bink.c, binkdsp.c and binkaudio.c
 * (LGPL 2.1 or later); the tables are generated from FFmpeg's binkdata.h.
 */
(function (G) {
  'use strict';
  const EMU = G.EMU = G.EMU || {};
  const T = EMU.BinkTables;

  // ------------------------------------------------------------------------------------------ bit reader (LSB first)
  class Bits {
    constructor(u8, start, end) { this.b = u8; this.base = start || 0; this.pos = 0; this.total = ((end === undefined ? u8.length : end) - this.base) * 8; }
    get left() { return this.total - this.pos; }
    peek(n) {              // n <= 24
      const i = this.base + (this.pos >> 3), b = this.b;
      const v = ((b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24)) >>> (this.pos & 7));
      return v & ((1 << n) - 1);
    }
    get(n) { if (n === 0) return 0; const v = this.peek(n); this.pos += n; return v; }
    get1() { const p = this.pos++; return (this.b[this.base + (p >> 3)] >> (p & 7)) & 1; }
    align32() { if (this.pos & 31) this.pos += 32 - (this.pos & 31); }
  }

  // ------------------------------------------------------------------------------------------ huffman trees
  const trees = [];
  function initVlcs() {
    for (let i = 0; i < 16; i++) {
      let maxbits = 0;
      for (let s = 0; s < 16; s++) maxbits = Math.max(maxbits, T.bink_tree_lens[i * 16 + s]);
      const table = new Int16Array(1 << maxbits).fill(-1);
      for (let s = 0; s < 16; s++) {
        const len = T.bink_tree_lens[i * 16 + s], code = T.bink_tree_bits[i * 16 + s];
        for (let f = 0; f < (1 << (maxbits - len)); f++) {
          const idx = code | (f << len);
          if (table[idx] !== -1) throw new Error('bink tree ' + i + ' is not prefix free');
          table[idx] = (len << 4) | s;
        }
      }
      trees.push({ maxbits, table });
    }
  }
  function huff(gb, tree) {
    const t = trees[tree.vlc], e = t.table[gb.peek(t.maxbits)];
    gb.pos += e >> 4;
    return tree.syms[e & 15];
  }
  function newTree() { return { vlc: 0, syms: new Uint8Array(16) }; }
  function merge(gb, dst, d, src, s, size) {
    let s2 = s + size, size2 = size;
    do {
      if (!gb.get1()) { dst[d++] = src[s++]; size--; } else { dst[d++] = src[s2++]; size2--; }
    } while (size && size2);
    while (size--) dst[d++] = src[s++];
    while (size2--) dst[d++] = src[s2++];
  }
  function readTree(gb, tree) {
    if (gb.left < 4) throw new Error('bink: out of data');
    tree.vlc = gb.get(4);
    if (!tree.vlc) { for (let i = 0; i < 16; i++) tree.syms[i] = i; return; }
    if (gb.get1()) {
      const tmp = new Uint8Array(16); let len = gb.get(3);
      for (let i = 0; i <= len; i++) { tree.syms[i] = gb.get(4); tmp[tree.syms[i]] = 1; }
      for (let i = 0; i < 16 && len < 15; i++) if (!tmp[i]) tree.syms[++len] = i;
    } else {
      let inp = new Uint8Array(16), out = new Uint8Array(16);
      const len = gb.get(2);
      for (let i = 0; i < 16; i++) inp[i] = i;
      for (let i = 0; i <= len; i++) {
        const size = 1 << i;
        for (let t = 0; t < 16; t += size << 1) merge(gb, out, t, inp, t, size);
        const x = inp; inp = out; out = x;
      }
      tree.syms.set(inp);
    }
  }

  // ------------------------------------------------------------------------------------------ bundles
  const SRC_BLOCK_TYPES = 0, SRC_SUB_BLOCK_TYPES = 1, SRC_COLORS = 2, SRC_PATTERN = 3, SRC_X_OFF = 4, SRC_Y_OFF = 5, SRC_INTRA_DC = 6, SRC_INTER_DC = 7, SRC_RUN = 8, NB_SRC = 9;
  const SKIP_BLOCK = 0, SCALED_BLOCK = 1, MOTION_BLOCK = 2, RUN_BLOCK = 3, RESIDUE_BLOCK = 4, INTRA_BLOCK = 5, FILL_BLOCK = 6, INTER_BLOCK = 7, PATTERN_BLOCK = 8, RAW_BLOCK = 9;
  const RLELENS = [4, 8, 12, 32];
  const log2 = x => 31 - Math.clz32(x);

  class Bundle {
    constructor(size) {
      this.buf = new ArrayBuffer(size + 16); this.u8 = new Uint8Array(this.buf); this.i8 = new Int8Array(this.buf); this.i16 = new Int16Array(this.buf, 0, (size >> 1));
      this.end = size; this.len = 0; this.tree = newTree(); this.curDec = 0; this.curPtr = 0;
    }
  }

  // ------------------------------------------------------------------------------------------ DSP
  const A1 = 2896, A2 = 2217, A3 = 3784, A4 = -5352;
  const MUL = (x, y) => Math.imul(x, y) >> 11;
  const tmpI = new Int32Array(64), out8 = new Int32Array(8);
  /** one 8-point Bink IDCT; reads src[o + k*step], writes out8[0..7] */
  function idct8(src, o, step) {
    const s0 = src[o], s1 = src[o + step], s2 = src[o + 2 * step], s3 = src[o + 3 * step], s4 = src[o + 4 * step], s5 = src[o + 5 * step], s6 = src[o + 6 * step], s7 = src[o + 7 * step];
    const a0 = s0 + s4, a1 = s0 - s4, a2 = s2 + s6, a3 = MUL(A1, s2 - s6);
    const a4 = s5 + s3, a5 = s5 - s3, a6 = s1 + s7, a7 = s1 - s7;
    const b0 = a4 + a6, b1 = MUL(A3, a5 + a7), b2 = MUL(A4, a5) - b0 + b1, b3 = MUL(A1, a6 - a4) - b2, b4 = MUL(A2, a7) + b3 - b1;
    out8[0] = a0 + a2 + b0; out8[1] = a1 + a3 - a2 + b2; out8[2] = a1 - a3 + a2 + b3; out8[3] = a0 - a2 - b4;
    out8[4] = a0 - a2 + b4; out8[5] = a1 - a3 + a2 - b3; out8[6] = a1 + a3 - a2 - b2; out8[7] = a0 + a2 - b0;
  }
  function idctCols(block) {
    for (let i = 0; i < 8; i++) {
      if ((block[i + 8] | block[i + 16] | block[i + 24] | block[i + 32] | block[i + 40] | block[i + 48] | block[i + 56]) === 0) {
        const v = block[i]; for (let k = 0; k < 8; k++) tmpI[i + 8 * k] = v;
      } else {
        idct8(block, i, 8);
        for (let k = 0; k < 8; k++) tmpI[i + 8 * k] = out8[k];
      }
    }
  }
  function idctPut(dst, off, stride, block) {
    idctCols(block);
    for (let i = 0; i < 8; i++) {
      idct8(tmpI, 8 * i, 1);
      const o = off + i * stride;
      for (let k = 0; k < 8; k++) dst[o + k] = (out8[k] + 0x7F) >> 8;
    }
  }
  function idctAdd(dst, off, stride, block) {
    idctCols(block);
    for (let i = 0; i < 8; i++) {
      idct8(tmpI, 8 * i, 1);
      const o = off + i * stride;
      for (let k = 0; k < 8; k++) dst[o + k] += (out8[k] + 0x7F) >> 8;
    }
  }

  // ------------------------------------------------------------------------------------------ colour conversion (BT.601, studio range: the movies' white is Y=235)
  const BPP = [0, 3, 3, 4, 4, 4, 4, 2, 2, 2, 2, 2, 2];
  const CLIP = new Uint8Array(1024); for (let i = 0; i < 1024; i++) { const v = i - 384; CLIP[i] = v < 0 ? 0 : v > 255 ? 255 : v; }
  const TY = new Int32Array(256), TRV = new Int32Array(256), TBU = new Int32Array(256), TGU = new Int32Array(256), TGV = new Int32Array(256);
  for (let i = 0; i < 256; i++) { TY[i] = 298 * (i - 16) + 128; TRV[i] = 409 * (i - 128); TBU[i] = 516 * (i - 128); TGU[i] = -100 * (i - 128); TGV[i] = -208 * (i - 128); }

  // ------------------------------------------------------------------------------------------ video decoder
  class BinkVideoDecoder {
    constructor(file) {
      this.version = file.version; this.width = file.width; this.height = file.height; this.hasAlpha = file.hasAlpha;
      this.swapPlanes = this.version >= 0x68;           // 'h'
      this.frameNum = 0;
      const w = this.width, h = this.height;
      const bw = (w + 7) >> 3, bh = (h + 7) >> 3, blocks = ((bw + 1) & ~1) * ((bh + 1) & ~1);
      this.bundles = []; for (let i = 0; i < NB_SRC; i++) this.bundles.push(new Bundle(blocks * 64));
      this.colHigh = []; for (let i = 0; i < 16; i++) this.colHigh.push(newTree());
      this.colLast = 0;
      // planes: 0 Y, 1 U, 2 V, 3 A (stream order for the planes is handled in decode)
      const mk = (pw, ph) => {
        const bwp = (pw + 7) >> 3, bhp = (ph + 7) >> 3, stride = (((bwp + 1) & ~1) + 2) * 8, rows = (((bhp + 1) & ~1) + 2) * 8;
        return { stride, rows, a: new Uint8Array(stride * rows), b: new Uint8Array(stride * rows), zero: new Uint8Array(stride * rows), cur: null, prev: null };
      };
      const cw = (w + 1) >> 1, ch = (h + 1) >> 1;
      this.pl = [mk(w, h), mk(((w + 15) >> 4) * 8, ((h + 15) >> 4) * 8), mk(((w + 15) >> 4) * 8, ((h + 15) >> 4) * 8), this.hasAlpha ? mk(w, h) : null];
      this.first = true; this.outputAlpha = this.hasAlpha;
      for (const P of this.pl) if (P) P.cur = P.a;
      this.planes = { y: this.pl[0].a, u: this.pl[1].a, v: this.pl[2].a, a: this.hasAlpha ? this.pl[3].a : null };
      this.strides = { y: this.pl[0].stride, u: this.pl[1].stride, a: this.hasAlpha ? this.pl[3].stride : 0 };
      this.dctblock = new Int32Array(64); this.block = new Int16Array(64); this.ublock = new Uint8Array(64);
      this.coefIdx = new Int32Array(64); this.coefList = new Int32Array(128); this.modeList = new Int32Array(128);
      this.nz = new Int32Array(64);
    }

    initLengths(width, bw) {
      width = (width + 7) & ~7;
      const B = this.bundles;
      B[SRC_BLOCK_TYPES].len = log2((width >> 3) + 511) + 1;
      B[SRC_SUB_BLOCK_TYPES].len = log2((width >> 4) + 511) + 1;
      B[SRC_COLORS].len = log2(bw * 64 + 511) + 1;
      B[SRC_INTRA_DC].len = B[SRC_INTER_DC].len = B[SRC_X_OFF].len = B[SRC_Y_OFF].len = log2((width >> 3) + 511) + 1;
      B[SRC_PATTERN].len = log2((bw << 3) + 511) + 1;
      B[SRC_RUN].len = log2(bw * 48 + 511) + 1;
    }

    readBundle(gb, n) {
      const b = this.bundles[n];
      if (n === SRC_COLORS) { for (let i = 0; i < 16; i++) readTree(gb, this.colHigh[i]); this.colLast = 0; }
      if (n !== SRC_INTRA_DC && n !== SRC_INTER_DC) readTree(gb, b.tree);
      b.curDec = b.curPtr = 0;
    }
    /** common prologue of the read_* functions; returns the element count or -1 when nothing is to be read */
    chk(gb, b) {
      if (b.curDec < 0 || b.curDec > b.curPtr) return -1;
      const t = gb.get(b.len);
      if (!t) { b.curDec = -1; return -1; }
      return t;
    }
    readRuns(gb, b) {
      const t = this.chk(gb, b); if (t < 0) return;
      const decEnd = b.curDec + t; if (decEnd > b.end) throw new Error('bink: run value out of bounds');
      if (gb.left < 1) throw new Error('bink: out of data');
      if (gb.get1()) { const v = gb.get(4); b.u8.fill(v, b.curDec, decEnd); b.curDec = decEnd; }
      else while (b.curDec < decEnd) b.u8[b.curDec++] = huff(gb, b.tree);
    }
    readMotion(gb, b) {
      const t = this.chk(gb, b); if (t < 0) return;
      const decEnd = b.curDec + t; if (decEnd > b.end) throw new Error('bink: too many motion values');
      if (gb.left < 1) throw new Error('bink: out of data');
      if (gb.get1()) {
        let v = gb.get(4);
        if (v) { const sign = -gb.get1(); v = (v ^ sign) - sign; }
        b.i8.fill(v, b.curDec, decEnd); b.curDec = decEnd;
      } else {
        while (b.curDec < decEnd) {
          let v = huff(gb, b.tree);
          if (v) { const sign = -gb.get1(); v = (v ^ sign) - sign; }
          b.i8[b.curDec++] = v;
        }
      }
    }
    readBlockTypes(gb, b) {
      let t = this.chk(gb, b); if (t < 0) return;
      const decEnd = b.curDec + t; if (decEnd > b.end) throw new Error('bink: too many block types');
      if (gb.left < 1) throw new Error('bink: out of data');
      if (gb.get1()) { const v = gb.get(4); b.u8.fill(v, b.curDec, decEnd); b.curDec = decEnd; }
      else {
        let last = 0;
        while (b.curDec < decEnd) {
          const v = huff(gb, b.tree);
          if (v < 12) { last = v; b.u8[b.curDec++] = v; }
          else {
            const run = RLELENS[v - 12];
            if (decEnd - b.curDec < run) throw new Error('bink: bad block type run');
            b.u8.fill(last, b.curDec, b.curDec + run); b.curDec += run;
          }
        }
      }
    }
    readPatterns(gb, b) {
      const t = this.chk(gb, b); if (t < 0) return;
      const decEnd = b.curDec + t; if (decEnd > b.end) throw new Error('bink: too many pattern values');
      while (b.curDec < decEnd) {
        if (gb.left < 2) throw new Error('bink: out of data');
        let v = huff(gb, b.tree); v |= huff(gb, b.tree) << 4;
        b.u8[b.curDec++] = v;
      }
    }
    readColors(gb, b) {
      const t = this.chk(gb, b); if (t < 0) return;
      const decEnd = b.curDec + t; if (decEnd > b.end) throw new Error('bink: too many color values');
      if (gb.left < 1) throw new Error('bink: out of data');
      const old = this.version < 0x69;                  // < 'i'
      const one = () => {
        this.colLast = huff(gb, this.colHigh[this.colLast]);
        let v = huff(gb, b.tree);
        v = (this.colLast << 4) | v;
        if (old) { const sign = ((v << 24) >> 24) >> 7; v = ((v & 0x7F) ^ sign) - sign; v += 0x80; }
        return v;
      };
      if (gb.get1()) { const v = one(); b.u8.fill(v, b.curDec, decEnd); b.curDec = decEnd; }
      else while (b.curDec < decEnd) { if (gb.left < 2) throw new Error('bink: out of data'); b.u8[b.curDec++] = one(); }
    }
    readDcs(gb, b, startBits, hasSign) {
      const len0 = this.chk(gb, b); if (len0 < 0) return;
      let len = len0, dst = b.curDec >> 1; const dstEnd = b.end >> 1, i16 = b.i16;
      if (gb.left < startBits - hasSign) throw new Error('bink: out of data');
      let v = gb.get(startBits - hasSign);
      if (v && hasSign) { const sign = -gb.get1(); v = (v ^ sign) - sign; }
      if (dstEnd - dst < 1) throw new Error('bink: dc overflow');
      i16[dst++] = v; len--;
      for (let i = 0; i < len; i += 8) {
        const len2 = Math.min(len - i, 8);
        if (dstEnd - dst < len2) throw new Error('bink: dc overflow');
        const bsize = gb.get(4);
        if (bsize) {
          for (let j = 0; j < len2; j++) {
            let v2 = gb.get(bsize);
            if (v2) { const sign = -gb.get1(); v2 = (v2 ^ sign) - sign; }
            v += v2; i16[dst++] = v;
            if (v < -32768 || v > 32767) throw new Error('bink: dc value out of bounds');
          }
        } else for (let j = 0; j < len2; j++) i16[dst++] = v;
      }
      b.curDec = dst << 1;
    }
    val(n) {
      const b = this.bundles[n];
      if (n < SRC_X_OFF || n === SRC_RUN) return b.u8[b.curPtr++];
      if (n === SRC_X_OFF || n === SRC_Y_OFF) return b.i8[b.curPtr++];
      const r = b.i16[b.curPtr >> 1]; b.curPtr += 2; return r;
    }

    /** read the DCT coefficients of one 8x8 block into this.dctblock (scan order positions), returns quant index; this.coefCount set */
    readDct(gb, block) {
      const coefList = this.coefList, modeList = this.modeList, coefIdx = this.coefIdx, scan = T.bink_scan;
      let listStart = 64, listEnd = 64, coefCount = 0;
      if (gb.left < 4) throw new Error('bink: out of data');
      coefList[listEnd] = 4; modeList[listEnd++] = 0;
      coefList[listEnd] = 24; modeList[listEnd++] = 0;
      coefList[listEnd] = 44; modeList[listEnd++] = 0;
      coefList[listEnd] = 1; modeList[listEnd++] = 3;
      coefList[listEnd] = 2; modeList[listEnd++] = 3;
      coefList[listEnd] = 3; modeList[listEnd++] = 3;
      for (let bits = gb.get(4) - 1; bits >= 0; bits--) {
        let listPos = listStart;
        while (listPos < listEnd) {
          if (!(modeList[listPos] | coefList[listPos]) || !gb.get1()) { listPos++; continue; }
          let ccoef = coefList[listPos]; const mode = modeList[listPos];
          if (mode === 0 || mode === 2) {
            if (mode === 0) { coefList[listPos] = ccoef + 4; modeList[listPos] = 1; }
            else { coefList[listPos] = 0; modeList[listPos++] = 0; }
            for (let i = 0; i < 4; i++, ccoef++) {
              if (gb.get1()) { coefList[--listStart] = ccoef; modeList[listStart] = 3; }
              else {
                let t;
                if (!bits) t = 1 - (gb.get1() << 1);
                else { t = gb.get(bits) | (1 << bits); const sign = -gb.get1(); t = (t ^ sign) - sign; }
                block[scan[ccoef]] = t; coefIdx[coefCount++] = ccoef;
              }
            }
          } else if (mode === 1) {
            modeList[listPos] = 2;
            for (let i = 0; i < 3; i++) { ccoef += 4; coefList[listEnd] = ccoef; modeList[listEnd++] = 2; }
          } else {   // 3
            let t;
            if (!bits) t = 1 - (gb.get1() << 1);
            else { t = gb.get(bits) | (1 << bits); const sign = -gb.get1(); t = (t ^ sign) - sign; }
            block[scan[ccoef]] = t; coefIdx[coefCount++] = ccoef;
            coefList[listPos] = 0; modeList[listPos++] = 0;
          }
        }
      }
      this.coefCount = coefCount;
      return gb.get(4);
    }
    unquant(block, quant, quantOff) {
      const scan = T.bink_scan, coefIdx = this.coefIdx;
      block[0] = Math.imul(block[0], quant[quantOff]) >> 11;
      for (let i = 0; i < this.coefCount; i++) { const idx = coefIdx[i], p = scan[idx]; block[p] = Math.imul(block[p], quant[quantOff + idx]) >> 11; }
    }
    readResidue(gb, block, masksCount) {
      const coefList = this.coefList, modeList = this.modeList, nz = this.nz, scan = T.bink_scan;
      let listStart = 64, listEnd = 64, nzCount = 0;
      coefList[listEnd] = 4; modeList[listEnd++] = 0;
      coefList[listEnd] = 24; modeList[listEnd++] = 0;
      coefList[listEnd] = 44; modeList[listEnd++] = 0;
      coefList[listEnd] = 0; modeList[listEnd++] = 2;
      for (let mask = 1 << gb.get(3); mask; mask >>= 1) {
        for (let i = 0; i < nzCount; i++) {
          if (!gb.get1()) continue;
          if (block[nz[i]] < 0) block[nz[i]] -= mask; else block[nz[i]] += mask;
          if (--masksCount < 0) return;
        }
        let listPos = listStart;
        while (listPos < listEnd) {
          if (!(coefList[listPos] | modeList[listPos]) || !gb.get1()) { listPos++; continue; }
          let ccoef = coefList[listPos]; const mode = modeList[listPos];
          if (mode === 0 || mode === 2) {
            if (mode === 0) { coefList[listPos] = ccoef + 4; modeList[listPos] = 1; }
            else { coefList[listPos] = 0; modeList[listPos++] = 0; }
            for (let i = 0; i < 4; i++, ccoef++) {
              if (gb.get1()) { coefList[--listStart] = ccoef; modeList[listStart] = 3; }
              else {
                nz[nzCount++] = scan[ccoef];
                const sign = -gb.get1(); block[scan[ccoef]] = (mask ^ sign) - sign;
                if (--masksCount < 0) return;
              }
            }
          } else if (mode === 1) {
            modeList[listPos] = 2;
            for (let i = 0; i < 3; i++) { ccoef += 4; coefList[listEnd] = ccoef; modeList[listEnd++] = 2; }
          } else {
            nz[nzCount++] = scan[ccoef];
            const sign = -gb.get1(); block[scan[ccoef]] = (mask ^ sign) - sign;
            coefList[listPos] = 0; modeList[listPos++] = 0;
            if (--masksCount < 0) return;
          }
        }
      }
    }

    /** copy an 8x8 block */
    static copy8(dst, d, src, s, stride) { for (let i = 0; i < 8; i++, d += stride, s += stride) for (let k = 0; k < 8; k++) dst[d + k] = src[s + k]; }

    decodePlane(gb, planeIdx, isChroma) {
      const P = this.pl[planeIdx], stride = P.stride;
      const dstBuf = P.cur, prevBuf = P.prev;
      const bw = isChroma ? (this.width + 15) >> 4 : (this.width + 7) >> 3;
      const bh = isChroma ? (this.height + 15) >> 4 : (this.height + 7) >> 3;
      const width = this.width >> isChroma;
      if (this.version === 0x6b && gb.get1()) {       // 'k': plain fill (not used by Bink 1.x files but cheap to support)
        const fill = gb.get(8); const height = this.height >> isChroma;
        for (let i = 0; i < height; i++) dstBuf.fill(fill, i * stride, i * stride + width);
        gb.align32(); return;
      }
      this.initLengths(Math.max(width, 8), bw);
      for (let i = 0; i < NB_SRC; i++) this.readBundle(gb, i);
      const refEnd = (bw - 1 + stride * (bh - 1) * 1) * 8 - 0;   // start of the last block, as in FFmpeg: (bw-1 + linesize*(bh-1))*8
      const refEndOff = ((bw - 1) + stride * (bh - 1)) * 8;
      const B = this.bundles, patterns = T.bink_patterns, ublock = this.ublock, block = this.block, dctblock = this.dctblock;
      const coord = new Int32Array(64); for (let i = 0; i < 64; i++) coord[i] = (i & 7) + (i >> 3) * stride;
      const put = (blkOff, prevOff) => {                       // motion block copy
        const xoff = this.val(SRC_X_OFF), yoff = this.val(SRC_Y_OFF);
        const ref = prevOff + xoff + yoff * stride;
        if (ref < 0 || ref > refEndOff) throw new Error('bink: copy out of bounds');
        BinkVideoDecoder.copy8(dstBuf, blkOff, prevBuf, ref, stride);
      };
      for (let by = 0; by < bh; by++) {
        this.readBlockTypes(gb, B[SRC_BLOCK_TYPES]);
        this.readBlockTypes(gb, B[SRC_SUB_BLOCK_TYPES]);
        this.readColors(gb, B[SRC_COLORS]);
        this.readPatterns(gb, B[SRC_PATTERN]);
        this.readMotion(gb, B[SRC_X_OFF]);
        this.readMotion(gb, B[SRC_Y_OFF]);
        this.readDcs(gb, B[SRC_INTRA_DC], 11, 0);
        this.readDcs(gb, B[SRC_INTER_DC], 11, 1);
        this.readRuns(gb, B[SRC_RUN]);
        let dst = 8 * by * stride;
        for (let bx = 0; bx < bw; bx++, dst += 8) {
          let blk = this.val(SRC_BLOCK_TYPES);
          if (((by & 1) || (bx & 1)) && blk === SCALED_BLOCK) { bx++; dst += 8; continue; }
          switch (blk) {
            case SKIP_BLOCK: BinkVideoDecoder.copy8(dstBuf, dst, prevBuf, dst, stride); break;
            case SCALED_BLOCK: {
              blk = this.val(SRC_SUB_BLOCK_TYPES);
              switch (blk) {
                case RUN_BLOCK: {
                  if (gb.left < 4) throw new Error('bink: out of data');
                  const sc = gb.get(4) * 64; let i = 0, sp = sc;
                  do {
                    const run = this.val(SRC_RUN) + 1; i += run;
                    if (i > 64) throw new Error('bink: run out of bounds');
                    if (gb.get1()) { const v = this.val(SRC_COLORS); for (let j = 0; j < run; j++) ublock[patterns[sp++]] = v; }
                    else for (let j = 0; j < run; j++) ublock[patterns[sp++]] = this.val(SRC_COLORS);
                  } while (i < 63);
                  if (i === 63) ublock[patterns[sp++]] = this.val(SRC_COLORS);
                  break;
                }
                case INTRA_BLOCK: {
                  dctblock.fill(0); dctblock[0] = this.val(SRC_INTRA_DC);
                  const q = this.readDct(gb, dctblock); this.unquant(dctblock, T.bink_intra_quant, q * 64);
                  idctPut(ublock, 0, 8, dctblock); break;
                }
                case FILL_BLOCK: {
                  const v = this.val(SRC_COLORS);
                  for (let i = 0; i < 16; i++) dstBuf.fill(v, dst + i * stride, dst + i * stride + 16);
                  break;
                }
                case PATTERN_BLOCK: {
                  const c0 = this.val(SRC_COLORS), c1 = this.val(SRC_COLORS);
                  for (let j = 0; j < 8; j++) { let v = this.val(SRC_PATTERN); for (let i = 0; i < 8; i++, v >>= 1) ublock[i + j * 8] = (v & 1) ? c1 : c0; }
                  break;
                }
                case RAW_BLOCK: for (let j = 0; j < 8; j++) for (let i = 0; i < 8; i++) ublock[i + j * 8] = this.val(SRC_COLORS); break;
                default: throw new Error('bink: incorrect 16x16 block type ' + blk);
              }
              if (blk !== FILL_BLOCK) {
                for (let j = 0; j < 8; j++) {
                  const o1 = dst + (2 * j) * stride, o2 = o1 + stride;
                  for (let i = 0; i < 8; i++) { const v = ublock[i + 8 * j]; dstBuf[o1 + 2 * i] = dstBuf[o1 + 2 * i + 1] = dstBuf[o2 + 2 * i] = dstBuf[o2 + 2 * i + 1] = v; }
                }
              }
              bx++; dst += 8;
              break;
            }
            case MOTION_BLOCK: put(dst, dst); break;
            case RUN_BLOCK: {
              const sc = gb.get(4) * 64; let i = 0, sp = sc;
              do {
                const run = this.val(SRC_RUN) + 1; i += run;
                if (i > 64) throw new Error('bink: run out of bounds');
                if (gb.get1()) { const v = this.val(SRC_COLORS); for (let j = 0; j < run; j++) dstBuf[dst + coord[patterns[sp++]]] = v; }
                else for (let j = 0; j < run; j++) dstBuf[dst + coord[patterns[sp++]]] = this.val(SRC_COLORS);
              } while (i < 63);
              if (i === 63) dstBuf[dst + coord[patterns[sp++]]] = this.val(SRC_COLORS);
              break;
            }
            case RESIDUE_BLOCK: {
              put(dst, dst);
              block.fill(0); const v = gb.get(7); this.readResidue(gb, block, v);
              for (let i = 0; i < 8; i++) for (let k = 0; k < 8; k++) dstBuf[dst + i * stride + k] += block[i * 8 + k];
              break;
            }
            case INTRA_BLOCK: {
              dctblock.fill(0); dctblock[0] = this.val(SRC_INTRA_DC);
              const q = this.readDct(gb, dctblock); this.unquant(dctblock, T.bink_intra_quant, q * 64);
              idctPut(dstBuf, dst, stride, dctblock); break;
            }
            case FILL_BLOCK: {
              const v = this.val(SRC_COLORS);
              for (let i = 0; i < 8; i++) dstBuf.fill(v, dst + i * stride, dst + i * stride + 8);
              break;
            }
            case INTER_BLOCK: {
              put(dst, dst);
              dctblock.fill(0); dctblock[0] = this.val(SRC_INTER_DC);
              const q = this.readDct(gb, dctblock); this.unquant(dctblock, T.bink_inter_quant, q * 64);
              idctAdd(dstBuf, dst, stride, dctblock); break;
            }
            case PATTERN_BLOCK: {
              const c0 = this.val(SRC_COLORS), c1 = this.val(SRC_COLORS);
              for (let i = 0; i < 8; i++) { let v = this.val(SRC_PATTERN); for (let j = 0; j < 8; j++, v >>= 1) dstBuf[dst + i * stride + j] = (v & 1) ? c1 : c0; }
              break;
            }
            case RAW_BLOCK: {
              const cb = B[SRC_COLORS];
              for (let i = 0; i < 8; i++) for (let k = 0; k < 8; k++) dstBuf[dst + i * stride + k] = cb.u8[cb.curPtr + i * 8 + k];
              cb.curPtr += 64; break;
            }
            default: throw new Error('bink: unknown block type ' + blk);
          }
        }
      }
      gb.align32();
    }

    /** decode one video packet; afterwards this.planes hold the newest frame */
    decode(pkt) {
      const gb = new Bits(pkt, 0, pkt.length);
      // current/previous buffers for every plane
      for (let p = 0; p < 4; p++) {
        const P = this.pl[p]; if (!P) continue;
        if (this.first) { P.prev = P.zero; P.cur = P.a; } else { P.prev = P.cur; P.cur = (P.prev === P.a) ? P.b : P.a; }
      }
      const ver = this.version;
      try {
        if (this.hasAlpha) {
          if (ver >= 0x69) gb.pos += 32;
          this.decodePlane(gb, 3, 0);
        }
        if (ver >= 0x69) gb.pos += 32;
        this.frameNum++;
        for (let plane = 0; plane < 3; plane++) {
          const idx = (!plane || !this.swapPlanes) ? plane : (plane ^ 3);
          this.decodePlane(gb, idx, plane ? 1 : 0);
          if (gb.left <= 0) break;
        }
      } finally {
        this.first = false;
        this.planes = { y: this.pl[0].cur, u: this.pl[1].cur, v: this.pl[2].cur, a: this.hasAlpha ? this.pl[3].cur : null };
      }
    }
    reset() { this.first = true; this.frameNum = 0; }

    /** convert the newest frame to RGB(A) into `dst` (a Uint8Array) the way BinkCopyToBuffer does.
     *  fmt: Bink surface type (1 BGR24, 2 RGB24, 3 BGRX, 4 RGBX, 5 BGRA, 6 RGBA, 7 4444, 8 5551, 9 555, 10 565, 11 655, 12 664).
     *  base: byte offset of the destination buffer start; pitch may be negative (bottom-up); returns 0, or 1 when the format is unsupported */
    copyToBuffer(dst, base, pitch, destHeight, destX, destY, fmt) {
      const bpp = BPP[fmt]; if (!bpp) return 1;
      const w = this.width, h = this.height, P = this.planes;
      const rows = Math.max(0, destHeight > 0 ? Math.min(h, destHeight - destY) : h);
      const cols = Math.max(0, Math.min(w, Math.floor(Math.abs(pitch) / bpp) - destX));
      const Yp = P.y, Up = P.u, Vp = P.v, Ap = this.outputAlpha ? P.a : null, ys = this.strides.y, cs = this.strides.u, as = this.strides.a;
      const clip = CLIP, ty = TY, trv = TRV, tbu = TBU, tgu = TGU, tgv = TGV;
      for (let y = 0; y < rows; y++) {
        const yo = y * ys, co = (y >> 1) * cs, ao = y * as;
        let o = base + (destY + y) * pitch + destX * bpp;
        for (let x = 0; x < cols; x++, o += bpp) {
          const yy = ty[Yp[yo + x]], cx = co + (x >> 1), u = Up[cx], v = Vp[cx];
          const r = clip[((yy + trv[v]) >> 8) + 384], g = clip[((yy + tgu[u] + tgv[v]) >> 8) + 384], b = clip[((yy + tbu[u]) >> 8) + 384];
          switch (fmt) {
            case 5: dst[o] = b; dst[o + 1] = g; dst[o + 2] = r; dst[o + 3] = Ap ? Ap[ao + x] : 255; break;
            case 1: dst[o] = b; dst[o + 1] = g; dst[o + 2] = r; break;
            case 9: { const q = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3); dst[o] = q & 255; dst[o + 1] = q >> 8; break; }
            case 10: { const q = ((r >> 3) << 11) | ((g >> 2) << 5) | (b >> 3); dst[o] = q & 255; dst[o + 1] = q >> 8; break; }
            case 2: dst[o] = r; dst[o + 1] = g; dst[o + 2] = b; break;
            case 3: dst[o] = b; dst[o + 1] = g; dst[o + 2] = r; dst[o + 3] = 0; break;
            case 4: dst[o] = r; dst[o + 1] = g; dst[o + 2] = b; dst[o + 3] = 0; break;
            case 6: dst[o] = r; dst[o + 1] = g; dst[o + 2] = b; dst[o + 3] = Ap ? Ap[ao + x] : 255; break;
            case 7: { const q = (((Ap ? Ap[ao + x] : 255) >> 4) << 12) | ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4); dst[o] = q & 255; dst[o + 1] = q >> 8; break; }
            case 8: { const q = (((Ap ? Ap[ao + x] : 255) >> 7) << 15) | ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3); dst[o] = q & 255; dst[o + 1] = q >> 8; break; }
            case 11: { const q = ((r >> 2) << 10) | ((g >> 3) << 5) | (b >> 3); dst[o] = q & 255; dst[o + 1] = q >> 8; break; }
            case 12: { const q = ((r >> 2) << 10) | ((g >> 2) << 4) | (b >> 3); dst[o] = q & 255; dst[o + 1] = q >> 8; break; }
          }
        }
      }
      return 0;
    }
  }

  // ------------------------------------------------------------------------------------------ container
  class BinkFile {
    constructor(u8) {
      this.bytes = u8;
      const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
      const sig = String.fromCharCode(u8[0], u8[1], u8[2], u8[3]);
      if (sig.substr(0, 3) !== 'BIK') throw new Error('not a Bink 1 file');
      this.signature = sig; this.version = u8[3];
      this.fileSize = dv.getUint32(4, true) + 8; this.frames = dv.getUint32(8, true); this.largest = dv.getUint32(12, true);
      this.width = dv.getUint32(20, true); this.height = dv.getUint32(24, true);
      this.fpsNum = dv.getUint32(28, true); this.fpsDen = dv.getUint32(32, true);
      this.flags = dv.getUint32(36, true); this.hasAlpha = !!(this.flags & 0x00100000);
      const nTracks = dv.getUint32(40, true); let o = 44;
      if (this.version === 0x6b) o += 4;
      this.audioTracks = [];
      if (nTracks) {
        o += 4 * nTracks;
        for (let i = 0; i < nTracks; i++) { const rate = dv.getUint16(o, true), fl = dv.getUint16(o + 2, true); o += 4; this.audioTracks.push({ rate, flags: fl, channels: (fl & 0x2000) ? 2 : 1, useDct: !!(fl & 0x1000), id: 0 }); }
        for (let i = 0; i < nTracks; i++) { this.audioTracks[i].id = dv.getUint32(o, true); o += 4; }
      }
      this.offsets = new Uint32Array(this.frames + 1); this.key = new Uint8Array(this.frames + 1);
      for (let i = 0; i < this.frames; i++) { const v = dv.getUint32(o, true); o += 4; this.offsets[i] = v & ~1; this.key[i] = v & 1; }
      this.offsets[this.frames] = Math.min(this.fileSize, u8.length); this.key[this.frames] = 1;
      this.key[0] = 1;
    }
    /** 0-based frame -> {video, audio[]} (audio entries are null for tracks without data in that frame; the 4-byte size header is included) */
    packet(n) {
      const u8 = this.bytes, dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
      let p = this.offsets[n]; const end = this.offsets[n + 1];
      const audio = [];
      for (let t = 0; t < this.audioTracks.length; t++) {
        const sz = dv.getUint32(p, true); p += 4;
        audio.push(sz >= 4 && p + sz <= end ? u8.subarray(p, p + sz) : null);
        p += sz;
      }
      const v = u8.subarray(p, end), video = new Uint8Array(v.length + 16); video.set(v);
      return { video: video.subarray(0, v.length), audio };
    }
  }

  // ------------------------------------------------------------------------------------------ audio
  const CRIT_FREQS = [100, 200, 300, 400, 510, 630, 770, 920, 1080, 1270, 1480, 1720, 2000, 2320, 2700, 3150, 3700, 4400, 5300, 6400, 7700, 9500, 12000, 15500, 24500];
  const RLE_LENGTH_TAB = [2, 3, 4, 5, 6, 8, 9, 10, 11, 12, 13, 14, 15, 16, 32, 64];

  /** in-place radix-2 complex FFT (forward, e^{-i...}) on re/im arrays of power-of-two length */
  function fft(re, im, n, inverse) {
    for (let i = 1, j = 0; i < n; i++) {
      let bit = n >> 1; for (; j & bit; bit >>= 1) j ^= bit; j ^= bit;
      if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
    }
    for (let len = 2; len <= n; len <<= 1) {
      const ang = (inverse ? 2 : -2) * Math.PI / len, wr = Math.cos(ang), wi = Math.sin(ang), half = len >> 1;
      for (let i = 0; i < n; i += len) {
        let cr = 1, ci = 0;
        for (let k = 0; k < half; k++) {
          const a = i + k, b = a + half;
          const tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr;
          re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
          const ncr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = ncr;
        }
      }
    }
  }

  class BinkAudioDecoder {
    /** version: the 4th signature byte of the file ('b', 'i' ...); rate/channels from the track description */
    constructor(rate, channels, useDct, version) {
      this.useDct = useDct; this.channels = channels; this.versionB = version === 0x62; this.rate = rate;
      let bits = rate < 22050 ? 9 : rate < 44100 ? 10 : 11;
      let rateEff = rate, chEff = channels;
      if (!useDct) { rateEff = rate * channels; chEff = 1; if (!this.versionB) bits += log2(channels); }
      this.coded = chEff;                              // channels coded as separate DCT blocks (1 for RDFT: interleaved)
      this.frameLen = 1 << bits; this.overlapLen = this.frameLen >> 4;
      this.blockSize = (this.frameLen - this.overlapLen) * Math.min(2, chEff);
      const half = Math.floor((rateEff + 1) / 2);
      this.root = useDct ? this.frameLen / (Math.sqrt(this.frameLen) * 32768.0) : 2.0 / (Math.sqrt(this.frameLen) * 32768.0);
      this.quantTable = new Float32Array(96);
      for (let i = 0; i < 96; i++) this.quantTable[i] = Math.fround(Math.exp(Math.fround(i * 0.15289164787221953823)) * this.root);
      let nb = 1; for (; nb < 25; nb++) if (half <= CRIT_FREQS[nb - 1]) break;
      this.numBands = nb;
      this.bands = new Uint32Array(26); this.bands[0] = 2;
      for (let i = 1; i < nb; i++) this.bands[i] = Math.floor(CRIT_FREQS[i - 1] * this.frameLen / half) & ~1;
      this.bands[nb] = this.frameLen;
      // transform normalisations: DCT variant verified against FFmpeg output (tests/bink_check_audio.js: ratio is exactly 2/N);
      // the RDFT variant (old 'b'-style files, none in this game) is untested
      this.dctScale = 2 / this.frameLen; this.rdftScale = 1 / this.frameLen;
      this.first = true;
      this.previous = []; for (let c = 0; c < Math.max(chEff, 1); c++) this.previous.push(new Float32Array(this.overlapLen));
      this.coeffs = new Float32Array(this.frameLen + 2);
      const n2 = this.frameLen * 2; this.fr = new Float64Array(n2); this.fi = new Float64Array(n2);
      this.outBlk = []; for (let c = 0; c < Math.max(chEff, 1); c++) this.outBlk.push(new Float32Array(this.frameLen));
    }

    /** transform coefficient array -> time samples (frameLen floats) */
    transform(coeffs, out) {
      const N = this.frameLen, re = this.fr, im = this.fi;
      if (this.useDct) {
        // DCT-III: out[n] = scale * sum_k w_k X[k] cos(pi (2n+1) k / (2N)); computed with a 2N point complex inverse FFT
        re.fill(0); im.fill(0);
        for (let k = 0; k < N; k++) { const a = Math.PI * k / (2 * N), x = coeffs[k] * (k === 0 ? 0.5 : 1); re[k] = x * Math.cos(a); im[k] = x * Math.sin(a); }
        fft(re, im, 2 * N, true);
        const sc = this.dctScale;
        for (let n = 0; n < N; n++) out[n] = re[n] * sc;
      } else {
        // inverse real DFT of N samples from N/2+1 complex bins: X[0]=c[0], X[N/2]=c[1], X[k]=(c[2k], -c[2k+1])
        re.fill(0); im.fill(0);
        re[0] = coeffs[0]; re[N >> 1] = coeffs[1];
        for (let k = 1; k < (N >> 1); k++) { re[k] = coeffs[2 * k]; im[k] = -coeffs[2 * k + 1]; re[N - k] = re[k]; im[N - k] = -im[k]; }
        fft(re, im, N, true);
        const sc = this.rdftScale;
        for (let n = 0; n < N; n++) out[n] = re[n] * sc;
      }
    }

    /** decode one packet (starting with its 4 byte sample count); returns [Float32Array per channel] */
    decode(pkt) {
      const gb = new Bits(pkt, 0, pkt.length);
      gb.pos += 32;
      const outCh = []; for (let c = 0; c < this.channels; c++) outCh.push([]);
      const chunk = this.useDct ? this.channels : 1;
      while (gb.left > 0) {
        const blk = this.decodeBlock(gb, chunk);
        const n = this.frameLen - this.overlapLen;
        if (this.useDct) for (let c = 0; c < this.channels; c++) outCh[c].push(blk[c].slice(0, n));
        else outCh[0].push(blk[0].slice(0, n));
        gb.align32();
      }
      const res = [];
      for (let c = 0; c < this.channels; c++) {
        const parts = outCh[c]; let tot = 0; for (const p of parts) tot += p.length;
        const o = new Float32Array(tot); let q = 0; for (const p of parts) { o.set(p, q); q += p.length; }
        res.push(o);
      }
      return res;
    }

    decodeBlock(gb, channels) {
      const coeffs = this.coeffs, N = this.frameLen, quant = new Float32Array(25), out = this.outBlk;
      const qbits = 8;
      if (this.useDct) gb.pos += 2;
      for (let ch = 0; ch < channels; ch++) {
        if (this.versionB) {
          if (gb.left < 64) throw new Error('bink audio: out of data');
          const f = new Float32Array(1), u = new Uint32Array(f.buffer);
          u[0] = gb.get(16) | (gb.get(16) << 16); coeffs[0] = f[0] * this.root;
          u[0] = gb.get(16) | (gb.get(16) << 16); coeffs[1] = f[0] * this.root;
        } else {
          if (gb.left < 58) throw new Error('bink audio: out of data');
          coeffs[0] = Math.fround(this.getFloat(gb) * this.root); coeffs[1] = Math.fround(this.getFloat(gb) * this.root);
        }
        if (gb.left < this.numBands * qbits) throw new Error('bink audio: out of data');
        for (let i = 0; i < this.numBands; i++) quant[i] = this.quantTable[Math.min(gb.get(qbits), 95)];
        let k = 0, q = quant[0], i = 2;
        while (i < N) {
          let j;
          if (this.versionB) j = i + 16;
          else if (gb.get1()) j = i + RLE_LENGTH_TAB[gb.get(4)] * 8; else j = i + 8;
          j = Math.min(j, N);
          const width = gb.get(4);
          if (width === 0) {
            coeffs.fill(0, i, j); i = j;
            while (this.bands[k] < i) q = quant[k++];
          } else {
            while (i < j) {
              if (this.bands[k] === i) q = quant[k++];
              const coeff = gb.get(width);
              coeffs[i] = coeff ? (gb.get1() ? -q * coeff : q * coeff) : 0;
              i++;
            }
          }
        }
        if (this.useDct) coeffs[0] /= 0.5;
        this.transform(coeffs, out[ch]);
      }
      const ov = this.overlapLen;
      for (let ch = 0; ch < channels; ch++) {
        const count = ov * channels, o = out[ch], prev = this.previous[ch];
        if (!this.first) { let j = ch; for (let i = 0; i < ov; i++, j += channels) o[i] = (prev[i] * (count - j) + o[i] * j) / count; }
        prev.set(o.subarray(N - ov, N));
      }
      this.first = false;
      return out;
    }
    getFloat(gb) {
      const power = gb.get(5), m = gb.get(23);
      let f = m * Math.pow(2, power - 23);
      if (gb.get1()) f = -f;
      return f;
    }
    resetOverlap() { this.first = true; }
  }

  initVlcs();
  EMU.BinkFile = BinkFile; EMU.BinkVideoDecoder = BinkVideoDecoder; EMU.BinkAudioDecoder = BinkAudioDecoder;
})(typeof globalThis !== 'undefined' ? globalThis : this);
