/* WS2_32 stand-in (imports are by ordinal): an in-process "network" with loopback sockets only.
 * The game opens a listening socket on localhost for its Flash content; the page can connect a client endpoint to it
 * (m.net.connectLocal(port)). Everything else (other hosts, DNS) fails like a machine that is offline.
 */
(function (G) {
  'use strict';
  const EMU = G.EMU;
  const WS = 'ws2_32.dll';
  const WSAEWOULDBLOCK = 10035, WSAECONNREFUSED = 10061, WSAENOTSOCK = 10038, WSAHOST_NOT_FOUND = 11001, WSAEINVAL = 10022, WSAENOTCONN = 10057;
  const INVALID = -1;

  function install(m) {
    const c = m.cpu;
    const trace = s => { if (m.opts.traceNet || m.opts.traceFiles) m.log('  [net] ' + s); };
    const net = m.net = m.net || {};
    net.listeners = new Map(); net.wsaError = 0;
    const sockOf = h => { const o = m.getHandle(h); return o && o.type === 'socket' ? o : null; };
    const setErr = e => { net.wsaError = e; };
    const def = (ord, name, n, fn) => { m.def(WS, '#' + ord, n, fn); m.def(WS, name, n, fn); };

    const newSock = (type) => ({ type: 'socket', kind: type, rx: [], rxOff: 0, peer: null, closed: false, peerClosed: false, listening: false, port: 0, backlog: [], nonblocking: false, connected: false });
    const avail = s => { let n = 0; for (let i = 0; i < s.rx.length; i++) n += s.rx[i].length - (i === 0 ? s.rxOff : 0); return n; };
    const pair = (a, b) => { a.peer = b; b.peer = a; a.connected = b.connected = true; };
    function readInto(s, dst, len) {
      let got = 0;
      while (got < len && s.rx.length) {
        const ch = s.rx[0], take = Math.min(len - got, ch.length - s.rxOff);
        if (dst !== null) c.u8.set(ch.subarray(s.rxOff, s.rxOff + take), dst + got);
        got += take; s.rxOff += take;
        if (s.rxOff >= ch.length) { s.rx.shift(); s.rxOff = 0; }
      }
      return got;
    }
    /** host side: connect a client endpoint to a listening game socket */
    net.connectLocal = function (port) {
      const l = net.listeners.get(port); if (!l) return null;
      m.printerShown = true;                                                 // Flash content is talking to the game: it may want to print (see EnumPrintersA in misc.js)
      const server = newSock('stream'), client = newSock('stream');
      pair(server, client);
      l.backlog.push(server);
      const ep = {
        send(bytes) { if (client.closed || server.closed) return false; server.rx.push(bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes)); return true; },
        recv() { if (!client.rx.length) return null; const out = client.rx.shift(); client.rxOff = 0; return out; },
        available: () => client.rx.length,
        close() { client.closed = true; server.peerClosed = true; },
        get closed() { return server.closed || client.closed; },
      };
      client.endpoint = ep;
      return ep;
    };

    def(115, 'WSAStartup', 2, (m, ver, p) => {
      m.zero(p, 400); c.u16[p >> 1] = 0x0202; c.u16[(p + 2) >> 1] = 0x0202; m.putStr(p + 4, 'WinSock 2.0'); c.u16[(p + 390) >> 1] = 32767;
      return 0;
    });
    def(116, 'WSACleanup', 0, () => 0);
    def(111, 'WSAGetLastError', 0, () => net.wsaError);
    def(112, 'WSASetLastError', 1, (m, e) => { setErr(e); });
    def(23, 'socket', 3, (m, af, type, proto) => { const s = newSock(type === 2 ? 'dgram' : 'stream'); const h = m.newHandle(s); trace('socket -> ' + h); return h; });
    def(3, 'closesocket', 1, (m, h) => {
      const s = sockOf(h); if (!s) { setErr(WSAENOTSOCK); return INVALID; }
      s.closed = true; if (s.peer) s.peer.peerClosed = true;
      if (s.listening && net.listeners.get(s.port) === s) net.listeners.delete(s.port);
      m.closeHandle(h); trace('closesocket ' + h); return 0;
    });
    def(2, 'bind', 3, (m, h, addr, len) => {
      const s = sockOf(h); if (!s) { setErr(WSAENOTSOCK); return INVALID; }
      s.port = ((c.u8[addr + 2] << 8) | c.u8[addr + 3]); trace('bind ' + h + ' port ' + s.port); return 0;
    });
    def(13, 'listen', 2, (m, h, backlog) => {
      const s = sockOf(h); if (!s) { setErr(WSAENOTSOCK); return INVALID; }
      s.listening = true; net.listeners.set(s.port, s); trace('listen ' + h + ' port ' + s.port); if (net.onListen) net.onListen(s.port); return 0;
    });
    def(1, 'accept', 3, (m, h, addr, plen) => {
      const s = sockOf(h); if (!s || !s.listening) { setErr(WSAEINVAL); return INVALID; }
      if (!s.backlog.length) {
        if (s.nonblocking) { setErr(WSAEWOULDBLOCK); return INVALID; }
        // a blocking accept waits (the game's socket thread sits here until the page connects its Flash bridge or the socket is closed)
        return m.blockCurrent(c.curEip, m.sp - 4, null, undefined, () => s.backlog.length > 0 || s.closed);
      }
      const n = s.backlog.shift(), nh = m.newHandle(n);
      if (addr) { m.zero(addr, 16); c.u16[addr >> 1] = 2; c.u8[addr + 4] = 127; c.u8[addr + 7] = 1; if (plen) m.wr32(plen, 16); }
      trace('accept -> ' + nh); return nh;
    });
    def(4, 'connect', 3, (m, h, addr, len) => {
      const s = sockOf(h); if (!s) { setErr(WSAENOTSOCK); return INVALID; }
      const port = (c.u8[addr + 2] << 8) | c.u8[addr + 3], ip = c.u8[addr + 4] + '.' + c.u8[addr + 5] + '.' + c.u8[addr + 6] + '.' + c.u8[addr + 7];
      const l = (ip === '127.0.0.1' || ip === '0.0.0.0') ? net.listeners.get(port) : null;
      trace('connect ' + ip + ':' + port + (l ? ' (local listener)' : ' refused'));
      if (!l) { setErr(WSAECONNREFUSED); return INVALID; }
      const server = newSock('stream'); pair(s, server); l.backlog.push(server); return 0;
    });
    def(16, 'recv', 4, (m, h, buf, len, flags) => {
      const s = sockOf(h); if (!s) { setErr(WSAENOTSOCK); return INVALID; }
      if (!s.connected) { setErr(WSAENOTCONN); return INVALID; }
      const n = avail(s);
      if (!n) {
        if (s.peerClosed || (s.peer && s.peer.closed)) return 0;
        if (s.nonblocking) { setErr(WSAEWOULDBLOCK); return INVALID; }
        return m.blockCurrent(c.curEip, m.sp - 4, null, undefined, () => avail(s) > 0 || s.peerClosed || s.closed || (s.peer && s.peer.closed));
      }
      return readInto(s, (flags & 2) ? null : buf, len);
    });
    def(19, 'send', 4, (m, h, buf, len, flags) => {
      const s = sockOf(h); if (!s) { setErr(WSAENOTSOCK); return INVALID; }
      if (!s.connected || !s.peer || s.peer.closed) { setErr(WSAENOTCONN); return INVALID; }
      s.peer.rx.push(c.u8.slice(buf, buf + len)); return len;
    });
    def(18, 'select', 5, (m, nfds, rd, wr, ex, tmo) => {
      // collect readiness first; the fd_sets are only rewritten when the call returns (it may block and run again)
      const collect = (set, test) => {
        if (!set) return null;
        const n = m.rd32(set), keep = [];
        for (let i = 0; i < n; i++) { const h = m.rd32(set + 4 + i * 4), s = sockOf(h); if (s && test(s)) keep.push(h); }
        return keep;
      };
      const rr = collect(rd, s => (s.listening ? s.backlog.length > 0 : (avail(s) > 0 || s.peerClosed || (s.peer && s.peer.closed)))),
        ww = collect(wr, s => s.connected), ee = collect(ex, () => false);
      const ready = (rr ? rr.length : 0) + (ww ? ww.length : 0) + (ee ? ee.length : 0);
      const t = m.cur;
      let pw = t.pendingSelect;
      if (!pw) {
        let deadline;                                     // undefined = wait forever
        if (tmo) deadline = m.now() + m.rd32(tmo) * 1000 + Math.floor(m.rd32(tmo + 4) / 1000);
        pw = t.pendingSelect = { deadline };
      }
      const expired = pw.deadline !== undefined && m.now() >= pw.deadline;
      if (ready === 0 && !expired && (!tmo || pw.deadline > m.now())) {
        const anySock = (set) => { if (!set) return []; const n = m.rd32(set), out = []; for (let i = 0; i < n; i++) { const s = sockOf(m.rd32(set + 4 + i * 4)); if (s) out.push(s); } return out; };
        const rs = anySock(rd), ws = anySock(wr);
        return m.blockCurrent(c.curEip, m.sp - 4, null, pw.deadline, () => rs.some(s => (s.listening ? s.backlog.length > 0 : (avail(s) > 0 || s.peerClosed || s.closed || (s.peer && s.peer.closed)))) || ws.some(s => s.connected));
      }
      t.pendingSelect = null;
      const put = (set, keep) => { if (!set) return; m.wr32(set, keep.length); for (let i = 0; i < keep.length; i++) m.wr32(set + 4 + i * 4, keep[i]); };
      put(rd, rr || []); put(wr, ww || []); put(ex, ee || []);
      return ready;
    });
    def(151, '__WSAFDIsSet', 2, (m, h, set) => { const n = m.rd32(set); for (let i = 0; i < n; i++) if (m.rd32(set + 4 + i * 4) === h) return 1; return 0; });
    def(21, 'setsockopt', 5, () => 0);
    def(7, 'getsockopt', 5, (m, h, lvl, opt, p, plen) => { if (p) m.wr32(p, 0); return 0; });
    def(10, 'ioctlsocket', 3, (m, h, cmd, p) => {
      const s = sockOf(h); if (!s) { setErr(WSAENOTSOCK); return INVALID; }
      if ((cmd >>> 0) === 0x8004667E) { s.nonblocking = !!m.rd32(p); return 0; }
      if ((cmd >>> 0) === 0x4004667F) { m.wr32(p, avail(s)); return 0; }
      return 0;
    });
    def(5, 'getpeername', 3, (m, h, addr, plen) => { m.zero(addr, 16); c.u16[addr >> 1] = 2; c.u8[addr + 4] = 127; c.u8[addr + 7] = 1; m.wr32(plen, 16); return 0; });
    def(6, 'getsockname', 3, (m, h, addr, plen) => { const s = sockOf(h); m.zero(addr, 16); c.u16[addr >> 1] = 2; c.u8[addr + 2] = (s ? s.port : 0) >> 8; c.u8[addr + 3] = (s ? s.port : 0) & 255; c.u8[addr + 4] = 127; c.u8[addr + 7] = 1; m.wr32(plen, 16); return 0; });
    // byte order
    def(8, 'htonl', 1, (m, v) => ((v & 255) << 24) | ((v >> 8 & 255) << 16) | ((v >> 16 & 255) << 8) | (v >>> 24));
    def(14, 'ntohl', 1, (m, v) => ((v & 255) << 24) | ((v >> 8 & 255) << 16) | ((v >> 16 & 255) << 8) | (v >>> 24));
    def(9, 'htons', 1, (m, v) => ((v & 255) << 8) | ((v >> 8) & 255));
    def(15, 'ntohs', 1, (m, v) => ((v & 255) << 8) | ((v >> 8) & 255));
    def(11, 'inet_addr', 1, (m, p) => {
      const s = m.cstr(p), q = s.split('.').map(Number);
      if (q.length !== 4 || q.some(v => !(v >= 0 && v < 256))) return -1;
      return (q[0]) | (q[1] << 8) | (q[2] << 16) | (q[3] << 24);
    });
    def(12, 'inet_ntoa', 1, (m, v) => m.scratchStr((v & 255) + '.' + ((v >> 8) & 255) + '.' + ((v >> 16) & 255) + '.' + ((v >>> 24) & 255)));
    // DNS: only the local machine resolves
    let hostent = 0;
    def(52, 'gethostbyname', 1, (m, p) => {
      const name = m.cstr(p).toLowerCase();
      trace('gethostbyname ' + name);
      if (name !== 'localhost' && name !== '127.0.0.1') { setErr(WSAHOST_NOT_FOUND); return 0; }
      if (!hostent) {
        hostent = m.scratch(64); const nm = m.scratchStr('localhost'), addr = m.scratch(8), list = m.scratch(8);
        m.wr32(addr, 0x0100007F); m.wr32(list, addr); m.wr32(list + 4, 0);
        const aliases = m.scratch(8); m.wr32(aliases, 0);
        m.wr32(hostent, nm); m.wr32(hostent + 4, aliases); c.u16[(hostent + 8) >> 1] = 2; c.u16[(hostent + 10) >> 1] = 4; m.wr32(hostent + 12, list);
      }
      return hostent;
    });
  }
  EMU.installWs2_32 = install;
})(typeof globalThis !== 'undefined' ? globalThis : this);
