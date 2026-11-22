/* GDI32 stand-ins, part B: DIB sections, BitBlt / StretchDIBits to the program's window, fonts and palettes.
 *
 * The Disney Playhouse engine (without DirectDraw) draws into a DIB section (CreateDIBSection) and copies it to its
 * window with BitBlt. The window is the screen: m.video.rgba holds what is shown (RGBA, client area of the main window).
 */
(function (G) {
  'use strict';
  const EMU = G.EMU;
  const GD = 'GDI32.dll';

  function install(m) {
    const d = (name, n, fn) => m.def(GD, name, n, fn);
    const c = m.cpu;
    const trace = s => { if (m.opts.traceFiles) m.log('  [gdi] ' + s); };
    const video = m.video = m.video || {};
    Object.assign(video, { width: 800, height: 600, rgba: new Uint8ClampedArray(800 * 600 * 4), dirty: false, frames: 0, blits: 0 });
    for (let i = 3; i < video.rgba.length; i += 4) video.rgba[i] = 255;
    /** (re)size the screen buffer: called when the main window gets its size */
    m.setScreenSize = (w, h) => {
      if (w === video.width && h === video.height) return;
      video.width = w; video.height = h; video.rgba = new Uint8ClampedArray(w * h * 4);
      for (let i = 3; i < video.rgba.length; i += 4) video.rgba[i] = 255;
    };
    m.getFrameRGBA = (out) => {
      if (!out || out.length !== video.rgba.length) out = new Uint8ClampedArray(video.rgba.length);
      out.set(video.rgba); video.dirty = false; return out;
    };

    const getObj = h => m.getHandle(h);
    const dcOf = h => { const o = m.getHandle(h); return o && o.type === 'dc' ? o : null; };

    // ---------------------------------------------------------------- pixel formats of DIBs
    /** describes a BITMAPINFO in guest memory: {w, h, bpp, comp, top, stride, pal(Uint8Array 256*4 BGRA|null), masks} */
    function readBmi(pbmi) {
      const size = m.rd32(pbmi), W = m.rd32(pbmi + 4) | 0, Hraw = m.rd32(pbmi + 8) | 0, bpp = c.u16[(pbmi + 14) >> 1], comp = m.rd32(pbmi + 16);
      const used = m.rd32(pbmi + 32);
      const o = { w: W, h: Math.abs(Hraw), top: Hraw < 0, bpp, comp, size, stride: (((W * bpp + 31) >> 5) << 2), pal: null, masks: null };
      let p = pbmi + size;
      if (comp === 3) { o.masks = [m.rd32(p) >>> 0, m.rd32(p + 4) >>> 0, m.rd32(p + 8) >>> 0]; p += 12; }
      if (bpp <= 8) {
        const n = used || (1 << bpp);
        o.pal = new Uint8Array(256 * 4); for (let i = 0; i < Math.min(n, 256); i++) { o.pal[i * 4] = c.u8[p + i * 4]; o.pal[i * 4 + 1] = c.u8[p + i * 4 + 1]; o.pal[i * 4 + 2] = c.u8[p + i * 4 + 2]; }
      }
      if (bpp === 16 && !o.masks) o.masks = [0x7C00, 0x03E0, 0x001F];
      return o;
    }
    /** convert rows of a DIB (bits at guest address `bits`) into RGBA, writing into dst (w*h*4) */
    function dibToRGBA(bits, f, sx, sy, w, h, dst, dstStride, dx, dy) {
      const U = c.u8;
      for (let y = 0; y < h; y++) {
        const srcRow = sy + y;
        const fileRow = f.top ? srcRow : f.h - 1 - srcRow;
        let q = bits + fileRow * f.stride;
        let o = ((dy + y) * dstStride + dx) * 4;
        if (f.bpp === 32) {
          q += sx * 4;
          for (let x = 0; x < w; x++, q += 4, o += 4) { dst[o] = U[q + 2]; dst[o + 1] = U[q + 1]; dst[o + 2] = U[q]; dst[o + 3] = 255; }
        } else if (f.bpp === 24) {
          q += sx * 3;
          for (let x = 0; x < w; x++, q += 3, o += 4) { dst[o] = U[q + 2]; dst[o + 1] = U[q + 1]; dst[o + 2] = U[q]; dst[o + 3] = 255; }
        } else if (f.bpp === 16) {
          q += sx * 2;
          const [rm, gm, bm] = f.masks, is565 = gm === 0x07E0;
          for (let x = 0; x < w; x++, q += 2, o += 4) {
            const v = U[q] | (U[q + 1] << 8);
            if (is565) { const r = (v >> 11) & 31, g = (v >> 5) & 63, b = v & 31; dst[o] = (r << 3) | (r >> 2); dst[o + 1] = (g << 2) | (g >> 4); dst[o + 2] = (b << 3) | (b >> 2); }
            else { const r = (v >> 10) & 31, g = (v >> 5) & 31, b = v & 31; dst[o] = (r << 3) | (r >> 2); dst[o + 1] = (g << 3) | (g >> 2); dst[o + 2] = (b << 3) | (b >> 2); }
            dst[o + 3] = 255;
          }
        } else if (f.bpp === 8) {
          q += sx; const P = f.pal;
          for (let x = 0; x < w; x++, q++, o += 4) { const i = U[q] * 4; dst[o] = P[i + 2]; dst[o + 1] = P[i + 1]; dst[o + 2] = P[i]; dst[o + 3] = 255; }
        } else if (f.bpp === 4) {
          const P = f.pal;
          for (let x = 0; x < w; x++, o += 4) { const px = sx + x, b = U[q + (px >> 1)], i = ((px & 1) ? b & 15 : b >> 4) * 4; dst[o] = P[i + 2]; dst[o + 1] = P[i + 1]; dst[o + 2] = P[i]; dst[o + 3] = 255; }
        } else if (f.bpp === 1) {
          const P = f.pal;
          for (let x = 0; x < w; x++, o += 4) { const px = sx + x, v = (U[q + (px >> 3)] >> (7 - (px & 7))) & 1, i = v * 4; dst[o] = P[i + 2]; dst[o + 1] = P[i + 1]; dst[o + 2] = P[i]; dst[o + 3] = 255; }
        }
      }
    }

    // ---------------------------------------------------------------- CreateDIBSection and friends
    d('CreateDIBSection', 6, (m, hdc, pbmi, usage, ppBits, section, offset) => {
      const f = readBmi(pbmi);
      if (!f.w || !f.h || ![1, 4, 8, 16, 24, 32].includes(f.bpp)) { m.lastError = 87; return 0; }
      const bytes = f.stride * f.h;
      const bits = m.valloc(bytes + 64);
      const bmp = { type: 'bitmap', dib: true, w: f.w, h: f.h, bpp: f.bpp, bits, fmt: f, rgb: null };
      if (ppBits) m.wr32(ppBits, bits);
      const h = m.newHandle(bmp);
      trace('CreateDIBSection ' + f.w + 'x' + f.h + 'x' + f.bpp + (f.top ? ' top-down' : '') + ' bits=0x' + bits.toString(16) + ' -> 0x' + h.toString(16));
      return h;
    });
    d('GetObjectA', 3, (m, h, size, p) => {
      const o = getObj(h);
      if (!o) return 0;
      if (o.type === 'bitmap') {
        if (size < 24) return 0;
        const bpp = o.bpp || 24, stride = (((o.w * bpp + 31) >> 5) << 2);
        m.wr32(p, 0); m.wr32(p + 4, o.w); m.wr32(p + 8, o.h); m.wr32(p + 12, stride); c.u16[(p + 16) >> 1] = 1; c.u16[(p + 18) >> 1] = bpp; m.wr32(p + 20, o.dib ? o.bits : 0);
        return 24;
      }
      if (o.type === 'palette') { if (size >= 2) c.u16[p >> 1] = o.entries.length >> 2; return 2; }
      if (o.type === 'font') {
        if (size < 60) return 0;
        m.zero(p, 60); m.wr32(p, o.height | 0); m.wr32(p + 4, o.width | 0); m.wr32(p + 16, o.weight | 0); c.u8[p + 20] = o.italic ? 1 : 0; c.u8[p + 23] = 1; m.putStr(p + 28, (o.face || '').substr(0, 31));
        return 60;
      }
      return 0;
    });
    d('CreateFontIndirectA', 1, (m, p) => {
      const f = { type: 'font', height: m.rd32(p) | 0, width: m.rd32(p + 4) | 0, weight: m.rd32(p + 16) | 0, italic: !!c.u8[p + 20], face: m.cstr(p + 28, 32) };
      trace('CreateFontIndirect ' + f.face + ' h=' + f.height);
      return m.newHandle(f);
    });
    d('SetStretchBltMode', 2, () => 3);
    d('GetCharABCWidthsA', 4, (m, h, first, last, p) => {
      const x = dcOf(h), f = (x && x.font) || { height: -11, weight: 400 };
      for (let ch = first; ch <= last; ch++) {
        const w = m.textBackend.measure(f, String.fromCharCode(ch));
        const o = p + (ch - first) * 12; m.wr32(o, 0); m.wr32(o + 4, w); m.wr32(o + 8, 0);
      }
      return 1;
    });
    d('TextOutA', 5, (m, h, X, Y, s, n) => {
      const x = dcOf(h); if (!x) return 0;
      const str = m.cstr(s, 4096).substr(0, n);
      if (x.bitmap && x.bitmap.dib) { /* text into DIB sections is not drawn (the engine uses its own fonts) */ return 1; }
      return 1;
    });
    d('GetPaletteEntries', 4, (m, h, start, n, p) => {
      const o = getObj(h); if (!o || !o.entries) return 0;
      const k = Math.min(n, (o.entries.length >> 2) - start); if (k <= 0) return 0;
      if (p) c.u8.set(o.entries.subarray(start * 4, (start + k) * 4), p);
      return k;
    });
    d('GetNearestPaletteIndex', 2, (m, h, col) => {
      const o = getObj(h); if (!o || !o.entries) return -1;
      const r = col & 255, g = (col >> 8) & 255, b = (col >> 16) & 255; let best = 0, bd = 1e9;
      for (let i = 0; i < o.entries.length >> 2; i++) { const dr = o.entries[i * 4] - r, dg = o.entries[i * 4 + 1] - g, db = o.entries[i * 4 + 2] - b, dd = dr * dr + dg * dg + db * db; if (dd < bd) { bd = dd; best = i; } }
      return best;
    });
    d('AnimatePalette', 4, () => 1);

    const origCaps = m.apis.get('gdi32.dll!GetDeviceCaps');
    d('GetDeviceCaps', 2, (m, h, i) => {
      const x = dcOf(h);
      if (x && x.printer && origCaps) return origCaps.fn(m, h, i);
      switch (i) {
        case 2: return 1;                          // TECHNOLOGY: raster
        case 4: return Math.round(m.screenW * 25.4 / 96); case 6: return Math.round(m.screenH * 25.4 / 96);
        case 8: return m.screenW; case 10: return m.screenH;
        case 12: return 32; case 14: return 1;     // BITSPIXEL, PLANES
        case 24: return -1;                        // NUMCOLORS
        case 36: return 0; case 38: return 0x7E99; // CURVECAPS, RASTERCAPS (no palette)
        case 88: case 90: return 96;
        case 104: return 0; case 106: return 0;    // SIZEPALETTE, NUMRESERVED
        case 108: return 32;                       // COLORRES
        default: return 0;
      }
    });

    // ---------------------------------------------------------------- blitting
    /** copy RGBA pixels (w*h) to the screen buffer at (x, y) */
    function toScreen(rgba, w, h, x, y) {
      const V = video;
      const x0 = Math.max(0, x), y0 = Math.max(0, y), x1 = Math.min(V.width, x + w), y1 = Math.min(V.height, y + h);
      for (let yy = y0; yy < y1; yy++) {
        const so = ((yy - y) * w + (x0 - x)) * 4, dof = (yy * V.width + x0) * 4;
        V.rgba.set(rgba.subarray(so, so + (x1 - x0) * 4), dof);
      }
      V.dirty = true; V.blits++;
    }
    function nearestScale(src, sw, sh, dw, dh) {
      const out = new Uint8ClampedArray(dw * dh * 4);
      for (let y = 0; y < dh; y++) {
        const sy = Math.min(sh - 1, Math.floor(y * sh / dh));
        for (let x = 0; x < dw; x++) { const sx = Math.min(sw - 1, Math.floor(x * sw / dw)), s = (sy * sw + sx) * 4, o = (y * dw + x) * 4; out[o] = src[s]; out[o + 1] = src[s + 1]; out[o + 2] = src[s + 2]; out[o + 3] = 255; }
      }
      return out;
    }
    d('BitBlt', 9, (m, hd, x, y, w, h, hs, sx, sy, rop) => {
      const dd = dcOf(hd); if (!dd) return 0;
      x |= 0; y |= 0; w |= 0; h |= 0; sx |= 0; sy |= 0;
      if (w <= 0 || h <= 0) return 1;
      const toWin = dd.window !== undefined && !dd.printer;
      if (rop === 0x42 || rop === 0xFF0062) {                       // BLACKNESS / WHITENESS
        if (toWin) { const px = new Uint8ClampedArray(w * h * 4).fill(rop === 0x42 ? 0 : 255); for (let i = 3; i < px.length; i += 4) px[i] = 255; toScreen(px, w, h, x, y); }
        return 1;
      }
      const sd = dcOf(hs); if (!sd || !sd.bitmap) return 1;
      const bmp = sd.bitmap;
      if (bmp.dib) {
        const rgba = new Uint8ClampedArray(w * h * 4);
        const cw = Math.max(0, Math.min(w, bmp.w - sx)), ch = Math.max(0, Math.min(h, bmp.h - sy));
        if (cw > 0 && ch > 0) dibToRGBA(bmp.bits, bmp.fmt, sx, sy, cw, ch, rgba, w, 0, 0);
        if (toWin) { toScreen(rgba, w, h, x, y); return 1; }
        if (dd.bitmap && dd.bitmap.dib) { writeDib(dd.bitmap, rgba, w, h, x, y); return 1; }
      }
      return 1;
    });
    /** write RGBA pixels into a DIB section (32/24/16-bit) */
    function writeDib(bmp, rgba, w, h, x, y) {
      const f = bmp.fmt, U = c.u8;
      for (let yy = 0; yy < h; yy++) {
        const ty = y + yy; if (ty < 0 || ty >= bmp.h) continue;
        const fileRow = f.top ? ty : f.h - 1 - ty;
        for (let xx = 0; xx < w; xx++) {
          const tx = x + xx; if (tx < 0 || tx >= bmp.w) continue;
          const s = (yy * w + xx) * 4, r = rgba[s], g = rgba[s + 1], b = rgba[s + 2];
          const q = bmp.bits + fileRow * f.stride + tx * (f.bpp >> 3);
          if (f.bpp === 32) { U[q] = b; U[q + 1] = g; U[q + 2] = r; U[q + 3] = 0; }
          else if (f.bpp === 24) { U[q] = b; U[q + 1] = g; U[q + 2] = r; }
          else if (f.bpp === 16) { const v = f.masks[1] === 0x07E0 ? ((r >> 3) << 11) | ((g >> 2) << 5) | (b >> 3) : ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3); U[q] = v; U[q + 1] = v >> 8; }
        }
      }
    }
    const origStretch = m.apis.get('gdi32.dll!StretchDIBits');
    d('StretchDIBits', 13, (m, hd, xd, yd, wd, hd2, xs, ys, ws, hs, bits, pbmi, usage, rop) => {
      const dd = dcOf(hd);
      if (dd && dd.printer && origStretch) return origStretch.fn(m, hd, xd, yd, wd, hd2, xs, ys, ws, hs, bits, pbmi, usage, rop);
      if (!dd) return 0;
      xd |= 0; yd |= 0; wd |= 0; hd2 |= 0; xs |= 0; ys |= 0; ws |= 0; hs |= 0;
      if (wd <= 0 || hd2 <= 0 || ws <= 0 || hs <= 0) return 0;
      const f = readBmi(pbmi);
      if (![1, 4, 8, 16, 24, 32].includes(f.bpp) || (f.comp !== 0 && f.comp !== 3)) return 0;
      // source rectangle (in bitmap coordinates, origin bottom-left for bottom-up bitmaps)
      const srcTop = f.top ? ys : f.h - ys - hs;
      const cw = Math.min(ws, f.w - xs), ch = Math.min(hs, f.h - srcTop);
      if (cw <= 0 || ch <= 0) return 0;
      const rgba = new Uint8ClampedArray(cw * ch * 4);
      dibToRGBA(bits, f, xs, srcTop, cw, ch, rgba, cw, 0, 0);
      const out = (cw === wd && ch === hd2) ? rgba : nearestScale(rgba, cw, ch, wd, hd2);
      if (dd.window !== undefined) toScreen(out, wd, hd2, xd, yd);
      return hd2;
    });
  }
  EMU.installGdi32b = install;
})(typeof globalThis !== 'undefined' ? globalThis : this);
