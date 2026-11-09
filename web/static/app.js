'use strict';

/* ------------------------------------------------------------------ 配置 */
const METHODS = [
  { id: 'telea', name: 'Telea', tag: '快速行进',
    param: { key: 'radius', min: 1, max: 20, def: 3, hint: 'r' } },
  { id: 'ns', name: 'Navier-Stokes', tag: 'PDE 扩散',
    param: { key: 'radius', min: 1, max: 20, def: 3, hint: 'r' } },
  { id: 'biharmonic', name: 'Biharmonic', tag: '双调和', param: null },
  { id: 'patchmatch', name: 'PatchMatch', tag: '样本块',
    param: { key: 'patch_size', min: 1, max: 15, def: 5, hint: 'ps' } },
  { id: 'auto', name: 'Auto', tag: '规则选路', param: null },
];
const DEFAULT_ON = ['telea', 'ns', 'auto', 'patchmatch'];

const $ = (id) => document.getElementById(id);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

/* ------------------------------------------------------------------ 状态 */
const S = {
  id: null, name: '', img: null, W: 0, H: 0,
  box: null,                       // {x,y,w,h} 图像坐标
  view: { s: 1, ox: 0, oy: 0 },
  active: 'telea',
  enabled: new Set(DEFAULT_ON),
  params: { telea: { radius: 3 }, ns: { radius: 3 }, patchmatch: { patch_size: 5 } },
  results: {},                     // id -> {name,ms,rect,img,maskImg,note}
  seq: {},
  loading: 0,
  showMask: false,
  showBox: true,       // 是否绘制 bbox 框线 / 手柄
  peek: false,
  avail: {},
  live: true,          // true=实时计算，false=手动（点「计算」才跑）
  compare: false,      // true=左原图 / 右结果
  split: 0.5,          // 对比分割线位置 0~1
};

const M = { open: false, id: null, scale: 1, tx: 0, ty: 0, drag: null };
let raf = 0;
let autoInspect = false;
let inspectZoom = 0;
let debounce = null;
const cv = $('cv');
const ctx = cv.getContext('2d');

/* ------------------------------------------------------------------ 工具 */
function loadImage(src) {
  return new Promise((res, rej) => {
    const im = new Image();
    im.onload = () => res(im);
    im.onerror = () => rej(new Error('图片解码失败'));
    im.src = src;
  });
}

function requestDraw() {
  if (raf) return;
  raf = requestAnimationFrame(() => { raf = 0; render(); });
}

function dpr() { return Math.min(2, window.devicePixelRatio || 1); }

function setShowBox(on) {
  S.showBox = on;
  const cb = $('show-box');
  if (cb) cb.checked = on;
  savePrefs();
  requestDraw();
  if (M.open) drawModal();
  updateStatus();
}

function savePrefs() {
  try {
    localStorage.setItem('studio.prefs', JSON.stringify({
      live: S.live, compare: S.compare, split: S.split, showBox: S.showBox,
    }));
  } catch (_) { /* 隐私模式忽略 */ }
}

function loadPrefs() {
  try {
    const p = JSON.parse(localStorage.getItem('studio.prefs') || '{}');
    if (p.live === false) S.live = false;
    if (p.compare === true) S.compare = true;
    if (typeof p.split === 'number') S.split = Math.min(0.96, Math.max(0.04, p.split));
    if (p.showBox === false) S.showBox = false;
  } catch (_) { /* 忽略 */ }
}

/* ------------------------------------------------------------------ 渲染 */
function render() {
  const stage = $('stage');
  const cw = stage.clientWidth, ch = stage.clientHeight;
  const d = dpr();
  if (!cw || !ch) return;
  if (cv.width !== Math.round(cw * d) || cv.height !== Math.round(ch * d)) {
    cv.width = Math.round(cw * d);
    cv.height = Math.round(ch * d);
  }
  ctx.setTransform(d, 0, 0, d, 0, 0);
  ctx.clearRect(0, 0, cw, ch);
  if (!S.img) return;

  const s = Math.min(cw / S.W, ch / S.H);
  const ox = (cw - S.W * s) / 2;
  const oy = (ch - S.H * s) / 2;
  S.view = { s, ox, oy };

  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(S.img, ox, oy, S.W * s, S.H * s);

  const res = S.results[S.active];
  const showRes = res && !S.peek;
  if (showRes) {
    const [x0, y0, x1, y1] = res.rect;
    const dx = ox + x0 * s, dy = oy + y0 * s;
    const dw = (x1 - x0) * s, dh = (y1 - y0) * s;
    if (S.compare) {
      // 左原图 / 右结果：结果只画在分割线右侧
      const sx = Math.round(cw * S.split);
      ctx.save();
      ctx.beginPath();
      ctx.rect(sx, 0, cw - sx, ch);
      ctx.clip();
      ctx.drawImage(res.img, dx, dy, dw, dh);
      ctx.restore();
    } else {
      ctx.drawImage(res.img, dx, dy, dw, dh);
      if (S.showMask && res.maskImg) {
        ctx.globalAlpha = 0.8;
        ctx.drawImage(res.maskImg, dx, dy, dw, dh);
        ctx.globalAlpha = 1;
      }
    }
  }
  if (S.compare && showRes) drawSplit(ctx, cw, ch);
  if (S.showBox && S.box && S.box.w > 0 && S.box.h > 0) drawBox(ctx, S.box, S.view);
}

