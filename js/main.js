// Denoise: a slow reel of real footage on the plate, and the quotes Shikhar believes in beside it, on separate clocks.
// Each clip develops out of static the way an image model removes noise step by step, stays a while, then
// dissolves into the next. Stir it and it dissolves early; hold still and the fine detail comes in.
// The quotes grain out and back in on their own timer; picking a quote never changes the clip, and stirring never changes the quote.
import { createRenderer, MAX_SP, MAX_IP } from './gl.js';
import { rasterText, loadFonts } from './text.js';
import { g, MONO } from './q/lib.js';
import { LOOK, isMedia, loadMedia, releaseMedia, motionAt } from './media.js';

const $ = (s, r = document) => r.querySelector(s);
const params = new URLSearchParams(location.search);
const root = document.documentElement;
const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches || params.has('still');
const coarse = matchMedia('(pointer: coarse)').matches;
const rand = (a, b) => a + Math.random() * (b - a);
const clamp01 = (v) => Math.min(1, Math.max(0, v));
const FLOOR = 0.1;       // resting step: clear, but the fine detail is still a little noisy until you hold still
const CLEAR = 0.3;       // a picture's clock (t) starts when it has developed this far
const MAX_FPS = 12;      // animated pictures re-draw at most this often
const MEDIA_FPS = 24;    // real footage: at most this many frame uploads a second
const HOLD_AFTER_NAV = 15;   // seconds without autoplay after someone swipes to a clip
const OUT = 1.2;         // seconds for a clear picture (or quote) to dissolve into static before the next one develops
const STIR_RATE = 0.9;   // stirring dissolves at most this much of the step per second (≈ 1 s from clear to static)
// transition options for the preview (23 Nov, grain only): ?tx=a dust · b erosion · c drift (none: the static dissolve);
// &wave=1 changes the quote together with the clip, a moment later, as if one wave crossed the page
// a quote change, start to end: the noise rises (eased), holds while the old words' static cross-fades into the new
// words' static, then falls (eased). Fractions of Q_DUR: rise to Q_UP, hold to Q_DOWN, fall to 1.
const Q_DUR = 3.0, Q_UP = 0.4, Q_DOWN = 0.6;
const smooth = (a, b, v) => { const x = clamp01((v - a) / (b - a)); return x * x * (3 - 2 * x); };

const [quotes, reel] = await Promise.all([
  fetch('data/quotes.json').then((r) => r.json()).then((d) => d.quotes),
  fetch('js/q/manifest.json').then((r) => r.json()),   // the reel: ids from data/reel.json that have footage, in order (tools/deploy.sh)
]);
const solo = params.get('pic');   // dev: one clip / picture alone, sharp and animating, no reel
if (solo) reel.splice(0, reel.length, solo);
// every visit gets its own order of clips and of quotes (a fresh shuffle each page load)
const shuffle = (a) => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
if (!solo) shuffle(reel);
const BOOT = !reduce && !solo;   // on opening, the whole page starts as static and develops together
if (!params.has('q')) shuffle(quotes);
const NQ = quotes.length, NC = reel.length;

/* ---------- picture modules ---------- */
const mods = new Map();   // id -> Promise<module | null>; resolved modules also in ready
const ready = new Map();
const media = new Map();  // id -> decoded footage / photo of a media picture (js/media.js)
function loadPic(id) {
  if (!mods.has(id)) {
    mods.set(id, import(`./q/${id}.js`).catch((e) => { console.error(`picture ${id}:`, e); return null; }).then(async (m) => {
      if (isMedia(m)) { const M = await loadMedia(m); if (!M) m = null; else media.set(id, M); }
      if (!m) mods.delete(id);   // failed (offline, a bad file): tried again the next time the reel comes round to it
      ready.set(id, m); return m;
    }));
  }
  return mods.get(id);
}
function keepNear(c) {   // only the clip on the plate and its two neighbours stay loaded (each holds a decoder and its file)
  const keep = new Set([-1, 0, 1].map((d) => reel[(c + d + NC) % NC]));
  for (const [id, M] of media) if (!keep.has(id)) { releaseMedia(M); media.delete(id); mods.delete(id); ready.delete(id); }
}

/* ---------- state ---------- */
// G: the plate (cur = index into the reel, which is shuffled per visit). Q: the quote column.
const G = {
  cur: Math.floor(Math.random() * NC), seeds: reel.map(() => 1000 + Math.floor(Math.random() * 9000)),
  T: 0.42, armed: false, pending: -1, sharp: false,
  lastStir: -10, stirring: false, still: 0, hover: false, lastMove: 0,
  auto: null, sweep: null, nextSweep: rand(55, 75), nextIp: rand(3, 5),
  t: 0, clear: false, lastDraw: -1, drawMs: 0,   // the current picture's clock and redraw bookkeeping
  dwell: 0, hold: -1, focus: false, skips: 0,   // reel
};
const Q = {
  cur: params.has('q') ? Math.min(NQ - 1, Math.max(0, +params.get('q') - 1)) : Math.floor(Math.random() * NQ),
  pending: -1, T: 0, u: reduce ? 1 : Q_DOWN, xa: 1, dwell: 0, hover: false,
};

