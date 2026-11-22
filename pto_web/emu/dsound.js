/* DirectSound stand-in plus the software mixer shared with the video-clip stand-in (smack.js).
 *
 * The mixer runs on the machine's virtual clock: sync(now) advances every playing buffer by the elapsed time, so the game's
 * streaming code (which polls GetCurrentPosition and refills behind the play cursor) sees a sound card that plays in real time.
 * A host that wants to hear the result calls mixer.attach() and then mixer.pull(maxFrames) for interleaved stereo floats at mixer.rate.
 * Without a listener only the play positions are advanced (cheap).
 *
 * COM objects are 16-byte guest blocks [vtable ptr][object id]; every vtable slot is a trap (same scheme as ddraw.js).
 */
(function (G) {
  'use strict';
  const EMU = G.EMU;
  const DS_OK = 0, E_NOINTERFACE = 0x80004002 | 0, DSERR_INVALIDPARAM = 0x80070057 | 0, DSERR_INVALIDCALL = 0x88780032 | 0,
    DSERR_BADFORMAT = 0x88780064 | 0, DSERR_GENERIC = 0x80004005 | 0;

  const U = [['QueryInterface', 2], ['AddRef', 0], ['Release', 0]];
  const DS = U.concat([['CreateSoundBuffer', 3], ['GetCaps', 1], ['DuplicateSoundBuffer', 2], ['SetCooperativeLevel', 2], ['Compact', 0], ['GetSpeakerConfig', 1], ['SetSpeakerConfig', 1], ['Initialize', 1]]);
  const DSB = U.concat([['GetCaps', 1], ['GetCurrentPosition', 2], ['GetFormat', 3], ['GetVolume', 1], ['GetPan', 1], ['GetFrequency', 1], ['GetStatus', 1], ['Initialize', 2],
    ['Lock', 7], ['Play', 3], ['SetCurrentPosition', 1], ['SetFormat', 1], ['SetVolume', 1], ['SetPan', 1], ['SetFrequency', 1], ['Stop', 0], ['Unlock', 4], ['Restore', 0]]);
  const DSN = U.concat([['SetNotificationPositions', 2]]);
  const IFACES = {
    IDirectSound: { m: DS, kind: 'ds', iid: 0x279AFA83 },
    IDirectSoundBuffer: { m: DSB, kind: 'buf', iid: 0x279AFA85 },
    IDirectSoundNotify: { m: DSN, kind: 'notify', iid: 0xB0210783 },
  };

  const dbGain = v => (v <= -10000 ? 0 : Math.pow(10, v / 2000));       // hundredths of a decibel -> amplitude

  /* ------------------------------------------------------------------------------------------------ mixer */
  class Mixer {
    constructor(m) {
      this.m = m; this.rate = 44100; this.sources = new Set(); this.last = null; this.frac = 0; this.attached = false;
      this.ring = new Float32Array(this.rate * 2 * 2); this.rw = 0; this.rr = 0;      // 2 s of stereo, monotonic frame counters
      this.tmp = new Float32Array(this.rate);                                          // render scratch (0.5 s stereo)
      this.streams = new Map(); this.master = 1;
    }
    attach() { this.attached = true; this.last = null; }
    /** advance (and, when a listener is attached, render) up to the virtual time `now` (ms) */
    sync(now) {
      if (this.last === null) { this.last = now; return; }
      const dt = now - this.last; if (dt <= 0) return;
      this.last = now;
      if (!this.sources.size && !this.attached) { this.frac = 0; return; }        // (with a listener the stream goes on, as silence: a gap then always means a real hold-up)
      const f = dt * this.rate / 1000 + this.frac, n = Math.floor(f); this.frac = f - n;
      if (n <= 0) return;
      const cap = this.rate >> 1;
      if (n > cap) { for (const s of this.sources) s.mix(null, n - cap, this.rate); this.mixBlock(cap); } else this.mixBlock(n);
    }
    mixBlock(n) {
      if (!this.attached) { for (const s of this.sources) s.mix(null, n, this.rate); return; }
      const out = this.tmp.subarray(0, n * 2); out.fill(0);
      for (const s of this.sources) s.mix(out, n, this.rate);
      const R = this.ring, cap = R.length >> 1, g = this.master;
      for (let i = 0; i < n; i++) {
        let l = out[2 * i] * g, r = out[2 * i + 1] * g;
        l = l > 1 ? 1 : l < -1 ? -1 : l; r = r > 1 ? 1 : r < -1 ? -1 : r;
        const o = (this.rw % cap) * 2; R[o] = l; R[o + 1] = r; this.rw++;
      }
      if (this.rw - this.rr > cap) this.rr = this.rw - cap;                             // listener too slow: drop the oldest
    }
    /** interleaved stereo floats, at most maxFrames frames */
    pull(maxFrames) {
      const R = this.ring, cap = R.length >> 1, n = Math.min(maxFrames, this.rw - this.rr), out = new Float32Array(n * 2);
      for (let i = 0; i < n; i++) { const o = ((this.rr + i) % cap) * 2; out[2 * i] = R[o]; out[2 * i + 1] = R[o + 1]; }
      this.rr += n; return out;
    }
    add(s) { this.sources.add(s); }
    remove(s) { this.sources.delete(s); }
    // ---- streams (video-clip audio): PCM is queued and played back at its own rate
    streamOpen(id, rate, channels, bits) {
      const s = new StreamSource(this.m, rate, channels, bits); this.streams.set(id, s); this.add(s); return s;
    }
    /** `due` (optional): the virtual time at which the first sample of `data` belongs to be heard */
    streamFeed(id, data, due) { const s = this.streams.get(id); if (!s) return; const now = this.m.now(); this.sync(now); s.feed(data, due, now); }
    streamStats() { return [...this.streams.values()].map(s => ({ late: Math.round(s.lastLate), trimmed: Math.round(s.trimmed) })); }
    streamClear(id) { const s = this.streams.get(id); if (s) s.clear(); }
    streamGain(id, gain, pan) { const s = this.streams.get(id); if (s) { s.gl = gain * (pan > 0 ? 1 - pan : 1); s.gr = gain * (pan < 0 ? 1 + pan : 1); } }
    streamClose(id) { const s = this.streams.get(id); if (s) { this.remove(s); this.streams.delete(id); } }
  }

  /* Sound of a video clip is queued one picture at a time, when the game shows that picture (sometimes with a head start: the first
   * pictures can carry a second or more of sound). The sound belongs to a timeline that starts when the clip starts. If the game was
   * held up (a slow frame) it shows several pictures in a row to catch up, and sound that is queued only now would start later than
   * it belongs for the rest of the clip. A chunk that would start more than LATE_MS after its place on the timeline loses the part
   * that is out of date, like the pictures that were skipped over. Sound that was queued ahead needs no such care: it keeps playing. */
  const LATE_MS = 45, LATE_KEEP_MS = 10;
  class StreamSource {
    constructor(m, rate, channels, bits) {
      this.rate = rate; this.ch = channels; this.bits = bits; this.gl = 1; this.gr = 1;
      this.buf = new Float32Array(rate * channels * 2); this.wr = 0; this.rd = 0;       // frames; rd is fractional
      this.fed = 0; this.origin = null; this.lastDue = -Infinity; this.noTrim = false;   // timeline: sound fed so far (frames), when its start belongs
      this.lastLate = 0; this.trimmed = 0;
    }
    clear() { this.wr = 0; this.rd = 0; this.fed = 0; this.origin = null; this.lastDue = -Infinity; }
    /** `due`: virtual time (ms) at which the picture that this sound belongs to is due, `now`: the virtual time now */
    feed(data, due, now) {
      let late = 0;
      if (due !== undefined) {
        if (due === this.lastDue) this.noTrim = true;                                   // two sound tracks for one picture: leave it alone
        this.lastDue = due;
        if (this.origin === null) this.origin = due;
        late = now + (this.wr - this.rd) / this.rate * 1000 - (this.origin + this.fed / this.rate * 1000);   // where this chunk would start, minus where it belongs
        this.lastLate = late;
      }
      const frames = Math.floor(data.length / this.ch);
      this.append(data);
      this.fed += frames;
      if (late > LATE_MS && !this.noTrim) {
        const drop = Math.min((late - LATE_KEEP_MS) * this.rate / 1000, this.wr - this.rd);
        this.rd += drop; this.trimmed += drop / this.rate * 1000;
      }
    }
    append(data) {
      const ch = this.ch, frames = Math.floor(data.length / ch);
      if ((this.wr + frames) * ch > this.buf.length) {
        const keep = Math.floor(this.rd);                                                // drop what was already played
        this.buf.copyWithin(0, keep * ch, this.wr * ch); this.wr -= keep; this.rd -= keep;
        if ((this.wr + frames) * ch > this.buf.length) { const nb = new Float32Array((this.wr + frames) * ch * 2); nb.set(this.buf.subarray(0, this.wr * ch)); this.buf = nb; }
      }
      const b = this.buf, o = this.wr * ch, n = frames * ch;
      if (this.bits === 16) for (let i = 0; i < n; i++) b[o + i] = data[i] / 32768; else for (let i = 0; i < n; i++) b[o + i] = (data[i] - 128) / 128;
      this.wr += frames;
    }
    mix(out, n, outRate) {
      const step = this.rate / outRate, b = this.buf, ch = this.ch;
      let pos = this.rd;
      if (!out) { pos = Math.min(this.wr, pos + n * step); this.rd = pos; return; }
      for (let i = 0; i < n; i++) {
        const i0 = pos | 0; if (i0 + 1 >= this.wr) break;                                 // underrun: wait for more data
        const fr = pos - i0, a = i0 * ch, c1 = a + ch;
        const l0 = b[a], l1 = b[c1], r0 = ch === 2 ? b[a + 1] : l0, r1 = ch === 2 ? b[c1 + 1] : l1;
        out[2 * i] += (l0 + (l1 - l0) * fr) * this.gl; out[2 * i + 1] += (r0 + (r1 - r0) * fr) * this.gr;
        pos += step;
      }
      this.rd = pos;
    }
  }

  /* ------------------------------------------------------------------------------------------------ DirectSound */
  function install(m) {
    const c = m.cpu;
    const trace = s => { if (m.opts.traceDS || m.opts.traceFiles) m.log('  [ds] ' + s); };
    const mixer = m.mixer = new Mixer(m);
    const objs = [null], vtables = {};

    function vtableFor(iface) {
      if (vtables[iface]) return vtables[iface];
      const list = IFACES[iface].m, base = m.scratch(list.length * 4);
      list.forEach(([name, n], i) => {
        const addr = m.rawTrap(iface + '::' + name, n + 1, (cpu, sp) => {
          const self = cpu.H.rd32(sp), obj = objs[cpu.H.rd32(self + 4)];
          if (!obj) throw new Error('DirectSound: call on dead object ' + iface + '::' + name);
          const h = obj.methods[name], a = [];
          for (let k = 0; k < n; k++) a.push(cpu.H.rd32(sp + 4 + 4 * k));
          if (!h) throw new Error('unimplemented DirectSound method ' + iface + '::' + name + ' (' + obj.kind + ')');
          mixer.sync(m.now());
          const r = h.call(obj, iface, self, ...a);
          if (m.opts.traceDS) trace(iface + '::' + name + '(' + a.map(v => '0x' + (v >>> 0).toString(16)).join(', ') + ') -> 0x' + ((r === undefined ? 0 : r) >>> 0).toString(16));
          return r === undefined ? 0 : r;
        });
        m.wr32(base + i * 4, addr);
      });
      return (vtables[iface] = base);
    }
    function newCom(model, iface) { model.id = objs.length; objs.push(model); model.refs = 1; return comPtr(model, iface); }
    function comPtr(model, iface) {
      const key = '$' + iface; if (model[key]) return model[key];
      const p = m.malloc(16, true); m.wr32(p, vtableFor(iface)); m.wr32(p + 4, model.id); model[key] = p; return p;
    }
    function queryInterface(obj, kind, self, piid, ppv) {
      const key = m.rd32(piid) >>> 0;
      for (const [name, f] of Object.entries(IFACES)) {
        if (f.iid !== key) continue;
        if (f.kind === kind) { obj.refs++; m.wr32(ppv, comPtr(obj, name)); return DS_OK; }
        if (f.kind === 'notify' && kind === 'buf') {
          if (!obj.notifyObj) { obj.notifyObj = { kind: 'notify', buf: obj, methods: Object.assign({}, common, notifyMethods) }; newCom(obj.notifyObj, 'IDirectSoundNotify'); }
          obj.notifyObj.refs++; m.wr32(ppv, comPtr(obj.notifyObj, 'IDirectSoundNotify')); return DS_OK;
        }
      }
      trace('QueryInterface(' + key.toString(16) + ') -> E_NOINTERFACE');
      m.wr32(ppv, 0); return E_NOINTERFACE;
    }
    const common = {
      QueryInterface(iface, self, piid, ppv) { return queryInterface(this, this.kind, self, piid, ppv); },
      AddRef() { return ++this.refs; },
      Release() { if (--this.refs <= 0 && this.destroy) this.destroy(); return Math.max(0, this.refs); },
    };

    /* ---- sound buffers */
    class BufferSource {
      constructor(model) { this.b = model; }
      mix(out, n, outRate) { this.b.mix(out, n, outRate); }
    }
    function readFormat(p) {
      return { tag: c.u16[p >> 1], channels: c.u16[(p + 2) >> 1], rate: m.rd32(p + 4), avg: m.rd32(p + 8), align: c.u16[(p + 12) >> 1], bits: c.u16[(p + 14) >> 1] };
    }
    function makeBuffer(flags, bytes, fmt) {
      const b = { kind: 'buf', flags, bytes, fmt, primary: !!(flags & 1), mem: 0, playing: false, looping: false, posF: 0, vol: 0, pan: 0, freq: 0,
        gl: 1, gr: 1, notify: [], methods: null, src: null };
      b.methods = Object.assign({}, common, bufMethods);
      if (!b.primary) {
        b.mem = m.malloc(bytes + 16, true);
        if (fmt) { b.channels = fmt.channels; b.bits = fmt.bits; b.align = fmt.align || (fmt.channels * fmt.bits / 8); b.freq = fmt.rate; b.frames = Math.floor(bytes / b.align); }
        else { b.channels = 1; b.bits = 8; b.align = 1; b.freq = 22050; b.frames = bytes; }
        b.src = new BufferSource(b); mixer.add(b.src);
      }
      b.destroy = () => { if (b.src) mixer.remove(b.src); if (b.mem) { m.free(b.mem); b.mem = 0; } };
      b.mix = bufferMix;
      return b;
    }
    function bufferMix(out, n, outRate) {
      const b = this; if (!b.playing || !b.frames) return;
      const step = b.freq / outRate, total = b.frames, ch = b.channels, u8 = c.u8, base = b.mem, bits = b.bits, loop = b.looping;
      const start = b.posF; let pos = start;
      if (!out) {
        pos += n * step;
        if (pos >= total) { if (loop) pos %= total; else { b.playing = false; pos = 0; fireNotify(b, start, total, true); b.posF = 0; return; } }
      } else {
        const gl = b.gl * 1, gr = b.gr * 1, ba = b.align;
        for (let i = 0; i < n; i++) {
          const i0 = pos | 0, fr = pos - i0;
          let i1 = i0 + 1; if (i1 >= total) i1 = loop ? 0 : i0;
          const a0 = base + i0 * ba, a1 = base + i1 * ba;
          let l0, l1, r0, r1;
          if (bits === 16) {
            l0 = ((u8[a0] | (u8[a0 + 1] << 8)) << 16 >> 16) / 32768; l1 = ((u8[a1] | (u8[a1 + 1] << 8)) << 16 >> 16) / 32768;
            if (ch === 2) { r0 = ((u8[a0 + 2] | (u8[a0 + 3] << 8)) << 16 >> 16) / 32768; r1 = ((u8[a1 + 2] | (u8[a1 + 3] << 8)) << 16 >> 16) / 32768; } else { r0 = l0; r1 = l1; }
          } else {
            l0 = (u8[a0] - 128) / 128; l1 = (u8[a1] - 128) / 128;
            if (ch === 2) { r0 = (u8[a0 + 1] - 128) / 128; r1 = (u8[a1 + 1] - 128) / 128; } else { r0 = l0; r1 = l1; }
          }
          out[2 * i] += (l0 + (l1 - l0) * fr) * gl; out[2 * i + 1] += (r0 + (r1 - r0) * fr) * gr;
          pos += step;
          if (pos >= total) {
            if (loop) pos -= total; else { b.playing = false; fireNotify(b, start, total, true); b.posF = 0; return; }
          }
        }
      }
      b.posF = pos;
      fireNotify(b, start, pos, false);
    }
    function fireNotify(b, from, to, stopped) {
      if (!b.notify.length) return;
      for (const nt of b.notify) {
        let hit;
        if (nt.off < 0) hit = stopped;                                                    // DSBPN_OFFSETSTOP
        else if (to >= from) hit = nt.off >= from && nt.off < to + (stopped ? 1 : 0);
        else hit = nt.off >= from || nt.off < to;                                         // wrapped
        if (hit) { const o = m.getHandle(nt.h); if (o && o.type === 'event') o.signaled = true; }
      }
    }
    const cursors = b => {
      const play = Math.floor(b.posF) * b.align;
      let write = play;
      if (b.playing) write = (play + Math.ceil(b.freq * 0.02) * b.align) % Math.max(b.bytes, 1);
      return [play, write];
    };
    const bufMethods = {
      GetCaps(iface, self, p) { m.zero(p, 20); m.wr32(p, 20); m.wr32(p + 4, this.flags); m.wr32(p + 8, this.bytes); m.wr32(p + 12, 100000); return DS_OK; },
      GetCurrentPosition(iface, self, pPlay, pWrite) {
        const [play, write] = cursors(this);
        if (pPlay) m.wr32(pPlay, play); if (pWrite) m.wr32(pWrite, write); return DS_OK;
      },
      GetFormat(iface, self, p, size, pWritten) {
        const f = this.fmt || { tag: 1, channels: 2, rate: 22050, avg: 88200, align: 4, bits: 16 };
        if (p) { m.zero(p, Math.min(size, 18)); c.u16[p >> 1] = 1; c.u16[(p + 2) >> 1] = f.channels; m.wr32(p + 4, f.rate); m.wr32(p + 8, f.avg || f.rate * f.align); c.u16[(p + 12) >> 1] = f.align; c.u16[(p + 14) >> 1] = f.bits; }
        if (pWritten) m.wr32(pWritten, 18); return DS_OK;
      },
      GetVolume(iface, self, p) { m.wr32(p, this.vol); return DS_OK; },
      GetPan(iface, self, p) { m.wr32(p, this.pan); return DS_OK; },
      GetFrequency(iface, self, p) { m.wr32(p, this.freq); return DS_OK; },
      GetStatus(iface, self, p) { m.wr32(p, (this.playing ? 1 | (this.looping ? 4 : 0) : 0)); return DS_OK; },
      Initialize() { return DS_OK; },
      Lock(iface, self, off, len, pp1, pb1, pp2, pb2, flags) {
        if (this.primary) return DSERR_INVALIDCALL;
        if (flags & 2) { off = 0; len = this.bytes; }
        else if (flags & 1) off = cursors(this)[1];
        if (off >= this.bytes || len > this.bytes) return DSERR_INVALIDPARAM;
        const first = Math.min(len, this.bytes - off);
        m.wr32(pp1, this.mem + off); m.wr32(pb1, first);
        if (pp2) { if (len > first) { m.wr32(pp2, this.mem); m.wr32(pb2, len - first); } else { m.wr32(pp2, 0); if (pb2) m.wr32(pb2, 0); } }
        return DS_OK;
      },
      Unlock() { return DS_OK; },
      Play(iface, self, r1, prio, flags) {
        if (!this.primary) { this.playing = true; this.looping = !!(flags & 1); if (this.posF >= this.frames) this.posF = 0; }
        else this.playing = true;
        return DS_OK;
      },
      Stop() { if (this.playing) { this.playing = false; fireNotify(this, this.posF, this.posF, true); } return DS_OK; },
      SetCurrentPosition(iface, self, pos) { if (!this.primary) this.posF = Math.min(Math.floor(pos / this.align), this.frames); return DS_OK; },
      SetFormat(iface, self, p) { if (p) { const f = readFormat(p); if (this.primary) this.fmt = f; } return DS_OK; },
      SetVolume(iface, self, v) { v |= 0; this.vol = v; this.setGains(); return DS_OK; },
      SetPan(iface, self, v) { v |= 0; this.pan = v; this.setGains(); return DS_OK; },
      SetFrequency(iface, self, hz) { if (!this.primary) this.freq = hz === 0 ? (this.fmt ? this.fmt.rate : 22050) : hz; return DS_OK; },
      Restore() { return DS_OK; },
    };
    const notifyMethods = {
      SetNotificationPositions(iface, self, n, p) {
        const b = this.buf; b.notify = [];
        for (let i = 0; i < n; i++) { const off = m.rd32(p + i * 8) | 0, h = m.rd32(p + i * 8 + 4); b.notify.push({ off: off < 0 ? -1 : Math.floor(off / b.align), h }); }
        trace('SetNotificationPositions x' + n);
        return DS_OK;
      },
    };
    // per-buffer volume/pan -> channel gains (called when either changes)
    const proto = { setGains() { const v = dbGain(this.vol), p = this.pan; this.gl = v * (p > 0 ? dbGain(-p) : 1); this.gr = v * (p < 0 ? dbGain(p) : 1); } };

    /* ---- the DirectSound object */
    const dsMethods = Object.assign({}, common, {
      CreateSoundBuffer(iface, self, pdesc, pout, unk) {
        const size = m.rd32(pdesc), flags = m.rd32(pdesc + 4), bytes = m.rd32(pdesc + 8), pfmt = m.rd32(pdesc + 16);
        let fmt = null;
        if (pfmt) { fmt = readFormat(pfmt); if (fmt.tag !== 1) { trace('CreateSoundBuffer: unsupported format tag ' + fmt.tag); return DSERR_BADFORMAT; } }
        if (!(flags & 1) && (!fmt || !bytes)) return DSERR_INVALIDPARAM;
        trace('CreateSoundBuffer flags=0x' + flags.toString(16) + ' bytes=' + bytes + (fmt ? ' ' + fmt.rate + 'Hz ' + fmt.channels + 'ch ' + fmt.bits + 'bit' : ''));
        const b = makeBuffer(flags, bytes, fmt); Object.assign(b, { setGains: proto.setGains });
        m.wr32(pout, newCom(b, 'IDirectSoundBuffer')); return DS_OK;
      },
      GetCaps(iface, self, p) {
        const sz = m.rd32(p) || 96; m.zero(p, sz); m.wr32(p, sz);
        m.wr32(p + 4, 0x1 | 0x2 | 0x4 | 0x8 | 0x10 | 0x100 | 0x200 | 0x400 | 0x800); m.wr32(p + 8, 100); m.wr32(p + 12, 100000); m.wr32(p + 16, 1);
        return DS_OK;
      },
      DuplicateSoundBuffer(iface, self, porig, pout) {
        const o = objs[m.rd32(porig + 4)]; if (!o || o.primary) return DSERR_INVALIDPARAM;
        const b = makeBuffer(o.flags, o.bytes, o.fmt); Object.assign(b, { setGains: proto.setGains });
        c.u8.copyWithin(b.mem, o.mem, o.mem + o.bytes); b.vol = o.vol; b.pan = o.pan; b.freq = o.freq; b.setGains();
        m.wr32(pout, newCom(b, 'IDirectSoundBuffer')); return DS_OK;
      },
      SetCooperativeLevel() { return DS_OK; },
      Compact() { return DS_OK; },
      GetSpeakerConfig(iface, self, p) { m.wr32(p, 3); return DS_OK; },
      SetSpeakerConfig() { return DS_OK; },
      Initialize() { return DS_OK; },
    });

    m.def('dsound.dll', 'DirectSoundCreate', 3, (m, pguid, pout, unk) => {
      const ds = { kind: 'ds', methods: dsMethods };
      m.wr32(pout, newCom(ds, 'IDirectSound')); trace('DirectSoundCreate');
      return DS_OK;
    });
    m.def('dsound.dll', 'DirectSoundEnumerateA', 2, () => DS_OK);
  }
  EMU.Mixer = Mixer;
  EMU.installDsound = install;
})(typeof globalThis !== 'undefined' ? globalThis : this);
