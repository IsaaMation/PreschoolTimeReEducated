/* RIFF/WAVE reader and decoder: PCM (8/16 bit), IMA ADPCM (format 0x11, what nearly all of the game's sounds are) and MS ADPCM (format 2).
 *   EMU.wavInfo(bytes)   -> {format, ch, rate, bits, blockAlign, samplesPerBlock, dataOff, dataLen, factSamples, samples} | null
 *   EMU.wavDecode(bytes) -> {rate, ch, frames, pcm: Int16Array (interleaved)} | null
 *   EMU.wavBuild(rate, ch, pcm) -> Uint8Array: a 16 bit PCM RIFF/WAVE image
 */
(function (G) {
  'use strict';
  const EMU = G.EMU = G.EMU || {};

  const STEP = [7, 8, 9, 10, 11, 12, 13, 14, 16, 17, 19, 21, 23, 25, 28, 31, 34, 37, 41, 45, 50, 55, 60, 66, 73, 80, 88, 97, 107, 118, 130, 143, 157, 173, 190, 209, 230, 253, 279, 307, 337, 371, 408, 449, 494, 544, 598, 658, 724, 796, 876, 963, 1060, 1166, 1282, 1411, 1552, 1707, 1878, 2066, 2272, 2499, 2749, 3024, 3327, 3660, 4026, 4428, 4871, 5358, 5894, 6484, 7132, 7845, 8630, 9493, 10442, 11487, 12635, 13899, 15289, 16818, 18500, 20350, 22385, 24623, 27086, 29794, 32767];
  const IDX = [-1, -1, -1, -1, 2, 4, 6, 8, -1, -1, -1, -1, 2, 4, 6, 8];
  const MSC1 = [256, 512, 0, 192, 240, 460, 392], MSC2 = [0, -256, 0, 64, 0, -208, -232];

  function wavInfo(b) {
    if (!b || b.length < 20 || b[0] !== 0x52 || b[1] !== 0x49 || b[2] !== 0x46 || b[3] !== 0x46 || b[8] !== 0x57 || b[9] !== 0x41 || b[10] !== 0x56 || b[11] !== 0x45) return null;
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    let i = 12, fmt = null, dataOff = -1, dataLen = 0, fact = -1;
    while (i + 8 <= b.length) {
      const id = String.fromCharCode(b[i], b[i + 1], b[i + 2], b[i + 3]); let sz = dv.getUint32(i + 4, true);
      const body = i + 8;
      if (id === 'fmt ' && body + 16 <= b.length) {
        fmt = { format: dv.getUint16(body, true), ch: dv.getUint16(body + 2, true), rate: dv.getUint32(body + 4, true), bytesPerSec: dv.getUint32(body + 8, true), blockAlign: dv.getUint16(body + 12, true), bits: dv.getUint16(body + 14, true), samplesPerBlock: 0 };
        if (sz >= 20 && body + 20 <= b.length && (fmt.format === 0x11 || fmt.format === 2)) fmt.samplesPerBlock = dv.getUint16(body + 18, true);
        if (fmt.format === 0xFFFE && sz >= 40 && body + 26 <= b.length) fmt.format = dv.getUint16(body + 24, true);
      } else if (id === 'fact' && sz >= 4) fact = dv.getUint32(body, true);
      else if (id === 'data') { dataOff = body; if (body + sz > b.length) sz = b.length - body; dataLen = sz; break; }
      i = body + sz + (sz & 1);
    }
    if (!fmt || dataOff < 0) return null;
    if (fmt.format === 0x11 && !fmt.samplesPerBlock) fmt.samplesPerBlock = (fmt.blockAlign - 4 * fmt.ch) * 8 / (4 * fmt.ch) + 1;
    if (fmt.format === 2 && !fmt.samplesPerBlock) fmt.samplesPerBlock = (fmt.blockAlign - 7 * fmt.ch) * 2 / fmt.ch + 2;
    let samples;
    if (fmt.format === 1) samples = Math.floor(dataLen / Math.max(1, fmt.ch * (fmt.bits >> 3)));
    else {
      const full = Math.floor(dataLen / fmt.blockAlign), rest = dataLen - full * fmt.blockAlign;
      samples = full * fmt.samplesPerBlock;
      if (rest > 4 * fmt.ch) samples += (fmt.format === 0x11) ? 1 + Math.floor((rest - 4 * fmt.ch) * 2 / fmt.ch) : 2 + Math.floor((rest - 7 * fmt.ch) * 2 / fmt.ch);
    }
    if (fact >= 0 && fact < samples && fmt.format !== 1) samples = fact;
    return Object.assign(fmt, { dataOff, dataLen, factSamples: fact, samples });
  }

  function decodeIma(b, info) {
    const { ch, blockAlign, samplesPerBlock, dataOff, dataLen, samples } = info;
    const out = new Int16Array(samples * ch);
    const pred = new Int32Array(ch), idx = new Int32Array(ch);
    let o = 0;
    for (let off = 0; off < dataLen && o < samples * ch; off += blockAlign) {
      const end = Math.min(off + blockAlign, dataLen), base = dataOff + off;
      if (end - off < 4 * ch) break;
      for (let c = 0; c < ch; c++) { pred[c] = (b[base + 4 * c] | (b[base + 4 * c + 1] << 8)) << 16 >> 16; idx[c] = Math.min(88, b[base + 4 * c + 2]); }
      const bo = o / ch;
      for (let c = 0; c < ch; c++) out[(bo) * ch + c] = pred[c];
      let n = 1; const maxN = Math.min(samplesPerBlock, samples - bo);
      let p = base + 4 * ch;
      // groups of 4 bytes (8 samples) per channel, interleaved by channel
      while (n < maxN && p + 4 * ch <= base + (end - off)) {
        for (let c = 0; c < ch; c++) {
          let pr = pred[c], ix = idx[c];
          for (let k = 0; k < 4; k++) {
            const byte = b[p + c * 4 + k];
            for (let h = 0; h < 2; h++) {
              const nib = h ? byte >> 4 : byte & 15, step = STEP[ix];
              let d = step >> 3; if (nib & 1) d += step >> 2; if (nib & 2) d += step >> 1; if (nib & 4) d += step; if (nib & 8) d = -d;
              pr += d; pr = pr > 32767 ? 32767 : pr < -32768 ? -32768 : pr;
              ix += IDX[nib]; ix = ix < 0 ? 0 : ix > 88 ? 88 : ix;
              const sn = n + k * 2 + h;
              if (sn < maxN) out[(bo + sn) * ch + c] = pr;
            }
          }
          pred[c] = pr; idx[c] = ix;
        }
        p += 4 * ch; n += 8;
      }
      o += Math.min(maxN, samplesPerBlock) * ch;
    }
    return out;
  }

  function decodeMs(b, info) {
    const { ch, blockAlign, samplesPerBlock, dataOff, dataLen, samples } = info;
    const out = new Int16Array(samples * ch);
    const clamp = v => v > 32767 ? 32767 : v < -32768 ? -32768 : v;
    let o = 0;
    for (let off = 0; off + 7 * ch <= dataLen && o < samples * ch; off += blockAlign) {
      const base = dataOff + off, end = Math.min(off + blockAlign, dataLen) + dataOff;
      let p = base;
      const bp = [], delta = [], s1 = [], s2 = [];
      for (let c = 0; c < ch; c++) bp.push(Math.min(6, b[p++]));
      for (let c = 0; c < ch; c++) { delta.push((b[p] | (b[p + 1] << 8)) << 16 >> 16); p += 2; }
      for (let c = 0; c < ch; c++) { s1.push((b[p] | (b[p + 1] << 8)) << 16 >> 16); p += 2; }
      for (let c = 0; c < ch; c++) { s2.push((b[p] | (b[p + 1] << 8)) << 16 >> 16); p += 2; }
      const bo = o / ch, maxN = Math.min(samplesPerBlock, samples - bo);
      for (let c = 0; c < ch; c++) { out[bo * ch + c] = s2[c]; if (maxN > 1) out[(bo + 1) * ch + c] = s1[c]; }
      let n = 2, c = 0, hi = true;
      while (n < maxN && p < end) {
        const nib = hi ? b[p] >> 4 : b[p] & 15; if (!hi) p++; hi = !hi;
        const snib = nib & 8 ? nib - 16 : nib;
        let pr = (s1[c] * MSC1[bp[c]] + s2[c] * MSC2[bp[c]]) >> 8; pr = clamp(pr + snib * delta[c]);
        s2[c] = s1[c]; s1[c] = pr;
        delta[c] = Math.max(16, (delta[c] * [230, 230, 230, 230, 307, 409, 512, 614, 768, 614, 512, 409, 307, 230, 230, 230][nib]) >> 8);
        out[(bo + n) * ch + c] = pr;
        if (++c === ch) { c = 0; n++; }
      }
      o += maxN * ch;
    }
    return out;
  }

  function wavDecode(b) {
    const info = wavInfo(b); if (!info) return null;
    let pcm;
    if (info.format === 1) {
      const n = info.samples * info.ch; pcm = new Int16Array(n);
      if (info.bits === 16) { const dv = new DataView(b.buffer, b.byteOffset + info.dataOff, n * 2); for (let i = 0; i < n; i++) pcm[i] = dv.getInt16(i * 2, true); }
      else if (info.bits === 8) { for (let i = 0; i < n; i++) pcm[i] = (b[info.dataOff + i] - 128) << 8; }
      else return null;
    } else if (info.format === 0x11) pcm = decodeIma(b, info);
    else if (info.format === 2) pcm = decodeMs(b, info);
    else return null;
    return { rate: info.rate, ch: info.ch, frames: pcm.length / info.ch, pcm, info };
  }

  function wavBuild(rate, ch, pcm) {
    const n = pcm.length * 2, out = new Uint8Array(44 + n), dv = new DataView(out.buffer);
    out.set([0x52, 0x49, 0x46, 0x46], 0); dv.setUint32(4, 36 + n, true); out.set([0x57, 0x41, 0x56, 0x45, 0x66, 0x6D, 0x74, 0x20], 8);
    dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, ch, true); dv.setUint32(24, rate, true); dv.setUint32(28, rate * ch * 2, true); dv.setUint16(32, ch * 2, true); dv.setUint16(34, 16, true);
    out.set([0x64, 0x61, 0x74, 0x61], 36); dv.setUint32(40, n, true);
    for (let i = 0; i < pcm.length; i++) dv.setInt16(44 + i * 2, pcm[i], true);
    return out;
  }
  EMU.wavInfo = wavInfo; EMU.wavDecode = wavDecode; EMU.wavBuild = wavBuild;
  EMU.wavDecodeRaw = (b, info) => info.format === 0x11 ? decodeIma(b, info) : decodeMs(b, info);
})(typeof globalThis !== 'undefined' ? globalThis : this);