function drawSplit(c, cw, ch) {
  const x = Math.round(cw * S.split);
  c.save();
  c.strokeStyle = 'rgba(255,255,255,.8)';
  c.lineWidth = 1.5;
  c.beginPath();
  c.moveTo(x + 0.5, 0);
  c.lineTo(x + 0.5, ch);
  c.stroke();

  // 中间把手
  c.fillStyle = 'rgba(12,16,24,.92)';
  c.strokeStyle = 'rgba(255,255,255,.45)';
  c.lineWidth = 1;
  c.beginPath();
  if (c.roundRect) c.roundRect(x - 13, ch / 2 - 24, 26, 48, 9);
  else c.rect(x - 13, ch / 2 - 24, 26, 48);
  c.fill();
  c.stroke();
  c.fillStyle = '#d7e2f5';
  c.font = '13px -apple-system, sans-serif';
  c.textAlign = 'center';
  c.fillText('‹', x, ch / 2 - 4);
  c.fillText('›', x, ch / 2 + 15);

  // 两侧标签（深色药丸底，亮背景也看得清）
  c.font = '11.5px -apple-system, "PingFang SC", sans-serif';
  c.textBaseline = 'middle';
  const chip = (text, cx, align) => {
    const w = c.measureText(text).width + 16;
    const left = align === 'right' ? cx - w : cx;
    c.fillStyle = 'rgba(10,13,19,.82)';
    c.beginPath();
    if (c.roundRect) c.roundRect(left, 8, w, 22, 7);
    else c.rect(left, 8, w, 22);
    c.fill();
    c.fillStyle = 'rgba(226,232,242,.95)';
    c.textAlign = align;
    c.fillText(text, align === 'right' ? cx - 8 : cx + 8, 20);
  };
  chip('原图', x - 12, 'right');
  chip('结果', x + 12, 'left');
  c.restore();
}

function drawBox(c, b, v) {
  const x = v.ox + b.x * v.s, y = v.oy + b.y * v.s;
  const w = b.w * v.s, h = b.h * v.s;
  c.save();
  c.lineWidth = 1.5;
  c.strokeStyle = '#4f8cff';
  c.strokeRect(x + 0.5, y + 0.5, w, h);
  c.setLineDash([5, 4]);
  c.strokeStyle = 'rgba(79,140,255,.42)';
  c.strokeRect(x - 3.5, y - 3.5, w + 7, h + 7);
  c.setLineDash([]);

  c.fillStyle = '#4f8cff';
  c.strokeStyle = 'rgba(6,8,12,.9)';
  c.lineWidth = 1.5;
  for (const [hx, hy] of [[x, y], [x + w, y], [x, y + h], [x + w, y + h]]) {
    c.beginPath();
    c.rect(hx - 4, hy - 4, 8, 8);
    c.fill();
    c.stroke();
  }

  const label = `${Math.round(b.w)} × ${Math.round(b.h)}`;
  c.font = '11px -apple-system, "PingFang SC", sans-serif';
  const tw = c.measureText(label).width + 12;
  const ly = y - 22 < 2 ? y + h + 6 : y - 22;
  c.fillStyle = 'rgba(12,16,24,.88)';
  c.beginPath();
  if (c.roundRect) c.roundRect(x, ly, tw, 17, 5); else c.rect(x, ly, tw, 17);
  c.fill();
  c.fillStyle = '#cdd8ee';
  c.fillText(label, x + 6, ly + 12.5);
  c.restore();
}

/* ------------------------------------------------------------------ 指针 */
function toImg(e) {
  const r = cv.getBoundingClientRect();
  const v = S.view;
  return {
    x: clamp((e.clientX - r.left - v.ox) / v.s, 0, S.W),
    y: clamp((e.clientY - r.top - v.oy) / v.s, 0, S.H),
  };
}

