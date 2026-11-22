// Shared helpers for picture modules (js/q/<id>.js). Grey only: every value is 0 (black) … 255 (ink).
// See README.md in this folder for the contract.

export const MONO = '"Geist Mono", ui-monospace, monospace';
export const SANS = 'Geist, Arial, sans-serif';

// seeded random numbers in [0, 1): const r = rng(seed); r()
export function rng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

// grey fill/stroke styles
export const g = (v) => `rgb(${v | 0},${v | 0},${v | 0})`;
export const ga = (v, a) => `rgba(${v | 0},${v | 0},${v | 0},${a})`;

// small maths for animation
export const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));
export const lerp = (a, b, u) => a + (b - a) * u;
export const smooth = (a, b, v) => { const u = clamp((v - a) / (b - a)); return u * u * (3 - 2 * u); };   // 0 before a, 1 after b
export const easeOut = (u) => 1 - (1 - clamp(u)) ** 3;

export function poly(ctx, pts) { ctx.beginPath(); pts.forEach((p, i) => (i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1]))); ctx.closePath(); }
export function line(ctx, a, b) { ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke(); }

// a lit ball: bright upper left, dark rim
export function shadedSphere(ctx, x, y, r, hi = 235, lo = 10) {
  const gr = ctx.createRadialGradient(x - r * 0.42, y - r * 0.46, r * 0.04, x - r * 0.1, y - r * 0.1, r * 1.15);
  gr.addColorStop(0, g(hi)); gr.addColorStop(0.35, g(hi * 0.78)); gr.addColorStop(0.72, g(hi * 0.33)); gr.addColorStop(0.94, g(lo * 2)); gr.addColorStop(1, g(lo));
  ctx.fillStyle = gr; ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
}

// soft light added on top of what is there (use on the coarse layer): v = peak grey at the centre
export function glow(ctx, x, y, r, v, sy = 1) {
  const gr = ctx.createRadialGradient(x, y, 0, x, y, r);
  gr.addColorStop(0, g(v)); gr.addColorStop(0.35, g(v * 0.45)); gr.addColorStop(1, g(0));
  ctx.save(); ctx.globalCompositeOperation = 'lighter'; ctx.translate(x, y); ctx.scale(1, sy); ctx.translate(-x, -y);
  ctx.fillStyle = gr; ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill(); ctx.restore();
}

// text in screen pixels
export function text(ctx, s, x, y, size, { wt = 500, font = MONO, v = 200, align = 'left' } = {}) {
  ctx.font = `${wt} ${size}px ${font}`; ctx.textAlign = align; ctx.fillStyle = g(v); ctx.fillText(s, x, y); ctx.textAlign = 'left';
}
// text inside a scaled transform (units ~1): drawn at 100x and scaled down, so glyphs are not built at a sub-pixel size
export function ptext(ctx, s, x, y, size, wt = 500) { ctx.save(); ctx.translate(x, y); ctx.scale(0.01, 0.01); ctx.font = `${wt} ${size * 100}px ${MONO}`; ctx.fillText(s, 0, 0); ctx.restore(); }

// isometric projection: x to the lower right, y to the lower left, z up. P(x, y, z) -> [px, py]
export function isoOf(S, cx, cy, k) {
  const P = (x, y, z = 0) => [S * cx + (x - y) * 0.866 * k, S * cy + (x + y) * 0.5 * k - z * k];
  P.plane = (ctx, z) => ctx.setTransform(0.866 * k, 0.5 * k, -0.866 * k, 0.5 * k, S * cx, S * cy - z * k);   // draw in plane units on z
  return P;
}
// an isometric box: faces on L[0] (coarse), edges on L[1] (structure)
export function box(L, P, x0, y0, x1, y1, z0, z1, top, left, right, edge, lw) {
  const [c, m] = L;
  c.fillStyle = g(right); poly(c, [P(x1, y0, z0), P(x1, y1, z0), P(x1, y1, z1), P(x1, y0, z1)]); c.fill();
  c.fillStyle = g(left); poly(c, [P(x0, y1, z0), P(x1, y1, z0), P(x1, y1, z1), P(x0, y1, z1)]); c.fill();
  c.fillStyle = typeof top === 'number' ? g(top) : top;
  poly(c, [P(x0, y0, z1), P(x1, y0, z1), P(x1, y1, z1), P(x0, y1, z1)]); c.fill();
  if (edge) {
    m.strokeStyle = g(edge); m.lineWidth = lw; m.lineJoin = 'round';
    poly(m, [P(x0, y0, z1), P(x1, y0, z1), P(x1, y1, z1), P(x0, y1, z1)]); m.stroke();
    m.beginPath(); m.moveTo(...P(x1, y0, z1)); m.lineTo(...P(x1, y0, z0)); m.lineTo(...P(x1, y1, z0)); m.lineTo(...P(x0, y1, z0)); m.lineTo(...P(x0, y1, z1));
    m.moveTo(...P(x1, y1, z1)); m.lineTo(...P(x1, y1, z0)); m.stroke();
  }
}

// a pinhole camera for scenes with depth. World: x right, y up, z toward the viewer.
// yaw turns the scene about the vertical axis (positive shows its right side), pitch tilts it toward you (positive looks down on it).
// P(x, y, z) -> [px, py, k] where k = pixels per world unit at that depth (use it to size things).
export function camera(S, { cx = 0.5, cy = 0.5, scale = 0.25, dist = 12, yaw = 0, pitch = 0 } = {}) {
  const cy_ = Math.cos(yaw), sy = Math.sin(yaw), cp = Math.cos(pitch), sp = Math.sin(pitch);
  return (x, y, z = 0) => {
    const x1 = x * cy_ - z * sy, z1 = x * sy + z * cy_;
    const y2 = y * cp - z1 * sp, z2 = y * sp + z1 * cp;
    const k = S * scale * dist / (dist - z2);
    return [S * cx + x1 * k, S * cy - y2 * k, k];
  };
}
// faces facing the camera have positive area in screen space (points listed counter-clockwise seen from outside)
export const facing = (pts) => { let a = 0; for (let i = 0; i < pts.length; i++) { const p = pts[i], q = pts[(i + 1) % pts.length]; a += p[0] * q[1] - q[0] * p[1]; } return a < 0; };

// map the unit square onto a parallelogram (o = corner for (0,0), u = corner for (1,0), v = corner for (0,1)),
// so flat things on a face (a screen, a label) can be drawn in 0…1 units. Remember line widths are in those units too.
export function onPlane(ctx, o, u, v) { ctx.setTransform(u[0] - o[0], u[1] - o[1], v[0] - o[0], v[1] - o[1], o[0], o[1]); }
export function reset(L) { for (const x of L) { x.setTransform(1, 0, 0, 1, 0, 0); x.globalCompositeOperation = 'source-over'; x.globalAlpha = 1; x.setLineDash([]); } }
