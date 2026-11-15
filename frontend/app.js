/* SPHEREx ChronoScope frontend — vanilla JS, no build step. */
(() => {
const $ = s => document.querySelector(s);
const qs = new URLSearchParams(location.search);
const PROXY = qs.get('proxy'); // e.g. ?proxy=php/api.php to route through PHP
const TARGETS = [['barnards-star',"Barnard's Star"],['epsilon-indi-b','Epsilon Indi B'],['wise-0855','WISE 0855'],['rw-aur','RW Aurigae'],['r-dra','R Draconis']];
const FOVS = [1, 2.5, 5, 15, 30];
const S = { ra: 133.7951, dec: -7.2451, fov: 5, band: 'D1-D6', mode: 'blink', epoch: 0, ref: 0, stretch: 'asinh', cmap: 'grayscale',
  blk: 1, wht: 99, frames: [], target: null, playing: false, dir: 1, pingpong: false, timer: null, interval: 600,
  view: { z: 1, px: 0, py: 0 }, sel: null, pm: { on: false, a: null, b: null }, cat: null, spec: null, lcModel: null, custom: false };

/* ---------- API ---------- */
async function api(path, params = {}) {
  const p = new URLSearchParams(params);
  const url = PROXY ? `${PROXY}?endpoint=${path}&${p}` : `/api/${path}?${p}`;
  const r = await fetch(url); if (!r.ok) throw new Error(path + ' ' + r.status); return r.json();
}
const toast = m => { const t = $('#toast'); t.textContent = m; t.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(() => t.hidden = true, 2200); };

/* ---------- coordinates ---------- */
function parseCoord(s) {
  s = s.trim();
  const sex = s.match(/^([+-]?\d+)[h:\s]\s*(\d+)[m:\s]\s*([\d.]+)s?\s*[,\s]\s*([+-]?\d+)[d°:\s]\s*(\d+)['m:\s]\s*([\d.]+)"?s?$/i);
  if (sex) {
    const ra = (+sex[1] + sex[2] / 60 + sex[3] / 3600) * 15;
    const sign = sex[4].trim().startsWith('-') ? -1 : 1;
    return { ra, dec: sign * (Math.abs(+sex[4]) + sex[5] / 60 + sex[6] / 3600) };
  }
  const dec = s.match(/^([+-]?\d+(?:\.\d+)?)\s*[,\s]\s*([+-]?\d+(?:\.\d+)?)$/);
  return dec ? { ra: +dec[1], dec: +dec[2] } : null;
}
const scaleAS = () => S.fov * 60 / (S.frames[0]?.w || 128); // arcsec/px
const sky2px = (px, py) => { const f = S.frames[0], sc = scaleAS(), c = Math.cos(S.dec * Math.PI / 180);
  return { ra: S.ra - (px - f.w / 2) * sc / 3600 / c, dec: S.dec - (py - f.h / 2) * sc / 3600 }; };
const fmtRA = d => { const h = d / 15, m = (h % 1) * 60, s = (m % 1) * 60; return `${String(Math.floor(h)).padStart(2,'0')}h${String(Math.floor(m)).padStart(2,'0')}m${s.toFixed(2).padStart(5,'0')}s`; };
const fmtDec = d => { const a = Math.abs(d), m = (a % 1) * 60, s = (m % 1) * 60; return `${d<0?'-':'+'}${String(Math.floor(a)).padStart(2,'0')}d${String(Math.floor(m)).padStart(2,'0')}m${s.toFixed(1).padStart(4,'0')}s`; };

/* ---------- URL state ---------- */
function readURL() { for (const k of ['ra','dec','fov']) if (qs.has(k)) S[k] = +qs.get(k);
  for (const k of ['band','mode','cmap','stretch']) if (qs.has(k)) S[k] = qs.get(k);
  if (qs.has('epoch')) S.epoch = +qs.get('epoch'); }
function writeURL() { const p = new URLSearchParams(location.search);
  Object.entries({ ra: S.ra.toFixed(5), dec: S.dec.toFixed(5), fov: S.fov, band: S.band, mode: S.mode, epoch: S.epoch, cmap: S.cmap, stretch: S.stretch }).forEach(([k, v]) => p.set(k, v));
  history.replaceState(null, '', '?' + p); }

/* ---------- colormaps / stretch ---------- */
const CM = {
  grayscale: [[0,0,0],[255,255,255]],
  viridis: [[68,1,84],[59,82,139],[33,145,140],[94,201,98],[253,231,37]],
  inferno: [[0,0,4],[87,16,110],[188,55,84],[249,142,9],[252,255,164]],
  'ir-heat': [[0,0,0],[90,0,0],[200,40,0],[255,160,0],[255,255,200]],
};
function lut(name) { const st = CM[name], out = new Uint8ClampedArray(256 * 3);
  for (let i = 0; i < 256; i++) { const t = i / 255 * (st.length - 1), k = Math.min(st.length - 2, Math.floor(t)), f = t - k;
    for (let c = 0; c < 3; c++) out[i * 3 + c] = st[k][c] + (st[k + 1][c] - st[k][c]) * f; } return out; }
const str = { linear: x => x, sqrt: Math.sqrt, log: x => Math.log10(1 + 999 * x) / 3, asinh: x => Math.asinh(10 * x) / Math.asinh(10) };
function pct(arr, p) { const s = Float32Array.from(arr).sort(); return s[Math.min(s.length - 1, Math.floor(p / 100 * s.length))]; }
function norm(arr) { const lo = pct(arr, S.blk), hi = pct(arr, S.wht), f = str[S.stretch], d = (hi - lo) || 1;
  const o = new Float32Array(arr.length); for (let i = 0; i < arr.length; i++) o[i] = f(Math.min(1, Math.max(0, (arr[i] - lo) / d))); return o; }

/* ---------- image math ---------- */
const sub = (a, b) => { const o = new Float32Array(a.length); for (let i = 0; i < a.length; i++) o[i] = a[i] - b[i]; return o; };
function coadd(median) { const n = S.frames.length, L = S.frames[0].data.length, o = new Float32Array(L);
  for (let i = 0; i < L; i++) { if (median) { const v = S.frames.map(f => f.data[i]).sort((a, b) => a - b); o[i] = v[n >> 1]; }
    else { let s = 0; for (const f of S.frames) s += f.data[i]; o[i] = s / n; } } return o; }
const off = document.createElement('canvas');
function composeFrame() {
  const F = S.frames; if (!F.length) return null; const f = F[S.epoch], w = f.w, h = f.h;
  off.width = w; off.height = h; const ctx = off.getContext('2d'), img = ctx.createImageData(w, h), L = lut(S.cmap);
  const put = (i, r, g, b) => { img.data[i*4] = r; img.data[i*4+1] = g; img.data[i*4+2] = b; img.data[i*4+3] = 255; };
  if (S.mode === 'rgb') {
    const ix = [0, F.length >> 1, F.length - 1], ch = ix.map(k => norm(F[k].data));
    for (let i = 0; i < w * h; i++) put(i, ch[0][i] * 255, ch[1][i] * 255, ch[2][i] * 255);
  } else if (S.mode === 'subtract') {
    const d = sub(f.data, F[S.ref].data); let m = 0; for (const v of d) m = Math.max(m, Math.abs(v)); m = pct(d.map(Math.abs), 99.5) || m || 1;
    for (let i = 0; i < w * h; i++) { const v = Math.max(-1, Math.min(1, d[i] / m)); // diverging: blue(neg) / white / red(pos) on dark
      put(i, v > 0 ? 255 * v : 0, Math.abs(v) * 60, v < 0 ? 255 * -v : 0); }
  } else {
    const data = S.mode === 'coadd' ? coadd(false) : S.mode === 'median' ? coadd(true) : f.data, n = norm(data);
    for (let i = 0; i < w * h; i++) { const k = Math.round(n[i] * 255) * 3; put(i, L[k], L[k+1], L[k+2]); }
  }
  ctx.putImageData(img, 0, 0); return off;
}

/* ---------- canvas viewer ---------- */
const cv = $('#sky'), ctx = cv.getContext('2d');
function fit() { const r = cv.parentElement.getBoundingClientRect(), d = devicePixelRatio || 1; cv.width = r.width * d; cv.height = r.height * d; draw(); }
const geom = () => { const f = S.frames[0], W = cv.width, H = cv.height, base = Math.min(W, H) * 0.92 / Math.max(f.w, f.h), z = base * S.view.z;
  return { z, x0: W / 2 - f.w * z / 2 + S.view.px, y0: H / 2 - f.h * z / 2 + S.view.py, f }; };
const toImg = (cx, cy) => { const g = geom(); return { x: (cx - g.x0) / g.z, y: (cy - g.y0) / g.z }; };
function draw() {
  if (!S.frames.length) return; const g = geom(), d = devicePixelRatio || 1, off_ = composeFrame();
  ctx.setTransform(1,0,0,1,0,0); ctx.fillStyle = '#000'; ctx.fillRect(0, 0, cv.width, cv.height);
  ctx.imageSmoothingEnabled = g.z < 3; ctx.drawImage(off_, g.x0, g.y0, g.f.w * g.z, g.f.h * g.z);
  const P = (x, y) => [g.x0 + x * g.z, g.y0 + y * g.z], sc = scaleAS();
  if ($('#ovGrid').checked) { ctx.strokeStyle = 'rgba(56,189,248,.25)'; ctx.fillStyle = 'rgba(56,189,248,.8)'; ctx.font = `${11*d}px monospace`; ctx.lineWidth = 1;
    const nice = [1,2,5,10,15,30,60,120,300,600,1800].find(v => v * (S.frames[0].w / (S.fov * 60)) * g.z > 70 * d) || 600; // arcsec step
    const step = nice / sc; for (let k = 1; k * step < g.f.w; k++) { const [x] = P(k * step, 0), [, y] = P(0, k * step);
      ctx.beginPath(); ctx.moveTo(x, g.y0); ctx.lineTo(x, g.y0 + g.f.h * g.z); ctx.moveTo(g.x0, y); ctx.lineTo(g.x0 + g.f.w * g.z, y); ctx.stroke();
      const c1 = sky2px(k * step, k * step); ctx.fillText(fmtRA(c1.ra).slice(0, 9), x + 3, g.y0 + 12 * d); ctx.fillText(fmtDec(c1.dec).slice(0, 8), g.x0 + 3, y - 3); } }
  // overlays
  const ov = S.cat; if (ov) {
    const px = u => P(g.f.w / 2 + u * g.f.w / 2, g.f.h / 2 - 0 * 1); // x only
    const pos = (x, y) => P(g.f.w / 2 + x * g.f.w / 2, g.f.h / 2 - y * g.f.h / 2);
    if ($('#ovGaia').checked) ov.gaia.forEach(s => { const [x, y] = pos(s.x, s.y); ctx.strokeStyle = '#38BDF8'; ctx.lineWidth = 1.5 * d; ctx.beginPath(); ctx.arc(x, y, 7 * d, 0, 6.3); ctx.stroke();
      const ax = x - s.pmra * 0.08 * d, ay = y - s.pmdec * 0.08 * d; ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(Math.max(0, Math.min(cv.width, ax)), Math.max(0, Math.min(cv.height, ay))); ctx.stroke(); });
    if ($('#ovWise').checked) ov.wise.forEach(s => { const [x, y] = pos(s.x, s.y); ctx.strokeStyle = '#F59E0B'; ctx.lineWidth = 1.5 * d; ctx.strokeRect(x - 6 * d, y - 6 * d, 12 * d, 12 * d); });
    if ($('#ovNeo').checked) ov.neossat.forEach(n => { ctx.strokeStyle = '#f472b6'; ctx.setLineDash([6 * d, 4 * d]); ctx.beginPath(); n.track.forEach((t, i) => { const [x, y] = pos(t[0], t[1]); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }); ctx.stroke(); ctx.setLineDash([]);
      const [x, y] = pos(n.track[0][0], n.track[0][1]); ctx.fillStyle = '#f472b6'; ctx.fillText(n.id, x + 4, y - 4); });
  }
  // scale bar
  const barAS = [1,2,5,10,20,30,60,120,300,600].find(v => v / sc * g.z > 80 * d) || 600, bw = barAS / sc * g.z;
  ctx.strokeStyle = '#fff'; ctx.fillStyle = '#fff'; ctx.lineWidth = 2 * d; ctx.beginPath(); ctx.moveTo(14 * d, cv.height - 64 * d); ctx.lineTo(14 * d + bw, cv.height - 64 * d); ctx.stroke();
  ctx.font = `${12*d}px sans-serif`; ctx.fillText(barAS >= 60 ? `${barAS / 60}′` : `${barAS}″`, 14 * d, cv.height - 70 * d);
  // PM tool marks
  const mark = (m, col) => { if (!m) return; const [x, y] = P(m.x, m.y); ctx.strokeStyle = col; ctx.lineWidth = 1.5 * d; ctx.beginPath(); ctx.arc(x, y, 9 * d, 0, 6.3); ctx.stroke(); };
  mark(S.pm.a, '#4ade80'); mark(S.pm.b, '#f87171');
  if (S.pm.a && S.pm.b) { const [x1, y1] = P(S.pm.a.x, S.pm.a.y), [x2, y2] = P(S.pm.b.x, S.pm.b.y); ctx.strokeStyle = '#F59E0B'; ctx.lineWidth = 2 * d;
    ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke(); const a = Math.atan2(y2 - y1, x2 - x1); ctx.beginPath(); ctx.moveTo(x2, y2);
    ctx.lineTo(x2 - 12 * d * Math.cos(a - .4), y2 - 12 * d * Math.sin(a - .4)); ctx.lineTo(x2 - 12 * d * Math.cos(a + .4), y2 - 12 * d * Math.sin(a + .4)); ctx.closePath(); ctx.fillStyle = '#F59E0B'; ctx.fill(); }
  if (S.sel) { const [x, y] = P(S.sel.x, S.sel.y); ctx.strokeStyle = '#F59E0B'; ctx.lineWidth = d; ctx.beginPath(); ctx.moveTo(x - 16 * d, y); ctx.lineTo(x - 5 * d, y); ctx.moveTo(x + 5 * d, y); ctx.lineTo(x + 16 * d, y); ctx.moveTo(x, y - 16 * d); ctx.lineTo(x, y - 5 * d); ctx.moveTo(x, y + 5 * d); ctx.lineTo(x, y + 16 * d); ctx.stroke(); }
  const e = S.frames[S.epoch]; $('#epochTag').innerHTML = `<b>${e.label}</b><br>${e.source} · ${e.utc} · MJD ${(+e.mjd).toFixed(1)}${S.mode !== 'blink' ? `<br><i>${S.mode}</i>` : ''}`;
}

/* ---------- interaction ---------- */
let drag = null;
cv.addEventListener('mousedown', e => { drag = { x: e.clientX, y: e.clientY, px: S.view.px, py: S.view.py, moved: false }; });
addEventListener('mouseup', e => { if (drag && !drag.moved && e.target === cv) onClick(e); drag = null; });
cv.addEventListener('mousemove', e => {
  if (drag) { const d = devicePixelRatio || 1, dx = e.clientX - drag.x, dy = e.clientY - drag.y; if (Math.hypot(dx, dy) > 3) drag.moved = true; if (drag.moved) { S.view.px = drag.px + dx * d; S.view.py = drag.py + dy * d; draw(); } }
  if (!S.frames.length) return; const r = cv.getBoundingClientRect(), d = devicePixelRatio || 1, p = toImg((e.clientX - r.left) * d, (e.clientY - r.top) * d), c = sky2px(p.x, p.y);
  $('#hud').textContent = `RA ${fmtRA(c.ra)}  Dec ${fmtDec(c.dec)}  (${c.ra.toFixed(5)}, ${c.dec.toFixed(5)})`; });
cv.addEventListener('wheel', e => { e.preventDefault(); S.view.z = Math.max(.5, Math.min(30, S.view.z * (e.deltaY < 0 ? 1.15 : 1 / 1.15))); draw(); }, { passive: false });
function centroid(p) { const f = S.frames[S.epoch], R = 6; let sx = 0, sy = 0, sw = 0, bg = pct(f.data, 20);
  for (let y = Math.round(p.y) - R; y <= Math.round(p.y) + R; y++) for (let x = Math.round(p.x) - R; x <= Math.round(p.x) + R; x++) {
    if (x < 0 || y < 0 || x >= f.w || y >= f.h) continue; const v = Math.max(0, f.data[y * f.w + x] - bg); sx += x * v; sy += y * v; sw += v; }
  return sw > 0 ? { x: sx / sw + .5, y: sy / sw + .5 } : p; }
function onClick(e) {
  const r = cv.getBoundingClientRect(), d = devicePixelRatio || 1, p = centroid(toImg((e.clientX - r.left) * d, (e.clientY - r.top) * d));
  if (S.pm.on) { const m = { ...p, ep: S.epoch };
    if (!S.pm.a || (S.pm.a && S.pm.b)) { S.pm.a = m; S.pm.b = null; $('#pmOut').textContent = `Point A set in "${S.frames[S.epoch].label}". Step to another epoch and click the source.`; }
    else { S.pm.b = m; const sc = scaleAS(), dpx = Math.hypot(m.x - S.pm.a.x, m.y - S.pm.a.y), dth = dpx * sc,
        dt = (S.frames[m.ep].mjd - S.frames[S.pm.a.ep].mjd) / 365.25, mu = dt ? Math.abs(dth * 1000 / dt) : NaN;
      $('#pmOut').innerHTML = `Δθ = <b>${dth.toFixed(2)}″</b> over ${dt.toFixed(2)} yr<br>μ = <b>${isFinite(mu) ? mu.toFixed(0) : '—'} mas/yr</b>`; }
    draw(); return; }
  S.sel = p; draw(); inspect(p);
}
async function inspect(p) {
  const c = sky2px(p.x, p.y); $('#hud').textContent = `Selected ${fmtRA(c.ra)} ${fmtDec(c.dec)}`;
  try { S.spec = await api('spectrum', { target: S.target?.id || '', ra: c.ra, dec: c.dec }); } catch { S.spec = null; }
  drawSpectrum(); drawLC(); drawMeta(); tab('spec');
}

/* ---------- playback ---------- */
function setEpoch(i) { const n = S.frames.length; S.epoch = (i + n) % n; $('#scrub').value = S.epoch; writeURL(); draw(); drawMeta(); }
function step(dir) { const n = S.frames.length; let nx = S.epoch + dir;
  if (S.pingpong) { if (nx >= n || nx < 0) { S.dir *= -1; nx = S.epoch + S.dir; } } setEpoch(nx); }
function play(on) { S.playing = on; $('#play').textContent = on ? '❚❚' : '▶'; clearInterval(S.timer);
  if (on) S.timer = setInterval(() => step(S.pingpong ? S.dir : 1), S.interval); }

/* ---------- charts (SVG, no dependency) ---------- */
function lineChart({ x, y, err, xlab, ylab, marks = [], bands = [], points = false, invertY = false, vlines = [] }) {
  const W = 900, H = 230, m = { l: 52, r: 14, t: 10, b: 34 }, xmin = Math.min(...x), xmax = Math.max(...x);
  let ymin = Math.min(...y.map((v, i) => v - (err?.[i] || 0))), ymax = Math.max(...y.map((v, i) => v + (err?.[i] || 0))); const pad = (ymax - ymin) * .08; ymin -= pad; ymax += pad;
  const X = v => m.l + (v - xmin) / (xmax - xmin) * (W - m.l - m.r), Y = v => { const t = (v - ymin) / (ymax - ymin); return invertY ? m.t + t * (H - m.t - m.b) : H - m.b - t * (H - m.t - m.b); };
  let s = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" font-family="system-ui" font-size="11">`;
  bands.forEach(b => s += `<rect x="${X(b.lo)}" y="${m.t}" width="${X(b.hi) - X(b.lo)}" height="${H - m.t - m.b}" fill="${b.c}" opacity=".07"/><text x="${(X(b.lo) + X(b.hi)) / 2}" y="${m.t + 10}" fill="#64748b" text-anchor="middle">${b.n}</text>`);
  for (let i = 0; i <= 5; i++) { const v = ymin + (ymax - ymin) * i / 5; s += `<line x1="${m.l}" x2="${W - m.r}" y1="${Y(v)}" y2="${Y(v)}" stroke="#1e293b"/><text x="${m.l - 6}" y="${Y(v) + 4}" fill="#94a3b8" text-anchor="end">${v.toFixed(2)}</text>`; }
  for (let i = 0; i <= 6; i++) { const v = xmin + (xmax - xmin) * i / 6; s += `<text x="${X(v)}" y="${H - 18}" fill="#94a3b8" text-anchor="middle">${v.toFixed(v > 1000 ? 0 : 2)}</text>`; }
  if (err) y.forEach((v, i) => s += `<line x1="${X(x[i])}" x2="${X(x[i])}" y1="${Y(v - err[i])}" y2="${Y(v + err[i])}" stroke="#38BDF8" opacity=".35"/>`);
  vlines.forEach(v => s += `<line x1="${X(v)}" x2="${X(v)}" y1="${m.t}" y2="${H - m.b}" stroke="#F59E0B" stroke-dasharray="3 3" opacity=".6"/>`);
  s += `<polyline fill="none" stroke="#38BDF8" stroke-width="1.8" points="${x.map((v, i) => X(v) + ',' + Y(y[i])).join(' ')}"/>`;
  if (points) x.forEach((v, i) => s += `<circle cx="${X(v)}" cy="${Y(y[i])}" r="4" fill="#F59E0B"/>`);
  marks.forEach(k => k.at.forEach(w => s += `<line x1="${X(w)}" x2="${X(w)}" y1="${m.t + 14}" y2="${H - m.b}" stroke="#F59E0B" stroke-dasharray="2 3" opacity=".7"/><text x="${X(w)}" y="${m.t + 24}" fill="#F59E0B" text-anchor="middle">${k.name}</text>`));
  s += `<text x="${W / 2}" y="${H - 3}" fill="#94a3b8" text-anchor="middle">${xlab}</text><text transform="rotate(-90)" x="${-H / 2}" y="12" fill="#94a3b8" text-anchor="middle">${ylab}</text></svg>`; return s;
}
const BCOL = ['#38BDF8', '#818cf8', '#34d399', '#F59E0B', '#f87171', '#e879f9'];
function drawSpectrum() { const el = $('#tab-spec'), sp = S.spec; if (!sp) { el.innerHTML = '<div class="hint">Click a source in the viewport to build its 102-band spectrum.</div>'; return; }
  el.innerHTML = lineChart({ x: sp.wavelength, y: sp.flux, err: sp.err, xlab: 'Wavelength (µm) — 102 SPHEREx channels', ylab: 'Relative flux (νFν)', marks: sp.molecules, bands: sp.arrays.map((a, i) => ({ lo: a.lo, hi: a.hi, n: a.id, c: BCOL[i] })) }); }
function photometry() { // aperture photometry at selected position across all frames
  if (!S.sel) return null; const R = 4, out = []; for (const f of S.frames) { let s = 0, n = 0, bg = pct(f.data, 30);
    for (let y = Math.round(S.sel.y) - R; y <= Math.round(S.sel.y) + R; y++) for (let x = Math.round(S.sel.x) - R; x <= Math.round(S.sel.x) + R; x++) if (x >= 0 && y >= 0 && x < f.w && y < f.h && Math.hypot(x - S.sel.x, y - S.sel.y) <= R) { s += f.data[y * f.w + x] - bg; n++; }
    out.push(s); } return out; }
async function drawLC() { const el = $('#tab-lc'), ph = photometry(); if (!ph) { el.innerHTML = '<div class="hint">Click a source to measure aperture photometry across all epochs.</div>'; return; }
  const mjd = S.frames.map(f => +f.mjd), mx = Math.max(...ph.map(Math.abs)) || 1;
  let html = lineChart({ x: mjd, y: ph.map(v => v / mx), xlab: 'MJD — aperture flux at selected position (normalised)', ylab: 'Flux', points: true, vlines: [mjd[S.epoch]] });
  if (S.target && !S.custom && (S.target.id === 'rw-aur' || S.target.id === 'r-dra')) { try { const lc = await api('lightcurve', { target: S.target.id });
    html += lineChart({ x: lc.mjd, y: lc.mag, xlab: 'MJD — long-term photometry (demo model)', ylab: 'Magnitude (brighter ↑)', invertY: true, vlines: lc.spherex }); } catch {} }
  el.innerHTML = html; }
function drawMeta() { const f = S.frames[S.epoch]; if (!f) return; const h = f.header || {};
  $('#tab-meta').innerHTML = `<table><tr><th>Keyword</th><th>Value</th></tr>${Object.entries(h).map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`).join('')}</table>
  <h4 style="color:#38BDF8;margin:10px 0 4px">Contamination FLAGS</h4>${(f.flags || []).length ? f.flags.map(x => `<span class="flag">⚠ ${x}</span>`).join('') : '<span class="ok">No contamination flags raised for this exposure.</span>'}`; }
function drawCat() { const c = S.cat, el = $('#tab-cat'); if (!c) return;
  const f = (window._cf || '').toLowerCase();
  const rows = c.gaia.filter(g => g.id.toLowerCase().includes(f)).map(g => `<tr><td>${g.id}</td><td>${g.gmag}</td><td>${g.plx}</td><td>${g.pmra}</td><td>${g.pmdec}</td><td>${(1000 / Math.max(g.plx, .01)).toFixed(0)} pc</td></tr>`).join('');
  const irsa = `https://irsa.ipac.caltech.edu/applications/finderchart/?locstr=${S.ra}+${S.dec}`, fire = `https://irsa.ipac.caltech.edu/applications/spherex/?__action=table.search&request={}`;
  el.innerHTML = `<div class="row" style="margin-bottom:6px"><input id="cf" placeholder="Filter objects…" value="${window._cf || ''}"><span><a target="_blank" rel="noopener" href="${irsa}">IRSA Finder Chart ↗</a> · <a target="_blank" rel="noopener" href="https://irsa.ipac.caltech.edu/applications/spherex/">SPHEREx / Firefly ↗</a></span></div>
  <table><tr><th>Gaia DR3 object</th><th>G mag</th><th>ϖ (mas)</th><th>μα* (mas/yr)</th><th>μδ (mas/yr)</th><th>Distance</th></tr>${rows}</table>
  <table style="margin-top:10px"><tr><th>Epoch</th><th>Mission</th><th>UTC</th><th>MJD</th><th>Source FITS</th></tr>${S.frames.map(fr => `<tr><td>${fr.label}</td><td>${fr.source}</td><td>${fr.utc}</td><td>${(+fr.mjd).toFixed(1)}</td><td>${fr.source === 'SPHEREx' ? '<a target="_blank" rel="noopener" href="https://irsa.ipac.caltech.edu/applications/spherex/">IRSA ↗</a>' : fr.source === 'NEOSSat' ? '<a target="_blank" rel="noopener" href="https://www.cadc-ccda.hia-iha.nrc-cnrc.gc.ca/en/neossat/">CADC ↗</a>' : fr.source === 'WISE' ? '<a target="_blank" rel="noopener" href="https://irsa.ipac.caltech.edu/Missions/wise.html">IRSA ↗</a>' : '—'}</td></tr>`).join('')}</table>`;
  $('#cf').oninput = e => { window._cf = e.target.value; const p = e.target.selectionStart; drawCat(); $('#cf').focus(); $('#cf').setSelectionRange(p, p); }; }
function tab(t) { document.querySelectorAll('#tabs button').forEach(b => b.classList.toggle('on', b.dataset.t === t)); ['spec', 'lc', 'meta', 'cat'].forEach(k => $('#tab-' + k).hidden = k !== t); }

/* ---------- data loading ---------- */
async function load() {
  $('#modeBadge').textContent = 'loading…';
  try {
    const d = await api('cutouts', { ra: S.ra, dec: S.dec, fov: S.fov, band: S.band, size: 128 });
    S.frames = d.frames.map(f => ({ label: f.epoch.label, source: f.source, mjd: f.epoch.mjd, utc: f.epoch.utc, w: d.size, h: d.size, data: Float32Array.from(f.data), flags: f.flags, header: f.header }));
    S.target = d.target; S.custom = false; $('#modeBadge').textContent = d.mode === 'demo' ? 'DEMO DATA (offline engine)' : 'LIVE IRSA'; $('#modeBadge').className = 'badge ' + (d.mode === 'demo' ? 'demo' : '');
    S.cat = await api('catalogs', { ra: S.ra, dec: S.dec, fov: S.fov });
  } catch (e) { $('#modeBadge').textContent = 'backend unreachable'; toast('Backend unreachable — start backend/app.py'); return; }
  afterLoad();
}
function afterLoad() { S.epoch = Math.min(S.epoch, S.frames.length - 1); S.sel = null; S.pm.a = S.pm.b = null; S.view = { z: 1, px: 0, py: 0 };
  $('#scrub').max = S.frames.length - 1; $('#scrub').value = S.epoch;
  $('#refEp').innerHTML = S.frames.map((f, i) => `<option value="${i}">${f.label}</option>`).join(''); $('#refEp').value = S.ref = 0;
  $('#xfer').textContent = `≈ ${(S.frames.length * S.frames[0].w * S.frames[0].h * 4 / 1024).toFixed(0)} kB cutouts · ${(S.fov * 60 / S.frames[0].w).toFixed(2)}″/px`;
  $('#q').value = `${S.ra.toFixed(5)}, ${S.dec.toFixed(5)}`; drawSpectrum(); drawLC(); drawMeta(); drawCat(); writeURL(); fit(); }
function goTo(ra, dec) { S.ra = ra; S.dec = dec; document.querySelectorAll('.pill').forEach(p => p.classList.remove('on')); return load(); }
async function goTarget(id) { const t = (await api('targets')).find(x => x.id === id); S.ra = t.ra; S.dec = t.dec; S.fov = id === 'barnards-star' ? 30 : id === 'wise-0855' ? 5 : 5;
  document.querySelectorAll('.pill').forEach(p => p.classList.toggle('on', p.dataset.id === id)); syncUI(); await load(); toast(t.note); }

/* ---------- uploads ---------- */
const UP = [];
function parseFITS(buf) { const dv = new DataView(buf), dec = new TextDecoder(); let off = 0;
  while (off < buf.byteLength) { const hdr = {}; let end = false; while (!end && off < buf.byteLength) { const blk = dec.decode(new Uint8Array(buf, off, 2880)); off += 2880;
      for (let i = 0; i < 36; i++) { const c = blk.substr(i * 80, 80); const k = c.slice(0, 8).trim(); if (k === 'END') { end = true; break; } if (c[8] === '=') hdr[k] = c.slice(10).split('/')[0].trim().replace(/^'|'$/g, '').trim(); } }
    const nax = +hdr.NAXIS || 0, bp = +hdr.BITPIX, w = +hdr.NAXIS1, h = +hdr.NAXIS2, bytes = Math.abs(bp) / 8; let n = 1; for (let i = 1; i <= nax; i++) n *= +hdr['NAXIS' + i];
    const size = nax ? n * bytes : 0;
    if (nax >= 2 && w && h) { const out = new Float32Array(w * h), bz = +hdr.BZERO || 0, bs = hdr.BSCALE ? +hdr.BSCALE : 1;
      for (let i = 0; i < w * h; i++) { const o = off + i * bytes; let v = bp === 16 ? dv.getInt16(o) : bp === 32 ? dv.getInt32(o) : bp === -32 ? dv.getFloat32(o) : bp === -64 ? dv.getFloat64(o) : bp === 8 ? dv.getUint8(o) : 0; out[i] = (isFinite(v) ? v : 0) * bs + bz; }
      const flip = new Float32Array(w * h); for (let y = 0; y < h; y++) flip.set(out.subarray(y * w, (y + 1) * w), (h - 1 - y) * w); // FITS origin bottom-left
      return { w, h, data: flip, header: hdr }; }
    off += Math.ceil(size / 2880) * 2880; }
  throw new Error('No 2-D image HDU found'); }
async function readImage(file) { const ext = file.name.split('.').pop().toLowerCase();
  if (['fits', 'fit', 'fts'].includes(ext)) return parseFITS(await file.arrayBuffer());
  if (['tif', 'tiff'].includes(ext)) throw new Error('TIFF not supported in-browser — export as PNG');
  const bm = await createImageBitmap(file), c = document.createElement('canvas'); c.width = bm.width; c.height = bm.height; const x = c.getContext('2d'); x.drawImage(bm, 0, 0);
  const id = x.getImageData(0, 0, c.width, c.height).data, g = new Float32Array(c.width * c.height); for (let i = 0; i < g.length; i++) g[i] = (id[i * 4] * .3 + id[i * 4 + 1] * .59 + id[i * 4 + 2] * .11) / 255;
  return { w: c.width, h: c.height, data: g, header: { NAME: file.name } }; }
async function addFiles(list) { for (const f of list) { try { const im = await readImage(f); UP.push({ name: f.name, ...im, label: f.name.replace(/\.[^.]+$/, ''), date: new Date(Date.now() - (5 - UP.length) * 864e5 * 90).toISOString().slice(0, 10), dx: 0, dy: 0, rot: 0 }); } catch (e) { toast(f.name + ': ' + e.message); } } renderUp(); }
function thumb(c, u) { const n = norm2(u.data); c.width = u.w; c.height = u.h; const x = c.getContext('2d'), im = x.createImageData(u.w, u.h); for (let i = 0; i < n.length; i++) im.data.set([n[i], n[i], n[i], 255], i * 4); x.putImageData(im, 0, 0); }
function norm2(a) { const lo = pct(a, 1), hi = pct(a, 99.5), d = (hi - lo) || 1; return Uint8ClampedArray.from(a, v => Math.asinh(10 * Math.max(0, Math.min(1, (v - lo) / d))) / Math.asinh(10) * 255); }
function renderUp() { const L = $('#upList'); L.innerHTML = UP.map((u, i) => `<div class="up"><canvas data-i="${i}"></canvas><div><b>${u.name}</b> <span class="hint">${u.w}×${u.h}</span> <button class="btn" data-rm="${i}">remove</button>
  <div class="f"><label>Label <input data-k="label" data-i="${i}" value="${u.label}"></label><label>Date <input type="date" data-k="date" data-i="${i}" value="${u.date}"></label></div>
  <div class="f"><label>X <input type="number" data-k="dx" data-i="${i}" value="${u.dx}"></label><label>Y <input type="number" data-k="dy" data-i="${i}" value="${u.dy}"></label><label>Rot° <input type="number" step="0.1" data-k="rot" data-i="${i}" value="${u.rot}"></label></div></div></div>`).join('') || '<div class="hint">No images yet.</div>';
  L.querySelectorAll('canvas').forEach(c => thumb(c, UP[+c.dataset.i]));
  L.querySelectorAll('input').forEach(el => el.oninput = () => { const u = UP[+el.dataset.i], k = el.dataset.k; u[k] = ['dx', 'dy', 'rot'].includes(k) ? +el.value : el.value; });
  L.querySelectorAll('[data-rm]').forEach(b => b.onclick = () => { UP.splice(+b.dataset.rm, 1); renderUp(); }); }
function applyUploads() { if (UP.length < 2) return toast('Add at least 2 images'); const sorted = [...UP].sort((a, b) => a.date.localeCompare(b.date)), W = Math.min(256, sorted[0].w), H = Math.round(W * sorted[0].h / sorted[0].w);
  S.frames = sorted.map(u => { const src = document.createElement('canvas'); src.width = u.w; src.height = u.h; const sx = src.getContext('2d'), im = sx.createImageData(u.w, u.h);
    const lo = pct(u.data, .5), hi = pct(u.data, 99.9), d = (hi - lo) || 1; for (let i = 0; i < u.data.length; i++) { const v = Math.max(0, (u.data[i] - lo) / d) * 255; im.data.set([v, v, v, 255], i * 4); } sx.putImageData(im, 0, 0);
    const dst = document.createElement('canvas'); dst.width = W; dst.height = H; const dx = dst.getContext('2d'); dx.fillStyle = '#000'; dx.fillRect(0, 0, W, H); dx.translate(W / 2 + u.dx * W / u.w, H / 2 + u.dy * W / u.w); dx.rotate(u.rot * Math.PI / 180); dx.drawImage(src, -W / 2, -H / 2, W, H);
    const px = dx.getImageData(0, 0, W, H).data, g = new Float32Array(W * H); for (let i = 0; i < g.length; i++) g[i] = px[i * 4] / 255;
    const mjd = new Date(u.date).getTime() / 864e5 + 40587; return { label: u.label, source: 'USER', mjd, utc: u.date, w: W, h: H, data: g, flags: [], header: { ...u.header, ORIGIN: 'user upload', FILE: u.name, ALIGN: `dx=${u.dx} dy=${u.dy} rot=${u.rot}` } }; });
  S.custom = true; S.target = null; S.cat = { gaia: [], wise: [], neossat: [] }; $('#modeBadge').textContent = 'CUSTOM UPLOADS'; $('#modeBadge').className = 'badge demo'; $('#modal').hidden = true; S.epoch = 0; afterLoad(); toast(`${S.frames.length} custom epochs loaded`); }

/* ---------- UI wiring ---------- */
function syncUI() { $('#band').value = S.band; $('#stretch').value = S.stretch; $('#cmap').value = S.cmap; $('#blk').value = S.blk; $('#wht').value = S.wht; $('#blkO').textContent = S.blk + '%'; $('#whtO').textContent = S.wht + '%';
  document.querySelectorAll('#fovSeg button').forEach(b => b.classList.toggle('on', +b.dataset.f === S.fov)); document.querySelectorAll('#modeSeg button').forEach(b => b.classList.toggle('on', b.dataset.m === S.mode)); $('#speedO').textContent = S.interval + 'ms'; }
function init() {
  readURL();
  $('#pills').innerHTML = TARGETS.map(([id, n]) => `<button class="pill" data-id="${id}">${n}</button>`).join(''); $('#pills').onclick = e => e.target.dataset.id && goTarget(e.target.dataset.id);
  $('#fovSeg').innerHTML = FOVS.map(f => `<button data-f="${f}">${f}′</button>`).join(''); $('#fovSeg').onclick = e => { if (e.target.dataset.f) { S.fov = +e.target.dataset.f; syncUI(); S.custom ? draw() : load(); } };
  $('#modeSeg').onclick = e => { if (e.target.dataset.m) { S.mode = e.target.dataset.m; syncUI(); writeURL(); draw(); } };
  $('#band').onchange = e => { S.band = e.target.value; if (!S.custom) load(); }; $('#refEp').onchange = e => { S.ref = +e.target.value; draw(); };
  $('#stretch').onchange = e => { S.stretch = e.target.value; writeURL(); draw(); }; $('#cmap').onchange = e => { S.cmap = e.target.value; writeURL(); draw(); };
  $('#blk').oninput = e => { S.blk = +e.target.value; $('#blkO').textContent = S.blk + '%'; draw(); }; $('#wht').oninput = e => { S.wht = +e.target.value; $('#whtO').textContent = S.wht + '%'; draw(); };
  ['ovGaia', 'ovWise', 'ovNeo', 'ovGrid'].forEach(id => $('#' + id).onchange = draw);
  $('#pmTool').onclick = () => { S.pm.on = !S.pm.on; $('#pmTool').classList.toggle('on', S.pm.on); S.pm.a = S.pm.b = null; $('#pmOut').textContent = S.pm.on ? 'Click the source in this epoch (A).' : 'Tool off.'; draw(); };
  $('#play').onclick = () => play(!S.playing); $('#prev').onclick = () => { play(false); step(-1); }; $('#next').onclick = () => { play(false); step(1); };
  $('#scrub').oninput = e => setEpoch(+e.target.value); $('#speed').oninput = e => { S.interval = +e.target.value; $('#speedO').textContent = S.interval + 'ms'; if (S.playing) play(true); };
  $('#pingpong').onclick = () => { S.pingpong = !S.pingpong; $('#pingpong').textContent = S.pingpong ? 'Ping-pong' : 'Loop'; };
  $('#tabs').onclick = e => e.target.dataset.t && tab(e.target.dataset.t);
  $('#searchForm').onsubmit = async e => { e.preventDefault(); const v = $('#q').value, c = parseCoord(v); if (c) return goTo(c.ra, c.dec);
    try { const r = await api('resolve', { q: v }); if (r.id) return goTarget(r.id); goTo(r.ra, r.dec); } catch { toast('Could not resolve "' + v + '"'); } };
  $('#shareBtn').onclick = () => { writeURL(); navigator.clipboard?.writeText(location.href).then(() => toast('URL copied'), () => toast(location.href)); };
  $('#uploadBtn').onclick = () => { $('#modal').hidden = false; renderUp(); }; $('#closeModal').onclick = () => $('#modal').hidden = true; $('#applyUp').onclick = applyUploads;
  $('#files').onchange = e => addFiles(e.target.files); const dz = $('#drop'); ['dragover', 'dragenter'].forEach(ev => dz.addEventListener(ev, e => { e.preventDefault(); dz.classList.add('hot'); }));
  ['dragleave', 'drop'].forEach(ev => dz.addEventListener(ev, e => { e.preventDefault(); dz.classList.remove('hot'); })); dz.addEventListener('drop', e => addFiles(e.dataTransfer.files));
  addEventListener('keydown', e => { if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return; if (e.key === 'ArrowRight') $('#next').click(); if (e.key === 'ArrowLeft') $('#prev').click(); if (e.key === ' ') { e.preventDefault(); $('#play').click(); } });
  addEventListener('resize', fit); syncUI(); load();
}
init();
})();
