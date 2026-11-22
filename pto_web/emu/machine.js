/* Machine: guest memory map, allocator, handles, threads, API trap registry, PE loader.
 * Win32/DirectX stand-ins register themselves through m.def(dll, name, argCount, fn).
 */
(function (G) {
  'use strict';
  const EMU = G.EMU = G.EMU || {};
  const { IMG_BASE, TRAP_BASE } = EMU.consts;

  const TIB_MAIN = 0x10000, PEB = 0x11000, SCRATCH = 0x12000, SCRATCH_END = 0x200000;
  const HEAP_START = 0x01000000;

  class HostExit extends Error { constructor(code) { super('process exit ' + code); this.hostStop = true; this.code = code; } }
  class HostIdle extends Error { constructor(wakeAt) { super('idle'); this.hostStop = true; this.wakeAt = wakeAt; } }

  class Machine {
    constructor(opts) {
      opts = opts || {};
      this.opts = opts;
      this.cpu = new EMU.CPU(opts.memBytes || 192 * 1024 * 1024);
      this.vfs = opts.vfs || null;
      this.logf = opts.log || ((s) => console.log(s));
      this.trace = !!opts.trace;
      this.traceLimit = opts.traceLimit || 400;
      this.traceSkip = new Set(opts.traceSkip || []);
      this.apis = new Map();           // 'dll!name' -> {n, fn}
      this.trapAddr = new Map();       // 'dll!name' -> guest address
      this.trapName = new Map();       // guest address -> 'dll!name'
      this.handles = new Map(); this.nextHandle = 0x100;
      this.lastError = 0;
      this.t0 = this.realNow(); this.skew = 0; this.lastYieldAt = 0;
      this.heapBrk = HEAP_START; this.freeLists = new Map();
      this.scratchBrk = SCRATCH;
      this.threads = []; this.cur = null; this.nextTid = 1000;
      this.exited = false; this.exitCode = 0;
      this.modules = new Map();        // lower dll name -> fake HMODULE
      this.nextModule = 0x70000000;
      this.sp = 0;
      this.callCount = 0;
      this.cpu.yieldHook = () => { };
    }

    log(s) { this.logf(s); }
    realNow() { return (typeof performance !== 'undefined' ? performance.now() : Date.now()); }
    now() { return this.realNow() - this.t0 + this.skew; }

    // ------------------------------------------------------------ memory helpers
    rd32(a) { return this.cpu.H.rd32(a); }
    wr32(a, v) { this.cpu.H.wr32(a, v); }
    rd16(a) { return this.cpu.H.rd16(a); }
    wr16(a, v) { this.cpu.H.wr16(a, v); }
    rd8(a) { return this.cpu.u8[a]; }
    wr8(a, v) { this.cpu.u8[a] = v; }
    cstr(a, max) { return a ? this.cpu.cstr(a, max || 4096) : ''; }
    wcstr(a) { let s = ''; for (let i = 0; i < 4096; i++) { const c = this.cpu.u16[(a >> 1) + i]; if (!c) break; s += String.fromCharCode(c); } return s; }
    putStr(a, s) { this.cpu.wstr(a, s); return a; }
    /** permanent small allocation in the scratch area (for strings and fixed structures) */
    scratch(n) { n = (n + 15) & ~15; const a = this.scratchBrk; this.scratchBrk += n; if (this.scratchBrk > SCRATCH_END) throw new Error('scratch exhausted'); return a; }
    scratchStr(s) { const a = this.scratch(s.length + 1); this.putStr(a, s); return a; }
    zero(a, n) { this.cpu.u8.fill(0, a, a + n); }

    // ------------------------------------------------------------ allocator (16 byte aligned, 16 byte header holding the size)
    /** block sizes are rounded up to 16 bytes (small) or to 1/8 steps of a power of two (large): freed blocks can then be reused for similar sizes */
    sizeClass(n) {
      n = (Math.max(n, 1) + 15) & ~15;
      if (n <= 2048) return n;
      const step = (1 << (31 - Math.clz32(n - 1))) >>> 3;
      return Math.ceil(n / step) * step;
    }
    malloc(n, zero) {
      n = this.sizeClass(n);
      const fl = this.freeLists.get(n);
      let a;
      if (fl && fl.length) { a = fl.pop(); this.zero(a, n); return a; }   // recycled blocks are always cleared (deterministic; tolerant of half-loaded objects)
      a = this.heapBrk + 16; this.heapBrk += n + 16;
      if (this.heapBrk >= this.cpu.memSize - 0x10000) throw new Error('guest out of memory (heap ' + (this.heapBrk >> 20) + ' MB)');
      this.cpu.H.wr32(a - 16, n);
      return a;
    }
    free(a) {
      if (!a) return;
      const n = this.cpu.H.rd32(a - 16);
      let fl = this.freeLists.get(n); if (!fl) this.freeLists.set(n, fl = []);
      fl.push(a);
    }
    msize(a) { return this.cpu.H.rd32(a - 16); }
    /** zeroed, 64K aligned region (VirtualAlloc / stacks) */
    valloc(n) {
      n = (n + 0xFFFF) & ~0xFFFF;
      const fl = this.freeLists.get(-n);
      if (fl && fl.length) { const a = fl.pop(); this.zero(a, n); return a; }
      this.heapBrk = (this.heapBrk + 0xFFFF) & ~0xFFFF;
      const a = this.heapBrk; this.heapBrk += n;
      if (this.heapBrk >= this.cpu.memSize - 0x10000) throw new Error('guest out of memory (valloc)');
      return a;
    }
    vfree(a, n) { n = (n + 0xFFFF) & ~0xFFFF; if (!n) return; let fl = this.freeLists.get(-n); if (!fl) this.freeLists.set(-n, fl = []); fl.push(a); }

    // ------------------------------------------------------------ handles
    newHandle(obj) { const h = this.nextHandle; this.nextHandle += 4; obj.handle = h; this.handles.set(h, obj); return h; }
    getHandle(h) { return this.handles.get(h); }
    closeHandle(h) { return this.handles.delete(h); }

    // ------------------------------------------------------------ API registry
    def(dll, name, n, fn) { this.apis.set(dll.toLowerCase() + '!' + name, { n, fn, dll, name }); }
    has(dll, name) { return this.apis.has(dll.toLowerCase() + '!' + name); }
    /** guest address of the trap for an API (created on demand) */
    trapFor(dll, name) {
      const key = dll.toLowerCase() + '!' + name;
      let a = this.trapAddr.get(key);
      if (a) return a;
      const api = this.apis.get(key);
      const m = this, tr = this.trace;
      let fn, n;
      if (!api) {
        n = 0;
        fn = function (c, sp) {
          let args = ''; for (let i = 0; i < 6; i++) args += ' ' + (c.H.rd32(sp + 4 * i) >>> 0).toString(16);
          throw new Error('unimplemented API ' + dll + '!' + name + ' args:' + args + ' ret=0x' + (c.H.rd32(sp - 4) >>> 0).toString(16));
        };
      } else {
        n = api.n; const f = api.fn;
        fn = function (c, sp) {
          m.sp = sp;
          let v;
          if (m.apiStats) m.apiStats[name] = (m.apiStats[name] | 0) + 1;
          switch (n) {
            case 0: v = f(m); break;
            case 1: v = f(m, c.H.rd32(sp)); break;
            case 2: v = f(m, c.H.rd32(sp), c.H.rd32(sp + 4)); break;
            case 3: v = f(m, c.H.rd32(sp), c.H.rd32(sp + 4), c.H.rd32(sp + 8)); break;
            case 4: v = f(m, c.H.rd32(sp), c.H.rd32(sp + 4), c.H.rd32(sp + 8), c.H.rd32(sp + 12)); break;
            default: { const a = new Array(n); for (let i = 0; i < n; i++) a[i] = c.H.rd32(sp + 4 * i); v = f(m, ...a); }
          }
          if (m.trace && m.callCount++ < m.traceLimit && !m.traceSkip.has(name)) {
            let args = ''; for (let i = 0; i < Math.min(n, 8); i++) args += (i ? ', ' : '') + '0x' + (c.H.rd32(sp + 4 * i) >>> 0).toString(16);
            m.log('  [api] ' + name + '(' + args + ') -> ' + (typeof v === 'number' ? '0x' + (v >>> 0).toString(16) : v === undefined ? '' : String(v)));
          }
          if (v === undefined) return undefined;
          if (v === EMU.CPU.NORET) return v;
          if (typeof v === 'boolean') return v ? 1 : 0;
          return v | 0;
        };
      }
      a = this.cpu.addTrap(name, n * 4, fn);
      this.trapAddr.set(key, a); this.trapName.set(a, key);
      return a;
    }
    /** raw trap (COM methods etc.): fn(c, sp) with sp -> first argument */
    rawTrap(name, nArgs, fn) { return this.cpu.addTrap(name, nArgs * 4, fn); }

    moduleHandle(dll) {
      const k = dll.toLowerCase().replace(/\.dll$/, '');
      let h = this.modules.get(k);
      if (!h) { h = this.nextModule; this.nextModule += 0x10000; this.modules.set(k, h); }
      return h;
    }
    moduleName(h) { for (const [k, v] of this.modules) if (v === h) return k; return null; }

    // ------------------------------------------------------------ loader
    load(file, imageName) {
      const c = this.cpu;
      const info = this.info = EMU.PE.parse(file);
      EMU.PE.load(file, info, c.u8);
      this.imageBase = info.base; this.entry = info.base + info.entry;
      this.imagePath = imageName || 'C:\\BEAR\\BEAR.EXE';
      const unresolved = [];
      for (const rec of info.imports) {
        const key = rec.dll.toLowerCase() + '!' + (rec.name || '#' + rec.ord);
        if (!this.apis.has(key)) unresolved.push(key);
        c.H.wr32(rec.iat, this.trapFor(rec.dll, rec.name || '#' + rec.ord));
      }
      this.unresolved = unresolved;
      this.moduleHandle('bear.exe');
      this.modules.set('bear.exe', info.base);
      this.setupProcess();
      return info;
    }

    setupProcess() {
      const c = this.cpu, H = c.H;
      // main thread
      const stackSize = 2 * 1024 * 1024;
      const stack = this.valloc(stackSize);
      this.zero(TIB_MAIN, 0x1000);
      H.wr32(TIB_MAIN + 0x00, -1); H.wr32(TIB_MAIN + 0x04, stack + stackSize); H.wr32(TIB_MAIN + 0x08, stack);
      H.wr32(TIB_MAIN + 0x18, TIB_MAIN); H.wr32(TIB_MAIN + 0x20, 0x4d2); H.wr32(TIB_MAIN + 0x24, 1);
      H.wr32(TIB_MAIN + 0x30, PEB);
      this.zero(PEB, 0x1000);
      const t = { id: 1, handle: this.newHandle({ type: 'thread' }), tib: TIB_MAIN, state: 'ready', ctx: null, name: 'main', main: true };
      this.handles.get(t.handle).t = t;
      this.threads.push(t); this.cur = t;
      c.fsBase = TIB_MAIN;
      c.R.fill(0);
      c.R[4] = stack + stackSize - 64;
      c.eip = this.entry;
      c.setFlags(0x202);
    }

    // ------------------------------------------------------------ threads (cooperative; switched only at API calls at depth 0)
    saveCtx() {
      const c = this.cpu;
      return { R: c.R.slice(), eip: c.eip, fo: c.fo, fa: c.fa, fb: c.fb, fr: c.fr, fx: c.fx, df: c.df, st: c.st.slice(), top: c.top, fsw: c.fsw, fcw: c.fcw, fsBase: c.fsBase };
    }
    loadCtx(x) {
      const c = this.cpu;
      c.R.set(x.R); c.eip = x.eip; c.fo = x.fo; c.fa = x.fa; c.fb = x.fb; c.fr = x.fr; c.fx = x.fx; c.df = x.df;
      c.st.set(x.st); c.top = x.top; c.fsw = x.fsw; c.fcw = x.fcw; c.fsBase = x.fsBase;
    }
    createThread(start, param, stackSize, suspended) {
      const c = this.cpu, H = c.H;
      stackSize = Math.max(stackSize || 0, 256 * 1024);
      const stack = this.valloc(stackSize);
      const tib = this.valloc(0x1000);
      const id = this.nextTid++;
      H.wr32(tib, -1); H.wr32(tib + 4, stack + stackSize); H.wr32(tib + 8, stack); H.wr32(tib + 0x18, tib); H.wr32(tib + 0x20, 0x4d2); H.wr32(tib + 0x24, id); H.wr32(tib + 0x30, PEB);
      let sp = stack + stackSize - 64;
      sp -= 4; H.wr32(sp, param); sp -= 4; H.wr32(sp, this.threadExitTrap());
      const t = { id, tib, state: suspended ? 'suspended' : 'ready', name: 't' + id };
      t.handle = this.newHandle({ type: 'thread', t });
      const R = new Int32Array(8); R[4] = sp;
      t.ctx = { R, eip: start, fo: 0, fa: 0x202, fb: 0, fr: 0, fx: 0, df: 0, st: new Float64Array(8), top: 0, fsw: 0, fcw: 0x37F, fsBase: tib };
      this.threads.push(t);
      return t;
    }
    threadExitTrap() {
      if (!this._thrExit) {
        const m = this;
        this._thrExit = this.cpu.addTrap('ThreadExit', 0, (c, sp) => { m.endThread(m.cpu.R[0]); return EMU.CPU.NORET; }, { noRet: true });
      }
      return this._thrExit;
    }
    endThread(code) {
      const t = this.cur;
      if (t.main) throw new HostExit(code);
      t.state = 'done'; t.exitCode = code;
      this.switchAway(true);
    }
    runnable(t) {
      if (t.state === 'ready') return true;
      if (t.state === 'blocked') {
        if (t.waitUntil !== undefined && this.now() >= t.waitUntil) return true;
        if (t.waitObj && this.isSignaled(t.waitObj)) return true;
        if (t.waitFn && t.waitFn()) return true;
      }
      return false;
    }
    isSignaled(o) {
      switch (o.type) {
        case 'event': return o.signaled;
        case 'sem': return o.count > 0;
        case 'thread': return o.t.state === 'done';
        default: return true;
      }
    }
    /** pick another runnable thread and load its context; the current thread's context must already be saved (or be dead). Returns false if none. */
    switchAway(dead) {
      const n = this.threads.length;
      let i = this.threads.indexOf(this.cur);
      for (let k = 1; k <= n; k++) {
        const t = this.threads[(i + k) % n];
        if (t === this.cur && !dead) { /* may re-pick itself last */ }
        if (t.state !== 'done' && t.state !== 'suspended' && this.runnable(t)) {
          if (t === this.cur) { t.state = 'ready'; return true; }
          this.cur = t; this.loadCtx(t.ctx); t.state = 'ready';
          return true;
        }
      }
      return false;
    }
    /** Time slicing: the running thread has had its turn without waiting for anything (the host calls this between slices of guest code, at
     *  depth 0); the next thread that can run gets the processor, as it would on Windows.  Without this a thread that works for a long time
     *  without ever calling Sleep or a wait function (a loader decoding pictures in the background) keeps the program's other threads,
     *  among them the one that draws the game, from running until it is done. */
    preempt() {
      if (this.threads.length < 2 || this.cpu.depth !== 0 || this.exited) return false;
      const t = this.cur;
      t.ctx = this.saveCtx(); t.state = 'ready';
      this.switchAway(false);
      return this.cur !== t;
    }
    /** block the current thread so that the API trap at 'trapEip' re-executes when it is runnable again; returns NORET */
    blockCurrent(trapEip, spAtCall, obj, untilMs, waitFn) {
      const c = this.cpu, t = this.cur;
      if (c.depth > 0) return this.blockNested(obj, untilMs);
      t.state = 'blocked'; t.waitObj = obj || null; t.waitUntil = untilMs; t.waitFn = waitFn || null;
      c.eip = trapEip; c.R[4] = spAtCall;
      t.ctx = this.saveCtx();
      // find somebody else; if nobody can run, idle until the earliest wake time
      for (; ;) {
        if (this.switchAway(false)) break;
        this.idle(t);
        if (this.exited) break;
      }
      return EMU.CPU.NORET;
    }
    blockNested(obj, untilMs) {
      // blocking while the host is inside a nested guest call: cannot switch threads; just let time pass
      if (untilMs !== undefined && isFinite(untilMs)) this.idleUntil(untilMs);
      return 0x102;
    }
    /** nobody is runnable: advance (virtual) time to the earliest deadline */
    idle() {
      let next = Infinity;
      for (const t of this.threads) if (t.state === 'blocked' && t.waitUntil !== undefined && t.waitUntil < next) next = t.waitUntil;
      if (!isFinite(next)) throw new HostIdle(undefined);
      if (this.realtime && this.cpu.depth === 0) throw new HostIdle(next);
      this.idleUntil(next);
    }
    idleUntil(ms) {
      const d = ms - this.now();
      if (d > 0) this.skew += d;
    }

    // ------------------------------------------------------------ run
    /** run the current guest thread for up to 'blocks' basic blocks (stops early on a yield request) */
    step(blocks) {
      const c = this.cpu;
      c.yieldNow = false;
      try { c.run(blocks); }
      catch (e) {
        if (e instanceof HostExit) { this.exited = true; this.exitCode = e.code; return false; }
        if (e instanceof HostIdle) { this.idleWake = e.wakeAt; this.idling = true; return true; }
        throw e;
      }
      this.idling = false;
      if (c.yieldNow) { c.yieldNow = false; this.onYield(); }
      return !this.exited;
    }
    /** called when the guest yields (message loop polling, sleep): let other threads run */
    onYield() {
      this.lastYieldAt = this.now();
      const t = this.cur;
      if (this.threads.length > 1) {
        t.ctx = this.saveCtx(); t.state = 'ready';
        this.switchAway(false);
      }
      if (this.yieldHook) this.yieldHook();
    }
    run(maxSteps) {
      for (let i = 0; i < maxSteps && !this.exited; i++) this.step(200000);
      return this.exited;
    }
  }

  EMU.Machine = Machine;
  EMU.HostExit = HostExit; EMU.HostIdle = HostIdle;
  EMU.mem = { TIB_MAIN, PEB, SCRATCH, SCRATCH_END, HEAP_START };
})(typeof globalThis !== 'undefined' ? globalThis : this);
