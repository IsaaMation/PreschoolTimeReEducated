/* KERNEL32 stand-ins, part C: what the Disney Playhouse client needs beyond part A/B -
 * thread local storage, Sleep, performance counter, locale, console, mutexes, process/thread odds and ends,
 * and a cleaner mapping of Windows paths onto the hosted folder (one install root; everything else is "not found").
 */
(function (G) {
  'use strict';
  const EMU = G.EMU;
  const K32 = 'KERNEL32.dll';

  function install(m) {
    const d = (name, n, fn) => m.def(K32, name, n, fn);
    const c = m.cpu;
    const setErr = e => { m.lastError = e; };

    // ---------------------------------------------------------------- install root and path mapping
    m.installRoot = 'C:\\ProgramData\\Disney\\Disney Online\\Playhouse Disney\\Data';
    m.cwd = m.installRoot;
    m.userDirs = new Set();
    m.userFiles = m.userFiles || new Map();
    const rootLow = () => m.installRoot.toLowerCase();
    m.fullPath = function (p) {
      p = (p || '').replace(/\//g, '\\');
      let drive = 'C:';
      const dm = /^([A-Za-z]:)/.exec(p);
      if (dm) { drive = dm[1].toUpperCase(); p = p.substr(2); }
      else if (p.startsWith('\\\\')) { drive = ''; }
      else if (!p.startsWith('\\')) { const cm = /^([A-Za-z]:)(.*)$/.exec(m.cwd); drive = cm[1]; p = cm[2] + '\\' + p; }
      const out = [];
      for (const part of p.split('\\')) { if (part === '' || part === '.') continue; if (part === '..') out.pop(); else out.push(part); }
      return drive + '\\' + out.join('\\');
    };
    /** key inside the hosted folder ('' = its root), or null when the path is outside of it */
    m.vfsKey = function (full) {
      const low = full.toLowerCase().replace(/\\+$/, '');
      const root = rootLow();
      if (low === root) return '';
      if (low.startsWith(root + '\\')) return low.substr(root.length + 1).replace(/\\/g, '/');
      return null;
    };
    m.statPath = function (p) {
      const full = m.fullPath(p), low = full.toLowerCase().replace(/\\+$/, '');
      if (m.userFiles.has(low)) return { dir: false, size: m.userFiles.get(low).size };
      if (m.userDirs.has(low)) return { dir: true, size: 0 };
      if (/^[a-z]:$/i.test(low)) return { dir: true, size: 0 };
      const key = m.vfsKey(full);
      if (key === null) {
        // the folders above the install root exist
        const root = rootLow();
        if (root.startsWith(low + '\\') || root === low) return { dir: true, size: 0 };
        return null;
      }
      if (key === '') return { dir: true, size: 0 };
      return m.vfs ? m.vfs.stat(key) : null;
    };
    m.openRead = function (p) {
      const full = m.fullPath(p), low = full.toLowerCase();
      if (m.userFiles.has(low)) { const u = m.userFiles.get(low); return { size: u.size, read: (pos, n) => u.data.subarray(pos, Math.min(pos + n, u.size)), mem: u, low }; }
      const key = m.vfsKey(full);
      if (!key || !m.vfs) return null;
      const st = m.vfs.stat(key);
      if (!st || st.dir) return null;
      return m.vfs.open(key);
    };
    /** put a file into the writable overlay (settings, saved pictures ...) */
    m.putUserFile = function (path, bytes) {
      const full = m.fullPath(path).toLowerCase();
      const data = bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes);
      m.userFiles.set(full, { data, size: data.length });
      const dir = full.substr(0, full.lastIndexOf('\\'));
      let p = '';
      for (const part of dir.split('\\')) { p = p ? p + '\\' + part : part; m.userDirs.add(p); }
    };
    d('CreateDirectoryA', 2, (m, p) => {
      const full = m.fullPath(m.cstr(p)), low = full.toLowerCase();
      const st = m.statPath(full);
      if (st) { setErr(183); return 0; }
      m.userDirs.add(low); return 1;
    });
    d('RemoveDirectoryA', 1, (m, p) => { m.userDirs.delete(m.fullPath(m.cstr(p)).toLowerCase()); return 1; });
    d('SetFileAttributesA', 2, () => 1);
    d('GetDiskFreeSpaceExA', 4, (m, root, pAvail, pTotal, pFree) => {
      for (const p of [pAvail, pTotal, pFree]) if (p) { m.wr32(p, 0xC0000000 | 0); m.wr32(p + 4, 2); }
      return 1;
    });
    d('GetWindowsDirectoryA', 2, (m, buf, size) => { const s = 'C:\\WINDOWS'; if (size <= s.length) return s.length + 1; m.putStr(buf, s); return s.length; });
    d('GetComputerNameA', 2, (m, buf, pSize) => { const s = 'PLAYHOUSE-PC'; if (m.rd32(pSize) <= s.length) return 0; m.putStr(buf, s); m.wr32(pSize, s.length); return 1; });
    d('CopyFileA', 3, (m, src, dst, failIfExists) => {
      const f = m.openRead(m.cstr(src));
      if (!f) { setErr(2); return 0; }
      const dl = m.fullPath(m.cstr(dst)).toLowerCase();
      if (failIfExists && m.statPath(dl)) { setErr(80); return 0; }
      m.putUserFile(dl, new Uint8Array(f.read(0, f.size)));
      return 1;
    });
    d('MoveFileA', 2, (m, src, dst) => {
      const sl = m.fullPath(m.cstr(src)).toLowerCase(), dl = m.fullPath(m.cstr(dst)).toLowerCase();
      const u = m.userFiles.get(sl);
      if (u) { m.userFiles.delete(sl); m.userFiles.set(dl, u); return 1; }
      const f = m.openRead(m.cstr(src));
      if (!f) { setErr(2); return 0; }
      m.putUserFile(dl, new Uint8Array(f.read(0, f.size)));
      return 1;
    });
    // directory listing: hosted folder plus the writable overlay
    const wildcard = pat => new RegExp('^' + pat.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 'i');
    const fillFind = (p, e) => { m.zero(p, 320); m.wr32(p, e.dir ? 0x10 : 0x80); m.wr32(p + 32, e.size || 0); m.putStr(p + 44, e.name); };
    d('FindFirstFileA', 2, (m, pat, pfd) => {
      const full = m.fullPath(m.cstr(pat));
      const i = full.lastIndexOf('\\'), dir = full.substr(0, i), mask = wildcard(full.substr(i + 1));
      const dirLow = dir.toLowerCase();
      const list = [], seen = new Set();
      const key = m.vfsKey(dir + '\\');
      if (key !== null && m.vfs) for (const e of m.vfs.list(key)) if (mask.test(e.name)) { list.push(e); seen.add(e.name.toLowerCase()); }
      for (const [low, u] of m.userFiles) { const j = low.lastIndexOf('\\'); const nm = low.substr(j + 1); if (low.substr(0, j) === dirLow && mask.test(nm) && !seen.has(nm)) { list.push({ name: nm, dir: false, size: u.size }); seen.add(nm); } }
      for (const dl of m.userDirs) { const j = dl.lastIndexOf('\\'); const nm = dl.substr(j + 1); if (dl.substr(0, j) === dirLow && mask.test(nm) && !seen.has(nm)) { list.push({ name: nm, dir: true, size: 0 }); seen.add(nm); } }
      if (/^\.\.?$/.test(full.substr(i + 1)) || mask.test('.')) { /* "." and ".." are not listed */ }
      if (m.opts.traceFiles) m.log('  [file] find ' + full + ' -> ' + list.length + ' entries' + (list.length < 6 ? ' ' + list.map(e => e.name).join(',') : ''));
      if (!list.length) { setErr(2); return -1; }
      const o = { type: 'find', list, idx: 1 };
      const h = m.newHandle(o);
      fillFind(pfd, list[0]);
      return h;
    });
    d('FindNextFileA', 2, (m, h, pfd) => { const o = m.getHandle(h); if (!o || o.idx >= o.list.length) { setErr(18); return 0; } fillFind(pfd, o.list[o.idx++]); return 1; });

    // ---------------------------------------------------------------- version, time
    d('GetVersion', 0, () => 0x0A280105);                      // Windows XP (5.1, build 2600)
    d('GetVersionExA', 1, (m, p) => {
      const size = m.rd32(p);
      m.zero(p + 4, Math.max(0, size - 4));
      m.wr32(p + 4, 5); m.wr32(p + 8, 1); m.wr32(p + 12, 2600); m.wr32(p + 16, 2);
      m.putStr(p + 20, 'Service Pack 3');
      if (size >= 156) { c.u16[(p + 148) >> 1] = 3; c.u16[(p + 150) >> 1] = 0; c.u16[(p + 152) >> 1] = 0x100; c.u8[p + 154] = 1; }
      return 1;
    });
    const QPF = 10000000;
    d('QueryPerformanceFrequency', 1, (m, p) => { m.wr32(p, QPF); m.wr32(p + 4, 0); return 1; });
    d('QueryPerformanceCounter', 1, (m, p) => { const v = Math.floor(m.now() * (QPF / 1000)); m.wr32(p, v % 4294967296); m.wr32(p + 4, Math.floor(v / 4294967296)); return 1; });
    d('GetSystemTimeAdjustment', 3, (m, pAdj, pInc, pDis) => { m.wr32(pAdj, 156250); m.wr32(pInc, 156250); m.wr32(pDis, 1); return 1; });
    d('GetProcessAffinityMask', 3, (m, h, pProc, pSys) => { m.wr32(pProc, 3); m.wr32(pSys, 3); return 1; });
    d('GetDateFormatA', 6, (m, lcid, flags, pst, fmt, buf, size) => {
      const y = pst ? c.u16[(pst) >> 1] : 2010, mo = pst ? c.u16[(pst + 2) >> 1] : 1, dd = pst ? c.u16[(pst + 6) >> 1] : 1;
      const s = mo + '/' + dd + '/' + y;
      if (!size) return s.length + 1;
      if (size <= s.length) { setErr(122); return 0; }
      m.putStr(buf, s); return s.length + 1;
    });
    d('GetTimeFormatA', 6, (m, lcid, flags, pst, fmt, buf, size) => {
      const h = pst ? c.u16[(pst + 8) >> 1] : 12, mi = pst ? c.u16[(pst + 10) >> 1] : 0, se = pst ? c.u16[(pst + 12) >> 1] : 0;
      const s = ((h % 12) || 12) + ':' + String(mi).padStart(2, '0') + ':' + String(se).padStart(2, '0') + ' ' + (h < 12 ? 'AM' : 'PM');
      if (!size) return s.length + 1;
      if (size <= s.length) { setErr(122); return 0; }
      m.putStr(buf, s); return s.length + 1;
    });

    // ---------------------------------------------------------------- Sleep and threads
    d('Sleep', 1, (m, ms) => {
      ms >>>= 0;
      const t = m.cur;
      if (ms === 0) { c.yieldNow = true; return; }
      let pw = t.pendingSleep;
      if (!pw) pw = t.pendingSleep = { deadline: m.now() + ms };
      else if (m.now() >= pw.deadline) { t.pendingSleep = null; return; }
      return m.blockCurrent(c.curEip, m.sp - 4, null, pw.deadline);
    });
    d('GetCurrentThreadId', 0, () => m.cur.id);
    d('GetCurrentThread', 0, () => -2);
    d('DuplicateHandle', 7, (m, sp, src, dp, pDst, access, inherit, opts) => {
      const h = (src | 0) === -2 ? m.cur.handle : (src | 0) === -1 ? 0xFFFFFFFF : src;
      if (pDst) m.wr32(pDst, h);
      return 1;
    });
    d('SuspendThread', 1, (m, h) => { const o = m.getHandle(h); if (!o || !o.t) return -1; const t = o.t; const was = t.state === 'suspended' ? 1 : 0; if (t !== m.cur) t.state = 'suspended'; return was; });
    d('ResumeThread', 1, (m, h) => { const o = m.getHandle(h); if (!o || !o.t) return -1; const t = o.t; const was = t.state === 'suspended' ? 1 : 0; if (was) { t.state = 'ready'; } return was; });
    d('TerminateThread', 2, (m, h, code) => { const o = m.getHandle(h); if (!o || !o.t) return 0; if (o.t === m.cur) throw new EMU.HostExit(code); o.t.state = 'done'; o.t.exitCode = code; return 1; });
    d('GetThreadPriority', 1, () => 0);
    d('IsDebuggerPresent', 0, () => 0);
    d('DebugBreak', 0, () => { m.log('[warn] DebugBreak'); });
    d('FatalAppExitA', 2, (m, a, msg) => { m.log('[FatalAppExit] ' + m.cstr(msg)); throw new EMU.HostExit(1); });
    d('InterlockedExchange', 2, (m, p, v) => { const o = m.rd32(p); m.wr32(p, v); return o; });
    d('InterlockedCompareExchange', 3, (m, p, v, cmp) => { const o = m.rd32(p); if (o === (cmp | 0)) m.wr32(p, v); return o; });
    d('InterlockedExchangeAdd', 2, (m, p, v) => { const o = m.rd32(p); m.wr32(p, (o + v) | 0); return o; });

    // ---------------------------------------------------------------- thread local storage
    const tlsUsed = new Array(64).fill(false);
    d('TlsAlloc', 0, () => { for (let i = 0; i < 64; i++) if (!tlsUsed[i]) { tlsUsed[i] = true; for (const t of m.threads) if (t.tls) t.tls[i] = 0; return i; } setErr(8); return -1; });
    d('TlsFree', 1, (m, i) => { if (i < 0 || i > 63 || !tlsUsed[i]) return 0; tlsUsed[i] = false; return 1; });
    d('TlsSetValue', 2, (m, i, v) => { if (i < 0 || i > 63) { setErr(87); return 0; } const t = m.cur; (t.tls = t.tls || new Array(64).fill(0))[i] = v | 0; return 1; });
    d('TlsGetValue', 1, (m, i) => { setErr(0); const t = m.cur; return t.tls && i >= 0 && i < 64 ? t.tls[i] | 0 : 0; });

    // ---------------------------------------------------------------- mutexes
    d('CreateMutexA', 3, (m, sa, owner, name) => {
      const nm = name ? m.cstr(name) : '';
      if (nm) { m.namedMutex = m.namedMutex || new Map(); const old = m.namedMutex.get(nm); if (old) { setErr(183); return old; } }
      const h = m.newHandle({ type: 'mutex', owner: owner ? m.cur : null });
      if (nm) m.namedMutex.set(nm, h);
      setErr(0); return h;
    });
    d('ReleaseMutex', 1, () => 1);

    // ---------------------------------------------------------------- memory (LocalAlloc family)
    d('LocalAlloc', 2, (m, flags, n) => m.malloc(n, true));
    d('LocalFree', 1, (m, p) => { m.free(p); return 0; });
    d('lstrcatA', 2, (m, dst, src) => { const a = m.cstr(dst, 1 << 20), b = m.cstr(src, 1 << 20); m.putStr(dst + a.length, b); return dst; });
    d('lstrcmpA', 2, (m, a, b) => { const x = m.cstr(a, 1 << 20), y = m.cstr(b, 1 << 20); return x < y ? -1 : x > y ? 1 : 0; });
    d('lstrcmpiA', 2, (m, a, b) => { const x = m.cstr(a, 1 << 20).toLowerCase(), y = m.cstr(b, 1 << 20).toLowerCase(); return x < y ? -1 : x > y ? 1 : 0; });
    d('lstrcpynA', 3, (m, dst, src, n) => { const s = m.cstr(src, 1 << 20); const k = Math.min(s.length, n - 1); if (n > 0) { for (let i = 0; i < k; i++) c.u8[dst + i] = s.charCodeAt(i); c.u8[dst + k] = 0; } return dst; });

    // ---------------------------------------------------------------- console (the C runtime probes it at start-up)
    d('GetConsoleOutputCP', 0, () => 437);
    d('GetConsoleCP', 0, () => 437);
    d('GetConsoleMode', 2, () => { setErr(6); return 0; });
    d('SetConsoleCtrlHandler', 2, () => 1);
    d('WriteConsoleA', 5, (m, h, buf, n, pw) => { if (m.opts.stdout) m.opts.stdout(m.cstr(buf, n)); if (pw) m.wr32(pw, n); return 1; });
    d('WriteConsoleW', 5, (m, h, buf, n, pw) => { if (m.opts.stdout) { let s = ''; for (let i = 0; i < n; i++) s += String.fromCharCode(c.u16[(buf >> 1) + i]); m.opts.stdout(s); } if (pw) m.wr32(pw, n); return 1; });
    d('CreatePipe', 4, (m, pr, pw, sa, size) => { const o = { type: 'pipe', data: [] }; m.wr32(pr, m.newHandle(o)); m.wr32(pw, m.newHandle(o)); return 1; });
    d('CreateProcessA', 10, (m, app, cmd, pa, ta, inh, flags, env, dir, si, pi) => { m.log('[CreateProcess] ' + (app ? m.cstr(app) : '') + ' ' + (cmd ? m.cstr(cmd) : '')); setErr(2); return 0; });
    d('WriteProfileStringA', 3, () => 1);

    // ---------------------------------------------------------------- locale (English, United States)
    const LOC = {
      0x0001: '0409', 0x0002: 'English (United States)', 0x0003: 'ENU', 0x0004: 'English', 0x0005: 'United States', 0x0006: 'USA', 0x0007: 'USA',
      0x0008: 'United States', 0x0009: '1', 0x000A: '1', 0x000B: '437', 0x1001: 'English', 0x1002: 'United States', 0x1004: '1252', 0x0059: 'en', 0x005A: 'US',
      0x0014: '.', 0x0015: ',', 0x0016: '1252', 0x0010: '1', 0x0018: '2', 0x001D: '/', 0x001E: ':', 0x001F: 'M/d/yyyy', 0x0020: 'dddd, MMMM dd, yyyy', 0x0023: '0', 0x0025: '0', 0x0026: '1', 0x0027: '1',
      0x0028: 'AM', 0x0029: 'PM', 0x1000: '0409', 0x1003: 'ENU', 0x1005: 'USA', 0x100E: '1252',
    };
    const locStr = t => {
      t &= 0xFFFF;
      if (t >= 0x2A && t <= 0x30) return ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][(t - 0x2A + 1) % 7] || '';
      if (LOC[t] !== undefined) return LOC[t];
      return '';
    };
    d('GetLocaleInfoA', 4, (m, lcid, type, buf, size) => {
      const s = locStr(type);
      if (!size) return s.length + 1;
      if (size <= s.length) { setErr(122); return 0; }
      m.putStr(buf, s); return s.length + 1;
    });
    d('GetLocaleInfoW', 4, (m, lcid, type, buf, size) => {
      const s = locStr(type);
      if ((type & 0x20000000) !== 0) { if (buf && size >= 2) m.wr32(buf, parseInt(s, 10) || 0); return 2; }
      if (!size) return s.length + 1;
      if (size <= s.length) { setErr(122); return 0; }
      for (let i = 0; i < s.length; i++) c.u16[(buf >> 1) + i] = s.charCodeAt(i);
      c.u16[(buf >> 1) + s.length] = 0; return s.length + 1;
    });
    d('GetUserDefaultLCID', 0, () => 0x0409);
    d('IsValidLocale', 2, () => 1);
    d('IsValidCodePage', 1, () => 1);
    d('EnumSystemLocalesA', 3, (m, proc, flags) => { const s = m.scratchStr('00000409'); c.callGuest(proc, [s]); return 1; });
  }
  EMU.installKernel32c = install;
})(typeof globalThis !== 'undefined' ? globalThis : this);
