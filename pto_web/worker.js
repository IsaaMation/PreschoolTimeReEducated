/* Playhouse Disney Preschool Time Online, browser player: emulator worker.
 *
 * Runs the original DisneyPO.exe inside the x86 emulator (emu/*.js) with replacement Windows / Miles sound / Bink / Smacker libraries and
 * a small in-page stand-in for the game's server. The game's files are read where they lie: installer programs (.exe) and zips,
 * also zips stored inside a zip, are read with HTTP Range requests (or from files chosen on the page) and only the parts that the
 * game asks for are fetched and unpacked.
 *
 * Messages in : {type:'scan', base, debug} {type:'addFiles', files} {type:'init', edition, lessons, nickname, debug, nocomp, fixedDate}
 *               {type:'input', ev} {type:'pause'} {type:'resume'} {type:'flush'} {type:'wipe'} {type:'recycle', buf}
 * Messages out: {type:'status', text} {type:'editions', editions, notes, files} {type:'frame', w, h, buf, te} {type:'audio', samples, te}
 *               {type:'log', lines} {type:'error', message, user, detail} {type:'exit', code} {type:'stats', ...} {type:'ready'}
 *               {type:'print', name, pages} {type:'wiped'}
 * (te: the time, in milliseconds on the clock that the page also uses, at which the worker made the frame / the end of the sound;
 *  the page uses it to show a picture together with its sound.)
 */
'use strict';

importScripts('emu/smk.js');
for (const f of ['x86dec', 'cpu', 'jit_core', 'jit_alu', 'jit_misc', 'pe', 'vfs', 'machine', 'kernel32a', 'kernel32b',
  'inflate', 'archives', 'editions', 'audiodec', 'mp3tab', 'mp3', 'advapi32', 'user32', 'gdi32', 'ddraw', 'dsound', 'kernel32c', 'user32b', 'gdi32b', 'misc',
  'mss32', 'bink_tables', 'bink', 'binkw32', 'smack', 'swfinfo', 'videolist', 'flashctl', 'wininet', 'ws2_32', 'server', 'hle', 'stallrec']) importScripts('emu/' + f + '.js');

const post = (type, data, transfer) => { const o = data || {}; o.type = type; self.postMessage(o, transfer || []); };
const epoch = () => performance.timeOrigin + performance.now();       // wall-clock milliseconds, comparable with the page's clock
const status = text => post('status', { text });

/* ------------------------------------------------------------------------------------------------ settings */
const FRAME_MS = 1000 / 60;        // the game's frame function is run at most this often
const SLICE_BLOCKS = 30000;        // guest basic blocks per slice
const BUDGET_MS = 10;              // longest time spent in one go before the worker lets input messages through
const LATE_MS = 40;                // the worker was held up (garbage collection, a busy computer ...) for longer than this: the game does not see the delay
const SAVE_DB = 'preschool-time-online', SAVE_STORE = 'kv';

/* names tried in the game folder when it has no files.json (the names of the files as they were shared) */
const DEFAULT_FILES = [];
for (const v of ['2.0.0', '2.0.3', '2.0.6']) DEFAULT_FILES.push('PlayhouseInstall' + v + '.exe', 'PlayhouseInstallABC' + v + '.exe', 'Playhouse Disney Preschool Time Online ' + v + '.zip', 'PackageBC' + v + '.zip');
DEFAULT_FILES.push('LP0516_lesson_0516_2.0.6.zip');

let m = null, cfg = null, running = false, paused = false, fatal = false, finished = false;
let timer = 0, soonFlag = false, yielded = false, blocked = false, nextTick = 0, lastPost = 0, pausedAt = 0, wakeDue = 0;
let pendingMove = null;
let rec = null;                    // ?debug: the stall recorder (emu/stallrec.js)
let nestedAt = 0, nestedSvc = 0;
let sliceThreads = true;           // the game's threads take turns (as on Windows) instead of only when one of them waits; ?debug&threads=coop turns this off
const pool = [];                   // recycled frame buffers
const stats = { ticks: 0, frames: 0, t: 0, busy: 0, held: 0, waited: 0, hc: 0, hp: 0, hd: 0 };
let logBuf = [], logTimer = 0;

class UserError extends Error { }

/* ------------------------------------------------------------------------------------------------ log */
function log(s) {
  logBuf.push(s);
  if (!logTimer) logTimer = setTimeout(flushLog, 250);
}
function flushLog() {
  logTimer = 0;
  if (logBuf.length) { post('log', { lines: logBuf.slice(-200) }); logBuf = []; }
}

/* A read of one of the game's files failed (or works again): tell the page at once.  The worker may be waiting inside that very request, so nothing here may depend on
 * its timers (log() alone would only be sent after the wait).  emu/archives.js repeats the request; the page shows a notice while that goes on. */
EMU.Net.note = info => {
  const what = '"' + info.name + '"';
  log('[files] ' + (info.state === 'retry' ? what + ' could not be read (' + info.message + '); trying again (' + info.attempt + ' of ' + info.of + ')'
    : info.state === 'ok' ? what + ' can be read again (after ' + info.attempt + ' failed ' + (info.attempt === 1 ? 'try' : 'tries') + ')'
      : what + ' could not be read, giving up after ' + info.attempt + ' tries (' + info.message + ')'));
  flushLog();
  post('net', { state: info.state, name: info.name, attempt: info.attempt, of: info.of, message: info.message });
};

