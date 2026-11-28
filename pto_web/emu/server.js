/* The (long gone) Disney Playhouse server, rebuilt in-page: answers the game's small XML requests so that it believes it is online
 * with one local player. Everything is answered from memory; nothing leaves the page.
 *
 * What the game wants, read from its own code (2.0.0, 2.0.3 and 2.0.6 alike):
 *  - verifysession, about every 4 minutes: <response><verifysession><success status="ok"/></verifysession></response> keeps it content.
 *    Any other answer counts as a failure, and the third failure makes the game stop with its "Session Terminated" screen.
 *  - getuser: <response><getuser><user id=".."><firstName>..</firstName></user></getuser></response> gives the player's first name, which the
 *    game shows in places like "Good Job, <name>!"; without it the game says "Player".  The name is the nickname that the player typed on the
 *    start card (state.nickname): it lives in the player's browser and in the page's memory, and goes nowhere else.
 *  - authenticate (the Parents' Corner asks for a member name and password before it opens Preferences, and before the game may be left when the
 *    parental lock is on): there are no member accounts any more, so every password is accepted:
 *    <response><authenticate><success status="ok"/></authenticate></response>.  (Without it the answer is "wrong password" and Preferences stay shut.)
 *  - where the player had got to: the game says so when it is left (setlessonprofile, field "LastEpisode") and asks for it again when it starts (the
 *    answer to getlessonprofile: <getlessonprofile><id type="lesson"> LP0301</id><freefield name="LastEpisode"> 2</freefield></getlessonprofile>).
 *    The server keeps that one number per lesson plan, as a small file that the page saves with the player's other files (see remember/recall
 *    below), so that a player who comes back goes on in the episode they had reached.
 *  - everything else (login, lesson profiles, reports ...): an empty <response revision="1"/>, which the game takes as "nothing to say".
 *  - the Sing-Along room (2.0.0, 2.0.3) downloads its list of videos, "movies.ini", and a picture for each video's button: these two GET requests
 *    are answered from the list of videos that the page gives (setVideos / setThumb; see videolist.js).  Without videos the list is empty.
 * No <?xml ...?> line in front: the 2.0.0 program's reader takes "?>" for the start of an attribute name and never stops looking for its "=".
 */
