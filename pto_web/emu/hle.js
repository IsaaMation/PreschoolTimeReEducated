/* Native stand-ins for the busiest routines of DisneyPO.exe itself (the other emu files stand in for Windows and its DLLs).
 *
 * The game paints its whole picture with its own code, into a 16-bit bitmap in memory.  Its picture blender (one routine, about 2.8 KB)
 * is what every animation with a see-through edge goes through: the Bink clips with an alpha channel, the Targa pictures the
 * telescope scene is made of, and so on.  It takes a source picture of 32-bit pixels (blue, green, red, alpha) and a rectangle in it,
 * a rectangle of the same size in the 16-bit destination picture, and a mode, and either blends the pixels in (mode 3) or just
 * converts their colours (mode 0, or any mode together with a colour key, which skips the pixels of that colour).  Written for 2007
 * computers it uses MMX when the processor has it; here it runs the plain
 * integer version, about 45 emulated instructions for every pixel, and in the telescope scene ("Letter and Number Hide and Seek"
 * in 2.0.6) that one routine used 99 % of everything the game did: eight million pixels a second.
 * 2.0.3 and 2.0.6 have the same routine.  2.0.0 has an older one with the same arguments, the same two modes, the same arithmetic and the
 * same integer loops, but without the third 16-bit format (see BLEND_VARIANTS): it is 0x110 bytes shorter, so it has a signature of its own.
 *
 * Here those two modes are done natively, with the same arithmetic as the game's integer code (checked against it, pixel for pixel,
 * by tests/hle_blit_test.js and live by `hle.verify`).  Whatever the native code does not know - another mode, the stretching
 * case, a picture format it has not seen, addresses that look wrong - is left to the game's own routine: the hook hands the call
 * straight on to the original code.
 *
 * The second routine is the colour-keyed copy of one 16-bit picture into another, the game's sprite blit for pictures without an
 * alpha channel (the drawers of the Bear lesson's cabinet game are big, mostly see-through pictures drawn with it).  Its integer version
 * looks at every pixel (or at four at a time, when all four are see-through) and takes seven or eight emulated instructions for each:
 * a cabinet scene spent 96 % of its time there, about 37 ms of every frame, where a computer with MMX does the same in a fraction
 * of a millisecond.  Natively it is one comparison and one store per pixel.  All three editions (2.0.0, 2.0.3, 2.0.6) have it.
 *
 *   EMU.Hle.attach(m)  after m.load(): looks for the routines in the loaded program (by their bytes; every build of 2.0.x that has
 *                      one has the same one), and replaces their entries by the native versions.  Does nothing about one that is
 *                      not found or has changed.  Returns m.hle = { found, entry, calls, pixels, declined, copyFound, copyEntry,
 *                      copies, copyPixels, copyDeclined, verify, ... }.
 *   m.hle.enabled = false   (or m.opts.noHle) switches the native versions off: every call then goes to the game's code.
 *   m.hle.verify = true     every call is done both ways and the results compared (the game's result is kept); slow.
 */
