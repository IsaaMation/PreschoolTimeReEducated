/* MP3 (MPEG audio, Layer III) decoder, written in JavaScript.
 *
 * A port of the Layer III path of minimp3 (https://github.com/lieff/minimp3, CC0 1.0 - public domain dedication): bit reservoir,
 * Huffman decoding, requantisation, stereo processing, IMDCT and the polyphase filter bank. MPEG-1, MPEG-2 and MPEG-2.5 files
 * with a constant sample rate are handled; Layers I and II and free-format streams are not (the game's music is Layer III).
 * The constant tables come from mp3tab.js, which is generated from minimp3.h by tools/gen_mp3tab.py.
 *
 *   EMU.mp3Decode(bytes) -> {rate, ch, frames, pcm: Int16Array (interleaved), ensure(upToFrame), done()} | null
 *
 * The whole file is scanned at once (cheap: only the frame headers), but the sound itself is made on demand: pcm is allocated
 * with its final size and ensure(n) decodes enough frames to fill the first n sample frames. A long music track therefore costs
 * a little time as it plays, not a long pause when it starts.
 */
(function (G) {
  'use strict';
  const EMU = G.EMU = G.EMU || {};
  const T = EMU.mp3Tables;

  // ------------------------------------------------------------------ frame headers (b: bytes, o: offset of the 4 header bytes)
  const isMono = (b, o) => (b[o + 3] & 0xC0) === 0xC0;
  const isMs = (b, o) => (b[o + 3] & 0xE0) === 0x60;
  const isCrc = (b, o) => !(b[o + 1] & 1);
  const hasPadding = (b, o) => (b[o + 2] & 2) !== 0;
  const isMpeg1 = (b, o) => (b[o + 1] & 8) !== 0;
  const notMpeg25 = (b, o) => (b[o + 1] & 16) !== 0;
  const isIntensity = (b, o) => (b[o + 3] & 0x10) !== 0;
  const hasMsFlag = (b, o) => (b[o + 3] & 0x20) !== 0;
  const layerBits = (b, o) => (b[o + 1] >> 1) & 3;
  const bitrateIdx = (b, o) => b[o + 2] >> 4;
  const rateIdx = (b, o) => (b[o + 2] >> 2) & 3;
  const mySampleRate = (b, o) => rateIdx(b, o) + (((b[o + 1] >> 3) & 1) + ((b[o + 1] >> 4) & 1)) * 3;
  const isFrame576 = (b, o) => (b[o + 1] & 14) === 2;
  const isLayer1 = (b, o) => (b[o + 1] & 6) === 6;
  const isFreeFormat = (b, o) => (b[o + 2] & 0xF0) === 0;

  function hdrValid(b, o) {
    return o + 4 <= b.length && b[o] === 0xff && ((b[o + 1] & 0xF0) === 0xf0 || (b[o + 1] & 0xFE) === 0xe2) &&
      layerBits(b, o) !== 0 && bitrateIdx(b, o) !== 15 && rateIdx(b, o) !== 3;
  }
  function hdrCompare(b1, o1, b2, o2) {
    return hdrValid(b2, o2) && ((b1[o1 + 1] ^ b2[o2 + 1]) & 0xFE) === 0 && ((b1[o1 + 2] ^ b2[o2 + 2]) & 0x0C) === 0 &&
      isFreeFormat(b1, o1) === isFreeFormat(b2, o2);
  }
  const HALFRATE = [
    [[0, 4, 8, 12, 16, 20, 24, 28, 32, 40, 48, 56, 64, 72, 80], [0, 4, 8, 12, 16, 20, 24, 28, 32, 40, 48, 56, 64, 72, 80], [0, 16, 24, 28, 32, 40, 48, 56, 64, 72, 80, 88, 96, 112, 128]],
    [[0, 16, 20, 24, 28, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160], [0, 16, 24, 28, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192], [0, 16, 32, 48, 64, 80, 96, 112, 128, 144, 160, 176, 192, 208, 224]],
  ];
  const bitrateKbps = (b, o) => 2 * HALFRATE[isMpeg1(b, o) ? 1 : 0][layerBits(b, o) - 1][bitrateIdx(b, o)];
  const HZ = [44100, 48000, 32000];
  const sampleRateHz = (b, o) => HZ[rateIdx(b, o)] >> (isMpeg1(b, o) ? 0 : 1) >> (notMpeg25(b, o) ? 0 : 1);
  const frameSamples = (b, o) => isLayer1(b, o) ? 384 : (1152 >> (isFrame576(b, o) ? 1 : 0));
  const frameBytes = (b, o) => { let n = Math.floor(frameSamples(b, o) * bitrateKbps(b, o) * 125 / sampleRateHz(b, o)); if (isLayer1(b, o)) n &= ~3; return n; };
  const padding = (b, o) => hasPadding(b, o) ? (isLayer1(b, o) ? 4 : 1) : 0;

  // ------------------------------------------------------------------ bit reader: {buf, pos (in bits), limit (in bits)}
  function getBits(bs, n) {
    const s = bs.pos & 7;
    let p = bs.pos >> 3, shl = n + s, cache = 0;
    bs.pos += n;
    if (bs.pos > bs.limit) return 0;
    const buf = bs.buf;
    let next = buf[p++] & (255 >> s);
    while ((shl -= 8) > 0) { cache |= next << shl; next = buf[p++]; }
    return (cache | (next >> -shl)) >>> 0;
  }

  // ------------------------------------------------------------------ decoder state
  const newGr = () => ({
    sfbtab: null, part23: 0, bigValues: 0, scalefacCompress: 0, globalGain: 0, blockType: 0, mixed: 0, nLong: 0, nShort: 0,
    tableSelect: new Uint8Array(3), region: new Uint8Array(3), subgain: new Uint8Array(3), preflag: 0, scalefacScale: 0, count1Table: 0, scfsi: 0,
  });
  function newDecoder() {
    return {
      mdct: [new Float32Array(288), new Float32Array(288)], qmf: new Float32Array(960), reserv: 0, reservBuf: new Uint8Array(511), header: new Uint8Array(4),
      bsFrame: { buf: null, pos: 0, limit: 0 }, bs: { buf: null, pos: 0, limit: 0 }, maindata: new Uint8Array(511 + 2304 + 16),
      gr: [newGr(), newGr(), newGr(), newGr()], grbuf: new Float32Array(1152), scf: new Float32Array(40), syn: new Float32Array(33 * 64), istPos: new Uint8Array(78),
      iscf: new Uint8Array(40), scfSize: new Uint8Array(4), maxBand: new Int32Array(3),
    };
  }

  // sfb tables are rows of the generated tables; rows are cut out once
  const rows = (a, w) => { const r = []; for (let i = 0; i < a.length / w; i++) r.push(a.subarray(i * w, (i + 1) * w)); return r; };
  const SCF_LONG = rows(T.scfLong, 23), SCF_SHORT = rows(T.scfShort, 40), SCF_MIXED = rows(T.scfMixed, 40);

  // ------------------------------------------------------------------ side information and scale factors
  function readSideInfo(bs, grs, h) {
    let tables, scfsi = 0, part23sum = 0, gi = 0, mainDataBegin;
    const mono = isMono(h, 0), mpeg1 = isMpeg1(h, 0);
    let grCount = mono ? 1 : 2;
    let sr = mySampleRate(h, 0); if (sr !== 0) sr--;
    if (mpeg1) { grCount *= 2; mainDataBegin = getBits(bs, 9); scfsi = getBits(bs, 7 + grCount); }
    else mainDataBegin = getBits(bs, 8 + grCount) >> grCount;
    do {
      const gr = grs[gi++];
      if (mono) scfsi <<= 4;
      gr.part23 = getBits(bs, 12);
      part23sum += gr.part23;
      gr.bigValues = getBits(bs, 9);
      if (gr.bigValues > 288) return -1;
      gr.globalGain = getBits(bs, 8);
      gr.scalefacCompress = getBits(bs, mpeg1 ? 4 : 9);
      gr.sfbtab = SCF_LONG[sr]; gr.nLong = 22; gr.nShort = 0;
      if (getBits(bs, 1)) {
        gr.blockType = getBits(bs, 2);
        if (!gr.blockType) return -1;
        gr.mixed = getBits(bs, 1);
        gr.region[0] = 7; gr.region[1] = 255;
        if (gr.blockType === 2) {
          scfsi &= 0x0F0F;
          if (!gr.mixed) { gr.region[0] = 8; gr.sfbtab = SCF_SHORT[sr]; gr.nLong = 0; gr.nShort = 39; }
          else { gr.sfbtab = SCF_MIXED[sr]; gr.nLong = mpeg1 ? 8 : 6; gr.nShort = 30; }
        }
        tables = getBits(bs, 10) << 5;
        gr.subgain[0] = getBits(bs, 3); gr.subgain[1] = getBits(bs, 3); gr.subgain[2] = getBits(bs, 3);
      } else {
        gr.blockType = 0; gr.mixed = 0;
        tables = getBits(bs, 15);
        gr.region[0] = getBits(bs, 4); gr.region[1] = getBits(bs, 3); gr.region[2] = 255;
      }
      gr.tableSelect[0] = tables >> 10; gr.tableSelect[1] = (tables >> 5) & 31; gr.tableSelect[2] = tables & 31;
      gr.preflag = mpeg1 ? getBits(bs, 1) : (gr.scalefacCompress >= 500 ? 1 : 0);
      gr.scalefacScale = getBits(bs, 1);
      gr.count1Table = getBits(bs, 1);
      gr.scfsi = (scfsi >> 12) & 15;
      scfsi <<= 4;
    } while (--grCount);
    if (part23sum + bs.pos > bs.limit + mainDataBegin * 8) return -1;
    return mainDataBegin;
  }

  /** scf/istPos get the scale factors of the partitions in part[partOff..] (counts, 0 ends), each scfSize[i] bits wide */
  function readScalefactors(scf, istPos, istOff, scfSize, part, partOff, bs, scfsi) {
    let sOff = 0;
    for (let i = 0; i < 4 && part[partOff + i]; i++, scfsi *= 2) {
      const cnt = part[partOff + i];
      if (scfsi & 8) {
        for (let k = 0; k < cnt; k++) scf[sOff + k] = istPos[istOff + k];
      } else {
        const bits = scfSize[i];
        if (!bits) {
          for (let k = 0; k < cnt; k++) { scf[sOff + k] = 0; istPos[istOff + k] = 0; }
        } else {
          const maxScf = (scfsi < 0) ? (1 << bits) - 1 : -1;
          for (let k = 0; k < cnt; k++) {
            const s = getBits(bs, bits);
            istPos[istOff + k] = (s === maxScf ? -1 : s);
            scf[sOff + k] = s;
          }
        }
      }
      istOff += cnt; sOff += cnt;
    }
    scf[sOff] = scf[sOff + 1] = scf[sOff + 2] = 0;
  }

  /** y * 2^(-exp/4) for exp >= 0 */
  function ldexpQ2(y, exp) {
    let e;
    do { e = Math.min(120, exp); y *= T.expfrac[e & 3] * ((1 << 30) >> (e >> 2)); } while ((exp -= e) > 0);
    return y;
  }

  function decodeScalefactors(dec, istOff, bs, gr, ch) {
    const h = dec.header, iscf = dec.iscf, scfSize = dec.scfSize, scf = dec.scf;
    let partOff = ((gr.nShort ? 1 : 0) + (gr.nLong ? 0 : 1)) * 28;
    const scfShift = gr.scalefacScale + 1;
    let scfsi = gr.scfsi;
    if (isMpeg1(h, 0)) {
      const part = T.scfcDecode[gr.scalefacCompress];
      scfSize[1] = scfSize[0] = part >> 2;
      scfSize[3] = scfSize[2] = part & 3;
    } else {
      const ist = (isIntensity(h, 0) && ch) ? 1 : 0;
      let sfc = gr.scalefacCompress >> ist, k = ist * 3 * 4, modprod;
      for (; sfc >= 0; sfc -= modprod, k += 4) {
        modprod = 1;
        for (let i = 3; i >= 0; i--) { scfSize[i] = ((sfc / modprod) | 0) % T.mod[k + i]; modprod *= T.mod[k + i]; }
      }
      partOff += k;
      scfsi = -16;
    }
    readScalefactors(iscf, dec.istPos, istOff, scfSize, T.scfPartitions, partOff, bs, scfsi);
    if (gr.nShort) {
      const sh = 3 - scfShift;
      for (let i = 0; i < gr.nShort; i += 3) {
        iscf[gr.nLong + i] += gr.subgain[0] << sh;
        iscf[gr.nLong + i + 1] += gr.subgain[1] << sh;
        iscf[gr.nLong + i + 2] += gr.subgain[2] << sh;
      }
    } else if (gr.preflag) {
      for (let i = 0; i < 10; i++) iscf[11 + i] += T.preamp[i];
    }
    const gainExp = gr.globalGain - 4 - 210 - (isMs(h, 0) ? 2 : 0);
    const gain = ldexpQ2(1 << 11, 44 - gainExp);
    for (let i = 0; i < gr.nLong + gr.nShort; i++) scf[i] = ldexpQ2(gain, iscf[i] << scfShift);
  }

  // ------------------------------------------------------------------ Huffman decoding and requantisation
  function pow43(x) {
    let mult = 256;
    if (x < 129) return T.pow43[16 + x];
    if (x < 1024) { mult = 16; x <<= 3; }
    const sign = 2 * x & 64, frac = ((x & 63) - sign) / ((x & ~63) + sign);
    return T.pow43[16 + ((x + sign) >> 6)] * (1 + frac * ((4 / 3) + frac * (2 / 9))) * mult;
  }

  /** the quantised values of one granule/channel into dst[dOff..] (576 values), scaled by scf; leaves bs.pos at the end of its part */
  function huffman(dst, dOff, bs, gr, scf, limit) {
    const tabs = T.huffTabs, tab32 = T.huffTab32, tab33 = T.huffTab33, tabindex = T.huffIndex, linbitsT = T.linbits, p43 = T.pow43;
    const buf = bs.buf, sfb = gr.sfbtab;
    let one = 0, ireg = 0, bigVal = gr.bigValues, sfbI = 0, scfI = 0, d = dOff;
    let next = bs.pos >> 3;
    let cache = ((buf[next] << 24) | (buf[next + 1] << 16) | (buf[next + 2] << 8) | buf[next + 3]) << (bs.pos & 7);
    let sh = (bs.pos & 7) - 8, np, pairs;
    next += 4;

    while (bigVal > 0) {
      const tabNum = gr.tableSelect[ireg];
      let sfbCnt = gr.region[ireg++];
      const cb = tabindex[tabNum], linbits = linbitsT[tabNum];
      do {
        np = sfb[sfbI++] >> 1;
        pairs = Math.min(bigVal, np);
        one = scf[scfI++];
        do {
          let w = 5, leaf = tabs[cb + (cache >>> 27)];
          while (leaf < 0) {
            cache <<= w; sh += w;
            w = leaf & 7;
            leaf = tabs[cb + (cache >>> (32 - w)) - (leaf >> 3)];
          }
          cache <<= leaf >> 8; sh += leaf >> 8;
          for (let j = 0; j < 2; j++, d++, leaf >>= 4) {
            let lsb = leaf & 15;
            if (linbits && lsb === 15) {
              lsb += cache >>> (32 - linbits);
              cache <<= linbits; sh += linbits;
              while (sh >= 0) { cache |= buf[next++] << sh; sh -= 8; }
              dst[d] = one * pow43(lsb) * (cache < 0 ? -1 : 1);
            } else {
              dst[d] = p43[16 + lsb - 16 * (cache >>> 31)] * one;
            }
            if (lsb) { cache <<= 1; sh += 1; }
          }
          while (sh >= 0) { cache |= buf[next++] << sh; sh -= 8; }
        } while (--pairs);
      } while ((bigVal -= np) > 0 && --sfbCnt >= 0);
    }

    const count1 = gr.count1Table ? tab33 : tab32;
    for (np = 1 - bigVal; ; d += 4) {
      let leaf = count1[cache >>> 28];
      if (!(leaf & 8)) leaf = count1[(leaf >> 3) + ((cache << 4) >>> (32 - (leaf & 3)))];
      cache <<= leaf & 7; sh += leaf & 7;
      if (next * 8 - 24 + sh > limit) break;
      if (!--np) { np = sfb[sfbI++] >> 1; if (!np) break; one = scf[scfI++]; }
      if (leaf & 128) { dst[d] = cache < 0 ? -one : one; cache <<= 1; sh += 1; }
      if (leaf & 64) { dst[d + 1] = cache < 0 ? -one : one; cache <<= 1; sh += 1; }
      if (!--np) { np = sfb[sfbI++] >> 1; if (!np) break; one = scf[scfI++]; }
      if (leaf & 32) { dst[d + 2] = cache < 0 ? -one : one; cache <<= 1; sh += 1; }
      if (leaf & 16) { dst[d + 3] = cache < 0 ? -one : one; cache <<= 1; sh += 1; }
      while (sh >= 0) { cache |= buf[next++] << sh; sh -= 8; }
    }
    bs.pos = limit;
  }

  // ------------------------------------------------------------------ stereo
  function midSide(g, left, n) {
    for (let i = 0; i < n; i++) { const a = g[left + i], b = g[left + 576 + i]; g[left + i] = a + b; g[left + 576 + i] = a - b; }
  }
  function intensityBand(g, left, n, kl, kr) {
    for (let i = 0; i < n; i++) { g[left + 576 + i] = g[left + i] * kr; g[left + i] = g[left + i] * kl; }
  }
  function stereoTopBand(g, right, sfb, nbands, maxBand) {
    maxBand[0] = maxBand[1] = maxBand[2] = -1;
    for (let i = 0; i < nbands; i++) {
      for (let k = 0; k < sfb[i]; k += 2) {
        if (g[right + k] !== 0 || g[right + k + 1] !== 0) { maxBand[i % 3] = i; break; }
      }
      right += sfb[i];
    }
  }
  function stereoProcess(g, left, ist, istOff, sfb, h, maxBand, mpeg2sh) {
    const mpeg1 = isMpeg1(h, 0), maxPos = mpeg1 ? 7 : 64;
    for (let i = 0; sfb[i]; i++) {
      const ipos = ist[istOff + i];
      if (i > maxBand[i % 3] && ipos < maxPos) {
        const s = hasMsFlag(h, 0) ? 1.41421356 : 1;
        let kl, kr;
        if (mpeg1) { kl = T.pan[2 * ipos]; kr = T.pan[2 * ipos + 1]; }
        else {
          kl = 1; kr = ldexpQ2(1, ((ipos + 1) >> 1) << mpeg2sh);
          if (ipos & 1) { kl = kr; kr = 1; }
        }
        intensityBand(g, left, sfb[i], kl * s, kr * s);
      } else if (hasMsFlag(h, 0)) midSide(g, left, sfb[i]);
      left += sfb[i];
    }
  }
  function intensityStereo(dec, gi) {
    const g = dec.grbuf, grs = dec.gr, gr = grs[gi], h = dec.header, maxBand = dec.maxBand, ist = dec.istPos;
    const nSfb = gr.nLong + gr.nShort, maxBlocks = gr.nShort ? 3 : 1;
    stereoTopBand(g, 576, gr.sfbtab, nSfb, maxBand);
    if (gr.nLong) maxBand[0] = maxBand[1] = maxBand[2] = Math.max(Math.max(maxBand[0], maxBand[1]), maxBand[2]);
    for (let i = 0; i < maxBlocks; i++) {
      const defaultPos = isMpeg1(h, 0) ? 3 : 0, itop = nSfb - maxBlocks + i, prev = itop - maxBlocks;
      ist[39 + itop] = maxBand[i] >= prev ? defaultPos : ist[39 + prev];
    }
    stereoProcess(g, 0, ist, 39, gr.sfbtab, h, maxBand, grs[gi + 1].scalefacCompress & 1);
  }

  // ------------------------------------------------------------------ reorder, alias reduction, IMDCT
  function reorder(g, goff, scratch, sfb, so) {
    let src = goff, dst = 0, len;
    for (; 0 !== (len = sfb[so]); so += 3, src += 2 * len) {
      for (let i = 0; i < len; i++, src++) { scratch[dst++] = g[src]; scratch[dst++] = g[src + len]; scratch[dst++] = g[src + 2 * len]; }
    }
    for (let i = 0; i < dst; i++) g[goff + i] = scratch[i];
  }
  function antialias(g, off, nbands) {
    const aa = T.aa;
    for (; nbands > 0; nbands--, off += 18) {
      for (let i = 0; i < 8; i++) {
        const u = g[off + 18 + i], d = g[off + 17 - i];
        g[off + 18 + i] = u * aa[i] - d * aa[8 + i];
        g[off + 17 - i] = u * aa[8 + i] + d * aa[i];
      }
    }
  }
  function dct3_9(y) {
    let s0 = y[0], s2 = y[2], s4 = y[4], s6 = y[6], s8 = y[8];
    let t0 = s0 + s6 * 0.5;
    s0 -= s6;
    let t4 = (s4 + s2) * 0.93969262, t2 = (s8 + s2) * 0.76604444;
    s6 = (s4 - s8) * 0.17364818;
    s4 += s8 - s2;
    s2 = s0 - s4 * 0.5;
    y[4] = s4 + s0;
    s8 = t0 - t2 + s6;
    s0 = t0 - t4 + t2;
    s4 = t0 + t4 - s6;
    let s1 = y[1], s3 = y[3], s5 = y[5], s7 = y[7];
    s3 *= 0.86602540;
    t0 = (s5 + s1) * 0.98480775;
    t4 = (s5 - s7) * 0.34202014;
    t2 = (s1 + s7) * 0.64278761;
    s1 = (s1 - s5 - s7) * 0.86602540;
    s5 = t0 - s3 - t2;
    s7 = t4 - s3 - t0;
    s3 = t4 + s3 - t2;
    y[0] = s4 - s7; y[1] = s2 + s1; y[2] = s0 - s3; y[3] = s8 + s5;
    y[5] = s8 - s5; y[6] = s0 + s3; y[7] = s2 - s1; y[8] = s4 + s7;
  }
  const CO = new Float64Array(9), SI = new Float64Array(9);
  function imdct36(g, goff, ov, ooff, woff, nbands) {
    const tw = T.twid9, win = T.mdctWindow;
    for (let j = 0; j < nbands; j++, goff += 18, ooff += 9) {
      CO[0] = -g[goff]; SI[0] = g[goff + 17];
      for (let i = 0; i < 4; i++) {
        SI[8 - 2 * i] = g[goff + 4 * i + 1] - g[goff + 4 * i + 2];
        CO[1 + 2 * i] = g[goff + 4 * i + 1] + g[goff + 4 * i + 2];
        SI[7 - 2 * i] = g[goff + 4 * i + 4] - g[goff + 4 * i + 3];
        CO[2 + 2 * i] = -(g[goff + 4 * i + 3] + g[goff + 4 * i + 4]);
      }
      dct3_9(CO); dct3_9(SI);
      SI[1] = -SI[1]; SI[3] = -SI[3]; SI[5] = -SI[5]; SI[7] = -SI[7];
      for (let i = 0; i < 9; i++) {
        const ovl = ov[ooff + i], sum = CO[i] * tw[9 + i] + SI[i] * tw[i];
        ov[ooff + i] = CO[i] * tw[i] - SI[i] * tw[9 + i];
        g[goff + i] = ovl * win[woff + i] - sum * win[woff + 9 + i];
        g[goff + 17 - i] = ovl * win[woff + 9 + i] + sum * win[woff + i];
      }
    }
  }
  const CO3 = new Float64Array(3), SI3 = new Float64Array(3), TMP18 = new Float64Array(18);
  function idct3(x0, x1, x2, dst) {
    const m1 = x1 * 0.86602540, a1 = x0 - x2 * 0.5;
    dst[1] = x0 + x2; dst[0] = a1 + m1; dst[2] = a1 - m1;
  }
  function imdct12(x, xo, dst, d, ov, o) {
    const tw = T.twid3;
    idct3(-x[xo], x[xo + 6] + x[xo + 3], x[xo + 12] + x[xo + 9], CO3);
    idct3(x[xo + 15], x[xo + 12] - x[xo + 9], x[xo + 6] - x[xo + 3], SI3);
    SI3[1] = -SI3[1];
    for (let i = 0; i < 3; i++) {
      const ovl = ov[o + i], sum = CO3[i] * tw[3 + i] + SI3[i] * tw[i];
      ov[o + i] = CO3[i] * tw[i] - SI3[i] * tw[3 + i];
      dst[d + i] = ovl * tw[2 - i] - sum * tw[5 - i];
      dst[d + 5 - i] = ovl * tw[5 - i] + sum * tw[2 - i];
    }
  }
  function imdctShort(g, goff, ov, ooff, nbands) {
    for (; nbands > 0; nbands--, ooff += 9, goff += 18) {
      for (let i = 0; i < 18; i++) TMP18[i] = g[goff + i];
      for (let i = 0; i < 6; i++) g[goff + i] = ov[ooff + i];
      imdct12(TMP18, 0, g, goff + 6, ov, ooff + 6);
      imdct12(TMP18, 1, g, goff + 12, ov, ooff + 6);
      imdct12(TMP18, 2, ov, ooff, ov, ooff + 6);
    }
  }
  function changeSign(g, off) {
    for (let b = 0, o = off + 18; b < 32; b += 2, o += 36) for (let i = 1; i < 18; i += 2) g[o + i] = -g[o + i];
  }
  function imdctGr(g, goff, ov, blockType, nLongBands) {
    let ooff = 0;
    if (nLongBands) { imdct36(g, goff, ov, 0, 0, nLongBands); goff += 18 * nLongBands; ooff += 9 * nLongBands; }
    if (blockType === 2) imdctShort(g, goff, ov, ooff, 32 - nLongBands);
    else imdct36(g, goff, ov, ooff, blockType === 3 ? 18 : 0, 32 - nLongBands);
  }

  // ------------------------------------------------------------------ one granule: scale factors, Huffman, stereo, IMDCT
  function l3Decode(dec, gBase, nch) {
    const h = dec.header, g = dec.grbuf, bs = dec.bs;
    for (let ch = 0; ch < nch; ch++) {
      const gr = dec.gr[gBase + ch], limit = bs.pos + gr.part23;
      decodeScalefactors(dec, ch * 39, bs, gr, ch);
      huffman(g, ch * 576, bs, gr, dec.scf, limit);
    }
    if (nch === 2) {
      if (isIntensity(h, 0)) intensityStereo(dec, gBase);
      else if (isMs(h, 0)) midSide(g, 0, 576);
    }
    for (let ch = 0; ch < nch; ch++) {
      const gr = dec.gr[gBase + ch];
      let aaBands = 31;
      const nLongBands = (gr.mixed ? 2 : 0) << (mySampleRate(h, 0) === 2 ? 1 : 0);
      if (gr.nShort) {
        aaBands = nLongBands - 1;
        reorder(g, ch * 576 + nLongBands * 18, dec.syn, gr.sfbtab, gr.nLong);
      }
      antialias(g, ch * 576, aaBands);
      imdctGr(g, ch * 576, dec.mdct[ch], gr.blockType, nLongBands);
      changeSign(g, ch * 576);
    }
  }

  // ------------------------------------------------------------------ polyphase synthesis
  const TMP32 = new Float64Array(32);
  function dctII(g, off, n) {
    const t = TMP32, sec = T.sec;
    for (let k = 0; k < n; k++) {
      const y = off + k;
      for (let i = 0; i < 8; i++) {
        const x0 = g[y + i * 18], x1 = g[y + (15 - i) * 18], x2 = g[y + (16 + i) * 18], x3 = g[y + (31 - i) * 18];
        const t0 = x0 + x3, t1 = x1 + x2, t2 = (x1 - x2) * sec[3 * i], t3 = (x0 - x3) * sec[3 * i + 1];
        t[i] = t0 + t1;
        t[8 + i] = (t0 - t1) * sec[3 * i + 2];
        t[16 + i] = t3 + t2;
        t[24 + i] = (t3 - t2) * sec[3 * i + 2];
      }
      for (let i = 0, x = 0; i < 4; i++, x += 8) {
        let x0 = t[x], x1 = t[x + 1], x2 = t[x + 2], x3 = t[x + 3], x4 = t[x + 4], x5 = t[x + 5], x6 = t[x + 6], x7 = t[x + 7], xt;
        xt = x0 - x7; x0 += x7;
        x7 = x1 - x6; x1 += x6;
        x6 = x2 - x5; x2 += x5;
        x5 = x3 - x4; x3 += x4;
        x4 = x0 - x3; x0 += x3;
        x3 = x1 - x2; x1 += x2;
        t[x] = x0 + x1;
        t[x + 4] = (x0 - x1) * 0.70710677;
        x5 = x5 + x6;
        x6 = (x6 + x7) * 0.70710677;
        x7 = x7 + xt;
        x3 = (x3 + x4) * 0.70710677;
        x5 -= x7 * 0.198912367;                                       // rotate by PI/8
        x7 += x5 * 0.382683432;
        x5 -= x7 * 0.198912367;
        x0 = xt - x6; xt += x6;
        t[x + 1] = (xt + x7) * 0.50979561;
        t[x + 2] = (x4 + x3) * 0.54119611;
        t[x + 3] = (x0 - x5) * 0.60134488;
        t[x + 5] = (x0 + x5) * 0.89997619;
        t[x + 6] = (x4 - x3) * 1.30656302;
        t[x + 7] = (xt - x7) * 2.56291556;
      }
      let yy = y;
      for (let i = 0; i < 7; i++, yy += 72) {
        g[yy] = t[i];
        g[yy + 18] = t[16 + i] + t[24 + i] + t[25 + i];
        g[yy + 36] = t[8 + i] + t[9 + i];
        g[yy + 54] = t[17 + i] + t[24 + i] + t[25 + i];
      }
      g[yy] = t[7]; g[yy + 18] = t[23] + t[31]; g[yy + 36] = t[15]; g[yy + 54] = t[31];
    }
  }

  function scalePcm(x) {
    if (x >= 32766.5) return 32767;
    if (x <= -32767.5) return -32768;
    let s = (x + 0.5) | 0;
    if (s < 0) s -= 1;                                                // away from zero, to be compliant
    return s;
  }
  function synthPair(pcm, o, nch, z, zo) {
    let a = (z[zo + 896] - z[zo]) * 29;
    a += (z[zo + 64] + z[zo + 832]) * 213;
    a += (z[zo + 768] - z[zo + 128]) * 459;
    a += (z[zo + 192] + z[zo + 704]) * 2037;
    a += (z[zo + 640] - z[zo + 256]) * 5153;
    a += (z[zo + 320] + z[zo + 576]) * 6574;
    a += (z[zo + 512] - z[zo + 384]) * 37489;
    a += z[zo + 448] * 75038;
    pcm[o] = scalePcm(a);
    zo += 2;
    a = z[zo + 896] * 104;
    a += z[zo + 768] * 1567;
    a += z[zo + 640] * 9727;
    a += z[zo + 512] * 64019;
    a += z[zo + 384] * -9975;
    a += z[zo + 256] * -45;
    a += z[zo + 128] * 146;
    a += z[zo] * -5;
    pcm[o + 16 * nch] = scalePcm(a);
  }
  const A4 = new Float64Array(4), B4 = new Float64Array(4);
  const MODE = [0, 2, 1, 2, 1, 2, 1, 2];
  function synth(g, xl, nch, pcm, dl, lins, lo) {
    const xr = xl + 576 * (nch - 1), dr = dl + (nch - 1), zlin = lo + 15 * 64, win = T.win, a = A4, b = B4;
    lins[zlin + 60] = g[xl + 18 * 16]; lins[zlin + 61] = g[xr + 18 * 16]; lins[zlin + 62] = g[xl]; lins[zlin + 63] = g[xr];
    lins[zlin + 124] = g[xl + 1 + 18 * 16]; lins[zlin + 125] = g[xr + 1 + 18 * 16]; lins[zlin + 126] = g[xl + 1]; lins[zlin + 127] = g[xr + 1];
    synthPair(pcm, dr, nch, lins, lo + 61);
    synthPair(pcm, dr + 32 * nch, nch, lins, lo + 60 + 64 + 1);
    synthPair(pcm, dl, nch, lins, lo + 60);
    synthPair(pcm, dl + 32 * nch, nch, lins, lo + 60 + 64);
    let w = 0;
    for (let i = 14; i >= 0; i--) {
      const zi = zlin + 4 * i;
      lins[zi] = g[xl + 18 * (31 - i)];
      lins[zi + 1] = g[xr + 18 * (31 - i)];
      lins[zi + 2] = g[xl + 1 + 18 * (31 - i)];
      lins[zi + 3] = g[xr + 1 + 18 * (31 - i)];
      lins[zlin + 4 * (i + 16)] = g[xl + 1 + 18 * (1 + i)];
      lins[zlin + 4 * (i + 16) + 1] = g[xr + 1 + 18 * (1 + i)];
      lins[zlin + 4 * (i - 16) + 2] = g[xl + 18 * (1 + i)];
      lins[zlin + 4 * (i - 16) + 3] = g[xr + 18 * (1 + i)];
      for (let k = 0; k < 8; k++) {
        const w0 = win[w++], w1 = win[w++], vz = zi - k * 64, vy = zi - (15 - k) * 64, mode = MODE[k];
        for (let j = 0; j < 4; j++) {
          const z = lins[vz + j], y = lins[vy + j], bb = z * w1 + y * w0;
          if (k === 0) { b[j] = bb; a[j] = z * w0 - y * w1; }
          else if (mode === 1) { b[j] += bb; a[j] += z * w0 - y * w1; }
          else { b[j] += bb; a[j] += y * w1 - z * w0; }
        }
      }
      pcm[dr + (15 - i) * nch] = scalePcm(a[1]);
      pcm[dr + (17 + i) * nch] = scalePcm(b[1]);
      pcm[dl + (15 - i) * nch] = scalePcm(a[0]);
      pcm[dl + (17 + i) * nch] = scalePcm(b[0]);
      pcm[dr + (47 - i) * nch] = scalePcm(a[3]);
      pcm[dr + (49 + i) * nch] = scalePcm(b[3]);
      pcm[dl + (47 - i) * nch] = scalePcm(a[2]);
      pcm[dl + (49 + i) * nch] = scalePcm(b[2]);
    }
  }
  function synthGranule(dec, nbands, nch, pcm, po) {
    const g = dec.grbuf, lins = dec.syn, qmf = dec.qmf;
    for (let i = 0; i < nch; i++) dctII(g, 576 * i, nbands);
    lins.set(qmf);
    lins.fill(0, 960, 960 + 64 * nbands);
    for (let i = 0; i < nbands; i += 2) synth(g, i, nch, pcm, po + 32 * nch * i, lins, i * 64);
    if (nch === 1) { for (let i = 0; i < 960; i += 2) qmf[i] = lins[nbands * 64 + i]; }
    else qmf.set(lins.subarray(nbands * 64, nbands * 64 + 960));
  }

  // ------------------------------------------------------------------ bit reservoir and the frame
  function saveReservoir(dec) {
    let pos = (dec.bs.pos + 7) >> 3, remains = (dec.bs.limit >> 3) - pos;
    if (remains > 511) { pos += remains - 511; remains = 511; }
    if (remains > 0) dec.reservBuf.set(dec.maindata.subarray(pos, pos + remains));
    dec.reserv = remains > 0 ? remains : 0;
  }
  function restoreReservoir(dec, bs, mainDataBegin) {
    const frameBytes = (bs.limit - bs.pos) >> 3, have = Math.min(dec.reserv, mainDataBegin);
    const from = Math.max(0, dec.reserv - mainDataBegin);
    dec.maindata.set(dec.reservBuf.subarray(from, from + have));
    dec.maindata.set(bs.buf.subarray(bs.pos >> 3, (bs.pos >> 3) + frameBytes), have);
    dec.bs.buf = dec.maindata; dec.bs.pos = 0; dec.bs.limit = (have + frameBytes) * 8;
    return dec.reserv >= mainDataBegin;
  }

  /** decodes the frame at b[off .. off+size) into pcm[po..]; returns the sample frames made, 0 when the frame could not be decoded */
  function decodeFrame(dec, b, off, size, pcm, po) {
    const hdr = dec.header;
    hdr[0] = b[off]; hdr[1] = b[off + 1]; hdr[2] = b[off + 2]; hdr[3] = b[off + 3];
    const nch = isMono(hdr, 0) ? 1 : 2, bs = dec.bsFrame;
    bs.buf = b.subarray(off + 4, off + size); bs.pos = 0; bs.limit = (size - 4) * 8;
    if (isCrc(hdr, 0)) getBits(bs, 16);
    dec.istPos.fill(0);
    const mainDataBegin = readSideInfo(bs, dec.gr, hdr);
    if (mainDataBegin < 0 || bs.pos > bs.limit) { dec.reserv = 0; return 0; }
    const ok = restoreReservoir(dec, bs, mainDataBegin);
    if (ok) {
      for (let igr = 0, n = isMpeg1(hdr, 0) ? 2 : 1; igr < n; igr++, po += 576 * nch) {
        dec.grbuf.fill(0);
        l3Decode(dec, igr * nch, nch);
        synthGranule(dec, 18, nch, pcm, po);
      }
    }
    saveReservoir(dec);
    return ok ? frameSamples(hdr, 0) : 0;
  }

  // ------------------------------------------------------------------ finding the frames of a file
  const isTag = (b, o, tag) => b[o] === tag.charCodeAt(0) && b[o + 1] === tag.charCodeAt(1) && b[o + 2] === tag.charCodeAt(2) && b[o + 3] === tag.charCodeAt(3);
  /** a frame that only carries the encoder's "Xing"/"Info"/"VBRI" description, no sound */
  function isInfoFrame(b, o) {
    const side = isMpeg1(b, o) ? (isMono(b, o) ? 17 : 32) : (isMono(b, o) ? 9 : 17), at = o + 4 + (isCrc(b, o) ? 2 : 0) + side;
    return isTag(b, at, 'Xing') || isTag(b, at, 'Info') || isTag(b, o + 4 + 32, 'VBRI');
  }
  /** list of {off, size} of the audio frames; null if the file holds no usable Layer III stream */
  function scanFrames(b) {
    let o = 0;
    if (b.length > 10 && b[0] === 0x49 && b[1] === 0x44 && b[2] === 0x33 && b[3] < 0xff && b[4] < 0xff && ((b[6] | b[7] | b[8] | b[9]) & 0x80) === 0) {
      o = 10 + ((b[6] << 21) | (b[7] << 14) | (b[8] << 7) | b[9]) + ((b[5] & 0x10) ? 10 : 0);
    }
    const len = b.length, size = p => frameBytes(b, p) + padding(b, p);
    // the first frame: a header whose following headers match, so a stray 0xFF in the data is not taken for one
    let first = -1;
    for (let p = o; p + 4 <= len && first < 0; p++) {
      if (b[p] !== 0xff || !hdrValid(b, p) || layerBits(b, p) !== 1 || isFreeFormat(b, p)) continue;
      let q = p, n = 0;
      while (n < 4) {
        const fs = size(q);
        if (fs <= 4 || q + fs > len) break;
        q += fs; n++;
        if (q + 4 > len || !hdrCompare(b, p, b, q)) break;
      }
      if (n >= 3 || (n >= 1 && q + 4 > len) || (n >= 1 && q + 128 >= len)) first = p;
    }
    if (first < 0) return null;
    const out = [];
    let p = first;
    while (p + 4 <= len) {
      if (!hdrCompare(b, first, b, p)) {                                // damaged or trailing data: look for the next frame like the first
        let q = p + 1;
        while (q + 4 <= len && !(b[q] === 0xff && hdrCompare(b, first, b, q))) q++;
        if (q + 4 > len) break;
        p = q; continue;
      }
      const fs = size(p);
      if (fs <= 4 || p + fs > len) break;
      if (!(out.length === 0 && isInfoFrame(b, p))) out.push({ off: p, size: fs });
      p += fs;
    }
    return out.length ? { first, frames: out } : null;
  }

  /** bytes of an MP3 file -> lazily decoded sound (see the top of the file) */
  function mp3Decode(bytes) {
    const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const found = scanFrames(b);
    if (!found) return null;
    const h0 = found.first, nch = isMono(b, h0) ? 1 : 2, spf = frameSamples(b, h0), rate = sampleRateHz(b, h0);
    const list = found.frames, total = list.length * spf, pcm = new Int16Array(total * nch), dec = newDecoder();
    let next = 0;
    function ensure(upTo) {
      const need = Math.min(list.length, Math.ceil(upTo / spf));
      for (; next < need; next++) {
        const f = list[next];
        if ((isMono(b, f.off) ? 1 : 2) !== nch) continue;                  // a stream that changes between mono and stereo: those frames stay silent
        try { decodeFrame(dec, b, f.off, f.size, pcm, next * spf * nch); }
        catch (e) { dec.reserv = 0; }                                     // a damaged frame stays silent
      }
    }
    return { rate, ch: nch, frames: total, pcm, ensure, done: () => next >= list.length, layer: 3, frameCount: list.length, bitrate: bitrateKbps(b, h0) };
  }

  EMU.mp3Decode = mp3Decode;
  EMU.mp3Scan = scanFrames;
  if (typeof module !== 'undefined' && module.exports) module.exports = mp3Decode;
})(typeof globalThis !== 'undefined' ? globalThis : this);
