/* x86-32 CPU: block JIT (x86 -> JavaScript) with lazy flags and an x87 FPU.
 *
 *   const cpu = new EMU.CPU(memBytes)
 *   cpu.u8 / cpu.i32 : guest memory (absolute addresses)
 *   cpu.R : Int32Array(8) EAX ECX EDX EBX ESP EBP ESI EDI ; cpu.eip
 *   cpu.addTrap(name, argBytes, fn) -> guest address ; fn(cpu, sp) where sp points at the first argument
 *   cpu.run(maxBlocks)   cpu.callGuest(addr, args)
 */
(function (G) {
  'use strict';
  const EMU = G.EMU = G.EMU || {};

  const IMG_BASE = 0x400000, IMG_SPAN = 0x300000;          // the program image (up to 3 MB) is compiled into a flat block table
  const TRAP_BASE = 0x00800000, TRAP_END = 0x00880000;
  const EXIT_STUB = 0x00800000;           // trap slot 0
  const FO_EFL = 0, FO_ADD = 1, FO_ADC = 2, FO_SUB = 3, FO_SBB = 4, FO_LOGIC = 5, FO_INC = 6, FO_DEC = 7, FO_SHL = 8, FO_SHR = 9, FO_SAR = 10;
  const SHIFTS = [0, 16, 24];            // left shift that aligns a value of size idx (0=32,1=16,2=8) to bit 31
  const PARITY = new Uint8Array(256);
  for (let i = 0; i < 256; i++) { let p = 0, v = i; while (v) { p ^= v & 1; v >>= 1; } PARITY[i] = p ? 0 : 1; }

  class GuestError extends Error { }

  class CPU {
    constructor(memBytes) {
      this.memSize = memBytes;
      this.buf = new ArrayBuffer(memBytes);
      this.u8 = new Uint8Array(this.buf);
      this.u16 = new Uint16Array(this.buf);
      this.i32 = new Int32Array(this.buf);
      this.f32 = new Float32Array(this.buf);
      this.dv = new DataView(this.buf);
      this.R = new Int32Array(8);
      this.eip = 0;
      // lazy flags
      this.fo = FO_EFL; this.fa = 0x202; this.fb = 0; this.fr = 0; this.fx = 0;
      this.df = 0;
      this.fsBase = 0;
      // x87
      this.st = new Float64Array(8); this.top = 0; this.fsw = 0; this.fcw = 0x037F; this.tagw = 0xFFFF;
      this.hi = 0;
      this.blocks = new Array(IMG_SPAN);
      this.dyn = new Map(); this.watch = null; this.codePage = new Uint8Array((memBytes >> 12) + 1); this.pageBlocks = new Map();
      this.traps = [null];
      this.stopped = false;
      this.depth = 0; this.yieldNow = false;
      this.trapStats = null;                 // debug: { trap name: calls } while it is an object
      this.nestedHook = null;                // called now and then while the host is inside a call into guest code (see callGuest)
      this.recent = new Int32Array(64); this.recentPos = 0;
      this.onFault = null;
      this.insCount = 0;
      this.makeHelpers();
      // trap 0 = return-to-host stub
      this.traps[0] = { name: 'EXIT_STUB', n: 0, fn: () => { this.stopped = true; return undefined; }, noRet: true };
    }

    // ---------------------------------------------------------------- memory helpers
    makeHelpers() {
      const U8 = this.u8, I32 = this.i32, SIZE = this.memSize, self = this, CP = this.codePage;
      function fault(a, what) { throw new GuestError('bad memory ' + what + ' at 0x' + (a >>> 0).toString(16) + ' eip=0x' + (self.curEip >>> 0).toString(16)); }
      this.H = {
        rd8: function (a) { const v = U8[a]; if (v === undefined) fault(a, 'read8'); return v; },
        rd16: function (a) { if (a + 1 >= SIZE || a < 0) fault(a, 'read16'); return U8[a] | (U8[a + 1] << 8); },
        rd32: function (a) {
          if ((a & 3) === 0) { const v = I32[a >> 2]; if (v === undefined) fault(a, 'read32'); return v; }
          if (a + 3 >= SIZE || a < 0) fault(a, 'read32');
          return U8[a] | (U8[a + 1] << 8) | (U8[a + 2] << 16) | (U8[a + 3] << 24);
        },
        wr8: function (a, v) { if (a >= SIZE || a < 0) fault(a, 'write8'); U8[a] = v; if (CP[a >>> 12] !== 0) self.invalidate(a >>> 12); },
        wr16: function (a, v) { if (a + 1 >= SIZE || a < 0) fault(a, 'write16'); U8[a] = v; U8[a + 1] = v >> 8; if ((CP[a >>> 12] | CP[(a + 1) >>> 12]) !== 0) self.noteWrite(a, 2); },
        wr32: function (a, v) {
          if ((a & 3) === 0) { if (a >= SIZE || a < 0) fault(a, 'write32'); I32[a >> 2] = v; if (CP[a >>> 12] !== 0) self.invalidate(a >>> 12); return; }
          if (a + 3 >= SIZE || a < 0) fault(a, 'write32');
          U8[a] = v; U8[a + 1] = v >> 8; U8[a + 2] = v >> 16; U8[a + 3] = v >> 24;
          if ((CP[a >>> 12] | CP[(a + 3) >>> 12]) !== 0) self.noteWrite(a, 4);
        },
      };
    }
    rd8(a) { return this.H.rd8(a); }
    rd16(a) { return this.H.rd16(a); }
    rd32(a) { return this.H.rd32(a); }
    wr8(a, v) { this.H.wr8(a, v); }
    wr16(a, v) { this.H.wr16(a, v); }
    wr32(a, v) { this.H.wr32(a, v); }
    arg(sp, i) { return this.H.rd32(sp + 4 * i); }
    cstr(a, max = 4096) { let s = ''; for (let i = 0; i < max; i++) { const b = this.u8[a + i]; if (!b) break; s += String.fromCharCode(b); } return s; }
    wstr(a, s) { for (let i = 0; i < s.length; i++) this.u8[a + i] = s.charCodeAt(i) & 255; this.u8[a + s.length] = 0; }
    wbytes(a, bytes) { this.u8.set(bytes, a); }

    // ---------------------------------------------------------------- traps / API entry points
    addTrap(name, n, fn, opts) {
      const idx = this.traps.length;
      this.traps.push(Object.assign({ name, n, fn }, opts || {}));
      return TRAP_BASE + idx * 16;
    }

    // ---------------------------------------------------------------- flags
    cf() {
      switch (this.fo >> 2) {
        case FO_EFL: return this.fa & 1;
        case FO_ADD: return (this.fr >>> 0) < (this.fa >>> 0) ? 1 : 0;
        case FO_ADC: return (this.fx ? (this.fr >>> 0) <= (this.fa >>> 0) : (this.fr >>> 0) < (this.fa >>> 0)) ? 1 : 0;
        case FO_SUB: return (this.fa >>> 0) < (this.fb >>> 0) ? 1 : 0;
        case FO_SBB: return (this.fx ? (this.fa >>> 0) <= (this.fb >>> 0) : (this.fa >>> 0) < (this.fb >>> 0)) ? 1 : 0;
        case FO_LOGIC: return 0;
        case FO_INC: case FO_DEC: return this.fx;
        case FO_SHL: { const c = this.fb; return c > 32 ? 0 : (this.fa >>> (32 - c)) & 1; }
        case FO_SHR: { const sh = SHIFTS[this.fo & 3], c = this.fb; return c > 32 - sh ? 0 : (this.fa >>> (sh + c - 1)) & 1; }
        case FO_SAR: { const sh = SHIFTS[this.fo & 3]; const p = Math.min(31, sh + this.fb - 1); return (this.fa >>> p) & 1; }
      }
      return 0;
    }
    zf() { return (this.fo >> 2) === FO_EFL ? (this.fa >> 6) & 1 : (this.fr === 0 ? 1 : 0); }
    sf() { return (this.fo >> 2) === FO_EFL ? (this.fa >> 7) & 1 : (this.fr < 0 ? 1 : 0); }
    of() {
      switch (this.fo >> 2) {
        case FO_EFL: return (this.fa >> 11) & 1;
        case FO_ADD: case FO_ADC: case FO_INC: return (((this.fa ^ this.fr) & (this.fb ^ this.fr)) < 0) ? 1 : 0;
        case FO_SUB: case FO_SBB: case FO_DEC: return (((this.fa ^ this.fb) & (this.fa ^ this.fr)) < 0) ? 1 : 0;
        case FO_SHL: return ((this.fr < 0) ? 1 : 0) ^ this.cf();
        case FO_SHR: return this.fa < 0 ? 1 : 0;
        default: return 0;
      }
    }
    pf() {
      if ((this.fo >> 2) === FO_EFL) return (this.fa >> 2) & 1;
      return PARITY[(this.fr >>> SHIFTS[this.fo & 3]) & 255];
    }
    af() { return (this.fo >> 2) === FO_EFL ? (this.fa >> 4) & 1 : 0; }
    cond(cc) {
      switch (cc) {
        case 0: return this.of() === 1; case 1: return this.of() === 0;
        case 2: return this.cf() === 1; case 3: return this.cf() === 0;
        case 4: return this.zf() === 1; case 5: return this.zf() === 0;
        case 6: return this.cf() === 1 || this.zf() === 1; case 7: return this.cf() === 0 && this.zf() === 0;
        case 8: return this.sf() === 1; case 9: return this.sf() === 0;
        case 10: return this.pf() === 1; case 11: return this.pf() === 0;
        case 12: return this.sf() !== this.of(); case 13: return this.sf() === this.of();
        case 14: return this.zf() === 1 || this.sf() !== this.of();
        case 15: return this.zf() === 0 && this.sf() === this.of();
      }
      return false;
    }
    getFlags() {
      return (this.cf() | (this.pf() << 2) | (this.af() << 4) | (this.zf() << 6) | (this.sf() << 7) | (this.df << 10) | (this.of() << 11) | 0x202) | 0;
    }
    setFlags(v) { this.fo = FO_EFL; this.fa = v & 0xFFF; this.df = (v >> 10) & 1; }
    /** set explicit flags: cf, zf, sf, of, pf */
    setEfl(cf, zf, sf, of, pf) { this.fo = FO_EFL; this.fa = cf | (pf << 2) | (zf << 6) | (sf << 7) | (of << 11) | 0x202; }
    setCF(v) { const f = this.getFlags(); this.fo = FO_EFL; this.fa = (f & ~1) | (v & 1); }

    // ---------------------------------------------------------------- compile
    invalidate(page) {
      const set = this.pageBlocks.get(page);
      if (set) { for (const a of set) this.dyn.delete(a); this.pageBlocks.delete(page); }
      this.codePage[page] = 0;
    }
    noteWrite(a, n) {
      for (let p = a >>> 12, e = (a + n - 1) >>> 12; p <= e; p++) if (this.codePage[p] !== 0) this.invalidate(p);
    }
    compile(eip) {
      const idx = eip - IMG_BASE;
      const dynamic = idx < 0 || idx >= IMG_SPAN;
      if (dynamic && (eip < 0x10000 || eip >= this.memSize)) {
        throw new GuestError('execution outside memory: eip=0x' + (eip >>> 0).toString(16) + this.recentDump());
      }
      const g = new EMU.Gen(this, eip);
      const src = g.run();
      let fn;
      try {
        fn = new Function('c', 'H', 'FS', '"use strict";const R=c.R,U8=c.u8,I32=c.i32,rd8=H.rd8,rd16=H.rd16,rd32=H.rd32,wr8=H.wr8,wr16=H.wr16,wr32=H.wr32;return function(){' + src + '}')(this, this.H, this.fsBase);
      } catch (e) {
        throw new Error('JIT compile error at 0x' + eip.toString(16) + ': ' + e.message + '\n' + src);
      }
      fn.src = src; fn.insCount = g.count; fn.end = g.endAddr;
      if (!dynamic) { this.blocks[idx] = fn; return fn; }
      this.dyn.set(eip, fn);
      for (let p = eip >>> 12, e = (g.endAddr - 1) >>> 12; p <= e; p++) {
        this.codePage[p] = 1;
        let set = this.pageBlocks.get(p); if (!set) this.pageBlocks.set(p, set = new Set());
        set.add(eip);
      }
      return fn;
    }

    recentDump() {
      const out = [];
      for (let i = 0; i < 24; i++) out.push((this.recent[(this.recentPos - 1 - i) & 63] >>> 0).toString(16));
      return '\n recent blocks (newest first): ' + out.join(' ');
    }

    // ---------------------------------------------------------------- run
    /** run up to maxBlocks basic blocks; returns true if the guest returned to the host stub */
    run(maxBlocks) {
      const blocks = this.blocks, recent = this.recent;
      let n = maxBlocks;
      this.stopped = false;
      while (n-- > 0) {
        const eip = this.eip;
        if (this.watch !== null) { const w = this.watch.get(eip); if (w !== undefined) w(this); }
        const bi = eip - IMG_BASE;
        let b = (bi >= 0 && bi < IMG_SPAN) ? blocks[bi] : this.dyn.get(eip);
        if (b === undefined) {
          if (eip >= TRAP_BASE && eip < TRAP_END) { this.doTrap(eip); if (this.stopped) return true; if (this.yieldNow) return false; continue; }
          b = this.compile(eip);
        }
        this.curEip = eip;
        recent[this.recentPos & 63] = eip; this.recentPos++;
        b();
      }
      return false;
    }

    doTrap(eip) {
      const idx = (eip - TRAP_BASE) >> 4;
      const t = this.traps[idx];
      if (!t) throw new GuestError('jump to unknown trap 0x' + eip.toString(16));
      if (this.trapStats !== null) this.trapStats[t.name] = (this.trapStats[t.name] | 0) + 1;
      const R = this.R, sp = R[4];
      const ret = this.H.rd32(sp);
      this.curEip = eip;
      let v;
      try { v = t.fn(this, sp + 4); }
      catch (e) { if (e && e.hostStop) throw e; throw e; }
      if (t.noRet || v === CPU.NORET) return;
      if (v !== undefined) R[0] = v | 0;
      R[4] = (sp + 4 + t.n) | 0;
      this.eip = ret;
    }

    /** call a guest function (stdcall/cdecl-agnostic: caller supplies args; we restore ESP) and return EAX */
    callGuest(addr, args, thisPtr) {
      const R = this.R;
      const savedEip = this.eip, savedSp = R[4];
      const saved = [R[1], R[2], R[3], R[5], R[6], R[7]];
      const savedEax = R[0], savedFl = [this.fo, this.fa, this.fb, this.fr, this.fx, this.df];
      let sp = savedSp;
      for (let i = args.length - 1; i >= 0; i--) { sp -= 4; this.H.wr32(sp, args[i]); }
      sp -= 4; this.H.wr32(sp, EXIT_STUB);
      R[4] = sp;
      if (thisPtr !== undefined) R[1] = thisPtr;
      this.eip = addr;
      this.depth++;
      try {
        // (with a nestedHook the guest runs in shorter pieces: a loop of its own in here - a program that waits for something while it keeps
        //  drawing - must not stop the page from getting pictures and sound)
        const hook = this.nestedHook;
        while (!this.run(hook ? 100000 : 2000000)) { this.yieldNow = false; if (this.yieldHook) this.yieldHook(); if (hook) hook(); }
      } finally { this.depth--; }
      const ret = R[0];
      this.eip = savedEip; R[4] = savedSp;
      R[1] = saved[0]; R[2] = saved[1]; R[3] = saved[2]; R[5] = saved[3]; R[6] = saved[4]; R[7] = saved[5];
      if (!this.keepEax) R[0] = savedEax;
      this.fo = savedFl[0]; this.fa = savedFl[1]; this.fb = savedFl[2]; this.fr = savedFl[3]; this.fx = savedFl[4]; this.df = savedFl[5];
      this.stopped = false;
      return ret;
    }

    // ---------------------------------------------------------------- x87
    fpush(v) { this.top = (this.top - 1) & 7; this.st[this.top] = v; }
    fpop() { const v = this.st[this.top]; this.top = (this.top + 1) & 7; return v; }
    fget(i) { return this.st[(this.top + i) & 7]; }
    fset(i, v) { this.st[(this.top + i) & 7] = v; }
    getFsw() { return (this.fsw & ~0x3800) | (this.top << 11); }
    fround(v) {
      switch ((this.fcw >> 10) & 3) {
        case 0: { const r = Math.round(v); return (Math.abs(v % 1) === 0.5 && r % 2 !== 0) ? r - 1 : r; }
        case 1: return Math.floor(v);
        case 2: return Math.ceil(v);
        default: return Math.trunc(v);
      }
    }
    fcompare(a, b) {
      let c0 = 0, c2 = 0, c3 = 0;
      if (a !== a || b !== b) { c0 = c2 = c3 = 1; } else if (a > b) { } else if (a < b) c0 = 1; else c3 = 1;
      this.fsw = (this.fsw & ~0x4500) | (c0 << 8) | (c2 << 10) | (c3 << 14);
    }
    fcomi(a, b) {
      let cf = 0, zf = 0, pf = 0;
      if (a !== a || b !== b) { cf = zf = pf = 1; } else if (a < b) cf = 1; else if (a === b) zf = 1;
      const f = this.getFlags();
      this.fo = FO_EFL; this.fa = (f & ~0x45) | cf | (pf << 2) | (zf << 6);
    }
    farith(r, dst, src, isDstSt0) {
      // r: 0 add 1 mul 4 sub 5 subr 6 div 7 divr ; dst/src: values; returns value
      switch (r) {
        case 0: return dst + src;
        case 1: return dst * src;
        case 4: return dst - src;
        case 5: return src - dst;
        case 6: return dst / src;
        case 7: return src / dst;
      }
      return NaN;
    }
    /** x87 instruction with a memory operand: o = opcode D8..DF, r = modrm reg field, ea = address */
    fpuMem(o, r, ea) {
      const H = this.H, dv = this.dv;
      let v;
      switch (o) {
        case 0xD8: case 0xDC: {
          v = o === 0xD8 ? dv.getFloat32(ea, true) : dv.getFloat64(ea, true);
          return this.fpuArithSt0(r, v);
        }
        case 0xDA: case 0xDE: {
          v = o === 0xDA ? H.rd32(ea) : (H.rd16(ea) << 16 >> 16);
          return this.fpuArithSt0(r, v);
        }
        case 0xD9:
          switch (r) {
            case 0: this.fpush(dv.getFloat32(ea, true)); return;
            case 2: dv.setFloat32(ea, this.fget(0), true); return;
            case 3: dv.setFloat32(ea, this.fpop(), true); return;
            case 4: return; // fldenv
            case 5: this.fcw = H.rd16(ea); return;
            case 6: this.fnstenv(ea); return;
            case 7: H.wr16(ea, this.fcw); return;
          }
          break;
        case 0xDB:
          switch (r) {
            case 0: this.fpush(H.rd32(ea)); return;
            case 1: this.fistStore(ea, 32, true, true); return;
            case 2: this.fistStore(ea, 32, false, false); return;
            case 3: this.fistStore(ea, 32, true, false); return;
            case 5: this.fpush(this.readF80(ea)); return;
            case 7: this.writeF80(ea, this.fpop()); return;
          }
          break;
        case 0xDD:
          switch (r) {
            case 0: this.fpush(dv.getFloat64(ea, true)); return;
            case 1: this.fistStore(ea, 64, true, true); return;
            case 2: dv.setFloat64(ea, this.fget(0), true); return;
            case 3: dv.setFloat64(ea, this.fpop(), true); return;
            case 4: return; // frstor
            case 6: this.fnstenv(ea); return; // fnsave (approx)
            case 7: H.wr16(ea, this.getFsw()); return;
          }
          break;
        case 0xDF:
          switch (r) {
            case 0: this.fpush(H.rd16(ea) << 16 >> 16); return;
            case 1: this.fistStore(ea, 16, true, true); return;
            case 2: this.fistStore(ea, 16, false, false); return;
            case 3: this.fistStore(ea, 16, true, false); return;
            case 5: { const lo = H.rd32(ea) >>> 0, hi = H.rd32(ea + 4); this.fpush(hi * 4294967296 + lo); return; }
            case 7: this.fistStore(ea, 64, true, false); return;
          }
          break;
      }
      throw new GuestError('unsupported x87 memory op ' + o.toString(16) + ' /' + r);
    }
    fnstenv(ea) {
      const H = this.H;
      H.wr32(ea, this.fcw); H.wr32(ea + 4, this.getFsw()); H.wr32(ea + 8, 0xFFFF);
      for (let i = 12; i < 28; i += 4) H.wr32(ea + i, 0);
    }
    fistStore(ea, bits, pop, trunc) {
      let v = this.fget(0);
      v = trunc ? Math.trunc(v) : this.fround(v);
      if (pop) this.fpop();
      const H = this.H;
      if (bits === 16) { if (!(v >= -32768 && v <= 32767)) v = -32768; H.wr16(ea, v); }
      else if (bits === 32) { if (!(v >= -2147483648 && v <= 2147483647)) v = -2147483648; H.wr32(ea, v | 0); }
      else {
        if (!(v >= -9223372036854775808 && v < 9223372036854775808)) { H.wr32(ea, 0); H.wr32(ea + 4, -2147483648); return; }
        const neg = v < 0; let m = Math.abs(v);
        let lo = m % 4294967296, hi = Math.floor(m / 4294967296);
        if (neg) { lo = (~lo >>> 0) + 1; hi = (~hi >>> 0) + (lo > 4294967295 ? 1 : 0); lo = lo >>> 0; }
        H.wr32(ea, lo | 0); H.wr32(ea + 4, hi | 0);
      }
    }
    readF80(ea) {
      const H = this.H;
      const lo = H.rd32(ea) >>> 0, hi = H.rd32(ea + 4) >>> 0, se = H.rd16(ea + 8);
      const sign = se & 0x8000 ? -1 : 1, exp = se & 0x7FFF;
      if (exp === 0 && hi === 0 && lo === 0) return sign * 0;
      if (exp === 0x7FFF) return (hi & 0x7FFFFFFF) || lo ? NaN : sign * Infinity;
      const mant = hi * 4294967296 + lo;           // 64-bit integer mantissa (approximated by double)
      return sign * mant * Math.pow(2, exp - 16383 - 63);
    }
    writeF80(ea, v) {
      const H = this.H;
      if (v === 0) { H.wr32(ea, 0); H.wr32(ea + 4, 0); H.wr16(ea + 8, (1 / v < 0) ? 0x8000 : 0); return; }
      if (v !== v) { H.wr32(ea, 0); H.wr32(ea + 4, 0xC0000000 | 0); H.wr16(ea + 8, 0x7FFF); return; }
      const sign = v < 0 ? 0x8000 : 0; v = Math.abs(v);
      if (v === Infinity) { H.wr32(ea, 0); H.wr32(ea + 4, 0x80000000 | 0); H.wr16(ea + 8, sign | 0x7FFF); return; }
      let e = Math.floor(Math.log2(v)); let m = v / Math.pow(2, e);
      if (m >= 2) { m /= 2; e++; } else if (m < 1) { m *= 2; e--; }
      const hi = Math.floor(m * 2147483648), lo = Math.round((m * 2147483648 - hi) * 4294967296);
      H.wr32(ea, lo | 0); H.wr32(ea + 4, (hi | 0x80000000 * 0) | 0 ? (hi | 0) : hi | 0);
      // mantissa top bit explicit: hi holds bits 62..32 with bit 63 = 1
      H.wr32(ea + 4, ((hi >>> 0) | 0x80000000) | 0);
      H.wr16(ea + 8, sign | (e + 16383));
    }
    fpuArithSt0(r, v) {
      const a = this.fget(0);
      switch (r) {
        case 2: this.fcompare(a, v); return;
        case 3: this.fcompare(a, v); this.fpop(); return;
        default: this.fset(0, this.farith(r, a, v));
      }
    }
    /** x87 register-form instruction: o = D8..DF, m = modrm byte (>= 0xC0) */
    fpuReg(o, m) {
      const i = m & 7, r = (m >> 3) & 7;
      switch (o) {
        case 0xD8: {
          const sv = this.fget(i);
          if (r === 2) { this.fcompare(this.fget(0), sv); return; }
          if (r === 3) { this.fcompare(this.fget(0), sv); this.fpop(); return; }
          this.fset(0, this.farith(r, this.fget(0), sv)); return;
        }
        case 0xD9:
          if (m < 0xC8) { this.fpush(this.fget(i)); return; }
          if (m < 0xD0) { const t = this.fget(0); this.fset(0, this.fget(i)); this.fset(i, t); return; }
          switch (m) {
            case 0xD0: return;
            case 0xE0: this.fset(0, -this.fget(0)); return;
            case 0xE1: this.fset(0, Math.abs(this.fget(0))); return;
            case 0xE4: this.fcompare(this.fget(0), 0); return;
            case 0xE5: { const v = this.fget(0); let c0 = 0, c2 = 0, c3 = 0; if (v !== v) c0 = 1; else if (!isFinite(v)) { c0 = 1; c2 = 1; } else if (v === 0) c3 = 1; else c2 = 1; if (v < 0 || (v === 0 && 1 / v < 0)) this.fsw |= 0x200; else this.fsw &= ~0x200; this.fsw = (this.fsw & ~0x4500) | (c0 << 8) | (c2 << 10) | (c3 << 14); return; }
            case 0xE8: this.fpush(1); return;
            case 0xE9: this.fpush(Math.log2(10)); return;
            case 0xEA: this.fpush(Math.LOG2E); return;
            case 0xEB: this.fpush(Math.PI); return;
            case 0xEC: this.fpush(Math.log10(2)); return;
            case 0xED: this.fpush(Math.LN2); return;
            case 0xEE: this.fpush(0); return;
            case 0xF0: this.fset(0, Math.pow(2, this.fget(0)) - 1); return;
            case 0xF1: { const x = this.fget(0), y = this.fget(1); this.fpop(); this.fset(0, y * Math.log2(x)); return; }
            case 0xF2: { this.fset(0, Math.tan(this.fget(0))); this.fpush(1); this.fsw &= ~0x400; return; }
            case 0xF3: { const x = this.fget(0), y = this.fget(1); this.fpop(); this.fset(0, Math.atan2(y, x)); return; }
            case 0xF4: { const v = this.fget(0); const e = v === 0 ? -Infinity : Math.floor(Math.log2(Math.abs(v))); this.fset(0, e); this.fpush(v / Math.pow(2, e)); return; }
            case 0xF5: case 0xF8: { const a = this.fget(0), b = this.fget(1); const q = m === 0xF8 ? Math.trunc(a / b) : this.fround(a / b); const rem = a - q * b; this.fset(0, rem); this.fsw &= ~0x4700; const qi = Math.abs(q) | 0; this.fsw |= ((qi & 4) ? 0x100 : 0) | ((qi & 2) ? 0x4000 : 0) | ((qi & 1) ? 0x200 : 0); return; }
            case 0xF6: this.top = (this.top - 1) & 7; return;
            case 0xF7: this.top = (this.top + 1) & 7; return;
            case 0xF9: { const x = this.fget(0), y = this.fget(1); this.fpop(); this.fset(0, y * Math.log2(x + 1)); return; }
            case 0xFA: this.fset(0, Math.sqrt(this.fget(0))); return;
            case 0xFB: { const v = this.fget(0); this.fset(0, Math.sin(v)); this.fpush(Math.cos(v)); this.fsw &= ~0x400; return; }
            case 0xFC: this.fset(0, this.fround(this.fget(0))); return;
            case 0xFD: this.fset(0, this.fget(0) * Math.pow(2, Math.trunc(this.fget(1)))); return;
            case 0xFE: this.fset(0, Math.sin(this.fget(0))); this.fsw &= ~0x400; return;
            case 0xFF: this.fset(0, Math.cos(this.fget(0))); this.fsw &= ~0x400; return;
          }
          break;
        case 0xDA:
          if (m < 0xE0) { // fcmovcc: b, e, be, u
            const cc = [this.cf() === 1, this.zf() === 1, this.cf() === 1 || this.zf() === 1, this.pf() === 1][r];
            if (cc) this.fset(0, this.fget(i)); return;
          }
          if (m === 0xE9) { this.fcompare(this.fget(0), this.fget(1)); this.fpop(); this.fpop(); return; }
          break;
        case 0xDB:
          if (m < 0xE0) { const cc = [this.cf() === 0, this.zf() === 0, !(this.cf() === 1 || this.zf() === 1), this.pf() === 0][r]; if (cc) this.fset(0, this.fget(i)); return; }
          if (m === 0xE2) { this.fsw &= 0x7F00; return; }
          if (m === 0xE3) { this.fcw = 0x37F; this.fsw = 0; this.top = 0; return; }
          if (m >= 0xE8 && m < 0xF8) { this.fcomi(this.fget(0), this.fget(i)); return; }
          break;
        case 0xDC: {
          const dv = this.fget(i), sv = this.fget(0);
          const rr = r === 4 ? 5 : r === 5 ? 4 : r === 6 ? 7 : r === 7 ? 6 : r;
          this.fset(i, this.farith(rr, dv, sv)); return;
        }
        case 0xDD:
          if (m < 0xD0) return;                      // ffree
          if (m < 0xD8) { this.fset(i, this.fget(0)); return; }
          if (m < 0xE0) { this.fset(i, this.fget(0)); this.fpop(); return; }
          if (m < 0xE8) { this.fcompare(this.fget(0), this.fget(i)); return; }
          if (m < 0xF0) { this.fcompare(this.fget(0), this.fget(i)); this.fpop(); return; }
          break;
        case 0xDE: {
          if (m === 0xD9) { this.fcompare(this.fget(0), this.fget(1)); this.fpop(); this.fpop(); return; }
          const dv = this.fget(i), sv = this.fget(0);
          const rr = r === 4 ? 5 : r === 5 ? 4 : r === 6 ? 7 : r === 7 ? 6 : r;
          this.fset(i, this.farith(rr, dv, sv)); this.fpop(); return;
        }
        case 0xDF:
          if (m === 0xE0) { this.R[0] = (this.R[0] & ~0xFFFF) | this.getFsw(); return; }
          if (m >= 0xE8 && m < 0xF8) { this.fcomi(this.fget(0), this.fget(i)); this.fpop(); return; }
          break;
      }
      throw new GuestError('unsupported x87 op ' + o.toString(16) + ' ' + m.toString(16));
    }

    // ---------------------------------------------------------------- misc helpers used by generated code
    mulu(a, b) {                 // unsigned 32x32 -> lo (returned as int32), hi in this.hi (int32)
      a >>>= 0; b >>>= 0;
      const al = a & 0xFFFF, ah = a >>> 16, bl = b & 0xFFFF, bh = b >>> 16;
      const t = al * bl, m1 = ah * bl + (t >>> 16), m2 = al * bh + (m1 & 0xFFFF);
      this.hi = (ah * bh + (m1 >>> 16) + (m2 >>> 16)) | 0;
      return Math.imul(a, b);
    }
    muls(a, b) {                 // signed
      const lo = this.mulu(a, b);
      let hi = this.hi;
      if (a < 0) hi = (hi - b) | 0;
      if (b < 0) hi = (hi - a) | 0;
      this.hi = hi;
      return lo;
    }
    divu(hi, lo, d) {            // unsigned 64/32 -> quotient (int32); remainder in this.hi
      d >>>= 0;
      if (d === 0) throw new GuestError('divide by zero at 0x' + this.curEip.toString(16));
      hi >>>= 0; lo >>>= 0;
      if (hi === 0) { const q = Math.floor(lo / d); this.hi = (lo - q * d) | 0; return q | 0; }
      const n = (BigInt(hi) << 32n) | BigInt(lo), bd = BigInt(d);
      const q = n / bd;
      if (q > 0xFFFFFFFFn) throw new GuestError('divide overflow');
      this.hi = Number(n % bd) | 0;
      return Number(q) | 0;
    }
    divs(hi, lo, d) {            // signed 64/32
      if (d === 0) throw new GuestError('divide by zero at 0x' + this.curEip.toString(16));
      if (hi === (lo >> 31)) { const q = Math.trunc(lo / d); this.hi = (lo - q * d) | 0; if (q > 2147483647 || q < -2147483648) throw new GuestError('divide overflow'); return q | 0; }
      const n = (BigInt(hi) << 32n) | BigInt(lo >>> 0), bd = BigInt(d);
      const q = n / bd;
      if (q > 2147483647n || q < -2147483648n) throw new GuestError('divide overflow');
      this.hi = Number(n % bd) | 0;
      return Number(q) | 0;
    }
    bsf(v) { return v === 0 ? -1 : 31 - Math.clz32(v & -v); }
    bsr(v) { return v === 0 ? -1 : 31 - Math.clz32(v); }
    shiftFlagsEfl(cf, of, res, sh) { }

    // string instructions ------------------------------------------------------
    strMovs(sz, rep) {
      const R = this.R, H = this.H, step = this.df ? -sz : sz;
      let n = rep ? (R[1] >>> 0) : 1;
      if (!n) return;
      let s = R[6], d = R[7];
      if (!this.df && n > 16 && (d >= s + n * sz || d + n * sz <= s || d < s)) {
        if (d + n * sz <= this.memSize && s + n * sz <= this.memSize && (d >= s + n * sz || d + n * sz <= s)) {
          this.u8.copyWithin(d, s, s + n * sz); this.noteWrite(d, n * sz); R[6] = s + n * sz; R[7] = d + n * sz; if (rep) R[1] = 0; return;
        }
      }
      while (n-- > 0) {
        if (sz === 1) H.wr8(d, H.rd8(s)); else if (sz === 2) H.wr16(d, H.rd16(s)); else H.wr32(d, H.rd32(s));
        s += step; d += step;
      }
      R[6] = s; R[7] = d; if (rep) R[1] = 0;
    }
    strStos(sz, rep) {
      const R = this.R, H = this.H, step = this.df ? -sz : sz;
      let n = rep ? (R[1] >>> 0) : 1;
      if (!n) return;
      let d = R[7]; const v = R[0];
      if (!this.df && sz === 1 && n > 8 && d + n <= this.memSize) { this.u8.fill(v & 255, d, d + n); this.noteWrite(d, n); R[7] = d + n; if (rep) R[1] = 0; return; }
      while (n-- > 0) {
        if (sz === 1) H.wr8(d, v & 255); else if (sz === 2) H.wr16(d, v & 65535); else H.wr32(d, v);
        d += step;
      }
      R[7] = d; if (rep) R[1] = 0;
    }
    strLods(sz, rep) {
      const R = this.R, H = this.H, step = this.df ? -sz : sz;
      let n = rep ? (R[1] >>> 0) : 1;
      while (n-- > 0) {
        const s = R[6];
        if (sz === 1) R[0] = (R[0] & ~255) | H.rd8(s); else if (sz === 2) R[0] = (R[0] & ~65535) | H.rd16(s); else R[0] = H.rd32(s);
        R[6] = s + step;
      }
      if (rep) R[1] = 0;
    }
    strScas(sz, rep) {            // rep: 0 none, 1 repe (F3), 2 repne (F2)
      const R = this.R, H = this.H, step = this.df ? -sz : sz;
      const al = sz === 1 ? R[0] & 255 : sz === 2 ? R[0] & 65535 : R[0];
      let n = rep ? (R[1] >>> 0) : 1;
      if (rep && !n) return;
      let d = R[7], a = 0, b = 0, last = false;
      const sh = sz === 1 ? 24 : sz === 2 ? 16 : 0;
      while (n-- > 0) {
        const m = sz === 1 ? H.rd8(d) : sz === 2 ? H.rd16(d) : H.rd32(d);
        a = al << sh; b = m << sh; last = true;
        d += step;
        if (rep) { R[1] = (R[1] - 1) | 0; }
        const eq = (a === b);
        if (rep === 2 && eq) break;
        if (rep === 1 && !eq) break;
      }
      R[7] = d;
      if (last) { this.fo = (FO_SUB << 2) | (sz === 1 ? 2 : sz === 2 ? 1 : 0); this.fa = a; this.fb = b; this.fr = (a - b) | 0; }
    }
    strCmps(sz, rep) {
      const R = this.R, H = this.H, step = this.df ? -sz : sz;
      let n = rep ? (R[1] >>> 0) : 1;
      if (rep && !n) return;
      let s = R[6], d = R[7], a = 0, b = 0, last = false;
      const sh = sz === 1 ? 24 : sz === 2 ? 16 : 0;
      while (n-- > 0) {
        const x = sz === 1 ? H.rd8(s) : sz === 2 ? H.rd16(s) : H.rd32(s);
        const y = sz === 1 ? H.rd8(d) : sz === 2 ? H.rd16(d) : H.rd32(d);
        a = x << sh; b = y << sh; last = true;
        s += step; d += step;
        if (rep) R[1] = (R[1] - 1) | 0;
        const eq = (a === b);
        if (rep === 2 && eq) break;
        if (rep === 1 && !eq) break;
      }
      R[6] = s; R[7] = d;
      if (last) { this.fo = (FO_SUB << 2) | (sz === 1 ? 2 : sz === 2 ? 1 : 0); this.fa = a; this.fb = b; this.fr = (a - b) | 0; }
    }
  }
  CPU.NORET = { noret: true };

  EMU.CPU = CPU;
  EMU.GuestError = GuestError;
  EMU.consts = { IMG_BASE, IMG_SPAN, TRAP_BASE, TRAP_END, EXIT_STUB, FO_EFL, FO_ADD, FO_ADC, FO_SUB, FO_SBB, FO_LOGIC, FO_INC, FO_DEC, FO_SHL, FO_SHR, FO_SAR, SHIFTS };
})(typeof globalThis !== 'undefined' ? globalThis : this);