function hitTest(p) {
  const b = S.box;
  if (!b) return null;
  const tol = 10 / S.view.s;
  const corners = {
    nw: [b.x, b.y], ne: [b.x + b.w, b.y],
    sw: [b.x, b.y + b.h], se: [b.x + b.w, b.y + b.h],
  };
  for (const [k, [cx, cy]] of Object.entries(corners)) {
    if (Math.abs(p.x - cx) <= tol && Math.abs(p.y - cy) <= tol) return k;
  }
  if (p.x > b.x && p.x < b.x + b.w && p.y > b.y && p.y < b.y + b.h) return 'move';
  return null;
}

let drag = null;

cv.addEventListener('pointerdown', (e) => {
  if (!S.img) return;
  // 对比模式下先判分割线
  if (S.compare && S.results[S.active]) {
    const r = cv.getBoundingClientRect();
    if (Math.abs(e.clientX - r.left - S.split * r.width) < 14) {
      cv.setPointerCapture(e.pointerId);
      drag = { mode: 'split' };
      cv.style.cursor = 'col-resize';
      return;
    }
  }
  cv.setPointerCapture(e.pointerId);
  const p = toImg(e);
  const hit = hitTest(p);
  if (hit && hit !== 'move') {
    drag = { mode: hit, start: p, orig: { ...S.box } };
  } else if (hit === 'move') {
    drag = { mode: 'move', start: p, orig: { ...S.box } };
  } else {
    drag = { mode: 'new', start: p };
    S.box = { x: p.x, y: p.y, w: 0, h: 0 };
  }
  requestDraw();
});