/* ---------- DOM ---------- */
const plateEl = $('[data-plate]'), capEl = $('[data-cap]');
const capT = $('[data-cap-t]'), capD = $('[data-cap-d]');
const qBox = $('[data-q-box]'), qText = $('[data-q-text]'), qBy = $('[data-q-by]');
const qCol = $('.quotes');
// keyboard focus in the centre column pauses the reel
addEventListener('focusin', (e) => {
  const el = e.target;
  G.focus = !!el.matches?.(':focus-visible') && !!el.closest('.gen');
});
addEventListener('focusout', () => { G.focus = false; });
const credit = (q) => (q.own ? '— my own note' : q.author ? `— ${q.author}` : '');
const descOf = (c) => ready.get(reel[c])?.desc ?? 'a picture still to come.';
function setCaption(s) {   // "Title · date · place": the title and the details are set in different styles
  const k = s.indexOf(' · ');
  capT.textContent = k < 0 ? s : s.slice(0, k);
  capD.textContent = k < 0 ? '' : s.slice(k + 3);   // date and place go on their own line under the title
}

// the quote is the largest text on the page; a long one steps down until it fits its room,
// but stays at least 1.2× the intro's size
const ledeEl = $('.lede');
function fitQuote() {
  qBox.style.setProperty('--qk', '1');
  const full = parseFloat(getComputedStyle(qText).fontSize), floor = (1.2 * parseFloat(getComputedStyle(ledeEl).fontSize)) / full;
  for (let k = 1; qBox.scrollHeight > qBox.clientHeight + 1 && k > floor; ) {
    k = Math.max(floor, k - 0.04); qBox.style.setProperty('--qk', k.toFixed(3));
  }
}
const PREV = { info: null, a: 0 };   // the previous quote's static while it cross-fades out (GPU text slot 2)
function showQuote(i) {   // the words swap while the quote is pure static (at once with reduced motion / no WebGL)
  const q = quotes[i];
  if (R && !reduce && TXT[0].info) { R.swapText(0, 2); PREV.info = TXT[0].info; }   // the old words' static stays a moment, fading out
  Q.cur = i; Q.pending = -1; Q.dwell = 0;
  qText.textContent = q.text; qBy.textContent = credit(q); qBy.hidden = !qBy.textContent;
  fitQuote();
  TXT[0].dirty = true;
}
const CPREV = { info: null, xf: 1 };   // the previous subtitle's static while it cross-fades into the new one (GPU text slot 4)
function showClip() {   // the subtitle under the plate describes the clip on it
  if (R && !reduce && TXT[1].info) { R.swapText(1, 4); CPREV.info = TXT[1].info; CPREV.xf = 0; }
  const d = descOf(G.cur);
  setCaption(d); plateEl.setAttribute('aria-label', `picture: ${d}`);
  TXT[1].dirty = true;
}

/* ---------- renderer ---------- */
const canvas = $('#world');
let R = createRenderer(canvas);
const layerCv = [0, 1, 2].map(() => document.createElement('canvas'));
const layerCtx = layerCv.map((cv) => cv.getContext('2d', { alpha: false }));
let side = 0, maxLod = 0, medLod = 0;

// draw the current picture at its clock into the three layers (and upload them).
// Real footage / photos: the current frame goes to the GPU as it is; the shader splits it into the layers.
function drawPic() {
  const S = layerCv[0].width, id = reel[G.cur], m = ready.get(id), M = media.get(id);
  if (M) {
    if (R) uploadMed(M);
    else { layerCtx.forEach((x) => { x.fillStyle = '#000'; x.fillRect(0, 0, S, S); }); layerCtx[1].drawImage(M.el, 0, 0, S, S); }
    return;
  }
  const L = layerCtx.map((x) => { x.setTransform(1, 0, 0, 1, 0, 0); x.globalCompositeOperation = 'source-over'; x.globalAlpha = 1; x.setLineDash([]); x.fillStyle = '#000'; x.fillRect(0, 0, S, S); x.lineCap = 'round'; x.lineJoin = 'round'; return x; });
  const t0 = performance.now();
  if (m) m.draw(L, S, reduce || !R ? (m.still ?? 0) : G.t, G.seeds[G.cur]);
  else {   // no picture file (dev only): a plain grain field
    L[0].fillStyle = g(44); L[0].fillRect(S * 0.08, S * 0.08, S * 0.84, S * 0.84);
    L[2].font = `500 ${S * 0.018}px ${MONO}`; L[2].fillStyle = g(150); L[2].fillText(`picture to come: ${id}`, S * 0.1, S * 0.89);
  }
  G.drawMs = G.drawMs ? G.drawMs * 0.8 + (performance.now() - t0) * 0.2 : performance.now() - t0;
  if (R) R.uploadForm(0, layerCv);
}
function uploadMed(M) {   // one texture upload of the decoded frame (+ its mip chain), no CPU pixel work
  const t0 = performance.now();
  medLod = R.uploadMedia(M.el, M.w, M.h);
  M.last = M.video ? M.el.currentTime : 0; M.dirty = false; M.lastUp = performance.now() / 1000;
  G.drawMs = G.drawMs ? G.drawMs * 0.8 + (performance.now() - t0) * 0.2 : performance.now() - t0;
}
function sizeForms() {
  const want = plateEl.getBoundingClientRect().width * px;
  const s = Math.min(1024, R.maxTex, Math.max(512, 2 ** Math.ceil(Math.log2(Math.max(1, want)))));
  if (s === side) return;
  side = s; layerCv.forEach((c) => { c.width = c.height = s; });
  maxLod = R.allocForms(s, 1); drawPic();
}

