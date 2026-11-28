/* Manny's Sing-Along TV, the page's side (videos.js has the videos themselves, and the Sing-Along room of the game itself uses them too).
 *
 * Manny (2.0.6's Flash application) has a TV in its Workshop whose eight buttons played songs from Disney's streaming server, which is gone.  The videos of the
 * `videos/` folder (and the ones added with the "Videos..." button) go on that TV instead:
 *  - mannyfix.js changes the TV's movie: it hides its own eight buttons, and it tells the page (by asking for made-up addresses that main.js answers itself and passes on here,
 *    see signal()) when its scene is up (pto-tv-up), when its X button is pressed (pto-tv-stop) and when the TV is left (pto-tv-down);
 *  - while the TV is up, this module lays eight buttons of its own over the TV's screen, exactly where the movie's own buttons were, each with the picture of a video (the same
 *    pictures as in the room); with more than eight videos there are pages, with two arrows in the free places of the middle row;
 *  - a click plays the video in the page's own player (videos.js: open) on the TV's screen, where the movie put its own video; the X button of the TV, Esc, the end of the video and
 *    leaving the TV stop it, and the buttons are there again;
 *  - Manny draws its mouse arrow inside the movie, under everything on the page: over a button or the video it would be hidden, or stick out beside it like a ghost.  So while the
 *    mouse is over one of this module's things the movie's mouse is parked far outside its stage (a pointer move that Ruffle gets from here), and the browser's own arrow (a hand over
 *    the buttons) shows; when the mouse leaves, the movie's mouse is put where the real one is.
 * Nothing here happens in a game without Manny, or with ?nomannyfix: the TV's movie is the one thing that asks for the addresses. */