cv.addEventListener('pointermove', (e) => {
  if (!S.img) return;
  if (drag && drag.mode === 'split') {
    const r = cv.getBoundingClientRect();
    S.split = clamp((e.clientX - r.left) / r.width, 0.04, 0.96);
    requestDraw();
    return;
  }
  const p = toImg(e);
  if (!drag) {
    if (S.compare && S.results[S.active]) {
      const r = cv.getBoundingClientRect();
      if (Math.abs(e.clientX - r.left - S.split * r.width) < 14) {
        cv.style.cursor = 'col-resize';
        return;
      }
    }
    const hit = hitTest(p);
    cv.style.cursor = hit === 'move' ? 'move'
      : hit ? (hit === 'nw' || hit === 'se' ? 'nwse-resize' : 'nesw-resize')
      : 'crosshair';
    return;
  }
  const st = drag.start;
  if (drag.mode === 'new') {
    S.box = {
      x: Math.min(st.x, p.x), y: Math.min(st.y, p.y),
      w: Math.abs(p.x - st.x), h: Math.abs(p.y - st.y),
    };
  } else if (drag.mode === 'move') {
    const b = drag.orig;
    S.box = {
      x: clamp(b.x + (p.x - st.x), 0, S.W - b.w),
      y: clamp(b.y + (p.y - st.y), 0, S.H - b.h),
      w: b.w, h: b.h,
    };
  } else {
    const b = drag.orig;
    let x1 = b.x, y1 = b.y, x2 = b.x + b.w, y2 = b.y + b.h;
    if (drag.mode.includes('w')) x1 = clamp(p.x, 0, x2 - 3);
    if (drag.mode.includes('e')) x2 = clamp(p.x, x1 + 3, S.W);
    if (drag.mode.includes('n')) y1 = clamp(p.y, 0, y2 - 3);
    if (drag.mode.includes('s')) y2 = clamp(p.y, y1 + 3, S.H);
    S.box = { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
  }
  requestDraw();
});

function endDrag() {
  if (!drag) return;
  if (drag.mode === 'split') {
    drag = null;
    cv.style.cursor = '';
    savePrefs();
    return;
  }
  drag = null;
  if (S.box && S.box.w >= 3 && S.box.h >= 3) {
    S.box = {
      x: Math.round(S.box.x), y: Math.round(S.box.y),
      w: Math.round(S.box.w), h: Math.round(S.box.h),
    };
    schedule();
  } else {
    S.box = null;
    requestDraw();
  }
}
cv.addEventListener('pointerup', endDrag);
cv.addEventListener('pointercancel', endDrag);

/* ------------------------------------------------------------------ 请求 */
function paramsFor(id) {
  const m = METHODS.find((x) => x.id === id);
  if (!m || !m.param) return {};
  const v = S.params[id] || {};
  return { [m.param.key]: Number(v[m.param.key] ?? m.param.def) };
}

function schedule() {
  clearTimeout(debounce);
  cancelAll();
  S.results = {};
  for (const id of S.enabled) clearCard(id);
  updateStatus();
  if (!S.live) return;                  // 手动模式：等用户点「计算」
  debounce = setTimeout(runAll, 90);
}

function runNow() {
  if (!S.box) return;
  clearTimeout(debounce);
  cancelAll();
  S.results = {};
  for (const id of S.enabled) clearCard(id);
  updateStatus();
  runAll();
}

function clearCard(id) {
  const card = document.querySelector(`.card[data-id="${id}"]`);
  if (!card) return;
  const ms = card.querySelector('.ms');
  ms.textContent = '…';
  ms.className = 'ms';
  const foot = card.querySelector('.card-foot');
  foot.className = 'card-foot';
  foot.textContent = S.avail[id] === false ? '未安装，已跳过'
    : (S.live ? '计算中…' : '待计算 · 点「计算」');
  const c = card.querySelector('canvas');
  const g = c.getContext('2d');
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.clearRect(0, 0, c.width, c.height);
  card.classList.add('empty');
}

function runAll() {
  for (const id of S.enabled) {
    if (S.avail[id] === false) continue;
    runMethod(id);
  }
}

async function runMethod(id) {
  if (!S.id || !S.box) return;
  const my = (S.seq[id] = (S.seq[id] || 0) + 1);
  setPending(id, true);
  const body = {
    id: S.id,
    bbox: [S.box.x, S.box.y, S.box.w, S.box.h],
    method: id,
    dilate: Number($('dilate').value),
    feather: Number($('feather').value),
    margin: Number($('margin').value),
    mask_mode: $('mask-mode').value,
    params: paramsFor(id),
  };
  try {
    const r = await fetch('/api/inpaint', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const d = await r.json();
    if (my !== S.seq[id]) return;                 // 过期结果，丢弃
    if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
    const [img, maskImg] = await Promise.all([
      loadImage(d.png),
      d.mask_png ? loadImage(d.mask_png) : Promise.resolve(null),
    ]);
    S.results[id] = { name: d.method, ms: d.ms, rect: d.rect, img, maskImg, note: d.note };
    setPending(id, false);
    drawCard(id);
    if (S.active === id) requestDraw();
    updateStatus();
    if (autoInspect && S.results[S.active]) { autoInspect = false; openModal(S.active); }
  } catch (err) {
    if (my !== S.seq[id]) return;
    failCard(id, err.message);
  }
}

/* ------------------------------------------------------------------ 卡片 */
function setPending(id, on) {
  const card = document.querySelector(`.card[data-id="${id}"]`);
  if (!card) return;
  const ms = card.querySelector('.ms');
  if (on) {
    ms.textContent = '…';
    ms.className = 'ms';
    card.classList.add('empty');
  }
  card.classList.remove('err');
}

function failCard(id, msg) {
  const card = document.querySelector(`.card[data-id="${id}"]`);
  if (!card) return;
  card.classList.remove('empty');
  card.querySelector('.ms').textContent = 'ERR';
  const foot = card.querySelector('.card-foot');
  foot.textContent = msg;
  foot.className = 'card-foot warn';
}

function fmtMs(ms) {
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${ms.toFixed(1)} ms`;
}

function updateCards() {
  const wrap = $('results');
  const on = METHODS.filter((m) => S.enabled.has(m.id));
  const ids = on.map((m) => m.id).join(',');
  if (wrap.dataset.sig !== ids) {
    wrap.dataset.sig = ids;
    wrap.innerHTML = '';
    if (!on.length) {
      wrap.innerHTML = '<div class="hintcard">左侧勾选至少一种方法</div>';
      return;
    }
    for (const m of on) {
      const card = document.createElement('div');
      card.className = 'card empty';
      card.dataset.id = m.id;
      card.innerHTML = `<div class="card-head"><span class="n">${m.name}</span>
          <span class="ms">—</span></div><canvas></canvas>
        <div class="card-foot">${S.avail[m.id] === false ? '未安装，已跳过' : '等待框选…'}</div>`;
      card.addEventListener('click', () => {
        S.active = m.id;
        markActive();
        requestDraw();
      });
      card.addEventListener('dblclick', () => openModal(m.id));
      wrap.appendChild(card);
    }
  }
  markActive();
  for (const m of on) {
    if (S.results[m.id]) drawCard(m.id);
    else if (!S.box) resetCard(m.id);
  }
}

function resetCard(id) {
  const card = document.querySelector(`.card[data-id="${id}"]`);
  if (!card) return;
  card.querySelector('.ms').textContent = '—';
  card.querySelector('.card-foot').textContent = S.avail[id] === false ? '未安装，已跳过' : '等待框选…';
  card.querySelector('.card-foot').className = 'card-foot';
  const c = card.querySelector('canvas');
  const g = c.getContext('2d');
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.clearRect(0, 0, c.width, c.height);
}

function markActive() {
  for (const card of document.querySelectorAll('.card')) {
    card.classList.toggle('active', card.dataset.id === S.active);
  }
}

function drawCard(id) {
  const card = document.querySelector(`.card[data-id="${id}"]`);
  const res = S.results[id];
  if (!card || !res) return;
  const c = card.querySelector('canvas');
  const d = dpr();
  const w = c.clientWidth, h = c.clientHeight;
  if (!w || !h) return;
  if (c.width !== Math.round(w * d) || c.height !== Math.round(h * d)) {
    c.width = Math.round(w * d);
    c.height = Math.round(h * d);
  }
  const g = c.getContext('2d');
  g.setTransform(d, 0, 0, d, 0, 0);
  g.clearRect(0, 0, w, h);

  const [x0, y0, x1, y1] = res.rect;
  const b = S.box;
  const pad = Math.max(12, Math.round(Math.min(b.w, b.h) * 0.22));
  const cx0 = Math.max(x0, b.x - pad), cy0 = Math.max(y0, b.y - pad);
  const cx1 = Math.min(x1, b.x + b.w + pad), cy1 = Math.min(y1, b.y + b.h + pad);
  const cw = cx1 - cx0, ch = cy1 - cy0;
  if (cw <= 0 || ch <= 0) return;

  const k = Math.min(w / cw, h / ch);
  const dw = cw * k, dh = ch * k;
  const dx = (w - dw) / 2, dy = (h - dh) / 2;
  g.imageSmoothingEnabled = k < 1.6;
  g.drawImage(res.img, cx0 - x0, cy0 - y0, cw, ch, dx, dy, dw, dh);

  // 标出 bbox 位置
  g.strokeStyle = 'rgba(79,140,255,.9)';
  g.lineWidth = 1;
  g.setLineDash([4, 3]);
  g.strokeRect(dx + (b.x - cx0) * k + 0.5, dy + (b.y - cy0) * k + 0.5, b.w * k, b.h * k);
  g.setLineDash([]);

  card.classList.remove('empty');
  const ms = card.querySelector('.ms');
  ms.textContent = fmtMs(res.ms);
  ms.className = 'ms' + (res.ms < 60 ? ' fast' : res.ms > 800 ? ' slow' : '');
  const foot = card.querySelector('.card-foot');
  foot.className = 'card-foot';
  foot.textContent = res.note ? res.note
    : (id === 'auto' ? `→ ${res.name} · 改动区 ${res.rect[2] - res.rect[0]}×${res.rect[3] - res.rect[1]}`
      : `改动区 ${res.rect[2] - res.rect[0]}×${res.rect[3] - res.rect[1]}`);
}

function updateStatus() {
  const el = $('status');
  if (!S.box) { el.textContent = ''; return; }
  const res = S.results[S.active];
  const b = S.box;
  el.innerHTML = `框 <b>${Math.round(b.w)}×${Math.round(b.h)}</b>`
    + (res ? ` · ${res.name} <b>${fmtMs(res.ms)}</b>`
      : (S.live ? ' · 计算中…' : ' · 待计算（Enter）'));
  if (!S.showBox) el.innerHTML += ' · <span class="dim-hint">框线已隐藏（B 显示）</span>';
  const run = $('btn-run');
  if (run) run.disabled = S.live || !S.box;
}

/* ------------------------------------------------------------------ 图像 */
function setBoxDefault() {
  const w = Math.max(24, Math.round(S.W * 0.11));
  const h = Math.max(24, Math.round(S.H * 0.11));
  S.box = { x: Math.round((S.W - w) / 2), y: Math.round((S.H - h) / 2), w, h };
}

async function setImage(d, url) {
  S.id = d.id;
  S.name = d.name || '';
  S.W = d.w; S.H = d.h;
  S.img = await loadImage(url);
  const qb = new URLSearchParams(location.search).get('box');
  S.results = {};
  S.seq = {};
  S.active = DEFAULT_ON.find((x) => S.enabled.has(x)) || 'telea';
  $('ph').classList.add('hide');
  $('btn-export').disabled = false;
  $('results').dataset.sig = '';
  if (qb && /^[\d.,]+$/.test(qb)) {
    const [bx, by, bw, bh] = qb.split(',').map(Number);
    S.box = { x: bx, y: by, w: bw, h: bh };
  } else {
    setBoxDefault();
  }
  updateCards();
  requestDraw();
  schedule();
  document.title = `${S.name || 'untitled'} · Inpaint Studio`;
}

async function openFile(file) {
  if (!file) return;
  const buf = await file.arrayBuffer();
  const r = await fetch(`/api/upload?name=${encodeURIComponent(file.name)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: buf,
  });
  const d = await r.json();
  if (!r.ok) throw new Error(d.error || '上传失败');
  await setImage(d, URL.createObjectURL(file));
}

async function openSample(path) {
  const r = await fetch('/api/open', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path }),
  });
  const d = await r.json();
  if (!r.ok) throw new Error(d.error || '打开失败');
  await setImage(d, `/api/image?id=${encodeURIComponent(d.id)}`);
}

