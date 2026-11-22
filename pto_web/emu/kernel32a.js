/* KERNEL32 stand-ins, part A: process, heap, virtual memory, time, environment, locale */
(function (G) {
  'use strict';
  const EMU = G.EMU;
  const K32 = 'KERNEL32.dll';

  function install(m) {
    const d = (name, n, fn) => m.def(K32, name, n, fn);
    const c = m.cpu;
    m.cmdLine = m.scratchStr('"C:\\BEAR\\BEAR.EXE"');
    m.pid = 0x4d2;
    const envText = 'PATH=C:\\WINDOWS;C:\\WINDOWS\\SYSTEM\0TEMP=C:\\TEMP\0TMP=C:\\TEMP\0windir=C:\\WINDOWS\0';
    m.envA = m.scratch(envText.length + 2);
    for (let i = 0; i < envText.length; i++) c.u8[m.envA + i] = envText.charCodeAt(i);
    m.envW = m.scratch((envText.length + 2) * 2);
    for (let i = 0; i < envText.length; i++) c.u16[(m.envW >> 1) + i] = envText.charCodeAt(i);

    // ---- process / errors
    d('GetVersion', 0, () => 0x08930005);                    // Windows 2000 (5.0, build 2195)
    d('GetLastError', 0, () => m.lastError);
    d('SetLastError', 1, (m, e) => { m.lastError = e; });
    d('GetCommandLineA', 0, () => m.cmdLine);
    d('GetCurrentProcess', 0, () => -1);
    d('GetCurrentProcessId', 0, () => m.pid);
    d('OpenProcess', 3, () => 0x2000);
    d('GetExitCodeProcess', 2, (m, h, p) => { if (p) m.wr32(p, 259); return 1; });
    d('TerminateProcess', 2, (m, h, code) => { throw new EMU.HostExit(code); });
    d('ExitProcess', 1, (m, code) => { throw new EMU.HostExit(code); });
    d('OutputDebugStringA', 1, (m, s) => { if (m.opts.debugOut) m.log('[dbg] ' + m.cstr(s)); });
    d('GetStartupInfoA', 1, (m, p) => { m.zero(p, 68); m.wr32(p, 68); });
    d('SetHandleCount', 1, (m, n) => n);
    d('GetStdHandle', 1, (m, id) => id === -10 ? 3 : id === -11 ? 7 : 11);
    d('SetStdHandle', 2, () => 1);
    d('GetFileType', 1, (m, h) => (h === 3 || h === 7 || h === 11) ? 2 : 1);
    d('UnhandledExceptionFilter', 1, () => 0);
    d('SetUnhandledExceptionFilter', 1, () => 0);
    d('RtlUnwind', 4, () => { m.log('[warn] RtlUnwind called'); });
    d('RaiseException', 4, (m, code, flags, n, args) => { throw new Error('RaiseException code=0x' + (code >>> 0).toString(16) + ' flags=' + flags + ' at ret 0x' + (m.rd32(m.sp - 4) >>> 0).toString(16)); });
    d('FormatMessageA', 7, (m, flags, src, id, lang, buf, size, args) => { const s = 'Error ' + id; if (buf && size > s.length) m.putStr(buf, s); return s.length; });
    d('InterlockedIncrement', 1, (m, p) => { const v = (m.rd32(p) + 1) | 0; m.wr32(p, v); return v; });
    d('InterlockedDecrement', 1, (m, p) => { const v = (m.rd32(p) - 1) | 0; m.wr32(p, v); return v; });
    d('IsBadReadPtr', 2, (m, p, n) => (p < 0x10000 || p + n > c.memSize) ? 1 : 0);
    d('IsBadWritePtr', 2, (m, p, n) => (p < 0x10000 || p + n > c.memSize) ? 1 : 0);
    d('IsBadCodePtr', 1, (m, p) => (p < 0x10000 || p > c.memSize) ? 1 : 0);
    d('lstrcpyA', 2, (m, dst, src) => { m.putStr(dst, m.cstr(src, 1 << 20)); return dst; });
    d('lstrlenA', 1, (m, s) => m.cstr(s, 1 << 20).length);
    d('GetModuleFileNameA', 3, (m, h, buf, size) => { const s = m.imagePath; if (size <= s.length) return 0; m.putStr(buf, s); return s.length; });
    d('GetModuleHandleA', 1, (m, name) => { if (!name) return m.imageBase; const n = m.cstr(name).toLowerCase(); if (n.indexOf('bear') >= 0) return m.imageBase; return m.moduleHandle(n); });
    d('GetProfileStringA', 5, (m, app, key, def, buf, size) => { const s = def ? m.cstr(def) : ''; const n = Math.min(s.length, size - 1); if (size > 0) m.putStr(buf, s.substr(0, n)); return n; });
    d('GetTickCount', 0, () => Math.floor(m.now()) | 0);

    // ---- heap
    const procHeap = m.newHandle({ type: 'heap' });
    d('GetProcessHeap', 0, () => procHeap);
    d('HeapCreate', 3, () => m.newHandle({ type: 'heap' }));
    d('HeapDestroy', 1, () => 1);
    d('HeapAlloc', 3, (m, h, flags, size) => m.malloc(size, (flags & 8) !== 0));
    d('HeapFree', 3, (m, h, flags, p) => { m.free(p); return 1; });
    d('HeapSize', 3, (m, h, flags, p) => m.msize(p));
    d('HeapReAlloc', 4, (m, h, flags, p, size) => {
      const old = m.msize(p), a = m.malloc(size, false);
      c.u8.copyWithin(a, p, p + Math.min(old, size));
      if ((flags & 8) && size > old) m.zero(a + old, size - old);
      m.free(p); return a;
    });
    d('GlobalAlloc', 2, (m, flags, size) => m.malloc(size, (flags & 0x40) !== 0));
    d('GlobalFree', 1, (m, p) => { m.free(p); return 0; });
    d('GlobalLock', 1, (m, p) => p);
    d('GlobalUnlock', 1, () => 0);
    d('GlobalMemoryStatus', 1, (m, p) => {
      m.zero(p, 32); m.wr32(p, 32); m.wr32(p + 4, 30);
      m.wr32(p + 8, 256 << 20); m.wr32(p + 12, 180 << 20); m.wr32(p + 16, 512 << 20); m.wr32(p + 20, 400 << 20);
      m.wr32(p + 24, 0x7FFE0000); m.wr32(p + 28, 0x70000000);
    });

    // ---- virtual memory
    m.vregions = new Map();
    d('VirtualAlloc', 4, (m, addr, size, type, prot) => {
      if (addr) {
        for (const [b, r] of m.vregions) if (addr >= b && addr < b + r) return addr;
      }
      const a = m.valloc(size || 0x1000);
      m.vregions.set(a, (size + 0xFFFF) & ~0xFFFF);
      return a;
    });
    d('VirtualFree', 3, (m, addr, size, type) => {
      if (type & 0x8000) { const r = m.vregions.get(addr); if (r) { m.vfree(addr, r); m.vregions.delete(addr); } }
      return 1;
    });
    d('VirtualQuery', 3, (m, addr, p, len) => {
      let base = addr & ~0xFFF, size = 0x10000;
      for (const [b, r] of m.vregions) if (addr >= b && addr < b + r) { base = b; size = r; break; }
      m.zero(p, 28);
      m.wr32(p, base); m.wr32(p + 4, base); m.wr32(p + 8, 4); m.wr32(p + 12, size); m.wr32(p + 16, 0x1000); m.wr32(p + 20, 4); m.wr32(p + 24, 0x20000);
      return 28;
    });
    d('GetSystemInfo', 1, (m, p) => {
      m.zero(p, 36);
      m.wr16(p, 0); m.wr32(p + 4, 4096); m.wr32(p + 8, 0x10000); m.wr32(p + 12, 0x7FFEFFFF); m.wr32(p + 16, 1); m.wr32(p + 20, 1); m.wr32(p + 24, 586); m.wr32(p + 28, 0x10000); m.wr16(p + 32, 5);
    });

    // ---- time
    const ftFromMs = ms => BigInt(Math.floor(ms)) * 10000n + 116444736000000000n;
    const putFt = (p, ft) => { m.wr32(p, Number(ft & 0xFFFFFFFFn) | 0); m.wr32(p + 4, Number(ft >> 32n) | 0); };
    const getFt = p => (BigInt(m.rd32(p + 4) >>> 0) << 32n) | BigInt(m.rd32(p) >>> 0);
    const putSt = (p, dt) => { m.wr16(p, dt.getUTCFullYear()); m.wr16(p + 2, dt.getUTCMonth() + 1); m.wr16(p + 4, dt.getUTCDay()); m.wr16(p + 6, dt.getUTCDate()); m.wr16(p + 8, dt.getUTCHours()); m.wr16(p + 10, dt.getUTCMinutes()); m.wr16(p + 12, dt.getUTCSeconds()); m.wr16(p + 14, dt.getUTCMilliseconds()); };
    const wallMs = () => (m.opts.fixedWallClock || Date.UTC(1999, 10, 15, 12, 0, 0)) + Math.floor(m.now());
    d('GetLocalTime', 1, (m, p) => putSt(p, new Date(wallMs())));
    d('GetSystemTimeAsFileTime', 1, (m, p) => putFt(p, ftFromMs(wallMs())));
    d('FileTimeToLocalFileTime', 2, (m, a, b) => putFt(b, getFt(a)) || 1);
    d('FileTimeToSystemTime', 2, (m, a, b) => { putSt(b, new Date(Number((getFt(a) - 116444736000000000n) / 10000n))); return 1; });
    d('FileTimeToDosDateTime', 3, (m, a, pd, pt) => {
      const dt = new Date(Number((getFt(a) - 116444736000000000n) / 10000n));
      m.wr16(pd, ((dt.getUTCFullYear() - 1980) << 9) | ((dt.getUTCMonth() + 1) << 5) | dt.getUTCDate());
      m.wr16(pt, (dt.getUTCHours() << 11) | (dt.getUTCMinutes() << 5) | (dt.getUTCSeconds() >> 1)); return 1;
    });
    d('GetTimeZoneInformation', 1, (m, p) => { m.zero(p, 172); return 1; });

    // ---- environment
    d('GetEnvironmentStrings', 0, () => m.envA);
    d('GetEnvironmentStringsW', 0, () => m.envW);
    d('FreeEnvironmentStringsA', 1, () => 1);
    d('FreeEnvironmentStringsW', 1, () => 1);
    d('SetEnvironmentVariableA', 2, () => 1);

    // ---- locale / strings
    d('GetACP', 0, () => 1252);
    d('GetOEMCP', 0, () => 437);
    d('GetCPInfo', 2, (m, cp, p) => { m.zero(p, 20); m.wr32(p, 1); c.u8[p + 4] = 0x3f; return 1; });
    d('MultiByteToWideChar', 6, (m, cp, flags, src, n, dst, max) => {
      if (n === -1) n = m.cstr(src, 1 << 20).length + 1;
      if (!max) return n;
      const k = Math.min(n, max);
      for (let i = 0; i < k; i++) c.u16[(dst >> 1) + i] = c.u8[src + i];
      return k;
    });
    d('WideCharToMultiByte', 8, (m, cp, flags, src, n, dst, max, defc, used) => {
      if (n === -1) { n = 0; while (c.u16[(src >> 1) + n]) n++; n++; }
      if (used) m.wr32(used, 0);
      if (!max) return n;
      const k = Math.min(n, max);
      for (let i = 0; i < k; i++) { const ch = c.u16[(src >> 1) + i]; c.u8[dst + i] = ch < 256 ? ch : 0x3f; }
      return k;
    });
    const ctype = ch => {
      let f = 0;
      if (ch >= 65 && ch <= 90) f |= 0x101; else if (ch >= 97 && ch <= 122) f |= 0x102;
      else if (ch >= 48 && ch <= 57) f |= 4;
      if (ch === 32) f |= 0x48; else if ((ch >= 9 && ch <= 13)) f |= 8;
      if ((ch >= 33 && ch <= 47) || (ch >= 58 && ch <= 64) || (ch >= 91 && ch <= 96) || (ch >= 123 && ch <= 126)) f |= 0x10;
      if (ch < 32 || ch === 127) f |= 0x20;
      if ((ch >= 48 && ch <= 57) || (ch >= 65 && ch <= 70) || (ch >= 97 && ch <= 102)) f |= 0x80;
      if (ch >= 192 && ch < 256 && ch !== 215 && ch !== 247) f |= (ch < 224 ? 0x101 : 0x102);
      return f;
    };
    d('GetStringTypeA', 5, (m, lcid, type, src, n, out) => {
      if (n === -1) n = m.cstr(src, 1 << 20).length + 1;
      for (let i = 0; i < n; i++) c.u16[(out >> 1) + i] = type === 1 ? ctype(c.u8[src + i]) : 0;
      return 1;
    });
    d('GetStringTypeW', 4, (m, type, src, n, out) => {
      if (n === -1) { n = 0; while (c.u16[(src >> 1) + n]) n++; n++; }
      for (let i = 0; i < n; i++) c.u16[(out >> 1) + i] = type === 1 ? ctype(c.u16[(src >> 1) + i]) : 0;
      return 1;
    });
    const mapCh = (ch, flags) => (flags & 0x200) ? (ch >= 97 && ch <= 122 ? ch - 32 : ch) : (flags & 0x100) ? (ch >= 65 && ch <= 90 ? ch + 32 : ch) : ch;
    d('LCMapStringA', 6, (m, lcid, flags, src, n, dst, max) => {
      if (n === -1) n = m.cstr(src, 1 << 20).length + 1;
      if (!max) return n;
      const k = Math.min(n, max); for (let i = 0; i < k; i++) c.u8[dst + i] = mapCh(c.u8[src + i], flags); return k;
    });
    d('LCMapStringW', 6, (m, lcid, flags, src, n, dst, max) => {
      if (n === -1) { n = 0; while (c.u16[(src >> 1) + n]) n++; n++; }
      if (!max) return n;
      const k = Math.min(n, max); for (let i = 0; i < k; i++) c.u16[(dst >> 1) + i] = mapCh(c.u16[(src >> 1) + i], flags); return k;
    });
    const cmp = (a, b, ic) => { if (ic) { a = a.toLowerCase(); b = b.toLowerCase(); } return a < b ? 1 : a > b ? 3 : 2; };
    d('CompareStringA', 6, (m, lcid, flags, s1, n1, s2, n2) => {
      const a = n1 === -1 ? m.cstr(s1, 1 << 20) : m.cstr(s1, n1).substr(0, n1), b = n2 === -1 ? m.cstr(s2, 1 << 20) : m.cstr(s2, n2).substr(0, n2);
      return cmp(a, b, flags & 1);
    });
    d('CompareStringW', 6, (m, lcid, flags, s1, n1, s2, n2) => {
      const rw = (p, n) => { let s = ''; for (let i = 0; (n === -1 || i < n); i++) { const ch = c.u16[(p >> 1) + i]; if (n === -1 && !ch) break; s += String.fromCharCode(ch); } return s; };
      return cmp(rw(s1, n1), rw(s2, n2), flags & 1);
    });
  }
  EMU.installKernel32a = install;
})(typeof globalThis !== 'undefined' ? globalThis : this);
