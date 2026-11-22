/* DirectDraw stand-in (8-bit palettised display only, which is what this game uses).
 * COM objects are 8 bytes in guest memory: [vtable ptr][object id]; every vtable slot is a trap.
 */
(function (G) {
  'use strict';
  const EMU = G.EMU;
  const DD_OK = 0, DDERR_UNSUPPORTED = 0x80004001 | 0, DDERR_INVALIDPARAMS = 0x80070057 | 0, DDERR_GENERIC = 0x80004005 | 0, DDERR_NOTFOUND = 0x887600FF | 0 /* approx */, DDERR_NOCOLORKEY = 0x8876008C | 0, E_NOINTERFACE = 0x80004002 | 0;

  // [name, argCount excluding this]
  const U = [['QueryInterface', 2], ['AddRef', 0], ['Release', 0]];
  const DD1 = U.concat([['Compact', 0], ['CreateClipper', 3], ['CreatePalette', 4], ['CreateSurface', 3], ['DuplicateSurface', 2], ['EnumDisplayModes', 4], ['EnumSurfaces', 4], ['FlipToGDISurface', 0], ['GetCaps', 2], ['GetDisplayMode', 1], ['GetFourCCCodes', 2], ['GetGDISurface', 1], ['GetMonitorFrequency', 1], ['GetScanLine', 1], ['GetVerticalBlankStatus', 1], ['Initialize', 1], ['RestoreDisplayMode', 0], ['SetCooperativeLevel', 2], ['SetDisplayMode', 3], ['WaitForVerticalBlank', 2]]);
  const DD2 = DD1.slice(); DD2[21] = ['SetDisplayMode', 5]; DD2.push(['GetAvailableVidMem', 3]);
  const DD4 = DD2.concat([['GetSurfaceFromDC', 2], ['RestoreAllSurfaces', 0], ['TestCooperativeLevel', 0], ['GetDeviceIdentifier', 2]]);
  const DD7 = DD4.concat([['StartModeTest', 3], ['EvaluateMode', 2]]);
  const S1 = U.concat([['AddAttachedSurface', 1], ['AddOverlayDirtyRect', 1], ['Blt', 5], ['BltBatch', 3], ['BltFast', 5], ['DeleteAttachedSurface', 2], ['EnumAttachedSurfaces', 2], ['EnumOverlayZOrders', 3], ['Flip', 2], ['GetAttachedSurface', 2], ['GetBltStatus', 1], ['GetCaps', 1], ['GetClipper', 1], ['GetColorKey', 2], ['GetDC', 1], ['GetFlipStatus', 1], ['GetOverlayPosition', 2], ['GetPalette', 1], ['GetPixelFormat', 1], ['GetSurfaceDesc', 1], ['Initialize', 2], ['IsLost', 0], ['Lock', 4], ['ReleaseDC', 1], ['Restore', 0], ['SetClipper', 1], ['SetColorKey', 2], ['SetOverlayPosition', 2], ['SetPalette', 1], ['Unlock', 1], ['UpdateOverlay', 5], ['UpdateOverlayDisplay', 1], ['UpdateOverlayZOrder', 2]]);
  const S2 = S1.concat([['GetDDInterface', 1], ['PageLock', 1], ['PageUnlock', 1]]);
  const S3 = S2.concat([['SetSurfaceDesc', 2]]);
  const S4 = S3.concat([['SetPrivateData', 4], ['GetPrivateData', 3], ['FreePrivateData', 1], ['GetUniquenessValue', 1], ['ChangeUniquenessValue', 0]]);
  const S7 = S4.concat([['SetPriority', 1], ['GetPriority', 1], ['SetLOD', 1], ['GetLOD', 1]]);
  const PAL = U.concat([['GetCaps', 1], ['GetEntries', 4], ['Initialize', 3], ['SetEntries', 4]]);
  const CLIP = U.concat([['GetClipList', 3], ['GetHWnd', 1], ['Initialize', 2], ['IsClipListChanged', 1], ['SetClipList', 2], ['SetHWnd', 2]]);

  const IFACES = {
    IDirectDraw: { m: DD1, kind: 'dd', iid: 0x6C14DB80 }, IDirectDraw2: { m: DD2, kind: 'dd', iid: 0xB3A6F3E0 },
    IDirectDraw4: { m: DD4, kind: 'dd', iid: 0x9C59509A }, IDirectDraw7: { m: DD7, kind: 'dd', iid: 0x15E65EC0 },
    IDirectDrawSurface: { m: S1, kind: 'surf', iid: 0x6C14DB81 }, IDirectDrawSurface2: { m: S2, kind: 'surf', iid: 0x57805885 },
    IDirectDrawSurface3: { m: S3, kind: 'surf', iid: 0xDA044E00 }, IDirectDrawSurface4: { m: S4, kind: 'surf', iid: 0x0B2B8630 },
    IDirectDrawSurface7: { m: S7, kind: 'surf', iid: 0x06675A80 },
    IDirectDrawPalette: { m: PAL, kind: 'pal', iid: 0x6C14DB84 }, IDirectDrawClipper: { m: CLIP, kind: 'clip', iid: 0x6C14DB85 },
  };

  function install(m) {
    const c = m.cpu;
    const trace = s => { if (m.opts.traceDD) m.log('  [dd] ' + s); };
    const objs = m.comObjects = [null];            // id -> model
    const vtables = {};
    const video = m.video = { width: 640, height: 480, bpp: 8, primary: null, palette: new Uint8Array(1024), dirty: false, frames: 0 };
    for (let i = 0; i < 256; i++) { video.palette[i * 4] = video.palette[i * 4 + 1] = video.palette[i * 4 + 2] = i; video.palette[i * 4 + 3] = 255; }

    // ---------------------------------------------------------------- COM plumbing
    function vtableFor(iface) {
      if (vtables[iface]) return vtables[iface];
      const list = IFACES[iface].m, base = m.scratch(list.length * 4);
      list.forEach(([name, n], i) => {
        const addr = m.rawTrap(iface + '::' + name, n + 1, (cpu, sp) => {
          const self = cpu.H.rd32(sp), obj = objs[cpu.H.rd32(self + 4)];
          if (!obj) throw new Error('DirectDraw: call on dead object ' + iface + '::' + name);
          const h = obj.methods[name];
          const a = [];
          for (let k = 0; k < n; k++) a.push(cpu.H.rd32(sp + 4 + 4 * k));
          if (m.opts.traceDD) trace(iface + '::' + name + '(' + a.map(v => '0x' + (v >>> 0).toString(16)).join(', ') + ')');
          if (!h) throw new Error('unimplemented DirectDraw method ' + iface + '::' + name + ' (' + obj.kind + ')');
          const r = h.call(obj, iface, self, ...a);
          return r === undefined ? 0 : r;
        });
        m.wr32(base + i * 4, addr);
      });
      return (vtables[iface] = base);
    }
    function newCom(model, iface) {
      model.id = objs.length; objs.push(model); model.refs = 1;
      return comPtr(model, iface);
    }
    function comPtr(model, iface) {
      const key = '$' + iface;
      if (model[key]) return model[key];
      const p = m.malloc(16, true);
      m.wr32(p, vtableFor(iface)); m.wr32(p + 4, model.id);
      model[key] = p; model.iface = model.iface || iface;
      return p;
    }
    const guidKey = p => m.rd32(p) >>> 0;
    function queryInterface(obj, kind, self, piid, ppv) {
      const key = guidKey(piid);
      if (key === 0) return E_NOINTERFACE;
      for (const [name, f] of Object.entries(IFACES)) {
        if (f.kind === kind && f.iid === key) { obj.refs++; m.wr32(ppv, comPtr(obj, name)); trace('QueryInterface -> ' + name); return DD_OK; }
      }
      trace('QueryInterface(' + key.toString(16) + ') -> E_NOINTERFACE');
      return E_NOINTERFACE;
    }
    const common = {
      QueryInterface(iface, self, piid, ppv) { return queryInterface(this, this.kind, self, piid, ppv); },
      AddRef() { return ++this.refs; },
      Release() { return --this.refs; },
    };

    // ---------------------------------------------------------------- surfaces
    const rectOf = (p, s) => p ? { l: m.rd32(p), t: m.rd32(p + 4), r: m.rd32(p + 8), b: m.rd32(p + 12) } : { l: 0, t: 0, r: s.w, b: s.h };
    function makeSurface(w, h, caps) {
      const pitch = (w + 3) & ~3;
      const s = { kind: 'surf', w, h, pitch, caps, mem: m.valloc(Math.max(pitch * h, 4096)), colorKey: null, dkey: null, palette: null, back: null, front: null, methods: Object.assign({}, common, surfMethods) };
      return s;
    }
    function fillDesc(s, p) {
      const size = m.rd32(p);
      const keep = size >= 108 ? size : 108;
      m.zero(p, keep); m.wr32(p, keep);
      m.wr32(p + 4, 1 | 2 | 4 | 8 | 0x1000 | 0x800);
      m.wr32(p + 8, s.h); m.wr32(p + 12, s.w); m.wr32(p + 16, s.pitch); m.wr32(p + 36, 0);
      m.wr32(p + 72, 32); m.wr32(p + 76, 0x20 | 0x40); m.wr32(p + 84, 8);
      m.wr32(p + 104, s.caps);
    }
    function clipRects(dst, dr, src, sr) {
      // clip destination rect to the surface and adjust the source accordingly (nearest-neighbour stretch)
      let dw = dr.r - dr.l, dh = dr.b - dr.t, sw = sr.r - sr.l, sh = sr.b - sr.t;
      if (dw <= 0 || dh <= 0 || sw <= 0 || sh <= 0) return null;
      return { dw, dh, sw, sh };
    }
    function blit(dst, dr, src, sr, keyMode) {
      const g = clipRects(dst, dr, src, sr); if (!g) return;
      const U8 = c.u8, key = keyMode === 1 ? src.colorKey : null, dkey = keyMode === 2 ? dst.dkey : null;
      const sxStep = g.sw / g.dw, syStep = g.sh / g.dh;
      for (let y = 0; y < g.dh; y++) {
        const dy = dr.t + y; if (dy < 0 || dy >= dst.h) continue;
        const sy = sr.t + Math.floor(y * syStep); if (sy < 0 || sy >= src.h) continue;
        const dRow = dst.mem + dy * dst.pitch, sRow = src.mem + sy * src.pitch;
        if (g.dw === g.sw && !key && !dkey) {
          let x0 = Math.max(0, -dr.l, -sr.l), x1 = Math.min(g.dw, dst.w - dr.l, src.w - sr.l);
          if (x1 > x0) U8.copyWithin(dRow + dr.l + x0, sRow + sr.l + x0, sRow + sr.l + x1);
        } else {
          for (let x = 0; x < g.dw; x++) {
            const dx = dr.l + x; if (dx < 0 || dx >= dst.w) continue;
            const sx = sr.l + Math.floor(x * sxStep); if (sx < 0 || sx >= src.w) continue;
            const px = U8[sRow + sx];
            if (key && px >= key[0] && px <= key[1]) continue;
            if (dkey) { const dp = U8[dRow + dx]; if (!(dp >= dkey[0] && dp <= dkey[1])) continue; }
            U8[dRow + dx] = px;
          }
        }
      }
      if (dst === video.primary) video.dirty = true;
    }
    function fill(dst, dr, color) {
      for (let y = Math.max(0, dr.t); y < Math.min(dst.h, dr.b); y++) {
        const x0 = Math.max(0, dr.l), x1 = Math.min(dst.w, dr.r);
        if (x1 > x0) c.u8.fill(color & 255, dst.mem + y * dst.pitch + x0, dst.mem + y * dst.pitch + x1);
      }
      if (dst === video.primary) video.dirty = true;
    }
    const surfOf = p => (p ? objs[m.rd32(p + 4)] : null);
    const surfMethods = {
      GetSurfaceDesc(iface, self, p) { fillDesc(this, p); return DD_OK; },
      GetCaps(iface, self, p) { m.wr32(p, this.caps); return DD_OK; },
      GetPixelFormat(iface, self, p) { m.zero(p, 32); m.wr32(p, 32); m.wr32(p + 4, 0x20 | 0x40); m.wr32(p + 12, 8); return DD_OK; },
      Lock(iface, self, prect, pdesc, flags, hev) {
        const r = prect ? rectOf(prect, this) : null;
        if (m.opts.traceLock && (m.lockLog = (m.lockLog | 0) + 1) <= m.opts.traceLock) m.log('  [lock] ' + (this === video.primary ? 'PRIMARY' : 'offscreen') + ' rect=' + (r ? [r.l, r.t, r.r, r.b].join(',') : 'full') + ' flags=0x' + (flags >>> 0).toString(16) + ' mem=0x' + this.mem.toString(16) + ' ret=0x' + (m.rd32(c.R[4] + 4) >>> 0).toString(16));
        fillDesc(this, pdesc);
        m.wr32(pdesc + 36, this.mem + (r ? r.t * this.pitch + r.l : 0));
        return DD_OK;
      },
      Unlock(iface, self) { if (this === video.primary) { video.dirty = true; } return DD_OK; },
      Blt(iface, self, pdr, psrc, psr, flags, pfx) {
        const src = surfOf(psrc), dr = rectOf(pdr, this);
        if (flags & 0x400) { fill(this, dr, m.rd32(pfx + 80)); return DD_OK; }
        if (!src) return DD_OK;
        const sr = rectOf(psr, src);
        blit(this, dr, src, sr, (flags & 0x8000) ? 1 : (flags & 0x2000) ? 2 : 0);
        return DD_OK;
      },
      BltFast(iface, self, x, y, psrc, psr, flags) {
        const src = surfOf(psrc), sr = rectOf(psr, src);
        blit(this, { l: x, t: y, r: x + (sr.r - sr.l), b: y + (sr.b - sr.t) }, src, sr, (flags & 1) ? 1 : (flags & 2) ? 2 : 0);
        return DD_OK;
      },
      Flip(iface, self, ptarget, flags) {
        const tgt = ptarget ? surfOf(ptarget) : this.back;
        if (tgt) {
          const t = this.mem; this.mem = tgt.mem; tgt.mem = t;
          if (this === video.primary) { video.dirty = true; video.frames++; }
        }
        return DD_OK;
      },
      GetAttachedSurface(iface, self, pcaps, pout) {
        if (!this.back) return DDERR_NOTFOUND;
        this.back.refs++; m.wr32(pout, comPtr(this.back, iface)); return DD_OK;
      },
      AddAttachedSurface(iface, self, psurf) { return DD_OK; },
      DeleteAttachedSurface() { return DD_OK; },
      IsLost() { return DD_OK; }, Restore() { return DD_OK; },
      GetBltStatus() { return DD_OK; }, GetFlipStatus() { return DD_OK; },
      SetColorKey(iface, self, flags, pk) {
        const k = pk ? [m.rd32(pk), m.rd32(pk + 4)] : null;
        if (flags & 8) this.colorKey = k; else if (flags & 2) this.dkey = k;
        return DD_OK;
      },
      GetColorKey(iface, self, flags, pk) { const k = (flags & 8) ? this.colorKey : this.dkey; if (!k) return DDERR_NOCOLORKEY; m.wr32(pk, k[0]); m.wr32(pk + 4, k[1]); return DD_OK; },
      SetPalette(iface, self, ppal) {
        const pal = ppal ? objs[m.rd32(ppal + 4)] : null;
        this.palette = pal;
        if (this === video.primary && pal) { video.palObj = pal; video.dirty = true; }
        return DD_OK;
      },
      GetPalette(iface, self, pout) { if (!this.palette) return 0x88760192 | 0; this.palette.refs++; m.wr32(pout, comPtr(this.palette, 'IDirectDrawPalette')); return DD_OK; },
      SetClipper() { return DD_OK; }, GetClipper() { return 0x887600A9 | 0; },
      GetDC(iface, self, pout) {
        const dc = m.newHandle({ type: 'dc', surface: this, textColor: 0, bkColor: 0xFFFFFF, bkMode: 2, font: null, pal: null });
        m.wr32(pout, dc); return DD_OK;
      },
      ReleaseDC(iface, self, dc) { m.closeHandle(dc); if (this === video.primary) video.dirty = true; return DD_OK; },
      PageLock() { return DD_OK; }, PageUnlock() { return DD_OK; },
      GetDDInterface(iface, self, pout) { m.wr32(pout, comPtr(m.ddObj, 'IDirectDraw4')); return DD_OK; },
      SetPriority() { return DD_OK; },
    };

    // ---------------------------------------------------------------- palette
    function makePalette(entriesPtr, flags) {
      const mem = m.malloc(1024, true);
      if (entriesPtr) c.u8.copyWithin(mem, entriesPtr, entriesPtr + 1024);
      return { kind: 'pal', mem, methods: Object.assign({}, common, {
        SetEntries(iface, self, fl, start, n, p) {
          c.u8.copyWithin(this.mem + start * 4, p, p + n * 4);
          if (video.palObj === this) video.dirty = true; return DD_OK;
        },
        GetEntries(iface, self, fl, start, n, p) { c.u8.copyWithin(p, this.mem + start * 4, this.mem + (start + n) * 4); return DD_OK; },
        GetCaps(iface, self, p) { m.wr32(p, 0x4 | 0x40); return DD_OK; },
      }) };
    }

    // ---------------------------------------------------------------- DirectDraw object
    const ddMethods = Object.assign({}, common, {
      SetCooperativeLevel(iface, self, hwnd, flags) { return DD_OK; },
      SetDisplayMode(iface, self, w, h, bpp) { video.width = w; video.height = h; video.bpp = bpp; trace('SetDisplayMode ' + w + 'x' + h + 'x' + bpp); return DD_OK; },
      RestoreDisplayMode() { return DD_OK; },
      GetDisplayMode(iface, self, p) { m.zero(p, 108); m.wr32(p, 108); m.wr32(p + 4, 1 | 2 | 4 | 0x1000); m.wr32(p + 8, video.height); m.wr32(p + 12, video.width); m.wr32(p + 72, 32); m.wr32(p + 76, 0x20 | 0x40); m.wr32(p + 84, 8); return DD_OK; },
      WaitForVerticalBlank() { c.yieldNow = true; return DD_OK; },
      GetVerticalBlankStatus(iface, self, p) { m.wr32(p, 1); return DD_OK; },
      GetScanLine(iface, self, p) { m.wr32(p, 0); return DD_OK; },
      FlipToGDISurface() { return DD_OK; },
      TestCooperativeLevel() { return DD_OK; },
      RestoreAllSurfaces() { return DD_OK; },
      Compact() { return DD_OK; },
      GetAvailableVidMem(iface, self, pcaps, ptotal, pfree) { if (ptotal) m.wr32(ptotal, 8 << 20); if (pfree) m.wr32(pfree, 6 << 20); return DD_OK; },
      GetMonitorFrequency(iface, self, p) { m.wr32(p, 60); return DD_OK; },
      GetGDISurface(iface, self, pout) { video.primary.refs++; m.wr32(pout, comPtr(video.primary, 'IDirectDrawSurface')); return DD_OK; },
      GetCaps(iface, self, pdrv, phel) {
        for (const p of [pdrv, phel]) if (p) {
          const sz = m.rd32(p) || 316; m.zero(p, sz); m.wr32(p, sz);
        }
        if (pdrv) { m.wr32(pdrv + 4, 0x1 | 0x40 | 0x4000 | 0x800 | 0x400); m.wr32(pdrv + 8, 0x7FFFFF); m.wr32(pdrv + 12, 0x1 | 0x2); m.wr32(pdrv + 52, 8 << 20); m.wr32(pdrv + 56, 6 << 20); }
        return DD_OK;
      },
      EnumDisplayModes(iface, self, flags, pdesc, ctx, cb) {
        const d = m.scratch(124); m.zero(d, 124); m.wr32(d, 108);
        m.wr32(d + 4, 1 | 2 | 4 | 0x1000); m.wr32(d + 8, 480); m.wr32(d + 12, 640); m.wr32(d + 72, 32); m.wr32(d + 76, 0x20 | 0x40); m.wr32(d + 84, 8);
        c.callGuest(cb, [d, ctx]);
        return DD_OK;
      },
      CreatePalette(iface, self, flags, pentries, pout, unk) {
        const pal = makePalette(pentries, flags);
        m.wr32(pout, newCom(pal, 'IDirectDrawPalette')); return DD_OK;
      },
      CreateClipper(iface, self, flags, pout, unk) {
        const cl = { kind: 'clip', methods: Object.assign({}, common, { SetHWnd() { return DD_OK; }, GetHWnd(i, s, p) { m.wr32(p, m.mainWnd); return DD_OK; }, IsClipListChanged(i, s, p) { m.wr32(p, 0); return DD_OK; } }) };
        m.wr32(pout, newCom(cl, 'IDirectDrawClipper')); return DD_OK;
      },
      CreateSurface(iface, self, pdesc, pout, unk) {
        const size = m.rd32(pdesc), flags = m.rd32(pdesc + 4);
        const capsOff = size >= 124 ? 104 : 104;
        const caps = m.rd32(pdesc + capsOff);
        const sIface = size >= 124 ? (iface === 'IDirectDraw7' ? 'IDirectDrawSurface7' : 'IDirectDrawSurface4') : 'IDirectDrawSurface';
        let w = (flags & 4) ? m.rd32(pdesc + 12) : video.width, h = (flags & 2) ? m.rd32(pdesc + 8) : video.height;
        const nback = (flags & 0x20) ? m.rd32(pdesc + 20) : 0;
        trace('CreateSurface ' + w + 'x' + h + ' caps=0x' + caps.toString(16) + ' flags=0x' + flags.toString(16) + ' back=' + nback + ' size=' + size);
        let s;
        if (caps & 0x200) {      // primary
          s = makeSurface(video.width, video.height, caps);
          video.primary = s; video.dirty = true;
          if (nback > 0) {
            const b = makeSurface(video.width, video.height, 4 | 0x40 | 0x4000);
            s.back = b; b.front = s; newCom(b, sIface);
          }
        } else {
          s = makeSurface(w, h, caps);
        }
        m.wr32(pout, newCom(s, sIface));
        return DD_OK;
      },
    });
    m.ddObj = { kind: 'dd', methods: ddMethods };

    m.def('ddraw.dll', 'DirectDrawCreate', 3, (m, pguid, pout, unk) => {
      const dd = { kind: 'dd', methods: ddMethods };
      m.ddObj = dd;
      m.wr32(pout, newCom(dd, 'IDirectDraw'));
      return DD_OK;
    });
    m.def('ddraw.dll', 'DirectDrawEnumerateA', 2, () => DD_OK);

    // ---------------------------------------------------------------- presentation: RGBA frame of the primary surface
    m.getFrameRGBA = (out) => {
      const p = video.primary; if (!p) return null;
      const U8 = c.u8, pal = video.palObj ? U8.subarray(video.palObj.mem, video.palObj.mem + 1024) : video.palette;
      const n = p.w * p.h; out = out || new Uint8ClampedArray(n * 4);
      for (let y = 0; y < p.h; y++) {
        let o = y * p.w * 4, s = p.mem + y * p.pitch;
        for (let x = 0; x < p.w; x++, o += 4) { const i = U8[s + x] * 4; out[o] = pal[i]; out[o + 1] = pal[i + 1]; out[o + 2] = pal[i + 2]; out[o + 3] = 255; }
      }
      return out;
    };
  }
  EMU.installDdraw = install;
})(typeof globalThis !== 'undefined' ? globalThis : this);