/* ------------------------------------------------------------------ 放大检查 */
const mcv = $('modal-cv');

function openModal(id) {
  const res = S.results[id];
  if (!res || !S.box) return;
  M.open = true; M.id = id;
  $('modal').hidden = false;
  const m = METHODS.find((x) => x.id === id);
  $('modal-title').textContent = `${m ? m.name : id} · 放大检查`;
  const r = mcv.getBoundingClientRect();
  const b = S.box;
  M.scale = clamp(Math.min(r.width / (b.w * 1.8), r.height / (b.h * 1.8)), 0.5, 10);
  if (inspectZoom) M.scale = inspectZoom;
  M.tx = r.width / 2 - (b.x + b.w / 2) * M.scale;
  M.ty = r.height / 2 - (b.y + b.h / 2) * M.scale;
  markZoom();
  drawModal();
}

function closeModal() {
  M.open = false;
  $('modal').hidden = true;
}

function drawModal() {
  if (!M.open) return;
  const d = dpr();
  const w = mcv.clientWidth, h = mcv.clientHeight;
  if (!w || !h) return;
  if (mcv.width !== Math.round(w * d) || mcv.height !== Math.round(h * d)) {
    mcv.width = Math.round(w * d);
    mcv.height = Math.round(h * d);
  }
  const g = mcv.getContext('2d');
  g.setTransform(d, 0, 0, d, 0, 0);
  g.fillStyle = '#07080b';
  g.fillRect(0, 0, w, h);
  g.save();
  // 平移取整：保证整图与"结果小块"落在同一像素网格上，避免接缝处出现 1px 竖线
  const tx = Math.round(M.tx), ty = Math.round(M.ty);
  g.translate(tx, ty);
  g.scale(M.scale, M.scale);
  g.imageSmoothingEnabled = M.scale < 2;
  g.drawImage(S.img, 0, 0, S.W, S.H);
  const res = S.results[M.id];
  if (res && !S.peek) {
    const [x0, y0, x1, y1] = res.rect;
    g.drawImage(res.img, x0, y0, x1 - x0, y1 - y0);
  }
  g.restore();

  if (S.showBox && S.box) {
    g.save();
    g.strokeStyle = 'rgba(120,170,255,.35)';
    g.setLineDash([6, 5]);
    g.lineWidth = 1;
    g.strokeRect(tx + S.box.x * M.scale, ty + S.box.y * M.scale,
                 S.box.w * M.scale, S.box.h * M.scale);
    g.restore();
  }
  g.fillStyle = 'rgba(200,212,232,.75)';
  g.font = '11px -apple-system, sans-serif';
  g.fillText(`${M.scale.toFixed(1)}×   ${S.peek ? '原图' : '结果'}`, 12, h - 12);
}

