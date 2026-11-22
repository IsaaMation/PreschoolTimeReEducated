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
    m.def(WS, 'GetPrinterA', 5, (m, h, level, buf, cb, pNeeded) => {
      // PRINTER_INFO_2A (84 bytes) followed by the DEVMODE and the strings; no other level is offered
      if (level !== 2) { m.lastError = 124; return 0; }                      // ERROR_INVALID_LEVEL
      const fixed = 84, strs = [[4, PRINTER], [12, 'BROWSER:'], [16, 'Browser Printer Driver'], [36, 'WinPrint'], [40, 'RAW']];
      const need = fixed + DEVMODE_SIZE + strs.reduce((a, e) => a + e[1].length + 1, 0);
      if (pNeeded) m.wr32(pNeeded, need);
      if (!buf || cb < need) { m.lastError = 122; return 0; }                // ERROR_INSUFFICIENT_BUFFER
      for (let i = 0; i < fixed; i++) m.wr8(buf + i, 0);
      let q = buf + fixed;
      devMode(q); m.wr32(buf + 28, q); q += DEVMODE_SIZE;                    // pDevMode
      for (const [off, str] of strs) { putStr(q, str); m.wr32(buf + off, q); q += str.length + 1; }
      m.wr32(buf + 52, 0x40);                                                // Attributes: local printer
      m.wr32(buf + 56, 1); m.wr32(buf + 60, 1);                              // Priority, DefaultPriority
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
