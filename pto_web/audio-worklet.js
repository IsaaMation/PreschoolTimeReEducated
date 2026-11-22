/* Plays the stereo float stream that the emulator worker renders (44100 Hz) through the page's AudioContext.
 *
 * The queue is kept short and steady, so that the sound stays close to the picture:
 *  - Playing starts once `target` is queued (40 ms to begin with). If the queue runs dry the player waits for that much again.
 *    When that keeps happening (three short gaps within 5 s: a slow computer) the target grows a little; after a calm spell it shrinks again.
 *  - More than `target + 60 ms` queued means that a stall let a lot arrive at once and the oldest part is out of date: it is
 *    skipped. A smaller excess (the queue never getting emptier than it needs to be) is played off by running up to 1 % faster,
 *    which cannot be heard.
 *    Not everything may be skipped: the worker says (`keep`) which pieces hold a voice or a sound effect, and those are played, however
 *    late they are (a "Today is ..." that lost its middle is worse than one that came a moment late). Only sound that belongs to a
 *    video clip, music and silence are skipped. If that much is queued that it cannot all be kept (over 1.5 s), the oldest goes after all.
 *  - For the page it reports when the end of a chunk (stamped by the worker when it made it) has been played, so that the page can
 *    measure how long the sound takes and hold the picture back by the same time.
 * The stream is resampled linearly when the context runs at another rate than 44100 Hz. */
const FADE = 96;                                         // output frames (about 2 ms) over which a jump in the sound is smoothed