for (const b of document.querySelectorAll('.zoom-set .btn')) {
  b.addEventListener('click', () => {
    if (!S.box) return;
    M.scale = Number(b.dataset.z);
    const r = mcv.getBoundingClientRect();
    M.tx = r.width / 2 - (S.box.x + S.box.w / 2) * M.scale;
    M.ty = r.height / 2 - (S.box.y + S.box.h / 2) * M.scale;
    markZoom();
    drawModal();
  });
}

function markZoom() {
  for (const b of document.querySelectorAll('.zoom-set .btn')) {
    b.classList.toggle('on', Math.abs(Number(b.dataset.z) - M.scale) < 0.05);
  }
}

mcv.addEventListener('wheel', (e) => {
  e.preventDefault();
  const r = mcv.getBoundingClientRect();
  const mx = e.clientX - r.left, my = e.clientY - r.top;
  const k = Math.exp(-e.deltaY * 0.0022);
  const ns = clamp(M.scale * k, 0.2, 16);
  const kk = ns / M.scale;
  M.tx = mx - (mx - M.tx) * kk;
  M.ty = my - (my - M.ty) * kk;
  M.scale = ns;
  markZoom();
  drawModal();
}, { passive: false });

mcv.addEventListener('pointerdown', (e) => {
  mcv.setPointerCapture(e.pointerId);
  M.drag = { x: e.clientX, y: e.clientY };
  mcv.classList.add('dragging');
});
mcv.addEventListener('pointermove', (e) => {
  if (!M.drag) return;
  M.tx += e.clientX - M.drag.x;
  M.ty += e.clientY - M.drag.y;
  M.drag = { x: e.clientX, y: e.clientY };
  drawModal();
});
mcv.addEventListener('pointerup', () => { M.drag = null; mcv.classList.remove('dragging'); });
$('modal-close').addEventListener('click', closeModal);
$('modal').addEventListener('click', (e) => { if (e.target === $('modal')) closeModal(); });