const whoEl = $('[data-who]');
// words drawn out of noise: the quote, the subtitle and the intro (GPU text slots 0, 1, 3; slot 2 is the previous quote)
// and the small labels (slots 5-8): top links, "Quotes I believe in", the hint, the footer; op = the element whose CSS
// opacity fades them (the opening, the hint going away), which the GPU follows
const LABELS = [['.contact', '.top'], ['#qh', '#qh'], ['.intro .hint', '.intro .hint'], ['.foot p', '.foot']].map(([s, o]) => [$(s), $(o)]);
const TXT = [[qBox, 0, qText], [capEl, 1, capEl], [whoEl, 3, ledeEl], ...LABELS.map(([el, op], i) => [el, 5 + i, el, op])]
  .map(([el, slot, fontEl, op]) => ({ el, slot, fontEl, op, cv: document.createElement('canvas'), dirty: true }));
for (const s of TXT.slice(3)) for (const ev of ['pointerover', 'pointerout', 'focusin', 'focusout']) s.el.addEventListener(ev, () => { s.dirty = true; });   // link hover: brighter underline
new MutationObserver(() => { TXT[2].dirty = true; }).observe($('[data-clock]'), { childList: true, characterData: true, subtree: true });   // the clock ticks
const I = { T: 0, u: BOOT ? Q_DOWN : 1 };   // the intro develops out of noise once, on load, with the quote
let boot = BOOT ? 1 : 0, veil = 1;
if (!BOOT) root.classList.remove('boot');   // e.g. ?still: no opening, labels show at once
if (BOOT) G.T = 1;
function rasterTxt(k) {
  const s = TXT[k]; s.info = rasterText(s.el, s.cv, Math.max(1, px * 1.25), Math.min(2048, R.maxTex));
  s.font = parseFloat(getComputedStyle(s.fontEl).fontSize); R.uploadText(s.slot, s.cv); s.dirty = false;
}

/* ---------- moving along the reel ---------- */
function switchTo(c) {   // the plate is pure static here, so a redraw is invisible
  G.pp = null; G.sw = performance.now() / 1000;   // the coming-in half starts gently
  const was = media.get(reel[G.cur]);
  if (was?.video && G.cur !== c) was.el.pause();
  G.cur = c; G.armed = false; G.pending = -1; G.skips = 0; G.sharp = false; G.T = 1; G.lock = true;
  G.t = 0; G.clear = false; G.dwell = 0; IP.length = 0;
  keepNear(c);
  startMedia(c);
  showClip(); drawPic(); flatDraw();
  for (const d of [1, -1]) loadPic(reel[(c + d + NC) % NC]);
}
function startMedia(c) {   // footage starts as its picture starts to develop; reduced motion / no WebGL: one still frame
  const M = media.get(reel[c]), m = ready.get(reel[c]);
  if (!M?.video) return;
  M.el.onseeked = () => { M.dirty = true; if (!R) flatDraw(); };
  M.blocked = reduce || !R; M.el.loop = solo;   // in the reel a clip plays once; the solo preview loops it
  M.el.currentTime = M.blocked ? (m.still ?? 0) : (m.start ?? 0);
  if (!M.blocked) playMedia(M, m);
}
function playMedia(M, m) {
  M.el.play().catch((e) => { if (e.name === 'NotAllowedError') { M.blocked = true; M.el.currentTime = m.still ?? 0; } });   // autoplay refused (e.g. phone battery saver): a still frame
}
function goClip(c) {   // dissolve to static, then develop clip c
  c = (c + NC) % NC;
  loadPic(reel[c]);
  if (c === G.cur && G.pending < 0) { G.sharp = true; return; }
  if (reduce || !R) { loadPic(reel[c]).then(() => { switchTo(c); G.T = reduce ? 0 : FLOOR; }); return; }
  G.pending = c;
}

/* ---------- moving between quotes ---------- */
function goQuote(i) {   // grain the quote out, then the next one in
  i = (i + NQ) % NQ;
  if (i === Q.cur && Q.pending < 0) return;
  if (reduce || !R) showQuote(i);
  else { Q.pending = i; if (Q.u >= 1) Q.u = 0; }
}

