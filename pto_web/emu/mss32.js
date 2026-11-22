/* Miles Sound System (mss32.dll) stand-in: the digital-audio calls the Disney Playhouse client makes.
 * Sounds are WAV images handed over in guest memory (AIL_set_named_sample_file); they are decoded here (PCM / IMA ADPCM / MS ADPCM)
 * and played by the shared software mixer from dsound.js.
 */
(function (G) {
  'use strict';
  const EMU = G.EMU;
  const MSS = 'mss32.dll';
  const SMP_FREE = 1, SMP_DONE = 2, SMP_PLAYING = 4, SMP_STOPPED = 8;
  const _f = new Float32Array(1), _i = new Int32Array(_f.buffer);
  const f32 = v => { _i[0] = v; return _f[0]; };

  class MilesSample {
    constructor(m, handle) {
      this.m = m; this.handle = handle; this.status = SMP_DONE; this.pcm = null; this.dec = null; this.ch = 1; this.frames = 0; this.fileRate = 22050; this.rate = 22050;
      this.pos = 0; this.loops = 1; this.loopsLeft = 1; this.gl = 1; this.gr = 1; this.name = '';
    }
    play() { this.pos = 0; this.loopsLeft = this.loops; this.status = SMP_PLAYING; this.m.mixer.add(this); }
    stop() { this.m.mixer.remove(this); }
    mix(out, n, outRate) {
      if (this.status !== SMP_PLAYING || !this.pcm) { this.m.mixer.remove(this); return; }
      const frames = this.frames, step = this.rate / outRate, inf = this.loops === 0;
      let pos = this.pos;
      if (!out) {
        pos += n * step;
        while (pos >= frames) {
          if (inf || this.loopsLeft > 1) { pos -= frames; if (!inf) this.loopsLeft--; if (frames === 0) { pos = 0; break; } }
          else { this.status = SMP_DONE; this.m.mixer.remove(this); pos = frames; break; }
        }
        this.pos = pos; return;
      }
      if (this.dec) this.dec.ensure(Math.ceil(pos + n * step) + 4);       // MP3: decode what is about to be heard
      const pcm = this.pcm, ch = this.ch, g = this.m.milesMaster, gl = this.gl * g / 32768, gr = this.gr * g / 32768;
      for (let i = 0; i < n; i++) {
        if (pos >= frames) {
          if (inf || this.loopsLeft > 1) { pos -= frames; if (!inf) this.loopsLeft--; if (pos >= frames) pos = 0; }
          else { this.status = SMP_DONE; this.m.mixer.remove(this); pos = frames; break; }
        }
        const i0 = pos | 0, fr = pos - i0, i1 = i0 + 1 < frames ? i0 + 1 : i0;
        if (ch === 1) { const a = pcm[i0], v = a + (pcm[i1] - a) * fr; out[2 * i] += v * gl; out[2 * i + 1] += v * gr; }
        else { const a = pcm[2 * i0], b = pcm[2 * i0 + 1]; out[2 * i] += (a + (pcm[2 * i1] - a) * fr) * gl; out[2 * i + 1] += (b + (pcm[2 * i1 + 1] - b) * fr) * gr; }
        pos += step;
      }
      this.pos = pos;
    }
  }

  function install(m) {
    const c = m.cpu;
    const trace = s => { if (m.opts.traceMiles || m.opts.traceFiles) m.log('  [mss] ' + s); };
    const d = (name, n, fn) => m.def(MSS, '_AIL_' + name + '@' + n * 4, n, fn);
    const samples = new Map(), drivers = new Map(), prefs = new Map();
    m.milesMaster = 1; m.miles = { samples, drivers, redist: '' };
    let lastErr = 'No error', errStr = 0;
    const setErrStr = s => { lastErr = s; errStr = m.scratchStr(s.substr(0, 126)); };
    errStr = m.scratchStr(lastErr);
    const sync = () => m.mixer.sync(m.now());
    const retFloat = v => { c.fpush(v); };

    d('startup', 0, () => 1);
    d('shutdown', 0, () => 0);
    d('set_preference', 2, (m, num, val) => { const old = prefs.get(num) | 0; prefs.set(num, val); return old; });
    d('last_error', 0, () => errStr);
    d('set_error', 1, (m, p) => { setErrStr(p ? m.cstr(p) : ''); });
    d('set_redist_directory', 1, (m, p) => { m.miles.redist = p ? m.cstr(p) : ''; trace('redist dir ' + m.miles.redist); return p; });
    d('open_digital_driver', 4, (m, freq, bits, ch, flags) => {
      const p = m.malloc(512); drivers.set(p, { p, freq, bits, ch, master: 1 });
      trace('open_digital_driver ' + freq + ' Hz ' + bits + ' bit ' + ch + ' ch -> 0x' + p.toString(16));
      return p;
    });
    d('close_digital_driver', 1, (m, p) => { drivers.delete(p); return 0; });
    d('digital_handle_release', 1, () => 1);
    d('digital_handle_reacquire', 1, () => 1);
    d('digital_master_volume_level', 1, (m) => { retFloat(m.milesMaster); });
    d('set_digital_master_volume_level', 2, (m, dr, v) => { m.milesMaster = Math.max(0, f32(v)); });

    d('allocate_sample_handle', 1, (m, dr) => {
      const p = m.malloc(256), s = new MilesSample(m, p); samples.set(p, s);
      s.status = SMP_DONE;
      return p;
    });
    d('release_sample_handle', 1, (m, p) => { const s = samples.get(p); if (s) { s.stop(); samples.delete(p); m.free(p); } });
    d('set_named_sample_file', 5, (m, S, name, image, size, block) => {
      const s = samples.get(S); if (!s) { setErrStr('Invalid sample handle'); return 0; }
      const nm = name ? m.cstr(name) : '';
      s.stop(); s.pcm = null; s.dec = null;
      const bytes = c.u8.subarray(image, image + size);
      let dec = null;
      if (bytes[0] === 0x52 && bytes[1] === 0x49) dec = EMU.wavDecode(bytes);
      else if (EMU.mp3Decode) dec = EMU.mp3Decode(bytes.slice());           // sound is made as it plays; the file image may be reused by the game
      if (!dec) { setErrStr('Invalid or unsupported sound file'); trace('set_named_sample_file ' + nm + ' (' + size + ' bytes): not decodable'); return 0; }
      s.pcm = dec.pcm; s.dec = dec.ensure ? dec : null; s.ch = dec.ch; s.frames = dec.frames; s.fileRate = s.rate = dec.rate; s.name = nm; s.pos = 0; s.status = SMP_DONE; s.loops = 1;
      trace('sample 0x' + S.toString(16) + ' <- ' + nm + ' ' + dec.rate + ' Hz ' + dec.ch + ' ch ' + dec.frames + ' frames');
      return 1;
    });
    d('start_sample', 1, (m, S) => { const s = samples.get(S); if (!s || !s.pcm) return; sync(); s.play(); trace('start 0x' + S.toString(16) + ' ' + s.name); });
    d('stop_sample', 1, (m, S) => { const s = samples.get(S); if (!s) return; sync(); if (s.status === SMP_PLAYING) { s.status = SMP_STOPPED; s.stop(); } });
    d('resume_sample', 1, (m, S) => { const s = samples.get(S); if (!s || !s.pcm) return; sync(); if (s.status === SMP_STOPPED) { s.status = SMP_PLAYING; m.mixer.add(s); } });
    d('sample_status', 1, (m, S) => { const s = samples.get(S); if (!s) return SMP_FREE; sync(); return s.status; });
    d('set_sample_loop_count', 2, (m, S, n) => { const s = samples.get(S); if (s) { s.loops = n | 0; s.loopsLeft = s.loops; } });
    d('set_sample_playback_rate', 2, (m, S, r) => { const s = samples.get(S); if (s && r > 0) s.rate = r; });
    d('sample_playback_rate', 1, (m, S) => { const s = samples.get(S); return s ? Math.round(s.rate) : 0; });
    d('set_sample_volume_levels', 3, (m, S, l, r) => { const s = samples.get(S); if (s) { s.gl = Math.max(0, f32(l)); s.gr = Math.max(0, f32(r)); } });

    // ---------------------------------------------------------------- WAV helpers
    d('WAV_info', 2, (m, data, info) => {
      if (!data || c.u8[data] !== 0x52 || c.u8[data + 1] !== 0x49) return 0;
      const riff = Math.min(m.rd32(data + 4) + 8, 64 * 1024 * 1024);
      const w = EMU.wavInfo(c.u8.subarray(data, data + riff));
      if (!w) return 0;
      m.wr32(info, w.format); m.wr32(info + 4, data + w.dataOff); m.wr32(info + 8, w.dataLen); m.wr32(info + 12, w.rate); m.wr32(info + 16, w.bits);
      m.wr32(info + 20, w.ch); m.wr32(info + 24, w.samples); m.wr32(info + 28, w.blockAlign); m.wr32(info + 32, 0);
      return 1;
    });
    d('decompress_ADPCM', 3, (m, info, pOut, pSize) => {
      const format = m.rd32(info), dptr = m.rd32(info + 4), dlen = m.rd32(info + 8), rate = m.rd32(info + 12), bits = m.rd32(info + 16), ch = m.rd32(info + 20), samp = m.rd32(info + 24), blk = m.rd32(info + 28);
      let pcm;
      const winfo = { format, ch, rate, bits, blockAlign: blk, dataOff: dptr, dataLen: dlen, samples: samp, samplesPerBlock: format === 0x11 ? (blk - 4 * ch) * 8 / (4 * ch) + 1 : (blk - 7 * ch) * 2 / ch + 2 };
      if (format === 0x11) pcm = EMU.wavDecodeRaw(c.u8, winfo); else if (format === 2) pcm = EMU.wavDecodeRaw(c.u8, winfo); else { setErrStr('Unsupported ADPCM format'); return 0; }
      const img = EMU.wavBuild(rate, ch, pcm), p = m.malloc(img.length);
      c.u8.set(img, p); m.wr32(pOut, p); m.wr32(pSize, img.length);
      trace('decompress_ADPCM ' + dlen + ' bytes -> ' + img.length);
      return 1;
    });
    d('compress_ADPCM', 3, () => { setErrStr('ADPCM compression is not available'); m.log('  [mss] AIL_compress_ADPCM called (not supported)'); return 0; });
    d('mem_free_lock', 1, (m, p) => { if (p) m.free(p); });
  }
  EMU.installMss32 = install;
})(typeof globalThis !== 'undefined' ? globalThis : this);
