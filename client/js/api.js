import { config } from './config.js';
import { jwtValid, loadScript } from './util.js';

export class OpError extends Error {
  constructor(code, status) {
    super(code);
    this.code = code;
    this.status = status;
  }
}

/** 연결 문제(→ 로컬 저장으로 전환)로 취급하는 오류 코드 */
const CONNECTIVITY = new Set(['offline', 'timeout', 'db_unavailable', 'disconnected']);
export const isConnectivity = (e) => CONNECTIVITY.has(e?.code);

async function req(url, opts = {}, timeout = 8000) {
  const ctl = new AbortController();
  const t = timeout ? setTimeout(() => ctl.abort(), timeout) : null;
  try {
    return await fetch(url, { ...opts, signal: ctl.signal });
  } catch {
    throw new OpError('offline');
  } finally {
    clearTimeout(t);
  }
}

async function errorFrom(r) {
  let code = 'server_error';
  try { code = (await r.json()).error || code; } catch { /* noop */ }
  if (r.status === 503) code = 'db_unavailable';
  return new OpError(code, r.status);
}

export async function health(base) {
  const r = await req(`${base}/api/health`, {}, 6000);
  if (!r.ok) throw new OpError('offline', r.status);
  return r.json();
}

async function postJson(base, path, body) {
  const r = await req(`${base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    const e = await errorFrom(r);
    if ([400, 401, 403, 501].includes(r.status)) e.code = 'auth_needed';
    throw e;
  }
  return r.json();
}

/** 로그인 정보(구글/애플 ID 토큰, 게스트 비밀키)를 서버 세션 토큰으로 교환 */
export async function exchange(base, session) {
  const u = session.user;
  if (u.provider === 'guest') {
    return postJson(base, '/api/auth/guest', { id: u.id, secret: session.guestSecret, nickname: u.nickname, avatar: u.avatar });
  }
  if (!jwtValid(session.idToken)) throw new OpError('auth_needed');
  if (u.provider === 'google') return postJson(base, '/api/auth/google', { credential: session.idToken });
  if (u.provider === 'apple') return postJson(base, '/api/auth/apple', { idToken: session.idToken, name: session.appleName, avatar: u.avatar });
  throw new OpError('auth_needed');
}

export function upload(base, token, blob, {
  id, name, onProgress, sha256, keep,
} = {}) {
  return new Promise((resolve, reject) => {
    const x = new XMLHttpRequest();
    const q = new URLSearchParams({ id, name: name || 'file', ...(sha256 ? { sha256 } : {}), ...(keep ? { keep: '1' } : {}) });
    x.open('POST', `${base}/api/upload?${q}`);
    x.setRequestHeader('Authorization', `Bearer ${token}`);
    x.responseType = 'json';
    x.upload.onprogress = (e) => e.lengthComputable && onProgress?.(e.loaded / e.total);
    x.onload = () => {
      if (x.status >= 200 && x.status < 300) return resolve(x.response);
      const code = x.status === 503 ? 'db_unavailable' : x.response?.error || 'upload_failed';
      reject(new OpError(code, x.status));
    };
    x.timeout = 5 * 60_000; // 멈춘 업로드가 동기화를 영원히 막지 않도록
    x.onerror = () => reject(new OpError('offline'));
    x.ontimeout = () => reject(new OpError('timeout'));
    const fd = new FormData();
    fd.append('file', blob, name || 'file');
    x.send(fd);
  });
}

export async function fetchFile(base, token, id) {
  const r = await req(`${base}/api/files/${encodeURIComponent(id)}`, { headers: { Authorization: `Bearer ${token}` } }, 3 * 60_000);
  if (r.status === 410 || r.status === 404) throw new OpError('expired', r.status);
  if (!r.ok) throw await errorFrom(r);
  return { blob: await r.blob(), sha256: r.headers.get('X-Content-SHA256') };
}

/** 서버 상태 (로그인 필요) */
/** 스케치를 서버의 실제 컴파일러로 컴파일 → { ok, hex, flash, … } 또는 { ok: false, errors, log } */
export async function compileSketch(base, token, body) {
  const r = await req(`${base}/api/arduino/compile`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  }, 90_000);
  if (!r.ok) throw await errorFrom(r);
  return r.json();
}

export async function status(base, token) {
  const r = await req(`${base}/api/status`, { headers: { Authorization: `Bearer ${token}` } }, 8000);
  if (!r.ok) throw await errorFrom(r);
  return r.json();
}

/** 자동 오류 보고 */
export async function reportErrors(base, token, reports) {
  const r = await req(`${base}/api/errors`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ reports }),
  }, 8000);
  if (!r.ok) throw await errorFrom(r);
  return r.json();
}

export const loadSocketIo = () => (window.io ? Promise.resolve() : loadScript(config.socketIoSrc));
