// Real footage and photos as pictures. A picture module can export, instead of draw():
//   kind: 'video' | 'image', src: 'media/<name>' (the engine adds .mp4 / .webm, or .jpg),
//   desc, still (seconds into the clip that sums it up: reduced motion, no WebGL, sheets),
//   look: { levels: [black, white, gamma], grain, sharp, base }   (all optional, see LOOK),
//   motion: { push, period, drift: [x, y] }                     (photos only: a slow, real-looking push-in).
// The engine keeps the decoded frame on the GPU and splits it into the three bands there (js/gl.js).

export const LOOK = { levels: [0, 1, 1], grain: 0.5, sharp: 0.55, base: 3, sharpLod: 1.3 };
export const isMedia = (m) => !!m && (m.kind === 'video' || m.kind === 'image');

let host = null;   // decoders stay in the page (1 px, invisible): some browsers stop decoding detached videos
function hostEl() {
  if (!host) {
    host = document.createElement('div');
    host.setAttribute('aria-hidden', 'true');
    host.style.cssText = 'position:fixed;left:0;top:0;width:1px;height:1px;overflow:hidden;opacity:0;pointer-events:none';
    document.body.append(host);
  }
  return host;
}

// resolves to { el, w, h, video, last } once the first frame can be shown, or null (missing / unplayable).
// A clip may take as long as it needs to download (slow phones); timeoutMs only guards the decoding after that.
export function loadMedia(m, timeoutMs = 8000) {
  return new Promise((res) => {
    let done = false;
    const end = (v) => { if (!done) { done = true; res(v); } };
    if (m.kind === 'video') {
      const el = document.createElement('video');
      el.muted = el.defaultMuted = true; el.loop = true; el.playsInline = true; el.preload = 'auto';
      el.setAttribute('muted', ''); el.setAttribute('playsinline', '');
      el.width = el.height = 1;
      const ext = el.canPlayType('video/mp4; codecs="avc1.64001f"') ? 'mp4' : 'webm';
      const fail = (why) => { if (done) return; console.error(`video ${m.src}: ${why}`); releaseMedia({ el, video: true }); end(null); };
      el.addEventListener('loadeddata', () => end({ el, w: el.videoWidth, h: el.videoHeight, video: true, last: -1 }), { once: true });
      el.addEventListener('error', () => fail('cannot play'), { once: true });
      // whole clip into memory first (≤ 2.5 MB): looping and seeking then work even on servers without range requests
      fetch(`${m.src}.${ext}`).then((r) => (r.ok ? r.blob() : Promise.reject(new Error(r.status)))).then((b) => {
        el.src = URL.createObjectURL(b);
        hostEl().append(el);
        el.load();
        setTimeout(() => fail('no frame in time'), timeoutMs);
      }).catch((e) => fail(e.message));
    } else {
      setTimeout(() => end(null), timeoutMs);
      const el = new Image();
      el.decoding = 'async';
      el.onload = () => end({ el, w: el.naturalWidth, h: el.naturalHeight, video: false, last: -1 });
      el.onerror = () => { console.error(`image ${m.src}: cannot load`); end(null); };
      el.src = `${m.src}.jpg`;
    }
  });
}

// let go of a clip that is no longer near the plate: its decoder, its frames and the downloaded file
export function releaseMedia(M) {
  if (!M?.video) return;
  const el = M.el, src = el.src;
  el.pause(); el.removeAttribute('src'); el.load(); el.remove();
  if (src.startsWith('blob:')) URL.revokeObjectURL(src);
}

// a photo's slow motion at clock t: [zoom, offset x, offset y] in plate units
export function motionAt(m, t) {
  const mo = m.motion;
  if (!mo) return [1, 0, 0];
  const u = 0.5 - 0.5 * Math.cos((2 * Math.PI * t) / (mo.period || 24));
  const [dx, dy] = mo.drift || [0, 0];
  return [1 + (mo.push || 0) * u, dx * u, dy * u];
}