/* ------------------------------------------------------------------------------------------------ text (GDI) via OffscreenCanvas */
const CP1252 = { 0x80: 0x20AC, 0x82: 0x201A, 0x83: 0x0192, 0x84: 0x201E, 0x85: 0x2026, 0x86: 0x2020, 0x87: 0x2021, 0x88: 0x02C6, 0x89: 0x2030, 0x8A: 0x0160, 0x8B: 0x2039, 0x8C: 0x0152,
  0x8E: 0x017D, 0x91: 0x2018, 0x92: 0x2019, 0x93: 0x201C, 0x94: 0x201D, 0x95: 0x2022, 0x96: 0x2013, 0x97: 0x2014, 0x98: 0x02DC, 0x99: 0x2122, 0x9A: 0x0161, 0x9B: 0x203A, 0x9C: 0x0153, 0x9E: 0x017E, 0x9F: 0x0178 };
const uni = ch => { const c = ch.charCodeAt(0); return CP1252[c] ? String.fromCharCode(CP1252[c]) : ch; };

function makeTextBackend() {
  if (typeof OffscreenCanvas === 'undefined') return null;
  const FAMILY = '"Arial", "Liberation Sans", "Helvetica Neue", Helvetica, "DejaVu Sans", sans-serif';
  const emOf = f => { const h = f.height || 16; return h < 0 ? -h : Math.max(1, Math.round(h / 1.117)); };
  const fontStr = f => (f.italic ? 'italic ' : '') + (f.weight >= 600 ? 'bold ' : '') + emOf(f) + 'px ' + FAMILY;
  const probe = new OffscreenCanvas(8, 8).getContext('2d');
  const advCache = new Map();
  const adv = (f, ch) => {                       // whole-pixel advance, like a hinted Windows font
    if (ch.charCodeAt(0) < 32) return 0;
    const key = fontStr(f) + '|' + ch;
    let w = advCache.get(key);
    if (w === undefined) { probe.font = fontStr(f); w = Math.max(1, Math.round(probe.measureText(uni(ch)).width)); advCache.set(key, w); }
    return w;
  };
  const metrics = f => {
    const em = emOf(f), ascent = Math.round(em * 0.905), descent = Math.round(em * 0.212);
    return { ascent, descent, internal: ascent + descent - em, avgWidth: Math.round(em * 0.5), maxWidth: em };
  };
  return {
    metrics,
    measure: (f, s) => { let w = 0; for (const ch of s) w += adv(f, ch); return w; },
    render: (f, s) => {
      const mt = metrics(f), advs = []; let w = 0;
      for (const ch of s) { const a = adv(f, ch); advs.push(a); w += a; }
      w = Math.max(1, w); const h = mt.ascent + mt.descent;
      const cx = new OffscreenCanvas(w, h).getContext('2d', { willReadFrequently: true });
      cx.font = fontStr(f); cx.textBaseline = 'alphabetic'; cx.fillStyle = '#fff';
      let x = 0, i = 0;
      for (const ch of s) { if (ch !== ' ' && ch.charCodeAt(0) >= 32) cx.fillText(uni(ch), x, mt.ascent); x += advs[i++]; }
      const d = cx.getImageData(0, 0, w, h).data, alpha = new Uint8Array(w * h);
      for (let k = 0; k < w * h; k++) { const a = d[k * 4 + 3] * 1.3; alpha[k] = a > 255 ? 255 : a; }   // the game keeps pixels at >= 50 % coverage: thin strokes need a little help
      return { w, h, alpha };
    },
  };
}

/* ------------------------------------------------------------------------------------------------ the game's files */
function syncReq(method, url, headers, binary) {
  const x = new XMLHttpRequest();
  x.open(method, url, false);
  if (binary) x.responseType = 'arraybuffer';
  for (const k in (headers || {})) x.setRequestHeader(k, headers[k]);
  try { x.send(); } catch (e) { return { status: 0, x }; }
  return { status: x.status, x };
}
/** syncReq, once more after a moment when the request failed at the network level or the server said "busy just now" (a hiccup of the server must not make a game file look missing) */
function probeReq(method, url, headers, binary) {
  let r = syncReq(method, url, headers, binary);
  if (r.status === 0 || EMU.Net.later(r.status)) { EMU.Net.sleep(200); r = syncReq(method, url, headers, binary); }
  return r;
}
const encPath = p => p.split('/').map(encodeURIComponent).join('/');

/** size of a file on the server, or -1 when it is not there */
function sizeOf(url, name) {
  const h = probeReq('HEAD', url);
  if (h.status === 200) {
    if (/text\/html/i.test(h.x.getResponseHeader('Content-Type') || '') && !/\.html?$/i.test(name)) return -1;   // a "page not found" page served with status 200
    const n = parseInt(h.x.getResponseHeader('Content-Length'), 10);
    if (n >= 0) return n;
  }
  if (h.status === 405 || h.status === 501 || h.status === 200) {              // no HEAD / no length: ask for one byte
    const g = probeReq('GET', url, { Range: 'bytes=0-0' }, true);
    if (g.status === 206) { const cr = /\/(\d+)\s*$/.exec(g.x.getResponseHeader('Content-Range') || ''); if (cr) return parseInt(cr[1], 10); }
  }
  return -1;
}

