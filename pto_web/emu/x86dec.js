/* x86-32 instruction decoder (the subset produced by MSVC 4-6 era compilers, plus x87).
 *
 *   const ins = EMU.decode(U8, addr)
 *   ins = { a: address, len, op, sz (operand size 8|16|32), d, s, s2, cc, t, rep, seg, ... }
 *   operands: {k:'r', n, sz} | {k:'m', base, idx, sc, disp, seg, sz} | {k:'i', v}
 */
(function (G) {
  'use strict';
  const EMU = G.EMU = G.EMU || {};

  const ALU = ['add', 'or', 'adc', 'sbb', 'and', 'sub', 'xor', 'cmp'];
  const SHIFT = ['rol', 'ror', 'rcl', 'rcr', 'shl', 'shr', 'shl', 'sar'];

  function s8(v) { return (v << 24) >> 24; }
  function s16(v) { return (v << 16) >> 16; }

  class Bad extends Error { }

  function decode(U8, a0) {
    let a = a0;
    let opsz = 32, rep = 0, seg = null;
    for (; ;) {
      const b = U8[a];
      if (b === 0x66) { opsz = 16; a++; }
      else if (b === 0xF3) { rep = 1; a++; }
      else if (b === 0xF2) { rep = 2; a++; }
      else if (b === 0x64) { seg = 'fs'; a++; }
      else if (b === 0x65) { seg = 'gs'; a++; }
      else if (b === 0x2E || b === 0x36 || b === 0x3E || b === 0x26) { a++; }
      else if (b === 0xF0 || b === 0x67) { a++; }
      else break;
    }
    const ins = { a: a0, len: 0, op: '', sz: opsz, d: null, s: null, s2: null, cc: 0, t: 0, rep, seg };

    const u8 = () => U8[a++];
    const i8 = () => s8(U8[a++]);
    const u16 = () => { const v = U8[a] | (U8[a + 1] << 8); a += 2; return v; };
    const i32 = () => { const v = (U8[a] | (U8[a + 1] << 8) | (U8[a + 2] << 16) | (U8[a + 3] << 24)); a += 4; return v; };

    const reg = (n, sz) => ({ k: 'r', n, sz });
    const imm = v => ({ k: 'i', v });

    // ModRM: returns {reg, rm}; rm is a reg operand or a mem operand of size sz
    let mrReg = 0;
    function modrm(sz) {
      const m = u8();
      const mod = m >> 6, r = (m >> 3) & 7, rm = m & 7;
      mrReg = r;
      if (mod === 3) return reg(rm, sz);
      let base = rm, idx = -1, sc = 0, disp = 0;
      if (rm === 4) {
        const sib = u8();
        sc = sib >> 6; const ix = (sib >> 3) & 7; base = sib & 7;
        idx = ix === 4 ? -1 : ix;
        if (base === 5 && mod === 0) { base = -1; disp = i32(); }
      } else if (rm === 5 && mod === 0) { base = -1; disp = i32(); }
      if (mod === 1) disp = i8(); else if (mod === 2) disp = i32();
      return { k: 'm', base, idx, sc, disp, seg, sz };
    }
    const immv = sz => sz === 8 ? u8() : sz === 16 ? u16() : i32();

    const op = U8[a++];
    ins.sz = opsz;
    function done(name) { ins.op = name; ins.len = a - a0; return ins; }

    // ---- ALU 00-3F
    if (op < 0x40 && (op & 7) < 6) {
      const name = ALU[op >> 3];
      const form = op & 7;
      if (form === 0) { const e = modrm(8); ins.sz = 8; ins.d = e; ins.s = reg(mrReg, 8); }
      else if (form === 1) { const e = modrm(opsz); ins.d = e; ins.s = reg(mrReg, opsz); }
      else if (form === 2) { const e = modrm(8); ins.sz = 8; ins.d = reg(mrReg, 8); ins.s = e; }
      else if (form === 3) { const e = modrm(opsz); ins.d = reg(mrReg, opsz); ins.s = e; }
      else if (form === 4) { ins.sz = 8; ins.d = reg(0, 8); ins.s = imm(u8()); }
      else { ins.d = reg(0, opsz); ins.s = imm(immv(opsz)); }
      return done(name);
    }
    if (op >= 0x40 && op <= 0x4F) { ins.d = reg(op & 7, opsz); return done(op < 0x48 ? 'inc' : 'dec'); }
    if (op >= 0x50 && op <= 0x57) { ins.s = reg(op & 7, 32); return done('push'); }
    if (op >= 0x58 && op <= 0x5F) { ins.d = reg(op & 7, 32); return done('pop'); }
    if (op >= 0x70 && op <= 0x7F) { ins.cc = op & 15; const d = i8(); ins.t = (a + d) | 0; return done('jcc'); }
    if (op >= 0x91 && op <= 0x97) { ins.d = reg(0, opsz); ins.s = reg(op & 7, opsz); return done('xchg'); }
    if (op >= 0xB0 && op <= 0xB7) { ins.sz = 8; ins.d = reg(op & 7, 8); ins.s = imm(u8()); return done('mov'); }
    if (op >= 0xB8 && op <= 0xBF) { ins.d = reg(op & 7, opsz); ins.s = imm(immv(opsz)); return done('mov'); }

    switch (op) {
      case 0x0F: return decode0F();
      case 0x60: return done('pusha');
      case 0x61: return done('popa');
      case 0x68: ins.s = imm(i32()); return done('push');
      case 0x6A: ins.s = imm(i8()); return done('push');
      case 0x69: { const e = modrm(opsz); ins.d = reg(mrReg, opsz); ins.s = e; ins.s2 = imm(immv(opsz)); return done('imul3'); }
      case 0x6B: { const e = modrm(opsz); ins.d = reg(mrReg, opsz); ins.s = e; ins.s2 = imm(i8()); return done('imul3'); }
      case 0x80: case 0x82: { const e = modrm(8); ins.sz = 8; ins.d = e; ins.s = imm(u8()); return done(ALU[mrReg]); }
      case 0x81: { const e = modrm(opsz); ins.d = e; ins.s = imm(immv(opsz)); return done(ALU[mrReg]); }
      case 0x83: { const e = modrm(opsz); ins.d = e; ins.s = imm(i8()); return done(ALU[mrReg]); }
      case 0x84: { const e = modrm(8); ins.sz = 8; ins.d = e; ins.s = reg(mrReg, 8); return done('test'); }
      case 0x85: { const e = modrm(opsz); ins.d = e; ins.s = reg(mrReg, opsz); return done('test'); }
      case 0x86: { const e = modrm(8); ins.sz = 8; ins.d = e; ins.s = reg(mrReg, 8); return done('xchg'); }
      case 0x87: { const e = modrm(opsz); ins.d = e; ins.s = reg(mrReg, opsz); return done('xchg'); }
      case 0x88: { const e = modrm(8); ins.sz = 8; ins.d = e; ins.s = reg(mrReg, 8); return done('mov'); }
      case 0x89: { const e = modrm(opsz); ins.d = e; ins.s = reg(mrReg, opsz); return done('mov'); }
      case 0x8A: { const e = modrm(8); ins.sz = 8; ins.d = reg(mrReg, 8); ins.s = e; return done('mov'); }
      case 0x8B: { const e = modrm(opsz); ins.d = reg(mrReg, opsz); ins.s = e; return done('mov'); }
      case 0x8C: { const e = modrm(16); ins.sz = 16; ins.d = e; ins.s = imm(0); return done('movseg'); }
      case 0x8D: { const e = modrm(opsz); ins.d = reg(mrReg, opsz); ins.s = e; return done('lea'); }
      case 0x8E: { const e = modrm(16); ins.sz = 16; ins.s = e; return done('nop'); }
      case 0x8F: { const e = modrm(32); ins.d = e; return done('pop'); }
      case 0x90: return done('nop');
      case 0x98: return done(opsz === 16 ? 'cbw' : 'cwde');
      case 0x99: return done(opsz === 16 ? 'cwd' : 'cdq');
      case 0x9B: return done('fwait');
      case 0x9C: return done('pushf');
      case 0x9D: return done('popf');
      case 0x9E: return done('sahf');
      case 0x9F: return done('lahf');
      case 0xA0: ins.sz = 8; ins.d = reg(0, 8); ins.s = { k: 'm', base: -1, idx: -1, sc: 0, disp: i32(), seg, sz: 8 }; return done('mov');
      case 0xA1: ins.d = reg(0, opsz); ins.s = { k: 'm', base: -1, idx: -1, sc: 0, disp: i32(), seg, sz: opsz }; return done('mov');
      case 0xA2: ins.sz = 8; ins.s = reg(0, 8); ins.d = { k: 'm', base: -1, idx: -1, sc: 0, disp: i32(), seg, sz: 8 }; return done('mov');
      case 0xA3: ins.s = reg(0, opsz); ins.d = { k: 'm', base: -1, idx: -1, sc: 0, disp: i32(), seg, sz: opsz }; return done('mov');
      case 0xA4: ins.sz = 8; return done('movs');
      case 0xA5: return done('movs');
      case 0xA6: ins.sz = 8; return done('cmps');
      case 0xA7: return done('cmps');
      case 0xA8: ins.sz = 8; ins.d = reg(0, 8); ins.s = imm(u8()); return done('test');
      case 0xA9: ins.d = reg(0, opsz); ins.s = imm(immv(opsz)); return done('test');
      case 0xAA: ins.sz = 8; return done('stos');
      case 0xAB: return done('stos');
      case 0xAC: ins.sz = 8; return done('lods');
      case 0xAD: return done('lods');
      case 0xAE: ins.sz = 8; return done('scas');
      case 0xAF: return done('scas');
      case 0xC0: { const e = modrm(8); ins.sz = 8; ins.d = e; ins.s = imm(u8()); return done(SHIFT[mrReg]); }
      case 0xC1: { const e = modrm(opsz); ins.d = e; ins.s = imm(u8()); return done(SHIFT[mrReg]); }
      case 0xC2: ins.s = imm(u16()); return done('ret');
      case 0xC3: ins.s = imm(0); return done('ret');
      case 0xC6: { const e = modrm(8); ins.sz = 8; ins.d = e; ins.s = imm(u8()); return done('mov'); }
      case 0xC7: { const e = modrm(opsz); ins.d = e; ins.s = imm(immv(opsz)); return done('mov'); }
      case 0xC8: { const n = u16(); const lvl = u8(); ins.s = imm(n); ins.s2 = imm(lvl); return done('enter'); }
      case 0xC9: return done('leave');
      case 0xCC: return done('int3');
      case 0xCD: ins.s = imm(u8()); return done('int');
      case 0xD0: { const e = modrm(8); ins.sz = 8; ins.d = e; ins.s = imm(1); return done(SHIFT[mrReg]); }
      case 0xD1: { const e = modrm(opsz); ins.d = e; ins.s = imm(1); return done(SHIFT[mrReg]); }
      case 0xD2: { const e = modrm(8); ins.sz = 8; ins.d = e; ins.s = reg(1, 8); return done(SHIFT[mrReg]); }
      case 0xD3: { const e = modrm(opsz); ins.d = e; ins.s = reg(1, 8); return done(SHIFT[mrReg]); }
      case 0xD4: ins.s = imm(u8()); return done('aam');
      case 0xD5: ins.s = imm(u8()); return done('aad');
      case 0xD7: return done('xlat');
      case 0xD8: case 0xD9: case 0xDA: case 0xDB: case 0xDC: case 0xDD: case 0xDE: case 0xDF: {
        const m = U8[a];
        if (m >= 0xC0) { a++; ins.fop = op; ins.fm = m; ins.fmem = null; }
        else { const e = modrm(32); ins.fop = op; ins.fm = mrReg << 3; ins.fmem = e; ins.fmr = mrReg; }
        return done('fpu');
      }
      case 0xE0: case 0xE1: case 0xE2: { const d = i8(); ins.t = (a + d) | 0; ins.cc = op; return done('loop'); }
      case 0xE3: { const d = i8(); ins.t = (a + d) | 0; return done('jecxz'); }
      case 0xE8: { const d = i32(); ins.t = (a + d) | 0; return done('call'); }
      case 0xE9: { const d = i32(); ins.t = (a + d) | 0; return done('jmp'); }
      case 0xEB: { const d = i8(); ins.t = (a + d) | 0; return done('jmp'); }
      case 0xF4: return done('hlt');
      case 0xF5: return done('cmc');
      case 0xF6: {
        const e = modrm(8); ins.sz = 8; ins.d = e;
        const r = mrReg;
        if (r === 0 || r === 1) { ins.s = imm(u8()); return done('test'); }
        return done(['', '', 'not', 'neg', 'mul', 'imul1', 'div', 'idiv'][r]);
      }
      case 0xF7: {
        const e = modrm(opsz); ins.d = e;
        const r = mrReg;
        if (r === 0 || r === 1) { ins.s = imm(immv(opsz)); return done('test'); }
        return done(['', '', 'not', 'neg', 'mul', 'imul1', 'div', 'idiv'][r]);
      }
      case 0xF8: return done('clc');
      case 0xF9: return done('stc');
      case 0xFA: case 0xFB: return done('nop');
      case 0xFC: return done('cld');
      case 0xFD: return done('std');
      case 0xFE: {
        const e = modrm(8); ins.sz = 8; ins.d = e;
        if (mrReg === 0) return done('inc');
        if (mrReg === 1) return done('dec');
        throw new Bad('FE /' + mrReg);
      }
      case 0xFF: {
        const e = modrm(opsz); const r = mrReg;
        if (r === 0) { ins.d = e; return done('inc'); }
        if (r === 1) { ins.d = e; return done('dec'); }
        if (r === 2) { ins.s = modrm_fix32(e); return done('calli'); }
        if (r === 4) { ins.s = modrm_fix32(e); return done('jmpi'); }
        if (r === 6) { ins.s = modrm_fix32(e); return done('push'); }
        throw new Bad('FF /' + r);
      }
      default: throw new Bad('opcode ' + op.toString(16));
    }

    function modrm_fix32(e) { e.sz = 32; return e; }

    function decode0F() {
      const o2 = u8();
      if (o2 >= 0x80 && o2 <= 0x8F) { ins.cc = o2 & 15; const d = i32(); ins.t = (a + d) | 0; return done('jcc'); }
      if (o2 >= 0x90 && o2 <= 0x9F) { const e = modrm(8); ins.sz = 8; ins.cc = o2 & 15; ins.d = e; return done('setcc'); }
      if (o2 >= 0x40 && o2 <= 0x4F) { const e = modrm(opsz); ins.cc = o2 & 15; ins.d = reg(mrReg, opsz); ins.s = e; return done('cmovcc'); }
      if (o2 >= 0xC8 && o2 <= 0xCF) { ins.d = reg(o2 & 7, 32); return done('bswap'); }
      switch (o2) {
        case 0xAF: { const e = modrm(opsz); ins.d = reg(mrReg, opsz); ins.s = e; return done('imul2'); }
        case 0xB6: { const e = modrm(8); ins.d = reg(mrReg, opsz); ins.s = e; ins.sz = opsz; return done('movzx'); }
        case 0xB7: { const e = modrm(16); ins.d = reg(mrReg, 32); ins.s = e; ins.sz = 32; return done('movzx'); }
        case 0xBE: { const e = modrm(8); ins.d = reg(mrReg, opsz); ins.s = e; ins.sz = opsz; return done('movsx'); }
        case 0xBF: { const e = modrm(16); ins.d = reg(mrReg, 32); ins.s = e; ins.sz = 32; return done('movsx'); }
        case 0xA2: return done('cpuid');
        case 0x31: return done('rdtsc');
        case 0xA3: case 0xAB: case 0xB3: case 0xBB: {
          const e = modrm(opsz); ins.d = e; ins.s = reg(mrReg, opsz);
          return done({ 0xA3: 'bt', 0xAB: 'bts', 0xB3: 'btr', 0xBB: 'btc' }[o2]);
        }
        case 0xBA: {
          const e = modrm(opsz); ins.d = e; ins.s = imm(u8());
          const r = mrReg;
          if (r < 4) throw new Bad('0FBA /' + r);
          return done(['bt', 'bts', 'btr', 'btc'][r - 4]);
        }
        case 0xBC: { const e = modrm(opsz); ins.d = reg(mrReg, opsz); ins.s = e; return done('bsf'); }
        case 0xBD: { const e = modrm(opsz); ins.d = reg(mrReg, opsz); ins.s = e; return done('bsr'); }
        case 0xA4: { const e = modrm(opsz); ins.d = e; ins.s = reg(mrReg, opsz); ins.s2 = imm(u8()); return done('shld'); }
        case 0xA5: { const e = modrm(opsz); ins.d = e; ins.s = reg(mrReg, opsz); ins.s2 = reg(1, 8); return done('shld'); }
        case 0xAC: { const e = modrm(opsz); ins.d = e; ins.s = reg(mrReg, opsz); ins.s2 = imm(u8()); return done('shrd'); }
        case 0xAD: { const e = modrm(opsz); ins.d = e; ins.s = reg(mrReg, opsz); ins.s2 = reg(1, 8); return done('shrd'); }
        case 0xB0: { const e = modrm(8); ins.sz = 8; ins.d = e; ins.s = reg(mrReg, 8); return done('cmpxchg'); }
        case 0xB1: { const e = modrm(opsz); ins.d = e; ins.s = reg(mrReg, opsz); return done('cmpxchg'); }
        case 0xC0: { const e = modrm(8); ins.sz = 8; ins.d = e; ins.s = reg(mrReg, 8); return done('xadd'); }
        case 0xC1: { const e = modrm(opsz); ins.d = e; ins.s = reg(mrReg, opsz); return done('xadd'); }
        case 0x0B: return done('ud2');
        case 0x1F: { modrm(opsz); return done('nop'); }
        default: throw new Bad('0F ' + o2.toString(16));
      }
    }
  }

  EMU.decode = decode;
  EMU.DecodeError = Bad;
})(typeof globalThis !== 'undefined' ? globalThis : this);
