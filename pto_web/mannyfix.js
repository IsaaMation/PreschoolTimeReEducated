/* Manny (2.0.6's interactive Flash application) under Ruffle: small changes to nine of its movies, made while the page serves the files.
 *   views/Workshop.swf (the room)
 *     1. The introduction (the buttons light up one after the other) stops on a null: Ruffle gives a button's state clip no parent, Flash does.  The
 *        button is already known at that place, so it is used instead.  Without it the buttons stay disabled for good.
 *     2. Ruffle finds the button under the mouse with the picture the button shows, Flash with the button's hit shape.  The seven tool characters show
 *        videos as big as the toolbox, so they took the clicks of the TV, the craft box and so on.  Now every frame each tool takes the mouse only while
 *        the pointer is inside the box around its hit shape.
 *   views/SpanishBook.swf, Paintasia.swf, CraftBox.swf, ToyBox.swf, Lullabys.swf, ReadalongStories.swf, SingalongVideos.swf, ScrapBook.swf
 *     3. These views load their artwork as a small embedded movie and build their scene one frame later; Ruffle does not have the artwork's symbols
 *        ready by then (it depends on how busy the computer is), the scene finds its buttons missing (TypeError #1009) and never appears.  Their start()
 *        now catches that and runs again one frame later (what init() already did once), until it works.  Where Ruffle is ready in time nothing changes.
 * A patch is a list of splices (position, bytes cut out, bytes put in) on the unpacked movie, valid for exactly one file (length and CRC-32 below);
 * any other file is served as it is.  Made by tools/mannyfix/mkmannyfix.py.  Off with ?nomannyfix in the page's address. */
