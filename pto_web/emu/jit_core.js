/* x86 -> JavaScript block compiler, core: decode loop, flag liveness, operand helpers, condition codes.
 * Instruction emitters live in jit_alu.js and jit_misc.js (they extend EMU.Gen.prototype as op_<name>).
 */
(function (G) {
  'use strict';
  const EMU = G.EMU = G.EMU || {};
  const K = EMU.consts;
  const SH = { 8: 24, 16: 16, 32: 0 }, IDX = { 8: 2, 16: 1, 32: 0 };
  const F_C = 1, F_Z = 2, F_S = 4, F_O = 8, F_P = 16, F_A = 32, F_ALL = 63;
  const CC_READ = [F_O, F_O, F_C, F_C, F_Z, F_Z, F_C | F_Z, F_C | F_Z, F_S, F_S, F_P, F_P, F_S | F_O, F_S | F_O, F_Z | F_S | F_O, F_Z | F_S | F_O];
  const MAXINS = 96;
  const TERM = new Set(['jcc', 'jmp', 'call', 'calli', 'jmpi', 'ret', 'loop', 'jecxz', 'hlt', 'int3', 'int', 'ud2', 'bad']);
  const NOFLAGS = { rd: 0, rdE: 0, wr: 0, kill: 0 };

  function flagInfo(ins) {
    const o = ins.op;
    switch (o) {
      case 'add': case 'sub': case 'cmp': case 'and': case 'or': case 'xor': case 'test': case 'neg': case 'xadd': case 'cmpxchg':
      case 'imul1': case 'imul2': case 'imul3': case 'mul': case 'bsf': case 'bsr':
        return { rd: 0, rdE: 0, wr: F_ALL, kill: F_ALL };
      case 'adc': case 'sbb': return { rd: F_C, rdE: 0, wr: F_ALL, kill: F_ALL };
      case 'inc': case 'dec': return { rd: 0, rdE: 0, wr: F_ALL & ~F_C, kill: F_ALL & ~F_C };
      case 'shl': case 'shr': case 'sar': case 'shld': case 'shrd': {
        const s = (o === 'shld' || o === 'shrd') ? ins.s2 : ins.s;
        if (s.k === 'i') return (s.v & 31) === 0 ? NOFLAGS : { rd: 0, rdE: 0, wr: F_ALL, kill: F_ALL };
        return { rd: 0, rdE: 0, wr: F_ALL, kill: 0 };
      }
      case 'rol': case 'ror': case 'rcl': case 'rcr': {
        const imm = ins.s.k === 'i';
        if (imm && (ins.s.v & 31) === 0) return NOFLAGS;
        return { rd: (o === 'rcl' || o === 'rcr') ? F_C : 0, rdE: F_ALL, wr: F_C | F_O, kill: imm ? (F_C | F_O) : 0 };
      }
      case 'bt': case 'bts': case 'btr': case 'btc': return { rd: 0, rdE: F_ALL & ~F_C, wr: F_C, kill: F_C };
      case 'sahf': return { rd: 0, rdE: F_O, wr: F_ALL & ~F_O, kill: F_ALL & ~F_O };
      case 'lahf': return { rd: F_C | F_Z | F_S | F_P | F_A, rdE: 0, wr: 0, kill: 0 };
      case 'clc': case 'stc': return { rd: 0, rdE: F_ALL & ~F_C, wr: F_C, kill: F_C };
      case 'cmc': return { rd: F_C, rdE: F_ALL & ~F_C, wr: F_C, kill: F_C };
      case 'pushf': return { rd: F_ALL, rdE: 0, wr: 0, kill: 0 };
      case 'popf': return { rd: 0, rdE: 0, wr: F_ALL, kill: F_ALL };
      case 'jcc': case 'setcc': case 'cmovcc': return { rd: CC_READ[ins.cc], rdE: 0, wr: 0, kill: 0 };
      case 'loop': return ins.cc === 0xE2 ? NOFLAGS : { rd: F_Z, rdE: 0, wr: 0, kill: 0 };
      case 'cmps': case 'scas': return { rd: 0, rdE: 0, wr: F_ALL, kill: 0 };
      case 'fpu': {
        const f = ins.fop, m = ins.fm;
        if (!ins.fmem) {
          if ((f === 0xDB || f === 0xDF) && m >= 0xE8 && m < 0xF8) return { rd: F_ALL, rdE: 0, wr: F_C | F_Z | F_P, kill: F_C | F_Z | F_P };
          if ((f === 0xDA || f === 0xDB) && m < 0xE0) return { rd: F_C | F_Z | F_P, rdE: 0, wr: 0, kill: 0 };
        }
        return NOFLAGS;
      }
    }
    return NOFLAGS;
  }

  class Gen {
    constructor(cpu, eip) {
      this.c = cpu; this.eip = eip; this.count = 0; this.endAddr = eip;
      this.vars = []; this.nvc = 0; this.desc = null; this.ins = null;
    }
    nv() { const n = 'v' + (this.nvc++); this.vars.push(n); return n; }

    run() {
      const U8 = this.c.u8;
      const list = [];
      let a = this.eip, bad = null;
      for (let n = 0; n < MAXINS; n++) {
        let ins;
        try { ins = EMU.decode(U8, a); }
        catch (e) {
          let bytes = ''; for (let i = 0; i < 8; i++) bytes += ('0' + U8[a + i].toString(16)).slice(-2) + ' ';
          bad = { op: 'bad', a, len: 0, msg: (e.message || String(e)) + ' at 0x' + (a >>> 0).toString(16) + ' bytes ' + bytes };
          break;
        }
        list.push(ins); a += ins.len;
        if (TERM.has(ins.op)) break;
      }
      if (bad) { if (list.length === 0) list.push(bad); }
      const last = list[list.length - 1];
      this.endAddr = a; this.count = list.length;
      // ---- flag liveness (backwards)
      let live = F_ALL;
      for (let i = list.length - 1; i >= 0; i--) {
        const ins = list[i];
        const f = flagInfo(ins);
        ins.emit = (f.wr & live) !== 0;
        ins.liveAfter = live;
        live = (live & ~f.kill) | f.rd | (ins.emit ? f.rdE : 0);
      }
      // ---- emit
      const body = [];
      for (const ins of list) body.push(this.gen(ins));
      if (!TERM.has(last.op)) body.push('c.eip = ' + a + ';');
      return (this.vars.length ? 'let ' + this.vars.join(',') + ';\n' : '') + body.join('\n');
    }

    gen(ins) {
      this.ins = ins;
      const m = this['op_' + ins.op];
      if (!m) return 'throw new Error(' + JSON.stringify('JIT: unsupported op ' + ins.op + ' at 0x' + (ins.a >>> 0).toString(16)) + ');';
      return '/*' + (ins.a >>> 0).toString(16) + ' ' + ins.op + '*/ ' + m.call(this, ins);
    }

    // ------------------------------------------------------------ operands
    rg(n, sz) {
      if (sz === 32) return 'R[' + n + ']';
      if (sz === 16) return '(R[' + n + '] & 65535)';
      return n < 4 ? '(R[' + n + '] & 255)' : '((R[' + (n - 4) + '] >> 8) & 255)';
    }
    sr(n, sz, e) {
      if (sz === 32) return 'R[' + n + '] = ' + e + ';';
      if (sz === 16) return 'R[' + n + '] = (R[' + n + '] & -65536) | ((' + e + ') & 65535);';
      if (n < 4) return 'R[' + n + '] = (R[' + n + '] & -256) | ((' + e + ') & 255);';
      return 'R[' + (n - 4) + '] = (R[' + (n - 4) + '] & -65281) | (((' + e + ') & 255) << 8);';
    }
    mr(a, sz) { return sz === 32 ? 'rd32(' + a + ')' : sz === 16 ? 'rd16(' + a + ')' : 'rd8(' + a + ')'; }
    mw(a, sz, v) { return (sz === 32 ? 'wr32(' : sz === 16 ? 'wr16(' : 'wr8(') + a + ', ' + v + ');'; }
    ea(m) {
      const parts = [];
      if (m.base >= 0) parts.push('R[' + m.base + ']');
      if (m.idx >= 0) parts.push(m.sc ? 'R[' + m.idx + '] * ' + (1 << m.sc) : 'R[' + m.idx + ']');
      if (m.seg === 'fs') parts.push('c.fsBase');
      const disp = m.disp | 0;
      if (parts.length === 0) return String(disp);
      if (disp) parts.push(String(disp));
      if (parts.length === 1) return parts[0];
      return '(' + parts.join(' + ') + ') | 0';
    }
    immv(v, sz) { return sz === 8 ? (v & 255) : sz === 16 ? (v & 65535) : (v | 0); }
    /** memory operands get their address computed once into a temp; returns a bound operand */
    bind(op, out) {
      if (op.k === 'm') { const v = this.nv(); out.push(v + ' = ' + this.ea(op) + ';'); return { k: 'M', a: v, sz: op.sz }; }
      return op;
    }
    get(p, sz) {
      if (p.k === 'M') return this.mr(p.a, p.sz);
      if (p.k === 'r') return this.rg(p.n, p.sz);
      if (p.k === 'm') return this.mr(this.ea(p), p.sz);
      return String(this.immv(p.v, sz));
    }
    put(p, e) {
      if (p.k === 'M') return this.mw(p.a, p.sz, e);
      if (p.k === 'm') return this.mw(this.ea(p), p.sz, e);
      return this.sr(p.n, p.sz, e);
    }

    // ------------------------------------------------------------ flags / conditions
    /** expression (0/1) for the current carry flag */
    cfExpr() {
      const d = this.desc;
      if (d) {
        if (d.k === 'sub') return '((' + d.a + ' >>> 0) < (' + d.b + ' >>> 0) ? 1 : 0)';
        if (d.k === 'add') return '((' + d.r + ' >>> 0) < (' + d.a + ' >>> 0) ? 1 : 0)';
        if (d.k === 'logic') return '0';
      }
      return 'c.cf()';
    }
    condExpr(cc) {
      const d = this.desc;
      if (d) {
        const a = d.a, b = d.b, r = d.r;
        if (d.k === 'sub') {
          switch (cc) {
            case 0: return '(((' + a + ' ^ ' + b + ') & (' + a + ' ^ ' + r + ')) < 0)';
            case 1: return '(((' + a + ' ^ ' + b + ') & (' + a + ' ^ ' + r + ')) >= 0)';
            case 2: return '((' + a + ' >>> 0) < (' + b + ' >>> 0))';
            case 3: return '((' + a + ' >>> 0) >= (' + b + ' >>> 0))';
            case 4: return '(' + a + ' === ' + b + ')';
            case 5: return '(' + a + ' !== ' + b + ')';
            case 6: return '((' + a + ' >>> 0) <= (' + b + ' >>> 0))';
            case 7: return '((' + a + ' >>> 0) > (' + b + ' >>> 0))';
            case 8: return '(' + r + ' < 0)';
            case 9: return '(' + r + ' >= 0)';
            case 12: return '(' + a + ' < ' + b + ')';
            case 13: return '(' + a + ' >= ' + b + ')';
            case 14: return '(' + a + ' <= ' + b + ')';
            case 15: return '(' + a + ' > ' + b + ')';
          }
        } else if (d.k === 'add') {
          const ov = '(((' + a + ' ^ ' + r + ') & (' + b + ' ^ ' + r + ')) < 0)';
          switch (cc) {
            case 0: return ov;
            case 1: return '!' + ov;
            case 2: return '((' + r + ' >>> 0) < (' + a + ' >>> 0))';
            case 3: return '((' + r + ' >>> 0) >= (' + a + ' >>> 0))';
            case 4: return '(' + r + ' === 0)';
            case 5: return '(' + r + ' !== 0)';
            case 6: return '(' + r + ' === 0 || (' + r + ' >>> 0) < (' + a + ' >>> 0))';
            case 7: return '(' + r + ' !== 0 && (' + r + ' >>> 0) >= (' + a + ' >>> 0))';
            case 8: return '(' + r + ' < 0)';
            case 9: return '(' + r + ' >= 0)';
            case 12: return '((' + r + ' < 0) !== ' + ov + ')';
            case 13: return '((' + r + ' < 0) === ' + ov + ')';
            case 14: return '(' + r + ' === 0 || (' + r + ' < 0) !== ' + ov + ')';
            case 15: return '(' + r + ' !== 0 && (' + r + ' < 0) === ' + ov + ')';
          }
        } else if (d.k === 'logic') {
          switch (cc) {
            case 0: return 'false'; case 1: return 'true'; case 2: return 'false'; case 3: return 'true';
            case 4: return '(' + r + ' === 0)'; case 5: return '(' + r + ' !== 0)';
            case 6: return '(' + r + ' === 0)'; case 7: return '(' + r + ' !== 0)';
            case 8: return '(' + r + ' < 0)'; case 9: return '(' + r + ' >= 0)';
            case 12: return '(' + r + ' < 0)'; case 13: return '(' + r + ' >= 0)';
            case 14: return '(' + r + ' <= 0)'; case 15: return '(' + r + ' > 0)';
          }
        } else if (d.k === 'res') {
          switch (cc) {
            case 4: return '(' + r + ' === 0)'; case 5: return '(' + r + ' !== 0)';
            case 8: return '(' + r + ' < 0)'; case 9: return '(' + r + ' >= 0)';
          }
        }
      }
      return 'c.cond(' + cc + ')';
    }
  }

  EMU.Gen = Gen;
  EMU.genConst = { SH, IDX, F_C, F_Z, F_S, F_O, F_P, F_A, F_ALL, K };
})(typeof globalThis !== 'undefined' ? globalThis : this);
