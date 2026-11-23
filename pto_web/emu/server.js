/* The (long gone) Disney Playhouse server, rebuilt in-page: answers the game's small XML requests so that it believes it is online
 * with one local player. Everything is answered from memory; nothing leaves the page.
 *
 * What the game wants, read from its own code (2.0.0, 2.0.3 and 2.0.6 alike):
 *  - verifysession, about every 4 minutes: <response><verifysession><success status="ok"/></verifysession></response> keeps it content.
 *    Any other answer counts as a failure, and the third failure makes the game stop with its "Session Terminated" screen.
 *  - getuser: <response><getuser><user id=".."><firstName>..</firstName></user></getuser></response> gives the player's first name, which the
 *    game shows in places like "Good Job, <name>!"; without it the game says "Player".  The name is the nickname that the player typed on the
 *    start card (state.nickname): it lives in the player's browser and in the page's memory, and goes nowhere else.
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
  function install(m) {
    const net = m.net = m.net || {};
    const S = net.server = { requests: [], state: { sessionId: 'LOCALSESSION0001', userId: '1', nickname: '' } };
    const V = EMU.Videos;
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
      if (/<verifysession\b/.test(body)) inner += '<verifysession> <success status="ok"/> </verifysession> ';
      if (/<getuser\b/.test(body)) {                       // (not <getusers>: \b needs a break after the "r")
        const name = cleanNickname(S.state.nickname);
        if (name) {
          inner += '<getuser> <user id="' + xmlText(String(S.state.userId)) + '"> <firstName>' + xmlText(name) + '</firstName> </user> </getuser> ';
          if (m.log) m.log('  [server] getuser: the game was given the nickname (' + name.length + ' characters, not shown here)');
        }
      }
      const xml = inner ? '<response revision="1"> ' + inner + '</response>' : '<response revision="1"/>';
      return { status: 200, headers: { 'Content-Type': 'text/xml' }, body: xml };
    };
  }
  EMU.installServer = install;
  EMU.cleanNickname = cleanNickname;
})(typeof globalThis !== 'undefined' ? globalThis : this);
