/* Editions: which versions of the game can be played from the files that are on hand, and what to mount for a chosen lesson.
 *
 * The host gives a list of files in any mix: installer programs (PlayhouseInstall2.0.3.exe), zips of the game's Data folder,
 * zips of the shared activities (PackageBC2.0.3.zip), lesson zips (LP0316_lesson_0316_2.0.3.zip), or one big zip that holds
 * several of those zips stored without compression.  scan() looks only at the file directories (a few small reads each),
 * sorts the files into versions and kinds, and tells what is missing.  mount() puts the pieces of one version on top of each
 * other (installer or Data zip first, then shared activities, then the chosen lesson) as one folder tree.
 *
 *   const found = EMU.Editions.scan([{name, file}, ...], cache)   -> {editions, notes}
 *   const mnt   = EMU.Editions.mount(edition, ['LP0316'])        -> {vfs, builtin}
 *   EMU.Editions.bootFiles(vfs, 'LP0316', ['LP0316'])            -> [{path, bytes}]   (DisneyPO.ini, config.ini overlays)
 *
 * A version is taken from the file names ("2.0.3" or "2_0_3"), then from the names inside, then from the lesson numbers
 * (LP02xx = 2.0.0, LP03xx = 2.0.3, LP05xx = 2.0.6).
 */
