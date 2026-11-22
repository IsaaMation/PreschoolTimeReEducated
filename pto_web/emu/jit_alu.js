/* x86 -> JS block compiler: ALU, moves, stack, control flow */
(function (G) {
  'use strict';
  const EMU = G.EMU, Gen = EMU.Gen, K = EMU.consts;
  const { SH, IDX, F_C } = EMU.genConst;
  const fo = (kind, idx) => (kind << 2) | idx;
  const P = Gen.prototype;

  // ---------------------------------------------------------------- add or adc sbb and sub xor cmp test
  P.alu = function (ins, name) {
    const sz = ins.sz, sh = SH[sz], idx = IDX[sz], out = [];
    const d = this.bind(ins.d, out), s = this.bind(ins.s, out);
    const store = name !== 'cmp' && name !== 'test';
    const emit = ins.emit;
    if (name === 'and' || name === 'or' || name === 'xor' || name === 'test') {
      const a = this.nv(), b = this.nv(), r = this.nv();
      const opc = name === 'or' ? '|' : name === 'xor' ? '^' : '&';
      out.push(a + ' = ' + this.get(d, sz) + '; ' + b + ' = ' + this.get(s, sz) + '; ' + r + ' = ' + a + ' ' + opc + ' ' + b + ';');
      if (store) out.push(this.put(d, r));
      if (emit) {
        let rl = r;
        if (sh) { rl = this.nv(); out.push(rl + ' = ' + r + ' << ' + sh + ';'); }
        out.push('c.fo = ' + fo(K.FO_LOGIC, idx) + '; c.fr = ' + rl + ';');
        this.desc = { k: 'logic', r: rl };
      }
      return out.join('\n');
    }
    const A = this.nv(), B = this.nv(), r = this.nv();
    let cin = null;
    if (name === 'adc' || name === 'sbb') { cin = this.nv(); out.push(cin + ' = ' + this.cfExpr() + ';'); }
    const L = e => sh ? '(' + e + ') << ' + sh : e;
    out.push(A + ' = ' + L(this.get(d, sz)) + '; ' + B + ' = ' + L(this.get(s, sz)) + ';');
    const cs = cin ? (sh ? '(' + cin + ' << ' + sh + ')' : cin) : '';
    switch (name) {
      case 'add': out.push(r + ' = (' + A + ' + ' + B + ') | 0;'); break;
      case 'adc': out.push(r + ' = (' + A + ' + ' + B + ' + ' + cs + ') | 0;'); break;
      case 'sub': case 'cmp': out.push(r + ' = (' + A + ' - ' + B + ') | 0;'); break;
      case 'sbb': out.push(r + ' = (' + A + ' - ' + B + ' - ' + cs + ') | 0;'); break;
    }
    if (store) out.push(this.put(d, sh ? r + ' >>> ' + sh : r));
    if (emit) {
      const kind = { add: K.FO_ADD, adc: K.FO_ADC, sub: K.FO_SUB, cmp: K.FO_SUB, sbb: K.FO_SBB }[name];
      out.push('c.fo = ' + fo(kind, idx) + '; c.fa = ' + A + '; c.fb = ' + B + '; c.fr = ' + r + ';' + (cin ? ' c.fx = ' + cin + ';' : ''));
      this.desc = (name === 'add') ? { k: 'add', a: A, b: B, r } : (name === 'sub' || name === 'cmp') ? { k: 'sub', a: A, b: B, r } : null;
    }
    return out.join('\n');
  };
  for (const n of ['add', 'or', 'adc', 'sbb', 'and', 'sub', 'xor', 'cmp', 'test']) P['op_' + n] = function (ins) { return this.alu(ins, n); };

  // ---------------------------------------------------------------- inc dec neg not
  P.incdec = function (ins, dec) {
    const sz = ins.sz, sh = SH[sz], idx = IDX[sz], out = [];
    const d = this.bind(ins.d, out);
    const a = this.nv(), r = this.nv();
    out.push(a + ' = ' + this.get(d, sz) + '; ' + r + ' = (' + a + (dec ? ' - 1' : ' + 1') + ') | 0;');
    out.push(this.put(d, r));
    if (ins.emit) {
      let cf = '0';
      if (ins.liveAfter & F_C) { cf = this.nv(); out.push(cf + ' = ' + this.cfExpr() + ';'); }
      const A = this.nv(), Rr = this.nv();
      out.push(A + ' = ' + (sh ? a + ' << ' + sh : a) + '; ' + Rr + ' = ' + (sh ? r + ' << ' + sh : r) + ';');
      out.push('c.fo = ' + fo(dec ? K.FO_DEC : K.FO_INC, idx) + '; c.fa = ' + A + '; c.fb = ' + (1 << sh) + '; c.fr = ' + Rr + '; c.fx = ' + cf + ';');
      this.desc = { k: 'res', r: Rr };
    }
    return out.join('\n');
  };
  P.op_inc = function (ins) { return this.incdec(ins, false); };
  P.op_dec = function (ins) { return this.incdec(ins, true); };
  P.op_neg = function (ins) {
    const sz = ins.sz, sh = SH[sz], idx = IDX[sz], out = [];
    const d = this.bind(ins.d, out);
    const a = this.nv(), r = this.nv();
    out.push(a + ' = ' + this.get(d, sz) + '; ' + r + ' = (0 - ' + a + ') | 0;');
    out.push(this.put(d, r));
    if (ins.emit) {
      const B = this.nv(), Rr = this.nv();
      out.push(B + ' = ' + (sh ? a + ' << ' + sh : a) + '; ' + Rr + ' = (0 - ' + B + ') | 0;');
      out.push('c.fo = ' + fo(K.FO_SUB, idx) + '; c.fa = 0; c.fb = ' + B + '; c.fr = ' + Rr + ';');
      this.desc = { k: 'sub', a: '0', b: B, r: Rr };
    }
    return out.join('\n');
  };
  P.op_not = function (ins) {
    const out = []; const d = this.bind(ins.d, out);
    out.push(this.put(d, '~' + this.get(d, ins.sz)));
    return out.join('\n');
  };

  // ---------------------------------------------------------------- shl shr sar
  P.shift = function (ins, kind) {
    const sz = ins.sz, sh = SH[sz], idx = IDX[sz], out = [];
    const imm = ins.s.k === 'i';
    let cnt;
    if (imm) { cnt = String(ins.s.v & 31); if (cnt === '0') return ''; }
    const d = this.bind(ins.d, out);
    if (!imm) { cnt = this.nv(); out.push(cnt + ' = R[1] & 31;'); }
    const a = this.nv(), A = this.nv(), r = this.nv(), rl = this.nv();
    const body = [];
    body.push(a + ' = ' + this.get(d, sz) + ';');
    if (kind === 'shl') {
      body.push(A + ' = ' + (sh ? a + ' << ' + sh : a) + '; ' + rl + ' = ' + A + ' << ' + cnt + ';');
      body.push(this.put(d, sh ? rl + ' >>> ' + sh : rl));
    } else if (kind === 'shr') {
      body.push(r + ' = ' + a + ' >>> ' + cnt + ';');
      body.push(this.put(d, r));
      if (ins.emit) body.push(A + ' = ' + (sh ? a + ' << ' + sh : a) + '; ' + rl + ' = ' + (sh ? r + ' << ' + sh : r + ' | 0') + ';');
    } else {
      body.push(r + ' = ' + (sh ? '((' + a + ' << ' + sh + ') >> ' + sh + ')' : a) + ' >> ' + cnt + ';');
      body.push(this.put(d, r));
      if (ins.emit) body.push(A + ' = ' + (sh ? a + ' << ' + sh : a) + '; ' + rl + ' = ' + (sh ? r + ' << ' + sh : r) + ';');
    }
    if (ins.emit) body.push('c.fo = ' + fo(kind === 'shl' ? K.FO_SHL : kind === 'shr' ? K.FO_SHR : K.FO_SAR, idx) + '; c.fa = ' + A + '; c.fb = ' + cnt + '; c.fr = ' + rl + ';');
    if (imm) out.push(body.join('\n')); else out.push('if (' + cnt + ' !== 0) {\n' + body.join('\n') + '\n}');
    if (ins.emit) this.desc = imm ? { k: 'res', r: rl } : null;
    return out.join('\n');
  };
  P.op_shl = function (ins) { return this.shift(ins, 'shl'); };
  P.op_shr = function (ins) { return this.shift(ins, 'shr'); };
  P.op_sar = function (ins) { return this.shift(ins, 'sar'); };

  // ---------------------------------------------------------------- moves
  P.op_mov = function (ins) { return this.put(ins.d, this.get(ins.s, ins.sz)); };
  P.op_lea = function (ins) { return this.put(ins.d, this.ea(ins.s)); };
  P.op_nop = function () { return ''; };
  P.op_fwait = function () { return ''; };
  P.op_movseg = function (ins) { return this.put(ins.d, '35'); };
  P.op_movzx = function (ins) { return this.put(ins.d, this.get(ins.s, ins.s.sz)); };
  P.op_movsx = function (ins) {
    const v = this.get(ins.s, ins.s.sz), b = ins.s.sz === 8 ? 24 : 16;
    return this.put(ins.d, '((' + v + ') << ' + b + ') >> ' + b);
  };
  P.op_xchg = function (ins) {
    const out = []; const d = this.bind(ins.d, out), s = this.bind(ins.s, out);
    const a = this.nv(), b = this.nv(), sz = ins.sz;
    out.push(a + ' = ' + this.get(d, sz) + '; ' + b + ' = ' + this.get(s, sz) + ';');
    out.push(this.put(d, b)); out.push(this.put(s, a));
    return out.join('\n');
  };
  P.op_cbw = function () { return 'R[0] = (R[0] & -65536) | (((R[0] << 24) >> 24) & 65535);'; };
  P.op_cwde = function () { return 'R[0] = (R[0] << 16) >> 16;'; };
  P.op_cwd = function () { return 'R[2] = (R[2] & -65536) | (((R[0] << 16) >> 31) & 65535);'; };
  P.op_cdq = function () { return 'R[2] = R[0] >> 31;'; };
  P.op_xlat = function () { return 'R[0] = (R[0] & -256) | rd8((R[3] + (R[0] & 255)) | 0);'; };
  P.op_setcc = function (ins) { return this.put(ins.d, '(' + this.condExpr(ins.cc) + ' ? 1 : 0)'); };
  P.op_cmovcc = function (ins) { return 'if (' + this.condExpr(ins.cc) + ') { ' + this.put(ins.d, this.get(ins.s, ins.sz)) + ' }'; };
  P.op_bswap = function (ins) {
    const n = ins.d.n;
    return '{ const t = R[' + n + ']; R[' + n + '] = (t << 24) | ((t & 65280) << 8) | ((t >>> 8) & 65280) | (t >>> 24); }';
  };

  // ---------------------------------------------------------------- stack
  P.op_push = function (ins) { return '{ const t = ' + this.get(ins.s, 32) + '; R[4] = (R[4] - 4) | 0; wr32(R[4], t); }'; };
  P.op_pop = function (ins) { return '{ const t = rd32(R[4]); R[4] = (R[4] + 4) | 0; ' + this.put(ins.d, 't') + ' }'; };
  P.op_leave = function () { return 'R[4] = R[5]; R[5] = rd32(R[4]); R[4] = (R[4] + 4) | 0;'; };
  P.op_pusha = function () { return '{ const t = R[4]; for (let i = 0; i < 8; i++) { R[4] = (R[4] - 4) | 0; wr32(R[4], i === 4 ? t : R[i]); } }'; };
  P.op_popa = function () { return 'for (let i = 7; i >= 0; i--) { const t = rd32(R[4]); R[4] = (R[4] + 4) | 0; if (i !== 4) R[i] = t; }'; };
  P.op_pushf = function () { return '{ R[4] = (R[4] - 4) | 0; wr32(R[4], c.getFlags()); }'; };
  P.op_popf = function () { this.desc = null; return '{ const t = rd32(R[4]); R[4] = (R[4] + 4) | 0; c.setFlags(t); }'; };

  // ---------------------------------------------------------------- control flow
  P.op_jmp = function (ins) { return 'c.eip = ' + ins.t + ';'; };
  P.op_jcc = function (ins) { return 'c.eip = ' + this.condExpr(ins.cc) + ' ? ' + ins.t + ' : ' + (ins.a + ins.len) + ';'; };
  P.op_call = function (ins) { return '{ const sp = (R[4] - 4) | 0; R[4] = sp; wr32(sp, ' + (ins.a + ins.len) + '); c.eip = ' + ins.t + '; }'; };
  P.op_calli = function (ins) { return '{ const t = ' + this.get(ins.s, 32) + '; const sp = (R[4] - 4) | 0; R[4] = sp; wr32(sp, ' + (ins.a + ins.len) + '); c.eip = t; }'; };
  P.op_jmpi = function (ins) { return 'c.eip = ' + this.get(ins.s, 32) + ';'; };
  P.op_ret = function (ins) { return '{ const sp = R[4]; c.eip = rd32(sp); R[4] = (sp + ' + (4 + ins.s.v) + ') | 0; }'; };
  P.op_jecxz = function (ins) { return 'c.eip = R[1] === 0 ? ' + ins.t + ' : ' + (ins.a + ins.len) + ';'; };
  P.op_loop = function (ins) {
    const nx = ins.a + ins.len;
    const extra = ins.cc === 0xE1 ? ' && c.zf() === 1' : ins.cc === 0xE0 ? ' && c.zf() === 0' : '';
    return 'R[1] = (R[1] - 1) | 0; c.eip = (R[1] !== 0' + extra + ') ? ' + ins.t + ' : ' + nx + ';';
  };
  P.op_hlt = function (ins) { return 'throw new Error("hlt at 0x' + (ins.a >>> 0).toString(16) + '");'; };
  P.op_int3 = function (ins) { return 'throw new Error("int3 at 0x' + (ins.a >>> 0).toString(16) + '");'; };
  P.op_int = function (ins) { return 'throw new Error("int 0x' + ins.s.v.toString(16) + ' at 0x' + (ins.a >>> 0).toString(16) + '");'; };
  P.op_ud2 = function (ins) { return 'throw new Error("ud2 at 0x' + (ins.a >>> 0).toString(16) + '");'; };
  P.op_bad = function (ins) { return 'throw new Error(' + JSON.stringify('undecodable: ' + ins.msg) + ');'; };
  P.op_cld = function () { return 'c.df = 0;'; };
  P.op_std = function () { return 'c.df = 1;'; };
})(typeof globalThis !== 'undefined' ? globalThis : this);
