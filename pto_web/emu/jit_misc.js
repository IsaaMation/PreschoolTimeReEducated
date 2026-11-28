/* x86 -> JS block compiler: multiply/divide, rotates, bit ops, strings, x87 glue, odds and ends */
(function (G) {
  'use strict';
  const EMU = G.EMU, Gen = EMU.Gen, CPU = EMU.CPU, K = EMU.consts;
  const { SH, IDX } = EMU.genConst;
  const fo = (kind, idx) => (kind << 2) | idx;
  const P = Gen.prototype;

  // ------------------------------------------------------------ CPU-side helpers
  Object.assign(CPU.prototype, {
    shrdFlags(a, r, n) {
      let p = r & 255; p ^= p >> 4; p ^= p >> 2; p ^= p >> 1;
      this.setEfl((a >>> (n - 1)) & 1, r === 0 ? 1 : 0, r < 0 ? 1 : 0, n === 1 ? ((a ^ r) >>> 31) & 1 : 0, (~p) & 1);
    },
    mulFlags(of) { this.fo = 0; this.fa = (of ? 0x801 : 0) | 0x202; },
    div16(signed, d) {
      const R = this.R;
      if (signed) {
        d = (d << 16) >> 16; if (d === 0) throw new EMU.GuestError('divide by zero');
        const n = (R[2] << 16) | (R[0] & 65535);
        const q = Math.trunc(n / d), r = n - q * d;
        if (q > 32767 || q < -32768) throw new EMU.GuestError('divide overflow');
        R[0] = (R[0] & -65536) | (q & 65535); R[2] = (R[2] & -65536) | (r & 65535);
      } else {
        if (d === 0) throw new EMU.GuestError('divide by zero');
        const n = (((R[2] & 65535) << 16) | (R[0] & 65535)) >>> 0;
        const q = Math.floor(n / d), r = n - q * d;
        if (q > 65535) throw new EMU.GuestError('divide overflow');
        R[0] = (R[0] & -65536) | q; R[2] = (R[2] & -65536) | r;
      }
    },
    div8(signed, d) {
      const R = this.R;
      if (signed) {
        d = (d << 24) >> 24; if (d === 0) throw new EMU.GuestError('divide by zero');
        const n = (R[0] << 16) >> 16;
        const q = Math.trunc(n / d), r = n - q * d;
        if (q > 127 || q < -128) throw new EMU.GuestError('divide overflow');
        R[0] = (R[0] & -65536) | ((r & 255) << 8) | (q & 255);
      } else {
        if (d === 0) throw new EMU.GuestError('divide by zero');
        const n = R[0] & 65535;
        const q = Math.floor(n / d), r = n - q * d;
        if (q > 255) throw new EMU.GuestError('divide overflow');
        R[0] = (R[0] & -65536) | (r << 8) | q;
      }
    },
    /** rotate; kind 0 rol 1 ror 2 rcl 3 rcr; a right-aligned; returns right-aligned result; sets CF/OF unless nf */
    rot(kind, bits, a, n, nf) {
      const full = bits === 32, mask = full ? 0xFFFFFFFF : ((1 << bits) - 1);
      a = full ? a >>> 0 : a & mask;
      let res = a, cf = 0, of = 0;
      const msb = v => (v >>> (bits - 1)) & 1;
      if (kind < 2) {
        const m = n % bits;
        if (m) {
          if (kind === 0) res = full ? (((a << m) | (a >>> (32 - m))) >>> 0) : (((a << m) | (a >>> (bits - m))) & mask);
          else res = full ? (((a >>> m) | (a << (32 - m))) >>> 0) : (((a >>> m) | (a << (bits - m))) & mask);
        }
        if (kind === 0) { cf = res & 1; of = msb(res) ^ cf; }
        else { cf = msb(res); of = msb(res) ^ ((res >>> (bits - 2)) & 1); }
      } else {
        cf = this.cf();
        const m = n % (bits + 1);
        for (let i = 0; i < m; i++) {
          if (kind === 2) { const nc = msb(res); res = full ? (((res << 1) | cf) >>> 0) : (((res << 1) | cf) & mask); cf = nc; }
          else { const nc = res & 1; res = full ? (((res >>> 1) | (cf << 31)) >>> 0) : ((res >>> 1) | (cf << (bits - 1))); cf = nc; }
        }
        of = kind === 2 ? (msb(res) ^ cf) : (msb(res) ^ ((res >>> (bits - 2)) & 1));
      }
      if (!nf) { const f = this.getFlags(); this.fo = 0; this.fa = (f & ~0x801) | cf | (of << 11); }
      return res | 0;
    },
    cpuid() {
      const R = this.R;
      if (R[0] === 0) { R[0] = 1; R[3] = 0x756e6547; R[2] = 0x49656e69; R[1] = 0x6c65746e; }
      else { R[0] = 0x0543; R[3] = 0; R[1] = 0; R[2] = 1; }
    },
    rdtsc() {
      const t = (typeof performance !== 'undefined' ? performance.now() : Date.now()) * 300000;
      this.R[0] = t % 4294967296 | 0; this.R[2] = Math.floor(t / 4294967296) | 0;
    },
  });

  // ------------------------------------------------------------ mul / imul / div / idiv
  P.mulop = function (ins, signed) {
    const sz = ins.sz, out = [];
    const d = this.bind(ins.d, out);
    const v = this.nv(); out.push(v + ' = ' + this.get(d, sz) + ';');
    const emit = ins.emit;
    if (sz === 32) {
      out.push('R[0] = c.' + (signed ? 'muls' : 'mulu') + '(R[0], ' + v + '); R[2] = c.hi;');
      if (emit) out.push('c.mulFlags(' + (signed ? '(c.hi !== (R[0] >> 31))' : '(c.hi !== 0)') + ');');
    } else if (sz === 16) {
      const p = this.nv();
      out.push(p + ' = ' + (signed ? '((R[0] << 16) >> 16) * ((' + v + ' << 16) >> 16)' : '(R[0] & 65535) * ' + v) + ';');
      out.push('R[0] = (R[0] & -65536) | (' + p + ' & 65535); R[2] = (R[2] & -65536) | ((' + p + ' >> 16) & 65535);');
      if (emit) out.push('c.mulFlags(' + (signed ? '(' + p + ' !== ((' + p + ' << 16) >> 16))' : '((' + p + ' >>> 16) !== 0)') + ');');
    } else {
      const p = this.nv();
      out.push(p + ' = ' + (signed ? '((R[0] << 24) >> 24) * ((' + v + ' << 24) >> 24)' : '(R[0] & 255) * ' + v) + ';');
      out.push('R[0] = (R[0] & -65536) | (' + p + ' & 65535);');
      if (emit) out.push('c.mulFlags(' + (signed ? '(' + p + ' !== ((' + p + ' << 24) >> 24))' : '((' + p + ' >> 8) !== 0)') + ');');
    }
    if (emit) this.desc = null;
    return out.join('\n');
  };
  P.op_mul = function (ins) { return this.mulop(ins, false); };
  P.op_imul1 = function (ins) { return this.mulop(ins, true); };
  P.imulN = function (ins, b3) {
    const sz = ins.sz, out = [];
    const a = this.nv(), b = this.nv();
    out.push(a + ' = ' + this.get(ins.s, sz) + '; ' + b + ' = ' + (b3 ? String(ins.s2.v | 0) : this.get(ins.d, sz)) + ';');
    const res = this.nv();
    if (sz === 32) {
      if (ins.emit) {
        out.push(res + ' = c.muls(' + a + ', ' + b + '); c.mulFlags(c.hi !== (' + res + ' >> 31));');
        this.desc = null;
      } else out.push(res + ' = Math.imul(' + a + ', ' + b + ');');
    } else {
      out.push(res + ' = ((' + a + ' << 16) >> 16) * ((' + b + ' << 16) >> 16);');
      if (ins.emit) { out.push('c.mulFlags(' + res + ' !== ((' + res + ' << 16) >> 16));'); this.desc = null; }
    }
    out.push(this.put(ins.d, res));
    return out.join('\n');
  };
  P.op_imul2 = function (ins) { return this.imulN(ins, false); };
  P.op_imul3 = function (ins) { return this.imulN(ins, true); };
  P.divop = function (ins, signed) {
    const sz = ins.sz, out = [];
    const d = this.bind(ins.d, out);
    const v = this.nv(); out.push(v + ' = ' + this.get(d, sz) + ';');
    if (sz === 32) out.push('{ const q = c.' + (signed ? 'divs' : 'divu') + '(R[2], R[0], ' + v + '); R[0] = q; R[2] = c.hi; }');
    else out.push('c.div' + sz + '(' + signed + ', ' + v + ');');
    return out.join('\n');
  };
  P.op_div = function (ins) { return this.divop(ins, false); };
  P.op_idiv = function (ins) { return this.divop(ins, true); };

  // ------------------------------------------------------------ rotates / double shifts
  P.rotop = function (ins, kind) {
    const sz = ins.sz, out = [];
    const imm = ins.s.k === 'i';
    let cnt;
    if (imm) { cnt = String(ins.s.v & 31); if (cnt === '0') return ''; }
    const d = this.bind(ins.d, out);
    if (!imm) { cnt = this.nv(); out.push(cnt + ' = R[1] & 31;'); }
    const r = this.nv();
    const nf = ins.emit ? '' : ', true';
    out.push('if (' + cnt + ' !== 0) { ' + r + ' = c.rot(' + kind + ', ' + sz + ', ' + this.get(d, sz) + ', ' + cnt + nf + '); ' + this.put(d, r) + ' }');
    if (ins.emit) this.desc = null;
    return out.join('\n');
  };
  P.op_rol = function (ins) { return this.rotop(ins, 0); };
  P.op_ror = function (ins) { return this.rotop(ins, 1); };
  P.op_rcl = function (ins) { return this.rotop(ins, 2); };
  P.op_rcr = function (ins) { return this.rotop(ins, 3); };
  P.dshift = function (ins, left) {
    if (ins.sz !== 32) return 'throw new Error("16-bit shld/shrd unsupported");';
    const out = [], imm = ins.s2.k === 'i';
    let cnt;
    if (imm) { cnt = String(ins.s2.v & 31); if (cnt === '0') return ''; }
    const d = this.bind(ins.d, out);
    if (!imm) { cnt = this.nv(); out.push(cnt + ' = R[1] & 31;'); }
    const a = this.nv(), b = this.nv(), r = this.nv();
    const body = [a + ' = ' + this.get(d, 32) + '; ' + b + ' = ' + this.get(ins.s, 32) + ';'];
    body.push(r + ' = ' + (left ? '(' + a + ' << ' + cnt + ') | (' + b + ' >>> (32 - ' + cnt + '))' : '(' + a + ' >>> ' + cnt + ') | (' + b + ' << (32 - ' + cnt + '))') + ';');
    body.push(this.put(d, r));
    if (ins.emit) {
      if (left) body.push('c.fo = ' + fo(K.FO_SHL, 0) + '; c.fa = ' + a + '; c.fb = ' + cnt + '; c.fr = ' + r + ';');
      else body.push('c.shrdFlags(' + a + ', ' + r + ', ' + cnt + ');');
    }
    out.push(imm ? body.join('\n') : 'if (' + cnt + ' !== 0) {\n' + body.join('\n') + '\n}');
    if (ins.emit) this.desc = (imm && left) ? { k: 'res', r } : null;
    return out.join('\n');
  };
  P.op_shld = function (ins) { return this.dshift(ins, true); };
  P.op_shrd = function (ins) { return this.dshift(ins, false); };

  // ------------------------------------------------------------ bit tests
  P.bitop = function (ins, kind) {
    const sz = ins.sz, out = [];
    const d = ins.d, s = ins.s;
    const off = this.nv(), val = this.nv(), bit = this.nv(), addr = this.nv();
    const w = sz === 16 ? 4 : 5;
    if (s.k === 'i') out.push(off + ' = ' + (s.v & (sz - 1)) + ';');
    else out.push(off + ' = ' + this.get(s, sz) + ';');
    let dst;
    if (d.k === 'm') {
      if (s.k === 'i') out.push(addr + ' = ' + this.ea(d) + ';');
      else out.push(addr + ' = (' + this.ea(d) + ' + ((' + off + ' >> ' + w + ') << ' + (sz === 16 ? 1 : 2) + ')) | 0; ' + off + ' &= ' + (sz - 1) + ';');
      dst = { k: 'M', a: addr, sz };
    } else {
      if (s.k !== 'i') out.push(off + ' &= ' + (sz - 1) + ';');
      dst = d;
    }
    out.push(val + ' = ' + this.get(dst, sz) + '; ' + bit + ' = (' + val + ' >>> ' + off + ') & 1;');
    if (kind === 1) out.push(this.put(dst, val + ' | (1 << ' + off + ')'));
    else if (kind === 2) out.push(this.put(dst, val + ' & ~(1 << ' + off + ')'));
    else if (kind === 3) out.push(this.put(dst, val + ' ^ (1 << ' + off + ')'));
    if (ins.emit) { out.push('c.setCF(' + bit + ');'); this.desc = null; }
    return out.join('\n');
  };
  P.op_bt = function (ins) { return this.bitop(ins, 0); };
  P.op_bts = function (ins) { return this.bitop(ins, 1); };
  P.op_btr = function (ins) { return this.bitop(ins, 2); };
  P.op_btc = function (ins) { return this.bitop(ins, 3); };
  P.bscan = function (ins, rev) {
    const out = [], v = this.nv();
    out.push(v + ' = ' + this.get(ins.s, ins.sz) + ';');
    out.push('if (' + v + ' !== 0) { ' + this.put(ins.d, 'c.' + (rev ? 'bsr' : 'bsf') + '(' + v + ')') + ' }');
    if (ins.emit) { out.push('c.fo = ' + fo(K.FO_LOGIC, 0) + '; c.fr = ' + v + ';'); this.desc = { k: 'logic', r: v }; }
    return out.join('\n');
  };
  P.op_bsf = function (ins) { return this.bscan(ins, false); };
  P.op_bsr = function (ins) { return this.bscan(ins, true); };

  // ------------------------------------------------------------ exchange-add / compare-exchange
  P.op_xadd = function (ins) {
    const sz = ins.sz, sh = SH[sz], idx = IDX[sz], out = [];
    const d = this.bind(ins.d, out);
    const a = this.nv(), b = this.nv(), r = this.nv();
    out.push(a + ' = ' + this.get(d, sz) + '; ' + b + ' = ' + this.get(ins.s, sz) + '; ' + r + ' = (' + a + ' + ' + b + ') | 0;');
    out.push(this.put(ins.s, a)); out.push(this.put(d, r));
    if (ins.emit) {
      out.push('c.fo = ' + fo(K.FO_ADD, idx) + '; c.fa = ' + (sh ? a + ' << ' + sh : a) + '; c.fb = ' + (sh ? b + ' << ' + sh : b) + '; c.fr = ' + (sh ? r + ' << ' + sh : r) + ';');
      this.desc = null;
    }
    return out.join('\n');
  };
  P.op_cmpxchg = function (ins) {
    const sz = ins.sz, sh = SH[sz], idx = IDX[sz], out = [];
    const d = this.bind(ins.d, out);
    const a = this.nv(), b = this.nv();
    out.push(a + ' = ' + this.rg(0, sz) + '; ' + b + ' = ' + this.get(d, sz) + ';');
    if (ins.emit) {
      out.push('c.fo = ' + fo(K.FO_SUB, idx) + '; c.fa = ' + (sh ? a + ' << ' + sh : a) + '; c.fb = ' + (sh ? b + ' << ' + sh : b) + '; c.fr = (c.fa - c.fb) | 0;');
      this.desc = null;
    }
    out.push('if (' + a + ' === ' + b + ') { ' + this.put(d, this.get(ins.s, sz)) + ' } else { ' + this.sr(0, sz, b) + ' }');
    return out.join('\n');
  };

  // ------------------------------------------------------------ strings
  P.op_movs = function (ins) { return 'c.strMovs(' + (ins.sz >> 3) + ', ' + (ins.rep ? 1 : 0) + ');'; };
  P.op_stos = function (ins) { return 'c.strStos(' + (ins.sz >> 3) + ', ' + (ins.rep ? 1 : 0) + ');'; };
  P.op_lods = function (ins) { return 'c.strLods(' + (ins.sz >> 3) + ', ' + (ins.rep ? 1 : 0) + ');'; };
  P.op_scas = function (ins) { this.desc = null; return 'c.strScas(' + (ins.sz >> 3) + ', ' + ins.rep + ');'; };
  P.op_cmps = function (ins) { this.desc = null; return 'c.strCmps(' + (ins.sz >> 3) + ', ' + ins.rep + ');'; };

  // ------------------------------------------------------------ flag oddments
  P.op_lahf = function () { return 'R[0] = (R[0] & -65281) | (((c.getFlags() & 213) | 2) << 8);'; };
  P.op_sahf = function (ins) {
    if (!ins.emit) return '';
    this.desc = null;
    return '{ const f = c.getFlags(); c.fo = 0; c.fa = (f & ~213) | ((R[0] >> 8) & 213) | 514; }';
  };
  P.op_clc = function (ins) { if (!ins.emit) return ''; this.desc = null; return '{ const f = c.getFlags(); c.fo = 0; c.fa = f & ~1; }'; };
  P.op_stc = function (ins) { if (!ins.emit) return ''; this.desc = null; return '{ const f = c.getFlags(); c.fo = 0; c.fa = f | 1; }'; };
  P.op_cmc = function (ins) { if (!ins.emit) return ''; this.desc = null; return '{ const f = c.getFlags(); c.fo = 0; c.fa = f ^ 1; }'; };
  P.op_cpuid = function () { return 'c.cpuid();'; };
  P.op_rdtsc = function () { return 'c.rdtsc();'; };

  // ------------------------------------------------------------ x87
  P.op_fpu = function (ins) {
    if (ins.fmem) return 'c.fpuMem(' + ins.fop + ', ' + ins.fmr + ', ' + this.ea(ins.fmem) + ');';
    const f = ins.fop, m = ins.fm;
    if ((f === 0xDB || f === 0xDF) && m >= 0xE8 && m < 0xF8) this.desc = null;
    return 'c.fpuReg(' + ins.fop + ', ' + ins.fm + ');';
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
