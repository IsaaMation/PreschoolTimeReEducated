/* WININET stand-in: HTTP requests are answered in-process by m.net.http(req) (the page provides the "server").
 *   req  = {method, host, port, secure, path, headers (string), body (Uint8Array|null)}
 *   resp = {status, statusText, headers: {name: value}, body: Uint8Array|string}
 * Nothing leaves the page. Without a handler every request fails like an offline machine.
 */
(function (G) {
  'use strict';
  const EMU = G.EMU;
  const WI = 'WININET.dll';
  const ERROR_INTERNET_CANNOT_CONNECT = 12029, ERROR_INTERNET_NAME_NOT_RESOLVED = 12007, ERROR_INVALID_HANDLE = 6;
  const enc = new TextEncoder();

  function install(m) {
    const c = m.cpu;
    const d = (name, n, fn) => m.def(WI, name, n, fn);
    const net = m.net = m.net || {};
    net.httpLog = net.httpLog || [];
    const trace = s => { if (m.opts.traceNet || m.opts.traceFiles) m.log('  [http] ' + s); };
    const setErr = e => { m.lastError = e; };

    function perform(req) {
      const rec = { method: req.method, url: (req.secure ? 'https://' : 'http://') + req.host + (req.port && req.port !== (req.secure ? 443 : 80) ? ':' + req.port : '') + req.path, body: req.body ? new TextDecoder().decode(req.body).substr(0, 600) : '' };
      net.httpLog.push(rec);
      m.log('  [http] ' + req.method + ' ' + rec.url + (rec.body ? '  body=' + rec.body.replace(/\s+/g, ' ') : ''));
      let resp = null;
      if (net.http) { try { resp = net.http(req); } catch (e) { m.log('  [http] handler error: ' + (e && e.stack || e)); } }
      if (!resp) return null;
      let body = resp.body === undefined ? new Uint8Array(0) : (typeof resp.body === 'string' ? enc.encode(resp.body) : resp.body);
      return { status: resp.status | 0 || 200, statusText: resp.statusText || (resp.status === 404 ? 'Not Found' : 'OK'), headers: resp.headers || {}, body, pos: 0 };
    }
    const hOf = h => { const o = m.getHandle(h); return o && o.type === 'inet' ? o : null; };

    d('InternetAttemptConnect', 1, () => 0);
    d('InternetOpenA', 5, (m, agent, access, proxy, bypass, flags) => m.newHandle({ type: 'inet', kind: 'session', agent: agent ? m.cstr(agent) : '' }));
    d('InternetConnectA', 8, (m, hs, server, port, user, pass, service, flags, ctx) => {
      const host = server ? m.cstr(server) : '';
      trace('connect ' + host + ':' + port + ' service=' + service);
      if (service === 1) { return m.newHandle({ type: 'inet', kind: 'ftp', host, port }); }
      return m.newHandle({ type: 'inet', kind: 'connect', host, port: port || 80, flags });
    });
    d('HttpOpenRequestA', 8, (m, hc, verb, obj, version, referrer, accept, flags, ctx) => {
      const con = hOf(hc); if (!con) { setErr(ERROR_INVALID_HANDLE); return 0; }
      const secure = !!(flags & 0x00800000) || con.port === 443;
      return m.newHandle({ type: 'inet', kind: 'request', req: { method: verb ? m.cstr(verb) : 'GET', host: con.host, port: con.port, secure, path: obj ? m.cstr(obj) : '/', headers: '', body: null }, resp: null });
    });
    d('HttpSendRequestA', 5, (m, hr, hdr, hlen, opt, olen) => {
      const r = hOf(hr); if (!r || r.kind !== 'request') { setErr(ERROR_INVALID_HANDLE); return 0; }
      if (hdr) r.req.headers = (hlen === -1 || hlen === 0xFFFFFFFF ? m.cstr(hdr) : m.cstr(hdr).substr(0, hlen));
      r.req.body = opt && olen ? c.u8.slice(opt, opt + olen) : null;
      r.resp = perform(r.req);
      if (!r.resp) { setErr(ERROR_INTERNET_CANNOT_CONNECT); return 0; }
      return 1;
    });
    d('InternetOpenUrlA', 6, (m, hs, url, hdr, hlen, flags, ctx) => {
      const u = m.cstr(url), mm = /^(https?):\/\/([^\/:]+)(?::(\d+))?(\/.*)?$/i.exec(u);
      if (!mm) { setErr(ERROR_INTERNET_NAME_NOT_RESOLVED); return 0; }
      const secure = mm[1].toLowerCase() === 'https';
      const req = { method: 'GET', host: mm[2], port: mm[3] ? +mm[3] : (secure ? 443 : 80), secure, path: mm[4] || '/', headers: '', body: null };
      const resp = perform(req);
      if (!resp) { setErr(ERROR_INTERNET_CANNOT_CONNECT); return 0; }
      return m.newHandle({ type: 'inet', kind: 'request', req, resp });
    });
    d('InternetReadFile', 4, (m, h, buf, n, pRead) => {
      const r = hOf(h); if (!r || !r.resp) { setErr(ERROR_INVALID_HANDLE); return 0; }
      const rs = r.resp, k = Math.min(n, rs.body.length - rs.pos);
      if (k > 0) c.u8.set(rs.body.subarray(rs.pos, rs.pos + k), buf);
      rs.pos += Math.max(0, k);
      if (pRead) m.wr32(pRead, Math.max(0, k));
      return 1;
    });
    d('HttpQueryInfoA', 5, (m, h, level, buf, pLen, pIdx) => {
      const r = hOf(h); if (!r || !r.resp) { setErr(ERROR_INVALID_HANDLE); return 0; }
      const rs = r.resp, num = !!(level & 0x20000000), lv = level & 0xFFFF;
      const hdrText = () => 'HTTP/1.1 ' + rs.status + ' ' + rs.statusText + '\r\n' + Object.entries(rs.headers).map(([k, v]) => k + ': ' + v).join('\r\n') + '\r\n\r\n';
      let val;
      switch (lv) {
        case 19: val = num ? rs.status : String(rs.status); break;                       // STATUS_CODE
        case 20: val = rs.statusText; break;                                            // STATUS_TEXT
        case 5: val = num ? rs.body.length : String(rs.body.length); break;             // CONTENT_LENGTH
        case 1: { const ct = Object.entries(rs.headers).find(([k]) => k.toLowerCase() === 'content-type'); if (!ct) { setErr(12150); return 0; } val = ct[1]; break; }
        case 21: case 22: val = hdrText(); break;                                       // RAW_HEADERS(_CRLF)
        default: setErr(12150); return 0;                                               // ERROR_HTTP_HEADER_NOT_FOUND
      }
      if (typeof val === 'number') { m.wr32(buf, val); m.wr32(pLen, 4); return 1; }
      const have = m.rd32(pLen);
      if (have < val.length + 1) { m.wr32(pLen, val.length + 1); setErr(122); return 0; }
      m.putStr(buf, val); m.wr32(pLen, val.length); return 1;
    });
    d('InternetCloseHandle', 1, (m, h) => { m.closeHandle(h); return 1; });
    d('FtpGetFileA', 7, () => { setErr(ERROR_INTERNET_CANNOT_CONNECT); return 0; });
  }
  EMU.installWininet = install;
})(typeof globalThis !== 'undefined' ? globalThis : this);