(function (G) {
  'use strict';
  const EMU = G.EMU;
  /** What a nickname may be: up to 12 letters, digits, spaces, apostrophes, full stops and hyphens (accents are dropped: the game's text is plain ASCII).
   * Returns '' when nothing usable is left. */
  function cleanNickname(s) {
    let t = String(s == null ? '' : s);
    try { t = t.normalize('NFD'); } catch (e) { /* as it is */ }
    t = t.replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, ' ').replace(/[^A-Za-z0-9 '.\-]/g, '').replace(/ {2,}/g, ' ').trim();       // (any white space, a pasted non-breaking space too, counts as a space)
    return t.slice(0, 12).trim();
  }
  const xmlText = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  /** the place where the stand-in keeps what it is told to remember: a file that the game never asks for, so that the page's saving of the player's files
   * (and "Clear saved data") takes care of it without anything extra */
  const PROFILE_PATH = 'c:\\pto-standin\\profile.json';
  const LESSON_RE = /<id type="lesson">\s*([A-Za-z0-9_]{1,16})\s*<\/id>/;
  const MAX_EPISODE = 999;
  function install(m) {
    const net = m.net = m.net || {};
    const S = net.server = { requests: [], state: { sessionId: 'LOCALSESSION0001', userId: '1', nickname: '' } };
    const V = EMU.Videos;
    /** what was remembered: {LESSONID: {lastEpisode: N}} */
    S.recall = () => {
      try {
        const u = m.userFiles && m.userFiles.get(PROFILE_PATH); if (!u) return {};
        const o = JSON.parse(new TextDecoder().decode(u.data.subarray(0, u.size)));
        return o && typeof o === 'object' && !Array.isArray(o) ? o : {};
      } catch (e) { return {}; }
    };
    S.remember = o => { if (m.putUserFile) m.putUserFile(PROFILE_PATH, new TextEncoder().encode(JSON.stringify(o))); if (S.onRemembered) { try { S.onRemembered(); } catch (e) { /* the page's business */ } } };
    /** the episode a player had reached in a lesson plan (0 = none: the game starts at the beginning) */
    S.lastEpisode = lesson => { const r = S.recall()[lesson]; const n = r && Number.isInteger(r.lastEpisode) ? r.lastEpisode : 0; return n > 0 && n <= MAX_EPISODE ? n : 0; };
    S.onRemembered = null;
    /** the videos for the Sing-Along room: the newest list (`gen` counts them), the button pictures of every list so far, and who is told when the room asks for its list */
    S.videos = { gen: 0, count: 0, anchor: 'center', thumbs: new Map(), listed: 0, thumbsServed: 0, thumbsMissed: 0 };
    S.onVideoRoom = null;
    /** a new list: `count` videos, their button pictures `thumbs` (PNG bytes, index = video); older lists stay answerable */
    S.setVideos = (gen, count, thumbs) => {
      const v = S.videos; v.gen = gen | 0; v.count = Math.max(0, Math.min(V ? V.MAX : 0, count | 0));
      for (let i = 0; i < v.count; i++) if (thumbs && thumbs[i]) S.setThumb(v.gen, i, thumbs[i]);
    };
    /** a (better) picture for one button of a list.  A picture the game has already downloaded is dropped from its folder so that it asks again next time. */
    S.setThumb = (gen, i, bytes) => {
      if (!V || !bytes) return;
      const name = V.thumbName(gen, i).toLowerCase(); S.videos.thumbs.set(name, bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
      if (m.userFiles) for (const k of Array.from(m.userFiles.keys())) if (k.endsWith('\\' + name)) m.userFiles.delete(k);       // (wherever the game put it)
    };
    function videoAnswer(req) {
      if (!V || req.method !== 'GET') return null;
      const path = String(req.path || '').split(/[?#]/)[0];
      if (/\/v1\/text\/videoini\//i.test(path)) {            // the list of videos
        const v = S.videos, ini = V.makeIni(v.count, v.gen, v.anchor);
        v.listed++;
        if (m.log) m.log('  [server] the Sing-Along room asked for its list of videos: ' + v.count + ' video' + (v.count === 1 ? '' : 's') + (v.count ? '' : ' (none: the room stays empty)'));
        if (S.onVideoRoom) { try { S.onVideoRoom({ count: v.count, gen: v.gen }); } catch (e) { /* the page's business */ } }
        return { status: 200, headers: { 'Content-Type': 'text/plain' }, body: ini };
      }
      if (/\/v1\/global\/videothumbnails\//i.test(path)) {   // the picture of a button
        const name = V.baseName(path).toLowerCase(), pic = V.THUMB_RE.test(name) ? S.videos.thumbs.get(name) : null;
        if (pic) { S.videos.thumbsServed++; return { status: 200, headers: { 'Content-Type': 'image/png' }, body: pic }; }
        S.videos.thumbsMissed++;
        if (m.log) m.log('  [server] no picture for "' + name + '": the game uses its own "Check back soon" button');
        return { status: 404, statusText: 'Not Found', headers: { 'Content-Type': 'text/plain' }, body: 'not found' };
      }
      return null;
    }
    net.http = function (req) {
      const va = videoAnswer(req); if (va) return va;
      const body = req.body ? new TextDecoder().decode(req.body) : '';
      S.requests.push({ path: req.path, body }); if (S.requests.length > 200) S.requests.shift();
      // (the game's reader skips two characters after the ">" of a tag that has attributes, taking the second for a space or line break, as in the XML
      // it writes itself: "<login> <authtoken>..</authtoken> </login>".  So every ">" is followed by a space here.)
      let inner = '';
      const lesson = (LESSON_RE.exec(body) || [])[1] || '';
      if (/<verifysession\b/.test(body)) inner += '<verifysession> <success status="ok"/> </verifysession> ';
      if (/<authenticate\b/.test(body)) {
        inner += '<authenticate> <success status="ok"/> </authenticate> ';
        if (m.log) m.log('  [server] authenticate: any password is accepted (there are no member accounts any more)');
      }
      if (lesson && /<setlessonprofile\b/.test(body)) {   // what the game says when it is left: the episode the player has reached
        const mm = /<fieldupdate\b[^>]*\bname="LastEpisode"[^>]*\bvalue="(\d{1,6})"/.exec(body);
        if (mm) {
          const n = Math.min(MAX_EPISODE, parseInt(mm[1], 10) || 0), all = S.recall(), had = S.lastEpisode(lesson);
          if (n !== had) {
            if (n > 0) all[lesson] = Object.assign({}, all[lesson], { lastEpisode: n }); else if (all[lesson]) { delete all[lesson].lastEpisode; if (!Object.keys(all[lesson]).length) delete all[lesson]; }
            S.remember(all);
            if (m.log) m.log('  [server] remembered: ' + lesson + ' reached episode ' + n + ' (it was ' + had + ')');
          }
        }
      }
      if (/<getuser\b/.test(body)) {                      // (not <getusers>: \b needs a break after the "r")
        const name = cleanNickname(S.state.nickname);
        if (name) {
          inner += '<getuser> <user id="' + xmlText(String(S.state.userId)) + '"> <firstName>' + xmlText(name) + '</firstName> </user> </getuser> ';
          if (m.log) m.log('  [server] getuser: the game was given the nickname (' + name.length + ' characters, not shown here)');
        }
      }
      if (lesson && /<getlessonprofile\b/.test(body)) {   // the game asks where this lesson plan was left: its own "LastEpisode" field is read from here
        const last = S.lastEpisode(lesson);
        if (last) {
          inner += '<getlessonprofile> <id type="lesson"> ' + lesson + '</id> <freefield name="LastEpisode"> ' + last + '</freefield> </getlessonprofile> ';
          if (m.log) m.log('  [server] getlessonprofile: the game was told it had reached episode ' + last + ' in ' + lesson);
        }
      }
      const xml = inner ? '<response revision="1"> ' + inner + '</response>' : '<response revision="1"/>';
      return { status: 200, headers: { 'Content-Type': 'text/xml' }, body: xml };
    };
  }
  EMU.installServer = install;
  EMU.cleanNickname = cleanNickname;
})(typeof globalThis !== 'undefined' ? globalThis : this);