/* ------------------------------------------------------------------ 交互 */
$('btn-open').addEventListener('click', () => $('file').click());
$('file').addEventListener('change', (e) => {
  openFile(e.target.files[0]).catch((err) => alert(err.message));
  e.target.value = '';
});

window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
  e.preventDefault();
  const f = e.dataTransfer.files[0];
  if (f && f.type.startsWith('image/')) openFile(f).catch((err) => alert(err.message));
});

window.addEventListener('paste', (e) => {
  const item = [...(e.clipboardData?.items || [])].find((i) => i.type.startsWith('image/'));
  if (item) openFile(item.getAsFile()).catch((err) => alert(err.message));
});

$('btn-export').addEventListener('click', async () => {
  if (!S.id || !S.box) return;
  const btn = $('btn-export');
  btn.disabled = true;
  btn.textContent = '导出中…';
  try {
    const r = await fetch('/api/export', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: S.id,
        bbox: [S.box.x, S.box.y, S.box.w, S.box.h],
        method: S.active,
        dilate: Number($('dilate').value),
        feather: Number($('feather').value),
        margin: Number($('margin').value),
        mask_mode: $('mask-mode').value,
        params: paramsFor(S.active),
      }),
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || '导出失败');
    const a = document.createElement('a');
    a.href = d.png;
    a.download = d.name;
    a.click();
  } catch (err) {
    alert(err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = '导出结果';
  }
});

/* 方法开关 */
function buildMethods() {
  const box = $('methods');
  box.innerHTML = '';
  for (const m of METHODS) {
    const row = document.createElement('label');
    row.className = 'm' + (S.enabled.has(m.id) ? ' on' : ' off');
    row.dataset.id = m.id;
    const p = m.param;
    row.innerHTML = `
      <input type="checkbox" ${S.enabled.has(m.id) ? 'checked' : ''}>
      <span class="name">${m.name}</span>
      <span class="tag">${m.tag}</span>
      ${p ? `<input class="p" type="number" min="${p.min}" max="${p.max}" step="1"
              title="${p.hint}" value="${(S.params[m.id] || {})[p.key] ?? p.def}">` : '<span class="p" style="border:0"></span>'}`;
    row.querySelector('input[type=checkbox]').addEventListener('change', (e) => {
      if (e.target.checked) S.enabled.add(m.id); else S.enabled.delete(m.id);
      row.classList.toggle('on', e.target.checked);
      row.classList.toggle('off', !e.target.checked);
      if (!S.enabled.has(S.active)) S.active = [...S.enabled][0] || 'telea';
      updateCards();
      if (e.target.checked && S.box) runMethod(m.id);
      if (!S.enabled.size) { /* nothing */ }
    });
    if (p) {
      const inp = row.querySelector('input.p');
      inp.addEventListener('input', () => {
        const v = clamp(Number(inp.value) || p.def, p.min, p.max);
        S.params[m.id] = { [p.key]: v };
        if (S.enabled.has(m.id) && S.box) { clearTimeout(debounce); debounce = setTimeout(() => runMethod(m.id), 160); }
      });
    }
    box.appendChild(row);
  }
}

/* 滑杆 */
function bindSlider(id, key, fmt) {
  const el = $(id);
  const out = $(`v-${key}`);
  const sync = () => { out.textContent = fmt(el.value); };
  el.addEventListener('input', sync);
  el.addEventListener('change', () => { if (S.box) schedule(); });
  sync();
}

