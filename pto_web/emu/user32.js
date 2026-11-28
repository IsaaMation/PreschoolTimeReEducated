/* USER32 stand-ins: window classes, windows, message queue, input state, string formatting */
(function (G) {
  'use strict';
  const EMU = G.EMU;
  const U = 'USER32.dll';
  const WM = { CREATE: 1, SIZE: 5, ACTIVATE: 6, SETFOCUS: 7, PAINT: 0xF, QUIT: 0x12, ERASEBKGND: 0x14, SHOWWINDOW: 0x18, ACTIVATEAPP: 0x1C, NCCREATE: 0x81, NCHITTEST: 0x84, KEYDOWN: 0x100, KEYUP: 0x101, CHAR: 0x102, MOUSEMOVE: 0x200, LBUTTONDOWN: 0x201, LBUTTONUP: 0x202, RBUTTONDOWN: 0x204, RBUTTONUP: 0x205 };

  /** printf-style formatting used by wsprintfA / wvsprintfA */
  function format(m, f, next) {
    let out = '';
    for (let i = 0; i < f.length; i++) {
      const ch = f[i];
      if (ch !== '%') { out += ch; continue; }
      i++;
      let flags = '', width = '', prec = null;
      while ('-+ 0#'.includes(f[i])) flags += f[i++];
      if (f[i] === '*') { width = String(next() | 0); i++; } else while (f[i] >= '0' && f[i] <= '9') width += f[i++];
      if (f[i] === '.') { i++; prec = ''; while (f[i] >= '0' && f[i] <= '9') prec += f[i++]; prec = +prec || 0; }
      let size = '';
      while (f[i] === 'l' || f[i] === 'h' || f[i] === 'I') size += f[i++];
      const t = f[i];
      let s;
      switch (t) {
        case 'd': case 'i': { let v = next() | 0; if (size === 'h') v = (v << 16) >> 16; s = String(Math.abs(v)); if (prec !== null) s = s.padStart(prec, '0'); s = (v < 0 ? '-' : flags.includes('+') ? '+' : flags.includes(' ') ? ' ' : '') + s; break; }
        case 'u': { let v = next() >>> 0; if (size === 'h') v &= 0xFFFF; s = String(v); break; }
        case 'x': case 'X': { let v = next() >>> 0; if (size === 'h') v &= 0xFFFF; s = v.toString(16); if (t === 'X') s = s.toUpperCase(); if (prec !== null) s = s.padStart(prec, '0'); if (flags.includes('#') && v) s = (t === 'X' ? '0X' : '0x') + s; break; }
        case 'c': s = String.fromCharCode(next() & 255); break;
        case 's': { const p = next(); s = p ? m.cstr(p, 1 << 16) : '(null)'; if (prec !== null) s = s.substr(0, prec); break; }
        case 'p': s = (next() >>> 0).toString(16).toUpperCase().padStart(8, '0'); break;
        case '%': s = '%'; break;
        default: s = '%' + t;
      }
      if (width && s.length < +width) {
        if (flags.includes('-')) s = s.padEnd(+width, ' ');
        else if (flags.includes('0') && 'diuxX'.includes(t)) { const neg = /^[-+]/.test(s) ? s[0] : ''; s = neg + s.substr(neg.length).padStart(+width - neg.length, '0'); }
        else s = s.padStart(+width, ' ');
      }
      out += s;
    }
    return out;
  }

  function install(m) {
    const d = (name, n, fn) => m.def(U, name, n, fn);
    const c = m.cpu;
    m.EMU_format = format;
    m.classes = new Map(); m.windows = new Map(); m.msgQueue = []; m.nextHwnd = 0x20010; m.nextAtom = 0xC001;
    // keys: real-time key state (GetAsyncKeyState). tkeys: key state as of the last key message the program took from its
    // queue (GetKeyboardState, as on Windows). cur: the key-down message being handled (see ToAscii below).
    m.input = { x: 320, y: 240, buttons: 0, keys: new Uint8Array(256), tkeys: new Uint8Array(256), cur: null, cursorVisible: true };
    m.mainWnd = 0;
    m.screenW = 640; m.screenH = 480;

    // ---- messages
    m.postMessage = (hwnd, msg, w, l, front) => {
      const q = { hwnd, msg, w: w | 0, l: l | 0, time: Math.floor(m.now()), x: m.input.x, y: m.input.y };
      if (front) m.msgQueue.unshift(q); else m.msgQueue.push(q);
      return q;
    };
    m.callProc = (hwnd, msg, w, l) => {
      const wnd = m.windows.get(hwnd);
      if (!wnd || !wnd.proc) return 0;
      return c.callGuest(wnd.proc, [hwnd, msg, w, l]);
    };
    /** Call a window procedure on the program's own stack, the way Windows does for DispatchMessage and SendMessage: the API trap
     *  turns into a call of the procedure, which returns straight to the caller of the API with the procedure's result.  The host does
     *  not wait inside the call, so a procedure that runs for a long time (a menu with a message loop of its own) cannot freeze it.
     *  nArgs = number of argument words of the API (they are removed from the stack on return, as stdcall does). */
    m.tailProc = (hwnd, msg, w, l, nArgs) => {
      const wnd = m.windows.get(hwnd);
      if (!wnd || !wnd.proc) return 0;
      const H = c.H, sp = m.sp, top = (sp + nArgs * 4) | 0, ret = H.rd32(sp - 4);      // (the new frame can cover the old return address)
      H.wr32(top - 4, l); H.wr32(top - 8, w); H.wr32(top - 12, msg); H.wr32(top - 16, hwnd); H.wr32(top - 20, ret);
      c.R[4] = top - 20; c.eip = wnd.proc;
      return EMU.CPU.NORET;
    };
    /** host input event -> Windows message */
    m.sendInput = (ev) => {
      const I = m.input, h = m.mainWnd;
      if (ev.x !== undefined) { I.x = ev.x; I.y = ev.y; }
      const lp = (I.y << 16) | (I.x & 0xFFFF), mk = (I.buttons & 1 ? 1 : 0) | (I.buttons & 2 ? 2 : 0);
      switch (ev.type) {
        case 'mousemove': {
          // Windows keeps at most one mouse-move message waiting: a newer position replaces the one the program has not taken yet (the
          // program sees where the mouse is now, not every place it has been).  Without this a game whose frames take longer than the
          // time between two mouse moves collects a queue of old moves while the mouse is in motion, and takes them one per frame for
          // many seconds afterwards.
          const last = m.msgQueue.length ? m.msgQueue[m.msgQueue.length - 1] : null;
          if (last && last.msg === WM.MOUSEMOVE && last.hwnd === h) { last.w = mk; last.l = lp | 0; last.time = Math.floor(m.now()); last.x = I.x; last.y = I.y; }
          else m.postMessage(h, WM.MOUSEMOVE, mk, lp);
          break;
        }
        case 'mousedown': I.buttons |= ev.button === 2 ? 2 : 1; m.postMessage(h, ev.button === 2 ? WM.RBUTTONDOWN : WM.LBUTTONDOWN, (I.buttons & 1 ? 1 : 0) | (I.buttons & 2 ? 2 : 0), lp); break;
        case 'mouseup': I.buttons &= ~(ev.button === 2 ? 2 : 1); m.postMessage(h, ev.button === 2 ? WM.RBUTTONUP : WM.LBUTTONUP, (I.buttons & 1 ? 1 : 0) | (I.buttons & 2 ? 2 : 0), lp); break;
        case 'keydown': case 'keyup': {
          // ev: vk (Windows virtual-key code), scan, ext (extended key), repeat (auto-repeat), ch (the character the browser
          // produced for this key, 0 = none, left out = unknown), caps / num (lock states)
          const down = ev.type === 'keydown', vk = ev.vk & 255;
          I.keys[vk] = down ? 0x80 : 0;
          if (ev.caps !== undefined) I.keys[0x14] = (I.keys[0x14] & 0x80) | (ev.caps ? 1 : 0);
          if (ev.num !== undefined) I.keys[0x90] = (I.keys[0x90] & 0x80) | (ev.num ? 1 : 0);
          const klp = 1 | ((ev.scan || 0) << 16) | (ev.ext ? 0x1000000 : 0) | (down ? (ev.repeat ? 0x40000000 : 0) : 0xC0000000);
          m.postMessage(h, down ? WM.KEYDOWN : WM.KEYUP, vk, klp).key = { vk, down, ch: ev.ch === undefined ? -1 : ev.ch | 0, caps: ev.caps, num: ev.num };
          break;
        }
        case 'char': m.postMessage(h, WM.CHAR, ev.ch, 1); break;
      }
    };
    const writeMsg = (p, q) => { m.wr32(p, q.hwnd); m.wr32(p + 4, q.msg); m.wr32(p + 8, q.w); m.wr32(p + 12, q.l); m.wr32(p + 16, q.time); m.wr32(p + 20, q.x); m.wr32(p + 24, q.y); };
    const takeKey = (k) => {                       // a key message leaves the queue: GetKeyboardState now shows its effect
      const T = m.input.tkeys;
      T[k.vk] = k.down ? 0x80 : 0;
      if (k.caps !== undefined) T[0x14] = (T[0x14] & 0x80) | (k.caps ? 1 : 0);
      if (k.num !== undefined) T[0x90] = (T[0x90] & 0x80) | (k.num ? 1 : 0);
      if (k.down) m.input.cur = k;
    };
    const takeMsg = (hwnd, min, max, remove) => {
      for (let i = 0; i < m.msgQueue.length; i++) {
        const q = m.msgQueue[i];
        if (hwnd && q.hwnd && q.hwnd !== hwnd) continue;
        if ((min || max) && (q.msg < min || q.msg > max)) continue;
        if (remove) {
          m.msgQueue.splice(i, 1); if (q.key) takeKey(q.key);
          if (m.opts.traceKeys && q.msg >= WM.KEYDOWN && q.msg <= WM.CHAR) m.log('  [key] taken: ' + ['WM_KEYDOWN', 'WM_KEYUP', 'WM_CHAR'][q.msg - WM.KEYDOWN] + ' w=' + q.w + ' l=0x' + (q.l >>> 0).toString(16) + ' for 0x' + (q.hwnd >>> 0).toString(16));
        }
        return q;
      }
      return null;
    };
    d('PeekMessageA', 5, (m, p, hwnd, min, max, remove) => {
      const q = takeMsg(hwnd, min, max, remove & 1);
      if (!q) { c.yieldNow = true; return 0; }
      writeMsg(p, q);
      // The game's frame loop gives the player its turn (a new picture, the sound, the time of the next frame) when it finds its queue
      // empty.  A busy game that finds a message every time (the mouse keeps moving) still comes back once per frame time.
      if (m.now() - m.lastYieldAt > 16) c.yieldNow = true;
      return 1;
    });
    d('GetMessageA', 4, (m, p, hwnd, min, max) => {
      const q = takeMsg(hwnd, min, max, true);
      if (q) { writeMsg(p, q); return q.msg === WM.QUIT ? 0 : 1; }
      return m.blockCurrent(c.curEip, m.sp - 4, null, undefined, () => takeMsg(hwnd, min, max, false) !== null);
    });
    // TranslateMessage: a key-down message the program has taken from its queue becomes a WM_CHAR message for the same window, which
    // Windows puts in the queue ahead of everything else waiting there (so a character follows its key press at once).  This is how
    // DisneyPO.exe gets Esc ("Press Escape to Skip"), the space bar and every typed character: its window procedure takes printable
    // characters and Esc from WM_CHAR only (WM_KEYDOWN gives it just the arrows, F1-F12, Home / End, Page up / down, Insert, Delete),
    // and it never calls ToAscii.  The character is the one the browser produced for the key (any keyboard layout works); a
    // US-layout table stands in when the page gave none.  Returns nonzero when a character was posted.
    d('TranslateMessage', 1, (m, p) => {
      if (m.rd32(p + 4) !== WM.KEYDOWN) return 0;
      const hwnd = m.rd32(p), vk = m.rd32(p + 8) & 255, lp = m.rd32(p + 12), cur = m.input.cur;
      const ch = (cur && cur.vk === vk && cur.ch >= 0) ? cur.ch : usChar(vk, i => m.input.tkeys[i]);
      if (m.opts.traceKeys) m.log('  [key] TranslateMessage vk=0x' + vk.toString(16) + ' -> ' + (ch ? 'WM_CHAR ' + ch : 'no character'));
      if (!ch) return 0;
      m.postMessage(hwnd, WM.CHAR, ch, lp, true);
      return 1;
    });
    d('DispatchMessageA', 1, (m, p) => {
      if (m.opts.traceKeys) { const msg = m.rd32(p + 4); if (msg >= WM.KEYDOWN && msg <= WM.CHAR) m.log('  [key] DispatchMessage ' + ['WM_KEYDOWN', 'WM_KEYUP', 'WM_CHAR'][msg - WM.KEYDOWN] + ' w=' + m.rd32(p + 8) + ' to proc 0x' + ((m.windows.get(m.rd32(p)) || {}).proc >>> 0).toString(16)); }
      return m.tailProc(m.rd32(p), m.rd32(p + 4), m.rd32(p + 8), m.rd32(p + 12), 1);
    });
    d('PostMessageA', 4, (m, h, msg, w, l) => { m.postMessage(h, msg, w, l); return 1; });
    d('SendMessageA', 4, (m, h, msg, w, l) => m.tailProc(h, msg, w, l, 4));
    d('PostQuitMessage', 1, (m, code) => { m.postMessage(0, WM.QUIT, code, 0); });
    d('DefWindowProcA', 4, (m, h, msg, w, l) => (msg === WM.NCCREATE || msg === WM.NCHITTEST || msg === WM.ERASEBKGND) ? 1 : 0);

    // ---- classes and windows
    d('RegisterClassA', 1, (m, p) => {
      const name = m.cstr(m.rd32(p + 36));
      m.classes.set(name.toLowerCase(), { name, style: m.rd32(p), proc: m.rd32(p + 4), extra: m.rd32(p + 12), hInst: m.rd32(p + 16), atom: m.nextAtom });
      if (m.opts.traceFiles) m.log('  [wnd] RegisterClass ' + name + ' proc=0x' + (m.rd32(p + 4) >>> 0).toString(16));
      return m.nextAtom++;
    });
    d('CreateWindowExA', 12, (m, ex, cls, title, style, x, y, w, h, parent, menu, inst, param) => {
      const cname = (cls >>> 0) < 0x10000 ? '#' + cls : m.cstr(cls);
      const k = m.classes.get(cname.toLowerCase());
      const hwnd = m.nextHwnd; m.nextHwnd += 4;
      const wnd = { hwnd, cls: cname, proc: k ? k.proc : 0, style, exStyle: ex, x, y, w, h, parent, title: title ? m.cstr(title) : '', data: new Map() };
      m.windows.set(hwnd, wnd);
      if (!m.mainWnd) m.mainWnd = hwnd;
      if (m.opts.traceFiles) m.log('  [wnd] CreateWindow ' + cname + ' "' + wnd.title + '" ' + x + ',' + y + ' ' + w + 'x' + h + ' style=0x' + (style >>> 0).toString(16));
      if (wnd.proc) {
        const cs = m.scratch(48);
        m.wr32(cs, param); m.wr32(cs + 4, inst); m.wr32(cs + 8, menu); m.wr32(cs + 12, parent); m.wr32(cs + 16, h); m.wr32(cs + 20, w); m.wr32(cs + 24, y); m.wr32(cs + 28, x); m.wr32(cs + 32, style); m.wr32(cs + 36, title); m.wr32(cs + 40, cls); m.wr32(cs + 44, ex);
        if (m.callProc(hwnd, WM.NCCREATE, 0, cs) === 0) { m.windows.delete(hwnd); return 0; }
        if (m.callProc(hwnd, WM.CREATE, 0, cs) === -1) { m.windows.delete(hwnd); return 0; }
        m.callProc(hwnd, WM.SIZE, 0, (h << 16) | (w & 0xFFFF));
        if ((style & 0x10000000) && m.doShow) m.doShow(hwnd, 1);     // WS_VISIBLE: shown (and activated) before CreateWindowEx returns
      }
      return hwnd;
    });
    d('GetWindowLongA', 2, (m, h, idx) => {
      const w = m.windows.get(h); if (!w) return 0;
      switch (idx) { case -16: return w.style; case -20: return w.exStyle; case -4: return w.proc; case -6: return m.imageBase; case -12: return 0; default: return w.data.get(idx) || 0; }
    });
    d('GetWindowRect', 2, (m, h, p) => { const w = m.windows.get(h); m.wr32(p, w ? w.x : 0); m.wr32(p + 4, w ? w.y : 0); m.wr32(p + 8, w ? w.x + w.w : m.screenW); m.wr32(p + 12, w ? w.y + w.h : m.screenH); return 1; });
    d('InvalidateRect', 3, () => 1);
    d('IsIconic', 1, () => 0);
    d('IsWindowVisible', 1, () => 1);
    d('GetForegroundWindow', 0, () => m.mainWnd);
    d('GetActiveWindow', 0, () => m.mainWnd);
    d('GetDesktopWindow', 0, () => 0x10010);
    d('GetSystemMetrics', 1, (m, i) => { switch (i) { case 0: return m.screenW; case 1: return m.screenH; case 13: case 14: return 32; case 11: case 12: return 32; case 15: return 19; case 4: return 19; case 5: case 6: return 1; case 32: case 33: return 4; case 16: return m.screenW; case 17: return m.screenH; default: return 0; } });

    // ---- cursor, icons, strings
    d('ShowCursor', 1, (m, show) => { m.input.cursorVisible = !!show; return show ? 1 : -1; });
    d('DestroyCursor', 1, () => 1);
    d('CreateCursor', 7, () => m.newHandle({ type: 'cursor' }));
    d('LoadIconA', 2, () => m.newHandle({ type: 'icon' }));
    d('LoadImageA', 6, () => m.newHandle({ type: 'image' }));
    d('GetCursorPos', 1, (m, p) => { const I = m.input; m.wr32(p, I.x); m.wr32(p + 4, I.y); m.pollX = I.x; m.pollY = I.y; return 1; });      // (pollX, pollY: the place the game was last told: the game draws its mouse arrow there, the page wants to know where that is)
    d('LoadStringA', 4, (m, hinst, id, buf, n) => {
      const ent = m.findRes(6, (id >> 4) + 1);
      if (!ent) return 0;
      let a = m.imageBase + m.rd32(ent);
      for (let i = 0; i < (id & 15); i++) a += 2 + 2 * c.u16[a >> 1];
      const len = c.u16[a >> 1], k = Math.min(len, n - 1);
      for (let i = 0; i < k; i++) c.u8[buf + i] = c.u16[(a >> 1) + 1 + i] & 255;
      c.u8[buf + k] = 0; return k;
    });
    d('MessageBoxA', 4, (m, h, text, cap, type) => { m.log('[MessageBox] ' + m.cstr(cap) + ': ' + m.cstr(text)); if (m.opts.onMessageBox) m.opts.onMessageBox(m.cstr(cap), m.cstr(text)); return 1; });
    d('wsprintfA', 0, (m) => {
      const sp = m.sp; let a = sp + 8;
      const s = format(m, m.cstr(m.rd32(sp + 4), 1 << 16), () => { const v = m.rd32(a); a += 4; return v; });
      m.putStr(m.rd32(sp), s); return s.length;
    });
    d('wvsprintfA', 3, (m, buf, fmt, va) => {
      let a = va;
      const s = format(m, m.cstr(fmt, 1 << 16), () => { const v = m.rd32(a); a += 4; return v; });
      m.putStr(buf, s); return s.length;
    });

    // ---- keyboard, clipboard
    d('GetKeyboardState', 1, (m, p) => { c.u8.set(m.input.tkeys, p); return 1; });
    let asyncLogged = 0;
    d('GetAsyncKeyState', 1, (m, vk) => {
      const down = vk === 1 ? (m.input.buttons & 1) : vk === 2 ? (m.input.buttons & 2) : m.input.keys[vk & 255] & 0x80;
      if (m.opts.traceKeys && vk > 2 && asyncLogged < 40) { asyncLogged++; m.log('  [key] GetAsyncKeyState(0x' + (vk & 255).toString(16) + ') = ' + (down ? 'down' : 'up')); }
      return down ? 0x8000 : 0;
    });
    // Programs that turn key presses into characters themselves (Bear in the Big Blue House does, from its WM_KEYDOWN handler) call
    // ToAscii.  For the key being handled we return the character the browser produced (so every keyboard layout works); a
    // US-layout table stands in when the page gave none. Returns 1 and stores the character, or 0 for keys without one.
    // (DisneyPO.exe does not use ToAscii: it gets WM_CHAR from TranslateMessage, above.)
    const OEM = { 0xBA: ';:', 0xBB: '=+', 0xBC: ',<', 0xBD: '-_', 0xBE: '.>', 0xBF: '/?', 0xC0: '`~', 0xDB: '[{', 0xDC: '\\|', 0xDD: ']}', 0xDE: '\'"' };
    const PADOP = { 0x6A: '*', 0x6B: '+', 0x6D: '-', 0x6E: '.', 0x6F: '/' };
    const usChar = (vk, st) => {
      const shift = (st(0x10) & 0x80) !== 0, caps = (st(0x14) & 1) !== 0, ctrl = (st(0x11) & 0x80) !== 0, alt = (st(0x12) & 0x80) !== 0;
      if (ctrl && alt) return 0;
      if (vk >= 0x41 && vk <= 0x5A) return ctrl ? vk - 0x40 : (shift !== caps ? vk : vk + 32);
      if (ctrl) return vk === 0x0D ? 10 : vk === 0x08 ? 0x7F : vk === 0xDB ? 0x1B : vk === 0xDC ? 0x1C : vk === 0xDD ? 0x1D : vk === 0x20 ? 0x20 : 0;
      if (vk >= 0x30 && vk <= 0x39) return shift ? ')!@#$%^&*('.charCodeAt(vk - 0x30) : vk;
      if (vk >= 0x60 && vk <= 0x69) return vk - 0x30;
      if (vk === 0x20) return 0x20;
      if (vk === 0x0D) return 13;
      if (vk === 0x08) return 8;
      if (vk === 0x09) return 9;
      if (vk === 0x1B) return 27;
      if (OEM[vk]) return OEM[vk].charCodeAt(shift ? 1 : 0);
      if (PADOP[vk]) return PADOP[vk].charCodeAt(0);
      return 0;
    };
    d('ToAscii', 5, (m, vk, scan, ksp, outp) => {
      vk &= 255;
      if (scan & 0x8000) return 0;                                  // key release
      const cur = m.input.cur;
      let ch;
      if (cur && cur.vk === vk && cur.ch >= 0) ch = cur.ch;
      else ch = usChar(vk, ksp ? (i) => c.u8[ksp + i] : (i) => m.input.tkeys[i]);
      if (!ch) return 0;
      if (outp) { c.u8[outp] = ch & 255; c.u8[outp + 1] = 0; }
      return 1;
    });
    d('OpenClipboard', 1, () => 0);
    d('EmptyClipboard', 0, () => 0);
    d('CloseClipboard', 0, () => 0);
    d('GetClipboardData', 1, () => 0);
    d('SetClipboardData', 2, () => 0);
    d('GetDC', 1, (m) => m.newHandle({ type: 'dc', surface: null, textColor: 0, bkColor: 0xFFFFFF, bkMode: 2, font: null, pal: null }));
    d('ReleaseDC', 2, (m, h, dc) => { m.closeHandle(dc); return 1; });
  }
  EMU.installUser32 = install;
  EMU.WM = WM;
})(typeof globalThis !== 'undefined' ? globalThis : this);