/** the files the host provides: game/files.json (names, or {name, url, size}) and, when that is missing, the usual names */
function probeHost(base) {
  base = base.replace(/\/?$/, '/');
  let list = null;
  const fj = probeReq('GET', base + 'files.json', {}, false);
  if (fj.status === 200) { try { const j = JSON.parse(fj.x.responseText); list = (Array.isArray(j) ? j : j.files || []).map(e => typeof e === 'string' ? { name: e } : e); } catch (e) { /* a broken list: use the usual names */ } }
  const named = !!list;
  if (!list) list = DEFAULT_FILES.map(n => ({ name: n }));
  const out = [];
  for (const e of list) {
    const url = e.url || base + encPath(e.name);
    const size = typeof e.size === 'number' ? e.size : sizeOf(url, e.name);
    if (size >= 0) out.push({ name: e.name.replace(/^.*\//, ''), url, size });
    else if (named) out.push({ name: e.name.replace(/^.*\//, ''), url, size: -1, missing: true });
  }
  return { files: out, named };
}

/** a server that ignores Range would send whole files: find out before the game starts */
function checkRange(files) {
  const f = files.filter(x => !x.missing).sort((a, b) => a.size - b.size)[0];
  if (!f) return;
  const t = probeReq('GET', f.url, { Range: 'bytes=0-15' }, true);
  if (t.status === 0 || EMU.Net.later(t.status)) throw new UserError('The web server did not answer a request for ' + f.name + ' (' + (t.status ? 'it said HTTP ' + t.status : 'the connection failed') + '). Is the server (serve.py) still running? Start it again and press Try again.');
  if (t.status !== 206) throw new UserError('The web server does not support HTTP Range requests (it answered ' + t.status + ' to a partial request for ' + f.name + '). The big archives are read in pieces, so the server must support them. See README.md.');
}

/* ------------------------------------------------------------------------------------------------ sources and editions */
const cache = new EMU.ChunkCache();
let hostFiles = [], localFiles = [], found = null, hostBase = 'game/';
cache.onWait = ms => { if (m && cfg && !cfg.nocomp) { m.skew -= ms; stats.waited += ms; } };   // a download blocks the worker; to the game it took no time

function scanSources() {
  const list = [];
  for (const f of hostFiles) if (!f.missing) list.push({ name: f.name, file: f.file || (f.file = EMU.httpFile(f.url, f.name, f.size)) });
  for (const f of localFiles) list.push({ name: f.name, file: f.file });
  found = EMU.Editions.scan(list, cache);
  const d = EMU.Editions.describe(found);
  d.files = hostFiles.map(f => ({ name: f.name, size: f.size, missing: !!f.missing })).concat(localFiles.map(f => ({ name: f.name, size: f.file.size, local: true })));
  post('editions', d);
}

function scan(c) {
  hostBase = c.base || hostBase;
  status('Looking for the game files…');
  const h = probeHost(hostBase);
  hostFiles = h.files;
  if (hostFiles.some(f => !f.missing)) checkRange(hostFiles);
  status('Reading what the files hold…');
  scanSources();
}

function addFiles(files) {
  for (const f of files) {
    if (localFiles.some(x => x.name === f.name && x.file.size === f.size)) continue;
    localFiles.push({ name: f.name, file: EMU.blobFile(f, f.name) });
  }
  status('Reading what the files hold…');
  scanSources();
}

/* ------------------------------------------------------------------------------------------------ saved games / settings (IndexedDB) */
function idb() {
  return new Promise((res, rej) => {
    if (typeof indexedDB === 'undefined') return rej(new Error('no IndexedDB'));
    const r = indexedDB.open(SAVE_DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(SAVE_STORE);
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
}
const idbGet = (db, k) => new Promise((res, rej) => { const q = db.transaction(SAVE_STORE).objectStore(SAVE_STORE).get(k); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); });
const idbPut = (db, k, v) => new Promise((res, rej) => { const t = db.transaction(SAVE_STORE, 'readwrite'); t.objectStore(SAVE_STORE).put(v, k); t.oncomplete = () => res(); t.onerror = () => rej(t.error); });

let saveDb = null, saveDirty = false, saveSig = '', saveKey = 'state', bootReg = new Map();
const isBootFile = path => /\\disneypo\.ini$/.test(path);       // written fresh at every start from the choices on the page (config.ini is kept: what the game wrote in it is the grown-up's Preferences and the garden's plant; only its [LessonPlan] part is renewed, see mergeConfig)
// what the Sing-Along room downloads (its list and the pictures of its buttons) is made from the page's videos at every start: kept, an old list or picture would be found by the game next time and used instead of the new one
const isTransient = path => /\\(ptovid_g\d+_\d+\.png|userdata\\movies\.ini)$/.test(path);
function snapshot() {
  const files = [];
  for (const [path, u] of m.userFiles) if (!isBootFile(path) && !isTransient(path)) files.push([path, u.data.slice(0, u.size)]);
  const reg = [];
  for (const [path, k] of m.registry) {
    const vals = [], b = bootReg.get(path);
    for (const [low, v] of k) if (!b || b.get(low) !== regSig(v)) vals.push([low, v.name, v.type, v.data]);     // (what the emulator itself put there is not kept)
    if (vals.length) reg.push([path, vals]);
  }
  return { files, reg };
}
const regSig = v => v.type + ':' + Array.prototype.join.call(v.data, ',');
function noteBootRegistry() { bootReg = new Map(); for (const [path, k] of m.registry) { const x = new Map(); for (const [low, v] of k) x.set(low, regSig(v)); bootReg.set(path, x); } }
function signature(s) {
  let h = 2166136261 >>> 0;
  const mix = n => { h = Math.imul(h ^ (n & 255), 16777619) >>> 0; };
  const str = t => { for (let i = 0; i < t.length; i++) mix(t.charCodeAt(i)); mix(0); };
  for (const [p, d] of s.files) { str(p); for (let i = 0; i < d.length; i++) mix(d[i]); mix(d.length); }
  for (const [p, vals] of s.reg) { str(p); for (const [l, n, t, d] of vals) { str(l); str(n); mix(t); for (let i = 0; i < d.length; i++) mix(d[i]); } }
  return h.toString(16) + ':' + s.files.length + ':' + s.reg.length;
}
async function saveNow() {
  if (!saveDb || !m) return;
  saveDirty = false;
  const s = snapshot(), sig = signature(s);
  if (sig === saveSig) return;
  try { await idbPut(saveDb, saveKey, s); saveSig = sig; } catch (e) { log('[save] failed: ' + e.message); }
}
async function restoreSaved() {
  try { saveDb = await idb(); } catch (e) { saveDb = null; return; }
  let s = null; try { s = await idbGet(saveDb, saveKey); } catch (e) { return; }
  if (!s) return;
  for (const [path, data] of s.files || []) if (!isBootFile(path) && !isTransient(path)) m.userFiles.set(path, { data: new Uint8Array(data), size: data.length });
  for (const [path, vals] of s.reg || []) { const k = m.registry.get(path) || new Map(); for (const [low, name, type, data] of vals) k.set(low, { name, type, data: new Uint8Array(data) }); m.registry.set(path, k); }
  saveSig = signature(snapshot());
  log('[save] restored ' + (s.files || []).length + ' file(s) and ' + (s.reg || []).length + ' registry key(s) from this browser');
}
/** mark the saved state as possibly changed whenever the guest touches player files or the registry */
function watchSaves() {
  for (const n of ['CreateFileA', 'WriteFile', 'SetEndOfFile', 'DeleteFileA', 'CloseHandle', 'MoveFileA', 'CopyFileA']) {
    const a = m.apis.get('kernel32.dll!' + n); if (!a) continue;
    const f = a.fn; a.fn = function () { saveDirty = true; return f.apply(this, arguments); };
  }
  const rs = m.regSet; if (rs) m.regSet = function () { saveDirty = true; return rs.apply(this, arguments); };
  setInterval(() => { if (saveDirty) saveNow(); }, 2000);
}

/* ------------------------------------------------------------------------------------------------ scheduling */
const mc = new MessageChannel();
mc.port1.onmessage = () => { soonFlag = false; if (timer) { clearTimeout(timer); timer = 0; } pump(); };
function requestRun(ms) {
  if (!running || paused || fatal || finished) return;
  const now = performance.now();
  if (ms <= 0.5) { wakeDue = wakeDue ? Math.min(wakeDue, now) : now; if (!soonFlag) { soonFlag = true; mc.port2.postMessage(0); } return; }
  if (!(soonFlag && wakeDue)) wakeDue = now + ms;        // (a message that is already on its way will run first)
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => { timer = 0; pump(); }, ms);
}

function applyPendingMove() {
  if (pendingMove && m.mainWnd) m.sendInput({ type: 'mousemove', x: pendingMove.x, y: pendingMove.y });
  pendingMove = null;
}

function emitAudio() {
  const mx = m.mixer; if (!mx) return;
  mx.sync(m.now());
  const a = mx.pull(1 << 16);
  if (a.length) post('audio', { samples: a, te: epoch(), keep: mx.pullKeep }, [a.buffer]);      // (keep: a voice or an effect is in it: the player must not throw it away)
}
/** the game draws into the window's picture (m.video.rgba); `dirty` says that it changed since it was last taken */
function emitFrame(force) {
  const V = m.video; if (!V || !V.rgba) return;
  if (!V.dirty && !force) return;
  const need = V.width * V.height * 4;
  let buf = pool.pop(); if (!buf || buf.length !== need) buf = new Uint8ClampedArray(need);
  const rgba = m.getFrameRGBA(buf);
  // (mx, my: where the game's own mouse arrow is in this picture, so that the page can carry it on over a video. The game draws its arrow where GetCursorPos last told it the mouse was
  // (measured: that is the arrow's place in 100 % of the pictures, while the mouse's place at the moment the picture is sent is one step ahead of it in about 5 %: the game can begin
  // a frame in one pump and finish it in the next, and a new mouse place is handed over at the start of a pump). Until the game has asked even once, the mouse's place)
  const I = m.input, mx = m.pollX !== undefined ? m.pollX : I ? I.x : undefined, my = m.pollY !== undefined ? m.pollY : I ? I.y : undefined;
  post('frame', { w: V.width, h: V.height, buf: rgba.buffer, te: epoch(), mx, my }, [rgba.buffer]);
  stats.frames++;
}

/** The host is inside a call into guest code that has been running for a while (a window procedure with a message loop of its own ...).
 *  The pump does not get to run then, so its work is done here: the sound, and the picture as far as the game has drawn it. */
function nestedService() {
  const now = performance.now(), ms = now - nestedAt; nestedAt = now;
  const ticked = yielded; if (yielded) { yielded = false; stats.ticks++; }
  if (rec) rec.after(ms > 100 ? 0 : ms, ticked, m.cur.id);
  if (now - nestedSvc < 10) return;
  nestedSvc = now;
  emitAudio();
  if (now - lastPost >= 33) { emitFrame(false); lastPost = now; }
}

function pump() {
  if (!m || !running || paused || fatal || finished) return;
  const t0 = performance.now();
  /* The game's clock is the computer's clock, so a long hold-up of this thread (a big garbage collection, other programs, a slow
   * download) would make the game believe that a lot of time had passed: its animations and video clips would race to catch up and
   * the sound would end up behind the picture. Time that the worker was held up while it wanted to run is taken off the game's clock. */
  if (wakeDue) { const late = t0 - wakeDue; wakeDue = 0; if (late > LATE_MS && !cfg.nocomp) { m.skew -= late - 1; stats.held += late; } }
  try { pumpLoop(t0); } finally { stats.busy += performance.now() - t0; }
}
function pumpLoop(t0) {
  blocked = false;
  applyPendingMove();
  for (; ;) {
    const s0 = rec ? performance.now() : 0, tid0 = rec ? m.cur.id : 0;
    try { m.step(SLICE_BLOCKS); } catch (e) { return fail(e); }
    if (m.exited) return done();
    if (rec) rec.after(performance.now() - s0, yielded || m.idling, tid0);
    if (!yielded && !m.idling && sliceThreads) m.preempt();           // (a thread that has used up its slice without giving way: the next one gets its turn)
    if (m.idling) {                                   // every guest thread is waiting
      emitAudio(); emitFrame(false); lastPost = performance.now(); blocked = true;
      // (wake at least every 20 ms, so that sound that is still playing keeps flowing to the speakers)
      return requestRun(m.idleWake === undefined ? 20 : Math.min(20, Math.max(1, m.idleWake - m.now())));
    }
    if (yielded) {                                    // the game finished one frame function and polls its message queue
      yielded = false; stats.ticks++;
      const now = performance.now();
      emitAudio();
      if (now - lastPost >= 8) { emitFrame(false); lastPost = now; }
      // one frame function per time slot: early -> wait for the slot; late -> go on at once (and forget the backlog if it grows large)
      if (now < nextTick - 0.5) { const w = nextTick - now; nextTick += FRAME_MS; return requestRun(w); }
      nextTick = (now - nextTick > 4 * FRAME_MS ? now : nextTick) + FRAME_MS;
    }
    if (performance.now() - t0 > BUDGET_MS) {
      emitAudio();
      const now = performance.now();
      if (now - lastPost >= 33) { emitFrame(false); lastPost = now; }       // the game has not come back to its message loop for a while (a scene is loading ...): show what it has drawn so far
      return requestRun(0);
    }
  }
}

function fail(e) {
  fatal = true; flushLog();
  let dump = ''; try { dump = m.cpu.recentDump(); } catch (x) { /* ignore */ }
  post('error', { message: e && e.message || String(e), detail: (e && e.stack || '') + dump + '\n\nfile reads: ' + JSON.stringify(EMU.Net.stats), network: !!(e && e.net) });
  saveNow();
}
function done() {
  finished = true; if (rec) rec.end(); emitAudio(); emitFrame(true); flushLog();
  post('exit', { code: m.exitCode | 0 });
  saveNow();
}

/* ------------------------------------------------------------------------------------------------ start up */
function newMachine(opts) {
  let last;
  for (const mb of [512, 384, 256, 192, 128]) {
    try { return new EMU.Machine(Object.assign({ memBytes: mb * 1024 * 1024 }, opts)); } catch (e) { last = e; }
  }
  throw last;
}
const readAll = (vfs, key) => { const h = vfs.open(key); return new Uint8Array(h.read(0, h.size)); };

async function boot(c) {
  cfg = c;
  if (c.debug && Array.isArray(c.netWaits) && c.netWaits.every(n => n >= 0 && n < 60000)) EMU.Net.waits = c.netWaits.slice();     // ?debug&netwaits=0,100,...: shorter waits between the repeats of a failed read (for tests)
  if (!found) throw new UserError('The game files have not been looked at yet.');
  const ed = found.editions.find(e => e.id === c.edition);
  if (!ed || !ed.ready) throw new UserError('Version ' + c.edition + ' cannot be started: ' + ((ed && ed.notes[0]) || 'its files are not complete') + '.');
  const lessons = (c.lessons && c.lessons.length ? c.lessons : []).filter(Boolean);
  status('Opening the game files…');
  const mnt = EMU.Editions.mount(ed, lessons);
  const vfs = mnt.vfs;
  if (!vfs.stat('disneypo.exe')) throw new UserError('DisneyPO.exe was not found in the files for ' + ed.id + '.');
  status('Loading DisneyPO.exe…');
  const exe = readAll(vfs, 'disneypo.exe');
  const lesson = lessons[0] || mnt.builtin[0] || null;
  saveKey = 'state-' + ed.id;

  status('Starting…');
  const local = Date.now() - new Date().getTimezoneOffset() * 60000;      // the game reads the date and time as UTC fields: give it the player's local time
  m = newMachine({
    vfs, log, stdout: log, debugOut: true, soundLog: !!c.debug, traceKeys: !!c.debug, noHle: !!c.nohle, traceNet: !!c.traceNet, traceFiles: !!c.traceFiles, fixedWallClock: c.fixedDate ? Date.parse(c.fixedDate + 'T12:00:00Z') : local,
    onPrint: doc => {                                  // the game's Print button: hand the page(s) to the web page
      const pages = doc.pages.map(p => ({ w: p.w, h: p.h, buf: p.rgba.buffer }));
      post('print', { name: doc.name, pages }, pages.map(p => p.buf));
    },
  });
  m.realtime = true;
  const tb = makeTextBackend(); if (tb) m.textBackend = tb;
  EMU.installKernel32a(m); EMU.installKernel32b(m);
  for (const n of ['installKernel32c', 'installAdvapi32', 'installUser32', 'installGdi32', 'installDdraw', 'installDsound', 'installUser32b', 'installGdi32b', 'installMisc',
    'installMss32', 'installBinkw32', 'installSmack', 'installFlashctl', 'installWininet', 'installWs2_32', 'installServer']) if (EMU[n]) EMU[n](m);
  if (m.net && m.net.server) {                         // the player's nickname (typed on the start card, kept in the browser only): the stand-in server gives it to the game as the player's first name
    m.net.server.state.nickname = typeof c.nickname === 'string' ? c.nickname : '';
    if (c.debug) log('[server] nickname: ' + (EMU.cleanNickname(m.net.server.state.nickname) ? 'set (' + EMU.cleanNickname(m.net.server.state.nickname).length + ' characters, not shown here)' : 'none (the game says "Player")'));
  }
  if (m.net && m.net.server) m.net.server.onRemembered = () => { saveDirty = true; };       // (the stand-in server has noted where the player got to: it is saved with the other files)
  if (m.net && m.net.server) {                         // the Sing-Along room: the page's videos become its list; the page hears when the room opens (and with no videos, that it is empty)
    m.net.server.onVideoRoom = info => post('videoRoom', info);
    for (const v of pendingVideos.splice(0)) applyVideos(v);
  }
  if (m.flash) {                                       // Flash movies: with Ruffle on the page the movie is shown there and the movie's clock waits for it; without, movies are run through quickly
    const ruffle = c.flash === 'ruffle';
    m.flash.mode = ruffle ? 'timed' : 'skip'; m.flash.wantBytes = ruffle; m.flash.hostWait = ruffle;
    m.flash.onEvent = ev => post('flash', { ev }, ev.bytes ? [ev.bytes.buffer] : []);
  }
  noteBootRegistry();
  await restoreSaved();
  watchSaves();
  for (const f of EMU.Editions.bootFiles(vfs, lesson, lessons.length ? lessons : (lesson ? [lesson] : []))) {
    const full = m.installRoot + '\\' + f.path;
    let bytes = f.bytes;
    if (/^config\.ini$/i.test(f.path)) {                // what the game left in it last time (Preferences, the garden) stays; the page's lesson plans are put in
      const u = m.userFiles.get(m.fullPath(full).toLowerCase());
      if (u) { try { bytes = EMU.Editions.mergeConfig(f.bytes, u.data.subarray(0, u.size)); if (c.debug) log('[save] config.ini: the game\'s own settings from last time are kept (' + bytes.length + ' bytes)'); } catch (e) { bytes = f.bytes; } }
    }
    m.putUserFile(full, bytes);
  }
  m.yieldHook = () => { yielded = true; };
  m.cpu.nestedHook = nestedService;
  sliceThreads = !(c.debug && c.threads === 'coop');
  if (c.debug && EMU.StallRecorder) rec = EMU.StallRecorder(m, log, { io: () => ({ req: cache.stats.requests, held: stats.held, waited: stats.waited }) });
  m.load(exe, m.installRoot + '\\DisneyPO.exe');
  if (EMU.Hle) {                                       // the game's busiest drawing routine, done natively where it is the one the 2.0.x builds have
    try {                                              // (only a speed-up: whatever goes wrong here, the game's own code does the work)
      const hle = EMU.Hle.attach(m);
      if (c.debug) log('[hle] ' + EMU.Hle.describe(hle) + (hle.enabled ? '' : ' (?hle=off)'));
    } catch (e) { if (c.debug) log('[hle] not used: ' + (e && e.message)); }
  }
  m.cmdLine = m.scratchStr('"' + m.installRoot + '\\DisneyPO.exe"');
  if (m.mixer) {
    m.mixer.attach();
    if (c.debug) {                                     // (debug log) a sound that waited for the game: only the ones that can be heard, and not forever
      let listed = 0;
      m.mixer.onHold = h => {
        if (h.ms < 150 || listed > 40) return;
        if (++listed > 40) { log('[sound] (more hold-ups of the sound are not listed)'); return; }
        log('[sound] the game was busy for ' + h.ms + ' ms while ' + h.names.map(n => '"' + n + '"').join(', ') + ' played: the sound waited and went on, nothing was skipped');
      };
    }
  }
  if (m.unresolved && m.unresolved.length) log('[emu] unresolved imports: ' + m.unresolved.join(' '));

  running = true; nextTick = performance.now(); lastPost = 0; stats.t = performance.now();
  post('ready');
  setInterval(() => {
    const now = performance.now(), dt = (now - stats.t) / 1000; stats.t = now;
    const hl = m.hle, hc = hl ? hl.calls + hl.copies : 0, hp = hl ? hl.pixels + hl.copyPixels : 0, hd = hl ? hl.declined + hl.copyDeclined : 0;
    post('stats', { tps: Math.round(stats.ticks / dt), fps: Math.round(stats.frames / dt), busy: Math.round(stats.busy / dt / 10), requests: cache.stats.requests, mb: +(cache.stats.bytes / 1048576).toFixed(1), heap: Math.round(m.heapBrk / 1048576), held: Math.round(stats.held), waited: Math.round(stats.waited),
      blits: Math.round((hc - stats.hc) / dt), mpx: +((hp - stats.hp) / dt / 1e6).toFixed(1), skipped: Math.round((hd - stats.hd) / dt),
      sw: m.mixer && m.mixer.holds ? Math.round(m.mixer.holds.ms) : 0, retries: EMU.Net.stats.retries, recovered: EMU.Net.stats.recovered });
    stats.ticks = 0; stats.frames = 0; stats.busy = 0; stats.held = 0; stats.waited = 0; stats.hc = hc; stats.hp = hp; stats.hd = hd;
  }, 1000);
  pump();
}

const userFail = e => post('error', { message: e && e.message || String(e), user: e instanceof UserError, detail: (e && e.stack || '') + '\n\nfile reads: ' + JSON.stringify(EMU.Net.stats), network: !!(e && e.net) });

/* ------------------------------------------------------------------------------------------------ the Sing-Along room's videos */
const pendingVideos = [];                              // lists that came before the game was ready
/** d: { gen, count, thumbs: [PNG bytes | null, ...] } = a new list;  { gen, thumb: i, bytes } = a better picture for one button of it */
function applyVideos(d) {
  const S = m && m.net && m.net.server;
  if (!S || !S.setVideos) { pendingVideos.push(d); return; }
  if (d.thumb !== undefined) { if (d.gen <= S.videos.gen) S.setThumb(d.gen, d.thumb, new Uint8Array(d.bytes)); }
  else S.setVideos(d.gen, d.count, (d.thumbs || []).map(b => b ? new Uint8Array(b) : null));
  if (cfg && cfg.debug) log('[server] videos for the Sing-Along room: ' + (d.thumb !== undefined ? 'a better picture for button ' + d.thumb + ' of list ' + d.gen : 'list ' + d.gen + ' with ' + d.count));
}

/* ------------------------------------------------------------------------------------------------ Flash's connections to the game
 * Manny's Craft Box and Painting Set send what is to be printed or kept to the game through a socket on "localhost:12345" (the game listens there for its Flash applications).
 * The page has Flash's end of such a connection (BridgeSocket in main.js); here it is put on the game's own listening socket, and what the game answers goes back. */
const socks = new Map();            // id -> the game's end of the connection (see ws2_32.js: net.connectLocal)
let sockTimer = 0;
const sockPoll = () => {
  for (const [id, ep] of socks) {
    try {
      for (let b; (b = ep.recv());) { const u = b.byteOffset || b.byteLength !== b.buffer.byteLength ? b.slice() : b; post('sockData', { id, bytes: u.buffer }, [u.buffer]); }
      if (ep.closed) { socks.delete(id); post('sockState', { id, state: 'closed' }); }
    } catch (e) { socks.delete(id); post('sockState', { id, state: 'closed' }); }
  }
  if (!socks.size && sockTimer) { clearInterval(sockTimer); sockTimer = 0; }
};
function sockOpen(d) {
  let ep = null, why = '';
  try {
    if (!m || !m.net || !m.net.connectLocal) why = 'the game is not running';
    else if (!(ep = m.net.connectLocal(d.port))) why = 'the game is not listening on port ' + d.port + ' (this edition does not use it)';
  } catch (e) { why = String(e && e.message || e); ep = null; }
  if (!ep) { post('sockState', { id: d.id, state: 'failed', why }); return; }
  socks.set(d.id, ep);
  if (!sockTimer) sockTimer = setInterval(sockPoll, 25);
  post('sockState', { id: d.id, state: 'open' });
  if (blocked) requestRun(0);                         // (the game's socket thread is waiting in accept)
}
function sockSend(d) {
  const ep = socks.get(d.id); if (!ep) return;
  ep.send(new Uint8Array(d.bytes));
  if (cfg && cfg.debug) log('[socket] Flash sent ' + d.bytes.byteLength + ' bytes to the game (connection ' + d.id + ')');
  if (blocked) requestRun(0);
}
function sockClose(d) {
  const ep = socks.get(d.id); if (!ep) return;
  ep.close(); socks.delete(d.id);
  if (blocked) requestRun(0);
}

/* ------------------------------------------------------------------------------------------------ messages from the page */
self.onmessage = ev => {
  const d = ev.data;
  switch (d.type) {
    case 'scan': try { scan(d); } catch (e) { userFail(e); } break;
    case 'addFiles': try { addFiles(d.files); } catch (e) { userFail(e); } break;
    case 'init': boot(d).catch(userFail); break;
    case 'input': {
      if (!m || !running || paused || fatal || finished) break;
      const e = d.ev;
      if (e.type === 'mousemove') pendingMove = { x: e.x, y: e.y };
      else { applyPendingMove(); if (m.mainWnd) m.sendInput(e); }
      if (blocked) requestRun(0);                      // otherwise the next paced frame picks it up within 17 ms
      break;
    }
    case 'pause':
      if (!running || paused) break;
      paused = true; pausedAt = performance.now(); wakeDue = 0;
      if (timer) { clearTimeout(timer); timer = 0; }
      saveNow();
      break;
    case 'resume':
      if (!paused) break;
      paused = false; m.skew -= performance.now() - pausedAt;       // the guest does not see the time spent paused
      nextTick = performance.now(); requestRun(0);
      break;
    case 'flush': saveNow(); break;
    case 'flashStarted': if (m && m.flash) { m.flash.started(d.id); if (blocked) requestRun(0); } break;                // the page's picture of the movie has begun
    case 'videos': applyVideos(d); break;                                                                                // the page's videos for the Sing-Along room (a list, or a better picture for one button)
    case 'videoEnded': if (m && m.flash) { m.flash.videoEnded(d.id); if (blocked) requestRun(0); } break;                // the page's video has played to its end (or could not be played)
    case 'flashSkip': case 'flashFailed': if (m && m.flash) { m.flash.skip(d.id); if (blocked) requestRun(0); } break;  // the player skipped it / it could not be shown
    case 'debugPutFile': if (cfg && cfg.debug && m) m.putUserFile(m.installRoot + '\\' + String(d.path).replace(/\//g, '\\'), new Uint8Array(d.bytes)); break;      // (tests) a file in the game's folder
    case 'debugTrace': if (cfg && cfg.debug && m) { m.trace = !!d.on; m.callCount = 0; m.traceLimit = d.limit || 400; m.traceSkip = new Set(d.skip || []); } break;      // (tests) the Windows calls the game makes, in the log
    case 'debugFlashApp':                             // (tests) the game runs one of its Flash applications on a file (2.0.3)
      if (cfg && cfg.debug && m && m.flash && m.flash.debugRunApp) { const go = () => { if (!m.flash.debugRunApp(d.path)) setTimeout(go, 50); else if (blocked) requestRun(0); }; go(); }
      break;
    case 'sockOpen': sockOpen(d); break;                                                                                // Flash opens a connection to the game's listening socket
    case 'sockSend': sockSend(d); break;
    case 'sockClose': sockClose(d); break;
    case 'flashFile': {                               // a Flash movie asked for a file by its relative address: it is looked for in the game's data (the game's own folders)
      let r = null;
      try { if (m && m.flash && m.flash.readFile) r = m.flash.readFile(d.path, d.from); } catch (e) { r = null; }
      post('flashFile', { req: d.req, key: r ? r.key : '', bytes: r ? r.bytes : null }, r ? [r.bytes.buffer] : []);
      break;
    }
    case 'wipe': {                                    // "Clear saved data"
      saveDirty = false;
      try { if (saveDb) saveDb.close(); } catch (e) { /* ignore */ }
      saveDb = null;
      const r = indexedDB.deleteDatabase(SAVE_DB);
      r.onsuccess = r.onerror = r.onblocked = () => post('wiped');
      break;
    }
    /* developer helpers (only with ?debug) */
    case 'stall':                                     // debug: block the worker for d.ms (like a slow synchronous download would)
      if (cfg && cfg.debug) { const t = performance.now(); while (performance.now() - t < d.ms); }
      break;
    case 'selftest':                                  // write a fake player file to check that saving works
      if (cfg && cfg.debug && m) { const b = new Uint8Array([1, 2, 3, 4, 5]); m.userFiles.set(m.installRoot.toLowerCase() + '\\userdata\\selftest.dat', { data: b, size: b.length }); saveDirty = true; saveNow(); }
      break;
    case 'recycle': if (pool.length < 16) pool.push(new Uint8ClampedArray(d.buf)); break;
  }
};
