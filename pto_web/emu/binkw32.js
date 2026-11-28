/* binkw32.dll stand-in: the Bink video player functions the Playhouse Disney client uses (BinkOpen ... BinkClose).
 * The movie decoding itself is in bink.js; this file keeps the BINK structure in guest memory, the clock (BinkWait), seeking
 * (BinkGoto) and the sound of the movie (fed to the shared mixer of dsound.js).
 *
 * BINK structure (the fields the program reads), offsets in bytes:
 *   +0 Width  +4 Height  +8 Frames  +12 FrameNum (1 based, the frame to be shown next)  +16 LastFrameNum (1 based, last frame decoded; 0 before the first)
 *   +20 FrameRate  +24 FrameRateDiv  +28 ReadError  +32 OpenFlags  +36 BinkType  +40 Size  +44 FrameSize  +48 SndSize
 *   +52 FrameRects[8] (Left, Top, Width, Height)  +180 NumRects
 */
(function (G) {
  'use strict';
  const EMU = G.EMU;
  const BW = 'binkw32.dll';
  const BINKSNDTRACK = 0x4000, BINKNOSKIP = 0x80000, BINKALPHA = 0x100000;
  const STRUCT_SIZE = 0x1C0;

  function install(m) {
    const c = m.cpu;
    const trace = s => { if (m.opts.traceBink || m.opts.traceFiles) m.log('  [bink] ' + s); };
    const d = (name, n, fn) => m.def(BW, '_' + name + '@' + n * 4, n, fn);
    const movies = new Map();                   // BINK pointer -> Movie
    const files = new Map();                    // lower-case full path -> {bin, file}  (small cache so that sprites opened many times are read once)
    const state = m.bink = { movies, soundSystem: false, soundTracks: [], opened: 0, framesDecoded: 0, framesSkipped: 0 };
    let fileBytes = 0;

    class Movie {
      constructor(ptr, file, flags, name) {
        this.ptr = ptr; this.file = file; this.flags = flags; this.name = name;
        this.dec = new EMU.BinkVideoDecoder(file);
        this.frameNum = 1; this.lastFrameNum = 0; this.decodedIdx = -1; this.readError = 0;
        this.durMs = 1000 * file.fpsDen / Math.max(1, file.fpsNum);
        this.startTime = null; this.paused = false; this.pauseAt = 0; this.decodedCount = 0;
        this.sid = 'bink' + ptr; this.stream = null; this.adec = null; this.trackIdx = -1; this.audioCursor = 0; this.soundOff = false; this.volume = 1;
      }
      /** write the fields the program looks at */
      publish() {
        m.wr32(this.ptr + 12, this.frameNum); m.wr32(this.ptr + 16, this.lastFrameNum); m.wr32(this.ptr + 28, this.readError);
      }
      openSound() {
        const f = this.file;
        if (!state.soundSystem || !f.audioTracks.length || !m.mixer) return;
        let ti = 0;
        if ((this.flags & BINKSNDTRACK) && state.soundTracks.length) { ti = f.audioTracks.findIndex(t => t.id === state.soundTracks[0]); if (ti < 0) return; }
        const t = f.audioTracks[ti];
        if (!t.useDct && f.version > 0x62) { /* old RDFT sound: handled by the decoder */ }
        this.adec = new EMU.BinkAudioDecoder(t.rate, t.channels, t.useDct, f.version);
        this.trackIdx = ti;
        this.stream = m.mixer.streamOpen(this.sid, t.rate, t.channels, 16);
        this.stream.gl = this.stream.gr = this.volume;
        trace('  sound track ' + ti + ': ' + t.rate + ' Hz ' + t.channels + ' ch ' + (t.useDct ? 'DCT' : 'RDFT'));
      }
      closeSound() { if (this.stream) { m.mixer.streamClose(this.sid); this.stream = null; } }
      /** keep about half a second of decoded sound queued */
      pumpSound() {
        if (!this.stream || this.soundOff || this.paused) return;
        const mx = m.mixer, s = this.stream, f = this.file; mx.sync(m.now());
        let ahead = (s.wr - s.rd) / s.rate, guard = 0;
        while (ahead < 0.5 && guard++ < 96 && this.audioCursor < f.frames) {
          const pk = f.packet(this.audioCursor++).audio[this.trackIdx];
          if (!pk) continue;
          let chans; try { chans = this.adec.decode(pk); } catch (e) { trace('sound decode error: ' + e.message); continue; }
          const nch = chans.length, n = chans[0].length, pcm = new Int16Array(n * nch);
          for (let ch = 0; ch < nch; ch++) { const src = chans[ch]; for (let i = 0; i < n; i++) { const v = Math.round(src[i] * 32768); pcm[i * nch + ch] = v > 32767 ? 32767 : v < -32768 ? -32768 : v; } }
          mx.streamFeed(this.sid, pcm);
          ahead += n / s.rate;
        }
      }
      restartSound(idx) {
        if (!this.stream) return;
        m.mixer.streamClear(this.sid); this.adec.resetOverlap(); this.audioCursor = Math.max(0, idx);
      }
      /** make the decoder hold frame idx (0 based) */
      ensure(idx) {
        const f = this.file, dec = this.dec;
        if (idx === this.decodedIdx) return;
        let kf = idx; while (kf > 0 && !f.key[kf]) kf--;
        let from;
        if (this.decodedIdx >= kf && this.decodedIdx < idx) from = this.decodedIdx + 1;
        else { dec.reset(); from = kf; }
        for (let i = from; i <= idx; i++) {
          try { dec.decode(f.packet(i).video); this.decodedCount++; state.framesDecoded++; }
          catch (e) { this.readError = 1; trace('decode error in frame ' + (i + 1) + ' of ' + this.name + ': ' + e.message); }
        }
        this.decodedIdx = idx;
      }
      wait() {
        if (this.paused) return 1;
        if (this.startTime === null) return 0;
        return m.now() >= this.startTime + (this.frameNum - 1) * this.durMs ? 0 : 1;
      }
      doFrame() {
        const now = m.now(), f = this.file, idx = this.frameNum - 1;
        const first = this.startTime === null;
        if (first) this.startTime = now - idx * this.durMs;
        const late = now - (this.startTime + idx * this.durMs);
        this.ensure(idx);
        this.lastFrameNum = this.frameNum;
        m.wr32(this.ptr + 44, f.offsets[idx + 1] - f.offsets[idx]);
        this.publish();
        if (first && this.stream) this.restartSound(idx);
        this.pumpSound();
        // far behind the clock: the picture is not shown (the frame is still decoded, the next ones depend on it)
        if (late > 2.5 * this.durMs && idx < f.frames - 1 && !(this.flags & BINKNOSKIP) && !this.paused) { state.framesSkipped++; return 1; }
        return 0;
      }
      nextFrame() {
        const f = this.file;
        if (this.frameNum >= f.frames) {                       // wrap around (the program decides when a movie is over)
          this.frameNum = 1;
          if (this.startTime !== null) this.startTime += f.frames * this.durMs;
          if (this.stream) { this.adec.resetOverlap(); this.audioCursor = 0; }
        } else this.frameNum++;
        this.publish();
      }
      gotoFrame(n) {
        const f = this.file; n = Math.max(1, Math.min(f.frames, n | 0));
        if (n === this.frameNum) return;
        this.frameNum = n;
        if (this.startTime !== null) this.startTime = m.now() - (n - 1) * this.durMs;     // the clock is resynchronised: the frame is due now
        if (this.stream) this.restartSound(n - 1);
        this.publish();
      }
      pause(p) {
        p = !!p; if (p === this.paused) return;
        const now = m.now();
        if (p) { this.pauseAt = now; if (this.stream) m.mixer.remove(this.stream); }
        else { if (this.startTime !== null) this.startTime += now - this.pauseAt; if (this.stream && !this.soundOff) m.mixer.add(this.stream); }
        this.paused = p;
      }
      setSoundOnOff(on) {
        this.soundOff = !on;
        if (!this.stream) return;
        if (!on) { m.mixer.streamClear(this.sid); m.mixer.remove(this.stream); }
        else { if (!this.paused) m.mixer.add(this.stream); this.restartSound(Math.max(0, this.frameNum - 1)); }
      }
    }

    function loadFile(path) {
      const low = m.fullPath(path).toLowerCase();
      let e = files.get(low);
      if (e) { files.delete(low); files.set(low, e); return e; }
      const h = m.openRead(path); if (!h) return null;
      const bin = new Uint8Array(h.read(0, h.size));
      let file; try { file = new EMU.BinkFile(bin); } catch (err) { trace('not a Bink file: ' + path + ' (' + err.message + ')'); return null; }
      e = { bin, file }; files.set(low, e); fileBytes += bin.length;
      while (fileBytes > (48 << 20) && files.size > 1) { const k = files.keys().next().value, o = files.get(k); files.delete(k); fileBytes -= o.bin.length; }
      return e;
    }

    d('BinkSetMemory', 2, () => 1);
    d('BinkSetSoundSystem', 2, (m, open, param) => { state.soundSystem = !!open; trace('sound system set (open 0x' + (open >>> 0).toString(16) + ')'); return 1; });
    d('BinkOpenMiles', 1, () => 1);
    d('BinkSetSoundTrack', 2, (m, n, ids) => { state.soundTracks = []; for (let i = 0; i < n && i < 32; i++) state.soundTracks.push(m.rd32(ids + 4 * i) >>> 0); trace('sound tracks ' + state.soundTracks.join(',')); return 1; });
    d('BinkOpen', 2, (m, name, flags) => {
      const path = name ? m.cstr(name) : '';
      const e = loadFile(path);
      if (!e) { m.log('  [bink] open failed: ' + path); return 0; }
      const f = e.file, ptr = m.malloc(STRUCT_SIZE);
      c.u8.fill(0, ptr, ptr + STRUCT_SIZE);
      const openFlags = ((flags >>> 0) & ~BINKALPHA) | (f.hasAlpha && (flags & BINKALPHA) ? BINKALPHA : 0);
      m.wr32(ptr, f.width); m.wr32(ptr + 4, f.height); m.wr32(ptr + 8, f.frames); m.wr32(ptr + 12, 1); m.wr32(ptr + 16, 0);
      m.wr32(ptr + 20, f.fpsNum); m.wr32(ptr + 24, f.fpsDen); m.wr32(ptr + 32, openFlags); m.wr32(ptr + 36, f.flags); m.wr32(ptr + 40, f.bytes.length);
      const mv = new Movie(ptr, f, flags >>> 0, path);
      mv.dec.outputAlpha = f.hasAlpha && !!(flags & BINKALPHA);
      mv.openSound();
      movies.set(ptr, mv); state.opened++;
      trace('open ' + path + ' flags=0x' + (flags >>> 0).toString(16) + ' ' + f.width + 'x' + f.height + ' ' + f.frames + ' frames ' + (f.fpsNum / f.fpsDen).toFixed(2) + ' fps' + (f.hasAlpha ? ' alpha' : '') + (mv.stream ? ' sound' : '') + ' -> 0x' + ptr.toString(16));
      return ptr;
    });
    d('BinkClose', 1, (m, h) => {
      const mv = movies.get(h); if (!mv) return;
      trace('close ' + mv.name + ' (' + mv.decodedCount + ' frames decoded)');
      mv.closeSound(); movies.delete(h); m.free(h);
    });
    d('BinkWait', 1, (m, h) => { const mv = movies.get(h); return mv ? mv.wait() : 0; });
    d('BinkDoFrame', 1, (m, h) => { const mv = movies.get(h); return mv ? mv.doFrame() : 1; });
    d('BinkNextFrame', 1, (m, h) => { const mv = movies.get(h); if (mv) mv.nextFrame(); });
    d('BinkGoto', 3, (m, h, frame, flags) => { const mv = movies.get(h); if (mv) mv.gotoFrame(frame); });
    d('BinkPause', 2, (m, h, p) => { const mv = movies.get(h); if (!mv) return 0; mv.pause(p); return mv.paused ? 1 : 0; });
    d('BinkSetVolume', 3, (m, h, track, vol) => {
      const mv = movies.get(h); if (!mv) return 0;
      mv.volume = Math.max(0, Math.min(32768, vol >>> 0)) / 32768;
      if (mv.stream) mv.stream.gl = mv.stream.gr = mv.volume;
      return 1;
    });
    d('BinkSetSoundOnOff', 2, (m, h, on) => { const mv = movies.get(h); if (!mv) return 0; mv.setSoundOnOff(on); return 1; });
    d('BinkGetRects', 2, (m, h, flags) => {
      const mv = movies.get(h); if (!mv || !mv.lastFrameNum) return 0;
      const f = mv.file;                                        // the whole picture counts as changed
      m.wr32(h + 52, 0); m.wr32(h + 56, 0); m.wr32(h + 60, f.width); m.wr32(h + 64, f.height); m.wr32(h + 180, 1);
      return 1;
    });
    d('BinkCopyToBuffer', 7, (m, h, dest, pitch, height, x, y, flags) => {
      const mv = movies.get(h); if (!mv || !dest || mv.decodedIdx < 0) return 1;
      return mv.dec.copyToBuffer(c.u8, dest, pitch | 0, height >>> 0, x | 0, y | 0, flags & 15);
    });
  }
  EMU.installBinkw32 = install;
})(typeof globalThis !== 'undefined' ? globalThis : this);
