/* The video list of the game's Sing-Along room ("Video", reached from the TV in the Backyard) - the parts that need no browser:
 * where the buttons go, what the list file for the game looks like, what the buttons' pictures are called, and a small PNG writer.
 *
 * How the room works (read from the game's own code, 2.0.0 and 2.0.3): when it opens it downloads a list of its videos, "movies.ini", from
 * the Playhouse server, which is gone.  The list holds, for each video, a button picture (downloaded from the same server), the place of the
 * button on the screen, and a "VideoName".  The game shows every button where its list puts it, and a click starts a little Flash movie
 * (stub.swf) with the VideoName as its FlashVars; that movie played the video from the server.  Here the page keeps its own list of videos,
 * the stand-in server (server.js) gives the game a list made from it, with button pictures made by the page, and the player (flashctl.js
 * and the page) plays the clicked video in a player of its own (the browser's video) instead of the Flash movie.
 *
 * What the game reads from the list (CBackyardVideo::OnStartRoom, 2.0.3 at 0x4201e0):
 *     [Video]
 *     NumButtons=N
 *     [Video00]            (then Video01 ... : two digits)
 *     ButtonName=<the picture's file name; downloaded from the server when the game has no such file>
 *     ButtonPos=x, y       (where the centre of the button goes)
 *     VideoName=<FlashVars for stub.swf, more than 5 characters>
 * The picture is "two frames side by side" (normal, then lit up when the mouse is over it), like the game's own DefaultBtn.png.
 */