class PtoPlayer extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const o = (options && options.processorOptions) || {};
    this.srcRate = o.srcRate || 44100;
    this.base = this.srcRate / sampleRate;               // source frames consumed per output frame
    const ms = t => Math.round(this.srcRate * t / 1000);
    this.cap = this.srcRate * 2;                         // ring size in frames (2 s)
    this.ring = new Float32Array(this.cap * 2);
    this.wr = 0;                                         // frames written (monotonic)
    this.rd = 0;                                         // frames read (fractional, monotonic)
    this.minTarget = ms(40); this.maxTarget = ms(200); this.target = this.minTarget; this.grow = ms(10); this.shrink = ms(5);
    this.slack = ms(60); this.dead = ms(8); this.ramp = ms(30); this.trough = ms(10); this.hardMax = ms(1500); this.hardKeep = ms(400);
    this.minSeen = Infinity; this.winStart = 0; this.excess = 0;            // emptiest the queue got in the last 250 ms, and how far that is above what is needed
    this.buffering = true; this.dryAt = -1; this.calmFrom = 0; this.recent = [];
    this.fade = 0; this.fromL = 0; this.fromR = 0; this.lastL = 0; this.lastR = 0;
    this.report = o.report | 0;                          // 0: nothing, 1: about ten reports a second, 2: every chunk
    this.marks = []; this.lastReport = -1; this.dries = 0; this.skips = 0;       // (counters for ?debug)
    this.port.onmessage = e => {
      const s = e.data;
      if (!s) return;
      if (s.flush) { this.wr = 0; this.rd = 0; this.marks.length = 0; this.buffering = true; this.dryAt = -1; this.minSeen = Infinity; this.excess = 0; return; }
      if (!s.samples) return;
      const a = s.samples, n = a.length >> 1, R = this.ring, cap = this.cap, start = this.wr;
      for (let i = 0; i < n; i++) { const o = (this.wr % cap) * 2; R[o] = a[2 * i]; R[o + 1] = a[2 * i + 1]; this.wr++; }
      if (n && (s.keep || (this.report && s.te))) this.marks.push({ start, end: this.wr, te: s.te || 0, keep: !!s.keep });
      if (this.wr - this.rd > cap - 1024) this.skipTo(this.wr - (cap - 1024));            // (the ring is full: whatever the reason, the oldest has to go)
    };
  }
  startPlaying() {
    this.buffering = false;
    if (this.dryAt >= 0) {                               // the queue had run dry
      this.dries++;
      const wasShort = currentTime - this.dryAt < 0.15;  // (a long gap is a stall, which no margin would have covered)
      this.recent = this.recent.filter(t => currentTime - t < 5); if (wasShort) this.recent.push(currentTime);
      if (this.recent.length >= 3) { this.target = Math.min(this.maxTarget, this.target + this.grow); this.recent.length = 0; }   // it keeps happening: keep a bigger margin
      this.dryAt = -1;
    }
    this.fade = FADE; this.fromL = 0; this.fromR = 0;    // fade in from silence
    this.calmFrom = this.winStart = currentTime; this.minSeen = Infinity; this.excess = 0;
  }
  skipTo(pos) {                                          // drop the sound before frame `pos`, it is out of date
    this.fade = FADE; this.fromL = this.lastL; this.fromR = this.lastR;
    this.skips++; this.rd = pos; this.minSeen = Infinity; this.excess = 0; this.winStart = currentTime;
    while (this.marks.length && this.marks[0].end <= pos) this.marks.shift();
  }
  /** how far the queue may be skipped (up to frame `pos`): not into the first piece that has to be heard (a voice, an effect) */
  skipLimit(pos) {
    for (const k of this.marks) if (k.keep && k.end > this.rd) return Math.min(pos, Math.max(k.start, this.rd));
    return pos;
  }
  process(inputs, outputs) {
    const out = outputs[0], L = out[0], Rr = out[1] || out[0], n = L.length, R = this.ring, cap = this.cap;
    if (this.buffering) {
      if (this.wr - this.rd < this.target) { L.fill(0); if (Rr !== L) Rr.fill(0); this.lastL = this.lastR = 0; return true; }
      this.startPlaying();
    }
    let step = this.base;
    const level = this.wr - this.rd;
    if (level < this.minSeen) this.minSeen = level;
    if (currentTime - this.winStart >= 0.25) { this.excess = this.minSeen - (this.target - this.trough); this.minSeen = Infinity; this.winStart = currentTime; }
    if (level > this.hardMax) this.skipTo(this.wr - this.hardKeep);                 // far too much: not everything can be kept
    else if (level - this.target > this.slack) {
      const to = this.skipLimit(this.wr - this.target);                               // (a voice that is waiting in the queue is not thrown away)
      if (to - this.rd > this.dead) this.skipTo(to);
    }
    if (this.excess > this.dead) step *= 1 + 0.01 * Math.min(1, (this.excess - this.dead) / this.ramp);
    this.speed = step / this.base;
    if (this.target > this.minTarget && currentTime - this.calmFrom > 4) { this.target = Math.max(this.minTarget, this.target - this.shrink); this.calmFrom = currentTime; }

    const can = Math.max(0, Math.floor((this.wr - 1 - this.rd) / step));    // output frames that the queue can still supply
    const m = Math.min(n, can), dry = can < n, end = this.wr - 1, fadeLen = FADE * step;
    let fade = this.fade;
    for (let i = 0; i < m; i++) {
      const i0 = Math.floor(this.rd), f = this.rd - i0, a = (i0 % cap) * 2, b = ((i0 + 1) % cap) * 2;
      let l = R[a] + (R[b] - R[a]) * f, r = R[a + 1] + (R[b + 1] - R[a + 1]) * f;
      if (fade > 0) { const w = 1 - fade / FADE; l = this.fromL + (l - this.fromL) * w; r = this.fromR + (r - this.fromR) * w; fade--; }
      const room = end - this.rd;
      if (room < fadeLen) { const g = room / fadeLen; l *= g; r *= g; }              // the queue is nearly empty: fade out before it runs dry
      L[i] = l; Rr[i] = r;
      this.rd += step;
    }
    for (let i = m; i < n; i++) { L[i] = 0; Rr[i] = 0; }
    this.fade = fade; this.lastL = L[n - 1]; this.lastR = Rr[n - 1];
    if (dry) { this.buffering = true; this.dryAt = currentTime; }                      // ran dry: wait until enough has arrived

    if (this.marks.length && this.rd >= this.marks[0].end) {
      let k;
      do { k = this.marks.shift(); if (this.report === 2) this.send(k); } while (this.marks.length && this.rd >= this.marks[0].end);
      if (this.report === 1 && currentTime - this.lastReport >= 0.1) this.send(k);
    }
    return true;
  }
  send(k) {
    this.lastReport = currentTime;
    this.port.postMessage({ played: { te: k.te, ctx: currentTime, queued: (this.wr - this.rd) / this.srcRate * 1000, target: this.target / this.srcRate * 1000, dries: this.dries, skips: this.skips, excess: this.excess / this.srcRate * 1000, speed: this.speed } });
  }
}
registerProcessor('pto-player', PtoPlayer);
