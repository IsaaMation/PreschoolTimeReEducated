/* The (long gone) Disney Playhouse server, rebuilt in-page: answers the game's small XML requests so that it believes it is online
 * with one local player. Everything is answered from memory; nothing leaves the page.
 */
(function (G) {
  'use strict';
  const EMU = G.EMU;
  function install(m) {
    const net = m.net = m.net || {};
    const S = net.server = { requests: [], state: { sessionId: 'LOCALSESSION0001', userId: '1' } };
    net.http = function (req) {
      const body = req.body ? new TextDecoder().decode(req.body) : '';
      S.requests.push({ path: req.path, body });
      // No <?xml ...?> line in front: the 2.0.0 program's reader takes "?>" for the start of an attribute name and never stops looking for its "=".
      const xml = '<response revision="1"/>';
      return { status: 200, headers: { 'Content-Type': 'text/xml' }, body: xml };
    };
  }
  EMU.installServer = install;
})(typeof globalThis !== 'undefined' ? globalThis : this);
