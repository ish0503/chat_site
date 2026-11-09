// 기기 내 저장소 (IndexedDB). MongoDB/서버에 연결할 수 없을 때 모든 데이터가 이곳에 저장되고,
// 연결되면 outbox 의 작업이 서버로 동기화됩니다. IndexedDB를 쓸 수 없으면 메모리에 저장합니다.

const DB_NAME = 'chat_site';
const VERSION = 1;
const STORES = ['nodes', 'messages', 'users', 'blobs', 'outbox'];

let dbp = null;
let memory = null;

function openDb() {
  if (dbp) return dbp;
  dbp = new Promise((resolve) => {
    let req;
    try {
      req = indexedDB.open(DB_NAME, VERSION);
    } catch {
      return resolve(null);
    }
    req.onupgradeneeded = () => {
      const d = req.result;
      d.createObjectStore('nodes', { keyPath: 'id' });
      const m = d.createObjectStore('messages', { keyPath: 'id' });
      m.createIndex('room_created', ['roomId', 'createdAt']);
      m.createIndex('room', 'roomId');
      d.createObjectStore('users', { keyPath: 'id' });
      d.createObjectStore('blobs', { keyPath: 'id' });
      d.createObjectStore('outbox', { keyPath: 'seq', autoIncrement: true });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
    req.onblocked = () => resolve(null);
  }).then((d) => {
    if (!d) {
      console.warn('[db] IndexedDB를 사용할 수 없어 메모리에 저장합니다.');
      memory = Object.fromEntries(STORES.map((s) => [s, new Map()]));
    }
    return d;
  });
  return dbp;
}

export const isPersistent = async () => !!(await openDb());

const p = (req) => new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); });

async function tx(store, mode, fn) {
  const d = await openDb();
  if (!d) return fn(null);
  const t = d.transaction(store, mode);
  const s = t.objectStore(store);
  const result = await fn(s);
  if (mode === 'readwrite') {
    await new Promise((res, rej) => { t.oncomplete = res; t.onerror = () => rej(t.error); t.onabort = () => rej(t.error); });
  }
  return result;
}

const keyOf = (store, v) => (store === 'outbox' ? v.seq : v.id);
let memSeq = 1;

export async function get(store, key) {
  return tx(store, 'readonly', (s) => (s ? p(s.get(key)) : memory[store].get(key)));
}

export async function put(store, value) {
  return putMany(store, [value]);
}

export async function putMany(store, values) {
  if (!values.length) return;
  return tx(store, 'readwrite', (s) => {
    if (!s) { for (const v of values) memory[store].set(keyOf(store, v), structuredClone(v)); return; }
    for (const v of values) s.put(v);
  });
}

export async function del(store, key) {
  return delMany(store, [key]);
}

export async function delMany(store, keys) {
  if (!keys.length) return;
  return tx(store, 'readwrite', (s) => {
    if (!s) { for (const k of keys) memory[store].delete(k); return; }
    for (const k of keys) s.delete(k);
  });
}

export async function all(store) {
  return tx(store, 'readonly', (s) => (s ? p(s.getAll()) : [...memory[store].values()]));
}

export async function clear(store) {
  return tx(store, 'readwrite', (s) => (s ? s.clear() : memory[store].clear()));
}

/** 방의 메시지를 createdAt 오름차순으로. before 보다 이전 것 중 최근 limit 개 */
export async function roomMessages(roomId, { before = Infinity, after = -Infinity, limit = 50 } = {}) {
  return tx('messages', 'readonly', (s) => {
    if (!s) {
      return [...memory.messages.values()]
        .filter((m) => m.roomId === roomId && m.createdAt < before && m.createdAt >= after)
        .sort((a, b) => a.createdAt - b.createdAt)
        .slice(-limit);
    }
    return new Promise((resolve, reject) => {
      const out = [];
      const range = IDBKeyRange.bound([roomId, after], [roomId, before], false, true);
      const req = s.index('room_created').openCursor(range, 'prev');
      req.onsuccess = () => {
        const c = req.result;
        if (!c || out.length >= limit) return resolve(out.reverse());
        out.push(c.value);
        c.continue();
      };
      req.onerror = () => reject(req.error);
    });
  });
}

export async function roomAll(roomId) {
  return tx('messages', 'readonly', (s) => (s
    ? p(s.index('room').getAll(roomId))
    : [...memory.messages.values()].filter((m) => m.roomId === roomId)));
}

export async function outboxAdd(op) {
  return tx('outbox', 'readwrite', (s) => {
    if (!s) { const seq = memSeq++; memory.outbox.set(seq, { ...op, seq }); return; }
    s.add({ ...op, at: Date.now() });
  });
}

export async function outboxAll() {
  const list = await all('outbox');
  return list.sort((a, b) => a.seq - b.seq);
}

export async function blobStats() {
  const list = await all('blobs');
  return { count: list.length, bytes: list.reduce((n, b) => n + (b.blob?.size || 0), 0) };
}
