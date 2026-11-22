// The GPU side: one full-screen pass. Wherever there is a picture (the generator's plate, the quote,
// the subtitle) it shows a diffusion step of that picture:
//   x_t = sqrt(alpha_bar(t)) * x0_hat + sqrt(1 - alpha_bar(t)) * noise,   alpha_bar = cosine schedule,
// where x0_hat is the clean picture blurred in proportion to the noise level, which is what an ideal
// denoiser predicts for natural images: coarse shapes come back first, fine detail last.
// No neural network: this imitates what a sampler shows, step by step.

export const MAX_SP = 24, MAX_IP = 8;
// text slots (every piece of text on the page is drawn out of noise): 0 quote, 1 subtitle, 2 previous quote, 3 intro,
// 4 previous subtitle, 5 top links, 6 "Quotes I believe in", 7 the hint, 8 the footer
export const NTXT = 9;
const TXT_UNITS = [3, 4, 6, 7, 8, 9, 10, 11, 12];   // texture units (0 forms, 2 cursor, 5 footage)
const slots = (f) => [...Array(NTXT).keys()].map(f).join('\n');

const VS = `#version 300 es
void main(){ vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2)); gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0); }`;

const FS = `#version 300 es
precision highp float; precision highp int; precision highp sampler2DArray;
uniform vec2 uRes, uView; uniform float uPx, uTime, uSigma, uFloor, uCurAmt, uNoiseRate;
uniform vec3 uBg, uInk;
uniform sampler2D uCur;
uniform vec2 uSweep;
uniform sampler2DArray uForms;
uniform vec4 uPlate; uniform float uLayer; uniform vec3 uPT; uniform vec2 uLodK;
uniform int uNIp; uniform vec4 uIp[${MAX_IP}]; uniform float uIpT[${MAX_IP}];
${slots((i) => `uniform sampler2D uTx${i}; uniform vec4 uTR${i}; uniform float uTT${i}, uTOn${i}, uTA${i}; uniform vec3 uTL${i};`)}
// real footage / photos: one grey frame texture, split into three frequency bands in here (see the plate)
uniform sampler2D uMed; uniform float uMedOn; uniform vec3 uMX; uniform vec4 uMK; uniform vec3 uMLev; uniform vec2 uMLod;
uniform int uNS; uniform vec4 uSp[${MAX_SP}]; uniform float uSpT[${MAX_SP}];
out vec4 o;

uint pcg(uint v){ uint s = v * 747796405u + 2891336453u; uint w = ((s >> ((s >> 28u) + 4u)) ^ s) * 277803737u; return (w >> 22u) ^ w; }
float rnd(uvec3 p){ return float(pcg((p.x * 1973u) ^ (p.y * 9277u) ^ pcg(p.z + 26699u))) * (1.0 / 4294967295.0); }
float gauss(uvec2 g, uint k){ return (rnd(uvec3(g, k * 2u)) + rnd(uvec3(g, k * 2u + 1u)) - 1.0) * 2.449; }   // ~unit variance
float vnoise(vec2 p){
  vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  uvec2 u = uvec2(ivec2(i) + 65536);
  float a = rnd(uvec3(u, 7u)), b = rnd(uvec3(u + uvec2(1, 0), 7u)), c = rnd(uvec3(u + uvec2(0, 1), 7u)), d = rnd(uvec3(u + uvec2(1, 1), 7u));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}
vec3 abar(vec3 t){ vec3 c = cos((t + 0.008) / 1.008 * 1.5707963); return max(c * c, vec3(1e-4)); }
float abar1(float t){ float c = cos((t + 0.008) / 1.008 * 1.5707963); return max(c * c, 1e-4); }
// a: presence (0..1): fades the words' grain away at the very end of a dissolve, so the swap to new words is never seen
void textSlot(sampler2D tex, vec4 r, float T, vec3 lk, float a, float tx, vec2 css, inout float sig, inout float nz, inout float fine){
  vec2 uv = (css - r.xy) / r.zw;
  if (a <= 0.0 || uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) return;
  float t = clamp(1.0 - (1.0 - T) * (1.0 - tx), 0.0, 1.0);
  float ab = abar1(t), sg = sqrt((1.0 - ab) / ab);
  float x = textureLod(tex, uv, clamp(log2(1.0 + 4.0 * sg * lk.x), 0.0, lk.y)).r;
  float env = textureLod(tex, uv, lk.z).r;   // the words blurred a little: where their noise may go
  float edge = smoothstep(0.0, 0.06, min(min(uv.x, 1.0 - uv.x), min(uv.y, 1.0 - uv.y)) * 8.0);
  sig = max(sig, a * sqrt(ab) * x);
  nz = max(nz, a * sqrt(1.0 - ab) * smoothstep(0.0, 0.1, env) * edge);
  fine = max(fine, a * sqrt(ab) * x);
}

void main(){
  vec2 css = vec2(gl_FragCoord.x, uRes.y - gl_FragCoord.y) / uPx;
  float cur = texture(uCur, css / uView).r * uCurAmt;
  float sw = uSweep.y > 0.0 ? uSweep.y * exp(-pow((css.x - uSweep.x) / 140.0, 2.0)) : 0.0;
  float tx = 1.0 - (1.0 - cur) * (1.0 - sw);
  float br = smoothstep(0.62, 0.95, vnoise(css * 0.004 + vec2(uTime * 0.04, -uTime * 0.025)));
  float sig = 0.0, nz = uFloor * (0.8 + 0.4 * br) + sw * 0.35, fine = 0.0, media = 0.0;

  // the plate: the generator's current form
  vec2 uv = (css - uPlate.xy) / uPlate.zw;
  if (uv.x >= 0.0 && uv.y >= 0.0 && uv.x <= 1.0 && uv.y <= 1.0) {
    float ip = 0.0;
    for (int i = 0; i < ${MAX_IP}; i++) {
      if (i >= uNIp) break; vec4 r = uIp[i];
      vec2 q = abs(uv - (r.xy + r.zw) * 0.5) - (r.zw - r.xy) * 0.5;
      ip = max(ip, uIpT[i] * (1.0 - smoothstep(-0.01, 0.025, max(q.x, q.y))));
    }
    vec3 tt = clamp(1.0 - (1.0 - uPT) * (1.0 - tx) * (1.0 - ip), 0.0, 1.0);
    vec3 ab = abar(tt), sg = sqrt((1.0 - ab) / ab);
    vec3 lod = clamp(log2(1.0 + 5.0 * sg * uLodK.x), 0.0, uLodK.y);
    float el = max(0.0, uLodK.y - 4.0);
    vec3 x, env;
    if (uMedOn > 0.5) {
      // a real frame, as three bands that clear one after another like the drawn layers do:
      // coarse = the frame blurred (masses), structure = the frame minus that blur, fine = a sharpening high-pass.
      // All clear: coarse + structure + fine = the frame, a little sharpened.
      vec2 mu = (uv - 0.5) / uMX.x + 0.5 + uMX.yz;
      vec3 lm = clamp(log2(1.0 + 5.0 * sg * uMLod.x), 0.0, uMLod.y);
      float lv = 1.0 / max(0.05, uMLev.y - uMLev.x);   // levels: black point, white point, gamma (per clip)
      float C = pow(clamp((textureLod(uMed, mu, max(lm.r, uMK.x)).r - uMLev.x) * lv, 0.0, 1.0), uMLev.z);
      float M = pow(clamp((textureLod(uMed, mu, lm.g).r - uMLev.x) * lv, 0.0, 1.0), uMLev.z);
      float F = (textureLod(uMed, mu, lm.b).r - textureLod(uMed, mu, lm.b + uMK.w).r) * lv;
      sig = clamp(sqrt(ab.r) * C + sqrt(ab.g) * (M - C) + sqrt(ab.b) * uMK.y * F, 0.0, 1.0);
      env = vec3(pow(clamp((textureLod(uMed, mu, max(0.0, uMLod.y - 4.0)).r - uMLev.x) * lv, 0.0, 1.0), uMLev.z));
      x = vec3(0.0);
    } else {
      x = vec3(textureLod(uForms, vec3(uv, uLayer), lod.r).r, textureLod(uForms, vec3(uv, uLayer + 1.0), lod.g).r, textureLod(uForms, vec3(uv, uLayer + 2.0), lod.b).r);
      env = vec3(textureLod(uForms, vec3(uv, uLayer), el).r, textureLod(uForms, vec3(uv, uLayer + 1.0), el).r, textureLod(uForms, vec3(uv, uLayer + 2.0), el).r);
    }
    float any = max(env.r, max(env.g, env.b));
    vec2 eu = min(uv, 1.0 - uv);
    float edge = smoothstep(0.0, 0.07, eu.x) * smoothstep(0.0, 0.07, eu.y);
    // at high noise the static fills the plate (a little denser where the picture will be); late in the
    // schedule each layer's leftover noise stays on that layer's own content, so the empty plate goes dark
    vec3 late = smoothstep(0.0, 0.12, env) * 0.85 + 0.12 * smoothstep(0.0, 0.1, any);
    vec3 w = mix(late, vec3(0.5 + 0.5 * smoothstep(0.0, 0.1, any)), smoothstep(0.3, 0.85, clamp(1.0 - (1.0 - uPT) * (1.0 - tx), 0.0, 1.0))) * edge;   // inpainting re-noises only where there is picture
    vec3 n = sqrt(1.0 - ab) * w;
    if (uMedOn > 0.5) media = 1.0;
    else { vec3 s = sqrt(ab) * x; sig = max(s.r, max(s.g, s.b)); fine = s.b; }
    nz = max(nz, max(n.r, max(n.g, n.b)));
  }

${slots((i) => `  if (uTOn${i} > 0.5) textSlot(uTx${i}, uTR${i}, uTT${i}, uTL${i}, uTA${i}, tx, css, sig, nz, fine);`)}

  for (int i = 0; i < ${MAX_SP}; i++) {   // small moving things (specks, packets), each with its own noise step
    if (i >= uNS) break; vec4 sp = uSp[i]; float d = length(css - sp.xy);
    if (d > sp.z * 3.0 + 40.0) continue;
    float t = clamp(1.0 - (1.0 - uSpT[i]) * (1.0 - tx), 0.0, 1.0);
    float ab = abar1(t); float bl = min(7.0, 3.0 * sqrt((1.0 - ab) / ab));
    float disc = 1.0 - smoothstep(sp.z - 0.6 - bl * 0.5, sp.z + 0.6 + bl, d);
    sig = max(sig, sqrt(ab) * sp.w * disc);
    float rr = sp.z + bl * 0.5 + 1.5; nz = max(nz, sqrt(1.0 - ab) * sp.w * exp(-d * d / (rr * rr * 2.0)));
  }

  uvec2 g = uvec2(gl_FragCoord.xy);
  // the grain morphs smoothly from one random pattern to the next (uNoiseRate patterns a second): both the noise and
  // the print screen blend between their two nearest patterns, so nothing ever snaps from one frame to the next
  float ft = uTime * uNoiseRate; float k = floor(ft); float f = ft - k; f = f * f * (3.0 - 2.0 * f);
  float nrm = inversesqrt((1.0 - f) * (1.0 - f) + f * f);   // keeps the blend as strong as one pattern
  uint ki = uint(k);
  float e = mix(gauss(g, ki), gauss(g, ki + 1u), f) * nrm;
  float d = clamp(sig + uSigma * nz * e, 0.0, 1.0);
  float scr = clamp(0.5 + (mix(rnd(uvec3(g, ki * 7u + 911u)), rnd(uvec3(g, (ki + 1u) * 7u + 911u)), f) - 0.5) * nrm, 0.0, 1.0);
  float ink = clamp((pow(d, 0.85) - scr * 0.85) * 5.0, 0.0, 1.0);   // stochastic print screen: the grain look
  float soft = smoothstep(0.2, 0.6, fine) * step(sig - fine, 0.02);  // keep thin lines and small text readable
  ink = mix(d, ink, mix(mix(0.62, 0.25, soft), uMK.z, media));      // footage has its own grain amount
  o = vec4(mix(uBg, uInk, ink), 1.0);
}`;

