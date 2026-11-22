/* Playhouse Disney Preschool Time Online, browser port: page script.
 * Asks the emulator worker what the game files hold, lets the player pick a version and a lesson, then draws the frames the worker sends,
 * plays its sound and forwards mouse / keyboard input.
 * URL options: ?base=URL (game folder, default "game/")  ?edition=2.0.3  ?lesson=LP0316  ?debug (statistics and log)
 *   ?fixeddate=YYYY-MM-DD (the date the game sees; the player's own date by default)
 *   ?avoffset=MS  hold the picture back by MS more (or less, when negative) than the automatic setting, if the sound is not in step
 *   ?ruffle=URL  where Ruffle (the Flash player) is, default "ruffle/ruffle.js";  ?ruffle=off  never use it (Flash movies are skipped)
 *   ?flashrenderer=canvas|webgl|wgpu-webgl|webgpu  the graphics backend Ruffle is asked to use (it chooses itself by default): for a movie that shows white
 * The start card also has a Nickname field: the name the game shows instead of "Player". It is kept in this browser only (localStorage 'pto-nickname'). */
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const params = new URLSearchParams(location.search);
  const base = params.get('base') || 'game/';
  const debug = params.has('debug');
  const wantEdition = params.get('edition') || '', wantLesson = params.get('lesson') || '';

  const cvs = $('screen'), ctx = cvs.getContext('2d', { alpha: false }), stage = $('stage');
  let worker = null, actx = null, gain = null, sink = null, muted = false, analyser = null;
  let ready = false, over = false, rafId = 0, audioFrames = 0, framesShown = 0, flushSound = () => { };
  const logLines = [];
  const keepLines = [];                              // debug: the notes of the stall recorder and the like, kept even when the log scrolls on
  const soundLines = [];                             // debug: which voices played, how much of each was heard, and when the sound had to wait for the game (kept apart, so later lines do not push them out)
  const flashLines = [];                             // debug: what happened to each Flash movie, with the time (seconds since the page opened); part of "Copy log"
  const fnote = t => { if (!debug) return; flashLines.push((performance.now() / 1000).toFixed(1).padStart(7) + ' s  ' + t); if (flashLines.length > 300) flashLines.shift(); };
  let clipStats = [];
  const avA = [], avV = [];                           // debug: measured delay (ms) between the game producing a sound / picture and it being heard / seen
  const downKeys = new Set(); let buttons = 0;

  const setStatus = t => { $('status').textContent = t || ''; };

  /* ---------------------------------------------------------------------------------------- sound */
  /* Sound takes a while to get from the game to the speaker: the player keeps a little queued so that it never runs dry, and
   * the computer's sound system adds its own delay. The picture is held back by the time that was measured, so that a picture and
   * its sound arrive together. The worker stamps every piece of sound and every frame with the time it made it; the audio player
   * reports when the end of a piece is played, and the browser can say when that actually reaches the speaker. */
  const epochNow = () => performance.timeOrigin + performance.now();
  const lim = (v, a, b) => v < a ? a : v > b ? b : v;
  const median = a => { const b = a.slice().sort((x, y) => x - y); return b[b.length >> 1]; };
  const MAX_PICTURE_DELAY = 400;                       // ms
  const PICTURE_LAG = 45;                              // ms: a picture needs about 25 ms from this page to the screen (the sound's figure includes the speaker), and sound that is 20 ms late is not noticed
  const storedOffset = () => { try { return parseFloat(localStorage.getItem('pto-avoffset')); } catch (e) { return NaN; } };
  let pictureDelay = 0, soundDelay = 0, delayHist = [], lastNote = 0;
  let userOffset = params.has('avoffset') ? parseFloat(params.get('avoffset')) : storedOffset();
  if (!isFinite(userOffset)) userOffset = 0;
  userOffset = lim(Math.round(userOffset), -MAX_PICTURE_DELAY, MAX_PICTURE_DELAY);
  function applyDelay(now) {
    if (muted || !soundDelay) { pictureDelay = 0; return; }
    const want = lim(Math.round(soundDelay - PICTURE_LAG + userOffset), 0, MAX_PICTURE_DELAY);
    if (now || Math.abs(want - pictureDelay) >= 6 || (want === 0) !== (pictureDelay === 0)) pictureDelay = want;     // (ignore tiny wobble)
  }
  function noteSoundDelay(d) {                         // d: ms from the game making a sound to it coming out of the speaker
    if (!(d > 0 && d < 2000) || muted) return;         // (an old report from before a pause is not a measurement)
    delayHist.push(d); if (delayHist.length > 5) delayHist.shift();
    if (delayHist.length >= 3) { soundDelay = median(delayHist); applyDelay(); }
  }
  function soundOff() { soundDelay = 0; delayHist = []; pictureDelay = 0; }
  /** when the sound that the audio thread handled at context time c comes out of the speaker (page clock, ms) */
  function audibleAt(c) {
    const ts = actx.getOutputTimestamp ? actx.getOutputTimestamp() : null;
    if (ts && ts.performanceTime > 0) return performance.timeOrigin + ts.performanceTime + (c - ts.contextTime) * 1000;
    return epochNow() - (actx.currentTime - c) * 1000 + (actx.outputLatency || actx.baseLatency || 0) * 1000;
  }

  async function setupAudio() {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    actx = new AC({ latencyHint: 'interactive' });
    gain = actx.createGain(); gain.connect(actx.destination);
    const outLat = () => (actx.outputLatency || actx.baseLatency || 0) * 1000;
    if (actx.audioWorklet && window.AudioWorkletNode) {
      await actx.audioWorklet.addModule('audio-worklet.js');
      const node = new AudioWorkletNode(actx, 'pto-player', { numberOfInputs: 0, outputChannelCount: [2], processorOptions: { srcRate: 44100, report: debug ? 2 : 1 } });
      node.connect(gain);
      node.port.onmessage = e => {                     // "the end of the sound that the game made at time te has just been played"
        const k = e.data && e.data.played; if (!k) return;
        const d = audibleAt(k.ctx) - k.te;
        if (debug) { avA.push({ te: k.te, d, q: k.queued, tg: k.target, dries: k.dries, skips: k.skips, ex: k.excess, sp: k.speed }); if (avA.length > 8000) avA.shift(); }
        const t = performance.now(); if (t - lastNote >= 95) { lastNote = t; noteSoundDelay(d); }
      };
      if (debug) { analyser = actx.createAnalyser(); analyser.fftSize = 2048; node.connect(analyser); }
      sink = (a, te, keep) => node.port.postMessage({ samples: a, te, keep: !!keep }, [a.buffer]);
      flushSound = () => node.port.postMessage({ flush: true });
      soundDelay = 40 + 17 + 8 + outLat(); applyDelay();        // a first guess until the measurements come in
    } else {                                           // older browsers: the same kind of queue on the page thread
      const rate = 44100, step = rate / actx.sampleRate, cap = rate * 2, ring = new Float32Array(cap * 2), block = 2048;
      let wr = 0, rd = 0, buffering = true, keepEnd = 0;          // keepEnd: where the last piece with a voice in it ends (that is not thrown away)
      const sp = actx.createScriptProcessor(block, 0, 2);
      sp.onaudioprocess = e => {
        const L = e.outputBuffer.getChannelData(0), R = e.outputBuffer.getChannelData(1), n = L.length;
        if (buffering && wr - rd >= rate * 0.1) buffering = false;
        if (wr - rd > rate * 0.3 && (rd >= keepEnd || wr - rd > rate * 1.5)) rd = wr - rate * 0.1;
        for (let i = 0; i < n; i++) {
          const i0 = Math.floor(rd);
          if (buffering || i0 + 1 >= wr) { buffering = true; L[i] = 0; R[i] = 0; continue; }
          const f = rd - i0, a = (i0 % cap) * 2, b = ((i0 + 1) % cap) * 2;
          L[i] = ring[a] + (ring[b] - ring[a]) * f; R[i] = ring[a + 1] + (ring[b + 1] - ring[a + 1]) * f; rd += step;
        }
      };
      sp.connect(gain);
      sink = (a, te, keep) => { for (let i = 0; i < a.length >> 1; i++) { const o = (wr % cap) * 2; ring[o] = a[2 * i]; ring[o + 1] = a[2 * i + 1]; wr++; } if (keep) keepEnd = wr; if (wr - rd > cap - 1024) rd = wr - (cap - 1024); };
      flushSound = () => { wr = rd = keepEnd = 0; buffering = true; };
      setInterval(() => { if (!muted) noteSoundDelay((wr - rd) / rate * 1000 + block / actx.sampleRate * 1000 + outLat() + 17); }, 100);
    }
    if (actx.state === 'suspended') await actx.resume();
  }

  /* ---------------------------------------------------------------------------------------- picture */
  /* A frame is shown `pictureDelay` ms after the worker made it. When several are due at once only the newest is drawn. */
  const fq = [];                                       // frames waiting for their time, oldest first
  let lastDue = 0;
  const recycle = f => worker.postMessage({ type: 'recycle', buf: f.buf }, [f.buf]);
  function draw() {
    rafId = 0;
    const limit = epochNow() + 8;                      // (half a screen refresh early is as good as late)
    let f = null;
    while (fq.length && fq[0].due <= limit) { if (f) recycle(f); f = fq.shift(); }
    if (f) {
      if (cvs.width !== f.w || cvs.height !== f.h) { cvs.width = f.w; cvs.height = f.h; }
      ctx.putImageData(new ImageData(new Uint8ClampedArray(f.buf), f.w, f.h), 0, 0); framesShown++;
      if (debug && f.te) { avV.push({ te: f.te, d: epochNow() - f.te }); if (avV.length > 4000) avV.shift(); }
      recycle(f);
    }
    if (fq.length && !rafId) rafId = requestAnimationFrame(draw);
  }
  function onFrame(d) {
    d.due = lastDue = Math.max((d.te || epochNow()) + pictureDelay, lastDue);       // (never earlier than the frame before)
    fq.push(d);
    if (fq.length > 48) recycle(fq.shift());           // only if drawing has stopped for a long time
    if (!rafId) rafId = requestAnimationFrame(draw);
    if (!ready) { ready = true; $('overlay').classList.add('hide'); $('bar').classList.remove('hide'); cvs.focus(); }
  }

  /* ---------------------------------------------------------------------------------------- messages from the worker */
  function onMessage(ev) {
    const d = ev.data;
    switch (d.type) {
      case 'status': setStatus(d.text); break;
      case 'editions': showEditions(d); break;
      case 'frame': onFrame(d); break;
      case 'audio': audioFrames += d.samples.length >> 1; if (sink && !muted) sink(d.samples, d.te, d.keep); break;
      case 'log': for (const l of d.lines) { logLines.push(l); if (/^\[(stall|hle)\]/.test(l)) { keepLines.push(l); if (keepLines.length > 300) keepLines.shift(); } else if (/^\[sound\]/.test(l)) { soundLines.push(l); if (soundLines.length > 150) soundLines.shift(); } } if (logLines.length > 400) logLines.splice(0, logLines.length - 400); if (debug) { $('log').textContent = logLines.slice(-60).join('\n'); $('log').scrollTop = 1e9; } break;
      case 'stats': if (debug) $('hud').textContent = 'game ticks ' + d.tps + '/s · frames ' + d.fps + '/s · cpu ' + d.busy + '% · requests ' + d.requests + ' (' + d.mb + ' MB) · guest memory ' + d.heap + ' MB · hold-ups ' + (d.held + d.waited) + ' ms/s' + (d.blits ? ' · native blits ' + d.blits + '/s (' + d.mpx + ' Mpx/s)' : '') + (d.skipped ? ' · left to the game ' + d.skipped + '/s' : '') + (d.sw ? ' · sound fell behind the game by ' + d.sw + ' ms in all' : '') + ' · picture delay ' + pictureDelay + ' ms' + (d.clips && d.clips.length ? ' · clip sound ' + d.clips.map(c => 'late ' + c.late + ' skipped ' + c.trimmed + ' ms').join(', ') : ''); if (d.clips) clipStats = d.clips; break;
      case 'print': showPrint(d); break;
      case 'flash': onFlash(d.ev); break;
      case 'flashFile': onFlashFile(d); break;
      case 'error': problem(d); break;
      case 'exit': over = true; showOverlay('The game has closed.', 'Play again'); break;
      case 'wiped': location.reload(); break;
    }
  }
  function showOverlay(text, buttonText) {
    $('overlay').classList.remove('hide'); $('start').classList.remove('hide'); $('start').disabled = false; $('start').textContent = buttonText || 'Start';
    $('start').onclick = () => location.reload(); setStatus(text);
  }
  function problem(d) {
    over = true;
    $('overlay').classList.remove('hide'); $('start').classList.add('hide'); setStatus('');
    $('problem').style.display = 'block';
    $('problemText').textContent = d.user ? d.message : 'The game stopped because of an error in the emulator: ' + d.message;
    const detail = (d.user ? '' : (d.detail || '') + '\n\n') + 'Recent game log:\n' + logLines.slice(-40).join('\n') + '\n\n' + navigator.userAgent;
    $('problemDetail').textContent = detail;
    $('problemDetail').style.display = d.user ? 'none' : 'block';
    $('copyBtn').style.display = d.user ? 'none' : '';
    $('copyBtn').onclick = () => { navigator.clipboard && navigator.clipboard.writeText(d.message + '\n' + detail).then(() => { $('copyBtn').textContent = 'Copied'; }, () => { }); };
    $('reloadBtn').onclick = () => location.reload();
    if (actx) actx.suspend();
  }

  /* ---------------------------------------------------------------------------------------- Flash movies */
  /* Some scenes of the game are Flash movies. The emulator only keeps each movie's clock, so that the game knows when a movie is over;
   * showing the picture takes a real Flash player. Ruffle (open source, ruffle.rs) does that when its files are put next to this page,
   * in the folder ruffle/ (or elsewhere, with ?ruffle=URL of its ruffle.js). The worker tells us what the game does with a movie: this page
   * puts Ruffle's picture over the game screen while the movie plays, and tells the worker when the picture has started (the movie's
   * clock waits for that) or that it could not be shown. Without Ruffle the worker runs the clocks through quickly and the movies are skipped. */
  const flashLayer = $('flashLayer'), flashSkip = $('flashSkip'), noticeEl = $('notice');
  const ruffleParam = params.get('ruffle');
  const ruffleUrl = ruffleParam && ruffleParam !== 'off' ? ruffleParam : 'ruffle/ruffle.js';
  const rendererWanted = (params.get('flashrenderer') || '').toLowerCase();
  const rendererOpt = ['webgpu', 'wgpu-webgl', 'webgl', 'canvas'].includes(rendererWanted) ? { preferredRenderer: rendererWanted } : {};
  let ruffleReady = null, ruffleApi = null;
  function loadRuffle() {
    if (ruffleReady) return ruffleReady;
    if (ruffleParam === 'off') { ruffleReady = Promise.resolve(null); showFlashNote(); return ruffleReady; }
    return ruffleReady = new Promise(resolve => {
      let url; try { url = new URL(ruffleUrl, location.href); } catch (e) { resolve(null); return; }
      const RP = window.RufflePlayer = window.RufflePlayer || {};
      RP.config = Object.assign({ publicPath: new URL('.', url).href, polyfills: false }, RP.config);      // (no replacing of <embed> tags on this page)
      const sc = document.createElement('script');
      let t = 0;
      const done = ok => {
        clearTimeout(t); if (ruffleApi !== null) return;
        try { ruffleApi = ok && window.RufflePlayer && window.RufflePlayer.newest ? window.RufflePlayer.newest() : null; } catch (e) { ruffleApi = null; }
        if (ruffleApi && !ruffleApi.createPlayer) ruffleApi = null;
        resolve(ruffleApi); showFlashNote();
      };
      t = setTimeout(() => done(false), 15000);
      sc.onload = () => done(true); sc.onerror = () => done(false);
      sc.src = url.href; document.head.appendChild(sc);
    });
  }
  function showFlashNote() {
    const n = $('flashNote'); if (!n) return;
    n.textContent = ruffleApi ? (debug ? 'Flash movies are shown with Ruffle.' : '') : (ruffleParam === 'off' ? 'Flash movies are turned off: the game skips them.' : 'Flash movies: no Ruffle player was found next to this page, so the game will skip them (see the README).');
    n.classList.toggle('hide', !n.textContent);
  }
  const movies = new Map();                            // the game's movie windows: id -> { id, name, bytes, vars, rect, playing, visible, api, el, started }
  let noticeTimer = 0, noticed = false;
  function notice(text, ms) {
    noticeEl.textContent = text; noticeEl.classList.remove('hide');
    clearTimeout(noticeTimer); noticeTimer = setTimeout(() => noticeEl.classList.add('hide'), ms || 9000);
  }
  const movieFile = n => (n && n !== '(memory)') ? String(n).split(/[\\/]/).pop() : 'movie.swf';
  const sent = [];                                     // debug: what was sent to the worker about movies
  const post = m => { if (debug) { sent.push(m); if (sent.length > 100) sent.shift(); } if (worker) worker.postMessage(m); };
  const seen = [];                                     // debug: what happened to each movie, and when (ms since the page opened)
  function rec(mv, k, extra) {
    if (!debug) return;
    let r = null; for (let i = seen.length - 1; i >= 0; i--) if (seen[i].id === mv.id && !seen[i].closed) { r = seen[i]; break; }
    if (!r) seen.push(r = { id: mv.id, name: mv.name });
    if (r[k] === undefined) r[k] = Math.round(performance.now());
    if (k === 'close') r.closed = true;
    if (extra) Object.assign(r, extra);
  }
  function onFlash(ev) {
    if (!ev) return;
    let mv = movies.get(ev.id);
    if (debug) logLines.push('[page] flash ' + ev.op + ' ' + (ev.id >>> 0).toString(16) + (ev.name ? ' ' + ev.name : ''));
    if (ev.op !== 'load') fnote('movie ' + hex(ev.id) + ' ' + ev.op + (ev.op === 'show' ? (ev.visible ? ' (visible)' : ' (hidden)') : '') + (ev.op === 'goto' ? ' frame ' + ev.frame : '') + (mv ? '' : ' (no such movie yet)') + (ev.rect && ev.op !== 'close' ? ' window ' + [ev.rect.x, ev.rect.y, ev.rect.w, ev.rect.h].join(',') : ''));
    switch (ev.op) {
      case 'load': {
        if (mv) closeMovie(mv);
        movies.set(ev.id, mv = { id: ev.id, name: movieFile(ev.name), src: ev.src || '', modal: !!ev.modal, bytes: ev.bytes || null, vars: ev.vars || '', interactive: !!ev.interactive, rect: ev.rect || null, playing: false, visible: !ev.rect || ev.rect.visible !== false, api: null, el: null, started: false, timer: 0, t0: performance.now() });
        rec(mv, 'load');
        const i = ev.info;
        fnote('movie ' + hex(ev.id) + ' "' + mv.name + '" arrives: ' + (ev.bytes ? ev.bytes.byteLength : 0) + ' bytes, '
          + (ev.interactive ? 'interactive (started through the control\'s calls)' : ev.modal ? 'an application (the game waits for its Back button)' : 'a movie (the game watches its frame)')
          + (mv.src ? ', file ' + mv.src : ', file not known')
          + (i ? '; swf v' + i.version + ' ' + i.width + 'x' + i.height + ', ' + i.frames + ' frames at ' + i.fps + ' fps' : '; header not readable')
          + (ev.rect ? '; window ' + [ev.rect.x, ev.rect.y, ev.rect.w, ev.rect.h].join(',') + (ev.rect.visible === false ? ' (hidden)' : '') : ''));
        break;
      }
      case 'play': if (mv) { mv.playing = true; rec(mv, 'play'); if (ev.rect) { mv.rect = ev.rect; mv.visible = ev.rect.visible !== false; } showMovie(mv); } break;
      case 'show': if (mv) { if (ev.rect) mv.rect = ev.rect; mv.visible = !!ev.visible; if (mv.visible) showMovie(mv); else hideMovie(mv); } break;
      case 'stop': if (mv) { mv.playing = false; setPaused(mv, true); } break;
      case 'goto': if (mv && mv.api && mv.started && ev.frame === 0 && mv.playing) restartMovie(mv); break;
      case 'close': if (mv) { rec(mv, 'close'); fnote('movie ' + hex(mv.id) + ' closed by the game' + (mv.skipAt ? ' ' + Math.round(performance.now() - mv.skipAt) + ' ms after the skip' : '') + (mv.t0 ? ', ' + Math.round((performance.now() - mv.t0) / 100) / 10 + ' s after it arrived' : '')); closeMovie(mv); movies.delete(ev.id); } break;
    }
  }
  function showMovie(mv) {
    if (!mv.playing || !mv.visible) return;
    if (mv.interactive) {                              // an application that talks to the game: not connected yet, the worker runs it through quickly
      if (!noticed) { noticed = true; notice('This part of the game is an interactive Flash application, which this player cannot run yet, so it is skipped.'); }
      return;
    }
    if (!ruffleApi) {                                  // nothing can show it: the worker runs its clock through quickly
      if (!noticed) { noticed = true; notice(ruffleParam === 'off' ? 'This part of the game is a Flash movie. Flash movies are turned off, so it is skipped.' : 'This part of the game is a Flash movie. No Ruffle player was found next to this page, so it is skipped.'); }
      return;
    }
    if (!mv.bytes) { post({ type: 'flashFailed', id: mv.id }); return; }       // the game named a movie that is not there
    if (mv.api) {                                      // already loaded: it was paused or hidden
      mv.hidden = false; mv.el.style.display = ''; setPaused(mv, false); layoutMovie(mv); post({ type: 'flashStarted', id: mv.id }); return;
    }
    if (warmState === 'failed') { failMovie(mv, new Error('Ruffle could not be started on this page')); return; }
    let el, api;
    try {
      el = ruffleApi.createPlayer(); api = el.ruffle ? el.ruffle() : el;
    } catch (e) { failMovie(mv, e); return; }
    mv.el = el; mv.api = api; el.classList.add('flashMovie');
    quietPlayer(el);
    flashLayer.appendChild(el); layoutMovie(mv);
    let settled = false;
    const ok = () => {
      if (settled) return; settled = true; clearTimeout(mv.timer); mv.started = true;
      let meta = null; try { meta = JSON.parse(JSON.stringify(api.metadata || null)); } catch (e) { /* ignore */ }
      rec(mv, 'started', { meta }); post({ type: 'flashStarted', id: mv.id });
      fnote('movie ' + hex(mv.id) + ' started in Ruffle after ' + Math.round(performance.now() - (mv.t0 || performance.now())) + ' ms' + (meta ? '; Ruffle reads: ' + JSON.stringify(meta).slice(0, 300) : ''));
    };
    // (Ruffle only takes a volume once the movie is loaded, and a restarted movie begins at full volume again: set it at every load)
    el.addEventListener('loadedmetadata', () => { try { api.volume = muted ? 0 : 1; } catch (e) { /* ignore */ } ok(); });
    mv.timer = setTimeout(() => { if (!settled) { settled = true; failMovie(mv, new Error('Ruffle did not start the movie')); } }, warmState === 'loading' ? 40000 : 8000);
    try {
      const r = api.load({
        data: mv.bytes, swfFileName: mv.name, base: FLASH_FILES + dirOf(mv.src), autoplay: 'on', unmuteOverlay: 'visible', splashScreen: false, preloader: false, letterbox: 'on',
        contextMenu: 'off', warnOnUnsupportedContent: false, openUrlMode: 'deny', showSwfDownload: false, parameters: mv.vars || undefined, ...rendererOpt,
      });
      if (r && r.catch) r.catch(e => { if (!settled) { settled = true; clearTimeout(mv.timer); failMovie(mv, e); } });
    } catch (e) { settled = true; clearTimeout(mv.timer); failMovie(mv, e); return; }
  }
  /** Ruffle's own boxes (the hardware-acceleration warning, the save manager, the right-click menu, the play button) have no place over this game */
  function quietPlayer(el) {
    try {
      const sr = el.shadowRoot; if (!sr) return;
      const st = document.createElement('style');
      st.textContent = '#hardware-acceleration-modal, #video-modal, #clipboard-modal, #save-manager, #volume-controls-modal, #context-menu-overlay, #play-button { display: none !important; }';
      sr.appendChild(st);
    } catch (e) { /* ignore */ }
  }
  /* Ruffle is a 14 MB program: it is loaded and started once in advance (when the game starts, long before the first movie), by showing a
   * tiny empty movie out of sight, so that the first real movie does not wait for the download. */
  let warmState = 'idle';                              // idle | loading | ready | failed
  const TINY_SWF = Uint8Array.from(atob('RldTCBcAAABgADIAADIAAAwBAEAAAAA='), c => c.charCodeAt(0));
  function warmRuffle() {
    if (warmState !== 'idle' || !ruffleApi) return;
    warmState = 'loading';
    if (rendererOpt.preferredRenderer) fnote('Ruffle is asked to use the "' + rendererOpt.preferredRenderer + '" graphics backend (?flashrenderer)');
    const box = document.createElement('div');
    box.style.cssText = 'position:fixed;left:-200px;top:0;width:64px;height:64px;overflow:hidden;opacity:0;pointer-events:none';
    let el, done = false, t = 0;
    const finish = good => {
      if (done) return; done = true; clearTimeout(t);
      warmState = good ? 'ready' : 'failed';
      if (!good) logLines.push('[page] Ruffle could not be started; Flash movies will be skipped');
      try { box.remove(); } catch (e) { /* ignore */ }
    };
    try {
      el = ruffleApi.createPlayer(); const api = el.ruffle ? el.ruffle() : el;
      quietPlayer(el); box.appendChild(el); document.body.appendChild(box);
      el.addEventListener('loadedmetadata', () => finish(true));
      t = setTimeout(() => finish(false), 120000);
      const r = api.load({ data: TINY_SWF, swfFileName: 'warmup.swf', autoplay: 'off', unmuteOverlay: 'hidden', splashScreen: false, preloader: false, contextMenu: 'off', warnOnUnsupportedContent: false, openUrlMode: 'deny', ...rendererOpt });
      if (r && r.catch) r.catch(() => finish(false));
    } catch (e) { finish(false); }
  }
  function failMovie(mv, e) {
    logLines.push('[page] Ruffle could not show "' + mv.name + '": ' + (e && e.message || e));
    fnote('Ruffle could not show movie ' + hex(mv.id) + ' "' + mv.name + '": ' + (e && e.message || e) + ' (the game is told to skip it)');
    if (!noticed) { noticed = true; notice('A Flash movie could not be shown and was skipped.'); }
    const id = mv.id; rec(mv, 'failed'); closeMovie(mv, true); mv.bytes = null; post({ type: 'flashFailed', id });
  }
  function restartMovie(mv) {
    try { const r = mv.api.reload(); if (r && r.catch) r.catch(() => { }); } catch (e) { /* ignore */ }
  }
  function setPaused(mv, pause) {                      // (Ruffle's current API suspends and resumes a movie; its old element API plays and pauses)
    const a = mv.api, el = mv.el; if (!a) return;
    try {
      if (pause) { if (a.suspend) a.suspend(); else if (el.pause) el.pause(); }
      else if (a.resume) a.resume(); else if (el.play) el.play();
    } catch (e) { /* ignore */ }
  }
  /** puts the movie's picture where the game's window for it is (the whole screen for nearly all movies) */
  function layoutMovie(mv) {
    const r = mv.rect, W = cvs.width, H = cvs.height;
    const whole = !r || r.w <= 0 || r.h <= 0 || (r.x <= 1 && r.y <= 1 && r.w >= W - 2 && r.h >= H - 2);
    mv.whole = whole;
    const st = mv.el.style;
    if (whole) { st.left = st.top = '0'; st.width = st.height = '100%'; }
    else {
      const a = stage.getBoundingClientRect(), c = cvs.getBoundingClientRect(), k = c.width / W;
      st.left = (c.left - a.left + r.x * k) + 'px'; st.top = (c.top - a.top + r.y * k) + 'px'; st.width = (r.w * k) + 'px'; st.height = (r.h * k) + 'px';
    }
    flashChanged();
  }
  function hideMovie(mv) { setPaused(mv, true); if (mv.el) mv.el.style.display = 'none'; mv.hidden = true; flashChanged(); }
  function closeMovie(mv, keepRecord) {
    clearTimeout(mv.timer); clearTimeout(mv.skipTimer);
    if (mv.el) { try { mv.el.remove(); } catch (e) { /* ignore */ } }
    mv.el = mv.api = null; mv.started = false;
    if (!keepRecord) mv.bytes = null;
    flashChanged();
  }
  /** the layer is only there while a movie is on show */
  function flashChanged() {
    let shown = 0, whole = false;
    for (const mv of movies.values()) if (mv.el && !mv.hidden) { shown++; if (mv.whole) whole = true; }
    const was = !flashLayer.classList.contains('hide');
    flashLayer.classList.toggle('hide', !shown); flashSkip.classList.toggle('hide', !shown);
    let app = false; for (const mv of movies.values()) if (mv.el && !mv.hidden && mv.modal) app = true;
    flashSkip.textContent = app ? 'Back' : 'Skip movie';                                  // (an application ends like the game's own Back button does)
    flashLayer.style.background = whole ? '#000' : 'transparent'; flashLayer.style.pointerEvents = whole ? '' : 'none';
    if (shown && !was) { releaseAll(); noticeEl.classList.add('hide'); }
    if (!shown && was && ready && !over) cvs.focus();
  }
  /* ---- a Flash application loads more files by relative address (a menu that loads its games, a book that loads its pages ...). The real
   * control found them in the game's folders next to the movie; Ruffle only knows this page's web server, which has none of them.  So each
   * movie is given a base address below `flashfiles/` on this page (in the folder its own file is in, when the game said which file it
   * was), and the page answers requests for such addresses itself: it asks the worker, which looks the file up in the game's data. */
  const FLASH_FILES = new URL('flashfiles/', document.baseURI).href;
  const flashReq = new Map(); let flashReqN = 0, fetchWrapped = false;
  const hex = id => (id >>> 0).toString(16);
  const dirOf = k => { const i = (k || '').lastIndexOf('/'); return i < 0 ? '' : k.slice(0, i + 1); };
  const MIME = { swf: 'application/x-shockwave-flash', xml: 'text/xml', txt: 'text/plain', mp3: 'audio/mpeg', wav: 'audio/wav', flv: 'video/x-flv', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif' };
  const mimeOf = p => { const x = /\.([a-z0-9]+)$/i.exec(p); return (x && MIME[x[1].toLowerCase()]) || 'application/octet-stream'; };
  const withUrl = (resp, url) => { try { Object.defineProperty(resp, 'url', { value: url }); } catch (e) { /* ignore */ } return resp; };
  function newestMovieSrc() { let s = ''; for (const mv of movies.values()) if (mv.src) s = mv.src; return s; }
  function flashFileResponse(url) {
    const path = url.slice(FLASH_FILES.length).split('#')[0].split('?')[0];
    return new Promise(resolve => {
      const req = ++flashReqN;
      const t = setTimeout(() => { flashReq.delete(req); fnote('file "' + path + '": no answer from the game within 20 s'); resolve(withUrl(new Response('', { status: 504, statusText: 'No answer' }), url)); }, 20000);
      flashReq.set(req, { resolve, url, path, t, t0: performance.now() });
      post({ type: 'flashFile', req, path, from: newestMovieSrc() });
    });
  }
  function onFlashFile(d) {
    const r = flashReq.get(d.req); if (!r) return;
    flashReq.delete(d.req); clearTimeout(r.t);
    const ms = Math.round(performance.now() - r.t0);
    if (!d.bytes) { fnote('file "' + r.path + '": not in the game\'s data (' + ms + ' ms)'); r.resolve(withUrl(new Response('not found', { status: 404, statusText: 'Not Found' }), r.url)); return; }
    fnote('file "' + r.path + '": served from the game\'s data as ' + d.key + ', ' + d.bytes.byteLength + ' bytes (' + ms + ' ms)');
    r.resolve(withUrl(new Response(d.bytes, { status: 200, headers: { 'Content-Type': mimeOf(r.path), 'Content-Length': String(d.bytes.byteLength) } }), r.url));
  }
  /** Ruffle fetches through window.fetch (looked up at every call), so wrapping it is enough; everything else goes on to the real fetch */
  function wrapFetch() {
    if (fetchWrapped || typeof window.fetch !== 'function') return; fetchWrapped = true;
    const real = window.fetch;
    window.fetch = function (input, init) {
      let url = ''; try { url = typeof input === 'string' ? input : (input && input.url) || String(input); } catch (e) { /* ignore */ }
      if (url.startsWith(FLASH_FILES)) return flashFileResponse(url);
      const p = real.apply(this, arguments);
      if (debug && movies.size && url && !/\.(wasm|js|map)([?#]|$)/i.test(url)) p.then(r => fnote('fetch ' + url.slice(0, 160) + ' -> ' + r.status), e => fnote('fetch ' + url.slice(0, 160) + ' failed: ' + (e && e.message || e)));
      return p;
    };
  }
  /** (?debug) what Ruffle says on the console while movies are up: problems with a movie show up there first */
  let lastConsole = '', lastConsoleN = 0, consoleLines = 0;
  function noteConsole(kind, args) {
    let t = args.map(a => typeof a === 'string' ? a : (a && a.message) || String(a)).join(' ').replace(/%c/g, '').replace(/\s+/g, ' ').trim();
    if (!t) return;
    if (kind === 'log' || kind === 'info') { if (!/ruffle|render|webgl|webgpu|canvas|swf|avm|flash|unimplemented|error|fail|denied|security|load/i.test(t) || consoleLines > 250) return; }
    else if (consoleLines > 400) return;
    t = t.slice(0, 300);
    if (t === lastConsole) { lastConsoleN++; return; }
    if (lastConsoleN) fnote('   (the line above repeated ' + lastConsoleN + ' more times)');
    lastConsole = t; lastConsoleN = 0; consoleLines++;
    fnote('console.' + kind + ': ' + t);
  }
  if (debug) for (const k of ['warn', 'error', 'info', 'log']) {
    const orig = console[k];
    console[k] = function () { try { if (movies.size || warmState === 'loading') noteConsole(k, Array.from(arguments)); } catch (e) { /* ignore */ } return orig.apply(this, arguments); };
  }

  /* Skip / Back. A movie the game watches by its frame ends as soon as the worker says it is on its last frame. An application (a menu or a
   * book: the game runs a loop of its own around it) ends when the worker sets the flag that the game's own Back button sets. Either way the
   * game has to notice, which takes a moment; if it has not closed the movie's window after a few seconds the picture is hidden anyway, so
   * that what is under it (the game's own screen, with its Back button) can be used. */
  const flashShown = () => { for (const mv of movies.values()) if (mv.el && !mv.hidden) return true; return false; };
  function skipMovies(how) {
    let n = 0;
    for (const mv of movies.values()) if (mv.el && !mv.hidden) {
      n++; rec(mv, 'skip'); mv.skipAt = performance.now();
      fnote(how + ': movie ' + hex(mv.id) + ' "' + mv.name + '"' + (mv.modal ? ' (an application: asks the game to end it)' : '') + ', ' + Math.round((mv.skipAt - (mv.t0 || mv.skipAt)) / 100) / 10 + ' s after it arrived');
      post({ type: 'flashSkip', id: mv.id });
      clearTimeout(mv.skipTimer);
      mv.skipTimer = setTimeout(() => {
        if (movies.get(mv.id) !== mv || !mv.el || mv.hidden) return;          // (it has ended)
        fnote('the game has not closed movie ' + hex(mv.id) + ' 2.5 s after the skip: its picture is hidden');
        hideMovie(mv);
        notice('The game did not end that part by itself. Its picture is hidden; use the game\'s own Back button if it shows one.', 7000);
      }, 2500);
    }
    return n;
  }
  flashSkip.onclick = () => { skipMovies('Skip pressed'); cvs.focus(); };
  wrapFetch();
  const flashRelayout = () => { for (const mv of movies.values()) if (mv.el && !mv.whole) layoutMovie(mv); };
  window.addEventListener('resize', flashRelayout);
  document.addEventListener('fullscreenchange', () => { flashRelayout(); setTimeout(flashRelayout, 200); });
  /** the page was hidden or shown again: the movies wait with the game */
  function flashVisible(visible) { for (const mv of movies.values()) if (mv.api && mv.playing && !mv.hidden) setPaused(mv, !visible); }
  function flashVolume(on) { for (const mv of movies.values()) if (mv.api) { try { mv.api.volume = on ? 1 : 0; } catch (e) { /* ignore */ } } }
  loadRuffle();

  /* ---------------------------------------------------------------------------------------- choosing what to play */
  const CHOICE_KEY = 'pto-choice';
  let editions = [], chosen = null;
  const mb = n => n >= 1e9 ? (n / 1073741824).toFixed(1) + ' GB' : (n / 1048576).toFixed(n >= 104857600 ? 0 : 1) + ' MB';
  const lastChoice = () => { try { return JSON.parse(localStorage.getItem(CHOICE_KEY)) || {}; } catch (e) { return {}; } };
  /* The nickname: what the game shows where it would say "Player" ("Good Job, Nick!"). It is only a local nickname: it is kept in this
   * browser (localStorage), handed to the worker, whose stand-in server gives it to the game, and goes nowhere else. */
  const NICK_KEY = 'pto-nickname';
  const cleanNickname = s => {                         // the same rule as the stand-in server's (emu/server.js): plain letters and digits, at most 12
    let t = String(s == null ? '' : s);
    try { t = t.normalize('NFD'); } catch (e) { /* as it is */ }
    t = t.replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, ' ').replace(/[^A-Za-z0-9 '.\-]/g, '').replace(/ {2,}/g, ' ').trim();       // (any white space, a pasted non-breaking space too, counts as a space)
    return t.slice(0, 12).trim();
  };
  const savedNick = () => { try { return cleanNickname(localStorage.getItem(NICK_KEY)); } catch (e) { return ''; } };
  const keepNick = v => { try { if (v) localStorage.setItem(NICK_KEY, v); else localStorage.removeItem(NICK_KEY); } catch (e) { /* not kept */ } };
  const nick = $('nickname');
  nick.value = savedNick();
  nick.onchange = () => { const v = cleanNickname(nick.value); nick.value = v; keepNick(v); };      // (what the field shows afterwards is what the game will get)
  nick.onkeydown = e => {                              // Enter in the field is the Start button
    const b = $('start');
    if (e.key === 'Enter' && !e.isComposing && !b.disabled && !b.classList.contains('hide')) { e.preventDefault(); nick.onchange(); b.click(); }
  };
  function fillLessons() {
    const ed = editions.find(e => e.id === $('version').value), sel = $('lesson');
    sel.textContent = '';
    if (!ed) return;
    for (const l of ed.lessons) {
      const o = document.createElement('option'); o.value = l.id; o.textContent = l.id + (l.size ? '  (' + mb(l.size) + ')' : '  (included)'); sel.appendChild(o);
    }
    const want = (chosen && chosen.edition === ed.id && chosen.lesson) || (wantEdition === ed.id && wantLesson) || '';
    if (want && ed.lessons.some(l => l.id === want)) sel.value = want;
    sel.disabled = !ed.ready || ed.lessons.length < 2;
    const note = $('versionNote');
    note.classList.toggle('warn', !ed.ready || (ed.notes && ed.notes.length > 0));
    note.textContent = (ed.notes || []).join(' ') || (ed.lessons.length > 1 ? ed.lessons.length + ' lessons are available in this version.' : '');
    $('start').disabled = !ed.ready;
  }
  function showEditions(d) {
    editions = d.editions || [];
    const sel = $('version'), last = lastChoice();
    chosen = wantEdition ? { edition: wantEdition, lesson: wantLesson } : last;
    sel.textContent = '';
    for (const ed of editions) { const o = document.createElement('option'); o.value = ed.id; o.textContent = ed.id + (ed.ready ? '' : ' (files incomplete)'); sel.appendChild(o); }
    const firstReady = editions.slice().reverse().find(e => e.ready);          // the newest version that can be played
    const pref = editions.find(e => e.id === (chosen && chosen.edition) && e.ready) || firstReady || editions[0];
    if (pref) sel.value = pref.id;
    fillLessons();
    // what was found
    const fl = $('fileList'); fl.textContent = '';
    for (const f of d.files || []) { const li = document.createElement('li'); li.textContent = f.name + (f.missing ? ' (not found)' : ' (' + mb(f.size) + ')' + (f.local ? ', from this computer' : '')); if (f.missing) li.className = 'miss'; fl.appendChild(li); }
    for (const n of d.notes || []) { const li = document.createElement('li'); li.textContent = n; fl.appendChild(li); }
    $('files').classList.toggle('hide', !(d.files && d.files.length) && !(d.notes && d.notes.length));
    $('filesSummary').textContent = (d.files || []).filter(f => !f.missing).length + ' file(s) found' + ((d.notes || []).length ? ', ' + d.notes.length + ' note(s)' : '');
    const ok = editions.some(e => e.ready);
    $('choose').classList.toggle('hide', !editions.length);
    setStatus(ok ? '' : (editions.length ? 'The files found do not make up a complete game yet. Add the missing ones below.' : 'No game files were found. Put them in the game/ folder of this server, or use the button below to pick files from your computer.'));
    if (!editions.length) $('files').open = true;
  }
  $('version').onchange = () => { chosen = null; fillLessons(); };

  /* ---------------------------------------------------------------------------------------- start */
  function newWorker() {
    worker = new Worker('worker.js');
    worker.onmessage = onMessage;
    worker.onerror = e => problem({ message: e.message || 'The worker could not be started.', detail: (e.filename || '') + ':' + (e.lineno || '') });
  }
  async function start() {
    const edition = $('version').value, lesson = $('lesson').value;
    const nickname = cleanNickname(nick.value); nick.value = nickname; keepNick(nickname);
    $('start').disabled = true; $('version').disabled = true; $('lesson').disabled = true; nick.disabled = true; setStatus('Starting…');
    try { localStorage.setItem(CHOICE_KEY, JSON.stringify({ edition, lesson })); } catch (e) { /* not kept */ }
    try { await setupAudio(); } catch (e) { sink = null; logLines.push('[page] sound unavailable: ' + e.message); }
    await loadRuffle();                                 // (started when the page opened; normally long done)
    worker.postMessage({ type: 'init', edition, lessons: lesson ? [lesson] : [], nickname, debug, nocomp: debug && params.has('nocomp'), nohle: debug && params.get('hle') === 'off', threads: debug ? params.get('threads') || '' : '', fixedDate: params.get('fixeddate') || '', flash: ruffleApi ? 'ruffle' : 'none' });
    if (debug) { $('log').style.display = 'block'; $('copyLogBtn').classList.remove('hide'); }
    warmRuffle();
  }
  $('start').onclick = start;
  newWorker();
  worker.postMessage({ type: 'scan', base, debug });

  /* files from this computer: chosen with the button or dropped on the page */
  function addLocal(list) {
    const files = [...list].filter(f => /\.(exe|zip)$/i.test(f.name));
    if (!files.length || !worker || ready) return;
    setStatus('Reading ' + files.length + ' file(s)…');
    worker.postMessage({ type: 'addFiles', files });
  }
  $('pick').onchange = e => { addLocal(e.target.files); e.target.value = ''; };
  let dragDepth = 0;
  const hasFiles = e => e.dataTransfer && [...(e.dataTransfer.types || [])].indexOf('Files') >= 0;
  window.addEventListener('dragenter', e => { if (!hasFiles(e) || ready) return; dragDepth++; document.body.classList.add('dragging'); e.preventDefault(); });
  window.addEventListener('dragover', e => { if (hasFiles(e)) e.preventDefault(); });
  window.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; document.body.classList.remove('dragging'); } });
  window.addEventListener('drop', e => { if (!hasFiles(e)) return; e.preventDefault(); dragDepth = 0; document.body.classList.remove('dragging'); addLocal(e.dataTransfer.files); });

  /* ---------------------------------------------------------------------------------------- input */
  const send = ev => { if (worker && ready && !over && !printOpen()) worker.postMessage({ type: 'input', ev }); };
  const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
  function gamePos(e) {
    const r = cvs.getBoundingClientRect();
    return { x: clamp(Math.floor((e.clientX - r.left) * cvs.width / r.width), 0, cvs.width - 1), y: clamp(Math.floor((e.clientY - r.top) * cvs.height / r.height), 0, cvs.height - 1) };
  }
  cvs.addEventListener('pointermove', e => { send(Object.assign({ type: 'mousemove' }, gamePos(e))); });
  cvs.addEventListener('pointerdown', e => {
    if (e.button > 2) return;
    try { cvs.setPointerCapture(e.pointerId); } catch (x) { /* ignore */ }
    const p = gamePos(e), b = e.button === 2 ? 2 : 0;
    send(Object.assign({ type: 'mousemove' }, p));
    buttons |= 1 << b; send(Object.assign({ type: 'mousedown', button: b }, p));
    if (document.activeElement !== kb) cvs.focus();
    e.preventDefault();
  });
  const up = e => {
    if (e.button > 2) return;
    const p = gamePos(e), b = e.button === 2 ? 2 : 0;
    if (!(buttons & (1 << b))) return;
    buttons &= ~(1 << b); send(Object.assign({ type: 'mouseup', button: b }, p)); e.preventDefault();
  };
  cvs.addEventListener('pointerup', up);
  cvs.addEventListener('pointercancel', up);
  cvs.addEventListener('contextmenu', e => e.preventDefault());

  /* ---- keyboard. The game takes Esc ("Press Escape to Skip"), the space bar and typed characters from Windows' character messages,
   * which the emulator makes from each key press. So each key press carries the character the browser produced for it (any keyboard
   * layout works), the Windows virtual-key code, the scan code and the lock-key states. */
  const PREVENT = new Set([8, 9, 13, 27, 32, 33, 34, 35, 36, 37, 38, 39, 40, 46]);
  const FIXVK = { 59: 0xBA, 61: 0xBB, 173: 0xBD };                       // Firefox numbers ; = - differently from Windows
  const CP1252 = { 0x20AC: 0x80, 0x201A: 0x82, 0x0192: 0x83, 0x201E: 0x84, 0x2026: 0x85, 0x2020: 0x86, 0x2021: 0x87, 0x02C6: 0x88, 0x2030: 0x89, 0x0160: 0x8A, 0x2039: 0x8B, 0x0152: 0x8C, 0x017D: 0x8E, 0x2018: 0x91, 0x2019: 0x92, 0x201C: 0x93, 0x201D: 0x94, 0x2022: 0x95, 0x2013: 0x96, 0x2014: 0x97, 0x02DC: 0x98, 0x2122: 0x99, 0x0161: 0x9A, 0x203A: 0x9B, 0x0153: 0x9C, 0x017E: 0x9E, 0x0178: 0x9F };
  const toAnsi = u => (u < 0x80 || (u >= 0xA0 && u < 0x100)) ? u : (CP1252[u] || 0);   // the game works with the Windows ANSI code page
  const SC = {};
  ('Escape,Digit1,Digit2,Digit3,Digit4,Digit5,Digit6,Digit7,Digit8,Digit9,Digit0,Minus,Equal,Backspace,Tab,KeyQ,KeyW,KeyE,KeyR,KeyT,KeyY,KeyU,KeyI,KeyO,KeyP,BracketLeft,BracketRight,Enter,ControlLeft,KeyA,KeyS,KeyD,KeyF,KeyG,KeyH,KeyJ,KeyK,KeyL,Semicolon,Quote,Backquote,ShiftLeft,Backslash,KeyZ,KeyX,KeyC,KeyV,KeyB,KeyN,KeyM,Comma,Period,Slash,ShiftRight,NumpadMultiply,AltLeft,Space,CapsLock,F1,F2,F3,F4,F5,F6,F7,F8,F9,F10,NumLock,ScrollLock,Numpad7,Numpad8,Numpad9,NumpadSubtract,Numpad4,Numpad5,Numpad6,NumpadAdd,Numpad1,Numpad2,Numpad3,Numpad0,NumpadDecimal').split(',').forEach((n, i) => { SC[n] = i + 1; });
  SC.F11 = 87; SC.F12 = 88;
  const EXT = { ControlRight: 29, AltRight: 56, NumpadEnter: 28, NumpadDivide: 53, Home: 71, ArrowUp: 72, PageUp: 73, ArrowLeft: 75, ArrowRight: 77, End: 79, ArrowDown: 80, PageDown: 81, Insert: 82, Delete: 83 };
  const keyFields = e => {
    const vk = FIXVK[e.keyCode & 255] || (e.keyCode & 255);
    let scan = SC[e.code] || 0, ext = 0;
    if (!scan && EXT[e.code]) { scan = EXT[e.code]; ext = 1; }
    return { vk, scan, ext, caps: e.getModifierState('CapsLock'), num: e.getModifierState('NumLock') };
  };
  const kb = $('kb'), kbBtn = $('kbBtn');
  document.addEventListener('keydown', e => {
    if (printOpen()) { if (e.key === 'Escape') closePrint(); return; }
    if (e.key === 'Escape' && !e.repeat && flashShown()) skipMovies('Esc pressed');                  // (the game gets the key too, as before)
    if (!ready || over || e.target === kb || e.isComposing || e.keyCode === 229) return;
    if (e.target && e.target.tagName === 'INPUT') return;                                           // the timing slider uses its own keys
    if (e.metaKey || ((e.ctrlKey || e.altKey) && !e.getModifierState('AltGraph'))) return;          // browser / system shortcuts (AltGr makes characters)
    if (e.target && e.target.tagName === 'BUTTON' && (e.key === ' ' || e.key === 'Enter')) return;   // let the page's own buttons work
    const k = keyFields(e), key = e.key;
    let ch = 0;
    if (key.length === 1) ch = toAnsi(key.charCodeAt(0));
    else if (key === 'Enter') ch = 13; else if (key === 'Backspace') ch = 8; else if (key === 'Tab') ch = 9; else if (key === 'Escape') ch = 27;
    downKeys.add(k.vk); send(Object.assign({ type: 'keydown', ch, repeat: e.repeat }, k));
    if (ch || PREVENT.has(e.keyCode)) e.preventDefault();
  });
  document.addEventListener('keyup', e => {
    if (e.target === kb) return;
    const k = keyFields(e);
    if (!downKeys.has(k.vk)) return;
    downKeys.delete(k.vk); send(Object.assign({ type: 'keyup' }, k)); e.preventDefault();
  });
  const releaseAll = () => {
    for (const vk of downKeys) send({ type: 'keyup', vk }); downKeys.clear();
    for (const b of [0, 2]) if (buttons & (1 << b)) send({ type: 'mouseup', button: b });
    buttons = 0;
  };
  window.addEventListener('blur', releaseAll);

  /* ---- on-screen keyboard (phones, tablets): a hidden text field raises the system keyboard and what it types is sent as key
   * presses. The field always holds a few padding characters, so that Backspace has something to delete and is noticed. */
  const PAD = '​​​​';
  let shadow = PAD;
  const OEM_VK = { ';': 0xBA, ':': 0xBA, '=': 0xBB, '+': 0xBB, ',': 0xBC, '<': 0xBC, '-': 0xBD, '_': 0xBD, '.': 0xBE, '>': 0xBE, '/': 0xBF, '?': 0xBF, '`': 0xC0, '~': 0xC0, '[': 0xDB, '{': 0xDB, '\\': 0xDC, '|': 0xDC, ']': 0xDD, '}': 0xDD, "'": 0xDE, '"': 0xDE };
  const vkOfChar = c => {
    const n = c.charCodeAt(0), i = ')!@#$%^&*('.indexOf(c);
    if (n >= 97 && n <= 122) return n - 32;
    if ((n >= 65 && n <= 90) || (n >= 48 && n <= 57)) return n;
    if (i >= 0) return 0x30 + i;
    if (n === 32) return 0x20;
    return OEM_VK[c] || 0xE7;
  };
  const tap = (vk, ch) => { send({ type: 'keydown', vk, ch }); send({ type: 'keyup', vk }); };
  kb.addEventListener('input', e => {
    const v = kb.value, n = Math.min(v.length, shadow.length);
    let p = 0;
    while (p < n && v.charCodeAt(p) === shadow.charCodeAt(p)) p++;
    for (let i = p; i < shadow.length; i++) tap(8, 8);                                  // characters that were deleted or replaced
    for (const c of v.slice(p)) { const u = toAnsi(c.codePointAt(0)); if (u) tap(vkOfChar(c), u); }   // characters that were typed
    shadow = v;
    if (!e.isComposing && (v.length < 2 || v.length > 40)) kb.value = shadow = PAD;
  });
  kb.addEventListener('keydown', e => {
    if (e.key === 'Enter') { tap(13, 13); e.preventDefault(); }
    else if (e.key === 'Escape') { tap(27, 27); e.preventDefault(); }
    else if (e.key.length > 1 && e.keyCode >= 33 && e.keyCode <= 40) { tap(e.keyCode, 0); e.preventDefault(); }   // arrows, Home, End, Page up / down
  });
  kb.addEventListener('focus', () => kbBtn.setAttribute('aria-pressed', 'true'));
  kb.addEventListener('blur', () => kbBtn.setAttribute('aria-pressed', 'false'));
  kbBtn.addEventListener('mousedown', e => e.preventDefault());                          // pressing the button must not take the focus away from the field
  kbBtn.onclick = () => {
    if (document.activeElement === kb) { kb.blur(); return; }
    kb.value = shadow = PAD; kb.focus({ preventScroll: true });
  };
  const touchDevice = (window.matchMedia && matchMedia('(any-pointer: coarse)').matches) || navigator.maxTouchPoints > 0;
  if (touchDevice) kbBtn.classList.remove('hide');
  // The game uses only two keys, Esc (skips the intro) and the space bar (Little Einsteins' Blast Off), and a phone's keyboard has neither Esc nor
  // a way to tap them without text going into a field: so touch screens get a button for each.
  const escBtn = $('escBtn'), spaceBtn = $('spaceBtn');
  escBtn.onclick = () => { tap(27, 27); cvs.focus(); };              // (the focus goes back to the picture, so that a real Space key is not taken by the button)
  spaceBtn.onclick = () => { tap(32, 32); cvs.focus(); };
  if (touchDevice) { escBtn.classList.remove('hide'); spaceBtn.classList.remove('hide'); }

  /* ---------------------------------------------------------------------------------------- printing */
  // The game's Print button draws the picture for a printer. The player shows it here with Print / Save choices.
  const pv = $('printView');
  function printOpen() { return !pv.classList.contains('hide'); }
  function closePrint() { pv.classList.add('hide'); document.body.classList.remove('printing'); cvs.focus(); }
  function showPrint(d) {
    releaseAll();
    const box = $('printPages'); box.textContent = '';
    for (const p of d.pages) {
      const src = document.createElement('canvas'); src.width = p.w; src.height = p.h;
      src.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(p.buf), p.w, p.h), 0, 0);
      let out = src;
      out.setAttribute('role', 'img'); out.setAttribute('aria-label', 'Picture to print');
      box.appendChild(out);
    }
    $('printTitle').textContent = d.name || 'Print';
    document.body.classList.add('printing'); pv.classList.remove('hide'); $('printNow').focus();
  }
  $('printNow').onclick = () => window.print();
  $('printSave').onclick = () => {
    const c = $('printPages').querySelector('canvas');
    if (c) c.toBlob(b => { const a = document.createElement('a'); a.href = URL.createObjectURL(b); a.download = 'preschool-time-picture.png'; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 10000); }, 'image/png');
  };
  $('printClose').onclick = closePrint;

  /* ---------------------------------------------------------------------------------------- pause while hidden, save on leaving */
  document.addEventListener('visibilitychange', () => {
    if (!worker || !ready || over) return;
    if (document.hidden) { releaseAll(); flashVisible(false); worker.postMessage({ type: 'pause' }); if (actx) actx.suspend(); }
    else { flushSound(); flashVisible(true); worker.postMessage({ type: 'resume' }); if (actx && !muted) actx.resume(); }
  });
  window.addEventListener('pagehide', () => { if (worker) worker.postMessage({ type: 'flush' }); });

  /* ---------------------------------------------------------------------------------------- toolbar */
  // In full screen a browser keeps Esc for itself (a press leaves full screen), but the game needs Esc to skip its intro. Chrome and Edge give
  // the page a short press of Esc when it asks for it (holding Esc then leaves full screen); other browsers have no way to ask.
  document.addEventListener('fullscreenchange', () => {
    const k = navigator.keyboard;
    try {
      if (document.fullscreenElement) { if (k && k.lock) k.lock(['Escape']).catch(() => { }); }
      else if (k && k.unlock) k.unlock();
    } catch (x) { /* not available */ }
  });
  $('fsBtn').onclick = () => {
    if (document.fullscreenElement) document.exitFullscreen();
    else if (stage.requestFullscreen) stage.requestFullscreen().catch(() => { });
    else if (stage.webkitRequestFullscreen) stage.webkitRequestFullscreen();
    cvs.focus();
  };
  $('muteBtn').onclick = () => {
    muted = !muted;
    if (gain) gain.gain.value = muted ? 0 : 1;
    flashVolume(!muted);
    flushSound(); if (muted) soundOff();                 // (no sound: nothing to wait for)
    $('muteBtn').textContent = 'Sound: ' + (muted ? 'off' : 'on'); $('muteBtn').setAttribute('aria-pressed', muted ? 'true' : 'false');
    cvs.focus();
  };
  /* sound / picture timing control */
  const syncRange = $('syncRange');
  const showOffset = () => { syncRange.value = userOffset; $('syncVal').textContent = (userOffset > 0 ? '+' : '') + userOffset + ' ms'; };
  showOffset();
  $('syncBtn').onclick = () => {
    const open = $('syncPanel').classList.toggle('hide') === false;
    $('syncBtn').setAttribute('aria-pressed', open ? 'true' : 'false');
    if (!open) cvs.focus();
  };
  syncRange.oninput = () => {
    userOffset = lim(Math.round(+syncRange.value), -MAX_PICTURE_DELAY, MAX_PICTURE_DELAY); showOffset(); applyDelay(true);
    try { localStorage.setItem('pto-avoffset', String(userOffset)); } catch (e) { /* not kept */ }
  };
  syncRange.addEventListener('pointerup', () => cvs.focus());
  $('syncReset').onclick = () => { syncRange.value = 0; syncRange.oninput(); cvs.focus(); };
  let wipeTimer = 0;
  /* ?debug: "Copy log" puts the statistics, the stall recorder's notes and the end of the log on the clipboard */
  $('copyLogBtn').onclick = async () => {
    const text = ['Playhouse Disney Preschool Time Online, player log', navigator.userAgent, location.search, $('hud').textContent, '',
      '--- notes (stalls, drawing) ---', ...keepLines, '', '--- sound (voices of 1.5 s and longer: when they start and end, how much of them was heard, and any time the sound had to wait for the game) ---', ...(soundLines.length ? soundLines : ['(nothing yet)']), '', '--- Flash movies (seconds since the page opened, what happened) ---', ...flashLines, '', '--- end of the log ---', ...logLines.slice(-60).filter(l => !/^\[(stall|hle|sound)\]/.test(l))].join('\n');
    const b = $('copyLogBtn');
    try { await navigator.clipboard.writeText(text); b.textContent = 'Copied'; }
    catch (e) { const l = $('log'); l.style.display = 'block'; l.style.maxHeight = '60vh'; l.textContent = text; const r = document.createRange(); r.selectNodeContents(l); const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r); b.textContent = 'Press Ctrl+C'; }
    setTimeout(() => { b.textContent = 'Copy log'; }, 3000);
  };
  $('wipeBtn').onclick = () => {
    if (!wipeTimer) {
      $('wipeBtn').textContent = 'Click again to confirm';
      wipeTimer = setTimeout(() => { wipeTimer = 0; $('wipeBtn').textContent = 'Clear saved data'; }, 4000);
      return;
    }
    clearTimeout(wipeTimer); keepNick(''); worker.postMessage({ type: 'wipe' });       // (the nickname is one of the things kept in this browser)
  };

  window.__pto = {                                                   // handle for automated tests and for ?debug
    get ready() { return ready; }, get audioFrames() { return audioFrames; }, get framesShown() { return framesShown; }, logLines,
    selftest: () => worker.postMessage({ type: 'selftest' }), post: m => worker.postMessage(m), cleanNickname, nickKey: NICK_KEY,
    testPrint: d => showPrint(d),                                    // shows a page in the print window, as if the game had printed it
    testFlash: ev => onFlash(ev), fromWorker: d => onMessage({ data: d }), skipMovies, flashLines, movies, sent, seen, get ruffle() { return !!ruffleApi; }, get warm() { return warmState; }, warmUp: warmRuffle,     // acts as if the worker had sent this Flash event
    pause: () => worker.postMessage({ type: 'pause' }), resume: () => worker.postMessage({ type: 'resume' }),
    level: () => { if (!analyser) return -1; const a = new Float32Array(analyser.fftSize); analyser.getFloatTimeDomainData(a); let s = 0; for (const v of a) s += v * v; return Math.sqrt(s / a.length); },
    stall: ms => worker.postMessage({ type: 'stall', ms }),
    get clips() { return clipStats; }, get pictureDelay() { return pictureDelay; }, get soundDelay() { return soundDelay; },
    avRaw: () => ({ a: avA.slice(), v: avV.slice(), now: performance.timeOrigin + performance.now() }),
    av: (sinceMs) => {                                  // delays of what was produced in the last `sinceMs` milliseconds
      const t = performance.timeOrigin + performance.now() - (sinceMs || 3000);
      const med = a => { const v = a.filter(x => x.te >= t).map(x => x.d).sort((x, y) => x - y); return v.length ? { n: v.length, med: +v[v.length >> 1].toFixed(1), min: +v[0].toFixed(1), max: +v[v.length - 1].toFixed(1) } : null; };
      const q = avA.filter(x => x.te >= t).map(x => x.q).sort((x, y) => x - y);
      const last = avA.length ? avA[avA.length - 1] : {};
      return { audio: med(avA), video: med(avV), queuedMs: q.length ? { med: +q[q.length >> 1].toFixed(1), max: +q[q.length - 1].toFixed(1) } : null, target: last.tg, dries: last.dries, skips: last.skips, excess: last.ex, speed: last.sp, pictureDelay, soundDelay: +soundDelay.toFixed(1) };
    },
    get baseLatency() { return actx && actx.baseLatency; }, get outputLatency() { return actx && actx.outputLatency; },
    audioState: () => actx ? actx.state + ' ' + actx.sampleRate + ' Hz' : 'none',
  };
})();