(function (G) {
  'use strict';
  const EMU = G.EMU = G.EMU || {};
  const V = {};

  /** the game's window for the video: the screen of the TV (480x360 inside by_vid_bg.tga's black screen) */
  V.RECT = { x: 161, y: 78, w: 480, h: 360 };
  /** how many videos fit on the TV; the rest are left out (the list is in file name order) */
  V.MAX = 36;
  /** the file types the page offers to its browser's player */
  V.EXT = /\.(mp4|m4v|webm|ogv|mov|mkv)$/i;
  V.isVideoName = n => V.EXT.test(String(n || ''));

  /** "01 - Hot Potato_(Sing-Along).mp4" -> "Hot Potato (Sing-Along)" */
  V.cleanTitle = file => {
    let t = String(file == null ? '' : file).replace(/^.*[\\/]/, '').replace(/\.[A-Za-z0-9]{2,4}$/, '');
    t = t.replace(/^\s*\d{1,3}\s*[-._)]+\s*(?=\S)/, '');           // a leading "01 - " / "02." / "3_" is only there to put the videos in order
    t = t.replace(/_+/g, ' ').replace(/\s+/g, ' ').trim();
    return t || String(file == null ? '' : file).trim();
  };
  /** the order of the videos on the TV: by name, numbers by their value ("2" before "10"), upper and lower case alike */
  V.compareNames = (a, b) => {
    const x = String(a).toLowerCase(), y = String(b).toLowerCase();
    const ra = x.split(/(\d+)/), rb = y.split(/(\d+)/);
    for (let i = 0; i < Math.min(ra.length, rb.length); i++) {
      if (ra[i] === rb[i]) continue;
      if (i % 2 === 1) { const d = (+ra[i]) - (+rb[i]); if (d) return d; }
      return ra[i] < rb[i] ? -1 : 1;
    }
    return ra.length - rb.length || (x < y ? -1 : x > y ? 1 : 0);
  };

  /**
   * Where the buttons go for n videos.  The picture of a button is cw x ch (one frame; the file is twice as wide); the buttons fill the TV's
   * screen in rows, each row centred.  Returns { n, cols, rows, w, h, cells: [{ x, y }] } with x, y the top left of each button in the game's
   * 800x600 coordinates.  Few videos get big buttons (2 or 4 of 240x180), many get small ones (36 of 80x60); the buttons touch, so their
   * pictures carry their own margin.
   */
  V.layout = n => {
    n = Math.max(0, Math.min(V.MAX, n | 0));
    const R = V.RECT, out = { n, cols: 0, rows: 0, w: 0, h: 0, cells: [] };
    if (!n) return out;
    const cols = Math.max(2, Math.min(6, Math.ceil(Math.sqrt(n))));
    const w = Math.floor(R.w / cols), h = Math.floor(w * 3 / 4), rows = Math.ceil(n / cols);
    const y0 = R.y + Math.floor((R.h - rows * h) / 2);
    for (let i = 0; i < n; i++) {
      const r = Math.floor(i / cols), inRow = r === rows - 1 ? n - r * cols : cols;
      const x0 = R.x + Math.floor((R.w - inRow * w) / 2);
      out.cells.push({ x: x0 + (i - r * cols) * w, y: y0 + r * h });
    }
    out.cols = cols; out.rows = rows; out.w = w; out.h = h;
    return out;
  };

  const pad2 = i => (i < 10 ? '0' : '') + i;
  /** names that belong to one list ("generation"): a new list gets new names, so that pictures the game has kept from an earlier list are not mistaken for its own */
  V.videoId = (gen, i) => 'v' + gen + '_' + pad2(i);
  V.thumbName = (gen, i) => 'ptovid_g' + gen + '_' + pad2(i) + '.png';
  V.THUMB_RE = /^ptovid_g(\d+)_(\d+)\.png$/i;
  V.ID_RE = /^v(\d+)_(\d+)$/;
  /** the video named in the FlashVars the game gave stub.swf ("streamloc=v1_03"), or null */
  V.videoOfVars = vars => {
    const m = /(?:^|[&?])streamloc=([^&]*)/i.exec(String(vars || '')); if (!m) return null;
    let id = m[1]; try { id = decodeURIComponent(id); } catch (e) { /* as it is */ }
    return V.ID_RE.test(id) ? id : null;
  };
  /** a path or address -> its last part */
  V.baseName = p => String(p || '').split(/[\\/]/).pop().split(/[?#]/)[0];

  /**
   * The list file for the game.  ButtonName is only the picture's file name: the game looks for it in the room's folders and the game's data, and when
   * it is not there, downloads it from the server (by that name) into the room's folder.  (A whole path does not work: the game puts the room's
   * folder in front of whatever it is given.)  ButtonPos is where the CENTRE of the button goes (found by trying: a button of 160x120 given
   * 161, 138 is drawn from 81, 78).  `anchor`: 'center' (what the game does) | 'topleft' (a position that is the button's top left).
   */
  V.makeIni = (n, gen, anchor) => {
    const lay = V.layout(n), L = ['[Video]', 'NumButtons=' + lay.n, ''];
    for (let i = 0; i < lay.n; i++) {
      const c = lay.cells[i], x = anchor === 'topleft' ? c.x : c.x + (lay.w >> 1), y = anchor === 'topleft' ? c.y : c.y + (lay.h >> 1);
      L.push('[Video' + pad2(i) + ']', 'ButtonName=' + V.thumbName(gen, i), 'ButtonPos=' + x + ', ' + y, 'VideoName=streamloc=' + V.videoId(gen, i), '');
    }
    return L.join('\r\n');
  };

  /** what a list of videos from a server may look like: ["a.mp4", ...], [{ file, title, size }], { videos: [...] }, or a web server's folder listing */
  V.parseList = text => {
    let data = null;
    try { data = JSON.parse(text); } catch (e) { /* maybe a folder listing */ }
    let arr = null;
    if (Array.isArray(data)) arr = data; else if (data && Array.isArray(data.videos)) arr = data.videos;
    const out = [];
    if (arr) {
      for (const e of arr) {
        const file = typeof e === 'string' ? e : e && typeof e.file === 'string' ? e.file : null;
        if (!file || !V.isVideoName(file)) continue;
        out.push({ file, title: (e && typeof e.title === 'string' && e.title.trim()) || V.cleanTitle(file), size: e && +e.size > 0 ? +e.size : 0 });
      }
    } else if (data === null && /<a\s/i.test(String(text))) {        // (python -m http.server and most others list a folder as links)
      const re = /<a\s[^>]*href\s*=\s*["']([^"']+)["']/gi; let m;
      while ((m = re.exec(text))) {
        let f = m[1].split(/[?#]/)[0]; try { f = decodeURIComponent(f); } catch (e) { continue; }
        if (f.indexOf('/') >= 0 || !V.isVideoName(f)) continue;
        out.push({ file: f, title: V.cleanTitle(f), size: 0 });
      }
    }
    const seen = new Set();
    return out.filter(e => !seen.has(e.file) && seen.add(e.file)).sort((a, b) => V.compareNames(a.file, b.file));
  };

  /* ---- PNG writer (8 bit RGB, no compression: the pictures are small and nothing here needs a compressor) */
  let crcTab = null;
  const crc32 = (u, a, b) => {
    if (!crcTab) { crcTab = new Int32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crcTab[n] = c; } }
    let c = -1; for (let i = a; i < b; i++) c = crcTab[(c ^ u[i]) & 255] ^ (c >>> 8);
    return (c ^ -1) >>> 0;
  };
  const adler32 = u => { let a = 1, b = 0; for (let i = 0; i < u.length; i++) { a = (a + u[i]) % 65521; b = (b + a) % 65521; } return ((b << 16) | a) >>> 0; };
  /** `rgb`: w*h*3 bytes.  Pure black and pure magenta are nudged by one step: a game's picture loader may take those for "see-through". */
  V.encodePng = (w, h, rgb) => {
    const row = w * 3 + 1, raw = new Uint8Array(row * h);
    for (let y = 0; y < h; y++) {
      const o = y * row + 1, s = y * w * 3;
      for (let x = 0; x < w * 3; x += 3) {
        let r = rgb[s + x], g = rgb[s + x + 1], b = rgb[s + x + 2];
        if (r === 0 && g === 0 && b === 0) { r = g = b = 1; } else if (r === 255 && g === 0 && b === 255) g = 1;
        raw[o + x] = r; raw[o + x + 1] = g; raw[o + x + 2] = b;
      }
    }
    const blocks = Math.max(1, Math.ceil(raw.length / 65535)), z = new Uint8Array(2 + raw.length + blocks * 5 + 4);
    let p = 0; z[p++] = 0x78; z[p++] = 0x01;
    for (let i = 0; i < blocks; i++) {
      const a = i * 65535, n = Math.min(65535, raw.length - a);
      z[p++] = i === blocks - 1 ? 1 : 0; z[p++] = n & 255; z[p++] = n >> 8; z[p++] = ~n & 255; z[p++] = (~n >> 8) & 255;
      z.set(raw.subarray(a, a + n), p); p += n;
    }
    const ad = adler32(raw); z[p++] = ad >>> 24; z[p++] = (ad >>> 16) & 255; z[p++] = (ad >>> 8) & 255; z[p++] = ad & 255;
    const out = new Uint8Array(8 + 25 + 12 + z.length + 12); let o = 0;
    const u32 = v => { out[o++] = v >>> 24; out[o++] = (v >>> 16) & 255; out[o++] = (v >>> 8) & 255; out[o++] = v & 255; };
    const chunk = (type, body) => {
      u32(body.length); const s = o; for (let i = 0; i < 4; i++) out[o++] = type.charCodeAt(i);
      out.set(body, o); o += body.length; u32(crc32(out, s, o));
    };
    out.set([137, 80, 78, 71, 13, 10, 26, 10]); o = 8;
    chunk('IHDR', Uint8Array.of(w >>> 24, (w >>> 16) & 255, (w >>> 8) & 255, w & 255, h >>> 24, (h >>> 16) & 255, (h >>> 8) & 255, h & 255, 8, 2, 0, 0, 0));
    chunk('IDAT', z.subarray(0, p));
    chunk('IEND', new Uint8Array(0));
    return out.subarray(0, o);
  };

  EMU.Videos = V;
})(typeof globalThis !== 'undefined' ? globalThis : this);