function hex(c) { return [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16) / 255); }

export function createRenderer(canvas) {
  const gl = canvas.getContext('webgl2', { antialias: false, alpha: false, depth: false, stencil: false, premultipliedAlpha: false, powerPreference: 'high-performance' });
  if (!gl) return null;
  const prog = gl.createProgram();
  for (const [type, src] of [[gl.VERTEX_SHADER, VS], [gl.FRAGMENT_SHADER, FS]]) {
    const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) { console.error(gl.getShaderInfoLog(s)); return null; }
    gl.attachShader(prog, s);
  }
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) { console.error(gl.getProgramInfoLog(prog)); return null; }
  gl.useProgram(prog);
  gl.bindVertexArray(gl.createVertexArray());
  const U = {};
  const n = gl.getProgramParameter(prog, gl.ACTIVE_UNIFORMS);
  for (let i = 0; i < n; i++) { const name = gl.getActiveUniform(prog, i).name.replace(/\[0\]$/, ''); U[name] = gl.getUniformLocation(prog, name); }
  gl.uniform1i(U.uForms, 0); gl.uniform1i(U.uCur, 2); gl.uniform1i(U.uMed, 5); TXT_UNITS.forEach((u, i) => gl.uniform1i(U['uTx' + i], u));
  gl.uniform3fv(U.uBg, hex('#0b0b12')); gl.uniform3fv(U.uInk, hex('#e8e4da'));
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  const maxTex = gl.getParameter(gl.MAX_TEXTURE_SIZE);

  function params(target, mip) {
    gl.texParameteri(target, gl.TEXTURE_MIN_FILTER, mip ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR);
    gl.texParameteri(target, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(target, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(target, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  }
  // all forms live in one array texture: 3 grey layers per form (coarse, structure, fine)
  let forms = null, formSide = 0;
  const cur = gl.createTexture(); gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, cur); params(gl.TEXTURE_2D, false);
  let curW = 0, curH = 0;
  const unit = (i) => gl.TEXTURE0 + TXT_UNITS[i];
  const txt = [...Array(NTXT).keys()].map((i) => { const t = gl.createTexture(); gl.activeTexture(unit(i)); gl.bindTexture(gl.TEXTURE_2D, t); params(gl.TEXTURE_2D, true); gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, 1, 1, 0, gl.RED, gl.UNSIGNED_BYTE, new Uint8Array(1)); return t; });
  // real footage: the current video frame (or photo), RGBA so the browser can copy decoded frames on the GPU
  let med = null, medW = 0, medH = 0;
  function allocMed(w, h) {
    if (med) gl.deleteTexture(med);
    med = gl.createTexture(); medW = w; medH = h;
    gl.activeTexture(gl.TEXTURE5); gl.bindTexture(gl.TEXTURE_2D, med); params(gl.TEXTURE_2D, true);
    gl.texStorage2D(gl.TEXTURE_2D, Math.floor(Math.log2(Math.max(w, h))) + 1, gl.RGBA8, w, h);
  }
  allocMed(1, 1);

  return {
    gl, maxTex,
    allocForms(side, count) {
      if (forms) gl.deleteTexture(forms);
      forms = gl.createTexture(); formSide = side;
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D_ARRAY, forms); params(gl.TEXTURE_2D_ARRAY, true);
      gl.texStorage3D(gl.TEXTURE_2D_ARRAY, Math.floor(Math.log2(side)) + 1, gl.R8, side, side, count * 3);
      return Math.floor(Math.log2(side));
    },
    uploadForm(i, layers) {   // three canvases, side x side
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D_ARRAY, forms);
      layers.forEach((cv, k) => gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, 0, 0, 0, i * 3 + k, formSide, formSide, 1, gl.RED, gl.UNSIGNED_BYTE, cv));
      gl.generateMipmap(gl.TEXTURE_2D_ARRAY);
    },
    swapText(a, b) {   // hand slot a's texture to slot b (no re-upload)
      [txt[a], txt[b]] = [txt[b], txt[a]];
      for (const i of [a, b]) { gl.activeTexture(unit(i)); gl.bindTexture(gl.TEXTURE_2D, txt[i]); }
    },
    uploadText(i, cv) {
      gl.activeTexture(unit(i)); gl.bindTexture(gl.TEXTURE_2D, txt[i]);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, gl.RED, gl.UNSIGNED_BYTE, cv);
      gl.generateMipmap(gl.TEXTURE_2D);
    },
    cursor(data, w, h) {
      gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, cur);
      if (w !== curW || h !== curH) { gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, w, h, 0, gl.RED, gl.UNSIGNED_BYTE, data); curW = w; curH = h; }
      else gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, w, h, gl.RED, gl.UNSIGNED_BYTE, data);
    },
    uploadMedia(src, w, h) {   // a <video> or <img>, w x h; returns the top mip level
      if (w !== medW || h !== medH) allocMed(w, h);
      gl.activeTexture(gl.TEXTURE5); gl.bindTexture(gl.TEXTURE_2D, med);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, src);
      gl.generateMipmap(gl.TEXTURE_2D);
      return Math.floor(Math.log2(Math.max(w, h)));
    },
    draw(f) {
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.uniform2f(U.uRes, canvas.width, canvas.height); gl.uniform2f(U.uView, f.vw, f.vh);
      gl.uniform1f(U.uPx, f.px); gl.uniform1f(U.uTime, f.time); gl.uniform1f(U.uSigma, f.sigma);
      gl.uniform1f(U.uNoiseRate, f.noiseRate);  gl.uniform1f(U.uFloor, f.floor); gl.uniform1f(U.uCurAmt, f.curAmt);
      gl.uniform2f(U.uSweep, f.sweep[0], f.sweep[1]);
      const p = f.plate;
      gl.uniform4f(U.uPlate, p.x, p.y, p.w, p.h); gl.uniform1f(U.uLayer, p.layer); gl.uniform3fv(U.uPT, p.t); gl.uniform2f(U.uLodK, p.texPerCss, p.maxLod);
      gl.uniform1i(U.uNIp, f.nip); if (f.nip) { gl.uniform4fv(U.uIp, f.ip); gl.uniform1fv(U.uIpT, f.ipt); }
      for (let i = 0; i < NTXT; i++) {
        const t = f.text[i];
        gl.uniform1f(U['uTOn' + i], t ? 1 : 0);
        if (!t) continue;
        gl.uniform4f(U['uTR' + i], t.x, t.y, t.w, t.h); gl.uniform1f(U['uTT' + i], t.t); gl.uniform3f(U['uTL' + i], t.texPerCss, t.maxLod, t.envLod ?? Math.max(0, t.maxLod - 5.5)); gl.uniform1f(U['uTA' + i], t.a ?? 1);
      }
      gl.uniform1i(U.uNS, f.ns); if (f.ns) { gl.uniform4fv(U.uSp, f.sp); gl.uniform1fv(U.uSpT, f.spt); }
      const m = f.media;
      gl.uniform1f(U.uMedOn, m ? 1 : 0);
      if (m) {
        gl.uniform3f(U.uMX, m.zoom, m.ox, m.oy); gl.uniform4f(U.uMK, m.base, m.sharp, m.grain, m.sharpLod);
        gl.uniform3f(U.uMLev, m.lev[0], m.lev[1], m.lev[2]); gl.uniform2f(U.uMLod, m.texPerCss, m.maxLod);
      }
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    },
  };
}