(function (G) {
  'use strict';
  const EMU = G.EMU = G.EMU || {};

  const VER_RE = /(?<![0-9])(\d)[._](\d)[._](\d{1,2})(?![0-9])/;
  const SERIES = { '02': '2.0.0', '03': '2.0.3', '05': '2.0.6' };
  const baseName = n => String(n).replace(/^.*[\\/]/, '');
  const versionOf = n => { const m = VER_RE.exec(String(n)); return m ? m[1] + '.' + m[2] + '.' + m[3] : null; };
  const lessonOf = n => { const m = /LP(\d{4})/i.exec(baseName(n)); return m ? 'LP' + m[1] : null; };
  const seriesVersion = id => (id && SERIES[id.substr(2, 2)]) || null;
  const memo = fn => { let v, done = false; return () => { if (!done) { v = fn(); done = true; } return v; }; };
  const mb = n => (n / 1048576).toFixed(n >= 104857600 ? 0 : 1) + ' MB';

  /** lesson folders (LP0301 ...) at the top of an archive */
  function topLessons(arc) {
    const s = new Set();
    for (const e of arc.entries) { const t = e.key.split('/')[0]; if (/^lp\d{4}$/.test(t) && e.key.indexOf('/') > 0) s.add(t.toUpperCase()); }
    return [...s].sort();
  }

  function addPart(parts, p) { parts.push(p); return p; }
  let deferred = [];                                                         // notes about installers inside zips: only worth showing when the version has no program otherwise

  /** one source file ({name, file}) -> parts */
  function scanOne(src, cache, parts, notes, hint) {
    const file = src.file, name = src.name || file.name;
    const head = cache.direct(file, 0, 4);
    if (head[0] === 0x4d && head[1] === 0x5a) {                              // installer program
      let arc;
      try { arc = new EMU.WiseArchive(file, cache, { label: name }); }
      catch (e) {                                                              // only worth a note when the version has no program from another file
        const text = name + ': a program, but not an installer I can read (' + e.message + ')', v = versionOf(baseName(name)) || hint;
        if (v) deferred.push({ ver: v, text }); else notes.push(text);
        return;
      }
      const lessons = topLessons(arc);
      addPart(parts, { kind: 'base', type: 'installer', name, label: name, size: file.size, usize: arc.entries.reduce((a, e) => a + e.usize, 0),
        version: versionOf(baseName(name)) || hint || seriesVersion(lessons[0]), lessons, open: () => arc, exe: !!arc.entries.find(e => e.key === 'disneypo.exe') });
      return;
    }
    if (head[0] === 0x50 && head[1] === 0x4b) { scanZip(file, name, cache, parts, notes, hint); return; }
    notes.push(name + ': neither a zip nor an installer program, skipped');
  }

  function scanZip(file, name, cache, parts, notes, hint) {
    const zip = new EMU.ZipArchive(file, cache, { label: name });
    // zips inside, and installer programs (the game's own DisneyPO.exe and Launcher.exe are not installers)
    const nested = zip.entries.filter(e => /\.zip$/i.test(e.raw) || (/\.exe$/i.test(e.raw) && /install|setup/i.test(baseName(e.raw))));
    if (nested.length) {                                                       // a zip made of zips (and installers)
      for (const e of nested) {
        const bn = baseName(e.raw), ver = versionOf(bn) || versionOf(e.raw) || versionOf(baseName(name)) || hint;
        const w = zip.window(e), label = baseName(name) + ' > ' + bn;
        if (!w) {
          const isExe = /\.exe$/i.test(bn);
          const text = bn + ' is compressed inside ' + baseName(name) + ' and cannot be read in place' +
            (isExe ? ' - put the .exe file next to the zip instead' : ' - it would have to be stored without compression');
          if (isExe) deferred.push({ ver, text }); else notes.push(text);
          continue;
        }
        if (/\.exe$/i.test(bn)) { try { scanOne({ name: label, file: w }, cache, parts, notes, ver); } catch (err) { notes.push(label + ': ' + err.message); } continue; }
        const id = lessonOf(bn);
        if (id) addPart(parts, { kind: 'lesson', name: bn, label, size: e.usize, version: ver || seriesVersion(id), lessons: [id], open: memo(() => new EMU.ZipArchive(w, cache, { label })) });
        else if (/package/i.test(bn)) addPart(parts, { kind: 'package', name: bn, label, size: e.usize, version: ver, lessons: [], open: memo(() => new EMU.ZipArchive(w, cache, { label })) });
        else { try { scanZip(w, label, cache, parts, notes, ver); } catch (err) { notes.push(label + ': ' + err.message); } }
      }
      return;
    }
    // a plain zip: decide by what is in it
    const entries = zip.entries, top = new Map();
    for (const e of entries) { const t = e.key.split('/')[0]; top.set(t, (top.get(t) || 0) + 1); }
    const lessonDirs = [...top.keys()].filter(t => /^lp\d{4}$/.test(t)).map(t => t.toUpperCase()).sort();
    const inLessons = lessonDirs.reduce((a, t) => a + top.get(t.toLowerCase()), 0);
    const hasGame = entries.some(e => e.key === 'disneypo.exe') || entries.some(e => /playhouse disney\/data\//i.test(e.raw));
    const first = entries.length ? entries[0].raw : '';
    const ver = versionOf(baseName(name)) || versionOf(first) || hint || seriesVersion(lessonDirs[0]);
    const size = file.size;
    if (hasGame) addPart(parts, { kind: 'base', type: 'zip', name, label: name, size, usize: entries.reduce((a, e) => a + e.usize, 0), version: ver, lessons: lessonDirs, open: () => zip, exe: !!entries.find(e => e.key === 'disneypo.exe') });
    else if (lessonDirs.length && inLessons >= 0.8 * entries.length) addPart(parts, { kind: 'lesson', name, label: name, size, version: ver, lessons: lessonDirs, open: () => zip });
    else if (entries.length) addPart(parts, { kind: 'package', name, label: name, size, version: ver, lessons: [], open: () => zip });
    else notes.push(name + ': an empty zip');
  }

  class Edition {
    constructor(id) { this.id = id; this.bases = []; this.packages = []; this.lessons = new Map(); this.notes = []; }
    get title() { return 'Preschool Time Online ' + this.id; }
    get ready() { return this.bases.length > 0 && this.bases.some(p => p.exe !== false); }
    /** lesson ids that can be chosen, with where they come from */
    lessonList() {
      const out = new Map();
      for (const b of this.bases) for (const id of b.lessons) out.set(id, { id, from: b.type === 'installer' ? 'the installer' : b.label, size: 0 });
      for (const [id, ps] of this.lessons) out.set(id, { id, from: ps.map(p => p.label).join(' + '), size: ps.reduce((a, p) => a + p.size, 0) });
      return [...out.values()].sort((a, b) => a.id < b.id ? -1 : 1);
    }
  }

  /** sources: [{name, file(RangeFile)}]; returns {editions: [Edition], notes: [string]} */
  function scan(sources, cache) {
    const parts = [], notes = [];
    deferred = [];
    for (const s of sources) {
      try { scanOne(s, cache, parts, notes, null); }
      catch (e) { notes.push((s.name || '?') + ': ' + e.message); }
    }
    const byVer = new Map();
    const get = v => { let ed = byVer.get(v); if (!ed) byVer.set(v, ed = new Edition(v)); return ed; };
    const unknown = [];
    for (const p of parts) { if (!p.version) { unknown.push(p); continue; } place(get(p.version), p); }
    if (unknown.length) {
      const known = [...byVer.values()];
      if (known.length === 1) for (const p of unknown) place(known[0], p);
      else { const ed = get('unknown'); for (const p of unknown) place(ed, p); ed.notes.push('The version could not be told from the file names; rename the files to include it (like 2.0.3).'); }
    }
    const editions = [...byVer.values()].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    for (const d of deferred) { const ed = d.ver && byVer.get(d.ver); if ((!ed || !ed.ready) && !notes.includes(d.text)) notes.push(d.text); }
    for (const ed of editions) {
      if (!ed.bases.length) ed.notes.push('No game program found for ' + ed.id + ': add PlayhouseInstall' + ed.id + '.exe or the zip with the Data folder.');
      else if (!ed.ready) ed.notes.push('The files for ' + ed.id + ' do not contain DisneyPO.exe.');
      if (ed.bases.length && !ed.lessonList().length) ed.notes.push('No lessons found for ' + ed.id + '.');
    }
    return { editions, notes };
  }
  function place(ed, p) {
    if (p.kind === 'base') {
      if (p.type === 'installer' && ed.bases.some(b => b.type === 'installer' && b.usize === p.usize)) return;      // a copy of an installer that is there already (the "-DC" ones)
      ed.bases.push(p);
    } else if (p.kind === 'package') ed.packages.push(p);
    else for (const id of p.lessons) { if (!ed.lessons.has(id)) ed.lessons.set(id, []); ed.lessons.get(id).push(p); }
  }

  /** the folder tree for one edition with the chosen lessons on top */
  function mount(ed, lessonIds) {
    const vfs = new EMU.LayeredVfs();
    for (const p of ed.bases.slice().sort((a, b) => a.size - b.size)) vfs.add(p.open());
    for (const p of ed.packages) vfs.add(p.open());
    const builtin = vfs.lessons();
    const seen = new Set();
    for (const id of lessonIds || []) for (const p of ed.lessons.get(id) || []) if (!seen.has(p)) { seen.add(p); vfs.add(p.open()); }
    return { vfs, builtin };
  }

  /** the two settings files the launcher would have written */
  function bootFiles(vfs, current, available) {
    const out = [];
    const rd = key => { const st = vfs.stat(key); if (!st || st.dir) return null; const h = vfs.open(key); return h.read(0, h.size); };
    const ini = rd('disneypo.ini');
    let text = ini ? new TextDecoder('latin1').decode(ini) : '[Engine]\r\nUseDirectDraw=0\r\nUseDirectSound=1\r\n';
    text = text.replace(/UseDirectDraw\s*=\s*1/i, 'UseDirectDraw=0');                       // plain bitmap output
    out.push({ path: 'DisneyPO.ini', bytes: latin1(text) });
    if (current) {
      const list = (available && available.length ? available : [current]);
      out.push({ path: 'config.ini', bytes: latin1('[LessonPlan]\r\nCurrent=' + current + '\r\nAvailable=' + list.join(',') + '\r\n') });
    }
    return out;
  }
  function latin1(s) { const b = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i) & 255; return b; }

  /** config.ini as the game left it last time, with the part that belongs to the page renewed: the page says which lesson plans there are ([LessonPlan], in
   * `fresh`), the game says everything else (what the grown-up chose in Preferences: guided or discovery mode, print limits, the parental lock, the sound
   * levels; the garden's plant).  Both are text or bytes; the result is bytes.  What the page writes wins wherever both have a section of the same name. */
  function mergeConfig(fresh, saved) {
    const text = t => t == null ? '' : typeof t === 'string' ? t : new TextDecoder('latin1').decode(t);
    const parse = t => {
      const secs = []; let cur = null;
      for (const raw of String(t).split(/\r?\n/)) {
        const line = raw.trim(), h = /^\[([^\]\r\n]{1,40})\]$/.exec(line);
        if (h) { cur = { name: h[1], lines: [] }; secs.push(cur); } else if (cur && line) cur.lines.push(line);
      }
      return secs;
    };
    const st = text(saved);
    if (st.length > 8192) return typeof fresh === 'string' ? latin1(fresh) : fresh;        // (not a settings file of ours: left alone)
    const out = parse(text(fresh)), have = new Set(out.map(x => x.name.toLowerCase()));
    for (const x of parse(st)) if (!have.has(x.name.toLowerCase())) { have.add(x.name.toLowerCase()); out.push(x); }
    return latin1(out.map(x => '[' + x.name + ']\r\n' + x.lines.join('\r\n') + '\r\n').join('\r\n'));
  }

  /** plain data for a page */
  function describe(found) {
    return {
      notes: found.notes,
      editions: found.editions.map(ed => ({
        id: ed.id, title: ed.title, ready: ed.ready, notes: ed.notes,
        lessons: ed.lessonList().map(l => ({ id: l.id, from: l.from, size: l.size })),
        sources: ed.bases.concat(ed.packages).map(p => ({ label: p.label, kind: p.kind, size: p.size })),
      })),
    };
  }

  EMU.Editions = { scan, mount, bootFiles, mergeConfig, describe, versionOf, lessonOf, seriesVersion, mb };
  if (typeof module !== 'undefined' && module.exports) module.exports = EMU.Editions;
})(typeof globalThis !== 'undefined' ? globalThis : this);
