// 자동 오류 보고: 앱에서 난 오류를 이 기기에 기록하고(설정 → 오류 기록), 서버에 연결되면 보냅니다.
// 보내는 내용: 오류 코드 · 메시지 · 스택 일부 · 화면 위치 · 앱 버전 · 연결 상태 (메시지 내용이나 개인 정보는 보내지 않음)
import { config } from './config.js';
import * as api from './api.js';

const KEY = 'cs.errorLog';
const MAX = 50;
let data = null;
let queue = [];
let timer = null;
const seen = new Map(); // 같은 오류가 계속 나면 1분에 한 번만

const read = () => { try { return JSON.parse(localStorage.getItem(KEY)) || []; } catch { return []; } };
const write = (v) => { try { localStorage.setItem(KEY, JSON.stringify(v)); } catch { /* noop */ } };

export const appVersion = (() => {
  const m = [...document.scripts].map((s) => s.src).join(' ').match(/[?&]v=([\w]+)/);
  return m ? m[1] : 'dev';
})();

export function enabled() {
  try { return (JSON.parse(localStorage.getItem('cs.settings')) || {}).errorReports !== false; } catch { return true; }
}

/** 개인 정보가 섞이지 않도록: 주소의 #해시·쿼리, 토큰처럼 보이는 긴 문자열 지우기 */
const scrub = (s = '') => String(s)
  .replace(/eyJ[\w-]+\.[\w-]+\.[\w-]+/g, '[token]')
  .replace(/https?:\/\/[^\s)]+/g, (u) => u.split(/[?#]/)[0])
  .slice(0, 2000);

export function record(err, { code = 'js', source = '' } = {}) {
  const message = scrub(err?.message || String(err || '알 수 없는 오류'));
  if (!message || /ResizeObserver loop/.test(message)) return;
  const key = `${code}:${message}`;
  if (Date.now() - (seen.get(key) || 0) < 60_000) return;
  seen.set(key, Date.now());
  const entry = {
    at: Date.now(), code, message, stack: scrub(err?.stack || '').split('\n').slice(0, 8).join('\n'), source: scrub(source), version: appVersion, mode: data?.mode || '',
  };
  write([entry, ...read()].slice(0, MAX));
  if (enabled()) {
    queue.push(entry);
    schedule();
  }
}

function schedule() {
  clearTimeout(timer);
  timer = setTimeout(flush, 3000);
}

async function flush() {
  if (!queue.length || !config.serverUrl || !navigator.onLine) return;
  const batch = queue.splice(0, 20);
  try {
    await api.reportErrors(config.serverUrl, data?.token, batch);
  } catch {
    queue = [...batch, ...queue].slice(0, 100); // 나중에 다시
  }
}

export const list = () => read();
export const clear = () => write([]);

let installed = false;
/** 전역 오류 감시 시작 (앱 시작 시 한 번) */
export function install(dataService) {
  data = dataService;
  dataService?.on('status', (st) => { if (st.mode === 'online') flush(); });
  if (installed) return;
  installed = true;
  window.addEventListener('error', (e) => {
    if (e.target && e.target !== window && (e.target.src || e.target.href)) return; // 이미지·스크립트 로드 실패는 제외
    record(e.error || e.message, { source: `${e.filename || ''}:${e.lineno || ''}` });
  });
  window.addEventListener('unhandledrejection', (e) => {
    const r = e.reason;
    if (r?.code && r.name !== 'TypeError' && !(r instanceof TypeError)) return; // 앱이 처리하는 동작 오류(OpError)는 제외
    record(r, { code: 'promise' });
  });
}
