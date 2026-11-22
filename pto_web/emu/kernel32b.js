/* KERNEL32 stand-ins, part B: files, drives, resources, threads and synchronisation, dynamic loading */
(function (G) {
  'use strict';
  const EMU = G.EMU;
  const K32 = 'KERNEL32.dll';
  const INVALID = -1;

  /** virtual path handling: any drive and directory maps onto the hosted folder */
  function installPaths(m) {
    m.cwd = 'C:\\BEAR';
    m.userFiles = new Map();            // lower-case full path -> {data: Uint8Array, size}
    m.fullPath = function (p) {
      p = (p || '').replace(/\//g, '\\');
      let drive = 'C:';
      const dm = /^([A-Za-z]:)/.exec(p);
      if (dm) { drive = dm[1].toUpperCase(); p = p.substr(2); }
      else if (!p.startsWith('\\')) { const cm = /^([A-Za-z]:)(.*)$/.exec(m.cwd); drive = cm[1]; p = cm[2] + '\\' + p; }
      const out = [];
      for (const part of p.split('\\')) { if (part === '' || part === '.') continue; if (part === '..') out.pop(); else out.push(part); }
      return drive + '\\' + out.join('\\');
    };
    /** relative key inside the hosted folder (lower case, forward slashes) or null */
    m.vfsKey = function (full) {
      const parts = full.substr(3).toLowerCase().split('\\').filter(Boolean);
      if (!m.vfs) return null;
      for (let i = 0; i < parts.length; i++) {          // longest suffix that exists
        const key = parts.slice(i).join('/');
        if (m.vfs.stat(key)) return key;
      }
      return parts.length ? parts[parts.length - 1] : '';
    };
    m.statPath = function (p) {
      const full = m.fullPath(p), low = full.toLowerCase();
      if (m.userFiles.has(low)) return { dir: false, size: m.userFiles.get(low).size };
      if (/^[a-z]:\\?$/i.test(full)) return { dir: true, size: 0 };
      const key = m.vfsKey(full);
      if (key === '') return { dir: true, size: 0 };
      const st = m.vfs ? m.vfs.stat(key) : null;
      return st;
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
  }

  function wildcard(pat) {
    const re = '^' + pat.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$';
    return new RegExp(re, 'i');
  }

  function install(m) {
    installPaths(m);
    const d = (name, n, fn) => m.def(K32, name, n, fn);
    const c = m.cpu;
    const setErr = e => { m.lastError = e; };

    // ---------------------------------------------------------------- files
    d('CreateFileA', 7, (m, name, access, share, sa, disp, flags, tmpl) => {
      const path = m.cstr(name);
      const full = m.fullPath(path), low = full.toLowerCase();
      const write = (access & 0x40000000) !== 0;
      let f = null;
      if (!write || disp === 3 || disp === 4) f = m.openRead(path);
      if (write) {
        let u = m.userFiles.get(low);
        if (disp === 1 && (u || f)) { setErr(80); return INVALID; }
        if (!u) {
          if (!f && (disp === 3 || disp === 5)) { setErr(2); return INVALID; }
          u = { data: new Uint8Array(f ? f.size + 4096 : 4096), size: 0 };
          if (f) { u.data.set(f.read(0, f.size), 0); u.size = f.size; }
          m.userFiles.set(low, u);
        }
        if (disp === 2 || disp === 5) u.size = 0;
        return m.newHandle({ type: 'file', f: null, mem: u, pos: 0, write: true, path: low });
      }
      if (!f) { if (m.opts.traceFiles) m.log('  [file] open FAIL ' + path); setErr(2); return INVALID; }
      if (m.opts.traceFiles) m.log('  [file] open ' + path + ' (' + f.size + ' bytes)');
      return m.newHandle({ type: 'file', f, pos: 0, write: false, path: low });
    });
    d('ReadFile', 5, (m, h, buf, n, pRead, ovl) => {
      const o = m.getHandle(h);
      if (!o || o.type !== 'file') { setErr(6); return 0; }
      const size = o.mem ? o.mem.size : o.f.size;
      const k = Math.max(0, Math.min(n >>> 0, size - o.pos));
      if (k > 0) { const data = o.mem ? o.mem.data.subarray(o.pos, o.pos + k) : o.f.read(o.pos, k); c.u8.set(data, buf); }
      o.pos += k;
      if (pRead) m.wr32(pRead, k);
      return 1;
    });
    d('WriteFile', 5, (m, h, buf, n, pWritten, ovl) => {
      const o = m.getHandle(h);
      if (h === 7 || h === 11) { if (m.opts.stdout) m.opts.stdout(m.cstr(buf, n)); if (pWritten) m.wr32(pWritten, n); return 1; }
      if (!o || !o.mem) { setErr(5); return 0; }
      const u = o.mem, end = o.pos + n;
      if (end > u.data.length) { const nd = new Uint8Array(Math.max(end * 2, 4096)); nd.set(u.data.subarray(0, u.size)); u.data = nd; }
      u.data.set(c.u8.subarray(buf, buf + n), o.pos);
      o.pos = end; if (end > u.size) u.size = end;
      if (pWritten) m.wr32(pWritten, n);
      return 1;
    });
    d('SetFilePointer', 4, (m, h, lo, pHi, method) => {
      const o = m.getHandle(h); if (!o || o.type !== 'file') return INVALID;
      const size = o.mem ? o.mem.size : o.f.size;
      let p = method === 0 ? lo : method === 1 ? o.pos + lo : size + lo;
      if (p < 0) { setErr(131); return INVALID; }
      o.pos = p; if (pHi) m.wr32(pHi, 0);
      return p;
    });
    d('GetFileSize', 2, (m, h, pHi) => { const o = m.getHandle(h); if (!o || o.type !== 'file') return INVALID; if (pHi) m.wr32(pHi, 0); return o.mem ? o.mem.size : o.f.size; });
    d('SetEndOfFile', 1, (m, h) => { const o = m.getHandle(h); if (o && o.mem) o.mem.size = o.pos; return 1; });
    d('FlushFileBuffers', 1, () => 1);
    d('CloseHandle', 1, (m, h) => { m.closeHandle(h); return 1; });
    d('GetFileTime', 4, (m, h, a, b, w) => { for (const p of [a, b, w]) if (p) { m.wr32(p, 0xD53E8000 | 0); m.wr32(p + 4, 0x01BF53EB); } return 1; });
    d('GetFileAttributesA', 1, (m, name) => {
      const st = m.statPath(m.cstr(name));
      if (!st) { setErr(2); return INVALID; }
      return st.dir ? 0x10 : 0x80;
    });
    d('DeleteFileA', 1, (m, name) => { const low = m.fullPath(m.cstr(name)).toLowerCase(); if (m.userFiles.delete(low)) return 1; setErr(2); return 0; });
    d('CreateDirectoryA', 2, () => 1);
    d('GetCurrentDirectoryA', 2, (m, size, buf) => { if (size <= m.cwd.length) return m.cwd.length + 1; m.putStr(buf, m.cwd); return m.cwd.length; });
    d('SetCurrentDirectoryA', 1, (m, p) => { m.cwd = m.fullPath(m.cstr(p)).replace(/\\$/, ''); return 1; });
    d('GetFullPathNameA', 4, (m, name, size, buf, pFile) => {
      const full = m.fullPath(m.cstr(name));
      if (size <= full.length) return full.length + 1;
      m.putStr(buf, full);
      if (pFile) { const i = full.lastIndexOf('\\'); m.wr32(pFile, buf + i + 1); }
      return full.length;
    });
    d('FindFirstFileA', 2, (m, pat, pfd) => {
      const full = m.fullPath(m.cstr(pat));
      const i = full.lastIndexOf('\\'), dir = full.substr(0, i), mask = wildcard(full.substr(i + 1));
      let list = [];
      const key = m.vfsKey(dir + '\\x');
      const base = key === null ? '' : key.replace(/\/?[^/]*$/, '');
      if (m.vfs) list = m.vfs.list(base).filter(e => mask.test(e.name));
      for (const [low, u] of m.userFiles) { const j = low.lastIndexOf('\\'); if (low.substr(0, j) === dir.toLowerCase() && mask.test(low.substr(j + 1))) list.push({ name: low.substr(j + 1), dir: false, size: u.size }); }
      if (m.opts.traceFiles) m.log('  [file] find ' + full + ' -> ' + list.map(e => e.name).join(','));
      if (!list.length) { setErr(2); return INVALID; }
      const o = { type: 'find', list, idx: 0 };
      const h = m.newHandle(o);
      fillFind(m, pfd, list[0]); o.idx = 1;
      return h;
    });
    d('FindNextFileA', 2, (m, h, pfd) => { const o = m.getHandle(h); if (!o || o.idx >= o.list.length) { setErr(18); return 0; } fillFind(m, pfd, o.list[o.idx++]); return 1; });
    d('FindClose', 1, (m, h) => { m.closeHandle(h); return 1; });

    // ---------------------------------------------------------------- drives
    d('GetLogicalDrives', 0, () => 0x0C);
    d('GetDriveTypeA', 1, (m, root) => { const r = m.cstr(root).toUpperCase(); if (r.startsWith('D')) return 5; if (r.startsWith('C') || !r) return 3; return 1; });
    m.volumeLabel = 'BEAR';
    d('GetVolumeInformationA', 8, (m, root, vol, volSize, pSerial, pMax, pFlags, fsBuf, fsSize) => {
      const r = m.cstr(root).toUpperCase();
      if (vol && volSize) m.putStr(vol, r.startsWith('D') ? m.volumeLabel : 'WINDOWS');
      if (pSerial) m.wr32(pSerial, 0x1A2B3C4D);
      if (pMax) m.wr32(pMax, 255);
      if (pFlags) m.wr32(pFlags, 3);
      if (fsBuf && fsSize) m.putStr(fsBuf, r.startsWith('D') ? 'CDFS' : 'FAT32');
      return 1;
    });
    d('GetDiskFreeSpaceA', 5, (m, root, pSpc, pBps, pFree, pTotal) => {
      if (pSpc) m.wr32(pSpc, 32); if (pBps) m.wr32(pBps, 512); if (pFree) m.wr32(pFree, 400000); if (pTotal) m.wr32(pTotal, 900000); return 1;
    });

    // ---------------------------------------------------------------- resources (inside the exe)
    const readName = (p) => (p >>> 0) < 0x10000 ? p : m.cstr(p).toLowerCase();
    function resDir(info, off) { const base = m.imageBase + info.resources.rva; return { base, off }; }
    function findRes(type, name) {
      const info = m.info; if (!info.resources.rva) return 0;
      const rbase = m.imageBase + info.resources.rva;
      const walk = (dirOff, key) => {
        const nn = c.u16[(rbase + dirOff + 12) >> 1], ni = c.u16[(rbase + dirOff + 14) >> 1];
        let first = 0;
        for (let i = 0; i < nn + ni; i++) {
          const e = rbase + dirOff + 16 + i * 8, id = m.rd32(e), off = m.rd32(e + 4);
          if (key === null) { return off; }           // any (language)
          if (i < nn) {
            if (typeof key !== 'string') continue;
            const so = rbase + (id & 0x7FFFFFFF), len = c.u16[so >> 1]; let s = '';
            for (let k = 0; k < len; k++) s += String.fromCharCode(c.u16[(so >> 1) + 1 + k]);
            if (s.toLowerCase() === key) return off;
          } else if (typeof key === 'number' && id === key) return off;
        }
        return -1;
      };
      let off = walk(0, readName(type)); if (off < 0) return 0;
      off = walk(off & 0x7FFFFFFF, readName(name)); if (off < 0) return 0;
      off = walk(off & 0x7FFFFFFF, null);
      return rbase + off;                                // address of the IMAGE_RESOURCE_DATA_ENTRY
    }
    m.findRes = findRes;
    d('FindResourceA', 3, (m, hmod, name, type) => { const r = findRes(type, name); if (!r) setErr(1814); return r; });
    d('LoadResource', 2, (m, hmod, hres) => hres ? m.imageBase + m.rd32(hres) : 0);
    d('LockResource', 1, (m, h) => h);
    d('SizeofResource', 2, (m, hmod, hres) => hres ? m.rd32(hres + 4) : 0);
    d('FreeResource', 1, () => 0);

    // ---------------------------------------------------------------- dynamic loading
    const known = new Set(['ddraw', 'dsound', 'smackw32', 'user32', 'kernel32', 'gdi32', 'advapi32', 'winmm', 'comdlg32']);
    d('LoadLibraryA', 1, (m, p) => {
      let n = m.cstr(p).replace(/^.*[\\/]/, '').toLowerCase().replace(/\.dll$/, '');
      if (m.opts.traceFiles) m.log('  [dll] LoadLibrary ' + n + (known.has(n) ? '' : ' (unknown)'));
      if (!known.has(n)) { setErr(126); return 0; }
      return m.moduleHandle(n);
    });
    d('FreeLibrary', 1, () => 1);
    d('GetProcAddress', 2, (m, h, p) => {
      if (h === m.imageBase) return 0;
      const mod = m.moduleName(h);
      if (!mod) { setErr(127); return 0; }
      const name = (p >>> 0) < 0x10000 ? '#' + p : m.cstr(p);
      if (m.has(mod + '.dll', name)) return m.trapFor(mod + '.dll', name);
      if (m.opts.traceFiles) m.log('  [dll] GetProcAddress ' + mod + '!' + name + ' -> not available');
      setErr(127); return 0;
    });

    // ---------------------------------------------------------------- events, semaphores, threads
    d('CreateEventA', 4, (m, sa, manual, initial, name) => m.newHandle({ type: 'event', manual: !!manual, signaled: !!initial }));
    d('SetEvent', 1, (m, h) => { const o = m.getHandle(h); if (o) o.signaled = true; return 1; });
    d('CreateSemaphoreA', 4, (m, sa, initial, max, name) => m.newHandle({ type: 'sem', count: initial, max }));
    d('CreateThread', 6, (m, sa, stack, start, param, flags, pTid) => {
      const t = m.createThread(start, param, stack, (flags & 4) !== 0);
      if (pTid) m.wr32(pTid, t.id);
      if (m.opts.traceFiles) m.log('  [thread] create id=' + t.id + ' start=0x' + (start >>> 0).toString(16));
      return t.handle;
    });
    d('SetThreadPriority', 2, () => 1);
    d('WaitForSingleObject', 2, (m, h, ms) => {
      const o = m.getHandle(h);
      if (!o) return 0;
      const t = m.cur;
      const sig = o.type === 'event' ? o.signaled : o.type === 'sem' ? o.count > 0 : o.type === 'thread' ? o.t.state === 'done' : true;
      if (sig) {
        if (o.type === 'event' && !o.manual) o.signaled = false; else if (o.type === 'sem') o.count--;
        t.pendingWait = null; return 0;
      }
      if (ms === 0) return 0x102;
      const now = m.now();
      let pw = t.pendingWait;
      if (!pw) pw = t.pendingWait = { deadline: ms === -1 ? undefined : now + (ms >>> 0) };
      else if (pw.deadline !== undefined && now >= pw.deadline) { t.pendingWait = null; return 0x102; }
      return m.blockCurrent(c.curEip, m.sp - 4, o, pw.deadline);
    });
    d('InitializeCriticalSection', 1, (m, p) => { m.zero(p, 24); m.wr32(p + 4, -1); });
    d('DeleteCriticalSection', 1, () => { });
    d('EnterCriticalSection', 1, (m, p) => {
      const tid = m.cur.id, owner = m.rd32(p + 12);
      if (owner === 0 || owner === tid) { m.wr32(p + 12, tid); m.wr32(p + 8, m.rd32(p + 8) + 1); m.wr32(p + 4, m.rd32(p + 4) + 1); return; }
      return m.blockCurrent(c.curEip, m.sp - 4, null, undefined, () => m.rd32(p + 12) === 0);
    });
    d('LeaveCriticalSection', 1, (m, p) => {
      const r = m.rd32(p + 8) - 1; m.wr32(p + 8, r); m.wr32(p + 4, m.rd32(p + 4) - 1);
      if (r <= 0) { m.wr32(p + 8, 0); m.wr32(p + 12, 0); }
    });
  }

  function fillFind(m, p, e) {
    m.zero(p, 320);
    m.wr32(p, e.dir ? 0x10 : 0x80);
    m.wr32(p + 32, e.size || 0);
    m.putStr(p + 44, e.name);
  }
  EMU.installKernel32b = install;
})(typeof globalThis !== 'undefined' ? globalThis : this);
