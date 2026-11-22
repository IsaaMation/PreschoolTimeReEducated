/* USER32 stand-ins, part B: window management odds and ends the Disney Playhouse client uses */
(function (G) {
  'use strict';
  const EMU = G.EMU;
  const U = 'USER32.dll';
  const WM_DESTROY = 2, WM_PAINT = 0xF, WM_NCDESTROY = 0x82, WM_SHOWWINDOW = 0x18, WM_SIZE = 5;
  const WS_CAPTION = 0xC00000, WS_BORDER = 0x800000, WS_DLGFRAME = 0x400000, WS_THICKFRAME = 0x40000;

  function install(m) {
    const d = (name, n, fn) => m.def(U, name, n, fn);
    const c = m.cpu;
    const trace = s => { if (m.opts.traceFiles) m.log('  [wnd] ' + s); };
    m.screenW = 1024; m.screenH = 768;
    m.capture = 0; m.hooks = new Map(); m.nextHook = 0x500;

    /** border width and caption height of a window with this style */
    const frameOf = (w) => {
      const st = w.style >>> 0;
      let b = 0, cap = 0;
      if (st & WS_THICKFRAME) b = 4; else if ((st & WS_CAPTION) === WS_CAPTION || (st & WS_DLGFRAME)) b = 3; else if (st & WS_BORDER) b = 1;
      if ((st & WS_CAPTION) === WS_CAPTION) cap = 19;
      return { b, cap };
    };
    m.clientRect = (w) => { const f = frameOf(w); return { l: 0, t: 0, r: Math.max(0, w.w - 2 * f.b), b: Math.max(0, w.h - 2 * f.b - f.cap) }; };

    d('GetClientRect', 2, (m, h, p) => {
      const w = m.windows.get(h);
      const r = w ? m.clientRect(w) : { l: 0, t: 0, r: m.screenW, b: m.screenH };
      m.wr32(p, r.l); m.wr32(p + 4, r.t); m.wr32(p + 8, r.r); m.wr32(p + 12, r.b); return 1;
    });
    d('ClientToScreen', 2, (m, h, p) => { const w = m.windows.get(h); if (w) { const f = frameOf(w); m.wr32(p, m.rd32(p) + w.x + f.b); m.wr32(p + 4, m.rd32(p + 4) + w.y + f.b + f.cap); } return 1; });
    d('ScreenToClient', 2, (m, h, p) => { const w = m.windows.get(h); if (w) { const f = frameOf(w); m.wr32(p, m.rd32(p) - w.x - f.b); m.wr32(p + 4, m.rd32(p + 4) - w.y - f.b - f.cap); } return 1; });
    // ---- activation: ShowWindow on the first top-level window of the process activates it, and Windows sends the activation
    // messages synchronously from inside the call (the game builds its screen in its WM_ACTIVATEAPP handler).
    const WM_NCACTIVATE = 0x86, WM_ACTIVATEAPP = 0x1C, WM_ACTIVATE = 6, WM_SETFOCUS = 7, WM_KILLFOCUS = 8, WS_CHILD = 0x40000000;
    m.activeWnd = 0; m.focusWnd = 0; m.appActive = false;
    m.activateWindow = (h) => {
      const w = m.windows.get(h); if (!w || (w.style & WS_CHILD) || m.activeWnd === h) return;
      const tid = m.cur ? m.cur.id : 0x3E8;
      if (!m.appActive) { m.appActive = true; trace('WM_ACTIVATEAPP -> ' + h.toString(16)); m.callProc(h, WM_ACTIVATEAPP, 1, tid); }
      const prev = m.activeWnd;
      if (prev && m.windows.has(prev)) m.callProc(prev, WM_ACTIVATE, 0, h);
      m.activeWnd = h;
      m.callProc(h, WM_NCACTIVATE, 1, 0);
      m.callProc(h, WM_ACTIVATE, 1, prev || 0);
      const pf = m.focusWnd; m.focusWnd = h;
      m.callProc(h, WM_SETFOCUS, pf || 0, 0);
    };
    m.doShow = (h, cmd) => {
      const w = m.windows.get(h); if (!w) return 0;
      const was = w.visible ? 1 : 0;
      w.visible = cmd !== 0;
      trace('ShowWindow ' + h.toString(16) + ' cmd=' + cmd);
      if (w.visible && !was) {
        m.callProc(h, WM_SHOWWINDOW, 1, 0);
        if (cmd !== 4 && cmd !== 7 && cmd !== 8) m.activateWindow(h);
        w.invalid = true; m.postMessage(h, WM_PAINT, 0, 0);
      } else if (!w.visible && was) {
        m.callProc(h, WM_SHOWWINDOW, 0, 0);
      }
      return was;
    };
    d('ShowWindow', 2, (m, h, cmd) => m.doShow(h, cmd));
    d('GetActiveWindow', 0, () => m.activeWnd);
    d('GetForegroundWindow', 0, () => m.appActive ? m.activeWnd : 0);
    d('SetForegroundWindow', 1, (m, h) => { m.activateWindow(h); return 1; });
    d('SetActiveWindow', 1, (m, h) => { const o = m.activeWnd; m.activateWindow(h); return o; });
    d('IsWindowVisible', 1, (m, h) => { const w = m.windows.get(h); return w && w.visible !== false ? 1 : 0; });
    d('MoveWindow', 6, (m, h, x, y, cx, cy, repaint) => { const w = m.windows.get(h); if (!w) return 0; w.x = x | 0; w.y = y | 0; w.w = cx | 0; w.h = cy | 0; trace('MoveWindow ' + x + ',' + y + ' ' + cx + 'x' + cy); return 1; });
    d('SetWindowPos', 7, (m, h, after, x, y, cx, cy, flags) => {
      const w = m.windows.get(h); if (!w) return 0;
      if (!(flags & 2)) { w.x = x | 0; w.y = y | 0; }
      if (!(flags & 1)) { w.w = cx | 0; w.h = cy | 0; }
      trace('SetWindowPos ' + (flags & 2 ? '' : x + ',' + y + ' ') + (flags & 1 ? '' : cx + 'x' + cy) + ' flags=0x' + (flags >>> 0).toString(16));
      return 1;
    });
    d('DestroyWindow', 1, (m, h) => {
      const w = m.windows.get(h); if (!w) return 0;
      trace('DestroyWindow ' + h.toString(16));
      m.callProc(h, WM_DESTROY, 0, 0); m.callProc(h, WM_NCDESTROY, 0, 0);
      m.windows.delete(h);
      if (m.mainWnd === h) m.mainWnd = 0;
      return 1;
    });
    d('UpdateWindow', 1, (m, h) => { const w = m.windows.get(h); if (w && w.invalid) { w.invalid = false; m.callProc(h, WM_PAINT, 0, 0); } return 1; });
    d('InvalidateRect', 3, (m, h) => {
      const w = m.windows.get(h); if (!w) return 1;
      if (!w.invalid) { w.invalid = true; m.postMessage(h, WM_PAINT, 0, 0); }
      return 1;
    });
    d('ValidateRect', 2, (m, h) => { const w = m.windows.get(h); if (w) w.invalid = false; return 1; });
    d('BeginPaint', 2, (m, h, ps) => {
      const w = m.windows.get(h);
      const dcH = m.newDC({ window: h });
      m.zero(ps, 64);
      m.wr32(ps, dcH);
      const r = w ? m.clientRect(w) : { l: 0, t: 0, r: m.screenW, b: m.screenH };
      m.wr32(ps + 8, r.l); m.wr32(ps + 12, r.t); m.wr32(ps + 16, r.r); m.wr32(ps + 20, r.b);
      if (w) w.invalid = false;
      return dcH;
    });
    d('EndPaint', 2, (m, h, ps) => { m.closeHandle(m.rd32(ps)); return 1; });
    d('GetDC', 1, (m, h) => m.newDC({ window: h || 0 }));
    d('ReleaseDC', 2, (m, h, dc) => { m.closeHandle(dc); return 1; });
    d('SetCapture', 1, (m, h) => { const o = m.capture; m.capture = h; return o; });
    d('ReleaseCapture', 0, () => { m.capture = 0; return 1; });
    d('GetCapture', 0, () => m.capture);
    d('GetWindow', 2, () => 0);
    d('IsWindowEnabled', 1, () => 1);
    d('EnableWindow', 2, () => 0);
    d('LockWindowUpdate', 1, () => 1);
    d('GetLastActivePopup', 1, (m, h) => h);
    d('FindWindowA', 2, (m, cls, title) => { trace('FindWindow ' + (cls ? m.cstr(cls) : '') + '/' + (title ? m.cstr(title) : '') + ' -> none'); return 0; });
    d('SetFocus', 1, (m, h) => { const o = m.focusWnd; if (h && m.windows.has(h) && h !== o) { if (o && m.windows.has(o)) m.callProc(o, WM_KILLFOCUS, h, 0); m.focusWnd = h; m.callProc(h, WM_SETFOCUS, o || 0, 0); } return o; });
    d('GetFocus', 0, () => m.focusWnd);
    d('SetCursorPos', 2, (m, x, y) => { m.input.x = x | 0; m.input.y = y | 0; return 1; });
    d('SetCursor', 1, () => 0);
    d('LoadCursorA', 2, (m, inst, name) => m.newHandle({ type: 'cursor', name: (name >>> 0) < 0x10000 ? name : m.cstr(name) }));
    d('SetWindowsHookExA', 4, (m, id, proc, hmod, tid) => { const h = m.nextHook++; m.hooks.set(h, { id, proc }); trace('SetWindowsHookEx id=' + id + ' proc=0x' + (proc >>> 0).toString(16)); return h; });
    d('UnhookWindowsHookEx', 1, (m, h) => { m.hooks.delete(h); return 1; });
    d('CallNextHookEx', 4, () => 0);
    d('SendMessageTimeoutA', 7, (m, h, msg, w, l, flags, timeout, pRes) => { const r = m.callProc(h, msg, w, l); if (pRes) m.wr32(pRes, r); return 1; });
    d('SystemParametersInfoA', 4, (m, act, ui, pv, win) => {
      if (act === 0x30 && pv) { m.wr32(pv, 0); m.wr32(pv + 4, 0); m.wr32(pv + 8, m.screenW); m.wr32(pv + 12, m.screenH - 30); return 1; }
      return 1;
    });
    d('DefWindowProcA', 4, (m, h, msg, w, l) => {
      if (msg === WM_PAINT) { const wnd = m.windows.get(h); if (wnd) wnd.invalid = false; return 0; }
      return (msg === 0x81 || msg === 0x84 || msg === 0x14) ? (msg === 0x84 ? 1 : 1) : 0;
    });
    d('GetSystemMetrics', 1, (m, i) => {
      switch (i) {
        case 0: return m.screenW; case 1: return m.screenH;
        case 2: case 3: return 17;                  // scroll bars
        case 4: return 19;                          // caption
        case 5: case 6: return 1;                   // border
        case 7: case 8: return 3;                   // dialog frame
        case 11: case 12: return 32; case 13: case 14: return 32;
        case 15: return 19;                         // menu
        case 16: return m.screenW; case 17: return m.screenH - 49;
        case 32: case 33: return 4;                 // sizing frame
        case 34: case 35: return 112; case 36: case 37: return 4;
        case 19: return 1;                          // mouse present
        case 43: return 3;
        case 78: return m.screenW; case 79: return m.screenH;
        default: return 0;
      }
    });
  }
  EMU.installUser32b = install;
})(typeof globalThis !== 'undefined' ? globalThis : this);