/* ---------- input: stirring, holding still, swiping ---------- */
const C = { cell: 10, w: 0, h: 0, v: null, u8: null, live: false };
function cursorGrid() {
  C.cell = Math.max(8, innerWidth / 420);
  C.w = Math.min(512, Math.ceil(innerWidth / C.cell)); C.h = Math.min(320, Math.ceil(innerHeight / C.cell));
  C.v = new Float32Array(C.w * C.h); C.u8 = new Uint8Array(C.w * C.h); C.live = true;
}
function stamp(x, y, a, rad) {
  if (!C.v) return;
  const cx = x / innerWidth * C.w, cy = y / innerHeight * C.h, rc = rad / C.cell, s2 = rc * rc * 0.45;
  const x0 = Math.max(0, Math.floor(cx - rc)), x1 = Math.min(C.w - 1, Math.ceil(cx + rc));
  const y0 = Math.max(0, Math.floor(cy - rc)), y1 = Math.min(C.h - 1, Math.ceil(cy + rc));
  for (let j = y0; j <= y1; j++) for (let i = x0; i <= x1; i++) {
    const dx = i + 0.5 - cx, dy = j + 0.5 - cy, gg = Math.exp(-(dx * dx + dy * dy) / s2);
    const k = j * C.w + i; C.v[k] = 1 - (1 - C.v[k]) * (1 - a * gg);
  }
  C.live = true;
}
let plateR = { x: 0, y: 0, w: 1, h: 1 }, colR = { x: 0, y: 0, w: 0, h: 0 };
const inRect = (r, x, y) => x >= r.x && y >= r.y && x <= r.x + r.w && y <= r.y + r.h;
const inPlate = (x, y) => inRect(plateR, x, y);
let lastP = null, down = false;
const scrub = { ax: -1, sg: 0, turns: [] };   // direction reversals of fast moves over the plate (a deliberate scrub)
function onMove(x, y, pressed, now) {
  if (lastP && now - lastP[2] < 120) {
    const dx = x - lastP[0], dy = y - lastP[1], d = Math.hypot(dx, dy), dt = Math.max(8, now - lastP[2]), v = d / dt * 1000;
    if (d > 0.5) {
      G.lastMove = now; G.still = 0;
      if (!reduce) {
        const over = inPlate(x, y) && inPlate(lastP[0], lastP[1]), n = Math.max(1, Math.ceil(d / 10));
        const a = Math.min(0.55, (over ? 0.06 : 0.035) + (d / n) * (pressed ? 0.06 : 0.035));
        for (let k = 1; k <= n; k++) stamp(lastP[0] + dx * k / n, lastP[1] + dy * k / n, a, coarse ? 60 : over ? 80 : 64);
        // stirring the plate pushes the whole picture back toward static: any drag, or a fast back-and-forth scrub
        // (plain hovering never stirs). Capped, so even a wild stir takes about a second to dissolve the picture.
        if (over && !pressed && v > plateR.w * 1.1) {
          const ax = Math.abs(dx) > Math.abs(dy) ? 0 : 1, sg = Math.sign(ax ? dy : dx);
          if (ax === scrub.ax && sg === -scrub.sg) scrub.turns.push(now);
          scrub.ax = ax; scrub.sg = sg;
        }
        scrub.turns = scrub.turns.filter((t) => now - t < 900);
        const scrubbing = scrub.turns.length >= 2;
        if (over && (pressed || scrubbing) && G.pending < 0 && !G.lock) {
          const want = d / plateR.w * (pressed ? 0.85 : 0.45) * Math.min(2, v / 900 + 0.4);
          G.T = Math.min(1, G.T + Math.min(want, STIR_RATE * (now - lastP[2]) / 1000));
          G.lastStir = now / 1000; G.stirring = true; G.sharp = false; G.auto = null; root.classList.add('used');
          if (G.T >= 0.9) G.armed = true;
        }
      }
    }
  }
  lastP = [x, y, now];
}
addEventListener('pointermove', (e) => {
  if (e.pointerType === 'touch') return;
  onMove(e.clientX, e.clientY, down, e.timeStamp || performance.now());
  G.hover = inPlate(e.clientX, e.clientY); Q.hover = inRect(colR, e.clientX, e.clientY);
}, { passive: true });
addEventListener('pointerdown', (e) => { down = true; if (inPlate(e.clientX, e.clientY)) { G.hover = true; G.still = 0; G.lastMove = performance.now(); } lastP = [e.clientX, e.clientY, e.timeStamp || performance.now()]; }, { passive: true });
addEventListener('pointerup', () => { down = false; if (coarse) G.hover = false; }, { passive: true });
addEventListener('pointercancel', () => { down = false; G.hover = false; }, { passive: true });
document.addEventListener('pointerleave', () => { G.hover = Q.hover = false; });
qCol.addEventListener('touchstart', () => { Q.hover = true; }, { passive: true });   // phones: reading with a finger on the quote
qCol.addEventListener('touchend', () => { Q.hover = false; }, { passive: true });
let swipe = null;   // phones: a quick sideways swipe on the picture goes to the next / previous clip
plateEl.addEventListener('touchmove', (e) => { const t = e.touches[0]; if (t) onMove(t.clientX, t.clientY, true, performance.now()); e.preventDefault(); }, { passive: false });
plateEl.addEventListener('touchstart', (e) => { const t = e.touches[0]; G.hover = true; lastP = [t.clientX, t.clientY, performance.now()]; G.lastMove = performance.now(); swipe = e.touches.length === 1 ? [t.clientX, t.clientY, performance.now()] : null; }, { passive: true });
plateEl.addEventListener('touchend', (e) => {
  G.hover = false; lastP = null;
  const t = e.changedTouches[0];
  if (swipe && t) {
    const dx = t.clientX - swipe[0], dy = t.clientY - swipe[1];
    if (performance.now() - swipe[2] < 600 && Math.abs(dx) > 48 && Math.abs(dx) > 1.6 * Math.abs(dy)) {
      G.armed = false; G.auto = null; G.hold = performance.now() / 1000 + HOLD_AFTER_NAV; root.classList.add('used');
      goClip((G.pending >= 0 ? G.pending : G.cur) + (dx < 0 ? 1 : -1));
    }
  }
  swipe = null;
}, { passive: true });

