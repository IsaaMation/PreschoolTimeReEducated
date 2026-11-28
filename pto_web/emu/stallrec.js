/* Stall recorder (for ?debug and the test programs).
 *
 * The page shows a new picture each time the game comes back to its message loop (one "game tick").  When the game goes on for a long
 * time without doing that - loading a scene, a loop of its own, some very slow drawing - the picture stands still.  The recorder
 * notices that (STALL_MS of work without a tick) and notes what the game is doing meanwhile: how often each block of its code runs,
 * what called what (return addresses found on the stack), which Windows / DirectDraw / Miles / Bink functions it calls and how often,
 * what the picture blender did, and how much of the time went on downloads.  When the stall is over, and every five seconds while it
 * lasts, it writes a short report through log(); the addresses are those of DisneyPO.exe, so a report is enough to find the loop.
 *
 *   const rec = EMU.StallRecorder(m, log, { io: () => ({ req, held, waited }) });
 *   rec.after(ms, ticked, tid)  call after every slice of guest code: how long the slice took (ms), whether the game came back to its
 *                           message loop, or went to sleep, in it, and the id of the thread that ran the slice
 *   rec.end()               the game is exiting / was paused: close an open stall
 *   rec.reports             how many reports were written
 */
(function (G) {
  'use strict';
  const EMU = G.EMU = G.EMU || {};
  const hex = v => (v >>> 0).toString(16);

  function StallRecorder(m, log, opts) {
    opts = opts || {};
    const c = m.cpu, K = EMU.consts, lo = K.IMG_BASE, hi = K.IMG_BASE + K.IMG_SPAN;
    const STALL_MS = opts.stallMs || 400, MIN_REPORT_MS = opts.minReportMs || 700, MAX_REPORTS = opts.maxReports || 80;
    const clock = opts.now || (() => performance.now());
    let busy = 0, on = false, t0 = 0, v0 = 0, prof = null, rets = null, first = null, last = null, nSamples = 0, lastNote = 0;
    let watchPrev = null, trapsPrev = null, hle0 = null, io0 = null, depthMax = 0, byThread = null, slices = 0;
    const rec = { reports: 0, stalls: 0 };
    const watcher = { get(eip) { prof.set(eip, (prof.get(eip) | 0) + 1); return undefined; } };      // (the CPU asks this about every block it is about to run)

    /** return addresses found on the guest's stack, closest first: values that point into the program just after a call instruction */
    function chain() {
      const out = [], b = c.u8, sp = c.R[4] >>> 0;
      for (let i = 0; i < 600 && out.length < 24; i++) {
        const a = sp + 4 * i;
        if (a + 4 > b.length) break;
        const v = c.H.rd32(a) >>> 0;
        if (v < lo + 8 || v >= hi) continue;
        if (b[v - 5] === 0xe8 || b[v - 6] === 0xff || b[v - 2] === 0xff || b[v - 3] === 0xff) out.push(v);
      }
      return out;
    }
    const top = (map, n) => (map instanceof Map ? [...map.entries()] : Object.entries(map)).sort((a, b) => b[1] - a[1]).slice(0, n);

    function begin(ms) {
      on = true; rec.stalls++;
      t0 = clock() - ms; lastNote = clock(); depthMax = 0;
      prof = new Map(); rets = new Map(); first = last = null; nSamples = 0; byThread = new Map();
      slices = 0; watchPrev = c.watch; c.watch = watcher;
      trapsPrev = c.trapStats; c.trapStats = {};
      const h = m.hle;
      hle0 = h ? { calls: h.calls, pixels: h.pixels, declined: h.declined, byWhy: Object.assign({}, h.byWhy), copies: h.copies | 0, copyPixels: h.copyPixels | 0, copyDeclined: h.copyDeclined | 0, copyWhy: Object.assign({}, h.copyWhy) } : null;
      io0 = opts.io ? opts.io() : null;
    }
    function sample() {
      nSamples++;
      if (c.depth > depthMax) depthMax = c.depth;
      const ch = chain();
      for (let i = 0; i < ch.length && i < 10; i++) rets.set(ch[i], (rets.get(ch[i]) | 0) + 1);
      last = { eip: c.eip >>> 0, chain: ch };
      if (!first) first = last;
    }
    const fmtChain = s => s ? hex(s.eip) + (s.chain.length ? ' < ' + s.chain.slice(0, 12).map(hex).join(' < ') : '') : '-';

    function report(final) {
      if (rec.reports >= MAX_REPORTS) return;
      rec.reports++;
      const secs = (clock() - t0) / 1000;
      const thr = (m.threads ? m.threads.map(t => t.id + (t === m.cur ? '*' : '') + ':' + t.state).join(' ') : '?') + ' (time on each: ' + top(byThread, 4).map(([id, ms]) => id + ' ' + (ms / 1000).toFixed(1) + ' s').join(', ') + ')';
      let io = '';
      if (io0 && opts.io) { const n = opts.io(); io = ' · downloads ' + (n.req - io0.req) + ' (' + Math.round((n.held - io0.held) + (n.waited - io0.waited)) + ' ms waiting)'; }
      log('[stall] ' + secs.toFixed(1) + ' s of work without a game tick' + (final ? '' : ' (still going)') + ' · threads ' + thr + ' · nested depth ' + depthMax + io + ' · ' + nSamples + ' samples');
      log('[stall] code that ran most (block x times, one slice in three): ' + top(prof, 14).map(([a, n]) => hex(a) + ' x' + n).join(' · '));
      log('[stall] on the stack most often: ' + top(rets, 10).map(([a, n]) => hex(a) + ' x' + n).join(' · '));
      log('[stall] stack at the start: ' + fmtChain(first));
      log('[stall] stack at the end: ' + fmtChain(last));
      const calls = top(c.trapStats || {}, 14).map(([k, n]) => k + ' x' + n);
      log('[stall] calls: ' + (calls.length ? calls.join(' · ') : 'none'));
      const h = m.hle;
      if (h && hle0) {
        const why = Object.keys(h.byWhy).map(k => [k, h.byWhy[k] - (hle0.byWhy[k] | 0)]).filter(p => p[1] > 0).sort((a, b) => b[1] - a[1]).map(p => p[0] + ' x' + p[1]);
        log('[stall] pictures: ' + (h.calls - hle0.calls) + ' blended natively (' + ((h.pixels - hle0.pixels) / 1e6).toFixed(1) + ' Mpx), ' + (h.declined - hle0.declined) + ' left to the game' + (why.length ? ' (' + why.join(', ') + ')' : ''));
        if (h.copyFound) {
          const cwhy = Object.keys(h.copyWhy).map(k => [k, h.copyWhy[k] - (hle0.copyWhy[k] | 0)]).filter(p => p[1] > 0).sort((a, b) => b[1] - a[1]).map(p => p[0] + ' x' + p[1]);
          log('[stall] colour-key copies: ' + (h.copies - hle0.copies) + ' done natively (' + ((h.copyPixels - hle0.copyPixels) / 1e6).toFixed(1) + ' Mpx), ' + (h.copyDeclined - hle0.copyDeclined) + ' left to the game' + (cwhy.length ? ' (' + cwhy.join(', ') + ')' : ''));
        }
      }
    }
    function finish() {
      const ms = clock() - t0;
      on = false;
      try { if (ms >= MIN_REPORT_MS) report(true); } finally { c.watch = watchPrev; c.trapStats = trapsPrev; prof = rets = null; }
    }

    rec.after = (ms, ticked, tid) => {
      try {
        if (ticked) { if (on) finish(); busy = 0; return; }
        busy += ms;
        if (!on) { if (busy >= STALL_MS) begin(busy); return; }
        byThread.set(tid, (byThread.get(tid) || 0) + ms);
        sample();
        c.watch = (++slices % 3 === 0) ? watcher : watchPrev;         // (counting every block slows the game down: one slice in three is enough to see which code it is in)
        if (clock() - lastNote >= 5000) { lastNote = clock(); report(false); }
      } catch (e) { on = false; c.watch = watchPrev; c.trapStats = trapsPrev; log('[stall] recorder stopped: ' + (e && e.message)); rec.after = () => { }; }
    };
    rec.end = () => { try { if (on) finish(); } catch (e) { /* ignore */ } busy = 0; };
    return rec;
  }

  EMU.StallRecorder = StallRecorder;
})(typeof self !== 'undefined' ? self : globalThis);
