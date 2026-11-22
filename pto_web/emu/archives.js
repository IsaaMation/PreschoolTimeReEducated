/* Reading the game's files where they lie: inside zips, zips inside zips, and Wise installer programs (.exe).
 * Nothing is unpacked up front.  A file is fetched in pieces (HTTP Range requests in the browser, file reads in tests) and
 * inflated when the game asks for it.
 *
 *   RangeFile      a file that can be read in pieces: nodeFile(path), httpFile(url), blobFile(File), memFile(bytes);
 *                  file.window(offset, size) is a part of a file (a zip stored inside a zip).
 *   ChunkCache     remembers the pieces already fetched (128 KB aligned, least recently used out), joins neighbouring
 *                  requests into one and reads ahead when a file is read in order.
 *   ZipArchive     central directory (also ZIP64), stored and deflated entries, entry.window() for stored entries.
 *   WiseArchive    Wise Installation System installers (versions 7 to 9) with or without the signing wrapper.
 *   LayeredVfs     several archives as one folder tree (a later archive wins), with the interface the machine expects:
 *                  stat(key), open(key) -> {size, read(pos, n)}, list(dirKey)   (keys: lower case, '/' separated).
 *
 * Written from the ZIP file format description (APPNOTE) and from my own look at the installers; the layout of the Wise
 * overlay was checked against the notes of the REWise project (GPL-3.0), whose code is not used here.
 */
