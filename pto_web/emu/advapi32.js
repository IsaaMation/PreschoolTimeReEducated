/* ADVAPI32 stand-ins: an in-memory registry */
(function (G) {
  'use strict';
  const EMU = G.EMU;
  const AD = 'ADVAPI32.dll';
  const ROOTS = { 0x80000000: 'hkcr', 0x80000001: 'hkcu', 0x80000002: 'hklm', 0x80000003: 'hku' };

  function install(m) {
    const d = (name, n, fn) => m.def(AD, name, n, fn);
    const reg = m.registry = m.registry || new Map();   // lower path -> Map(lower name -> {name, type, data})
    const keyPath = h => { if (ROOTS[h >>> 0]) return ROOTS[h >>> 0]; const o = m.getHandle(h); return o && o.type === 'key' ? o.path : null; };
    const norm = (base, sub) => (base + '\\' + (sub || '')).toLowerCase().replace(/\\+/g, '\\').replace(/\\$/, '');
    const exists = p => { for (const k of reg.keys()) if (k === p || k.startsWith(p + '\\')) return true; return Object.values(ROOTS).includes(p); };
    m.regSet = (path, name, type, bytes) => { path = path.toLowerCase(); let k = reg.get(path); if (!k) reg.set(path, k = new Map()); k.set(name.toLowerCase(), { name, type, data: bytes }); };
    m.regSetStr = (path, name, s) => m.regSet(path, name, 1, Uint8Array.from([...s].map(ch => ch.charCodeAt(0)).concat([0])));
    m.regSetDword = (path, name, v) => m.regSet(path, name, 4, Uint8Array.from([v & 255, (v >> 8) & 255, (v >> 16) & 255, (v >>> 24) & 255]));
    const trace = (s) => { if (m.opts.traceFiles) m.log('  [reg] ' + s); };

    d('RegOpenKeyExA', 5, (m, hk, sub, opts, sam, pOut) => {
      const base = keyPath(hk); if (base === null) return 6;
      const p = norm(base, sub ? m.cstr(sub) : '');
      const ok = exists(p);
      trace('open ' + p + (ok ? '' : ' (missing)'));
      if (!ok) return 2;
      m.wr32(pOut, m.newHandle({ type: 'key', path: p })); return 0;
    });
    d('RegCreateKeyExA', 9, (m, hk, sub, res, cls, opts, sam, sa, pOut, pDisp) => {
      const base = keyPath(hk); if (base === null) return 6;
      const p = norm(base, sub ? m.cstr(sub) : '');
      const existed = exists(p);
      if (!reg.has(p)) reg.set(p, new Map());
      trace('create ' + p);
      m.wr32(pOut, m.newHandle({ type: 'key', path: p })); if (pDisp) m.wr32(pDisp, existed ? 2 : 1); return 0;
    });
    d('RegCloseKey', 1, (m, h) => { m.closeHandle(h); return 0; });
    d('RegFlushKey', 1, () => 0);
    d('RegQueryValueExA', 6, (m, hk, name, res, pType, pData, pSize) => {
      const p = keyPath(hk); if (p === null) return 6;
      const k = reg.get(p), v = k && k.get((name ? m.cstr(name) : '').toLowerCase());
      trace('query ' + p + ' [' + (name ? m.cstr(name) : '') + '] ' + (v ? 'found' : 'missing'));
      if (!v) return 2;
      if (pType) m.wr32(pType, v.type);
      if (pSize) {
        const have = m.rd32(pSize);
        if (pData) { if (have < v.data.length) { m.wr32(pSize, v.data.length); return 234; } m.cpu.u8.set(v.data, pData); }
        m.wr32(pSize, v.data.length);
      }
      return 0;
    });
    d('RegSetValueExA', 6, (m, hk, name, res, type, pData, size) => {
      const p = keyPath(hk); if (p === null) return 6;
      const n = name ? m.cstr(name) : '';
      trace('set ' + p + ' [' + n + '] type=' + type + ' size=' + size);
      m.regSet(p, n, type, m.cpu.u8.slice(pData, pData + size));
      return 0;
    });
    d('GetUserNameA', 2, (m, buf, pSize) => { const n = 'Player'; if (m.rd32(pSize) <= n.length) return 0; m.putStr(buf, n); m.wr32(pSize, n.length + 1); return 1; });
  }
  EMU.installAdvapi32 = install;
})(typeof globalThis !== 'undefined' ? globalThis : this);