(function () {
  'use strict';
  const PATCHES = [
  {
    name: "Manny/views/Workshop.swf", match: new RegExp("(^|\\/)manny\\/views\\/workshop\\.swf$", 'i'),
    version: 9, bodyLength: 9422930, bodyCrc32: 0xb27edd05,
    splices: [[9228664,"57b80200","54b90200"],[9228803,"f0","f1"],[9310224,"","0c686974546573745374617465"],[9311930,"a7","a8"],[9318780,"","0701f014"],[9347620,"5d13d266af0946130182d7","60c00982d7020202020202"],[9351703,"02020a0b42","6b020a0bad02d066e50812e30000d0669101d066910166a70dd066910166fb08d066910166fd082746cc0903618009d0668701d066870166a70dd066870166fb08d066870166fd082746cc0903618009d066a101d066a10166a70dd066a10166fb08d066a10166fd082746cc0903618009d0669701d066970166a70dd066970166fb08d066970166fd082746cc0903618009d066a001d066a00166a70dd066a00166fb08d066a00166fd082746cc0903618009d0669601d066960166a70dd066960166fb08d066960166fd082746cc0903618009d06677d0667766a70dd0667766fb08d0667766fd082746cc0903618009"]]
  },
  {
    name: "Manny/views/SpanishBook.swf", match: new RegExp("(^|\\/)manny\\/views\\/spanishbook\\.swf$", 'i'),
    version: 9, bodyLength: 195254, bodyCrc32: 0x933528bf,
    splices: [[178646,"7a400000","9a400000"],[178682,"a2","a3"],[185713,"","057472616365"],[185865,"e4","e5"],[186652,"","0701a204"],[187853,"02010b0c15d0305e1b5d1c4a1c00681b5da401601b4fa4010147","10010b0c26d0305e1b5d1c4a1c00681b5da401601b4fa401014729d030609f01d02401d066134fa00103470102141500"]]
  },
  {
    name: "Manny/views/Paintasia.swf", match: new RegExp("(^|\\/)manny\\/views\\/paintasia\\.swf$", 'i'),
    version: 9, bodyLength: 8809749, bodyCrc32: 0x7b97b5e3,
    splices: [[8565018,"da4c0300","f04c0300"],[8719319,"02010b0c20f1e911f036d030f0375e225d234a23006822f0385d980b60224f980b01f03947","10010b0c31f1e911f036d030f0375e225d234a23006822f0385d980b60224f980b01f0394729d03060930bd02401d0661b4f940b034701071f2000"]]
  },
  {
    name: "Manny/views/CraftBox.swf", match: new RegExp("(^|\\/)manny\\/views\\/craftbox\\.swf$", 'i'),
    version: 9, bodyLength: 126817, bodyCrc32: 0xd9326d59,
    splices: [[111706,"b03a0000","c43a0000"],[121749,"02010b0c1ef18101f052d030f0535e1c5d1d4a1d00681cf0545d67601c4f6701f05547","10010b0c2df18101f052d030f0535e1c5d1d4a1d00681cf0545d67601c4f6701f0554729d030605ed02401d066114f5f034701071d1e00"]]
  },
  {
    name: "Manny/views/ToyBox.swf", match: new RegExp("(^|\\/)manny\\/views\\/toybox\\.swf$", 'i'),
    version: 9, bodyLength: 598344, bodyCrc32: 0xf94b05fb,
    splices: [[590483,"881b0000","a61b0000"],[590525,"b5","b6"],[593753,"","057472616365"],[593901,"96","97"],[594382,"","0701b501"],[595227,"02010b0c13d0305e0a5d0b4a0b00680a5d58600a4f580147","10010b0c22d0305e0a5d0b4a0b00680a5d58600a4f58014729d0306056d02401d0660f4f5703470102121300"]]
  },
  {
    name: "Manny/views/Lullabys.swf", match: new RegExp("(^|\\/)manny\\/views\\/lullabys\\.swf$", 'i'),
    version: 9, bodyLength: 14871, bodyCrc32: 0x72e07738,
    splices: [[11021,"800e0000","940e0000"],[13752,"02010b0c19d0306037240c61385e105d114a110068105d3960104f390147","10010b0c28d0306037240c61385e105d114a110068105d3960104f39014729d0306032d02401d066134f3303470102181900"]]
  },
  {
    name: "Manny/views/ReadalongStories.swf", match: new RegExp("(^|\\/)manny\\/views\\/readalongstories\\.swf$", 'i'),
    version: 9, bodyLength: 540011, bodyCrc32: 0xc1bba3b7,
    splices: [[533065,"b91a0000","d71a0000"],[533087,"b1","b2"],[536208,"","057472616365"],[536261,"77","78"],[536643,"","0701b101"],[537278,"02010b0c1df160f020d030f0215e0a5d0b4a0b00680af0225d47600a4f4701f02347","10010b0c2cf160f020d030f0215e0a5d0b4a0b00680af0225d47600a4f4701f0234729d0306045d02401d0660f4f46034701061c1d00"]]
  },
  {
    name: "Manny/views/SingalongVideos.swf", match: new RegExp("(^|\\/)manny\\/views\\/singalongvideos\\.swf$", 'i'),
    version: 9, bodyLength: 153325, bodyCrc32: 0x39c89a0d,
    splices: [[141854,"ce2b0000","e32b0000"],[148114,"02010b0c15d0305e265d274a270068265d8f0160264f8f010147","10010b0c25d0305e265d274a270068265d8f0160264f8f01014729d0306058d02401d066224f800103470102141500"]]
  },
  {
    name: "Manny/views/ScrapBook.swf", match: new RegExp("(^|\\/)manny\\/views\\/scrapbook\\.swf$", 'i'),
    version: 9, bodyLength: 286401, bodyCrc32: 0xdddebcdb,
    splices: [[248327,"27940000","3c940000"],[266412,"02010b0c15d0305e395d3a4a3a0068395dcc0360394fcc030147","10010b0c25d0305e395d3a4a3a0068395dcc0360394fcc03014729d0306040d02401d066354f990303470102141500"]]
  }
  ];
  let crcTab = null;
  function crc32(u8) {
    if (!crcTab) { crcTab = new Int32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = (c & 1) ? ((c >>> 1) ^ 0xEDB88320) : (c >>> 1); crcTab[n] = c; } }
    let c = -1; for (let i = 0; i < u8.length; i++) c = crcTab[(c ^ u8[i]) & 255] ^ (c >>> 8);
    return (c ^ -1) >>> 0;
  }
  const unhex = h => { const u = new Uint8Array(h.length >> 1); for (let i = 0; i < u.length; i++) u[i] = parseInt(h.substr(i * 2, 2), 16); return u; };
  async function inflate(u8) {
    const ds = new DecompressionStream('deflate');                      // (a zlib stream)
    return new Uint8Array(await new Response(new Blob([u8]).stream().pipeThrough(ds)).arrayBuffer());
  }
  /** the movie as the page found it (ArrayBuffer or Uint8Array) -> { bytes, note } (patched), or { note } when it is left as it is, or null when no patch is meant for this path */
  async function patch(path, input) {
    const p = PATCHES.find(x => x.match.test(path)); if (!p) return null;
    const what = p.name.replace(/^.*\//, '');
    const u8 = input instanceof Uint8Array ? input : new Uint8Array(input);
    const sig = String.fromCharCode(u8[0], u8[1], u8[2]);
    if (sig !== 'CWS' && sig !== 'FWS') return { note: 'not patched: the file is not a plain or zlib-packed movie (' + sig + ')' };
    if (u8[3] !== p.version) return { note: 'not patched: the movie\'s version is ' + u8[3] + ', not ' + p.version };
    let body;
    if (sig === 'FWS') body = u8.subarray(8);
    else {
      if (typeof DecompressionStream !== 'function') return { note: 'not patched: this browser cannot unpack a zlib stream (no DecompressionStream)' };
      try { body = await inflate(u8.subarray(8)); } catch (e) { return { note: 'not patched: the movie could not be unpacked (' + (e && e.message || e) + ')' }; }
    }
    if (body.length !== p.bodyLength || crc32(body) !== p.bodyCrc32) return { note: 'not patched: this is not the ' + what + ' the patch was made for (' + body.length + ' bytes, CRC-32 ' + crc32(body).toString(16) + ')' };
    let total = body.length; const parts = [];
    let cur = 0;
    for (const [pos, oldHex, newHex] of p.splices) {
      const old = unhex(oldHex), nw = unhex(newHex);
      for (let i = 0; i < old.length; i++) if (body[pos + i] !== old[i]) return { note: 'not patched: the bytes at ' + pos + ' are not the expected ones' };
      parts.push(body.subarray(cur, pos), nw); cur = pos + old.length; total += nw.length - old.length;
    }
    parts.push(body.subarray(cur));
    const out = new Uint8Array(8 + total); out[0] = 0x46; out[1] = 0x57; out[2] = 0x53; out[3] = p.version;     // "FWS"
    new DataView(out.buffer).setUint32(4, 8 + total, true);
    let o = 8; for (const part of parts) { out.set(part, o); o += part.length; }
    return { bytes: out, note: what + ' patched for Ruffle (' + p.splices.length + ' splices, ' + (8 + total) + ' bytes unpacked)' };
  }
  window.MannyFix = { patch, patches: PATCHES };
})();
