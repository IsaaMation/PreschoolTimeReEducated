/* Small stand-ins that the Disney Playhouse client imports but does not really need:
 * registry odds and ends (advapi32/shlwapi), shell32, printing (winspool/comdlg32: "no printer"), BugslayerUtil (crash reports).
 */
(function (G) {
  'use strict';
  const EMU = G.EMU;

  function install(m) {
    const c = m.cpu;
    const trace = s => { if (m.opts.traceFiles) m.log('  [misc] ' + s); };
    const reg = m.registry = m.registry || new Map();
    const ROOTS = { 0x80000000: 'hkcr', 0x80000001: 'hkcu', 0x80000002: 'hklm', 0x80000003: 'hku' };
    const keyPath = h => { if (ROOTS[h >>> 0]) return ROOTS[h >>> 0]; const o = m.getHandle(h); return o && o.type === 'key' ? o.path : null; };
    const norm = (base, sub) => (base + '\\' + (sub || '')).toLowerCase().replace(/\\+/g, '\\').replace(/\\$/, '');

    // ---------------------------------------------------------------- registry
    m.def('ADVAPI32.dll', 'RegCreateKeyA', 3, (m, hk, sub, pOut) => {
      const base = keyPath(hk); if (base === null) return 6;
      const p = norm(base, sub ? m.cstr(sub) : '');
      if (!reg.has(p)) reg.set(p, new Map());
      trace('RegCreateKey ' + p);
      m.wr32(pOut, m.newHandle({ type: 'key', path: p })); return 0;
    });
    m.def('SHLWAPI.dll', 'SHDeleteValueA', 3, (m, hk, sub, name) => {
      const base = keyPath(hk); if (base === null) return 6;
      const p = norm(base, sub ? m.cstr(sub) : ''), k = reg.get(p);
      if (!k || !k.delete((name ? m.cstr(name) : '').toLowerCase())) return 2;
      return 0;
    });
    m.def('SHLWAPI.dll', 'SHDeleteKeyA', 2, (m, hk, sub) => {
      const base = keyPath(hk); if (base === null) return 6;
      const p = norm(base, sub ? m.cstr(sub) : '');
      let any = false;
      for (const k of [...reg.keys()]) if (k === p || k.startsWith(p + '\\')) { reg.delete(k); any = true; }
      return any ? 0 : 2;
    });

    // ---------------------------------------------------------------- shell32
    m.def('SHELL32.dll', 'DragQueryFileA', 4, () => 0);
    m.def('SHELL32.dll', 'ShellExecuteExA', 1, (m, p) => {
      // SHELLEXECUTEINFO: cbSize, fMask, hwnd, lpVerb, lpFile, lpParameters, lpDirectory, nShow, hInstApp
      const file = m.rd32(p + 16) ? m.cstr(m.rd32(p + 16)) : '', verb = m.rd32(p + 12) ? m.cstr(m.rd32(p + 12)) : '', par = m.rd32(p + 20) ? m.cstr(m.rd32(p + 20)) : '';
      m.log('  [shell] ' + (verb || 'open') + ' ' + file + (par ? ' ' + par : ''));
      if (m.onShellExecute) m.onShellExecute(verb || 'open', file, par);
      m.wr32(p + 32, 42);
      return 1;
    });

    // ---------------------------------------------------------------- printing: one pretend printer
    // The game asks for the default printer when it starts and shows "connect or turn on your printer" when there is none. There is
    // one here: a Letter-size printer whose pages are handed to the host page (see StartDoc/EndDoc in gdi32.js). Paper is 8.5 x 11 in.
    const WS = 'winspool.drv', PRINTER = 'Browser Printer', DEVMODE_SIZE = 156;
    const putStr = (p, s) => { for (let i = 0; i < s.length; i++) m.wr8(p + i, s.charCodeAt(i)); m.wr8(p + s.length, 0); };
    function devMode(p) {                                                    // DEVMODEA: portrait Letter, colour, 300 dpi
      for (let i = 0; i < DEVMODE_SIZE; i++) m.wr8(p + i, 0);
      putStr(p, PRINTER.substr(0, 31));
      m.wr16(p + 32, 0x0401); m.wr16(p + 34, 0x0401); m.wr16(p + 36, DEVMODE_SIZE); m.wr16(p + 38, 0);
      m.wr32(p + 40, 0x1 | 0x2 | 0x100 | 0x400 | 0x800 | 0x2000);            // orientation, paper size, copies, quality, colour, y resolution
      m.wr16(p + 44, 1); m.wr16(p + 46, 1); m.wr16(p + 54, 1);               // portrait, Letter, 1 copy
      m.wr16(p + 58, 300); m.wr16(p + 60, 2); m.wr16(p + 64, 300);           // 300 dpi, colour
      putStr(p + 70, 'Letter');
    }
    m.def(WS, 'OpenPrinterA', 3, (m, name, pOut) => { if (pOut) m.wr32(pOut, m.newHandle({ type: 'printer' })); return 1; });
    m.def(WS, 'ClosePrinter', 1, () => 1);
    // The printer's description as the PRINTER_INFO_n structures of the levels that programs ask for: 1, 2 (with its DEVMODE), 4 and 5.
    // Each gives the structure, then the strings (as Windows does: everything is inside the caller's buffer).
    const INFO = {
      1: { size: 16, strs: [[8, PRINTER], [4, PRINTER + ',Browser Printer Driver,'], [12, '']], fill: b => { m.wr32(b, 0x8); } },            // PRINTER_INFO_1A: Flags, pDescription, pName, pComment
      2: { size: 84, extra: DEVMODE_SIZE, strs: [[4, PRINTER], [12, 'BROWSER:'], [16, 'Browser Printer Driver'], [36, 'WinPrint'], [40, 'RAW']],
        fill: (b, q) => { devMode(q); m.wr32(b + 28, q); m.wr32(b + 52, 0x40); m.wr32(b + 56, 1); m.wr32(b + 60, 1); } },                // pDevMode, Attributes: local, Priority, DefaultPriority
      4: { size: 12, strs: [[0, PRINTER]], fill: b => { m.wr32(b + 8, 0x40); } },                                                      // PRINTER_INFO_4A: pPrinterName, pServerName, Attributes
      5: { size: 20, strs: [[0, PRINTER], [4, 'BROWSER:']], fill: b => { m.wr32(b + 8, 0x40); m.wr32(b + 12, 15000); m.wr32(b + 16, 90000); } },     // PRINTER_INFO_5A
    };
    /** writes the printer's PRINTER_INFO_<level> into buf (cb bytes); returns the size needed (0: no such level) and whether it fitted */
    function printerInfo(level, buf, cb) {
      const I = INFO[level]; if (!I) return { need: 0, ok: false };
      const need = I.size + (I.extra || 0) + I.strs.reduce((a, e) => a + e[1].length + 1, 0);
      if (!buf || cb < need) return { need, ok: false };
      for (let i = 0; i < I.size; i++) m.wr8(buf + i, 0);
      let q = buf + I.size;
      const dm = q; q += I.extra || 0;
      for (const [off, str] of I.strs) { putStr(q, str); m.wr32(buf + off, q); q += str.length + 1; }
      I.fill(buf, dm);
      return { need, ok: true };
    }
    m.def(WS, 'GetPrinterA', 5, (m, h, level, buf, cb, pNeeded) => {
      if (level !== 2) { m.lastError = 124; return 0; }                      // ERROR_INVALID_LEVEL (only level 2 is offered; the others are for enumerating)
      const r = printerInfo(level, buf, cb);
      if (pNeeded) m.wr32(pNeeded, r.need);
      if (!r.ok) { m.lastError = 122; return 0; }                            // ERROR_INSUFFICIENT_BUFFER
      return 1;
    });
    // EnumPrintersA(Flags, Name, Level, pPrinterEnum, cbBuf, pcbNeeded, pcReturned): the one printer is a local printer (PRINTER_ENUM_LOCAL 2, ..._DEFAULT 1, ..._NAME 8 with no
    // server name); it is not a connection (4), a shared (0x20), a remote (0x10) or a network (0x40) one.  Like the real call it says how much room it needs when the buffer is too small.
    // The game also lists the printers while it starts up.  To keep that start exactly as it was in the earlier versions (where the list was always empty), the printer is offered only
    // once the page's Flash content (Manny) has connected to the game's socket (m.printerShown, set by m.net.connectLocal in ws2_32.js): before that the list is empty and the call
    // succeeds, as it always did.
    m.def(WS, 'EnumPrintersA', 7, (m, flags, name, level, buf, cb, pNeeded, pRet) => {
      if (pNeeded) m.wr32(pNeeded, 0); if (pRet) m.wr32(pRet, 0);
      if (!m.printerShown) return 1;                                         // no printers (yet)
      if (!INFO[level]) { m.lastError = 124; return 0; }                     // ERROR_INVALID_LEVEL
      const listed = (flags & 0xb) !== 0 && !(name && m.cstr(name));
      if (!listed) return 1;                                                 // no printers of that kind
      const r = printerInfo(level, buf, cb);
      if (pNeeded) m.wr32(pNeeded, r.need);
      if (!r.ok) { m.lastError = 122; return 0; }                            // ERROR_INSUFFICIENT_BUFFER
      if (pRet) m.wr32(pRet, 1);
      return 1;
    });
    m.def(WS, 'SetPrinterA', 4, () => { m.lastError = 5; return 0; });
    m.def(WS, 'DocumentPropertiesA', 6, (m, hwnd, hPrn, name, pOut, pIn, mode) => {
      if (mode === 0) return DEVMODE_SIZE;                                   // size wanted
      if (pOut && (mode & 2)) devMode(pOut);                                 // DM_OUT_BUFFER
      return 1;                                                              // IDOK
    });
    m.def(WS, '#201', 2, (m, buf, pSize) => {                               // GetDefaultPrinterA(buf, &size)
      const need = PRINTER.length + 1;
      if (!pSize) { m.lastError = 87; return 0; }
      if (!buf || m.rd32(pSize) < need) { m.wr32(pSize, need); m.lastError = 122; return 0; }
      putStr(buf, PRINTER); m.wr32(pSize, need); return 1;
    });
    m.def(WS, '#202', 1, () => 1);                                           // SetDefaultPrinterA(name)
    m.def('COMDLG32.dll', 'PrintDlgA', 1, () => 0);                           // the program never shows the dialog; cancelled if it did

    // ---------------------------------------------------------------- imports that the older programs name but do not depend on
    m.def('KERNEL32.dll', 'IsProcessorFeaturePresent', 1, () => 0);                     // none of the optional CPU features
    m.def('USER32.dll', 'WaitForInputIdle', 2, () => 0);
    m.def('d3d9.dll', 'Direct3DCreate9', 1, () => 0);                                   // no Direct3D: the program falls back to plain bitmap output
    m.def('ADVAPI32.dll', 'RegOpenKeyA', 3, (m, hk, sub, pOut) => m.apis.get('advapi32.dll!RegOpenKeyExA').fn(m, hk, sub, 0, 0x20019, pOut));

    // ---------------------------------------------------------------- BugslayerUtil (crash handler of the original program)
    const BU = 'BugslayerUtil.dll';
    const empty = m.scratchStr('');
    m.def(BU, 'SetCrashHandlerFilter', 1, () => 1);
    m.def(BU, 'GetFaultReason', 1, () => empty);
    m.def(BU, 'GetFirstStackTraceString', 2, () => empty);
    m.def(BU, 'GetNextStackTraceString', 2, () => 0);
    m.def(BU, 'GetRegisterString', 0, () => empty);
  }
  EMU.installMisc = install;
})(typeof globalThis !== 'undefined' ? globalThis : this);
