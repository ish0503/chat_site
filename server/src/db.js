import { MongoClient, GridFSBucket } from 'mongodb';
import { config } from './config.js';

let client = null;
let db = null;
let bucket = null;
let ready = false;
let pingTimer = null;
const listeners = new Set();

export const isReady = () => ready;
export const col = (name) => db.collection(name);
export const files = () => db.collection('uploads.files');
export const getBucket = () => bucket;
export const onStatus = (fn) => listeners.add(fn);

function setReady(v) {
  if (ready === v) return;
  ready = v;
  console.log(v ? '[db] MongoDB 연결됨' : '[db] MongoDB 연결 끊김');
  for (const fn of listeners) fn(v);
}

export function isNetworkError(e) {
  const n = e?.name || '';
  return /MongoNetwork|MongoServerSelection|MongoTopologyClosed|PoolClosed|MongoNotConnected/.test(n);
}

/** MongoDB 왕복 시간(ms) 측정 */
export async function pingMs() {
  if (!ready) return null;
  const t0 = performance.now();
  await db.command({ ping: 1 });
  return Math.round(performance.now() - t0);
}

export function markDown() {
  setReady(false);
}

async function ensureIndexes() {
  await Promise.all([
    col('messages').createIndex({ roomId: 1, createdAt: -1 }),
    col('messages').createIndex({ roomId: 1, pinned: 1, pinnedAt: -1 }),
    col('nodes').createIndex({ parentId: 1, order: 1 }),
    col('nodes').createIndex({ members: 1 }, { sparse: true }),
    files().createIndex({ 'metadata.expiresAt': 1 }),
    files().createIndex({ 'metadata.uploaderId': 1, 'metadata.persistent': 1 }),
    // 오류 보고는 30일 뒤 자동 삭제
    col('errors').createIndex({ at: 1 }, { expireAfterSeconds: 30 * 86400 }),
  ]);
}

export const isMemory = () => config.mongoUri === 'memory';

async function tryConnect() {
  try {
    if (!db && isMemory()) {
      const { createMemoryDb } = await import('./memdb.js');
      const m = createMemoryDb();
      db = m.db;
      bucket = m.bucket;
      console.warn('[db] MONGODB_URI=memory — 메모리 DB 사용 (재시작하면 데이터가 사라집니다)');
    }
    if (!client && !isMemory()) {
      client = new MongoClient(config.mongoUri, { serverSelectionTimeoutMS: 5000 });
      await client.connect();
      db = client.db(config.dbName);
      bucket = new GridFSBucket(db, { bucketName: 'uploads' });
      await ensureIndexes();
    }
    await db.command({ ping: 1 });
    setReady(true);
  } catch (e) {
    if (!db) {
      // 첫 연결 실패 → 클라이언트를 버리고 다시 시도
      try { await client?.close(); } catch { /* noop */ }
      client = null;
    }
    console.warn('[db] 연결 실패:', e.message);
    setReady(false);
  }
}

/** 연결을 시작하고 10초마다 상태를 확인합니다. MongoDB가 내려가도 서버는 계속 동작하며, 클라이언트는 로컬 저장 모드로 전환됩니다. */
export async function startDb() {
  await tryConnect();
  if (isMemory()) return;
  pingTimer = setInterval(tryConnect, 10_000);
  pingTimer.unref?.();
}