(function (G) {
  'use strict';
  const EMU = G.EMU = G.EMU || {};

  // ---- how the routine is recognised: the start of its code finds it, a hash of all of it (without the two operands that depend on where
  // the build put things: the address of the "processor has MMX" flag and the call to the neighbouring routine) confirms it
  const BLEND_START = [0x55, 0x8b, 0xec, 0x83, 0xec, 0x3c, 0x8b, 0x45, 0x18, 0x85, 0xc0, 0x89, 0x4d, 0xd8, 0xc7, 0x45, 0xd0, 0, 0, 0, 0, 0x74, 0x05, 0x8b, 0x00, 0x89, 0x45, 0xd0];     // (the same in every build)
  const MMX_FLAG_AT = 0xc2;           // 4 bytes: address of the flag; the code before it is  80 3d <flag> 00  (cmp byte [flag], 0); the same place in every build
  // The builds: `len` = the length of the routine (up to and including its last ret 0x14), `callAt` = the 4 bytes of the relative address of the call to the stretching routine
  // (the last call in it), `hash` = the hash of all of it without those two operands.  `bgr555` = whether the routine has the branch for the 1BBBBBGGGGGRRRRR format (2.0.0's
  // has not: it takes every destination whose green has not 6 bits for 0RRRRRGGGGGBBBBB).
  const BLEND_VARIANTS = [
    { id: '2.0.3 / 2.0.6', len: 0xb10, callAt: 0xb03, hash: '5c3be690-1f2aa35c', bgr555: true },
    { id: '2.0.0', len: 0xa00, callAt: 0x9f3, hash: '2bcc5ade-5aee7562', bgr555: false },
  ];
  const BLEND_LEN = BLEND_VARIANTS[0].len, CALL_AT = BLEND_VARIANTS[0].callAt, BLEND_HASH = BLEND_VARIANTS[0].hash;      // (the 2.0.3 / 2.0.6 routine: what the tests and tools ask for by these names)

  // the colour-keyed copy (`this` = the picture copied from, in ecx; four arguments: the picture copied to, a rectangle whose left and
  // top say where in it, the rectangle in `this` that is copied, and the colour key; ret 0x10).  Its only operand that depends on the
  // build is the address of the "processor has MMX" flag, in the cmp at 0x66.
  const KEYCOPY_LEN = 0x24e;
  const KEYCOPY_START = [0x55, 0x8b, 0xec, 0x83, 0xec, 0x10, 0x8b, 0x81, 0x6c, 0x03, 0, 0, 0x99, 0x2b, 0xc2, 0x53, 0x56, 0x8b, 0xf0, 0x8b];
  const KEYCOPY_MMX_AT = 0x66;        // 4 bytes: address of the flag; the code before it is  80 3d <flag> 00  (cmp byte [flag], 0)
  const KEYCOPY_HASH = 'dd51be04-59ec3f44';

  /** two different 32-bit hashes of a routine's bytes, the operands that move with the build (4 bytes at each offset in `skips`) set to zero */
  function hashRoutine(u8, at, len, skips) {
    let h1 = 0x811c9dc5 | 0, h2 = 5381 | 0;
    for (let i = 0; i < len; i++) {
      let moved = false;
      for (let k = 0; k < skips.length; k++) if (i >= skips[k] && i < skips[k] + 4) { moved = true; break; }
      const b = moved ? 0 : u8[at + i];
      h1 = Math.imul(h1 ^ b, 0x01000193); h2 = (Math.imul(h2, 33) + b + 0x9e37) | 0;
    }
    return (h1 >>> 0).toString(16).padStart(8, '0') + '-' + (h2 >>> 0).toString(16).padStart(8, '0');
  }
  const hashBlend = (u8, at) => hashRoutine(u8, at, BLEND_LEN, [MMX_FLAG_AT, CALL_AT]);
  const hashKeyCopy = (u8, at) => hashRoutine(u8, at, KEYCOPY_LEN, [KEYCOPY_MMX_AT]);

  // ---- the inner loops.  `s` and `d` are indices into the 32-bit and the 16-bit view of the guest's memory; a row is `w` pixels and the
  // next row starts `sStep` / `dStep` pixels after the start of this one (the pictures' pitch, which may be negative).
  // Mode 3 blends: with the pixel's alpha a (0..255), every colour channel of 5 or 6 bits becomes (old * (255 - a) + new * a) >> 8;
  // pixels with alpha 0 are left alone.  (As in the game's integer code the sum is shifted by 8, not divided by 255: a fully
  // opaque white comes out as 30 of 31, which is how the real program draws it.)
  function blend555(I, U, s0, d0, w, h, sStep, dStep) {              // 0RRRRRGGGGGBBBBB
    for (let y = 0; y < h; y++, s0 += sStep, d0 += dStep) {
      for (let x = 0, s = s0, d = d0; x < w; x++, s++, d++) {
        const p = I[s], a = p >>> 24;
        if (a === 0) continue;
        const k = 255 - a, o = U[d];
        U[d] = (((((((o >> 10) & 31) * k + ((p >> 19) & 31) * a) >> 8) << 5) | ((((o >> 5) & 31) * k + ((p >> 11) & 31) * a) >> 8)) << 5) | ((((o & 31) * k + ((p >> 3) & 31) * a) >> 8));
      }
    }
  }
  function blend565(I, U, s0, d0, w, h, sStep, dStep) {              // RRRRRGGGGGGBBBBB
    for (let y = 0; y < h; y++, s0 += sStep, d0 += dStep) {
      for (let x = 0, s = s0, d = d0; x < w; x++, s++, d++) {
        const p = I[s], a = p >>> 24;
        if (a === 0) continue;
        const k = 255 - a, o = U[d];
        U[d] = (((((((o >> 11) & 31) * k + ((p >> 19) & 31) * a) >> 8) << 6) | ((((o >> 5) & 63) * k + ((p >> 10) & 63) * a) >> 8)) << 5) | ((((o & 31) * k + ((p >> 3) & 31) * a) >> 8));
      }
    }
  }
  function blendBgr555(I, U, s0, d0, w, h, sStep, dStep) {           // 1BBBBBGGGGGRRRRR (the game's code for this format sets the top bit of every pixel it draws)
    for (let y = 0; y < h; y++, s0 += sStep, d0 += dStep) {
      for (let x = 0, s = s0, d = d0; x < w; x++, s++, d++) {
        const p = I[s], a = p >>> 24;
        if (a === 0) continue;
        const k = 255 - a, o = U[d];
        U[d] = 0x8000 | (((((((o >> 10) & 31) * k + ((p >> 3) & 31) * a) >> 8) << 5) | ((((o >> 5) & 31) * k + ((p >> 11) & 31) * a) >> 8)) << 5) | ((((o & 31) * k + ((p >> 19) & 31) * a) >> 8));
      }
    }
  }
  // Mode 0 only converts: every colour channel keeps its top bits (rb, gb, bb of them), whatever the alpha is.  Red is the top field.
  function convert555(I, U, s0, d0, w, h, sStep, dStep) {
    for (let y = 0; y < h; y++, s0 += sStep, d0 += dStep) {
      for (let x = 0, s = s0, d = d0; x < w; x++, s++, d++) {
        const p = I[s];
        U[d] = (((p >> 19) & 31) << 10) | (((p >> 11) & 31) << 5) | ((p >> 3) & 31);
      }
    }
  }
  function convertBits(I, U, s0, d0, w, h, sStep, dStep, rb, gb, bb) {
    const rs = 8 - rb, gs = 8 - gb, bs = 8 - bb, gUp = bb, rUp = gb + bb;
    for (let y = 0; y < h; y++, s0 += sStep, d0 += dStep) {
      for (let x = 0, s = s0, d = d0; x < w; x++, s++, d++) {
        const p = I[s];
        U[d] = ((((p >> 16) & 255) >> rs) << rUp) | ((((p >> 8) & 255) >> gs) << gUp) | ((p & 255) >> bs);
      }
    }
  }
  // With a colour key (the fourth argument is not -1) the same conversion leaves out every pixel that is exactly equal to the key.
  function convertKey(I, U, s0, d0, w, h, sStep, dStep, rb, gb, bb, key) {
    const rs = 8 - rb, gs = 8 - gb, bs = 8 - bb, gUp = bb, rUp = gb + bb;
    for (let y = 0; y < h; y++, s0 += sStep, d0 += dStep) {
      for (let x = 0, s = s0, d = d0; x < w; x++, s++, d++) {
        const p = I[s];
        if (p === key) continue;
        U[d] = ((((p >> 16) & 255) >> rs) << rUp) | ((((p >> 8) & 255) >> gs) << gUp) | ((p & 255) >> bs);
      }
    }
  }

  // The colour-keyed copy: every pixel of the rectangle that is not the key is copied.  (The game's loop tests two pairs of pixels against
  // the key twice over, (key << 16 | key), and skips four pixels at once when both pairs are the key; that skips exactly the pixels that
  // are the key, one by one, when the key fits in 16 bits, which is all the native version accepts.  The order of reads and writes, row
  // by row and left to right, is the game's too, so even pictures that overlap come out the same.)
  function keyCopy16(U, s0, d0, w, h, sStep, dStep, key) {
    for (let y = 0; y < h; y++, s0 += sStep, d0 += dStep) {
      for (let x = 0, s = s0, d = d0; x < w; x++, s++, d++) {
        const p = U[s];
        if (p !== key) U[d] = p;
      }
    }
  }

  /** The hook for the colour-keyed copy (keyCopy16).  The routine is `this->copy(dst, dstPos, srcRect, key)`: `this` and `dst` are pictures
   *  (pixel pointer at +0x350, pitch in bytes at +0x36c), rectangles have left, top, right, bottom at +4, +8, +12, +16. */
  function attachKeyCopy(m, hle, at) {
    const c = m.cpu, U8 = c.u8, H = c.H, R = c.R, U16 = c.u16, SIZE = c.memSize, LOW = 0x10000;
    const orig = c.compile(at);                          // (puts the compiled original into the block table; the hook replaces it below)
    let bypass = false;
    const decline = why => { hle.copyDeclined++; hle.copyWhy[why] = (hle.copyWhy[why] | 0) + 1; return false; };

    /** where the rows are: { w, h, sFirst, dFirst, sStep, dStep } (addresses in bytes, steps in pixels) or a reason (string) for leaving the job to the game */
    function geometry(self, dst, dpos, srect, key) {
      if (!self || !dst || !dpos || !srect) return 'null';
      if ((key >>> 16) !== 0 && key !== -1) return 'key';
      if (U8[hle.copyMmxFlag] !== 0) return 'mmx';
      const L = H.rd32(srect + 4) | 0, T = H.rd32(srect + 8) | 0, w = (H.rd32(srect + 12) | 0) - L + 1, h = (H.rd32(srect + 16) | 0) - T + 1;
      if (h <= 0 || w * h > 0x2000000) return 'size';
      if (w <= 0) return { w: 0, h };                    // nothing to copy (the game's loop only moves its pointers)
      const dL = H.rd32(dpos + 4) | 0, dT = H.rd32(dpos + 8) | 0;
      const sPitch = H.rd32(self + 0x36c) | 0, dPitch = H.rd32(dst + 0x36c) | 0;
      const sStep = (sPitch - (sPitch >> 31)) >> 1, dStep = (dPitch - (dPitch >> 31)) >> 1;       // pixels per row, as the game rounds them
      const sFirst = (H.rd32(self + 0x350) >>> 0) + (T * sStep + L) * 2, dFirst = (H.rd32(dst + 0x350) >>> 0) + (dT * dStep + dL) * 2;
      const sLast = sFirst + (h - 1) * sStep * 2, dLast = dFirst + (h - 1) * dStep * 2;
      if ((sFirst & 1) || (dFirst & 1) || Math.abs(sFirst) > SIZE || Math.abs(dFirst) > SIZE) return 'address';
      if (Math.min(sFirst, sLast) < LOW || Math.max(sFirst, sLast) + w * 2 > SIZE || Math.min(dFirst, dLast) < LOW || Math.max(dFirst, dLast) + w * 2 > SIZE) return 'range';
      return { w, h, sFirst, dFirst, sStep, dStep };
    }
    /** the whole job; false (and nothing touched) if the game's own routine has to do it */
    function work(self, dst, dpos, srect, key) {
      const g = geometry(self, dst, dpos, srect, key);
      if (typeof g === 'string') return decline(g);
      if (g.w > 0) {
        keyCopy16(U16, g.sFirst >> 1, g.dFirst >> 1, g.w, g.h, g.sStep, g.dStep, key & 0xffff);
        hle.copies++; hle.copyPixels += g.w * g.h;
      }
      return true;
    }
    /** the bytes of the destination rectangle's rows, for the verifying mode */
    const destBytes = (self, dst, dpos, srect, key) => {
      const g = geometry(self, dst, dpos, srect, key);
      if (typeof g === 'string' || g.w <= 0) return [];
      const out = [];
      for (let y = 0; y < g.h; y++) { const a = g.dFirst + y * g.dStep * 2; out.push([a, U8.slice(a, a + g.w * 2)]); }
      return out;
    };

    function hook() {
      if (bypass || !hle.enabled) return orig();
      const sp = R[4] >>> 0, self = R[1] >>> 0;
      const ret = H.rd32(sp), dst = H.rd32(sp + 4) >>> 0, dpos = H.rd32(sp + 8) >>> 0, srect = H.rd32(sp + 12) >>> 0, key = H.rd32(sp + 16) | 0;
      if (!hle.verify) {
        if (!work(self, dst, dpos, srect, key)) return orig();
      } else {
        // do it both ways: natively into the destination, remember the result, put the old pixels back, let the game's code do it, compare
        const before = destBytes(self, dst, dpos, srect, key);
        const mark = hle.copies;
        let nat = null;
        try { if (work(self, dst, dpos, srect, key) && hle.copies > mark) nat = destBytes(self, dst, dpos, srect, key); } catch (e) { nat = null; }
        if (nat) for (const [a, bytes] of before) U8.set(bytes, a);
        bypass = true;
        try { c.callGuest(at, [dst, dpos, srect, key], self); } finally { bypass = false; }
        if (nat) {
          const after = destBytes(self, dst, dpos, srect, key); hle.copyVerified++;
          let bad = 0; for (let i = 0; i < after.length && !bad; i++) for (let j = 0; j < after[i][1].length; j++) if (after[i][1][j] !== nat[i][1][j]) { bad = 1; break; }
          if (bad) { hle.copyMismatches++; if (hle.copyMismatches <= 5) m.log('[hle] MISMATCH in colour-key copy ' + hle.copies + ': key 0x' + (key >>> 0).toString(16)); }
        }
      }
      R[4] = (sp + 20) | 0; c.eip = ret;                  // ret 0x10
    }
    c.blocks[at - EMU.consts.IMG_BASE] = hook;
    hle.copyHook = hook; hle.copyOrig = orig; hle.copyWork = work;     // (for the tests)
  }

  function attach(m) {
    const c = m.cpu, U8 = c.u8, H = c.H;
    const hle = m.hle = { found: false, variant: '', bgr555: false, enabled: !m.opts.noHle, verify: false, entry: 0, calls: 0, pixels: 0, declined: 0, byWhy: {}, mismatches: 0, verified: 0, mmxFlag: 0, note: '',
      copyFound: false, copyEntry: 0, copies: 0, copyPixels: 0, copyDeclined: 0, copyWhy: {}, copyMismatches: 0, copyVerified: 0, copyMmxFlag: 0 };
    const text = m.info && m.info.sections && m.info.sections.find(s => s.name === '.text');
    if (!text) { hle.note = 'no code section'; return hle; }
    const lo = m.info.base + text.va, hi = lo + text.vsize;
    const find = (start, len, hash, skips) => {
      for (let a = lo; a < hi - len; a++) {
        if (U8[a] !== 0x55 || U8[a + 1] !== 0x8b) continue;
        let k = 2; while (k < start.length && U8[a + k] === start[k]) k++;
        if (k === start.length && hashRoutine(U8, a, len, skips) === hash) return a;
      }
      return 0;
    };
    let at = 0, variant = null;
    for (const v of BLEND_VARIANTS) { at = find(BLEND_START, v.len, v.hash, [MMX_FLAG_AT, v.callAt]); if (at) { variant = v; break; } }
    const copyAt = find(KEYCOPY_START, KEYCOPY_LEN, KEYCOPY_HASH, [KEYCOPY_MMX_AT]);
    if (!at) hle.note = 'picture blender not found (another build of the game?)';
    if (copyAt) { hle.copyFound = true; hle.copyEntry = copyAt; hle.copyMmxFlag = H.rd32(copyAt + KEYCOPY_MMX_AT) >>> 0; }
    const R = c.R, I32 = c.i32, U16 = c.u16, SIZE = c.memSize, LOW = 0x10000;
    if (copyAt) attachKeyCopy(m, hle, copyAt);
    if (!at) return hle;
    hle.found = true; hle.entry = at; hle.variant = variant.id; hle.bgr555 = variant.bgr555;
    hle.mmxFlag = H.rd32(at + MMX_FLAG_AT) >>> 0;

    const orig = c.compile(at);                          // (puts the compiled original into the block table; the hook replaces it below)
    let bypass = false;

    const decline = why => { hle.declined++; hle.byWhy[why] = (hle.byWhy[why] | 0) + 1; return false; };
    /** the whole job; false (and nothing touched) if the game's own routine has to do it */
    function work(self, dst, dr, sr, flag, mp) {
      const keyed = flag !== -1;                          // a colour key: the game then only converts (whatever the mode is) and skips the key
      const mode = mp ? H.rd32(mp) | 0 : 0;
      if (!keyed && mode !== 0 && mode !== 3) return decline('mode');
      if (!self || !dst || !dr || !sr) return decline('null');
      const rect = p => [H.rd32(p + 4) | 0, H.rd32(p + 8) | 0, H.rd32(p + 12) | 0, H.rd32(p + 16) | 0];
      const D = rect(dr), S = rect(sr);
      const w = S[2] - S[0] + 1, h = S[3] - S[1] + 1;
      if (D[2] - D[0] + 1 !== w || D[3] - D[1] + 1 !== h) return decline('stretch');
      if (w <= 0 || h <= 0) return true;                 // nothing to draw (the game's code draws nothing either)
      if (!keyed && mode === 3 && U8[hle.mmxFlag] !== 0) return decline('mmx');
      const sBase = H.rd32(self + 0x350) >>> 0, sPitch = H.rd32(self + 0x36c) | 0, dBase = H.rd32(dst + 0x350) >>> 0, dPitch = H.rd32(dst + 0x36c) | 0;
      const sStep = (sPitch + ((sPitch >> 31) & 3)) >> 2, dStep = (dPitch - (dPitch >> 31)) >> 1;      // pixels per row, as the game rounds them
      const sFirst = sBase + (S[1] * sStep + S[0]) * 4, dFirst = dBase + (D[1] * dStep + D[0]) * 2;
      const sLast = sFirst + (h - 1) * sStep * 4, dLast = dFirst + (h - 1) * dStep * 2;
      if ((sFirst & 3) || (dFirst & 1) || Math.abs(sFirst) > SIZE || Math.abs(dFirst) > SIZE) return decline('address');
      if (Math.min(sFirst, sLast) < LOW || Math.max(sFirst, sLast) + w * 4 > SIZE || Math.min(dFirst, dLast) < LOW || Math.max(dFirst, dLast) + w * 2 > SIZE) return decline('range');
      const s0 = sFirst >> 2, d0 = dFirst >> 1;
      if (keyed) {
        const rb = U8[dst + 0x376], gb = U8[dst + 0x377], bb = U8[dst + 0x378];
        if (rb < 1 || rb > 8 || gb < 1 || gb > 8 || bb < 1 || bb > 8) return decline('format');
        convertKey(I32, U16, s0, d0, w, h, sStep, dStep, rb, gb, bb, flag);
      } else if (mode === 3) {
        if (U8[dst + 0x377] === 6) blend565(I32, U16, s0, d0, w, h, sStep, dStep);
        else if (hle.bgr555 && U8[dst + 0x374] === 8) blendBgr555(I32, U16, s0, d0, w, h, sStep, dStep);
        else if (U8[dst + 0x374] === 1) blend555(I32, U16, s0, d0, w, h, sStep, dStep);
        else return decline('format');
      } else {
        const rb = U8[dst + 0x376], gb = U8[dst + 0x377], bb = U8[dst + 0x378];
        if (rb < 1 || rb > 8 || gb < 1 || gb > 8 || bb < 1 || bb > 8) return decline('format');
        if (rb === 5 && gb === 5 && bb === 5) convert555(I32, U16, s0, d0, w, h, sStep, dStep);
        else convertBits(I32, U16, s0, d0, w, h, sStep, dStep, rb, gb, bb);
      }
      hle.calls++; hle.pixels += w * h;
      return true;
    }

    /** the bytes of the destination rectangle's rows, for the verifying mode */
    const destBytes = (dst, dr) => {
      const dBase = H.rd32(dst + 0x350) >>> 0, dPitch = H.rd32(dst + 0x36c) | 0, dStep = (dPitch - (dPitch >> 31)) >> 1;
      const l = H.rd32(dr + 4) | 0, t = H.rd32(dr + 8) | 0, r = H.rd32(dr + 12) | 0, b = H.rd32(dr + 16) | 0, out = [];
      for (let y = t; y <= b; y++) { const a = dBase + (y * dStep + l) * 2; out.push([a, U8.slice(a, a + (r - l + 1) * 2)]); }
      return out;
    };

    function hook() {
      if (bypass || !hle.enabled) return orig();
      const sp = R[4] >>> 0, self = R[1] >>> 0;
      const ret = H.rd32(sp), dst = H.rd32(sp + 4) >>> 0, dr = H.rd32(sp + 8) >>> 0, sr = H.rd32(sp + 12) >>> 0, flag = H.rd32(sp + 16) | 0, mp = H.rd32(sp + 20) >>> 0;
      if (!hle.verify) {
        if (!work(self, dst, dr, sr, flag, mp)) return orig();
      } else {
        // do it both ways: natively into the destination, remember the result, put the old pixels back, let the game's code do it, compare
        const before = (dst && dr) ? destBytes(dst, dr) : [];
        const mark = hle.calls;
        let nat = null;
        try { if (work(self, dst, dr, sr, flag, mp) && hle.calls > mark) nat = destBytes(dst, dr); } catch (e) { nat = null; }
        if (nat) for (const [a, bytes] of before) U8.set(bytes, a);
        bypass = true;
        try { c.callGuest(at, [dst, dr, sr, flag, mp], self); } finally { bypass = false; }
        if (nat) {
          const after = destBytes(dst, dr); hle.verified++;
          let bad = 0; for (let i = 0; i < after.length && !bad; i++) for (let j = 0; j < after[i][1].length; j++) if (after[i][1][j] !== nat[i][1][j]) { bad = 1; break; }
          if (bad) { hle.mismatches++; if (hle.mismatches <= 5) m.log('[hle] MISMATCH in call ' + hle.calls + ': mode ' + (mp ? H.rd32(mp) : 0) + ' format ' + [0x374, 0x376, 0x377, 0x378].map(o => U8[dst + o]).join('/')); }
        }
      }
      R[4] = (sp + 24) | 0; c.eip = ret;                  // ret 0x14
    }
    c.blocks[at - EMU.consts.IMG_BASE] = hook;
    hle.hook = hook; hle.orig = orig; hle.work = work;       // (work: for the tests, which ask whether a call would be done natively)
    return hle;
  }

  /** one line for the log: what was found, and whether it runs natively */
  function describe(h) {
    const parts = [];
    if (h.found) parts.push('the picture blender (' + h.variant + ') at 0x' + h.entry.toString(16));
    if (h.copyFound) parts.push('the colour-key copy at 0x' + h.copyEntry.toString(16));
    if (!parts.length) return h.note || 'no picture routine found';
    const one = parts.length === 1;
    return parts.join(' and ') + (h.enabled ? (one ? ' runs' : ' run') + ' natively' : (one ? ' is' : ' are') + ' left to the game');
  }

  EMU.Hle = { attach, describe, hashBlend, hashKeyCopy, BLEND_LEN, BLEND_HASH, BLEND_START, MMX_FLAG_AT, CALL_AT, BLEND_VARIANTS, KEYCOPY_LEN, KEYCOPY_HASH, KEYCOPY_START, KEYCOPY_MMX_AT,
    kernels: { blend555, blend565, blendBgr555, convert555, convertBits, convertKey, keyCopy16 } };
})(typeof globalThis !== 'undefined' ? globalThis : this);