/* ---------- small events ---------- */
const IP = [];   // "inpainting": a patch of the plate re-noises and is drawn again
function inpaint(u0, v0, u1, v1, peak = 0.75) { if (IP.length < MAX_IP) IP.push({ r: [u0, v0, u1, v1], age: 0, peak, up: 0.3, down: rand(1.4, 2.2) }); }
// little dots drifting anywhere on the page, each drawn out of noise now and then; they never cross the picture
// (they fade out at its edge) and wrap around the screen's sides (MAX_SP in gl.js is 24)
const specks = [...Array(22).keys()].map((k) => ({ x: Math.random(), y: Math.random(), a: rand(0, 6.28), sp: rand(7, 20), turn: rand(-0.25, 0.25), wob: rand(0.15, 0.5), r: k < 6 ? rand(2, 3.4) : rand(1.2, 2.4), t: 0, next: rand(1, 7), phase: 0 }));
// Two clocks. A clip plays once: its picture starts to dissolve END_LEAD s before the footage ends (a photo stays 9 s);
// a quote stays 9–12 s (longer quotes longer).
// They never change together: a quote only starts to change while the plate is clear with at least 3 s left on its clip,
// so the two word/picture swaps are always seconds apart.
const END_LEAD = 2.5;   // the invisible stir (1.3 s) plus the dissolve (1.2 s) finish as the footage ends
const clipLeft = () => {
  const M = media.get(reel[G.cur]);
  return M?.video && !M.blocked && M.el.duration ? M.el.duration - M.el.currentTime - END_LEAD : 9 - G.dwell;
};
const quoteDwell = (i) => Math.min(12, Math.max(9, quotes[i].text.split(/\s+/).length * 0.25));
const quoteIdle = () => Q.pending < 0 && Q.u >= 1;
const plateIdle = () => G.pending < 0 && !G.auto && !G.stirring && G.T <= FLOOR + 0.01;

/* ---------- sizing ---------- */
let pxBase = 1, px = 1;
function sizeCanvas() {
  const vw = innerWidth, vh = innerHeight;
  pxBase = Math.min(devicePixelRatio || 1, coarse ? 1.25 : 1.5, 4096 / vw, 4096 / vh, Math.sqrt(3.2e6 / (vw * vh)));
  px = Math.min(px, pxBase) || pxBase;
  canvas.width = Math.round(vw * px); canvas.height = Math.round(vh * px);
}
let rzTimer = 0;
addEventListener('resize', () => {
  clearTimeout(rzTimer);
  rzTimer = setTimeout(() => {
    fitQuote();
    if (!R) { flatDraw(); return; }
    px = Infinity; sizeCanvas(); cursorGrid(); sizeForms(); TXT.forEach((t) => (t.dirty = true));
  }, 150);
});

/* ---------- fallback without WebGL: the clean picture, no noise ---------- */
const flat = $('[data-flat]');
function flatDraw() {
  if (R) return;
  const s = Math.min(1024, Math.round(plateEl.getBoundingClientRect().width * (devicePixelRatio || 1)));
  layerCv.forEach((c) => { c.width = c.height = s; }); flat.width = flat.height = s;
  drawPic();
  const x = flat.getContext('2d'); x.fillStyle = '#0b0b12'; x.fillRect(0, 0, s, s); x.globalCompositeOperation = 'lighten';
  layerCv.forEach((c) => x.drawImage(c, 0, 0)); x.globalCompositeOperation = 'source-over';
}

/* ---------- per frame ---------- */
let time = 0, last = performance.now(), lost = false;
const fpsEl = params.has('fps') ? document.body.appendChild(Object.assign(document.createElement('div'), { style: 'position:fixed;left:8px;bottom:8px;z-index:200;font:12px monospace;color:#e8e4da;background:#000a;padding:2px 6px' })) : null;
const fpsAcc = []; let fpsAt = 0;
const frameLog = [];
const sp = new Float32Array(MAX_SP * 4), spt = new Float32Array(MAX_SP), ipA = new Float32Array(MAX_IP * 4), ipT = new Float32Array(MAX_IP);
function rectOf(el) { const r = el.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; }

