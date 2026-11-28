/* Minimal PE (32-bit) loader: maps sections into a flat memory image and reports imports. */
(function (G) {
  'use strict';
  const EMU = G.EMU = G.EMU || {};

  function cstr(u8, o) { let s = ''; while (u8[o]) s += String.fromCharCode(u8[o++]); return s; }

  /** returns {base, entry, sizeOfImage, sections:[{name,va,vsize,raw,rsize}], imports:[{dll, name|ord, iat (VA)}], resources: {rva,size}} */
  function parse(file) {
    const dv = new DataView(file.buffer, file.byteOffset, file.byteLength);
    if (dv.getUint16(0, true) !== 0x5A4D) throw new Error('not an MZ file');
    const pe = dv.getUint32(0x3c, true);
    if (dv.getUint32(pe, true) !== 0x4550) throw new Error('not a PE file');
    const nsec = dv.getUint16(pe + 6, true);
    const optSize = dv.getUint16(pe + 20, true);
    const opt = pe + 24;
    if (dv.getUint16(opt, true) !== 0x10b) throw new Error('not PE32');
    const info = {
      entry: dv.getUint32(opt + 16, true),
      base: dv.getUint32(opt + 28, true),
      sizeOfImage: dv.getUint32(opt + 56, true),
      sizeOfHeaders: dv.getUint32(opt + 60, true),
      stackReserve: dv.getUint32(opt + 72, true),
      sections: [], imports: [],
    };
    for (let i = 0; i < nsec; i++) {
      const o = opt + optSize + i * 40;
      let name = ''; for (let k = 0; k < 8 && file[o + k]; k++) name += String.fromCharCode(file[o + k]);
      info.sections.push({ name, vsize: dv.getUint32(o + 8, true), va: dv.getUint32(o + 12, true), rsize: dv.getUint32(o + 16, true), raw: dv.getUint32(o + 20, true) });
    }
    const dd = opt + 96;
    const impRva = dv.getUint32(dd + 8, true);
    const rsrc = { rva: dv.getUint32(dd + 16, true), size: dv.getUint32(dd + 20, true) };
    info.resources = rsrc;
    const rva2off = rva => {
      for (const s of info.sections) if (rva >= s.va && rva < s.va + Math.max(s.rsize, s.vsize)) return s.raw + rva - s.va;
      return rva;
    };
    info.rva2off = rva2off;
    if (impRva) {
      let o = rva2off(impRva);
      for (; ;) {
        const oft = dv.getUint32(o, true), nameRva = dv.getUint32(o + 12, true), ft = dv.getUint32(o + 16, true);
        if (!nameRva) break;
        const dll = cstr(file, rva2off(nameRva));
        let t = rva2off(oft || ft), k = 0;
        for (; ;) {
          const v = dv.getUint32(t + 4 * k, true);
          if (!v) break;
          const rec = { dll, iat: info.base + ft + 4 * k };
          if (v & 0x80000000) rec.ord = v & 0xffff; else rec.name = cstr(file, rva2off(v) + 2);
          info.imports.push(rec);
          k++;
        }
        o += 20;
      }
    }
    return info;
  }

  /** copy headers+sections into memory u8 (address = absolute VA) */
  function load(file, info, u8) {
    u8.set(file.subarray(0, info.sizeOfHeaders), info.base);
    for (const s of info.sections) {
      const n = Math.min(s.rsize, s.vsize || s.rsize);
      u8.set(file.subarray(s.raw, s.raw + n), info.base + s.va);
    }
  }

  EMU.PE = { parse, load };
})(typeof globalThis !== 'undefined' ? globalThis : this);
