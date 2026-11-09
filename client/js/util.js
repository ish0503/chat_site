/** 작은 DOM 헬퍼: h('div', {class: 'a', onclick}, ...children) */
export function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (k === 'html') el.innerHTML = v;
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else if (v === true) el.setAttribute(k, '');
      else el.setAttribute(k, v);
    }
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    if (Array.isArray(c)) append(el, c);
    else el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function uid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
}

export function randomSecret() {
  return [...crypto.getRandomValues(new Uint8Array(24))].map((x) => x.toString(16).padStart(2, '0')).join('');
}

export class Emitter {
  #h = new Map();
  on(evt, fn) {
    if (!this.#h.has(evt)) this.#h.set(evt, new Set());
    this.#h.get(evt).add(fn);
    return () => this.#h.get(evt)?.delete(fn);
  }
  emit(evt, ...args) {
    for (const fn of this.#h.get(evt) || []) {
      try { fn(...args); } catch (e) { console.error(e); }
    }
  }
}

export const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function safeImageUrl(u) {
  if (typeof u !== 'string') return null;
  if (/^https:\/\//.test(u) || /^data:image\//.test(u) || /^blob:/.test(u)) return u;
  return null;
}

let timeFmt = new Intl.DateTimeFormat('ko-KR', { hour: 'numeric', minute: '2-digit' });
let fullOpts = { year: 'numeric', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' };
/** 24시간제 표시 설정 */
export function setClock24(on) {
  timeFmt = new Intl.DateTimeFormat('ko-KR', { hour: 'numeric', minute: '2-digit', hourCycle: on ? 'h23' : 'h12' });
  fullOpts = { ...fullOpts, hourCycle: on ? 'h23' : 'h12' };
  fullFmt = new Intl.DateTimeFormat('ko-KR', fullOpts);
}
const dateFmt = new Intl.DateTimeFormat('ko-KR', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' });
let fullFmt = new Intl.DateTimeFormat('ko-KR', fullOpts);

export const fmtTime = (t) => timeFmt.format(t);
export const fmtDate = (t) => dateFmt.format(t);
export const fmtFull = (t) => fullFmt.format(t);
export const sameDay = (a, b) => new Date(a).toDateString() === new Date(b).toDateString();

export function fmtStamp(t) {
  const d = new Date(t);
  const today = new Date();
  const y = new Date(); y.setDate(today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return `오늘 ${fmtTime(t)}`;
  if (d.toDateString() === y.toDateString()) return `어제 ${fmtTime(t)}`;
  return `${d.getFullYear()}.${d.getMonth() + 1}.${d.getDate()}. ${fmtTime(t)}`;
}

export function fmtBytes(n) {
  if (!Number.isFinite(n)) return '';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(i && n < 10 ? 1 : 0)} ${u[i]}`;
}

export function fmtRemain(ms) {
  if (ms <= 0) return '만료됨';
  const h = Math.floor(ms / 3600_000);
  if (h >= 48) return `${Math.floor(h / 24)}일 남음`;
  if (h >= 1) return `${h}시간 남음`;
  return `${Math.max(1, Math.floor(ms / 60_000))}분 남음`;
}

export function decodeJwt(token) {
  try {
    const part = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    const bin = atob(part.padEnd(part.length + ((4 - (part.length % 4)) % 4), '='));
    return JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0))));
  } catch {
    return null;
  }
}

export const jwtValid = (token, marginSec = 60) => {
  const p = token && decodeJwt(token);
  return !!p && (!p.exp || p.exp * 1000 > Date.now() + marginSec * 1000);
};

export function throttle(fn, ms) {
  let last = 0;
  return (...a) => {
    const t = Date.now();
    if (t - last >= ms) { last = t; fn(...a); }
  };
}

export function debounce(fn, ms) {
  let t = null;
  return (...a) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
}

export const kindOf = (mime = '') => (mime.startsWith('image/') ? 'image' : mime.startsWith('video/') ? 'video' : mime.startsWith('audio/') ? 'audio' : 'file');

/**
 * 큰 사진(JPEG/WebP/HEIC)을 최대 2560px, JPEG 85% 로 줄여 전송 시간을 줄입니다.
 * 줄어들지 않거나 변환할 수 없으면 원본을 그대로 돌려줍니다. PNG·GIF 는 건드리지 않습니다.
 */
export async function compressImage(file, { maxDim = 2560, quality = 0.85, minBytes = 1_000_000 } = {}) {
  if (!/^image\/(jpeg|webp|heic|heif)$/i.test(file.type) || file.size < minBytes || !window.createImageBitmap) return file;
  try {
    const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
    const scale = Math.min(1, maxDim / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas');
    c.width = Math.round(bmp.width * scale);
    c.height = Math.round(bmp.height * scale);
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    bmp.close?.();
    const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', quality));
    if (!blob || blob.size >= file.size) return file;
    const name = `${file.name.replace(/\.(jpe?g|webp|heic|heif)$/i, '')}.jpg`;
    return new File([blob], name, { type: 'image/jpeg', lastModified: file.lastModified });
  } catch {
    return file;
  }
}

/** 이미지 파일을 정사각형으로 잘라 data URL로 변환 (프로필 사진용) */
export async function imageToAvatar(file, size = 256) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((res, rej) => {
      const i = new Image();
      i.onload = () => res(i);
      i.onerror = rej;
      i.src = url;
    });
    const s = Math.min(img.naturalWidth, img.naturalHeight);
    const c = document.createElement('canvas');
    c.width = c.height = size;
    c.getContext('2d').drawImage(img, (img.naturalWidth - s) / 2, (img.naturalHeight - s) / 2, s, s, 0, 0, size, size);
    return c.toDataURL('image/jpeg', 0.85);
  } finally {
    URL.revokeObjectURL(url);
  }
}

let toastBox;
export function toast(msg, type = 'info', ms = 3200) {
  if (!toastBox) {
    toastBox = h('div', { class: 'toasts', role: 'status', 'aria-live': 'polite' });
    document.body.append(toastBox);
  }
  const t = h('div', { class: `toast toast-${type}` }, msg);
  toastBox.append(t);
  setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 300); }, ms);
}

export const isTouch = () => matchMedia('(pointer: coarse)').matches;
export const isMobile = () => matchMedia('(max-width: 768px)').matches;

export function loadScript(src) {
  return new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[src="${src}"]`);
    if (existing?.dataset.loaded) return resolve();
    const s = existing || h('script', { src, async: true });
    s.addEventListener('load', () => { s.dataset.loaded = '1'; resolve(); });
    s.addEventListener('error', () => { s.remove(); reject(new Error(`load failed: ${src}`)); });
    if (!existing) document.head.append(s);
  });
}

/** 기본 아바타 색상 (아이디 기반) */
export function colorFor(id = '') {
  let x = 0;
  for (const c of id) x = (x * 31 + c.charCodeAt(0)) >>> 0;
  const colors = ['#5865f2', '#3ba55c', '#faa61a', '#ed4245', '#eb459e', '#9b59b6', '#1abc9c', '#e67e22'];
  return colors[x % colors.length];
}