function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.05, (now - last) / 1000); last = now;
  if (lost) return;
  if (!reduce) time += dt;
  frameLog.push(dt); if (frameLog.length > 120) frameLog.shift();
  const vw = innerWidth, vh = innerHeight, sec = now / 1000;

  // read layout first (no writes before this point in the frame)
  plateR = rectOf(plateEl); colR = rectOf(qCol);
  const qr = rectOf(qBox), cr = rectOf(capEl), wr = rectOf(whoEl);
  const onScreen = plateR.y < vh && plateR.y + plateR.h > 0;

  /* the plate's noise step */
  G.stirring = sec - G.lastStir < 0.22;
  if (G.lock && G.T < 0.7) G.lock = false;
  if (G.hover && now - G.lastMove > 450 && !G.stirring) G.still += dt; else if (!G.hover) G.still = 0;
  if (G.still > 0.3 || (G.still > 0.05 && G.T <= FLOOR + 0.02)) G.sharp = true;
  if (G.armed && !G.stirring && !G.auto && G.pending < 0 && G.T >= 0.9) { G.pending = (G.cur + 1) % NC; loadPic(reel[G.pending]); }
  if (G.wait) G.T = reduce ? 0 : 1;   // no clip yet: static
  else if (reduce) G.T = 0;
  else if (G.pending >= 0) {
    if (G.pp == null) { G.pp = 0; G.po0 = G.T; }   // eased: the static rises gently, speeds up, then settles at full
    G.pp = Math.min(1, G.pp + dt / OUT); G.T = G.po0 + (1 - G.po0) * smooth(0, 1, G.pp);
    const id = reel[G.pending];
    if (G.T >= 1 && ready.has(id)) {
      // a clip that failed to load is skipped (once round the reel at most), rather than showing an empty plate
      if (ready.get(id) || ++G.skips >= NC) switchTo(G.pending);
      else { ready.delete(id); G.pending = (G.pending + 1) % NC; loadPic(reel[G.pending]); }
    }
  }
  else if (!G.stirring && !G.auto) {
    G.armed = false;
    const floor = G.sharp ? 0 : FLOOR;
    const ease = 0.1 + 0.9 * smooth(0, 0.6, sec - (G.sw ?? -9));   // after a new clip, the clearing starts gently
    if (G.T > FLOOR) G.T = Math.max(floor, G.T - dt * (0.15 + 0.36 * G.T) * ease);   // about 3 s from static to clear
    else if (G.T > floor) G.T = Math.max(floor, G.T - dt * 0.12);            // sharpening: the last, finest steps
  }

  /* the quote's own step: grains out to static, the words swap, the new ones grain in (same curve as a picture) */
  if (reduce) Q.T = 0;
  else {
    if (Q.u < 1) {
      const u0 = Q.u; Q.u = Math.min(1, Q.u + dt / Q_DUR);
      if (u0 < Q_UP && Q.u >= Q_UP && Q.pending >= 0) showQuote(Q.pending);   // the words swap at full static
      if (Q.u >= 1 && Q.pending >= 0) Q.u = 0;   // another quote was asked for meanwhile
    }
    const u = Q.u, hold = u >= Q_UP && u < Q_DOWN;
    Q.T = u < Q_UP ? smooth(0, Q_UP, u) : u < Q_DOWN ? 1 : 1 - smooth(Q_DOWN, 1, u);
    Q.xa = hold ? smooth(Q_UP, Q_DOWN, u) : 1; PREV.a = hold ? 1 - Q.xa : 0;
  }

  // the picture's own clock, and its redraws (animated pictures only, at most MAX_FPS, only while on screen)
  if (!G.clear && G.T <= CLEAR && G.pending < 0) G.clear = true;
  const mod = ready.get(reel[G.cur]), med = media.get(reel[G.cur]);
  if (G.clear && !reduce) {
    G.t += dt;
    const fps = Math.min(MAX_FPS, mod?.fps || 0);
    if (fps > 0 && onScreen && sec - G.lastDraw >= 1 / fps - 0.004) { G.lastDraw = sec; drawPic(); }
  }
  // footage plays only while the plate is on screen; each new frame is one texture upload (≤ MEDIA_FPS)
  if (med?.video) {
    const want = onScreen && !med.blocked;
    // a clip that has played to its end waits on its last frame for the hand-over (restarting it would show a jump
    // back to its first frame under the dissolve); it starts again only while the reel is held (pointer, focus, swipe)
    const held = G.hover || G.focus || sec < G.hold;
    if (want && med.el.paused && (!med.el.ended || held)) playMedia(med, mod);
    else if (!want && !med.el.paused) med.el.pause();
    if (onScreen && (med.dirty || med.el.currentTime !== med.last) && sec - med.lastUp >= 1 / MEDIA_FPS - 0.004) uploadMed(med);
  }

  // the reel: each clip plays once, then an invisible hand stirs it into the next one as the footage ends.
  // Paused while the pointer is on the plate, while keyboard focus is on it, and after a swipe.
  const clipRuns = !reduce && !solo && !G.hover && !G.focus && sec >= G.hold;
  if (clipRuns && plateIdle()) {
    G.dwell += dt;
    if (clipLeft() <= 0) {
      G.auto = { age: 0, ph: rand(0, 6) }; loadPic(reel[(G.cur + 1) % NC]);
    }
  }
  if (G.auto) {
    const au = G.auto; au.age += dt;
    const u = au.age / 1.3, x = plateR.x + plateR.w * (0.5 + 0.34 * Math.sin(u * 7 + au.ph)), y = plateR.y + plateR.h * (0.5 + 0.3 * Math.sin(u * 11 + au.ph * 2));
    stamp(x, y, 0.22, 90);
    G.T = Math.min(1, G.T + dt / 1.0);
    if (au.age > 1.3) { G.auto = null; G.armed = true; G.T = Math.max(G.T, 0.9); G.lastStir = sec - 0.3; }
  }
  // the quotes: a plain slideshow, paused while the pointer is on the quote column;
  // a quote waits while a clip is changing or due within 3 s
  if (quoteIdle() && !Q.hover) {
    Q.dwell += dt;
    if (Q.dwell >= quoteDwell(Q.cur) && plateIdle() && !(clipRuns && clipLeft() < 3)) goQuote(Q.cur + 1);
  }

  // the opening: full-screen static that clears while everything develops
  if (boot > 0) { boot = Math.max(0, boot - dt / 2.4); if (boot < 0.45) root.classList.remove('boot'); }

  // background: the text slots
  TXT.forEach((s, k) => { if (s.dirty) rasterTxt(k); });
  if (CPREV.xf < 1) CPREV.xf = Math.min(1, CPREV.xf + dt / 0.6);
  if (I.u < 1) { I.u = Math.min(1, I.u + dt / Q_DUR); I.T = 1 - smooth(Q_DOWN, 1, I.u); }

  // the rare big moment: a band of static sweeps the whole screen and the picture is re-sampled with a new seed
  let sweep = [0, 0];
  if (!reduce) {
    G.nextSweep -= dt;
    if (G.nextSweep <= 0 && !G.sweep && G.pending < 0) { G.sweep = { x: -300, hit: false }; G.nextSweep = rand(60, 80); }
    if (G.sweep) {
      const s = G.sweep; s.x += dt * (vw + 600) / 2.4;
      if (!s.hit && s.x > plateR.x + plateR.w * 0.5) { s.hit = true; G.seeds[G.cur] += 1 + Math.floor(Math.random() * 97); drawPic(); G.T = Math.max(G.T, 0.88); G.sharp = false; }
      sweep = [s.x, 0.8];
      if (s.x > vw + 300) G.sweep = null;
    }
  }

  // inpainting patches every few seconds
  G.nextIp -= dt;
  if (!reduce && G.nextIp <= 0) {
    G.nextIp = rand(3.5, 6);
    if (G.T < 0.3) { const s = rand(0.1, 0.2), u = rand(0.15, 0.85 - s), v = rand(0.15, 0.85 - s); inpaint(u, v, u + s, v + s * rand(0.7, 1.2), 0.6); }
  }
  let nip = 0;
  for (let k = IP.length - 1; k >= 0; k--) { const p = IP[k]; p.age += dt; if (p.age > p.up + p.down) IP.splice(k, 1); }
  for (const p of IP) {
    const t = p.age < p.up ? p.age / p.up : 1 - (p.age - p.up) / p.down;
    ipA.set(p.r, nip * 4); ipT[nip] = p.peak * Math.sin(Math.min(1, t) * Math.PI / 2); nip++;
  }

  // the drifting dots: each wanders on a slowly turning heading
  let ns = 0;
  if (!reduce) for (const s of specks) {
    s.a += dt * (s.turn + 0.5 * Math.sin(time * s.wob + s.r * 7));
    s.x += Math.cos(s.a) * s.sp * dt / vw; s.y += Math.sin(s.a) * s.sp * dt / vh;
    s.x -= Math.floor(s.x); s.y -= Math.floor(s.y);   // off one side, back on the other
    const X = s.x * vw, Y = s.y * vh;
    s.next -= dt; if (s.next <= 0) { s.next = rand(3, 7); s.phase = 1; }
    if (s.phase > 0) s.phase = Math.max(0, s.phase - dt / 1.6);
    s.t = s.phase > 0 ? Math.sin(s.phase * Math.PI) * 0.8 : 0;
    const ox = Math.max(plateR.x - X, 0, X - plateR.x - plateR.w), oy = Math.max(plateR.y - Y, 0, Y - plateR.y - plateR.h);
    const pres = smooth(0, 16, Math.hypot(ox, oy)) * smooth(0, 24, Math.min(X, vw - X, Y, vh - Y));   // not on the picture; soft at the screen's sides
    if (pres <= 0) continue;
    sp.set([X, Y, s.r, 0.9 * pres], ns * 4); spt[ns] = s.t; ns++;
  }

  // cursor noise fades back to zero
  if (C.live && C.v) {
    const k = Math.exp(-dt / 0.7); let mx = 0;
    for (let i = 0; i < C.v.length; i++) { const v = C.v[i] * k; C.v[i] = v < 0.004 ? 0 : v; C.u8[i] = (v * 255 + 0.5) | 0; if (v > mx) mx = v; }
    R.cursor(C.u8, C.w, C.h);
    C.live = mx > 0;
  }

  // per-layer noise steps: coarse resolves first, fine detail last; the subtitle follows the plate, the quote its own step.
  // Words' grain fades out last and back in first (presence a), so a swap at full static is never seen.
  const T = G.T, QT = Q.T;
  const pt = [clamp01(1.25 * T - 0.25), clamp01(1.25 * T - 0.1), clamp01(1.6 * T)];
  const t0 = TXT[0].info, t1 = TXT[1].info, t2 = TXT[2].info;
  // the subtitle's noise hugs its letters like the quote's: its mask is blurred by the same share of its font size
  // (one blur for both turned the small one-line subtitle into a solid box of static)
  const blurPerFont = t0 ? Math.min(0.25, 2 ** Math.max(0, t0.maxLod - 5.5) / t0.sc / TXT[0].font) : 0.2;
  const envFor = (ti, font) => Math.max(0, Math.min(ti.maxLod - 5.5, Math.log2(Math.max(1, ti.sc * blurPerFont * font))));
  const whoEnv = t2 && envFor(t2, TXT[2].font);
  const capEnv = t1 && Math.max(0, Math.min(t1.maxLod - 5.5, Math.log2(Math.max(1, t1.sc * blurPerFont * TXT[1].font))));
  R.draw({
    vw, vh, px, time, sigma: 0.62, noiseRate: reduce ? 0 : 6, floor: 0.055 + 0.05 * smooth(0, 1, boot), curAmt: 0.9, sweep,
    plate: { ...plateR, layer: 0, t: pt, texPerCss: side / plateR.w, maxLod },
    nip, ip: ipA, ipt: ipT,
    text: [t0 && { x: qr.x, y: qr.y, w: t0.w, h: t0.h, t: QT, a: Q.xa, texPerCss: t0.sc, maxLod: t0.maxLod },
      t1 && { x: cr.x, y: cr.y, w: t1.w, h: t1.h, t: clamp01((T - 0.1) / 0.65), a: smooth(0, 1, CPREV.xf), texPerCss: t1.sc, maxLod: t1.maxLod, envLod: capEnv },
      PREV.a > 0 && PREV.info && { x: qr.x, y: qr.y, w: PREV.info.w, h: PREV.info.h, t: 1, a: PREV.a, texPerCss: PREV.info.sc, maxLod: PREV.info.maxLod },
      t2 && { x: wr.x, y: wr.y, w: t2.w, h: t2.h, t: I.T, a: 1, texPerCss: t2.sc, maxLod: t2.maxLod, envLod: whoEnv },
      CPREV.xf < 1 && CPREV.info && { x: cr.x, y: cr.y, w: CPREV.info.w, h: CPREV.info.h, t: 1, a: 1 - smooth(0, 1, CPREV.xf), texPerCss: CPREV.info.sc, maxLod: CPREV.info.maxLod, envLod: capEnv },
      ...TXT.slice(3).map((s) => {   // the small labels (slots 5-8): they develop out of noise as they fade in
        const i = s.info, a = i ? +getComputedStyle(s.op).opacity : 0;
        if (a < 0.01) return null;
        const r = rectOf(s.el);
        return { x: r.x, y: r.y, w: i.w, h: i.h, t: clamp01(1 - a) * 0.9, a, texPerCss: i.sc, maxLod: i.maxLod, envLod: envFor(i, s.font) };
      })],
    ns, sp, spt,
    media: med && R && (() => {
      const lk = { ...LOOK, ...mod.look }, [z, ox, oy] = motionAt(mod, reduce ? (mod.still ?? 0) : G.t);
      return { zoom: z * (lk.zoom || 1), ox, oy, base: lk.base, sharp: lk.sharp, grain: lk.grain, sharpLod: lk.sharpLod, lev: lk.levels, texPerCss: med.w / plateR.w, maxLod: medLod };
    })(),
  });


  if (veil && ++veil > 2) { root.classList.remove('veil'); veil = 0; }   // the GPU's own static is on screen now

  if (fpsEl) {   // ?fps: frame rate and the slowest frame of the last second, to check smoothness on a real screen
    fpsAcc.push(dt * 1000);
    if (now - fpsAt > 1000) { fpsEl.textContent = `${fpsAcc.length} fps · slowest ${Math.max(...fpsAcc).toFixed(0)} ms · ${canvas.width}×${canvas.height}`; fpsAcc.length = 0; fpsAt = now; }
  }

  // keep it smooth on slow GPUs: drop the drawing resolution once if frames are long
  if (frameLog.length === 120 && time > 3 && px > pxBase * 0.55) {
    const avg = frameLog.reduce((a, b) => a + b, 0) / 120;
    if (avg > 0.026) { px *= 0.8; sizeCanvas(); frameLog.length = 0; }
  }
}

