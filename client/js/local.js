// 나만 보는 개인 설정 (이 기기에만 저장): 북마크, 즐겨찾기, 방 알림, 차단, 메모, 리마인더, 임시 저장
import { Emitter } from './util.js';

const read = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } };
const write = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* noop */ } };

export const personal = new Emitter();

function store(key, fallback) {
  let value = read(key, fallback);
  return {
    get: () => value,
    set(v) { value = v; write(key, v); personal.emit(key, v); personal.emit('change', key); },
  };
}

// ── 북마크 (저장한 메시지) ──
const bm = store('cs.bookmarks', []);
export const bookmarks = {
  list: () => bm.get(),
  has: (id) => bm.get().some((b) => b.id === id),
  toggle(m, extra = {}) {
    if (this.has(m.id)) { bm.set(bm.get().filter((b) => b.id !== m.id)); return false; }
    bm.set([{
      id: m.id, roomId: m.roomId, authorId: m.authorId, author: m.author, content: (m.content || '').slice(0, 300),
      attachments: (m.attachments || []).map((a) => a.name), createdAt: m.createdAt, savedAt: Date.now(), ...extra,
    }, ...bm.get()].slice(0, 500));
    return true;
  },
  remove(id) { bm.set(bm.get().filter((b) => b.id !== id)); },
};

// ── 즐겨찾기 방 ──
const fav = store('cs.favorites', []);
export const favorites = {
  list: () => fav.get(),
  has: (id) => fav.get().includes(id),
  toggle(id) { fav.set(this.has(id) ? fav.get().filter((x) => x !== id) : [...fav.get(), id]); return this.has(id); },
};

// ── 방별 알림: all | mentions | none ──
const rn = store('cs.roomNotify', {});
export const roomNotify = {
  get: (id) => rn.get()[id] || 'all',
  set(id, v) { const o = { ...rn.get() }; if (v === 'all') delete o[id]; else o[id] = v; rn.set(o); },
};

// ── 차단한 사용자 (메시지 숨김) ──
const bl = store('cs.blocked', []);
export const blocked = {
  has: (id) => bl.get().includes(id),
  list: () => bl.get(),
  toggle(id) { bl.set(this.has(id) ? bl.get().filter((x) => x !== id) : [...bl.get(), id]); return this.has(id); },
};

// ── 사용자 메모 ──
const nt = store('cs.notes', {});
export const notes = {
  get: (id) => nt.get()[id] || '',
  set(id, v) { const o = { ...nt.get() }; if (v.trim()) o[id] = v.trim().slice(0, 500); else delete o[id]; nt.set(o); },
};

// ── 리마인더 ──
const rm = store('cs.reminders', []);
export const reminders = {
  list: () => rm.get(),
  add(r) { rm.set([...rm.get(), { id: `${Date.now()}${Math.random().toString(36).slice(2, 6)}`, ...r }]); },
  remove(id) { rm.set(rm.get().filter((x) => x.id !== id)); },
};

// ── 입력창 임시 저장 (새로고침해도 유지) ──
let draftMap = read('cs.drafts', {});
export const drafts = {
  get: (roomId) => draftMap[roomId] || '',
  set(roomId, text) {
    draftMap = { ...draftMap };
    if (text) draftMap[roomId] = text.slice(0, 4000); else delete draftMap[roomId];
    write('cs.drafts', draftMap); // 자주 바뀌므로 이벤트 없이 저장
  },
};
