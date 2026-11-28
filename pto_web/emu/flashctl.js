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
 * One of those calls is the Sing-Along room's (2.0.0, 2.0.3): it loads stub.swf with FlashVars that name a video ("streamloc=v1_03"; see
 * videolist.js), which the original movie played from a streaming server that no longer exists.  Such a window is a *video*: the 'load' event says
 * which (`video`), the page plays it with the browser's player, and the room's loop, which asks the movie's variable "finished" about every 50 ms,
 * is told the video is over when the page calls `flash.videoEnded(id)` (or the player pressed skip), and not before.
 *
 * The movies that are put into the window with message 0x1402 (PUT_MOVIE_MEM) are the game's Flash *applications* (the day and night
 * menus, the read-along books): the game runs a loop of its own around them that never looks at the movie's frame.  That loop ends
 * when a flag in the game's object for the application is set, which the game's own Back button does (the button is drawn over the
 * movie, and the real control hands the mouse to the game, so the child can press it).  Nothing here can press that button for the
 * player, so `flash.skip(id)` sets the flag itself (the object is found when the movie arrives; see `captureApp`); the 'load' event says
 * `modal`.  The 'load' event also says `src`, the movie's file in the game's data, when it is known, and `flash.readFile` gives the files
 * such a movie asks for by a relative address.
 *
 * Host hooks:   flash.onEvent({ op, id, rect, ... })  op: 'load' (name, info, bytes, vars, interactive) | 'play' | 'stop' | 'goto' (frame) | 'show' (visible) | 'close';
 *                                                  rect = { x, y, w, h, visible }: where the movie is on the game's screen
 *               flash.started(id)                  the picture has begun; the clock starts
 *               flash.skip(id)                     the player pressed skip: the movie is over
 *               flash.videoEnded(id)               the page's video (see above) has played to its end
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

  /** The loop that runs a Flash application sends message 0x1402 (PUT_MOVIE_MEM) and then repeats until `cmp byte [esi+FLAG], bl` finds the flag set
   * (`je` back to the top of the loop).  All three editions (2.0.0, 2.0.3, 2.0.6) have it, with FLAG = 0xb0.  `u8` is the program's memory,
   * [lo, hi) its code; returns { flag, at } (at: where the push of 0x1402 is) or null. */
  function modalFlag(u, lo, hi) {
    hi -= 16;
    for (let a = lo; a < hi; a++) {
      if (u[a] !== 0x68 || u[a + 1] !== 0x02 || u[a + 2] !== 0x14 || u[a + 3] !== 0 || u[a + 4] !== 0) continue;        // push 0x1402
      for (let b = a + 5; b < Math.min(a + 0x1c0, hi); b++) {
        if (u[b] === 0x38 && u[b + 1] === 0x9e && u[b + 6] === 0x0f && u[b + 7] === 0x84) {                            // cmp [esi+disp32], bl ; je rel32
          const rel = (u[b + 8] | (u[b + 9] << 8) | (u[b + 10] << 16) | (u[b + 11] << 24)) | 0;
          const flag = (u[b + 2] | (u[b + 3] << 8) | (u[b + 4] << 16) | (u[b + 5] << 24)) >>> 0;
          if (rel < 0 && rel > -0x400 && flag < 0x1000) return { flag, at: a };
        }
      }
    }
    return null;
  }
  EMU.flashModalFlag = modalFlag;

  function install(m) {
    const c = m.cpu;
    const flash = m.flash = {
      windows: new Map(), onEvent: null, mode: 'timed', skipMs: 1500, hostWait: false, hostTimeoutMs: 15000, wantBytes: false,
      onLoad: null, onPlay: null, getVariable: null, finishedCount: 0, modalLayout: undefined,
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
        base: 0, clockOn: false, clock: 0, waitSince: 0, skipped: false, shown: false, modal: false, app: null, src: '',
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
    const isFinished = w => w.loaded && (w.skipped || (w.video ? w.videoDone : (w.playing && curFrame(w) >= nFrames(w) - 1)));      // (a video is over when the page says so, not by the movie's own length)

    // ---- loading
    const setInfo = (w, bytes) => { w.info = (EMU.swfInfo && bytes && bytes.length >= 12) ? EMU.swfInfo(bytes) : null; };
    const loaded = (w, why) => {
      w.loaded = true; w.skipped = false; w.base = 0; w.playing = true; w.clockOn = false; w.shown = true;
      const i = w.info;
      log(why + ' "' + w.name + '" ' + (i ? 'flash ' + i.version + ', ' + i.width + 'x' + i.height + ', ' + i.frames + ' frames at ' + i.fps + ' fps (' + (i.frames / i.fps).toFixed(1) + ' s)' : 'header not readable'));
      emit('load', w, { name: w.name, info: i, bytes: w.data, vars: w.vars, interactive: !!w.interactive, modal: !!w.modal, src: w.src || '', video: w.video || '' });
      if (flash.onLoad) flash.onLoad(w);
    };
    const fromMemory = (w, ptr, size) => {
      ptr >>>= 0; size >>>= 0;
      if (!ptr || !size || ptr + size > c.u8.length) { log('load from memory: bad buffer 0x' + ptr.toString(16) + ' + ' + size); return; }
      w.kind = 'mem'; w.name = w.name || '(memory)';
      const ls = m.lastSwf; w.src = ls && ls.key && ls.size === size ? ls.key : '';           // the game read the movie from a file just before: the file's place in its data
      w.data = flash.wantBytes ? c.u8.slice(ptr, ptr + size) : null;
      setInfo(w, c.u8.subarray(ptr, ptr + Math.min(size, 8192)));
      loaded(w, 'movie in memory (' + size + ' bytes)');
    };
    const fromFile = (w, path) => {
      w.kind = 'file'; w.name = path; w.src = (m.vfsKey && m.vfsKey(m.fullPath(path))) || ''; w.interactive = true;       // started through the DLL's calls: the game's interactive Flash applications, which end by themselves (not by their length)
      w.video = (EMU.Videos && /(^|[\\/])stub\.swf$/i.test(path) && EMU.Videos.videoOfVars(w.vars)) || ''; w.videoDone = false;      // the Sing-Along room's player: see above
      let f = null; try { f = m.openRead(path); } catch (e) { }
      if (!f) { log('movie file not found: ' + path); w.info = null; w.data = null; loaded(w, 'movie file (missing)'); return; }
      w.data = flash.wantBytes && !w.interactive ? new Uint8Array(f.read(0, f.size)) : null;           // (a copy: the page takes the buffer over; nothing shows interactive ones yet)
      setInfo(w, w.data || f.read(0, Math.min(f.size, 8192)));
      loaded(w, 'movie file');
    };

    // ---- the game's Flash applications (movies put in with PUT_MOVIE_MEM)
    /** Where the loop around such an application keeps its "finished" flag, read from the game's own code (see modalFlag below).
     * Returns { flag } or null when the code is not found (then Skip cannot end such an application, and the page falls back to hiding it). */
    function findModalLayout() {
      const info = m.info; if (!info || !info.sections) return null;
      const ts = info.sections.find(x => x.name === '.text'); if (!ts) return null;
      return modalFlag(c.u8, info.base + ts.va, Math.min(info.base + ts.va + ts.vsize, c.u8.length));
    }
    flash.findModalLayout = findModalLayout;
    /** The application's object is `this` of the game's loop, which is still in ESI when the loop sends the movie (the control's window procedure
     * is called straight from the game's SendMessage).  It is only believed when it holds the movie window's handle in its first bytes. */
    function captureApp(w) {
      try {
        if (flash.modalLayout === undefined) flash.modalLayout = findModalLayout();
        const lay = flash.modalLayout; if (!lay) { log('application: the loop was not found in the game'); return; }
        const p = c.R[6] >>> 0;
        if (p < 0x10000 || p + 0x400 > c.u8.length) { log('application: ESI 0x' + p.toString(16) + ' is not an object'); return; }
        let at = -1;
        for (let o = 0x40; o < 0x200; o += 4) if ((m.rd32(p + o) >>> 0) === (w.hwnd >>> 0)) { at = o; break; }
        if (at < 0) { log('application: the object at 0x' + p.toString(16) + ' does not hold the window'); return; }
        w.app = { obj: p, hwndAt: at, flag: lay.flag, skip: false };
        log('application object 0x' + p.toString(16) + ' (window handle at +0x' + at.toString(16) + ', "finished" flag at +0x' + lay.flag.toString(16) + ')');
      } catch (e) { log('application: ' + (e && e.message)); }
    }
    /** what the game's Back button does: the flag that ends the loop */
    function writeDone(w) {
      const a = w.app; if (!a) return false;
      if ((m.rd32(a.obj + a.hwndAt) >>> 0) !== (w.hwnd >>> 0)) { w.app = null; return false; }     // the object is gone (the loop has ended)
      m.wr8(a.obj + a.flag, 1); a.skip = true; return true;
    }

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
      if (w.app && w.app.skip) writeDone(w);                         // (the loop clears the flag as it begins: say it again if this arrives after that)
      switch (msg) {
        case M.PUT_MOVIE_MEM: w.modal = true; captureApp(w); fromMemory(w, m.rd32(lp), m.rd32(lp + 4)); beginPlay(w); emit('play', w); return 0;      // {data, size}: the movie starts by itself (an application: see above)
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
    // (an application's variables come AFTER its movie: 2.0.6's loop puts the movie in, shows the window and only then hands over "Basepath=...", so the page is told again)
    m.def(FP, 'FPC_PutFlashVarsA', 2, (m, h, s) => { const w = win(h); w.vars = m.cstr(s); log('vars ' + w.vars); if (w.loaded) emit('vars', w, { vars: w.vars }); return 1; });
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
    flash.videoEnded = id => {
      const w = flash.windows.get(id); if (!w || !w.video) return false;
      w.videoDone = true; log('video ' + w.video + ' ended');
      return true;
    };
    flash.skip = id => {
      const w = flash.windows.get(id); if (!w) return false;
      w.skipped = true; w.playing = true;                            // a movie the game watches by its frame: it is on its last frame
      const done = writeDone(w);                                     // an application: the flag the game's Back button sets
      log('skip ' + w.hwnd.toString(16) + (w.modal ? (done ? ' (application: its "finished" flag is set)' : ' (application: no flag to set)') : ''));
      return done || !w.modal;
    };
    /** The file a movie asked for by a relative address ("games/mute.swf"), out of the game's data.  The movie does not know where in the game's
     * folders it lives (its file came to the control as bytes), so the address is looked for as it is, then below the movie's own folder, then
     * anywhere (a file whose name ends with it), preferring the one whose folders are closest to the movie's. */
    const fileKeys = { tail: null, cache: new Map() };
    const dirOf = k => { const i = (k || '').lastIndexOf('/'); return i < 0 ? '' : k.slice(0, i + 1); };
    const isFile = k => { try { const st = m.vfs && m.vfs.stat(k); return !!(st && !st.dir); } catch (e) { return false; } };
    flash.resolveFile = (want, fromKey) => {
      want = String(want || '').replace(/\\/g, '/').replace(/^\/+/, '').replace(/^(\.\/)+/, '').toLowerCase();
      if (!want) return null;
      const ck = want + '|' + dirOf(fromKey); if (fileKeys.cache.has(ck)) return fileKeys.cache.get(ck);
      let found = null;
      if (isFile(want)) found = want;
      else if (fromKey && isFile(dirOf(fromKey) + want)) found = dirOf(fromKey) + want;
      else if (m.vfs && m.vfs.index && m.vfs.index.keys) {
        const mine = dirOf(fromKey), suffix = '/' + want; let best = null, bestScore = -1;
        for (const k of m.vfs.index.keys()) {
          if (!(k === want || k.endsWith(suffix)) || !isFile(k)) continue;
          const d = dirOf(k); let n = 0;                                                 // how many folder names at the end of the two folders agree
          const a = d.split('/').filter(Boolean).reverse(), b = mine.split('/').filter(Boolean).reverse();
          while (n < a.length && n < b.length && a[n] === b[n]) n++;
          const score = n * 1000 - k.length;
          if (score > bestScore) { bestScore = score; best = k; }
        }
        found = best;
      }
      fileKeys.cache.set(ck, found);
      return found;
    };
    flash.readFile = (path, fromKey) => {
      let want = String(path || '').split('#')[0].split('?')[0];
      try { want = decodeURIComponent(want); } catch (e) { /* as it is */ }
      // A file the game wrote itself (its config.ini, saved pictures and so on) is the one a movie must get, whatever else the data holds under that name:
      // 2.0.6's Manny reads the game's config.ini to see which lesson plans there are.
      const rel = want.replace(/\\/g, '/').replace(/^\/+/, '').replace(/^(\.\/)+/, '');
      const own = m.userFiles && m.userFiles.get(m.installRoot.toLowerCase() + '\\' + rel.replace(/\//g, '\\').toLowerCase());
      if (own) return { key: rel.toLowerCase(), bytes: own.data.slice(0, own.size) };
      const key = flash.resolveFile(want, fromKey);
      if (key === null) return null;
      const h = m.vfs.open(key); if (!h) return null;
      return { key, bytes: new Uint8Array(h.read(0, h.size)) };
    };
    /** (tests and ?debug only; the addresses are 2.0.3's) Makes the game run one of its Flash applications on a file in its data, the way its menus
     * do (its function at 0x428140, called with the file's path), from where the main thread is now.  Returns false when this is not a good moment. */
    flash.debugRunApp = path => {
      if (!m.mainWnd || !m.cur || m.cur.id !== 1) return false;
      const g = m.rd32(0x64ba00) >>> 0, screen = g ? m.rd32(g + 0x56c) >>> 0 : 0;
      if (!screen) return false;
      const u = c.u8, str = m.scratchStr(path), stub = m.scratch(48);
      let o = stub; const put = (...b) => { for (const x of b) u[o++] = x; }, imm = v => put(v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255);
      put(0x9c, 0x60); put(0x68); imm(str);                           // pushfd, pushad, push path
      put(0xe8); imm((0x428140 - (o + 4)) | 0);                       // call DoFlashApp
      put(0x83, 0xc4, 0x04, 0x61, 0x9d);                              // add esp, 4; popad; popfd
      const back = c.eip >>> 0; put(0xe9); imm((back - (o + 4)) | 0); // jmp back to where the guest was
      c.eip = stub;
      return true;
    };
    flash.current = id => { const w = flash.windows.get(id); return w ? { frame: curFrame(w), frames: nFrames(w), playing: w.playing, finished: isFinished(w) } : null; };
  }
  EMU.installFlashctl = install;
})(typeof globalThis !== 'undefined' ? globalThis : this);