(function (G) {
  'use strict';
  const EMU = G.EMU = G.EMU || {};
  const MARK = 'playhouse disney/data/';
  let nextId = 1;

  // ------------------------------------------------------------------------------------------------------------ crc32
  const CRC_T = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1); t[n] = c >>> 0; } return t; })();
  function crc32(u8, start) {
    let c = ~(start || 0) >>> 0;
    for (let i = 0; i < u8.length; i++) c = CRC_T[(c ^ u8[i]) & 255] ^ (c >>> 8);
    return (~c) >>> 0;
  }

  // ------------------------------------------------------------------------------------------------------ range files
  /** a file that can be read in pieces.  Roots implement fetch(a, b) (b exclusive); a window shares its root. */
  class RangeFile {
    constructor(name, size) { this.id = nextId++; this.name = name; this.size = size; this.root = this; this.base = 0; }
    window(offset, size, name) {
      const w = Object.create(RangeFile.prototype);
      w.id = nextId++; w.name = name || this.name; w.size = size; w.root = this.root; w.base = this.base + offset;
      return w;
    }
  }
  function nodeFile(path) {
    const fs = require('fs'), size = fs.statSync(path).size, fd = fs.openSync(path, 'r');
    const f = new RangeFile(path.replace(/^.*[\\/]/, ''), size);
    f.fetch = (a, b) => { const n = Math.max(0, Math.min(b, size) - a), buf = Buffer.allocUnsafe(n); let got = 0; while (got < n) { const k = fs.readSync(fd, buf, got, n - got, a + got); if (!k) break; got += k; } return new Uint8Array(buf.buffer, buf.byteOffset, got); };
    return f;
  }
  function memFile(bytes, name) {
    const f = new RangeFile(name || 'memory', bytes.length);
    f.fetch = (a, b) => bytes.subarray(a, Math.min(b, bytes.length));
    return f;
  }
  /** a file chosen on the page (File or Blob); readable synchronously inside a Worker */
  function blobFile(blob, name) {
    const f = new RangeFile(name || blob.name || 'file', blob.size);
    f.fetch = (a, b) => new Uint8Array(new FileReaderSync().readAsArrayBuffer(blob.slice(a, Math.min(b, blob.size))));
    return f;
  }
  /** a file on a web server (Range requests, synchronous: only inside a Worker).  `size` may be given when known. */
  function httpFile(url, name, size) {
    const bin = typeof document === 'undefined';       // inside a Worker a synchronous request may ask for an ArrayBuffer
    const req = (method, range) => {
      const x = new XMLHttpRequest();
      x.open(method, url, false);
      if (method === 'GET') { if (bin) x.responseType = 'arraybuffer'; else x.overrideMimeType('text/plain; charset=x-user-defined'); }
      if (range) x.setRequestHeader('Range', range);
      x.send();
      return x;
    };
    if (size == null) {
      let x = req('HEAD');
      if (x.status === 200 || x.status === 204) size = +x.getResponseHeader('Content-Length');
      if (!(size >= 0)) {                              // no usable HEAD: ask for the first byte and read the total from Content-Range
        x = req('GET', 'bytes=0-0');
        const cr = /\/(\d+)\s*$/.exec(x.getResponseHeader('Content-Range') || '');
        if (cr) size = +cr[1]; else if (x.status === 200) size = bin ? x.response.byteLength : x.responseText.length;
      }
      if (!(size >= 0)) throw new Error('cannot find the size of ' + url + ' (HTTP ' + x.status + ')');
    }
    const f = new RangeFile(name || decodeURIComponent(url.replace(/^.*\//, '')), size);
    f.url = url;
    f.fetch = (a, b) => {
      b = Math.min(b, size);
      const x = req('GET', 'bytes=' + a + '-' + (b - 1));
      if (x.status !== 206 && x.status !== 200) throw new Error('HTTP ' + x.status + ' for ' + url);
      let out;
      if (bin) out = new Uint8Array(x.response);
      else { const t = x.responseText, n = t.length; out = new Uint8Array(n); for (let i = 0; i < n; i++) out[i] = t.charCodeAt(i) & 255; }
      if (x.status === 200 && out.length > b - a) return out.subarray(a, b);       // the server ignored the Range header
      return out;
    };
    return f;
  }

  // ------------------------------------------------------------------------------------------------------ chunk cache
  class ChunkCache {
    constructor(opt) {
      opt = opt || {};
      this.CH = opt.chunk || (1 << 17);
      this.max = opt.maxBytes || (64 << 20);
      this.maxRun = opt.maxRun || 64;                        // most chunks fetched in one request
      this.map = new Map(); this.bytes = 0;
      this.stats = { requests: 0, bytes: 0, hits: 0, misses: 0, waited: 0 };
      this.onWait = null;                                    // called with the milliseconds a fetch took (the machine hides them from the game)
      // inflated files that are being read (see InflateSource); one budget for all archives
      this.srcs = new Map(); this.srcBytes = 0; this.srcMax = opt.inflateBudget || (96 << 20);
    }
    _fetch(root, a, b) {
      const t0 = (typeof performance !== 'undefined') ? performance.now() : 0;
      let out;
      try { out = root.fetch(a, b); }
      finally { if (t0) { const dt = performance.now() - t0; this.stats.waited += dt; if (this.onWait) this.onWait(dt); } }
      this.stats.requests++; this.stats.bytes += out.length;
      return out;
    }
    /** read bytes straight from the file without keeping them (directories and other one-off reads) */
    direct(file, pos, n) {
      if (pos >= file.size) return new Uint8Array(0);
      if (pos + n > file.size) n = file.size - pos;
      return this._fetch(file.root, file.base + pos, file.base + pos + n);
    }
    /** n bytes at pos (fewer at the end of the file).  `ra` = how many chunks to fetch beyond the last one needed (sequential reads). */
    read(file, pos, n, ra) {
      if (pos < 0) pos = 0;
      if (pos >= file.size || n <= 0) return new Uint8Array(0);
      if (pos + n > file.size) n = file.size - pos;
      const root = file.root, abs = file.base + pos, CH = this.CH, map = this.map, rid = root.id * 4194304;
      const c0 = Math.floor(abs / CH), c1 = Math.floor((abs + n - 1) / CH), last = Math.floor((root.size - 1) / CH);
      const parts = new Array(c1 - c0 + 1);
      for (let c = c0; c <= c1; c++) {
        let ch = map.get(rid + c);
        if (ch) { map.delete(rid + c); map.set(rid + c, ch); parts[c - c0] = ch; this.stats.hits++; continue; }
        // a run of missing chunks starting here
        let e = c;
        while (e < c1 && !map.has(rid + e + 1) && e - c + 1 < this.maxRun) e++;
        if (e === c1 && ra) { const want = Math.min(last, e + ra); while (e < want && !map.has(rid + e + 1) && e - c + 1 < this.maxRun) e++; }
        const a = c * CH, b = Math.min((e + 1) * CH, root.size);
        const buf = this._fetch(root, a, b);
        this.stats.misses += e - c + 1;
        for (let k = c; k <= e; k++) {
          const v = buf.subarray((k - c) * CH, Math.min((k - c + 1) * CH, buf.length));
          map.set(rid + k, v); this.bytes += v.length;
          if (k <= c1) parts[k - c0] = v;
        }
        c = Math.min(e, c1);                                  // chunks beyond c1 were read ahead only; those up to c1 are in `parts` now
        while (this.bytes > this.max && map.size > 1) {
          const k0 = map.keys().next().value, v0 = map.get(k0); map.delete(k0); this.bytes -= v0.length;
        }
      }
      for (let k = c0; k <= c1; k++) if (!parts[k - c0]) throw new Error('cache: lost a chunk');
      const o0 = abs - c0 * CH;
      if (c0 === c1) return parts[0].subarray(o0, o0 + n);
      const out = new Uint8Array(n);
      let w = 0;
      for (let k = 0; k < parts.length; k++) {
        const p = parts[k], from = k === 0 ? o0 : 0, take = Math.min(p.length - from, n - w);
        out.set(p.subarray(from, from + take), w); w += take;
      }
      return out;
    }
    /** least recently used inflated files are forgotten when the budget is exceeded */
    touchSource(key, src) {
      const m = this.srcs;
      if (m.has(key)) { m.delete(key); m.set(key, src); return; }
      m.set(key, src); this.srcBytes += src.size;
      while (this.srcBytes > this.srcMax && m.size > 1) {
        const k0 = m.keys().next().value, s0 = m.get(k0);
        if (k0 === key) break;
        m.delete(k0); this.srcBytes -= s0.size;
      }
    }
  }

  // ----------------------------------------------------------------------------------- inflating one stored file
  /** One compressed file (a zip entry or a Wise file): decoded as far as it has been asked for, never twice. */
  class InflateSource {
    constructor(cache, file, start, clen, usize, name) {
      this.cache = cache; this.file = file; this.start = start; this.clen = clen; this.size = usize; this.name = name;
      this.inf = new EMU.Inflater(usize); this.cpos = 0; this.fed = false;
    }
    ensure(end) {
      const inf = this.inf, PUSH = 1 << 16;
      let stuck = 0;
      while (inf.outPos < end && !inf.done) {
        const before = inf.outPos + inf.totalIn;
        inf.run(end);
        if (inf.outPos >= end || inf.done) break;
        if (this.cpos >= this.clen) {
          inf.finish(); inf.run(end);
          if (inf.outPos < end && !inf.done) throw new Error('archive: damaged data in ' + this.name);
          break;
        }
        const k = Math.min(PUSH, this.clen - this.cpos);
        inf.push(this.cache.read(this.file, this.start + this.cpos, k, 4)); this.cpos += k;
        if (this.cpos >= this.clen) inf.finish();
        if (inf.outPos + inf.totalIn === before && ++stuck > 8) throw new Error('archive: no progress inflating ' + this.name);
      }
    }
  }
  function inflatedHandle(cache, keyObj, make) {
    return {
      size: keyObj.usize,
      read(pos, n) {
        if (pos >= keyObj.usize) return new Uint8Array(0);
        const end = Math.min(pos + n, keyObj.usize);
        let src = cache.srcs.get(keyObj);
        if (!src) src = make();
        cache.touchSource(keyObj, src);
        src.ensure(end);
        if (src.inf.outPos < end) throw new Error('archive: short data in ' + keyObj.name);
        return src.inf.out.subarray(pos, end);
      },
    };
  }

  // ---------------------------------------------------------------------------------------------------------- zip
  const dec8 = (typeof TextDecoder !== 'undefined') ? new TextDecoder('utf-8') : null;
  function latin1(u8, a, b) { let s = ''; for (let i = a; i < b; i++) s += String.fromCharCode(u8[i]); return s; }
  const u16 = (d, o) => d[o] | (d[o + 1] << 8);
  const u32 = (d, o) => (d[o] | (d[o + 1] << 8) | (d[o + 2] << 16) | (d[o + 3] << 24)) >>> 0;
  const u64 = (d, o) => u32(d, o) + u32(d, o + 4) * 4294967296;

  /** the name below the game's Data folder: the part after "playhouse disney/data/" when there is one, else the name itself */
  function keyOfName(name, strip) {
    let n = name.replace(/\\/g, '/').replace(/^\/+/, '');
    const low = n.toLowerCase();
    if (strip) for (const s of strip) if (low.startsWith(s)) return n.slice(s.length);
    const i = low.indexOf(MARK);
    return i >= 0 ? n.slice(i + MARK.length) : n;
  }

  class ZipArchive {
    /** opt: {label, strip: ['prefix/', ...] (lower case), include: fn(name)->bool} */
    constructor(file, cache, opt) {
      opt = opt || {};
      this.kind = 'zip'; this.file = file; this.cache = cache; this.label = opt.label || file.name;
      this.strip = (opt.strip || []).map(s => s.toLowerCase().replace(/\\/g, '/'));
      this.include = opt.include || null;
      this.entries = [];                                     // {name, key, method, flags, crc, csize, usize, lho, dataStart}
      this._directory();
    }
    _directory() {
      const f = this.file, cache = this.cache;
      if (f.size < 22) throw new Error(this.label + ': too small to be a zip');
      const tailLen = Math.min(f.size, 65536 + 22 + 20);
      const tail = cache.direct(f, f.size - tailLen, tailLen);
      let p = -1;
      for (let i = tail.length - 22; i >= 0; i--) {
        if (tail[i] === 0x50 && tail[i + 1] === 0x4b && tail[i + 2] === 5 && tail[i + 3] === 6) {
          if (i + 22 + u16(tail, i + 20) === tail.length) { p = i; break; }
          if (p < 0) p = i;
        }
      }
      if (p < 0) throw new Error(this.label + ': no zip directory found (not a zip, or damaged)');
      let total = u16(tail, p + 10), cdSize = u32(tail, p + 12), cdOff = u32(tail, p + 16);
      if (total === 0xFFFF || cdSize === 0xFFFFFFFF || cdOff === 0xFFFFFFFF) {                       // ZIP64
        const eocdAbs = f.size - tailLen + p;
        const loc = cache.direct(f, eocdAbs - 20, 20);
        if (loc.length === 20 && u32(loc, 0) === 0x07064b50) {
          const z = cache.direct(f, u64(loc, 8), 56);
          if (z.length < 56 || u32(z, 0) !== 0x06064b50) throw new Error(this.label + ': damaged ZIP64 directory');
          total = u64(z, 32); cdSize = u64(z, 40); cdOff = u64(z, 48);
        }
      }
      const cd = cache.direct(f, cdOff, cdSize);
      if (cd.length < cdSize) throw new Error(this.label + ': the zip directory is cut off');
      let o = 0;
      for (let i = 0; i < total; i++) {
        if (o + 46 > cd.length || u32(cd, o) !== 0x02014b50) throw new Error(this.label + ': damaged zip directory (entry ' + i + ')');
        const flags = u16(cd, o + 8), method = u16(cd, o + 10), crc = u32(cd, o + 16);
        let csize = u32(cd, o + 20), usize = u32(cd, o + 24), lho = u32(cd, o + 42);
        const nl = u16(cd, o + 28), el = u16(cd, o + 30), cl = u16(cd, o + 32);
        const raw = (flags & 0x800) && dec8 ? dec8.decode(cd.subarray(o + 46, o + 46 + nl)) : latin1(cd, o + 46, o + 46 + nl);
        if (usize === 0xFFFFFFFF || csize === 0xFFFFFFFF || lho === 0xFFFFFFFF) {
          let x = o + 46 + nl; const xe = x + el;
          while (x + 4 <= xe) {
            const id = u16(cd, x), sz = u16(cd, x + 2);
            if (id === 1) {
              let q = x + 4;
              if (usize === 0xFFFFFFFF) { usize = u64(cd, q); q += 8; }
              if (csize === 0xFFFFFFFF) { csize = u64(cd, q); q += 8; }
              if (lho === 0xFFFFFFFF) { lho = u64(cd, q); q += 8; }
            }
            x += 4 + sz;
          }
        }
        o += 46 + nl + el + cl;
        if (raw.endsWith('/')) continue;
        if (this.include && !this.include(raw)) continue;
        if (flags & 1) continue;                                                                    // encrypted: not supported
        const name = keyOfName(raw, this.strip);
        this.entries.push({ name, key: name.toLowerCase(), raw, method, flags, crc, csize, usize, lho, dataStart: -1, archive: this });
      }
    }
    _dataStart(e) {
      if (e.dataStart >= 0) return e.dataStart;
      const h = this.cache.read(this.file, e.lho, 30);
      if (h.length < 30 || u32(h, 0) !== 0x04034b50) throw new Error(this.label + ': damaged local header for ' + e.raw);
      e.dataStart = e.lho + 30 + u16(h, 26) + u16(h, 28);
      return e.dataStart;
    }
    open(e) {
      const cache = this.cache, self = this;
      if (e.method === 0) {
        let last = -1;
        return {
          size: e.usize,
          read(pos, n) {
            if (pos >= e.usize) return new Uint8Array(0);
            n = Math.min(n, e.usize - pos);
            const ra = pos === last ? 4 : 0; last = pos + n;
            return cache.read(self.file, self._dataStart(e) + pos, n, ra);
          },
        };
      }
      if (e.method === 8) return inflatedHandle(cache, e, () => new InflateSource(cache, self.file, self._dataStart(e), e.csize, e.usize, e.raw));
      throw new Error(this.label + ': ' + e.raw + ' uses compression method ' + e.method + ', which is not supported');
    }
    /** a stored entry (a zip inside a zip, an installer) as a file of its own; null when it is compressed */
    window(e) { return e.method === 0 ? this.file.window(this._dataStart(e), e.usize, e.raw.replace(/^.*\//, '')) : null; }
  }

  // ---------------------------------------------------------------------------------------------------- Wise installer
  /** Wise Installation System (versions 7 to 9, 1998-2001): an .exe with raw deflate streams appended.  The signed variant is
   *  a small wrapper program that carries the real installer inside it. */
  class WiseArchive {
    constructor(file, cache, opt) {
      opt = opt || {};
      this.kind = 'wise'; this.file = file; this.cache = cache; this.label = opt.label || file.name;
      this.entries = []; this.info = {};
      this._parse();
    }
    _parse() {
      const f = this.file, cache = this.cache, L = this.label;
      const head = cache.direct(f, 0, Math.min(f.size, 1 << 17));
      if (head[0] !== 0x4d || head[1] !== 0x5a) throw new Error(L + ': not a program file');
      // the installer itself: the wrapper starts it from a temp file, so it is a second program image inside the first
      let stub = 0;
      for (let i = 1; i + 10 < head.length; i++) {
        if (head[i] === 0x4d && head[i + 1] === 0x5a && head[i + 2] === 0x90 && head[i + 3] === 0 && head[i + 4] === 3 && head[i + 5] === 0 && head[i + 6] === 0 && head[i + 7] === 0 && head[i + 8] === 4) { stub = i; break; }
      }
      const peEnd = at => {                                                  // end of the last section of the program image at `at`
        const hb = cache.direct(f, at, 4096);
        const pe = u32(hb, 0x3c);
        if (pe + 24 > hb.length || u32(hb, pe) !== 0x4550) throw new Error(L + ': damaged program header');
        const ns = u16(hb, pe + 6), opt = u16(hb, pe + 20);
        let end = 0;
        for (let i = 0; i < ns; i++) { const s = pe + 24 + opt + 40 * i; end = Math.max(end, u32(hb, s + 20) + u32(hb, s + 16)); }
        return end;
      };
      const ovl = stub + peEnd(stub);
      const h = cache.direct(f, ovl, 512);
      let p = 0;
      const dllNameLen = h[p++]; if (dllNameLen) p += dllNameLen + 4;
      const flags = u32(h, p); p += 4 + 20;
      const inflScript = u32(h, p), deflScript = u32(h, p + 4), deflWise = u32(h, p + 8); p += 12;
      const sz16 = () => { const v = u16(h, p); p += 4; return v; };
      const ctl3d = sz16(), wise2 = sz16(), ocx = sz16();
      const progress = u32(h, p); p += 4;
      const http = sz16(), ctl3dnt = sz16(), msrst = sz16(), reboot = sz16();
      const deflInst = u32(h, p), inflInst = u32(h, p + 4); p += 12 + 0;          // + eof
      const deflDib = u32(h, p), inflDib = u32(h, p + 4); p += 8 + 2;
      const initLen = h[p++]; p += initLen;
      if (inflScript <= 0 || inflScript > (64 << 20) || deflScript <= 4 || deflScript > f.size) throw new Error(L + ': this is not a Wise installer I know (script size)');
      const dstart = ovl + p;
      // what lies between the header and the first game file
      let dataOffset = dstart + deflDib + deflScript + deflWise + ctl3dnt + progress + deflInst;
      if (flags & 0x8000) dataOffset += wise2;
      if (flags & 0x20000) dataOffset += ocx;
      if (flags & 0x2000) dataOffset += msrst;
      if (!(reboot & 0x8000)) dataOffset += reboot;
      if (flags & 0x4000000) dataOffset += http;
      // the script (all file records)
      const sc = cache.direct(f, dstart + deflDib, deflScript);
      const inf = new EMU.Inflater(inflScript);
      inf.push(sc.subarray(0, deflScript - 4)); inf.finish(); inf.run(inflScript);
      if (inf.outPos !== inflScript) throw new Error(L + ': damaged installer script');
      if (crc32(inf.out) !== u32(sc, deflScript - 4)) throw new Error(L + ': the installer script fails its checksum');
      const d = inf.out;
      // where the data ends: before a signature block at the very end, if there is one
      let dataEnd = f.size;
      {
        const hb = head, pe = u32(hb, 0x3c);
        const nrva = u32(hb, pe + 24 + 92);
        if (nrva > 4) { const so = u32(hb, pe + 24 + 96 + 8 * 4), ss = u32(hb, pe + 24 + 96 + 8 * 4 + 4); if (so && ss && so + ss === f.size) dataEnd = so; }
      }
      // file records: op 0, 2 bytes, start, end, date, time, size, 20 bytes, crc, then the target path
      const recs = [];
      let prevEnd = 0;
      for (let q = 0; q + 50 < d.length; q++) {
        if (d[q] !== 0) continue;
        const start = u32(d, q + 3), end = u32(d, q + 7), date = u16(d, q + 11), tm = u16(d, q + 13), size = u32(d, q + 15);
        const mo = (date >> 5) & 15, dy = date & 31, yr = (date >> 9) + 1980;
        if (start > end || end - start < 4 || end > f.size || start < prevEnd || start - prevEnd > (64 << 20)) continue;
        if (mo < 1 || mo > 12 || dy < 1 || dy > 31 || yr < 1990 || yr > 2030) continue;
        let e = q + 43;
        while (e < d.length && e < q + 43 + 300 && d[e] >= 0x20 && d[e] < 0x7f) e++;
        if (e === q + 43 || d[e] !== 0) continue;
        const dest = latin1(d, q + 43, e);
        if (!(dest.charAt(0) === '%' || dest.substr(1, 2) === ':\\')) continue;
        recs.push({ dest, start, end, size, crc: u32(d, q + 39), date, time: tm });
        prevEnd = end; q = e;
      }
      if (!recs.length) throw new Error(L + ': no files found in this installer');
      // The sizes in the header give the start of the file data; a second way is the end of the last file counted back from the
      // end of the installer.  Whichever one makes the first small files inflate and match their checksums is the right one.
      let maxEnd = 0; for (const r of recs) if (r.end > maxEnd) maxEnd = r.end;
      const cands = [['header', dataOffset], ['from the end', dataEnd - maxEnd], ['from the end of the file', f.size - maxEnd]];
      const probe = recs.filter(r => r.size > 0 && r.size <= (1 << 20) && r.end - r.start <= (1 << 20)).slice(0, 3);
      const works = off => {
        if (off < ovl || off + maxEnd > f.size) return false;
        for (const r of probe) {
          const raw = cache.direct(f, off + r.start, r.end - r.start);
          if (raw.length !== r.end - r.start) return false;
          try {
            const z = new EMU.Inflater(r.size); z.push(raw.subarray(0, raw.length - 4)); z.finish(); z.run(r.size);
            if (z.outPos !== r.size || (r.crc && crc32(z.out) !== r.crc)) return false;
          } catch (e) { return false; }
        }
        return probe.length > 0;
      };
      let how = null;
      for (const [nm, off] of cands) if (works(off)) { dataOffset = off; how = nm; break; }
      if (!how) throw new Error(L + ': cannot find where the files of this installer start');
      this.info.dataOffset = dataOffset; this.info.offsetFrom = how; this.info.files = recs.length; this.info.stub = stub; this.info.flags = flags;
      for (const r of recs) {
        const m = /^%DATADIR%[\\/](.*)$/i.exec(r.dest);
        if (!m) continue;                                                                           // the installer's own files, the launcher...
        const name = m[1].replace(/\\/g, '/');
        this.entries.push({ name, key: name.toLowerCase(), raw: r.dest, method: 8, crc: r.crc, csize: r.end - r.start - 4, usize: r.size, start: dataOffset + r.start, archive: this });
      }
    }
    open(e) {
      const cache = this.cache, self = this;
      if (e.usize === 0) return { size: 0, read: () => new Uint8Array(0) };
      return inflatedHandle(cache, e, () => new InflateSource(cache, self.file, e.start, e.csize, e.usize, e.raw));
    }
    window() { return null; }
  }

  /** open whatever it is: a zip or a Wise installer */
  function openArchive(file, cache, opt) {
    const h = cache.direct(file, 0, 4);
    if (h[0] === 0x50 && h[1] === 0x4b) return new ZipArchive(file, cache, opt);
    if (h[0] === 0x4d && h[1] === 0x5a) return new WiseArchive(file, cache, opt);
    // zips that are empty or start with something else still have their directory at the end
    return new ZipArchive(file, cache, opt);
  }

  // -------------------------------------------------------------------------------------------------- layered folder tree
  class LayeredVfs {
    constructor() {
      this.files = new Map();            // key -> {archive, entry}
      this.dirs = new Map();             // dirKey -> Map(lowerName -> {name, dir, size})
      this.archives = [];
      this.dirs.set('', new Map());
    }
    /** add an archive; where names collide, the archive added last wins */
    add(archive) {
      this.archives.push(archive);
      for (const e of archive.entries) {
        this.files.set(e.key, { archive, entry: e });
        const parts = e.name.split('/');
        let dir = '';
        for (let i = 0; i < parts.length - 1; i++) {
          const nm = parts[i], low = nm.toLowerCase(), key = dir ? dir + '/' + low : low;
          let m = this.dirs.get(dir); if (!m) { m = new Map(); this.dirs.set(dir, m); }
          if (!m.has(low)) m.set(low, { name: nm, dir: true, size: 0 });
          if (!this.dirs.has(key)) this.dirs.set(key, new Map());
          dir = key;
        }
        let m = this.dirs.get(dir); if (!m) { m = new Map(); this.dirs.set(dir, m); }
        const fn = parts[parts.length - 1];
        m.set(fn.toLowerCase(), { name: fn, dir: false, size: e.usize });
      }
      return this;
    }
    /** the files by key (for tools that want to look at all names) */
    get index() { return this.files; }
    stat(key) {
      const f = this.files.get(key);
      if (f) return { dir: false, size: f.entry.usize };
      if (key && this.dirs.has(key)) return { dir: true, size: 0 };
      return null;
    }
    open(key) { const f = this.files.get(key); return f.archive.open(f.entry); }
    list(dirKey) { const m = this.dirs.get(dirKey || ''); return m ? [...m.values()].map(x => ({ name: x.name, dir: x.dir, size: x.size })) : []; }
    /** names of the lesson folders (LP0301 ...) found at the top */
    lessons() { return this.list('').filter(x => x.dir && /^LP\d{4}$/i.test(x.name)).map(x => x.name.toUpperCase()).sort(); }
  }

  EMU.RangeFile = RangeFile; EMU.nodeFile = nodeFile; EMU.memFile = memFile; EMU.blobFile = blobFile; EMU.httpFile = httpFile;
  EMU.ChunkCache = ChunkCache; EMU.ZipArchive = ZipArchive; EMU.WiseArchive = WiseArchive; EMU.openArchive = openArchive;
  EMU.LayeredVfs = LayeredVfs; EMU.crc32 = crc32; EMU.keyOfName = keyOfName;
  if (typeof module !== 'undefined' && module.exports) module.exports = { RangeFile, nodeFile, memFile, blobFile, httpFile, ChunkCache, ZipArchive, WiseArchive, openArchive, LayeredVfs, crc32, keyOfName };
})(typeof globalThis !== 'undefined' ? globalThis : this);
