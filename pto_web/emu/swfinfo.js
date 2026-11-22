/* Reads the header of a Flash movie (.swf): version, stage size, frame rate and number of frames.
 *
 *   EMU.swfInfo(bytes)  ->  { version, compressed, length, width, height, fps, frames }  or null if it is not a movie we can read
 *
 * `bytes` only needs to hold the first few hundred bytes of the file (the length is read from the header, not from `bytes`).
 * "FWS" movies are plain, "CWS" movies are zlib-compressed after the 8 byte start; "ZWS" (LZMA, Flash 13 and later) is not read.
 * The layout is the one in Adobe's published SWF file format specification.
 */
(function (G) {
  'use strict';
  const EMU = G.EMU = G.EMU || {};

  EMU.swfInfo = function (b) {
    if (!b || b.length < 12) return null;
    const c0 = b[0];
    if ((c0 !== 0x46 && c0 !== 0x43 && c0 !== 0x5a) || b[1] !== 0x57 || b[2] !== 0x53) return null;     // F/C/Z + "WS"
    const compressed = c0 === 0x43, version = b[3];
    const length = (b[4] | b[5] << 8 | b[6] << 16 | b[7] << 24) >>> 0;
    let body;
    if (c0 === 0x46) body = b.subarray(8, Math.min(b.length, 8 + 64));
    else if (compressed) {
      if (!EMU.Inflater) return null;
      const inf = new EMU.Inflater(Math.max(64, length - 8));
      inf.push(b.subarray(10, Math.min(b.length, 10 + 8192)));            // 2 bytes of zlib header, then the deflate data
      inf.run(64);
      body = inf.out.subarray(0, Math.min(64, inf.outPos));
    } else return null;
    if (body.length < 8) return null;
    const nbits = body[0] >> 3;
    if (nbits < 1 || nbits > 31) return null;
    let bit = 5;
    const read = () => {                                                  // one signed value of nbits bits
      let v = 0;
      for (let i = 0; i < nbits; i++, bit++) v = (v << 1) | ((body[bit >> 3] >> (7 - (bit & 7))) & 1);
      return nbits < 32 && (v & (1 << (nbits - 1))) ? v - 2 ** nbits : v;
    };
    const xmin = read(), xmax = read(), ymin = read(), ymax = read();
    const o = (bit + 7) >> 3;
    if (o + 4 > body.length) return null;
    const fps = (body[o] | body[o + 1] << 8) / 256;
    const frames = body[o + 2] | body[o + 3] << 8;
    return { version, compressed, length, width: (xmax - xmin) / 20, height: (ymax - ymin) / 20, fps, frames };
  };
  if (typeof module !== 'undefined') module.exports = { swfInfo: EMU.swfInfo };
})(typeof globalThis !== 'undefined' ? globalThis : this);
