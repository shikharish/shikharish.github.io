// Draws an element's words into a grey canvas at exactly the places the browser laid them out,
// so the shader can develop the text out of noise over the (transparent) real text.
// Each text node is drawn in its parent's font (family, style, weight, size, letter spacing, case);
// `--tone` (0..1) on a parent sets how bright its words are drawn (dim details, credits).

const CASE = { uppercase: (s) => s.toUpperCase(), lowercase: (s) => s.toLowerCase() };

// every font face the element's text uses, loaded (call before the first rasterText)
export function loadFonts(els) {
  const fams = new Set();
  const clean = (f) => f.trim().replace(/^["']|["']$/g, '');
  for (const el of els) for (const n of [el, ...el.querySelectorAll('*')]) getComputedStyle(n).fontFamily.split(',').forEach((f) => fams.add(clean(f)));
  return Promise.all([...document.fonts].filter((f) => fams.has(clean(f.family))).map((f) => f.load().catch(() => null)));
}

export function rasterText(el, cv, sc, maxSide) {
  const box = el.getBoundingClientRect();
  sc = Math.min(sc, maxSide / Math.max(1, box.width), maxSide / Math.max(1, box.height));
  const w = Math.max(1, Math.ceil(box.width * sc)), h = Math.max(1, Math.ceil(box.height * sc));
  cv.width = w; cv.height = h;
  const ctx = cv.getContext('2d', { alpha: false });
  ctx.fillStyle = '#000'; ctx.fillRect(0, 0, w, h);
  if ('fontKerning' in ctx) ctx.fontKerning = 'normal';
  const range = document.createRange();
  const walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  let lastParent = null, asc = 0.8, desc = 0.2, tcase = null;
  for (let node = walk.nextNode(); node; node = walk.nextNode()) {
    const p = node.parentElement;
    if (p !== lastParent) {
      lastParent = p;
      const cs = getComputedStyle(p);
      ctx.font = `${cs.fontStyle} ${cs.fontWeight} ${parseFloat(cs.fontSize) * sc}px ${cs.fontFamily}`;
      if ('letterSpacing' in ctx) ctx.letterSpacing = `${(parseFloat(cs.letterSpacing) || 0) * sc}px`;
      tcase = CASE[cs.textTransform] || null;
      const tone = parseFloat(cs.getPropertyValue('--tone'));
      const v = Math.round(255 * (Number.isFinite(tone) ? Math.min(1, Math.max(0, tone)) : 1));
      ctx.fillStyle = `rgb(${v},${v},${v})`;
      const m = ctx.measureText('Hg'); asc = m.fontBoundingBoxAscent; desc = m.fontBoundingBoxDescent;
    }
    const text = node.nodeValue;
    for (const mt of text.matchAll(/\S+/g)) {
      range.setStart(node, mt.index); range.setEnd(node, mt.index + mt[0].length);
      const rects = range.getClientRects();
      if (!rects.length) continue;
      const r = rects[0];
      const word = tcase ? tcase(mt[0]) : mt[0];
      const x = (r.left - box.left) * sc, y = (r.top - box.top) * sc, rh = r.height * sc;
      const mw = ctx.measureText(word).width || 1;
      ctx.save();
      ctx.translate(x, y + rh * asc / (asc + desc));
      ctx.scale(Math.min(1.2, Math.max(0.85, (r.width * sc) / mw)), 1);
      ctx.fillText(word, 0, 0);
      ctx.restore();
    }
  }
  return { sc, w: box.width, h: box.height, maxLod: Math.floor(Math.log2(Math.max(w, h))) };
}
