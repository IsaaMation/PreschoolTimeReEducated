/* The Sing-Along room's videos, the page's side (see emu/videolist.js for how the room works).
 *
 * The room (the TV in the Backyard) used to download its videos from a server that is gone, so it is empty.  Here the videos come from
 *   - the folder `videos/` next to this page (every .mp4 / .m4v / .webm / .ogv / .mov / .mkv in it; serve.py lists it as videos/videos.json), and
 *   - files added on the page ("Videos..." button, or dropped on the page; kept until the page is closed).
 * Each becomes a button on the TV: its picture is made here from a frame of the video (or a plain card with its name until that frame is
 * ready), handed to the worker, whose stand-in server gives the game a list made from them.  A click in the game starts a Flash movie in
 * a window on the TV's screen; the page plays the video there, in a small player of its own (open() below: the browser's video with controls made
 * here, and the game's own mouse arrow drawn over it), and tells the game when it is over.
 *
 * With no videos the room is empty, and one of the sounds sounds/NOVIDEOS1.mp3 .. NOVIDEOS8.mp3 is played when it opens.
 */
(function (G) {
  'use strict';
  const V = G.EMU && G.EMU.Videos;
  if (!V) return;                                      // (emu/videolist.js is loaded first)
  const P = G.PTOVideos = {};
  const doc = G.document;

  let cfg = { debug: false, note: () => { }, muted: () => false, base: doc ? doc.baseURI : '' };
  let sendFn = null;                                   // posts a message to the worker (null until the worker exists)
  let folder = [], added = [], items = [], gen = 0, folderState = 'idle';        // folder: from videos/ ; added: picked on the page ; items: what the TV shows now
  const byId = new Map();                              // every video of every list so far (the game may still hold buttons of an older one)
  let jobs = 0;                                        // poster frames being made (a newer list stops the older queue)
  const listeners = [];
  P.onChange = fn => { listeners.push(fn); };
  const changed = () => { for (const f of listeners) { try { f(P.info()); } catch (e) { /* not ours */ } } };
  const note = s => { try { cfg.note(s); } catch (e) { /* ignore */ } };

  P.init = o => { cfg = Object.assign(cfg, o || {}); };
  P.info = () => ({ count: items.length, shown: Math.min(items.length, V.MAX), folder: folder.length, added: added.length, folderState, gen, over: Math.max(0, folder.length + added.length - V.MAX) });
  P.items = () => items.slice();
  P.byId = id => byId.get(id) || null;

  /* ------------------------------------------------------------------------------------------ the list */
  const urlOf = file => new URL('videos/' + encodeURIComponent(file), cfg.base || doc.baseURI).href;
  async function loadFolder() {
    folderState = 'loading';
    const get = async u => { const r = await fetch(u, { cache: 'no-store' }); if (!r.ok) throw new Error(u + ' -> ' + r.status); return r.text(); };
    let list = null, how = '';
    try { list = V.parseList(await get(new URL('videos/videos.json', cfg.base || doc.baseURI).href)); how = 'videos.json'; } catch (e) { /* no list: maybe a plain folder listing */ }
    if (!list) { try { list = V.parseList(await get(new URL('videos/', cfg.base || doc.baseURI).href)); how = 'folder listing'; } catch (e) { /* no folder */ } }
    folder = (list || []).map(e => ({ file: e.file, title: e.title, size: e.size, url: urlOf(e.file), local: false }));
    folderState = list ? 'ok' : 'none';
    note('[videos] the videos folder: ' + (list ? folder.length + ' video(s), read from ' + how : 'not found (no videos/ folder next to this page, or the server does not list it)'));
  }
  /** videos from the person's computer (the picker or a drop); returns how many were new */
  P.addFiles = files => {
    let n = 0;
    for (const f of Array.from(files || [])) {
      if (!f || !(V.isVideoName(f.name) || /^video\//i.test(f.type || ''))) continue;
      if (folder.some(e => e.file === f.name) || added.some(e => e.file === f.name)) continue;
      added.push({ file: f.name, title: V.cleanTitle(f.name), size: f.size || 0, url: URL.createObjectURL(f), local: true }); n++;
    }
    if (n) rebuild('added ' + n);
    return n;
  };
  P.isVideoFile = f => !!f && (V.isVideoName(f.name) || /^video\//i.test(f.type || ''));

  function rebuild(why) {
    const all = folder.concat(added).sort((a, b) => V.compareNames(a.file, b.file));
    items = all.slice(0, V.MAX).map((e, i) => Object.assign({}, e, { id: V.videoId(gen + 1, i), index: i, thumb: null, poster: false }));
    gen++; jobs++;
    for (const it of items) { it.gen = gen; byId.set(it.id, it); }
    note('[videos] list ' + gen + ' (' + why + '): ' + items.length + ' video(s) on the TV' + (all.length > V.MAX ? ', ' + (all.length - V.MAX) + ' more than fit are left out' : ''));
    const lay = V.layout(items.length);
    for (const it of items) it.thumb = drawThumbs(it, lay.w, lay.h, null);
    send({ type: 'videos', gen, count: items.length, thumbs: items.map(it => it.thumb.slice().buffer) });
    changed();
    if (items.length) makePosters(gen, lay);
  }
  function send(msg) {
    if (!sendFn) return;
    const tr = msg.thumbs ? msg.thumbs.filter(Boolean) : msg.bytes ? [msg.bytes] : [];
    try { sendFn(msg, tr); } catch (e) { note('[videos] could not tell the game: ' + (e && e.message)); }
  }
  /** the worker exists: it gets the list as it is now, and every change after this */
  P.attach = fn => {
    sendFn = fn;
    if (gen) send({ type: 'videos', gen, count: items.length, thumbs: items.map(it => it.thumb.slice().buffer) });
  };
  P.start = async () => {
    try { await loadFolder(); } catch (e) { folderState = 'none'; note('[videos] the videos folder could not be read: ' + (e && e.message)); }
    rebuild('page start');
  };

  /* ------------------------------------------------------------------------------------------ button pictures */
  const hue = s => { let h = 7; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360; return h; };
  const FONT = 'system-ui, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';
  function wrapText(g, text, maxW, maxLines) {
    const words = text.split(/\s+/).filter(Boolean), lines = []; let cur = '';
    for (let i = 0; i < words.length; i++) {
      const t = cur ? cur + ' ' + words[i] : words[i];
      if (g.measureText(t).width <= maxW || !cur) cur = t;
      else { lines.push(cur); cur = words[i]; }
      if (lines.length === maxLines) break;
    }
    if (lines.length < maxLines && cur) lines.push(cur);
    const used = lines.join(' ').length;
    if (used < text.replace(/\s+/g, ' ').trim().length) lines[lines.length - 1] += '…';        // (cut: say so)
    return lines.map(l => { while (l.length > 1 && g.measureText(l).width > maxW) l = l.slice(0, -2) + '…'; return l; });
  }
  /** one frame (the normal or the lit one) of a button, w x h, drawn at (x0, 0) */
  function drawFrame(g, x0, w, h, it, poster, lit) {
    const m = Math.max(2, Math.round(w / 40)), bw = lit ? Math.max(3, Math.round(w / 28)) : Math.max(2, Math.round(w / 48));
    const ix = x0 + m, iy = m, iw = w - 2 * m, ih = h - 2 * m, r = Math.max(3, Math.round(w / 22));
    g.save();
    g.fillStyle = '#141820'; g.fillRect(x0, 0, w, h);
    g.beginPath(); g.roundRect ? g.roundRect(ix, iy, iw, ih, r) : g.rect(ix, iy, iw, ih); g.clip();
    if (poster) {                                      // the video's own frame, filling the button
      const k = Math.max(iw / poster.width, ih / poster.height), dw = poster.width * k, dh = poster.height * k;
      g.drawImage(poster, ix + (iw - dw) / 2, iy + (ih - dh) / 2, dw, dh);
    } else {                                           // no frame (yet): a plain card, a colour of its own
      const hh = hue(it.title), gr = g.createLinearGradient(0, iy, 0, iy + ih);
      gr.addColorStop(0, 'hsl(' + hh + ',55%,' + (lit ? 52 : 40) + '%)'); gr.addColorStop(1, 'hsl(' + ((hh + 40) % 360) + ',60%,' + (lit ? 38 : 28) + '%)');
      g.fillStyle = gr; g.fillRect(ix, iy, iw, ih);
    }
    if (lit) { g.fillStyle = 'rgba(255,255,255,0.16)'; g.fillRect(ix, iy, iw, ih); }
    const two = w >= 120, fs = Math.max(7, Math.round(h * (two ? 0.105 : 0.125))), lh = Math.round(fs * 1.15), pad = Math.max(2, Math.round(w / 40));
    g.font = '700 ' + fs + 'px ' + FONT; g.textAlign = 'center'; g.textBaseline = 'top';
    const lines = wrapText(g, it.title, iw - 2 * pad - 2, two ? 2 : 1), th = lines.length * lh + 2 * pad;
    const showText = !poster || w >= 80;
    if (showText) {
      g.fillStyle = poster ? 'rgba(10,12,18,0.72)' : 'rgba(10,12,18,0.35)';
      const by = poster ? iy + ih - th : iy + Math.round((ih - th) / 2);
      g.fillRect(ix, by, iw, th);
      g.fillStyle = '#fff'; lines.forEach((l, i) => g.fillText(l, ix + iw / 2, by + pad + i * lh));
    }
    if (lit) {                                         // a play mark: "this one"
      const s = Math.round(Math.min(iw, ih) * 0.22), cx = ix + iw / 2, cy = iy + (ih - (showText && poster ? th : 0)) / 2;
      g.fillStyle = 'rgba(255,255,255,0.92)'; g.beginPath(); g.moveTo(cx - s * 0.4, cy - s * 0.55); g.lineTo(cx + s * 0.6, cy); g.lineTo(cx - s * 0.4, cy + s * 0.55); g.closePath(); g.fill();
    }
    g.restore();
    g.lineWidth = bw; g.strokeStyle = lit ? '#ffd23f' : 'rgba(235,240,250,0.9)';
    g.beginPath(); g.roundRect ? g.roundRect(ix + bw / 2, iy + bw / 2, iw - bw, ih - bw, r) : g.rect(ix + bw / 2, iy + bw / 2, iw - bw, ih - bw); g.stroke();
  }
  /** the PNG for a button: the two frames side by side (normal | lit) */
  function drawThumbs(it, w, h, poster) {
    const cv = doc.createElement('canvas'); cv.width = 2 * w; cv.height = h;
    const g = cv.getContext('2d', { willReadFrequently: true });
    drawFrame(g, 0, w, h, it, poster, false); drawFrame(g, w, w, h, it, poster, true);
    const px = g.getImageData(0, 0, 2 * w, h).data, rgb = new Uint8Array(2 * w * h * 3);
    for (let i = 0, j = 0; i < px.length; i += 4, j += 3) { rgb[j] = px[i]; rgb[j + 1] = px[i + 1]; rgb[j + 2] = px[i + 2]; }
    return V.encodePng(2 * w, h, rgb);
  }
  P._drawThumbs = drawThumbs;                          // (tests)

  /* ------------------------------------------------------------------------------------------ frames of the videos */
  const once = (el, ev, ms) => new Promise((res, rej) => {
    const t = setTimeout(() => { cleanup(); rej(new Error('timeout (' + ev + ')')); }, ms);
    const ok = () => { cleanup(); res(); }, bad = () => { cleanup(); rej(new Error('error while waiting for ' + ev)); };
    const cleanup = () => { clearTimeout(t); el.removeEventListener(ev, ok); el.removeEventListener('error', bad); };
    el.addEventListener(ev, ok); el.addEventListener('error', bad);
  });
  const lumOf = cv => {                                // how bright a frame is: 0 (black) .. 255
    const s = doc.createElement('canvas'); s.width = 16; s.height = 12; const g = s.getContext('2d', { willReadFrequently: true });
    g.drawImage(cv, 0, 0, 16, 12); const d = g.getImageData(0, 0, 16, 12).data; let t = 0;
    for (let i = 0; i < d.length; i += 4) t += d[i] * 0.3 + d[i + 1] * 0.59 + d[i + 2] * 0.11;
    return t / (d.length / 4);
  };
  /** a frame of the video, as a canvas (max 320 wide), or null; many videos open on black, so a few later places are tried */
  async function grabFrame(it) {
    const v = doc.createElement('video'); v.muted = true; v.preload = 'auto'; v.playsInline = true; v.setAttribute('playsinline', '');
    let best = null;
    try {
      v.src = it.url;
      await once(v, 'loadedmetadata', 15000);
      const dur = isFinite(v.duration) && v.duration > 0 ? v.duration : 0;
      for (const f of dur ? [0.08, 0.3, 0.55] : [0]) {
        v.currentTime = dur ? Math.min(dur * f, Math.max(0.2, dur - 0.3)) : 0.1;
        try { await once(v, 'seeked', 15000); } catch (e) { if (best) break; throw e; }
        if (v.readyState < 2) { try { await once(v, 'loadeddata', 8000); } catch (e) { /* draw what there is */ } }
        if (!v.videoWidth) throw new Error('no picture');
        const k = Math.min(1, 320 / v.videoWidth), cv = doc.createElement('canvas'); cv.width = Math.max(1, Math.round(v.videoWidth * k)); cv.height = Math.max(1, Math.round(v.videoHeight * k));
        cv.getContext('2d').drawImage(v, 0, 0, cv.width, cv.height);
        if (!best || lumOf(cv) > lumOf(best)) best = cv;
        if (lumOf(best) >= 14) break;
      }
    } finally { try { v.removeAttribute('src'); v.load(); } catch (e) { /* ignore */ } }
    return best;
  }
  async function makePosters(myGen, lay) {
    let next = 0, done = 0, failed = 0;
    const worker = async () => {
      while (next < items.length) {
        if (myGen !== gen) return;                     // a newer list: this queue is finished
        const it = items[next++];
        try {
          const fr = await grabFrame(it);
          if (myGen !== gen) return;
          if (!fr) { failed++; continue; }
          it.thumb = drawThumbs(it, lay.w, lay.h, fr); it.poster = true; done++;
          send({ type: 'videos', gen: myGen, thumb: it.index, bytes: it.thumb.slice().buffer });
        } catch (e) { failed++; note('[videos] no picture from "' + it.file + '": ' + (e && e.message)); }
      }
    };
    await Promise.all([worker(), worker()]);
    if (myGen === gen) note('[videos] pictures for list ' + myGen + ': ' + done + ' made from the videos, ' + failed + ' left as plain cards');
  }

  /* ------------------------------------------------------------------------------------------ the game's mouse arrow */
  /* The game draws its own mouse arrow (Common/arrow.tga) into its picture, and the video lies on top of that picture, so the arrow went
   * under the video: cut off at the TV's edge, and over the video the browser's plain arrow showed instead.  So the page draws the same arrow
   * on top of the video itself.  The game's arrow is always a little behind the mouse (the game draws it in its own turn, and its picture is
   * held back for the sound), the page's arrow is not, so two things are looked after:
   *  - where the game's own arrow is in view (it sticks out beside the TV, or lies at its edge) the page's arrow is the game's arrow carried on over the video: it is drawn where
   *    the game's arrow is in the picture that is on show (the worker says where that is: shown), cut off at the TV's edge, so the two halves make one arrow;
   *  - where the game's arrow is out of sight under the video (and so is the arrow at the mouse: the whole of it is well inside the TV), the page's arrow follows the mouse itself, at once.
   *    In between (the last few pixels before the edge) it slides from one to the other.  When the mouse leaves the TV faster than the game follows, the page's arrow stays with the game's.
   * The picture of the arrow is read from the game's own data (main.js asks the worker for it), not shipped with the page. */
  const HOT = { x: 0, y: 2 };                          // the game puts the picture's top-left corner at (mouse x - 0, mouse y - 2): the arrow's tip is at the mouse
  let sprite = null;                                   // { w, h, canvas }
  const spriteWaiters = [];                            // players that were opened before the picture was there
  P.cursorFile = 'common/arrow.tga';
  P.hasCursorSprite = () => !!sprite;
  P.cursorBounds = () => sprite ? Object.assign({ w: sprite.w, h: sprite.h }, sprite.vis) : null;       // (tests) the arrow's picture and the part of it that can be seen
  P.cursorImage = () => sprite ? sprite.canvas : null;                                                   // (tests)
  const SLIDE = 24;                                    // game pixels: how far under the video the game's arrow has to be before the page's arrow is all for the mouse
  /** a TGA picture (type 2 or 10, 24 or 32 bits: what the game's cursor files are) -> { w, h, data (RGBA, top row first) }, or null */
  P.decodeTga = u8 => {
    try {
      if (!u8 || u8.length < 18) return null;
      const idLen = u8[0], type = u8[2], w = u8[12] | (u8[13] << 8), h = u8[14] | (u8[15] << 8), bpp = u8[16], desc = u8[17];
      if (u8[1] !== 0 || (type !== 2 && type !== 10) || (bpp !== 24 && bpp !== 32) || !w || !h || w > 512 || h > 512) return null;
      const bytes = bpp >> 3, topDown = !!(desc & 0x20), rightToLeft = !!(desc & 0x10), hasAlpha = bpp === 32 && (desc & 15) > 0;
      const total = w * h, out = new Uint8ClampedArray(total * 4);
      let p = 18 + idLen, n = 0;
      const put = q => {                               // the next pixel of the file, which is at u8[q]
        const row = (n / w) | 0, col = n - row * w, y = topDown ? row : h - 1 - row, x = rightToLeft ? w - 1 - col : col, o = (y * w + x) * 4;
        out[o] = u8[q + 2]; out[o + 1] = u8[q + 1]; out[o + 2] = u8[q]; out[o + 3] = hasAlpha ? u8[q + 3] : 255; n++;
      };
      if (type === 2) { if (p + total * bytes > u8.length) return null; while (n < total) { put(p); p += bytes; } }
      else {
        while (n < total) {
          if (p >= u8.length) return null;
          const c = u8[p++], cnt = (c & 127) + 1;
          if (c & 128) { if (p + bytes > u8.length) return null; for (let i = 0; i < cnt && n < total; i++) put(p); p += bytes; }
          else { if (p + cnt * bytes > u8.length) return null; for (let i = 0; i < cnt && n < total; i++) { put(p); p += bytes; } }
        }
      }
      return { w, h, data: out };
    } catch (e) { return null; }
  };
  /** the part of a picture { w, h, data (RGBA) } that can be seen: its soft shadow is nearly see-through (alpha under 24 of 255), so it does not count.  The arrow is "under the
   * video" when all of that is.  { x0, y0, x1, y1 }: the first and last column and row; the whole picture when nothing can be seen */
  P.visibleBounds = t => {
    let x0 = t.w, y0 = t.h, x1 = -1, y1 = -1;
    for (let y = 0; y < t.h; y++) for (let x = 0; x < t.w; x++) if (t.data[(y * t.w + x) * 4 + 3] >= 24) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    return x1 < 0 ? { x0: 0, y0: 0, x1: t.w - 1, y1: t.h - 1 } : { x0, y0, x1, y1 };
  };
  /** the arrow's file (bytes) has been read: players that are open (or open later) draw it.  Returns false when it is not a picture we can read. */
  P.setCursorSprite = bytes => {
    const t = P.decodeTga(bytes); if (!t || !doc) return false;
    const c = doc.createElement('canvas'); c.width = t.w; c.height = t.h;
    c.getContext('2d').putImageData(new G.ImageData(t.data, t.w, t.h), 0, 0);
    sprite = { w: t.w, h: t.h, canvas: c, vis: P.visibleBounds(t) };
    note('[videos] the game\'s mouse arrow (' + t.w + 'x' + t.h + ') is ready to be drawn over the video');
    for (const f of spriteWaiters.splice(0)) { try { f(); } catch (e) { /* not ours */ } }
    return true;
  };

  /* ------------------------------------------------------------------------------------------ the player on the TV */
  const ICON = {
    play: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 4.5v15l12.5-7.5z"/></svg>',
    pause: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 4.5h4.4v15H6zM13.6 4.5H18v15h-4.4z"/></svg>',
    sound: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 9.5h4L12.5 5v14L7 14.5H3z"/><path d="M15.6 8.6a4.8 4.8 0 0 1 0 6.8M18.3 5.8a8.8 8.8 0 0 1 0 12.4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
    mute: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 9.5h4L12.5 5v14L7 14.5H3z"/><path d="M15.5 9.5l5.5 5M21 9.5l-5.5 5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
  };
  const clock = t => { t = isFinite(t) && t > 0 ? Math.floor(t) : 0; const h = Math.floor(t / 3600), m = Math.floor(t / 60) % 60, s = t % 60; return (h ? h + ':' + (m < 10 ? '0' : '') + m : m) + ':' + (s < 10 ? '0' : '') + s; };
  P.clock = clock;
  /**
   * The element for the game's window (it is put where the game's window is, by the page) and the little API the page's Flash code uses for
   * a movie (suspend / resume / volume / dispose, and cursor: where the mouse is, so that the game's arrow is drawn over the video).
   * hooks.onEnd() is called once when the video has played to its end, or cannot be played.
   * The player has controls of its own (click the picture or the first button to pause, the bar to seek, the last button for the sound), not the
   * browser's: the browser's would show its plain arrow over the video, which the game's arrow is meant to replace.
   */
  P.open = (id, hooks) => {
    const it = byId.get(id); if (!it) return null;
    hooks = hooks || {};
    const box = doc.createElement('div'); box.className = 'videoBox';
    const v = doc.createElement('video');
    v.playsInline = true; v.preload = 'auto'; v.disablePictureInPicture = true; v.setAttribute('disableremoteplayback', '');
    v.muted = !!(hooks.muted && hooks.muted());
    const msg = doc.createElement('div'); msg.className = 'videoMsg'; msg.hidden = true;
    const mk = (tag, cls) => { const e = doc.createElement(tag); e.className = cls; return e; };
    const button = (cls, label) => { const b = mk('button', cls); b.type = 'button'; b.title = label; b.setAttribute('aria-label', label); b.addEventListener('mousedown', e => e.preventDefault()); return b; };      // (a click must not take the keyboard away from the game)
    const bar = mk('div', 'videoBar'), bPlay = button('vbPlay', 'Pause'), bMute = button('vbMute', 'Sound'), seek = mk('div', 'vbSeek'), fill = mk('div', 'vbFill'), knob = mk('div', 'vbKnob'), time = mk('span', 'vbTime');
    seek.setAttribute('role', 'slider'); seek.setAttribute('aria-label', 'Position in the video'); seek.append(fill, knob);
    bar.append(bPlay, seek, time, bMute);
    const cur = mk('canvas', 'videoCursor'); cur.hidden = true;
    box.append(v, msg, bar, cur);

    let ended = false, wasPlaying = false, errTimer = 0, idleTimer = 0, dragging = false, idleAtDown = false, downType = '';
    const end = why => { if (ended) return; ended = true; note('[videos] "' + it.file + '": ' + why); if (hooks.onEnd) hooks.onEnd(why); };
    v.addEventListener('ended', () => end('played to its end'));
    v.addEventListener('error', () => {
      const code = v.error ? v.error.code : 0;
      msg.textContent = code === 4 || code === 3
        ? 'This browser cannot play “' + it.title + '”. Videos need to be MP4 (H.264/AAC) or WebM; see the README for how to convert one.'
        : 'The video “' + it.title + '” could not be loaded.';
      msg.hidden = false; note('[videos] "' + it.file + '" could not be played (media error ' + code + ')');
      clearTimeout(errTimer); errTimer = setTimeout(() => end('could not be played'), 7000);
    });

    // ---- the controls
    const paint = () => {
      const d = v.duration, f = isFinite(d) && d > 0 ? Math.min(1, v.currentTime / d) : 0;
      fill.style.width = (f * 100) + '%'; knob.style.left = (f * 100) + '%';
      seek.setAttribute('aria-valuenow', String(Math.round(f * 100)));
      time.textContent = clock(v.currentTime) + ' / ' + (isFinite(d) ? clock(d) : '-:--');
    };
    const icons = () => {
      bPlay.innerHTML = v.paused ? ICON.play : ICON.pause; bPlay.title = v.paused ? 'Play' : 'Pause'; bPlay.setAttribute('aria-label', bPlay.title);
      bMute.innerHTML = v.muted ? ICON.mute : ICON.sound; bMute.title = v.muted ? 'Sound on' : 'Sound off'; bMute.setAttribute('aria-label', bMute.title);
    };
    // the bar shows while the mouse moves over the player (and while the video is paused), and goes away after a moment
    const showBar = () => {
      box.classList.remove('idle'); clearTimeout(idleTimer);
      if (!v.paused) idleTimer = setTimeout(() => { if (!v.paused && !dragging && !bar.matches(':hover')) box.classList.add('idle'); else if (!v.paused) showBar(); }, 2500);
    };
    const toggle = () => { if (v.paused) { const p = v.play(); if (p && p.catch) p.catch(() => { }); } else v.pause(); };
    for (const e of ['timeupdate', 'durationchange', 'loadedmetadata', 'seeked']) v.addEventListener(e, paint);
    for (const e of ['play', 'pause', 'volumechange']) v.addEventListener(e, () => { icons(); showBar(); });
    bPlay.addEventListener('click', toggle);
    bMute.addEventListener('click', () => { v.muted = !v.muted; });
    v.addEventListener('pointerdown', e => { idleAtDown = box.classList.contains('idle'); downType = e.pointerType; });
    v.addEventListener('click', () => { if (idleAtDown && downType === 'touch') return; toggle(); });         // (a touch on a hidden bar only brings the bar back)
    box.addEventListener('pointermove', showBar); box.addEventListener('pointerdown', showBar);
    box.addEventListener('pointerleave', () => { clearTimeout(idleTimer); if (!v.paused && !dragging) idleTimer = setTimeout(() => box.classList.add('idle'), 600); });
    const seekTo = e => { const d = v.duration; if (!isFinite(d) || d <= 0) return; const r = seek.getBoundingClientRect(); v.currentTime = Math.min(1, Math.max(0, (e.clientX - r.left) / (r.width || 1))) * d; paint(); };
    seek.addEventListener('pointerdown', e => { if (e.button !== 0) return; dragging = true; try { seek.setPointerCapture(e.pointerId); } catch (x) { /* ignore */ } seekTo(e); e.preventDefault(); });
    seek.addEventListener('pointermove', e => { if (dragging) seekTo(e); });
    const seekEnd = () => { dragging = false; };
    seek.addEventListener('pointerup', seekEnd); seek.addEventListener('pointercancel', seekEnd);
    seek.addEventListener('mousedown', e => e.preventDefault());
    icons(); paint(); showBar();

    // ---- the game's arrow
    let haveSprite = false, curK = 0;
    const adopt = () => {
      if (haveSprite || !sprite) return;
      cur.width = sprite.w; cur.height = sprite.h; cur.getContext('2d').drawImage(sprite.canvas, 0, 0);
      haveSprite = true; box.classList.add('hascur');                   // (from now on the player hides the browser's own arrow)
    };
    adopt(); if (!haveSprite) spriteWaiters.push(adopt);
    /** real: where the mouse is, in the game's 800x600 picture (null: not on the page / a touch: no arrow); shown: where the game's own arrow is in the picture that is
     * on show (null: not known: the same place as the mouse) */
    const cursorAt = (real, shown) => {
      if (!haveSprite) return;
      const R = V.RECT, bw = box.clientWidth;
      if (!real || !isFinite(real.x) || !isFinite(real.y) || !bw) { cur.hidden = true; return; }
      const T = shown && isFinite(shown.x) && isFinite(shown.y) ? shown : real, v = sprite.vis;
      // how far inside the TV's screen all of an arrow that can be seen is, from the nearest edge (0 or less: some of it is outside, in view): the game's arrow, and the arrow at the mouse.
      // Only when both are well inside is the game's arrow out of sight under the video AND the mouse's arrow all over the video: then the page's arrow may go with the mouse.
      // (If the mouse has already left the TV and the game's arrow has not, the page's arrow stays with the game's, so there is no arrow drawn beside the TV that the game then pulls back.)
      const roomOf = p => Math.min(p.x - HOT.x + v.x0 - R.x, p.y - HOT.y + v.y0 - R.y, R.x + R.w - (p.x - HOT.x + v.x1 + 1), R.y + R.h - (p.y - HOT.y + v.y1 + 1));
      const room = Math.min(roomOf(T), roomOf(real));
      const f = room <= 0 ? 0 : Math.min(1, room / SLIDE);            // 0: go with the game's arrow, 1: go with the mouse
      const x = T.x + (real.x - T.x) * f - HOT.x - R.x, y = T.y + (real.y - T.y) * f - HOT.y - R.y;       // the picture's top-left corner, from the player's, in game pixels
      if (!f && (x >= R.w || y >= R.h || x + sprite.w <= 0 || y + sprite.h <= 0)) { cur.hidden = true; return; }       // (none of it is over the TV)
      const k = bw / R.w;
      if (k !== curK) { curK = k; cur.style.width = (sprite.w * k) + 'px'; cur.style.height = (sprite.h * k) + 'px'; }
      cur.style.transform = 'translate(' + (x * k) + 'px,' + (y * k) + 'px)';
      // (the part of the arrow that is over the TV is the page's; the part beside it is the game's own, so the page's copy is cut off at the TV's edge. With the game's arrow hidden it is not)
      cur.style.clipPath = f ? '' : 'inset(' + [Math.max(0, -y), Math.max(0, x + sprite.w - R.w), Math.max(0, y + sprite.h - R.h), Math.max(0, -x)].map(d => (d * k) + 'px').join(' ') + ')';
      cur.hidden = false;
    };

    v.src = it.url;
    const start = v.play();
    if (start && start.catch) start.catch(e => note('[videos] play() was refused (' + (e && e.name) + '): the play button starts it'));
    note('[videos] playing "' + it.file + '"' + (it.local ? ' (added on the page)' : ''));
    const api = {
      suspend() { wasPlaying = !v.paused; try { v.pause(); } catch (e) { /* ignore */ } },
      resume() { if (wasPlaying) { const p = v.play(); if (p && p.catch) p.catch(() => { }); } wasPlaying = false; },
      set volume(x) { v.muted = !x; },
      get volume() { return v.muted ? 0 : 1; },
      cursor: cursorAt,
      dispose() { clearTimeout(errTimer); clearTimeout(idleTimer); const i = spriteWaiters.indexOf(adopt); if (i >= 0) spriteWaiters.splice(i, 1); try { v.pause(); v.removeAttribute('src'); v.load(); } catch (e) { /* ignore */ } },
      video: v, item: it,
    };
    return { el: box, api };
  };

  /* ------------------------------------------------------------------------------------------ the empty room */
  const SOUND_MAX = 8, SOUND_DIR = 'sounds/';
  let clips = null, lastClip = -1, playing = null;
  async function findClips() {
    if (clips) return clips;
    const found = [];
    await Promise.all(Array.from({ length: SOUND_MAX }, (_, i) => i + 1).map(async n => {
      const url = new URL(SOUND_DIR + 'NOVIDEOS' + n + '.mp3', cfg.base || doc.baseURI).href;
      try { const r = await fetch(url, { method: 'HEAD', cache: 'no-store' }); if (r.ok) found.push({ n, url }); } catch (e) { /* not there */ }
    }));
    clips = found.sort((a, b) => a.n - b.n); return clips;
  }
  /** the room opened with no videos: one of the NOVIDEOS sounds, picked at random but never the one that played last */
  P.noVideos = async () => {
    if (playing && !playing.ended && !playing.paused) return false;       // (still talking)
    const list = await findClips();
    if (!list.length) { note('[videos] no sounds/NOVIDEOS*.mp3 found: the empty room stays silent'); return false; }
    let k = Math.floor(Math.random() * list.length);
    if (list.length > 1 && list[k].n === lastClip) k = (k + 1 + Math.floor(Math.random() * (list.length - 1))) % list.length;
    lastClip = list[k].n;
    const a = new G.Audio(list[k].url); a.muted = !!cfg.muted(); playing = a;
    note('[videos] the room is empty: playing NOVIDEOS' + list[k].n + '.mp3');
    try { await a.play(); return true; } catch (e) { note('[videos] the sound was refused (' + (e && e.name) + ')'); return false; }
  };
  P.setMuted = on => { if (playing) playing.muted = !!on; };
  P.pauseSound = pause => { if (!playing) return; try { if (pause) { playing._wasPlaying = !playing.paused && !playing.ended; playing.pause(); } else if (playing._wasPlaying) { playing._wasPlaying = false; playing.play().catch(() => { }); } } catch (e) { /* ignore */ } };
  P._clips = () => clips && clips.map(c => c.n);       // (tests)
})(typeof globalThis !== 'undefined' ? globalThis : this);
