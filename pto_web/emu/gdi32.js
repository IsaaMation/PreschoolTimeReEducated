/* GDI32 stand-ins: device contexts, bitmaps, brushes/pens, fonts, text, palettes.
 *
 * The game uses GDI for exactly one thing: at start-up it draws every character of an Arial font into a monochrome memory bitmap
 * (CreateCompatibleDC + CreateDIBitmap + ExtTextOutA) and reads it back with GetDIBits, to build its own bitmap font ("sgdi.cpp").
 * So bitmaps are plain RGB arrays and text goes through m.textBackend:
 *     metrics(font)      -> { ascent, descent, internal, avgWidth, maxWidth }
 *     measure(font, str) -> advance width in pixels (integer)
 *     render(font, str)  -> { w, h, alpha: Uint8Array(w*h) }  glyph coverage, text cell top-left at (0,0)
 * Browser: canvas based (worker); Node tests: a crude box font.
 */
(function (G) {
  'use strict';
  const EMU = G.EMU;
  const GD = 'GDI32.dll';

  /** classic Arial proportions (what Windows reports for the font used by the game: -13 px -> ascent 12, descent 3) */
  function emOf(font) {
    const h = font.height || 16;
    return h < 0 ? -h : Math.max(1, Math.round(h / 1.117));
  }
  function fallbackBackend() {
    const metrics = font => {
      const em = emOf(font), ascent = Math.round(em * 0.905), descent = Math.round(em * 0.212);
      return { ascent, descent, internal: ascent + descent - em, avgWidth: Math.round(em * 0.5), maxWidth: Math.round(em * 1.0) };
    };
    const adv = (font, ch) => { const em = emOf(font); return ch === ' ' ? Math.round(em * 0.28) : Math.round(em * 0.56) + (font.weight >= 600 ? 1 : 0); };
    return {
      metrics,
      measure: (font, s) => { let w = 0; for (const ch of s) w += adv(font, ch); return w; },
      render: (font, s) => {
        const mt = metrics(font), w = Math.max(1, (() => { let t = 0; for (const ch of s) t += adv(font, ch); return t; })()), h = mt.ascent + mt.descent;
        const alpha = new Uint8Array(w * h); let x = 0;
        for (const ch of s) {
          const a = adv(font, ch);
          if (ch !== ' ') for (let y = Math.max(1, mt.ascent - Math.round(emOf(font) * 0.7)); y < mt.ascent; y++) for (let i = 1; i < a - 1; i++) alpha[y * w + x + i] = 255;
          x += a;
        }
        return { w, h, alpha };
      },
    };
  }

  const STOCK = {   // GetStockObject indices
    0: { type: 'brush', color: 0xFFFFFF }, 1: { type: 'brush', color: 0xC0C0C0 }, 2: { type: 'brush', color: 0x808080 }, 3: { type: 'brush', color: 0x404040 },
    4: { type: 'brush', color: 0x000000 }, 5: { type: 'brush', color: null }, 6: { type: 'pen', color: 0xFFFFFF }, 7: { type: 'pen', color: 0x000000 }, 8: { type: 'pen', color: null },
  };

  function install(m) {
    const d = (name, n, fn) => m.def(GD, name, n, fn);
    const c = m.cpu;
    if (!m.textBackend) m.textBackend = fallbackBackend();
    const trace = s => { if (m.opts.traceFiles) m.log('  [gdi] ' + s); };

    const STOCK_BASE = 0x30000, DEFAULT_BMP = STOCK_BASE + 0x20, DEFAULT_FONT = STOCK_BASE + 13;
    const stockObjs = {};
    for (const [i, o] of Object.entries(STOCK)) { const h = STOCK_BASE + +i; stockObjs[h] = Object.assign({ stock: true, handle: h }, o); }
    stockObjs[DEFAULT_BMP] = { type: 'bitmap', w: 1, h: 1, rgb: new Uint8Array(3), stock: true, handle: DEFAULT_BMP };
    for (const i of [10, 11, 12, 13, 14, 16, 17]) stockObjs[STOCK_BASE + i] = { type: 'font', height: -11, width: 0, weight: 400, italic: false, face: 'System', stock: true, handle: STOCK_BASE + i };
    const getObj = h => stockObjs[h >>> 0] || m.getHandle(h);
    const newObj = o => { o.handle = m.newHandle(o); return o.handle; };
    const dc = h => { const o = getObj(h); return o && o.type === 'dc' ? o : null; };
    const newDC = extra => Object.assign({ type: 'dc', surface: null, bitmap: null, textColor: 0, bkColor: 0xFFFFFF, bkMode: 2, align: 0, font: null, pal: null, brush: null, pen: null }, extra);
    m.newDC = extra => { const o = newDC(extra); o.handle = m.newHandle(o); return o.handle; };
    const brushOf = x => x.brush || stockObjs[STOCK_BASE + 0], penOf = x => x.pen || stockObjs[STOCK_BASE + 7];
    const fontOf = x => x.font || stockObjs[DEFAULT_FONT];

    d('CreateCompatibleDC', 1, () => m.newDC({ bitmap: stockObjs[DEFAULT_BMP] }));
    d('CreateDCA', 4, () => m.newDC({ printer: true }));          // the only device context the program creates by name is its printer
    d('DeleteDC', 1, (m, h) => { m.closeHandle(h); return 1; });
    d('GetDeviceCaps', 2, (m, h, i) => {
      switch (i) { case 8: return 640; case 10: return 480; case 12: return 8; case 14: return 1; case 24: return 20; case 38: return 0x7E99 | 0x100; case 88: case 90: return 96; case 104: return 256; case 106: return 20; case 2: return 1; case 4: return 340; case 6: return 270; default: return 0; }
    });
    d('GetStockObject', 1, (m, i) => STOCK_BASE + i);
    d('DeleteObject', 1, (m, h) => { if (stockObjs[h >>> 0]) return 1; m.closeHandle(h); return 1; });
    d('SelectObject', 2, (m, h, o) => {
      const x = dc(h), obj = getObj(o);
      if (!x || !obj) return 0;
      switch (obj.type) {
        case 'font': { const old = x.font; x.font = obj; return old ? old.handle : DEFAULT_FONT; }
        case 'bitmap': { const old = x.bitmap; x.bitmap = obj; return old ? old.handle : DEFAULT_BMP; }
        case 'brush': { const old = x.brush; x.brush = obj; return old ? old.handle : STOCK_BASE; }
        case 'pen': { const old = x.pen; x.pen = obj; return old ? old.handle : STOCK_BASE + 7; }
        default: return 0;
      }
    });
    d('CreateFontA', 14, (m, height, width, esc, orient, weight, italic, under, strike, charset, outp, clip, quality, pitch, face) => {
      const f = { type: 'font', height: height | 0, width, weight, italic: !!(italic & 255), face: face ? m.cstr(face) : '' };
      trace('CreateFont ' + f.face + ' h=' + (height | 0) + ' w=' + weight);
      return newObj(f);
    });
    d('CreateSolidBrush', 1, (m, col) => newObj({ type: 'brush', color: col & 0xFFFFFF }));
    d('CreatePen', 3, (m, style, w, col) => newObj({ type: 'pen', color: style === 5 ? null : col & 0xFFFFFF }));
    d('CreateCompatibleBitmap', 3, (m, h, w, ht) => newObj({ type: 'bitmap', w: Math.max(1, w), h: Math.max(1, ht), rgb: new Uint8Array(Math.max(1, w) * Math.max(1, ht) * 3) }));
    d('SetBkMode', 2, (m, h, mode) => { const x = dc(h); if (!x) return 0; const o = x.bkMode; x.bkMode = mode; return o; });
    d('SetBkColor', 2, (m, h, col) => { const x = dc(h); if (!x) return 0; const o = x.bkColor; x.bkColor = col; return o; });
    d('SetTextColor', 2, (m, h, col) => { const x = dc(h); if (!x) return 0; const o = x.textColor; x.textColor = col; return o; });
    d('SetTextAlign', 2, (m, h, a) => { const x = dc(h); if (!x) return 0; const o = x.align || 0; x.align = a; return o; });
    d('SetMapMode', 2, () => 1);

    // ---- drawing into bitmaps (RGB arrays; DirectDraw surface DCs are handled by m.drawText when a host provides it)
    const rgbOf = col => [col & 255, (col >> 8) & 255, (col >> 16) & 255];
    function fillRect(bmp, l, t, r, b, col) {
      const [R, Gc, Bc] = rgbOf(col);
      l = Math.max(0, l); t = Math.max(0, t); r = Math.min(bmp.w, r); b = Math.min(bmp.h, b);
      for (let y = t; y < b; y++) for (let x = l, o = (y * bmp.w + l) * 3; x < r; x++, o += 3) { bmp.rgb[o] = R; bmp.rgb[o + 1] = Gc; bmp.rgb[o + 2] = Bc; }
    }
    d('Rectangle', 5, (m, h, l, t, r, b) => {
      const x = dc(h); if (!x || !x.bitmap || x.bitmap.stock) return 1;
      const br = brushOf(x), pen = penOf(x), bmp = x.bitmap;
      l |= 0; t |= 0; r |= 0; b |= 0;
      if (br.color !== null) fillRect(bmp, l, t, r, b, br.color);
      if (pen.color !== null) { fillRect(bmp, l, t, r, t + 1, pen.color); fillRect(bmp, l, b - 1, r, b, pen.color); fillRect(bmp, l, t, l + 1, b, pen.color); fillRect(bmp, r - 1, t, r, b, pen.color); }
      return 1;
    });

    // ---- text
    d('GetTextMetricsA', 2, (m, h, p) => {
      const x = dc(h) || newDC(), f = fontOf(x), mt = m.textBackend.metrics(f), ht = mt.ascent + mt.descent;
      m.zero(p, 56);
      m.wr32(p, ht); m.wr32(p + 4, mt.ascent); m.wr32(p + 8, mt.descent); m.wr32(p + 12, mt.internal); m.wr32(p + 16, 0);
      m.wr32(p + 20, mt.avgWidth); m.wr32(p + 24, mt.maxWidth); m.wr32(p + 28, f.weight || 400); m.wr32(p + 32, 0); m.wr32(p + 36, 96); m.wr32(p + 40, 96);
      c.u8[p + 44] = 32; c.u8[p + 45] = 255; c.u8[p + 46] = 127; c.u8[p + 47] = 32;            // first, last, default, break char
      c.u8[p + 48] = f.italic ? 1 : 0; c.u8[p + 49] = 0; c.u8[p + 50] = 0;
      c.u8[p + 51] = 0x26;                                                                     // TMPF_VECTOR | TMPF_TRUETYPE | FF_SWISS (proportional)
      c.u8[p + 52] = 0;
      return 1;
    });
    d('GetTextExtentPoint32A', 4, (m, h, s, n, p) => {
      const x = dc(h) || newDC(), f = fontOf(x), mt = m.textBackend.metrics(f);
      const str = m.cstr(s, 4096).substr(0, n);
      m.wr32(p, m.textBackend.measure(f, str)); m.wr32(p + 4, mt.ascent + mt.descent); return 1;
    });
    d('ExtTextOutA', 8, (m, h, X, Y, opts, prect, s, n, pdx) => {
      const x = dc(h); if (!x) return 0;
      const str = m.cstr(s, 4096).substr(0, n);
      X |= 0; Y |= 0;
      if (!x.bitmap || x.bitmap.stock) { if (m.drawText) m.drawText(x, X, Y, opts, prect ? { l: m.rd32(prect), t: m.rd32(prect + 4), r: m.rd32(prect + 8), b: m.rd32(prect + 12) } : null, str); return 1; }
      const bmp = x.bitmap, f = fontOf(x);
      let clip = null;
      if (prect) {
        clip = { l: m.rd32(prect) | 0, t: m.rd32(prect + 4) | 0, r: m.rd32(prect + 8) | 0, b: m.rd32(prect + 12) | 0 };
        if (opts & 2) fillRect(bmp, clip.l, clip.t, clip.r, clip.b, x.bkColor);                // ETO_OPAQUE
      }
      if (!str.length) return 1;
      const g = m.textBackend.render(f, str);
      let ox = X, oy = Y;
      const al = x.align | 0;
      if ((al & 6) === 6) ox -= g.w >> 1; else if (al & 2) ox -= g.w;                          // TA_CENTER / TA_RIGHT
      if ((al & 24) === 24) oy -= m.textBackend.metrics(f).ascent; else if (al & 8) oy -= g.h; // TA_BASELINE / TA_BOTTOM
      if (x.bkMode === 2) fillRect(bmp, ox, oy, ox + g.w, oy + g.h, x.bkColor);
      const [R, Gc, Bc] = rgbOf(x.textColor);
      for (let gy = 0; gy < g.h; gy++) {
        const py = oy + gy; if (py < 0 || py >= bmp.h) continue;
        if (clip && (opts & 4) && (py < clip.t || py >= clip.b)) continue;
        for (let gx = 0; gx < g.w; gx++) {
          if (g.alpha[gy * g.w + gx] < 128) continue;                                         // 1-bit text: no anti-aliasing in an 8-bit device context
          const px = ox + gx; if (px < 0 || px >= bmp.w) continue;
          if (clip && (opts & 4) && (px < clip.l || px >= clip.r)) continue;
          const o = (py * bmp.w + px) * 3; bmp.rgb[o] = R; bmp.rgb[o + 1] = Gc; bmp.rgb[o + 2] = Bc;
        }
      }
      return 1;
    });

    // ---- DIBs
    const lum = (rgb, o) => (rgb[o] * 299 + rgb[o + 1] * 587 + rgb[o + 2] * 114) / 1000;
    d('CreateDIBitmap', 6, (m, h, pbmih, init, pbits, pbmi, usage) => {
      const w = Math.max(1, m.rd32(pbmih + 4) | 0), ht = Math.max(1, Math.abs(m.rd32(pbmih + 8) | 0));
      const bmp = { type: 'bitmap', w, h: ht, rgb: new Uint8Array(w * ht * 3) };
      if ((init & 4) && pbits && pbmi) dibToRgb(bmp, pbits, pbmi);
      return newObj(bmp);
    });
    function dibToRgb(bmp, bits, bmi) {
      const bc = c.u16[(bmi + 14) >> 1], hdr = m.rd32(bmi), w = bmp.w, H = bmp.h, tall = (m.rd32(bmi + 8) | 0) > 0;
      const stride = (((w * bc + 31) >> 5) << 2);
      for (let y = 0; y < H; y++) {
        const row = bits + (tall ? H - 1 - y : y) * stride;
        for (let x = 0; x < w; x++) {
          let r, g, b;
          if (bc === 1) { const v = (c.u8[row + (x >> 3)] >> (7 - (x & 7))) & 1, e = bmi + hdr + v * 4; b = c.u8[e]; g = c.u8[e + 1]; r = c.u8[e + 2]; }
          else if (bc === 8) { const e = bmi + hdr + c.u8[row + x] * 4; b = c.u8[e]; g = c.u8[e + 1]; r = c.u8[e + 2]; }
          else if (bc === 24) { b = c.u8[row + x * 3]; g = c.u8[row + x * 3 + 1]; r = c.u8[row + x * 3 + 2]; }
          else { b = c.u8[row + x * 4]; g = c.u8[row + x * 4 + 1]; r = c.u8[row + x * 4 + 2]; }
          const o = (y * w + x) * 3; bmp.rgb[o] = r; bmp.rgb[o + 1] = g; bmp.rgb[o + 2] = b;
        }
      }
    }
    d('GetDIBits', 7, (m, h, hbm, start, lines, pbits, pbmi, usage) => {
      const bmp = getObj(hbm); if (!bmp || bmp.type !== 'bitmap') return 0;
      const hdr = m.rd32(pbmi); let bc = c.u16[(pbmi + 14) >> 1];
      if (!bc) { bc = 24; c.u16[(pbmi + 14) >> 1] = 24; c.u16[(pbmi + 12) >> 1] = 1; }
      m.wr32(pbmi + 4, bmp.w); m.wr32(pbmi + 8, bmp.h);
      if (!pbits) return bmp.h;
      const tall = (m.rd32(pbmi + 8) | 0) > 0, w = bmp.w, H = bmp.h, stride = (((w * bc + 31) >> 5) << 2);
      lines = Math.min(lines, H - start);
      if (bc === 1) { c.u8.fill(0, pbmi + hdr, pbmi + hdr + 8); c.u8[pbmi + hdr + 4] = c.u8[pbmi + hdr + 5] = c.u8[pbmi + hdr + 6] = 255; }   // black, white
      for (let k = 0; k < lines; k++) {
        const sy = tall ? H - 1 - (start + k) : start + k, row = pbits + k * stride;
        if (bc === 1) {
          c.u8.fill(0, row, row + stride);
          for (let x = 0; x < w; x++) if (lum(bmp.rgb, (sy * w + x) * 3) >= 128) c.u8[row + (x >> 3)] |= 0x80 >> (x & 7);
        } else if (bc === 24 || bc === 32) {
          const bpp = bc >> 3;
          for (let x = 0; x < w; x++) { const o = (sy * w + x) * 3; c.u8[row + x * bpp] = bmp.rgb[o + 2]; c.u8[row + x * bpp + 1] = bmp.rgb[o + 1]; c.u8[row + x * bpp + 2] = bmp.rgb[o]; if (bpp === 4) c.u8[row + x * 4 + 3] = 0; }
        } else return 0;
      }
      return lines;
    });
    d('SetDIBits', 7, () => 0);

    // ---- palettes
    d('CreatePalette', 1, (m, p) => {
      const n = c.u16[(p + 2) >> 1], ent = new Uint8Array(n * 4); ent.set(c.u8.subarray(p + 4, p + 4 + n * 4));
      return newObj({ type: 'palette', entries: ent });
    });
    d('SetPaletteEntries', 4, (m, h, start, n, p) => { const o = getObj(h); if (!o) return 0; o.entries.set(c.u8.subarray(p, p + n * 4), start * 4); return n; });
    d('SelectPalette', 3, (m, h, pal, bg) => { const x = dc(h); if (!x) return 0; const old = x.pal ? x.pal.handle : 0x30010; x.pal = getObj(pal) || null; return old; });
    d('RealizePalette', 1, () => 0);
    d('GetSystemPaletteEntries', 4, (m, h, start, n, p) => {
      for (let i = 0; i < n; i++) {
        const idx = start + i; let r = 0, g = 0, b = 0;
        if (idx < 10) { const t = [[0, 0, 0], [128, 0, 0], [0, 128, 0], [128, 128, 0], [0, 0, 128], [128, 0, 128], [0, 128, 128], [192, 192, 192], [192, 220, 192], [166, 202, 240]][idx]; [r, g, b] = t; }
        else if (idx >= 246) { const t = [[255, 251, 240], [160, 160, 164], [128, 128, 128], [255, 0, 0], [0, 255, 0], [255, 255, 0], [0, 0, 255], [255, 0, 255], [0, 255, 255], [255, 255, 255]][idx - 246]; [r, g, b] = t; }
        c.u8[p + i * 4] = r; c.u8[p + i * 4 + 1] = g; c.u8[p + i * 4 + 2] = b; c.u8[p + i * 4 + 3] = 0;
      }
      return n;
    });

    // ---- printing. The game's Print button draws the current picture into a printer DC: CreateDC, StartDoc, StartPage,
    // StretchDIBits (8-bit DIB), EndPage, EndDoc. There is no printer here: the picture is handed to the host page
    // (m.opts.onPrint) which shows it with Print / Save choices.
    const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
    /** reads a rectangle of a BI_RGB DIB (1, 4, 8, 24 or 32 bits) from guest memory into RGBA; null if unsupported */
    function readDib(pbits, pbmi, xs, ys, ws, hs) {
      const size = m.rd32(pbmi), W = m.rd32(pbmi + 4) | 0, Hraw = m.rd32(pbmi + 8) | 0, bc = c.u16[(pbmi + 14) >> 1], comp = m.rd32(pbmi + 16);
      if (size < 40 || !W || !Hraw || comp !== 0 || ![1, 4, 8, 24, 32].includes(bc)) return null;
      const H = Math.abs(Hraw), tall = Hraw > 0;
      if (W < 1 || W > 8192 || H > 8192) return null;
      const stride = (((W * bc + 31) >> 5) << 2), ncol = bc <= 8 ? (m.rd32(pbmi + 32) || (1 << bc)) : 0, pal = pbmi + size;
      const x0 = clamp(xs | 0, 0, W - 1), w = clamp(ws | 0, 1, W - x0);
      const yTop = tall ? H - ((ys | 0) + Math.abs(hs | 0)) : (ys | 0);             // bottom-up bitmaps count rows from the bottom
      const y0 = clamp(yTop, 0, H - 1), h = clamp(Math.abs(hs | 0), 1, H - y0);
      const rgba = new Uint8ClampedArray(w * h * 4), U = c.u8;
      for (let r = 0; r < h; r++) {
        const fileRow = tall ? H - 1 - (y0 + r) : y0 + r, row = pbits + fileRow * stride;
        for (let x = 0; x < w; x++) {
          const sx = x0 + x, o = (r * w + x) * 4;
          if (bc >= 24) { const q = row + sx * (bc >> 3); rgba[o] = U[q + 2]; rgba[o + 1] = U[q + 1]; rgba[o + 2] = U[q]; }
          else {
            const idx = bc === 8 ? U[row + sx] : bc === 4 ? (U[row + (sx >> 1)] >> ((sx & 1) ? 0 : 4)) & 15 : (U[row + (sx >> 3)] >> (7 - (sx & 7))) & 1;
            const q = pal + Math.min(idx, Math.max(ncol - 1, 0)) * 4; rgba[o] = U[q + 2]; rgba[o + 1] = U[q + 1]; rgba[o + 2] = U[q];
          }
          rgba[o + 3] = 255;
        }
      }
      return { w, h, rgba };
    }
    const prn = h => { const x = dc(h); return x && x.printer ? x : null; };
    d('SetAbortProc', 2, () => 1);
    d('StartDocA', 2, (m, h, info) => { const x = prn(h); if (!x) return 0; x.doc = { name: info ? m.cstr(m.rd32(info + 4)) : '', pages: [] }; return 1; });
    d('StartPage', 1, (m, h) => { const x = prn(h); return x && x.doc ? 1 : 0; });
    d('StretchDIBits', 13, (m, h, xd, yd, wd, hd, xs, ys, ws, hs, bits, bmi) => {
      const x = prn(h);
      if (!x || !x.doc) return 0;
      const img = readDib(bits, bmi, xs, ys, ws, hs);                              // the picture itself; the page scales it to the paper
      if (img) x.doc.pages.push(img);
      return img ? img.h : 0;
    });
    d('EndPage', 1, (m, h) => { const x = prn(h); return x && x.doc ? 1 : 0; });
    d('EndDoc', 1, (m, h) => {
      const x = prn(h); if (!x || !x.doc) return 0;
      const doc = x.doc; x.doc = null;
      m.log('[print] ' + doc.pages.length + ' page(s)' + (doc.pages[0] ? ' ' + doc.pages[0].w + 'x' + doc.pages[0].h : ''));
      if (doc.pages.length && m.opts.onPrint) m.opts.onPrint(doc);
      return 1;
    });
    // (EnumPrintersA, with the printer's description, is in misc.js)
    m.def('comdlg32.dll', 'GetOpenFileNameA', 1, () => 0);
    m.def('comdlg32.dll', 'GetSaveFileNameA', 1, () => 0);
  }
  EMU.installGdi32 = install;
})(typeof globalThis !== 'undefined' ? globalThis : this);