// the page starts drawing at once; the plate stays static (G.wait) until the first clip that loads can show
G.wait = true;
const firstClip = (async () => { for (let k = 1; !(await loadPic(reel[G.cur])) && k < NC; k++) G.cur = (G.cur + 1) % NC; })();
showQuote(Q.cur); showClip();
if (solo) { G.T = 0.6; G.sharp = true; }
if (!R) {
  root.classList.add('no-gl'); root.classList.remove('boot', 'veil');
  await firstClip; G.wait = false; showClip();
  await document.fonts.ready; fitQuote(); startMedia(G.cur); flatDraw();
} else {
  // while the GPU context is gone the drawn words would be invisible (html.gl hides the DOM text): show the DOM text
  canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); lost = true; root.classList.remove('gl', 'boot', 'veil'); });
  canvas.addEventListener('webglcontextrestored', () => { R = createRenderer(canvas); side = 0; sizeForms(); TXT.forEach((t) => (t.dirty = true)); cursorGrid(); lost = false; root.classList.add('gl'); });
  await Promise.all(['500 20px Geist', '450 20px Geist', '500 12px "Geist Mono"', '600 12px "Geist Mono"', '400 12px "Geist Mono"'].map((f) => document.fonts.load(f)));
  await loadFonts(TXT.map((s) => s.el));   // the faces of the words drawn out of noise (quote, credit, subtitle, intro)
  await document.fonts.ready; fitQuote();
  px = Infinity; sizeCanvas(); cursorGrid(); sizeForms();
  TXT.forEach((_, k) => rasterTxt(k));
  R.cursor(C.u8, C.w, C.h);
  firstClip.then(() => {
    G.wait = false; showClip(); drawPic();   // its first frame onto the plate (the first try may have skipped a clip that failed)
    if (reduce) G.T = 0;
    startMedia(G.cur);
    for (const d of [1, -1]) loadPic(reel[(G.cur + d + NC) % NC]);
  });
  document.addEventListener('visibilitychange', () => { const M = media.get(reel[G.cur]); if (M?.video && document.hidden) M.el.pause(); });
  last = performance.now();
  frame(last);
  if (!lost) root.classList.add('gl');
  window.denoise = { G, Q, quotes, reel, goClip, goQuote, stamp, inpaint, fitQuote, media: () => media.get(reel[G.cur])?.el, get px() { return px; }, get canvasSize() { return [canvas.width, canvas.height]; }, get side() { return side; } };
}
