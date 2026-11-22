/* FlashPlayerControl.dll stand-in.
 *
 * The game shows its Flash movies through a window class from this DLL (a wrapper around Adobe's ActiveX player).  It uses the
 * control in two ways, and both are answered here:
 *
 *   - by sending the window private messages (0x14xx / 0x15xx; the numbers were read from the exported wrappers of the DLL that
 *     ships with the game): load a movie from memory, play, current frame, total frames, go to frame.  A movie is over when the
 *     game finds "current frame == total frames - 1".
 *   - by calling exported functions (FPC_LoadMovieA, FPC_Play, FPC_GetVariableA ...); a movie started like that is over when
 *     the movie's variable "finished" is a non-zero number.
 *
 * The movie itself is not run in here.  Each movie has a clock instead: from the frame count and the frame rate in its header the
 * stand-in says which frame the movie would be on, which is all the game looks at.  The page can show the real picture on top of
 * the game's window (Ruffle) and tell us when it has started (`flash.started(id)`); until it does the clock waits.  Without a
 * picture the movie is skipped quickly (`flash.mode = 'skip'`), so the game never waits for something nobody can see.
 *
 * Movies started through the DLL's calls (FPC_LoadMovieA: the interactive applications such as 2.0.6's) are not run by their length:
 * nothing can show them yet, so they are run through quickly like skipped movies, and the 'load' event says `interactive`.
 *
 * Host hooks:   flash.onEvent({ op, id, rect, ... })  op: 'load' (name, info, bytes, vars, interactive) | 'play' | 'stop' | 'goto' (frame) | 'show' (visible) | 'close';
 *                                                  rect = { x, y, w, h, visible }: where the movie is on the game's screen
 *               flash.started(id)                  the picture has begun; the clock starts
 *               flash.skip(id)                     the player pressed skip: the movie is over
 *               flash.mode                         'timed' (default: play for the movie's real length), 'skip' (end after skipMs)
 *               flash.wantBytes                    true when the host needs the movie's bytes in the 'load' event
 *               flash.hostWait                     true when the clock must wait for started(id) (a picture is being prepared)
 */