(function (G) {
  'use strict';
  const V = G.PTOVideos, doc = G.document;
  if (!V || !doc) return;                              // (videos.js is loaded first)
  const P = G.PTOMannyTV = {};

  /* The TV's own picture (the movie is 800 x 600, the same as the game): where its eight buttons were (the movie reported its buttons' bounds: btnOne 120,118,128,96 ... btnNine
   * 450,368,128,96; the fourth place is empty), and where it puts the video it plays (VIDEO_X 110, VIDEO_Y 110, 480 x 360 in its code). */
  const STAGE = { w: 800, h: 600 };
  const SLOT = { w: 128, h: 96 };
  const SLOTS = [[120, 118], [285, 118], [450, 118], [202, 243], [367, 243], [120, 368], [285, 368], [450, 368]];
  const VIDEO = { x: 110, y: 110, w: 480, h: 360 };
  const PREV = { x: 135, y: 265, w: 52, h: 52 }, NEXT = { x: 510, y: 265, w: 52, h: 52 }, POS = { x: 332, y: 276, w: 34, h: 30 };      // (pages: the free places of the middle row)
  const PER_PAGE = SLOTS.length;
  P.geometry = { STAGE, SLOT, SLOTS, VIDEO, PREV, NEXT, POS };

  let cfg = { layer: null, cvs: null, host: () => null, note: () => { }, muted: () => false, notice: () => { } };
  let wired = false, root = null, slots = [], prevB = null, nextB = null, posEl = null, noteEl = null;
  let page = 0, pages = 1, vid = null, queued = 0, noSoundTimer = 0;
  const hot = new Set();                               // the things of this module that the mouse is over
  let parked = false, lastPt = null;                   // parked: the movie's mouse is outside its stage; lastPt: where the real mouse was last seen on one of our things
  const note = s => { try { cfg.note(s); } catch (e) { /* ignore */ } };
  const el = (tag, cls) => { const e = doc.createElement(tag); if (cls) e.className = cls; return e; };
  const box = (e, r) => { const s = e.style; s.left = (r.x / STAGE.w * 100) + '%'; s.top = (r.y / STAGE.h * 100) + '%'; s.width = (r.w / STAGE.w * 100) + '%'; s.height = (r.h / STAGE.h * 100) + '%'; };

  P.init = o => {
    cfg = Object.assign(cfg, o || {});
    if (!wired) { wired = true; V.onChange(() => schedule()); }
  };

  /* ------------------------------------------------------------------------------------------ the movie's mouse */
  function flashCanvas() {
    const h = cfg.host(), sr = h && h.el && h.el.shadowRoot;
    return sr ? sr.querySelector('canvas') : null;
  }
  function moveFlash(x, y) {                           // a pointer move on Ruffle's own canvas: Ruffle takes it for the mouse (Manny's arrow and the buttons' rollovers follow it)
    const cv = flashCanvas(); if (!cv) return false;
    try {
      cv.dispatchEvent(new G.PointerEvent('pointermove', { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, pointerId: 1, pointerType: 'mouse', isPrimary: true, buttons: 0, view: G }));
      return true;
    } catch (e) { return false; }
  }
  function park() {
    if (parked) return;
    const cv = flashCanvas(); if (!cv) return;
    const r = cv.getBoundingClientRect();
    if (moveFlash(r.left - r.width, r.top - r.height)) parked = true;      // (far to the upper left of the stage: the arrow is out of sight)
  }
  function unpark() {
    if (!parked) return;
    parked = false;
    if (lastPt) moveFlash(lastPt.x, lastPt.y);
  }
  /** a thing the mouse is over is "hot": the movie's mouse stays parked while any is */
  function wire(e) {
    e.addEventListener('pointerenter', ev => { if (ev.pointerType === 'touch') return; lastPt = { x: ev.clientX, y: ev.clientY }; hot.add(e); park(); });
    e.addEventListener('pointermove', ev => { if (ev.pointerType !== 'touch') lastPt = { x: ev.clientX, y: ev.clientY }; });
    e.addEventListener('pointerleave', ev => { lastPt = { x: ev.clientX, y: ev.clientY }; hot.delete(e); if (!hot.size) unpark(); });
  }
  const forget = e => { hot.delete(e); if (!hot.size) unpark(); };          // (a thing that is taken away under the mouse sends no pointerleave)

  /* ------------------------------------------------------------------------------------------ the buttons */
  function layout() {
    if (!root || !cfg.layer || !cfg.cvs) return;
    const l = cfg.layer.getBoundingClientRect(), c = cfg.cvs.getBoundingClientRect();
    if (!c.width) return;
    const s = root.style;
    s.left = (c.left - l.left) + 'px'; s.top = (c.top - l.top) + 'px'; s.width = c.width + 'px'; s.height = c.height + 'px';
    s.fontSize = (c.width / STAGE.w * 16) + 'px';
  }
  P.relayout = () => layout();

  function drawSlot(s) { if (s.it) V.drawSlot(s.cv, s.it, s.lit); }
  function build() {
    root = el('div', 'mtv'); root.setAttribute('role', 'group'); root.setAttribute('aria-label', 'Your videos');
    slots = SLOTS.map((p, k) => {
      const b = el('button', 'mtvSlot'), cv = el('canvas'), s = { k, b, cv, it: null, lit: false };
      b.type = 'button'; box(b, { x: p[0], y: p[1], w: SLOT.w, h: SLOT.h }); cv.width = SLOT.w * 2; cv.height = SLOT.h * 2; b.append(cv);
      b.addEventListener('mousedown', ev => ev.preventDefault());           // (a click must not take the keyboard away from the game)
      b.addEventListener('click', () => { if (s.it) play(s.it); });
      b.addEventListener('pointerenter', () => { s.lit = true; drawSlot(s); }); b.addEventListener('pointerleave', () => { s.lit = false; drawSlot(s); });
      b.addEventListener('focus', () => { s.lit = true; drawSlot(s); }); b.addEventListener('blur', () => { s.lit = false; drawSlot(s); });
      wire(b); root.append(b);
      return s;
    });
    const arrow = (cls, r, label, d) => {
      const b = el('button', 'mtvPage ' + cls); b.type = 'button'; box(b, r); b.title = label; b.setAttribute('aria-label', label);
      b.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="' + (d < 0 ? 'M15 4.5 7.5 12 15 19.5' : 'M9 4.5 16.5 12 9 19.5') + '" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
      b.addEventListener('mousedown', ev => ev.preventDefault());
      b.addEventListener('click', () => turn(d));
      wire(b); root.append(b); return b;
    };
    prevB = arrow('mtvPrev', PREV, 'Earlier videos', -1); nextB = arrow('mtvNext', NEXT, 'More videos', 1);
    posEl = el('div', 'mtvPos'); box(posEl, POS); posEl.setAttribute('aria-live', 'polite'); root.append(posEl);
    noteEl = el('div', 'mtvNote'); box(noteEl, { x: 120, y: 118, w: 458, h: 346 });
    noteEl.innerHTML = '<p><b>No videos yet</b></p><p>Put video files (.mp4 or .webm) into the <i>videos</i> folder next to this page, or press <i>Videos…</i> under the game.</p>';
    root.append(noteEl);
    cfg.layer.appendChild(root); layout();
  }

  let rafId = 0;
  function schedule() {                                // (pictures arrive one after the other: one redraw for all of those that come together)
    if (!root || rafId) return;
    rafId = (G.requestAnimationFrame || (f => G.setTimeout(f, 16)))(() => { rafId = 0; render(); });
  }
  function render() {
    if (!root) return;
    const items = V.items();
    pages = Math.max(1, Math.ceil(items.length / PER_PAGE)); if (page >= pages) page = pages - 1; if (page < 0) page = 0;
    for (const s of slots) {
      const it = items[page * PER_PAGE + s.k] || null;
      s.it = it; s.b.hidden = !it;
      if (it) { drawSlot(s); s.b.title = it.title; s.b.setAttribute('aria-label', 'Play ' + it.title); }
      else if (hot.has(s.b)) forget(s.b);
    }
    const many = pages > 1;
    prevB.hidden = nextB.hidden = posEl.hidden = !many;
    prevB.disabled = page === 0; nextB.disabled = page === pages - 1;
    posEl.textContent = (page + 1) + '/' + pages; posEl.title = 'Videos ' + (page * PER_PAGE + 1) + ' to ' + Math.min(items.length, (page + 1) * PER_PAGE) + ' of ' + items.length;
    noteEl.hidden = items.length > 0;
    root.classList.toggle('playing', !!vid);
  }
  function turn(d) {
    const n = Math.min(pages - 1, Math.max(0, page + d)); if (n === page) return;
    page = n; render();
  }

  /* ------------------------------------------------------------------------------------------ playing */
  function play(it) {
    if (!root) return;
    closeVideo('another video was picked', true);
    let me = null;
    const o = V.open(it.id, { muted: () => cfg.muted(), nativeCursor: true, onEnd: why => { if (vid && vid === me) closeVideo(why, false); } }, VIDEO);
    if (!o) { cfg.notice('That video is not in the list any more.'); note('[videos] Manny\'s TV: ' + it.file + ' is not in the list any more'); render(); return; }
    me = vid = { el: o.el, api: o.api, it };
    o.el.classList.add('mtvVideo'); box(o.el, VIDEO); wire(o.el);
    root.append(o.el); root.classList.add('playing');
    note('[videos] Manny\'s TV plays "' + it.file + '"');
    for (const s of slots) if (hot.has(s.b)) forget(s.b);       // (the buttons are hidden now: the mouse is over the video, if over anything)
  }
  function closeVideo(why, again) {
    const v = vid; if (!v) return false;
    vid = null;
    try { v.api.dispose(); } catch (e) { /* ignore */ }
    try { v.el.remove(); } catch (e) { /* ignore */ }
    forget(v.el);
    note('[videos] Manny\'s TV: "' + v.it.file + '" stopped (' + why + ')');
    if (!again && root) { root.classList.remove('playing'); render(); }
    return true;
  }

  /* ------------------------------------------------------------------------------------------ what the page tells us */
  function up() {
    const h = cfg.host();
    if (!h) { note('[videos] Manny\'s TV says it is up, but no Manny movie is on show: ignored'); return; }
    if (root) down('the TV came up again');
    page = 0; build(); render();
    const n = V.items().length;
    note('[videos] Manny\'s TV is up: ' + n + ' video(s) on ' + pages + ' page(s)');
    if (!n) { clearTimeout(noSoundTimer); noSoundTimer = setTimeout(() => { if (root) V.noVideos().catch(() => { }); }, 1000); }      // (the TV has to fade in first)
  }
  function down(why) {
    clearTimeout(noSoundTimer);
    if (!root) return;
    closeVideo(why, true);
    for (const e of Array.from(hot)) hot.delete(e);
    unpark();
    try { root.remove(); } catch (e) { /* ignore */ }
    root = null; slots = []; prevB = nextB = posEl = noteEl = null; rafId = 0;
    note('[videos] Manny\'s TV is gone (' + why + ')');
  }
  /** main.js: the movie asked for pto-tv-up / pto-tv-stop / pto-tv-down */
  P.signal = kind => {
    if (kind === 'up') up();
    else if (kind === 'down') down('the TV was left');
    else if (kind === 'stop') { if (!closeVideo('the TV\'s X button', false) && root) render(); }
  };
  /** main.js: a Flash movie came or went; the buttons go when Manny is not on show any more */
  P.check = () => { if (root && !cfg.host()) down('Manny is not on show any more'); };
  /** Esc: it stops a video that is playing (and that is all it does then); true when it did */
  P.escape = () => closeVideo('Esc', false);
  P.visible = on => { if (!vid) return; try { if (on) vid.api.resume(); else vid.api.suspend(); } catch (e) { /* ignore */ } };
  P.setMuted = on => { if (vid) { try { vid.api.volume = on ? 0 : 1; } catch (e) { /* ignore */ } } };
  P.info = () => ({ up: !!root, page, pages, playing: vid ? vid.it.file : null, parked, hot: hot.size, slots: slots.map(s => s.it ? s.it.file : null) });
})(typeof globalThis !== 'undefined' ? globalThis : this);