/* 键盘 */
window.addEventListener('keydown', (e) => {
  if (e.code === 'Space' && !e.repeat) {
    e.preventDefault();
    S.peek = true;
    requestDraw();
    if (M.open) drawModal();
  }
  if (e.key === 'Escape' && M.open) closeModal();
  if ((e.key === 'b' || e.key === 'B') && !M.open) {
    const tag = document.activeElement?.tagName;
    if (tag !== 'INPUT' && tag !== 'SELECT') {
      e.preventDefault();
      setShowBox(!S.showBox);
    }
  }
  if (e.key === 'Enter' && !M.open && !S.live) {
    const tag = document.activeElement?.tagName;
    if (tag !== 'INPUT' && tag !== 'SELECT') { e.preventDefault(); runNow(); }
  }
  if ((e.key === 'Delete' || e.key === 'Backspace') && S.box && !M.open) {
    const tag = document.activeElement?.tagName;
    if (tag === 'INPUT' || tag === 'SELECT') return;
    e.preventDefault();
    S.box = null;
    S.results = {};
    cancelAll();
    updateCards();
    updateStatus();
    requestDraw();
  }
});

window.addEventListener('keyup', (e) => {
  if (e.code === 'Space') {
    S.peek = false;
    requestDraw();
    if (M.open) drawModal();
  }
});

function cancelAll() {
  for (const k of Object.keys(S.seq)) S.seq[k]++;
}

/* 尺寸变化 */
window.addEventListener('resize', () => {
  requestDraw();
  if (M.open) drawModal();
  for (const id of Object.keys(S.results)) drawCard(id);
});

/* 初始化 */
(async function init() {
  buildMethods();
  loadPrefs();
  const qp = new URLSearchParams(location.search);
  if (qp.get('live') === '0') S.live = false;
  if (qp.get('compare') === '1') S.compare = true;
  if (qp.get('hidebox') === '1') S.showBox = false;

  const syncSeg = (el, on) => {
    for (const b of el.querySelectorAll('button')) b.classList.toggle('on', (b.dataset.v === '1') === on);
  };
  syncSeg($('seg-live'), S.live);
  syncSeg($('seg-view'), S.compare);
  $('btn-run').disabled = S.live;

  $('seg-live').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    S.live = b.dataset.v === '1';
    syncSeg($('seg-live'), S.live);
    $('btn-run').disabled = S.live || !S.box;
    savePrefs();
    if (S.live && S.box) schedule();
    updateStatus();
  });

  $('seg-view').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    S.compare = b.dataset.v === '1';
    syncSeg($('seg-view'), S.compare);
    savePrefs();
    requestDraw();
  });

  $('btn-run').addEventListener('click', runNow);

  bindSlider('dilate', 'dilate', (v) => v);
  bindSlider('feather', 'feather', (v) => v);
  bindSlider('margin', 'margin', (v) => Number(v).toFixed(1));
  if (new URLSearchParams(location.search).get('mask') === '1') {
    $('show-mask').checked = true;
    S.showMask = true;
  }
  $('show-box').checked = S.showBox;
  $('show-box').addEventListener('change', (e) => setShowBox(e.target.checked));

  $('show-mask').addEventListener('change', (e) => {
    S.showMask = e.target.checked;
    requestDraw();
  });
  $('mask-mode').addEventListener('change', () => { if (S.box) schedule(); });

  try {
    const r = await fetch('/api/methods');
    const d = await r.json();
    S.avail = d.available || {};
    for (const m of METHODS) {
      if (S.avail[m.id] === false) {
        S.enabled.delete(m.id);
        const row = document.querySelector(`.m[data-id="${m.id}"]`);
        if (row) {
          row.classList.add('off');
          row.classList.remove('on');
          row.querySelector('input[type=checkbox]').checked = false;
          row.title = '未安装：pip install PyPatchMatch / scikit-image';
        }
      }
    }
    buildMethods();
    updateCards();
  } catch (_) { /* 忽略 */ }

  // 支持 ?sample=<workspace 相对路径> 直接打开（方便分享/嵌 iframe）
  const q = new URLSearchParams(location.search);
  const init = q.get('sample') || q.get('img');
  const ins = q.get('inspect');
  autoInspect = !!ins;
  inspectZoom = Number(ins) > 0 ? Number(ins) : 0;
  if (init) openSample(init).catch((err) => console.warn(err.message));

  try {
    const r = await fetch('/api/samples');
    const d = await r.json();
    const sel = $('samples');
    for (const s of d.samples || []) {
      const o = document.createElement('option');
      o.value = s.path;
      o.textContent = s.label;
      sel.appendChild(o);
    }
    sel.addEventListener('change', () => {
      if (sel.value) openSample(sel.value).catch((err) => alert(err.message));
      sel.value = '';
    });
  } catch (_) { /* 忽略 */ }
})();