/* Smacker (SMK2/SMK4) decoder for the browser and Node.
 *
 *   const d = new SmkDecoder(arrayBuffer);
 *   d.width, d.height, d.frames, d.frameMs
 *   d.decodeFrame(i)        -> decodes frame i (must be called in order 0,1,2,...; call d.reset() to restart)
 *                              fills d.pixels (Uint8Array width*height, palette indices) and d.palette (Uint8Array 768, RGB)
 *   d.audioTrack(n)         -> {rate, channels, bits, data: Int16Array|Uint8Array} for packed audio track n (null if absent)
 *   d.rawTrack(n)           -> Uint8Array with the concatenated raw bytes of an uncompressed track (the game stores a
 *                              per-frame hit mask in them; not needed for display)
 */
(function (root) {
  'use strict';

  const SMK_PAL = [
    0x00, 0x04, 0x08, 0x0C, 0x10, 0x14, 0x18, 0x1C, 0x20, 0x24, 0x28, 0x2C, 0x30, 0x34, 0x38, 0x3C,
    0x41, 0x45, 0x49, 0x4D, 0x51, 0x55, 0x59, 0x5D, 0x61, 0x65, 0x69, 0x6D, 0x71, 0x75, 0x79, 0x7D,
    0x82, 0x86, 0x8A, 0x8E, 0x92, 0x96, 0x9A, 0x9E, 0xA2, 0xA6, 0xAA, 0xAE, 0xB2, 0xB6, 0xBA, 0xBE,
    0xC3, 0xC7, 0xCB, 0xCF, 0xD3, 0xD7, 0xDB, 0xDF, 0xE3, 0xE7, 0xEB, 0xEF, 0xF3, 0xF7, 0xFB, 0xFF];

  const BLOCK_RUNS = [
    1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32,
    33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46, 47, 48, 49, 50, 51, 52, 53, 54, 55, 56, 57, 58, 59,
    128, 256, 512, 1024, 2048];

  /* LSB-first bit reader */
  class Bits {
    constructor(u8, start, end) {
      this.d = u8; this.pos = start * 8; this.end = end * 8;
    }
    bit() {
      const p = this.pos++;
      if (p >= this.end) throw new Error('smk: bit reader overrun');
      return (this.d[p >> 3] >> (p & 7)) & 1;
    }
    bits(n) {
      let v = 0;
      for (let i = 0; i < n; i++) v |= this.bit() << i;
      return v >>> 0;
    }
  }

  /* small tree (audio, and the two byte-trees of the big trees): node = {l, r} | leaf = number */
  function readSmallTree(br) {
    if (!br.bit()) return br.bits(8);                 // leaf
    const l = readSmallTree(br);
    const r = readSmallTree(br);
    return { l, r };
  }
  function walkSmall(br, t) {
    while (typeof t === 'object') t = br.bit() ? t.r : t.l;
    return t;
  }

  /* big tree: flat array, node = SMK_NODE | leftSize ; leaf = value; plus the 3-entry "last value" cache */
  const NODE = 0x80000000;
  function readBigTree(br, size) {
    // "tree present" flag
    if (!br.bit()) {
      return { table: [0], last: [0, 0, 0], empty: true };
    }
    let t1 = null, t2 = null;
    if (br.bit()) { t1 = readSmallTree(br); br.bit(); }
    if (br.bit()) { t2 = readSmallTree(br); br.bit(); }
    const esc = [0, 0, 0];
    for (let i = 0; i < 3; i++) { const lo = br.bits(8); const hi = br.bits(8); esc[i] = lo | (hi << 8); }
    const last = [-1, -1, -1];
    const table = [];
    function build(depth) {
      if (depth > 500) throw new Error('smk: tree too deep');
      if (!br.bit()) {                                // leaf
        const i1 = t1 === null ? 0 : walkSmall(br, t1);
        const i2 = t2 === null ? 0 : walkSmall(br, t2);
        let val = i1 | (i2 << 8);
        if (val === esc[0]) { last[0] = table.length; val = 0; }
        else if (val === esc[1]) { last[1] = table.length; val = 0; }
        else if (val === esc[2]) { last[2] = table.length; val = 0; }
        table.push(val);
        return 1;
      }
      const t = table.length; table.push(0);          // node
      const r = build(depth + 1);
      table[t] = (NODE | r) >>> 0;
      const r2 = build(depth + 1);
      return 1 + r + r2;
    }
    build(0);
    br.bit();                                         // trailing 0 bit
    for (let i = 0; i < 3; i++) if (last[i] === -1) { last[i] = table.length; table.push(0); }
    return { table, last, empty: false };
  }
  function bigGet(br, T) {
    const tb = T.table;
    let i = 0;
    while (tb[i] & NODE) {                            // note: values are < 2^31 so the test is exact
      if (br.bit()) i += (tb[i] & ~NODE) >>> 0;
      i++;
    }
    const v = tb[i];
    const last = T.last;
    if (v !== tb[last[0]]) {
      tb[last[2]] = tb[last[1]];
      tb[last[1]] = tb[last[0]];
      tb[last[0]] = v;
    }
    return v;
  }

  class SmkDecoder {
    constructor(buf) {
      const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
      this.u8 = u8;
      const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
      this.dv = dv;
      const sig = String.fromCharCode(u8[0], u8[1], u8[2], u8[3]);
      if (sig !== 'SMK2' && sig !== 'SMK4') throw new Error('not a Smacker file: ' + sig);
      this.v4 = sig === 'SMK4';
      this.width = dv.getUint32(4, true);
      this.height = dv.getUint32(8, true);
      let frames = dv.getUint32(12, true);
      const rate = dv.getInt32(16, true);
      this.flags = dv.getUint32(20, true);
      if (this.flags & 1) frames++;                   // ring frame
      this.frames = frames;
      if (rate > 0) this.frameMs = rate; else if (rate < 0) this.frameMs = -rate / 100; else this.frameMs = 100;
      this.audioMax = []; for (let i = 0; i < 7; i++) this.audioMax.push(dv.getUint32(24 + 4 * i, true));
      this.treeSize = dv.getUint32(52, true);
      this.sizes = [dv.getUint32(56, true), dv.getUint32(60, true), dv.getUint32(64, true), dv.getUint32(68, true)];
      this.audioRate = []; this.audioFlags = [];
      for (let i = 0; i < 7; i++) {
        const v = dv.getUint32(72 + 4 * i, true);
        this.audioRate.push(v & 0xFFFFFF); this.audioFlags.push(v >>> 24);
      }
      let p = 104;
      this.frameSize = []; this.frameFlag = [];
      for (let i = 0; i < frames; i++) { this.frameSize.push(dv.getUint32(p, true) & ~3); p += 4; }
      for (let i = 0; i < frames; i++) { this.frameFlag.push(u8[p++]); }
      // trees
      const br = new Bits(u8, p, p + this.treeSize);
      this.trees = {};
      this.trees.mmap = readBigTree(br, this.sizes[0]);
      this.trees.mclr = readBigTree(br, this.sizes[1]);
      this.trees.full = readBigTree(br, this.sizes[2]);
      this.trees.type = readBigTree(br, this.sizes[3]);
      this.treesPristine = JSON.stringify([this.trees.mmap.table, this.trees.mclr.table, this.trees.full.table, this.trees.type.table]);
      this.dataStart = p + this.treeSize;
      // frame offsets
      this.frameOff = []; let o = this.dataStart;
      for (let i = 0; i < frames; i++) { this.frameOff.push(o); o += this.frameSize[i]; }
      this.pixels = new Uint8Array(this.width * this.height);
      this.palette = new Uint8Array(768);
      this.cur = -1; this.begun = -1; this.begunPal = false;
      this.dirty = new Uint8Array((this.width >> 2) * (this.height >> 2));      // 4x4 blocks written by the last decoded frame
      this._pristine = [this.trees.mmap.table.slice(), this.trees.mclr.table.slice(), this.trees.full.table.slice(), this.trees.type.table.slice()];
    }

    reset() {
      this.pixels.fill(0); this.palette.fill(0); this.cur = -1; this.begun = -1; this.begunPal = false;
      const t = [this.trees.mmap, this.trees.mclr, this.trees.full, this.trees.type];
      for (let i = 0; i < 4; i++) t[i].table = this._pristine[i].slice();
    }

    /** split a frame into palette / audio chunks / video bitstream */
    _parts(i) {
      const u8 = this.u8, dv = this.dv;
      let p = this.frameOff[i]; const end = p + this.frameSize[i];
      const flags = this.frameFlag[i];
      const parts = { pal: null, audio: [], video: null };
      if (flags & 1) {
        const n = u8[p] * 4;
        parts.pal = { start: p + 1, end: p + n };
        p += n;
      }
      for (let t = 0; t < 7; t++) {
        if (flags & (2 << t)) {
          const sz = dv.getUint32(p, true);
          parts.audio.push({ track: t, start: p + 4, end: p + sz });
          p += sz;
        }
      }
      parts.video = { start: p, end };
      return parts;
    }

    _applyPalette(pt) {
      const u8 = this.u8, pal = this.palette;
      const old = pal.slice();
      let p = pt.start, sz = 0, q = 0;
      while (sz < 256 && p < pt.end) {
        const t = u8[p++];
        if (t & 0x80) {
          const n = (t & 0x7F) + 1; sz += n; q += n * 3;
        } else if (t & 0x40) {
          const off = u8[p++]; let j = (t & 0x3F) + 1; let o3 = off * 3;
          while (j-- && sz < 256) { pal[q++] = old[o3++]; pal[q++] = old[o3++]; pal[q++] = old[o3++]; sz++; }
        } else {
          pal[q++] = SMK_PAL[t & 0x3F];
          pal[q++] = SMK_PAL[u8[p++] & 0x3F];
          pal[q++] = SMK_PAL[u8[p++] & 0x3F];
          sz++;
        }
      }
    }

    _seek(i) {
      if (i === 0 && this.cur !== -1) this.reset();
      if (i !== this.cur + 1) {
        if (i <= this.cur) this.reset();
        while (this.cur + 1 < i) this.decodeFrame(this.cur + 1);
      }
    }

    /** step 1 of a frame: bring the decoder to frame i and apply that frame's palette chunk.
     *  Returns true when the frame carries a palette. The game (via SMACKW32) wants the palette before it asks for the pixels. */
    beginFrame(i) {
      if (this.begun === i) return this.begunPal;
      this._seek(i);
      const parts = this._parts(i);
      if (parts.pal) this._applyPalette(parts.pal);
      this.begun = i; this.begunPal = !!parts.pal;
      return this.begunPal;
    }

    /** step 2: decode the pixels of frame i (this.dirty marks the 4x4 blocks that were written) */
    finishFrame(i) {
      if (this.begun !== i) this.beginFrame(i);
      this._decodeVideo(this._parts(i).video);
      this.cur = i; this.begun = -1; this.begunPal = false;
    }

    decodeFrame(i) { this.beginFrame(i); this.finishFrame(i); }

    /** the packed bytes of one track in one frame (null when the frame has none) */
    frameTrack(i, n) {
      if (!(this.frameFlag[i] & (2 << n))) return null;
      const a = this._parts(i).audio.find(x => x.track === n);
      return a ? { start: a.start, end: a.end } : null;
    }

    _decodeVideo(v) {
      const W = this.width, H = this.height, px = this.pixels;
      const bw = W >> 2, bh = H >> 2, blocks = bw * bh;
      const br = new Bits(this.u8, v.start, v.end);
      const T = this.trees, dirty = this.dirty;
      dirty.fill(0);
      for (const t of [T.mmap, T.mclr, T.full, T.type]) t.table[t.last[0]] = t.table[t.last[1]] = t.table[t.last[2]] = 0;   // ffmpeg's last_reset()
      let blk = 0;
      while (blk < blocks) {
        const type = bigGet(br, T.type);
        let run = BLOCK_RUNS[(type >> 2) & 0x3F];
        switch (type & 3) {
          case 0:                                     // MONO
            while (run-- && blk < blocks) {
              const clr = bigGet(br, T.mclr);
              let map = bigGet(br, T.mmap);
              const hi = clr >> 8, lo = clr & 0xFF;
              let o = ((blk / bw) | 0) * 4 * W + (blk % bw) * 4;
              for (let r = 0; r < 4; r++) {
                px[o] = (map & 1) ? hi : lo;
                px[o + 1] = (map & 2) ? hi : lo;
                px[o + 2] = (map & 4) ? hi : lo;
                px[o + 3] = (map & 8) ? hi : lo;
                map >>= 4; o += W;
              }
              dirty[blk++] = 1;
            }
            break;
          case 1: {                                   // FULL
            let mode = 0;
            if (this.v4) { if (br.bit()) mode = 1; else if (br.bit()) mode = 2; }
            while (run-- && blk < blocks) {
              let o = ((blk / bw) | 0) * 4 * W + (blk % bw) * 4;
              if (mode === 0) {
                for (let r = 0; r < 4; r++) {
                  let pix = bigGet(br, T.full);
                  px[o + 2] = pix & 0xFF; px[o + 3] = pix >> 8;
                  pix = bigGet(br, T.full);
                  px[o] = pix & 0xFF; px[o + 1] = pix >> 8;
                  o += W;
                }
              } else if (mode === 1) {                // v4: 2x2 pixel doubled vertically
                for (let r = 0; r < 2; r++) {
                  let pix = bigGet(br, T.full);
                  px[o + 2] = px[o + 3] = px[o + W + 2] = px[o + W + 3] = pix & 0xFF;
                  px[o] = px[o + 1] = px[o + W] = px[o + W + 1] = (pix >> 8) & 0xFF;
                  // (SMK4 modes are not used by this game; kept for completeness)
                  o += 2 * W;
                }
              } else {
                for (let r = 0; r < 2; r++) {
                  let pix = bigGet(br, T.full);
                  px[o + 2] = px[o + 3] = pix & 0xFF; px[o] = px[o + 1] = pix >> 8;
                  pix = bigGet(br, T.full);
                  px[o + W + 2] = px[o + W + 3] = pix & 0xFF; px[o + W] = px[o + W + 1] = pix >> 8;
                  o += 2 * W;
                }
              }
              dirty[blk++] = 1;
            }
            break;
          }
          case 2:                                     // SKIP (keep previous frame)
            while (run-- && blk < blocks) blk++;
            break;
          case 3: {                                   // FILL
            const col = type >> 8;
            while (run-- && blk < blocks) {
              let o = ((blk / bw) | 0) * 4 * W + (blk % bw) * 4;
              for (let r = 0; r < 4; r++) { px[o] = px[o + 1] = px[o + 2] = px[o + 3] = col; o += W; }
              dirty[blk++] = 1;
            }
            break;
          }
        }
      }
    }

    /** decode one packed audio chunk into the output arrays */
    _decodeAudioChunk(a, flags) {
      const u8 = this.u8;
      const unp = (u8[a.start] | (u8[a.start + 1] << 8) | (u8[a.start + 2] << 16) | (u8[a.start + 3] << 24)) >>> 0;
      const br = new Bits(u8, a.start + 4, a.end);
      if (!br.bit()) return null;
      const stereo = br.bit(), bits16 = br.bit();
      const nt = 1 << (bits16 + stereo);
      const trees = [];
      for (let i = 0; i < nt; i++) {
        if (br.bit()) { trees.push(readSmallTree(br)); br.bit(); } else trees.push(0);
      }
      const get = (k) => walkSmall(br, trees[k]);
      const pred = [0, 0];
      let out;
      if (bits16) {
        const n = unp >> 1; out = new Int16Array(n);
        for (let i = stereo; i >= 0; i--) { const lo = br.bits(8), hi = br.bits(8); pred[i] = (((lo << 8) | hi) << 16) >> 16; }
        let o = 0;
        for (let i = 0; i <= stereo; i++) out[o++] = pred[i];
        for (let i = 1 + stereo; o < n; i++) {
          if (i & stereo) {
            let val = get(2); val |= get(3) << 8; pred[1] = ((pred[1] + val) << 16) >> 16;
            out[o++] = pred[1];
          } else {
            let val = get(0); val |= get(1) << 8; pred[0] = ((pred[0] + val) << 16) >> 16;
            out[o++] = pred[0];
          }
        }
      } else {
        out = new Uint8Array(unp);
        for (let i = stereo; i >= 0; i--) pred[i] = br.bits(8);
        let o = 0;
        for (let i = 0; i <= stereo; i++) out[o++] = pred[i];
        for (let i = 1 + stereo; o < unp; i++) {
          if (i & stereo) { pred[1] += (get(1) << 24) >> 24; out[o++] = Math.max(0, Math.min(255, pred[1])); }
          else { pred[0] += (get(0) << 24) >> 24; out[o++] = Math.max(0, Math.min(255, pred[0])); }
        }
      }
      return { data: out, stereo, bits16 };
    }

    /** whole audio track n decoded (packed tracks only). Returns null when the track does not exist */
    audioTrack(n) {
      const rate = this.audioRate[n], fl = this.audioFlags[n];
      if (!rate) return null;
      if (!(fl & 0x80)) return null;                  // not packed
      const chunks = [];
      let total = 0, info = null;
      for (let i = 0; i < this.frames; i++) {
        if (!(this.frameFlag[i] & (2 << n))) continue;
        const parts = this._parts(i);
        const a = parts.audio.find(x => x.track === n);
        const r = this._decodeAudioChunk(a, fl);
        if (r) { chunks.push(r.data); total += r.data.length; info = r; }
      }
      if (!info) return null;
      const out = info.bits16 ? new Int16Array(total) : new Uint8Array(total);
      let o = 0; for (const c of chunks) { out.set(c, o); o += c.length; }
      return { rate, channels: info.stereo ? 2 : 1, bits: info.bits16 ? 16 : 8, data: out };
    }

    rawTrack(n) {
      if (!this.audioRate[n] || (this.audioFlags[n] & 0x80)) return null;
      const parts = [];
      for (let i = 0; i < this.frames; i++) {
        if (!(this.frameFlag[i] & (2 << n))) continue;
        const a = this._parts(i).audio.find(x => x.track === n);
        parts.push(this.u8.subarray(a.start, a.end));
      }
      let total = 0; for (const p of parts) total += p.length;
      const out = new Uint8Array(total); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; }
      return out;
    }
  }

  const api = { SmkDecoder };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.SMK = api;
})(typeof self !== 'undefined' ? self : this);