(function (G) {
  'use strict';
  const EMU = G.EMU;
  const FP = 'FlashPlayerControl.dll';
  const WM_NCCREATE = 0x81, WM_DESTROY = 2, WM_NCDESTROY = 0x82, WM_SHOWWINDOW = 0x18;
  // private window messages of the control (found in the exported wrappers of the real DLL)
  const M = {
    PUT_MOVIE_MEM: 0x1402, LOAD_MOVIE_MEM: 0x1403, PLAY: 0x1503, STOP: 0x1504, BACK: 0x1505, FORWARD: 0x1506, REWIND: 0x1507, STOPPLAY: 0x1508,
    GOTOFRAME: 0x1509, CURRENTFRAME: 0x150a, ISPLAYING: 0x150b, PERCENTLOADED: 0x150c, FRAMELOADED: 0x150d, FLASHVERSION: 0x150e,
    READYSTATE: 0x152f, TOTALFRAMES: 0x1530, PUTPLAYING: 0x1531, GETPLAYING: 0x1532, PUTFRAMENUM: 0x1541, GETFRAMENUM: 0x1542,
  };
  const FLASH_VERSION = 0x000B0000;

  function install(m) {
    const c = m.cpu;
    const flash = m.flash = {
      windows: new Map(), onEvent: null, mode: 'timed', skipMs: 1500, hostWait: false, hostTimeoutMs: 15000, wantBytes: false,
      onLoad: null, onPlay: null, getVariable: null, finishedCount: 0,
    };
    const log = s => { if (m.opts.traceFiles || m.opts.traceFlash) m.log('  [flash] ' + s); };
    log.on = () => !!(m.opts.traceFiles || m.opts.traceFlash);
    /** where the movie's window is on the game's screen (client coordinates of the game's main window), and whether it can be seen */
    const place = w => {
      const wnd = m.windows.get(w.hwnd); if (!wnd) return null;
      let x = wnd.x | 0, y = wnd.y | 0, visible = wnd.visible !== false, p = wnd.parent ? m.windows.get(wnd.parent) : null, n = 0;
      while (p && p.parent && n++ < 8) { x += p.x | 0; y += p.y | 0; if (p.visible === false) visible = false; p = m.windows.get(p.parent); }
      if (p && p.visible === false) visible = false;
      return { x, y, w: wnd.w | 0, h: wnd.h | 0, visible };
    };
    const emit = (op, w, more) => {
      if (!flash.onEvent) return;
      const ev = Object.assign({ op, id: w.hwnd }, more || {});
      if (op !== 'close' && !ev.rect) ev.rect = place(w);
      try { flash.onEvent(ev); } catch (e) { log('host event failed: ' + (e && e.message)); }
    };
    const win = h => {
      let w = flash.windows.get(h);
      if (!w) flash.windows.set(h, w = {
        hwnd: h, kind: '', name: '', data: null, info: null, vars: '', access: '', loaded: false, playing: false,
        base: 0, clockOn: false, clock: 0, waitSince: 0, skipped: false, shown: false,
      });
      return w;
    };

    // ---- the clock
    const nFrames = w => (w.info && w.info.frames > 0 ? w.info.frames : 1);
    const rate = w => {
      const fps = w.info && w.info.fps > 0 ? w.info.fps : 12, last = nFrames(w) - 1;
      if ((flash.mode === 'skip' || w.interactive) && last > 0) return Math.max(fps, last / (flash.skipMs / 1000));     // a movie nobody can see is run through quickly
      return fps;
    };
    const startClock = w => { w.clockOn = true; w.clock = m.now(); };
    const beginPlay = (w) => {                                  // the movie starts (or restarts) from where it is
      w.playing = true;
      if (flash.hostWait && flash.mode !== 'skip' && !w.interactive) { w.clockOn = false; w.waitSince = m.now(); }
      else startClock(w);
    };
    const curFrame = w => {
      if (!w.loaded) return 0;
      const last = nFrames(w) - 1;
      if (w.skipped) return last;
      let f = w.base;
      if (w.playing) {
        if (!w.clockOn && flash.hostWait && m.now() - w.waitSince > flash.hostTimeoutMs) { w.clockOn = true; w.clock = w.waitSince + flash.hostTimeoutMs; }    // nobody answered: carry on without a picture
        if (w.clockOn) f = w.base + Math.floor((m.now() - w.clock) / 1000 * rate(w));
      }
      return Math.max(0, Math.min(f, last));
    };
    const freeze = w => { w.base = curFrame(w); w.playing = false; w.clockOn = false; };
    const isFinished = w => w.loaded && (w.skipped || (w.playing && curFrame(w) >= nFrames(w) - 1));

    // ---- loading
    const setInfo = (w, bytes) => { w.info = (EMU.swfInfo && bytes && bytes.length >= 12) ? EMU.swfInfo(bytes) : null; };
    const loaded = (w, why) => {
      w.loaded = true; w.skipped = false; w.base = 0; w.playing = true; w.clockOn = false; w.shown = true;
      const i = w.info;
      log(why + ' "' + w.name + '" ' + (i ? 'flash ' + i.version + ', ' + i.width + 'x' + i.height + ', ' + i.frames + ' frames at ' + i.fps + ' fps (' + (i.frames / i.fps).toFixed(1) + ' s)' : 'header not readable'));
      emit('load', w, { name: w.name, info: i, bytes: w.data, vars: w.vars, interactive: !!w.interactive });
      if (flash.onLoad) flash.onLoad(w);
    };
    const fromMemory = (w, ptr, size) => {
      ptr >>>= 0; size >>>= 0;
      if (!ptr || !size || ptr + size > c.u8.length) { log('load from memory: bad buffer 0x' + ptr.toString(16) + ' + ' + size); return; }
      w.kind = 'mem'; w.name = w.name || '(memory)';
      w.data = flash.wantBytes ? c.u8.slice(ptr, ptr + size) : null;
      setInfo(w, c.u8.subarray(ptr, ptr + Math.min(size, 8192)));
      loaded(w, 'movie in memory (' + size + ' bytes)');
    };
    const fromFile = (w, path) => {
      w.kind = 'file'; w.name = path; w.interactive = true;       // started through the DLL's calls: the game's interactive Flash applications, which end by themselves (not by their length)
      let f = null; try { f = m.openRead(path); } catch (e) { }
      if (!f) { log('movie file not found: ' + path); w.info = null; w.data = null; loaded(w, 'movie file (missing)'); return; }
      w.data = flash.wantBytes && !w.interactive ? new Uint8Array(f.read(0, f.size)) : null;           // (a copy: the page takes the buffer over; nothing shows interactive ones yet)
      setInfo(w, w.data || f.read(0, Math.min(f.size, 8192)));
      loaded(w, 'movie file');
    };

    // ---- the window messages
    const out2 = (lp, value, hr) => { if (lp >>> 0 >= 0x10000) { m.wr32(lp, value | 0); m.wr32(lp + 4, hr | 0); } };      // the control answers in {value, hresult}
    function handle(h, msg, wp, lp) {
      const w = flash.windows.get(h) || (msg === WM_NCCREATE ? win(h) : null);
      switch (msg) {
        case WM_NCCREATE: return 1;
        case WM_SHOWWINDOW: if (w) emit('show', w, { visible: !!wp }); return 0;
        case WM_DESTROY: case WM_NCDESTROY:
          if (w && flash.windows.has(h)) { log('window ' + h.toString(16) + ' closed'); emit('close', w); flash.windows.delete(h); }
          return 0;
      }
      if (!w) return 0;
      switch (msg) {
        case M.PUT_MOVIE_MEM: fromMemory(w, m.rd32(lp), m.rd32(lp + 4)); beginPlay(w); emit('play', w); return 0;      // {data, size}: the movie starts by itself
        case M.LOAD_MOVIE_MEM: fromMemory(w, m.rd32(lp + 4), m.rd32(lp + 8)); return 0;                                // {layer, data, size}
        case M.PLAY: beginPlay(w); log('play'); emit('play', w); if (flash.onPlay) flash.onPlay(w); return 0;
        case M.STOP: case M.STOPPLAY: freeze(w); emit('stop', w); return 0;
        case M.REWIND: w.base = 0; if (w.playing) beginPlay(w); return 0;
        case M.BACK: freeze(w); w.base = Math.max(0, w.base - 1); return 0;
        case M.FORWARD: freeze(w); w.base = Math.min(nFrames(w) - 1, w.base + 1); return 0;
        case M.GOTOFRAME: { const f = Math.max(0, Math.min(nFrames(w) - 1, m.rd32(lp))); w.base = f; w.skipped = false; if (w.playing) beginPlay(w); emit('goto', w, { frame: f }); if (lp >>> 0 >= 0x10000) m.wr32(lp + 4, 0); return 0; }       // {frame, hresult}
        case M.CURRENTFRAME: case M.GETFRAMENUM: out2(lp, curFrame(w), 0); return 0;
        case M.TOTALFRAMES: out2(lp, nFrames(w), 0); return 0;
        case M.ISPLAYING: case M.GETPLAYING: out2(lp, w.playing && !isFinished(w) ? 1 : 0, 0); return 0;
        case M.PERCENTLOADED: out2(lp, w.loaded ? 100 : 0, 0); return 0;
        case M.READYSTATE: out2(lp, w.loaded ? 4 : 0, 0); return 0;
        case M.FRAMELOADED: out2(lp, 1, 0); return 0;
        case M.FLASHVERSION: out2(lp, FLASH_VERSION, 0); return 0;
        case M.PUTPLAYING: if (wp) beginPlay(w); else freeze(w); return 0;
      }
      if (msg >= 0x1400 && msg < 0x1600 && log.on()) log('message 0x' + msg.toString(16) + ' (not handled) hwnd 0x' + (h >>> 0).toString(16) + ' w=0x' + (wp >>> 0).toString(16) + ' l=0x' + (lp >>> 0).toString(16));
      return 0;
    }
    flash.handle = handle;

    m.def(FP, 'RegisterFlashWindowClass', 0, (m) => {
      const proc = m.rawTrap('FlashWndProc', 4, (cpu, sp) => handle(m.rd32(sp), m.rd32(sp + 4) >>> 0, m.rd32(sp + 8), m.rd32(sp + 12)));
      m.classes.set('flashplayercontrol', { name: 'FlashPlayerControl', style: 0, proc, extra: 0, hInst: 0, atom: m.nextAtom++ });
      log('RegisterFlashWindowClass');
      return 1;
    });
    m.def(FP, 'UnregisterFlashWindowClass', 0, () => 1);
    m.def(FP, 'GetInstalledFlashVersion', 0, () => FLASH_VERSION);
    m.def(FP, 'GetUsingFlashVersion', 0, () => FLASH_VERSION);

    // ---- the exported functions
    m.def(FP, 'FPC_PutFlashVarsA', 2, (m, h, s) => { win(h).vars = m.cstr(s); log('vars ' + win(h).vars); return 1; });
    m.def(FP, 'FPC_PutAllowScriptAccessA', 2, (m, h, s) => { win(h).access = m.cstr(s); return 1; });
    m.def(FP, 'FPC_LoadMovieA', 3, (m, h, layer, s) => { const w = win(h); fromFile(w, m.cstr(s)); return 1; });
    m.def(FP, 'FPC_Play', 1, (m, h) => { const w = win(h); beginPlay(w); log('play'); emit('play', w); if (flash.onPlay) flash.onPlay(w); return 1; });
    m.def(FP, 'FPC_GetVariableA', 4, (m, h, name, buf, plen) => {
      const w = win(h), nm = m.cstr(name);
      let v = flash.getVariable ? flash.getVariable(w, nm) : null;
      if ((v === null || v === undefined) && /^finished$/i.test(nm) && isFinished(w)) v = '1';           // the movie has reached its end
      log('getvariable "' + nm + '" -> ' + JSON.stringify(v === undefined ? null : v) + ' (frame ' + curFrame(w) + '/' + nFrames(w) + ')');
      if (v === null || v === undefined || v === '') { if (buf) c.u8[buf] = 0; if (plen) m.wr32(plen, 0); return 0; }
      v = String(v); const max = plen ? m.rd32(plen) : 0; v = v.substr(0, Math.max(0, max));
      m.putStr(buf, v); if (plen) m.wr32(plen, v.length); return 1;
    });

    // ---- what the page can tell us
    flash.started = id => { const w = flash.windows.get(id); if (w && w.playing && !w.clockOn) startClock(w); };
    flash.skip = id => { const w = flash.windows.get(id); if (w) { w.skipped = true; w.playing = true; } };
    flash.current = id => { const w = flash.windows.get(id); return w ? { frame: curFrame(w), frames: nFrames(w), playing: w.playing, finished: isFinished(w) } : null; };
  }
  EMU.installFlashctl = install;
})(typeof globalThis !== 'undefined' ? globalThis : this);
