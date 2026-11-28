/* Virtual file systems for the emulated machine.
 *   NodeVfs(rootDir)             - files from a local folder (tests)
 *   HttpVfs(baseUrl, manifest)   - files from a web server via synchronous Range requests (browser worker)
 * Interface: stat(key) -> null | {dir,size};  open(key) -> {size, read(pos,n)->Uint8Array};  list(dirKey) -> [{name,dir,size}]
 * keys are lower-case, forward-slash separated, relative to the root.
 */
(function (G) {
  'use strict';
  const EMU = G.EMU = G.EMU || {};

  class NodeVfs {
    constructor(root) {
      this.fs = require('fs'); this.path = require('path'); this.root = root;
      this.index = new Map();
      this.scan('');
    }
    scan(rel, relKey) {
      relKey = relKey || '';
      const dir = this.path.join(this.root, rel);
      for (const name of this.fs.readdirSync(dir)) {
        const full = this.path.join(dir, name), st = this.fs.statSync(full);
        const key = (relKey ? relKey + '/' : '') + name.toLowerCase();
        this.index.set(key, { real: full, name, dir: st.isDirectory(), size: st.size });
        if (st.isDirectory()) this.scan(rel ? rel + '/' + name : name, key);
      }
    }
    stat(key) { const e = this.index.get(key); return e ? { dir: e.dir, size: e.size } : null; }
    open(key) {
      const e = this.index.get(key), fs = this.fs;
      const fd = fs.openSync(e.real, 'r');
      return {
        size: e.size,
        read: (pos, n) => { const b = Buffer.allocUnsafe(n); const k = fs.readSync(fd, b, 0, n, pos); return new Uint8Array(b.buffer, b.byteOffset, k); },
      };
    }
    list(dirKey) {
      const out = [], pre = dirKey ? dirKey + '/' : '';
      for (const [k, e] of this.index) { if (k.startsWith(pre) && k.indexOf('/', pre.length) < 0) out.push({ name: e.name, dir: e.dir, size: e.size }); }
      return out;
    }
  }

  /** Browser (inside a Worker): synchronous XHR with Range headers, so the large archives are never downloaded as a whole.
   *  Reads are cached in 256 KB chunks. `manifest` is a list of {name, size}; names may contain '/' for loose files in sub folders. */
  class HttpVfs {
    constructor(baseUrl, manifest) {
      this.base = baseUrl.replace(/\/?$/, '/');
      this.index = new Map();
      for (const f of manifest) this.index.set(f.name.toLowerCase(), { name: f.name, dir: false, size: f.size });
      this.chunks = new Map(); this.CH = 1 << 18; this.maxChunks = 160; this.stats = { requests: 0, bytes: 0 };
    }
    url(name) { return this.base + name.split('/').map(encodeURIComponent).join('/'); }
    stat(key) { const e = this.index.get(key); return e ? { dir: false, size: e.size } : null; }
    list(dirKey) { if (dirKey) return []; return [...this.index.values()].filter(e => e.name.indexOf('/') < 0).map(e => ({ name: e.name, dir: false, size: e.size })); }
    /** a synchronous download blocks the whole worker; onWait(ms) tells the machine how long, so that the game can be told it took no time */
    fetchRange(e, a, b) {
      const t0 = typeof performance !== 'undefined' ? performance.now() : 0;
      try { return this._fetchRange(e, a, b); }
      finally { if (this.onWait && t0) this.onWait(performance.now() - t0); }
    }
    _fetchRange(e, a, b) {
      const x = new XMLHttpRequest();
      x.open('GET', this.url(e.name), false);
      const bin = typeof document === 'undefined';           // a Worker may ask for an ArrayBuffer from a synchronous request
      if (bin) x.responseType = 'arraybuffer'; else x.overrideMimeType('text/plain; charset=x-user-defined');
      x.setRequestHeader('Range', 'bytes=' + a + '-' + (b - 1));
      x.send();
      this.stats.requests++;
      if (x.status !== 206 && x.status !== 200) throw new Error('HTTP ' + x.status + ' for ' + e.name);
      let out;
      if (bin) out = new Uint8Array(x.response);
      else { const t = x.responseText, n = t.length; out = new Uint8Array(n); for (let i = 0; i < n; i++) out[i] = t.charCodeAt(i) & 255; }
      if (x.status === 200 && out.length > b - a) return out.subarray(a, b);   // server ignored Range
      this.stats.bytes += out.length;
      return out;
    }
    open(key) {
      const e = this.index.get(key), self = this, CH = this.CH;
      if (e.size <= (4 << 20)) {      // small files: load completely once
        let all = null;
        return { size: e.size, read: (pos, n) => { if (!all) all = self.fetchRange(e, 0, e.size); return all.subarray(pos, Math.min(pos + n, e.size)); } };
      }
      return {
        size: e.size,
        read(pos, n) {
          const end = Math.min(pos + n, e.size);
          const out = new Uint8Array(Math.max(0, end - pos));
          let p = pos;
          while (p < end) {
            const ci = Math.floor(p / CH), ck = e.name + ':' + ci;
            let ch = self.chunks.get(ck);
            if (!ch) {
              ch = self.fetchRange(e, ci * CH, Math.min((ci + 1) * CH, e.size));
              if (self.chunks.size >= self.maxChunks) self.chunks.delete(self.chunks.keys().next().value);
              self.chunks.set(ck, ch);
            }
            const o = p - ci * CH, k = Math.min(ch.length - o, end - p);
            out.set(ch.subarray(o, o + k), p - pos); p += k;
          }
          return out;
        },
      };
    }
  }

  EMU.NodeVfs = NodeVfs; EMU.HttpVfs = HttpVfs;
  if (typeof module !== 'undefined') module.exports = { NodeVfs, HttpVfs };
})(typeof globalThis !== 'undefined' ? globalThis : this);
