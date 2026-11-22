/* SMACKW32 stand-in: the video-clip library the game binds with LoadLibrary/GetProcAddress (svid.cpp).
 * The game reads the Smack and SmackBuf structs directly, so both are laid out exactly as in RAD's smack.h
 * (checked against the offsets the game's code uses: Smack+4/+8 size, +0xC frames, +0x68 NewPalette, +0x6C palette,
 * +0x374 FrameNum, +0x380..0x38C LastRect, +0x30 LargestInTrack[6]; SmackBuf+0x18 pitch, +0x448 buffer).
 * Decoding is done by smk.js (bit-exact against ffmpeg). Audio goes to the shared mixer (dsound.js).
 *
 * Behaviour notes (where the real library has choices):
 *  - the palette of a frame is made available when the frame is selected (open / NextFrame / Goto), before DoFrame,
 *    because the game applies NewPalette before it asks for the pixels;
 *  - DoFrame writes only the 4x4 blocks that changed into the destination buffer (as the real one does);
 *    the first DoFrame into a new destination writes the whole picture;
 *  - frames are never skipped; SmackWait is driven by the machine's virtual clock.
 */
(function (G) {
  'use strict';
  const EMU = G.EMU;
  const DLL = 'smackw32.dll';

  // Smack struct (smack.h)
  const S = { Version: 0, Width: 4, Height: 8, Frames: 12, MSPerFrame: 16, SmackerType: 20, LargestInTrack: 24, tablesize: 52, TrackType: 72, extra: 100,
    NewPalette: 104, Palette: 108, PalType: 880, FrameNum: 884, FrameSize: 888, SndSize: 892, LastRectx: 896, LastRecty: 900, LastRectw: 904, LastRecth: 908,
    OpenFlags: 912, LeftOfs: 916, TopOfs: 920, LargestFrameSize: 924, ReadError: 936, SIZE: 960 };
  // SmackBuf struct
  const B = { Reversed: 0, SurfaceType: 4, BlitType: 8, FullScreen: 12, Width: 16, Height: 20, Pitch: 24, Zoomed: 28, ZWidth: 32, ZHeight: 36,
    DispColors: 40, MaxPalColors: 44, PalColorsInUse: 48, StartPalColor: 52, EndPalColor: 56, Palette: 60, PalType: 0x43C, forceredraw: 0x440, didapalette: 0x444, Buffer: 0x448, SIZE: 0x4C0 };

  const F_FILEHANDLE = 0x1000, F_TRACK1 = 0x2000, F_NEEDPAN = 0x20, F_NEEDVOLUME = 0x40;

  function install(m) {
    const c = m.cpu;
    const SMK = G.SMK || (typeof require !== 'undefined' ? require('./smk.js') : null);
    if (!SMK) throw new Error('smack.js needs smk.js');
    const trace = s => { if (m.opts.traceSmack || m.opts.traceFiles) m.log('  [smk] ' + s); };
    const d = (name, n, fn) => m.def(DLL, name, n, fn);
    const clips = new Map();        // Smack* -> state
    const bufs = new Map();         // SmackBuf* -> {own}
    let nextAudioId = 1;

    /** total size of a Smacker file starting at the file object's position */
    function smkLength(f, pos) {
      const h = f.read(pos, 104);
      if (h.length < 104) throw new Error('smack: short file');
      const dv = new DataView(h.buffer, h.byteOffset, h.byteLength);
      const sig = String.fromCharCode(h[0], h[1], h[2], h[3]);
      if (sig !== 'SMK2' && sig !== 'SMK4') throw new Error('smack: not a Smacker file (' + sig + ')');
      const nf = dv.getUint32(12, true) + ((dv.getUint32(20, true) & 1) ? 1 : 0), tree = dv.getUint32(52, true);
      const t = f.read(pos + 104, nf * 4), tv = new DataView(t.buffer, t.byteOffset, t.byteLength);
      let total = 104 + nf * 5 + tree;
      for (let i = 0; i < nf; i++) total += tv.getUint32(i * 4, true) & ~3;
      return total;
    }

    function openBytes(src, flags) {
      if (flags & F_FILEHANDLE) {
        const o = m.getHandle(src);
        if (!o || o.type !== 'file' || !o.f) return null;
        const total = Math.min(smkLength(o.f, o.pos), o.f.size - o.pos);
        const bytes = new Uint8Array(o.f.read(o.pos, total));
        trace('open handle 0x' + (src >>> 0).toString(16) + ' at ' + o.pos + ', ' + bytes.length + ' bytes');
        o.pos += total;
        return bytes;
      }
      const path = m.cstr(src), f = m.openRead(path);
      if (!f) { trace('open FAIL ' + path); return null; }
      trace('open ' + path);
      return new Uint8Array(f.read(0, f.size));
    }

    const frameTime = st => st.dec.frameMs;

    /** make frame n current: seek the decoder, publish its palette */
    function selectFrame(st, n, forcePal) {
      const dec = st.dec;
      const hasPal = dec.beginFrame(n);
      st.frameNum = n;
      m.wr32(st.ptr + S.FrameNum, n);
      if (hasPal || forcePal) {
        c.u8.set(dec.palette, st.ptr + S.Palette);
        m.wr32(st.ptr + S.NewPalette, 1);
      } else m.wr32(st.ptr + S.NewPalette, 0);
      m.wr32(st.ptr + S.FrameSize, dec.frameSize[n] || 0);
    }

    d('_SmackOpen@12', 3, (m, src, flags, extra) => {
      let bytes;
      try { bytes = openBytes(src, flags); } catch (e) { trace('open error: ' + e.message); return 0; }
      if (!bytes) return 0;
      let dec;
      try { dec = new SMK.SmkDecoder(bytes); } catch (e) { trace('open error: ' + e.message); return 0; }
      const ptr = m.malloc(S.SIZE, true);
      const hdr = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      const ring = (hdr.getUint32(20, true) & 1) !== 0;
      const st = { ptr, dec, bytes, flags, ring, frames: dec.frames - (ring ? 1 : 0), frameNum: 0, t0: null, soundOn: true, dest: null, lastBuf: 0,
        audioId: 0, rect: null, tracks: flags & 0xFE000, vol: 32768, pan: 32768, hdr };
      m.wr32(ptr + S.Version, hdr.getUint32(0, true)); m.wr32(ptr + S.Width, dec.width); m.wr32(ptr + S.Height, dec.height);
      m.wr32(ptr + S.Frames, st.frames); m.wr32(ptr + S.MSPerFrame, Math.round(dec.frameMs)); m.wr32(ptr + S.SmackerType, hdr.getUint32(20, true));
      for (let i = 0; i < 7; i++) { m.wr32(ptr + S.LargestInTrack + 4 * i, dec.audioMax[i]); m.wr32(ptr + S.TrackType + 4 * i, hdr.getUint32(72 + 4 * i, true)); }
      m.wr32(ptr + S.tablesize, dec.treeSize);
      m.wr32(ptr + S.OpenFlags, flags);
      m.wr32(ptr + S.LargestFrameSize, Math.max(...dec.frameSize));
      clips.set(ptr, st);
      selectFrame(st, 0, true);
      trace('SmackOpen ' + dec.width + 'x' + dec.height + ' frames=' + st.frames + ' ms=' + dec.frameMs.toFixed(2) + ' flags=0x' + flags.toString(16) + ' -> 0x' + ptr.toString(16));
      return ptr;
    });

    d('_SmackClose@4', 1, (m, ptr) => {
      const st = clips.get(ptr); if (!st) return 0;
      if (st.audioId && m.mixer) m.mixer.streamClose(st.audioId);
      clips.delete(ptr); m.free(ptr);
      trace('SmackClose 0x' + ptr.toString(16));
      return 0;
    });

    d('_SmackToBuffer@28', 7, (m, ptr, left, top, pitch, height, buf, flags) => {
      const st = clips.get(ptr); if (!st) return 0;
      st.dest = { left: left | 0, top: top | 0, pitch: pitch | 0, height, buf, flags };
      m.wr32(ptr + S.LeftOfs, left); m.wr32(ptr + S.TopOfs, top);
      return 0;
    });

    function audioFeed(st, fn) {
      if (!m.mixer || !st.soundOn || !st.tracks) return;
      const dec = st.dec;
      for (let t = 0; t < 7; t++) {
        if (!(st.tracks & (F_TRACK1 << t))) continue;
        if (!(dec.audioFlags[t] & 0x40)) continue;          // track not present (e.g. the hit-mask track has flags 0)
        const ch = dec.frameTrack(fn, t); if (!ch) continue;
        let pcm = null;
        if (dec.audioFlags[t] & 0x80) { const r = dec._decodeAudioChunk(ch); if (r) pcm = { rate: dec.audioRate[t], channels: r.stereo ? 2 : 1, bits: r.bits16 ? 16 : 8, data: r.data }; }
        else { const raw = dec.u8.subarray(ch.start, ch.end); pcm = { rate: dec.audioRate[t], channels: (dec.audioFlags[t] & 0x10) ? 2 : 1, bits: (dec.audioFlags[t] & 0x20) ? 16 : 8, data: (dec.audioFlags[t] & 0x20) ? new Int16Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + (raw.length & ~1))) : raw.slice() }; }
        if (!pcm) continue;
        if (!st.audioId) {
          st.audioId = nextAudioId++;
          m.mixer.streamOpen(st.audioId, pcm.rate, pcm.channels, pcm.bits);
          m.mixer.streamGain(st.audioId, (st.flags & F_NEEDVOLUME) ? st.vol / 65536 : 1, (st.flags & F_NEEDPAN) ? (st.pan - 32768) / 32768 : 0);
        }
        m.mixer.streamFeed(st.audioId, pcm.data, st.t0 + fn * frameTime(st));   // (the sound of picture `fn` belongs to its time slot)
      }
    }

    d('_SmackDoFrame@4', 1, (m, ptr) => {
      const st = clips.get(ptr); if (!st) return 0;
      const dec = st.dec, fn = st.frameNum;
      if (st.t0 === null) st.t0 = m.now();
      dec.finishFrame(fn);
      const W = dec.width, H = dec.height, bw = W >> 2, bh = H >> 2, px = dec.pixels, dirty = dec.dirty;
      const dst = st.dest;
      const full = !dst || dst.buf !== st.lastBuf || st.needFull || fn === 0 && !st.drawn;
      let x0 = bw, y0 = bh, x1 = -1, y1 = -1;
      for (let by = 0; by < bh; by++) {
        for (let bx = 0; bx < bw; bx++) {
          if (!dirty[by * bw + bx] && !full) continue;
          if (bx < x0) x0 = bx; if (bx > x1) x1 = bx; if (by < y0) y0 = by; if (by > y1) y1 = by;
        }
      }
      if (dst && dst.buf) {
        const u8 = c.u8;
        if (full) {
          for (let y = 0; y < H; y++) {
            const dy = dst.top + y; if (dy < 0) continue;
            u8.set(px.subarray(y * W, y * W + W), dst.buf + dy * dst.pitch + dst.left);
          }
        } else {
          for (let by = 0; by < bh; by++) {
            let bx = 0;
            while (bx < bw) {
              if (!dirty[by * bw + bx]) { bx++; continue; }
              let e = bx + 1;
              while (e < bw && dirty[by * bw + e]) e++;
              for (let r = 0; r < 4; r++) {
                const y = by * 4 + r, so = y * W + bx * 4, dy = dst.top + y; if (dy < 0) continue;
                u8.set(px.subarray(so, so + (e - bx) * 4), dst.buf + dy * dst.pitch + dst.left + bx * 4);
              }
              bx = e;
            }
          }
        }
        st.lastBuf = dst.buf; st.needFull = false; st.drawn = true;
      }
      st.rect = x1 >= x0 ? { x: x0 * 4, y: y0 * 4, w: (x1 - x0 + 1) * 4, h: (y1 - y0 + 1) * 4 } : null;
      audioFeed(st, fn);
      return 0;
    });

    d('_SmackToBufferRect@8', 2, (m, ptr, surf) => {
      const st = clips.get(ptr); if (!st) return 0;
      const r = st.rect;
      if (!r) { m.wr32(ptr + S.LastRectx, 0); m.wr32(ptr + S.LastRecty, 0); m.wr32(ptr + S.LastRectw, 0); m.wr32(ptr + S.LastRecth, 0); return 0; }
      const ox = st.dest ? st.dest.left : 0, oy = st.dest ? st.dest.top : 0;
      m.wr32(ptr + S.LastRectx, r.x + ox); m.wr32(ptr + S.LastRecty, r.y + oy); m.wr32(ptr + S.LastRectw, r.w); m.wr32(ptr + S.LastRecth, r.h);
      st.rect = null;       // a rectangle is reported once
      return 1;
    });

    d('_SmackNextFrame@4', 1, (m, ptr) => {
      const st = clips.get(ptr); if (!st) return 0;
      let n = st.frameNum + 1;
      if (n >= st.frames) { n = 0; if (st.t0 !== null) st.t0 = m.now(); if (m.mixer && st.audioId) m.mixer.streamClear(st.audioId); st.needFull = true; }
      selectFrame(st, n, n === 0);
      return 0;
    });

    d('_SmackGoto@8', 2, (m, ptr, n) => {
      const st = clips.get(ptr); if (!st) return 0;
      n = Math.max(0, Math.min(n >>> 0, st.frames - 1));
      if (st.t0 !== null) st.t0 = m.now() - n * frameTime(st);
      if (m.mixer && st.audioId) m.mixer.streamClear(st.audioId);
      st.needFull = true;
      selectFrame(st, n, true);
      return 0;
    });

    d('_SmackWait@4', 1, (m, ptr) => {
      const st = clips.get(ptr); if (!st) return 0;
      if (st.t0 === null) return 0;
      return (m.now() - st.t0 >= st.frameNum * frameTime(st)) ? 0 : 1;
    });

    d('_SmackSoundOnOff@8', 2, (m, ptr, on) => {
      const st = clips.get(ptr); if (!st) return 0;
      st.soundOn = !!on;
      if (!on && m.mixer && st.audioId) m.mixer.streamClear(st.audioId);
      return 0;
    });
    d('_SmackVolumePan@16', 4, (m, ptr, trackFlags, vol, pan) => {
      const st = clips.get(ptr); if (!st) return 0;
      st.vol = vol; st.pan = pan;
      if (m.mixer && st.audioId) m.mixer.streamGain(st.audioId, (st.flags & F_NEEDVOLUME) ? vol / 65536 : 1, (st.flags & F_NEEDPAN) ? (pan - 32768) / 32768 : 0);
      return 0;
    });
    d('_SmackSoundUseDirectSound@4', 1, () => 1);
    d('_SmackSoundUseMSS@4', 1, () => 1);     // sound goes to the shared mixer whichever driver the game names
    d('_SmackUseMMX@4', 1, () => 0);          // 0 = off; the decoder is plain script code
    d('_SmackSetMemory@8', 2, () => 0);       // the game offers its own allocator; the stand-in keeps using the machine's heap

    d('_SmackGetTrackData@12', 3, (m, ptr, dest, trackFlag) => {
      const st = clips.get(ptr); if (!st) return 0;
      let t = -1; for (let i = 0; i < 7; i++) if (trackFlag & (F_TRACK1 << i)) { t = i; break; }
      if (t < 0) return 0;
      const ch = st.dec.frameTrack(st.frameNum, t); if (!ch) return 0;
      if (st.dec.audioFlags[t] & 0x80) {
        const r = st.dec._decodeAudioChunk(ch); if (!r) return 0;
        const bytes = new Uint8Array(r.data.buffer, r.data.byteOffset, r.data.byteLength);
        c.u8.set(bytes, dest); return bytes.length;
      }
      c.u8.set(st.dec.u8.subarray(ch.start, ch.end), dest);
      return ch.end - ch.start;
    });

    // ---------------------------------------------------------------- SmackBuf
    d('_SmackBufferOpen@24', 6, (m, hwnd, blitType, w, h, zw, zh) => {
      const p = m.malloc(B.SIZE, true);
      const pitch = (w + 3) & ~3;
      const psize = Math.max(pitch * Math.max(h, 1), 4096), pix = m.valloc(psize);
      m.wr32(p + B.BlitType, blitType); m.wr32(p + B.Width, w); m.wr32(p + B.Height, h); m.wr32(p + B.Pitch, pitch);
      m.wr32(p + B.Zoomed, (zw && (zw !== w || zh !== h)) ? 1 : 0); m.wr32(p + B.ZWidth, zw || w); m.wr32(p + B.ZHeight, zh || h);
      m.wr32(p + B.DispColors, 256); m.wr32(p + B.MaxPalColors, 256); m.wr32(p + B.PalColorsInUse, 256); m.wr32(p + B.StartPalColor, 0); m.wr32(p + B.EndPalColor, 255);
      m.wr32(p + B.Buffer, pix);
      bufs.set(p, { pix, psize });
      return p;
    });
    d('_SmackBufferClose@4', 1, (m, p) => {
      const b = bufs.get(p); if (!b) return 0;
      m.vfree(b.pix, b.psize); bufs.delete(p); m.free(p);
      return 0;
    });
    d('_SmackBufferNewPalette@12', 3, (m, p, pal, palType) => {
      if (!p || !pal) return 0;
      for (let i = 0; i < 256; i++) {
        c.u8[p + B.Palette + i * 4] = c.u8[pal + i * 3 + 2]; c.u8[p + B.Palette + i * 4 + 1] = c.u8[pal + i * 3 + 1];
        c.u8[p + B.Palette + i * 4 + 2] = c.u8[pal + i * 3]; c.u8[p + B.Palette + i * 4 + 3] = 0;
      }
      m.wr32(p + B.didapalette, 0);
      return 0;
    });
    d('_SmackBufferToBufferTrans@36', 9, (m, dstb, dx, dy, srcb, sx, sy, sw, sh, trans) => {
      const dBuf = m.rd32(dstb + B.Buffer), dPitch = m.rd32(dstb + B.Pitch), dW = m.rd32(dstb + B.Width), dH = m.rd32(dstb + B.Height);
      const sBuf = m.rd32(srcb + B.Buffer), sPitch = m.rd32(srcb + B.Pitch), sW = m.rd32(srcb + B.Width), sH = m.rd32(srcb + B.Height);
      dx |= 0; dy |= 0; sx |= 0; sy |= 0; sw |= 0; sh |= 0;
      if (dx < 0) { sx -= dx; sw += dx; dx = 0; }
      if (dy < 0) { sy -= dy; sh += dy; dy = 0; }
      if (sx < 0) { dx -= sx; sw += sx; sx = 0; }
      if (sy < 0) { dy -= sy; sh += sy; sy = 0; }
      if (dW) sw = Math.min(sw, dW - dx); if (sW) sw = Math.min(sw, sW - sx);
      if (dH) sh = Math.min(sh, dH - dy); if (sH) sh = Math.min(sh, sH - sy);
      if (sw <= 0 || sh <= 0 || !dBuf || !sBuf) return 0;
      const u8 = c.u8, key = trans & 255;
      for (let y = 0; y < sh; y++) {
        let so = sBuf + (sy + y) * sPitch + sx, dof = dBuf + (dy + y) * dPitch + dx;
        for (let x = 0; x < sw; x++, so++, dof++) { const v = u8[so]; if (v !== key) u8[dof] = v; }
      }
      return 0;
    });

    m.smack = { clips, bufs };
  }
  EMU.installSmack = install;
})(typeof globalThis !== 'undefined' ? globalThis : this);
