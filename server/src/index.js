import http from 'node:http';
import { randomUUID, createHash } from 'node:crypto';
import express from 'express';
import cors from 'cors';
import multer from 'multer';
import { Server } from 'socket.io';
import { config } from './config.js';
import * as store from './db.js';
import { can } from './permissions.js';
import {
  HttpError, verifyGoogleToken, verifyAppleToken, signSession, verifySession, hashSecret, sameHash,
} from './auth.js';
import { RateLimiter, httpLimit } from './ratelimit.js';
import { createArduinoBuilder, CompileError } from './arduino.js';
import { createLibraryManager } from './arduino-libs.js';
import { aiEnabled, askAi, askBoard } from './ai.js';

const LIMITS = {
  name: 100, topic: 300, content: 4000, nickname: 32, avatar: 300_000, attachments: 10, status: 80, bio: 300, emoji: 8, pollOption: 100, pollOptions: 10,
};
const PRESENCE = ['online', 'idle', 'dnd', 'invisible'];
const MSG_KINDS = ['text', 'me', 'poll'];
const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;
const ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
const GUEST_ID_RE = /^guest:[A-Za-z0-9_-]{8,64}$/;
const NODE_TYPES = ['folder', 'text', 'voice', 'code', 'board'];
// 메시지를 주고받을 수 있는 방: 일반 채팅방, 1:1 대화, 코드 작업실, 보드 방 (작업 공간에도 채팅이 딸려 있음)
const CHAT_TYPES = ['text', 'dm', 'code', 'board'];
const WORKSPACE_TYPES = ['code', 'board'];
const BOARD_VIEWS = ['tree', 'sticky', 'mindmap', 'branch', 'kanban', 'timeline', 'debate'];
// 작업 공간 항목: 코드 작업실의 프로젝트·폴더·파일, 보드 방의 카드
const WS_KINDS = ['project', 'folder', 'file', 'card'];
const WS_STATUS = ['todo', 'doing', 'review', 'done'];
const WS_STANCE = ['pro', 'con', 'neutral'];
const WS_LIMITS = { name: 100, text: 2000, content: 200_000, perRoom: 3000, batch: 300, history: 10 };
const SHA256_RE = /^[0-9a-f]{64}$/;
// 브라우저에서 바로 열어도 안전한 형식만 inline 으로 보냅니다 (HTML·SVG 등은 내려받기로)
const INLINE_MIME = /^(image\/(png|jpe?g|gif|webp|avif|bmp)|video\/[\w.+-]+|audio\/[\w.+-]+|application\/pdf|text\/plain)$/;

// 1:1 대화방 id: 두 사용자 id 로 정해지므로 어느 기기에서 먼저 만들어도 같은 방이 됩니다 (client/js/data.js 와 같은 규칙)
export const dmIdFor = (a, b) => `dm_${createHash('sha256').update([a, b].sort().join('|')).digest('hex').slice(0, 40)}`;
const visibleTo = (node, uid) => !!node && (node.type !== 'dm' || (node.members || []).includes(uid));

const fail = (message, status = 400) => new HttpError(status, message);
const cleanStr = (v, max) => (typeof v === 'string' ? v.replace(/\u0000/g, '').trim().slice(0, max) : '');
const validId = (id) => typeof id === 'string' && ID_RE.test(id);
const out = (doc) => {
  if (!doc) return doc;
  const { _id, ...rest } = doc;
  return { id: _id, ...rest };
};
const cleanUser = (u) => u && ({
  id: u._id,
  provider: u.provider,
  nickname: u.nickname,
  avatar: u.avatar || null,
  status: u.status || '',
  bio: u.bio || '',
  banner: u.banner || null,
  presence: u.presence || 'online',
  createdAt: u.createdAt,
  lastSeen: u.lastSeen,
});
const kindOf = (mime = '') => (mime.startsWith('image/') ? 'image' : mime.startsWith('video/') ? 'video' : mime.startsWith('audio/') ? 'audio' : 'file');

function sanitizeAvatar(v) {
  if (typeof v !== 'string' || !v) return null;
  if (v.length > LIMITS.avatar) return null;
  if (/^data:image\/(png|jpe?g|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(v)) return v;
  if (/^https:\/\/[^\s"'<>]+$/.test(v)) return v;
  return null;
}

function fileMeta(f) {
  return {
    id: f._id, name: f.filename, size: f.length, mime: f.metadata?.mime || 'application/octet-stream',
    kind: f.metadata?.kind || 'file', expiresAt: f.metadata?.persistent ? 0 : f.metadata?.expiresAt || 0,
    ...(f.metadata?.sha256 ? { sha256: f.metadata.sha256 } : {}),
    ...(f.metadata?.persistent ? { persistent: true } : {}),
  };
}
const isFileExpired = (f) => !f.metadata?.persistent && (f.metadata?.expiresAt || 0) < Date.now();

// ───────────────────────── 상태 모니터링용 지표 ─────────────────────────
const startedAt = Date.now();
const metrics = {
  serverErrors: [], // 최근 서버 오류 시각
  clientErrors: [], // 최근 클라이언트 오류 보고 시각
  sends: [], // 최근 메시지 전송 시각 (분당 메시지 수)
  lastErrors: [], // 최근 오류 요약 (관리자에게만 보임)
};
const HOUR = 3600_000;
function track(list, t = Date.now(), keep = HOUR) {
  list.push(t);
  while (list.length && list[0] < t - keep) list.shift();
  if (list.length > 10_000) list.splice(0, list.length - 10_000);
}
function noteError(where, e) {
  track(metrics.serverErrors);
  metrics.lastErrors.unshift({ at: Date.now(), where, message: String(e?.message || e).slice(0, 200) });
  metrics.lastErrors.length = Math.min(metrics.lastErrors.length, 20);
}

// ───────────────────────── 요청 제한 ─────────────────────────
const limiters = {
  user: new RateLimiter({ capacity: 60, refillPerSec: 15 }), // 사용자별 전체 요청 (기기 여러 대 합산)
  send: new RateLimiter({ capacity: 20, refillPerSec: 2 }), // 사용자별 메시지 전송
  auth: new RateLimiter({ capacity: 20, refillPerSec: 0.2 }), // IP별 로그인
  upload: new RateLimiter({ capacity: 30, refillPerSec: 0.5 }), // 사용자별 업로드
  report: new RateLimiter({ capacity: 10, refillPerSec: 0.1 }), // IP별 오류 보고
  ai: new RateLimiter({ capacity: 5, refillPerSec: 1 / 60 }), // 사용자별 AI 요청
  compile: new RateLimiter({ capacity: 12, refillPerSec: 0.2 }), // 사용자별 아두이노 컴파일
};
setInterval(() => Object.values(limiters).forEach((l) => l.sweep()), 5 * 60_000).unref();

// ───────────────────────── HTTP ─────────────────────────
const app = express();
// Koyeb 등 프록시 뒤에서 실제 접속 IP 를 쓰기 위해 (요청 제한용)
app.set('trust proxy', Number(process.env.TRUST_PROXY ?? 1));
app.disable('x-powered-by');
const corsOptions = {
  origin: config.allowedOrigins.includes('*') ? true : config.allowedOrigins,
  exposedHeaders: ['X-Expires-At', 'X-Content-SHA256'],
};
app.use(cors(corsOptions));
app.use((req, res, next) => {
  res.set({ 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY' });
  next();
});
app.use(express.json({ limit: '1mb' }));
const ipKey = (req) => req.ip || 'unknown';

const route = (fn) => async (req, res) => {
  try {
    await fn(req, res);
  } catch (e) {
    if (store.isNetworkError(e)) {
      store.markDown();
      return res.status(503).json({ error: 'db_unavailable' });
    }
    if (!e.expose) { console.error(e); noteError(req.path, e); }
    res.status(e.status || 500).json({ error: e.expose ? e.message : 'server_error' });
  }
};

const requireDb = (req, res, next) => (store.isReady() ? next() : res.status(503).json({ error: 'db_unavailable' }));

async function authHttp(req) {
  const header = req.get('authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : req.query.t;
  const s = await verifySession(token);
  const u = await store.col('users').findOne({ _id: s.sub });
  if (!u) throw fail('unauthorized', 401);
  return cleanUser(u);
}

async function upsertUser({ id, provider, nickname, avatar, secretHash }) {
  const users = store.col('users');
  const existing = await users.findOne({ _id: id });
  if (existing) {
    await users.updateOne({ _id: id }, { $set: { lastSeen: Date.now() } });
    return existing;
  }
  const doc = {
    _id: id,
    provider,
    nickname: cleanStr(nickname, LIMITS.nickname) || '사용자',
    avatar: sanitizeAvatar(avatar),
    createdAt: Date.now(),
    lastSeen: Date.now(),
    ...(secretHash ? { secretHash } : {}),
  };
  try {
    await users.insertOne(doc);
  } catch (e) {
    if (e.code === 11000) return users.findOne({ _id: id });
    throw e;
  }
  io.emit('user:upsert', cleanUser(doc));
  return doc;
}

const authResponse = async (res, user) => res.json({ token: await signSession(user), user: cleanUser(user) });

app.get('/', (req, res) => res.type('text').send('chat_site server OK'));

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    db: store.isReady(),
    version: config.version,
    fileTtlHours: config.fileTtlHours,
    maxUploadMb: config.maxUploadMb,
    storageQuotaMb: config.storageQuotaMb,
    callMaxParticipants: config.callMaxParticipants,
    sfuUrl: config.sfuUrl || null,
    features: { dm: true, storage: true, ai: aiEnabled(), errorReports: true },
    providers: { google: config.googleClientIds.length > 0, apple: config.appleClientIds.length > 0, guest: true },
  });
});

// 서버 상태 (로그인한 사용자). API · DB · WebSocket · 통화 · 오류 현황
app.get('/api/status', route(async (req, res) => {
  const user = store.isReady() ? await authHttp(req) : null;
  const t0 = performance.now();
  const dbPing = await store.pingMs().catch(() => null);
  const mem = process.memoryUsage();
  const reportsDay = store.isReady() ? await store.col('errors').countDocuments({ at: { $gt: Date.now() - 86400_000 } }).catch(() => null) : null;
  const callRooms = [...calls.values()];
  res.json({
    version: config.version,
    node: process.version,
    uptimeSec: Math.round((Date.now() - startedAt) / 1000),
    memoryMb: { rss: Math.round(mem.rss / 1048576), heap: Math.round(mem.heapUsed / 1048576) },
    db: { ready: store.isReady(), pingMs: dbPing, memory: store.isMemory() },
    sockets: io.engine.clientsCount,
    onlineUsers: visibleOnline().length,
    calls: { rooms: callRooms.length, participants: callRooms.reduce((n, m) => n + m.size, 0), max: config.callMaxParticipants, mode: config.sfuUrl ? 'sfu' : 'mesh' },
    messagesPerMin: metrics.sends.filter((x) => x > Date.now() - 60_000).length,
    errors: {
      serverLastHour: metrics.serverErrors.length,
      clientLastHour: metrics.clientErrors.length,
      reportsLastDay: reportsDay,
      recent: user && can(user, 'manageNodes') ? metrics.lastErrors.slice(0, 10) : undefined,
    },
    rateLimited: Object.fromEntries(Object.entries(limiters).map(([k, l]) => [k, l.blocked])),
    features: { ai: aiEnabled() },
    checkedInMs: Math.round(performance.now() - t0),
  });
}));

// 자동 오류 보고: 클라이언트에서 난 오류(코드, 메시지, 브라우저 정보)를 모읍니다. 30일 뒤 자동 삭제.
app.post('/api/errors', httpLimit(limiters.report, ipKey), route(async (req, res) => {
  const list = Array.isArray(req.body?.reports) ? req.body.reports.slice(0, 20) : [];
  let userId = null;
  try { userId = (await verifySession((req.get('authorization') || '').slice(7))).sub; } catch { /* 로그인 없이도 보고 가능 */ }
  const docs = list.map((r) => ({
    _id: randomUUID(),
    at: Date.now(),
    clientAt: Number(r?.at) || null,
    code: cleanStr(r?.code, 60),
    message: cleanStr(r?.message, 500),
    stack: cleanStr(r?.stack, 2000),
    source: cleanStr(r?.source, 200),
    version: cleanStr(r?.version, 40),
    mode: cleanStr(r?.mode, 20),
    ua: cleanStr(req.get('user-agent'), 300),
    userId,
  })).filter((d) => d.message);
  for (const d of docs) track(metrics.clientErrors);
  if (docs.length && store.isReady()) {
    for (const d of docs) await store.col('errors').insertOne(d);
  }
  res.json({ ok: true, received: docs.length });
}));

app.post('/api/auth/google', httpLimit(limiters.auth, ipKey), requireDb, route(async (req, res) => {
  const p = await verifyGoogleToken(req.body?.credential);
  const user = await upsertUser({
    id: `google:${p.sub}`, provider: 'google', nickname: p.name || p.email?.split('@')[0], avatar: p.picture,
  });
  await authResponse(res, user);
}));

app.post('/api/auth/apple', httpLimit(limiters.auth, ipKey), requireDb, route(async (req, res) => {
  const p = await verifyAppleToken(req.body?.idToken);
  const user = await upsertUser({
    id: `apple:${p.sub}`,
    provider: 'apple',
    nickname: cleanStr(req.body?.name, LIMITS.nickname) || (p.email ? String(p.email).split('@')[0] : '') || 'Apple 사용자',
    avatar: req.body?.avatar,
  });
  await authResponse(res, user);
}));

app.post('/api/auth/guest', httpLimit(limiters.auth, ipKey), requireDb, route(async (req, res) => {
  const { id, secret, nickname, avatar } = req.body || {};
  if (typeof id !== 'string' || !GUEST_ID_RE.test(id)) throw fail('invalid_guest_id');
  if (typeof secret !== 'string' || secret.length < 16 || secret.length > 128) throw fail('invalid_secret');
  const existing = await store.col('users').findOne({ _id: id });
  if (existing) {
    if (existing.provider !== 'guest' || !sameHash(existing.secretHash, hashSecret(secret))) throw fail('forbidden', 403);
    await store.col('users').updateOne({ _id: id }, { $set: { lastSeen: Date.now() } });
    return authResponse(res, existing);
  }
  if (!cleanStr(nickname, LIMITS.nickname)) throw fail('nickname_required');
  const user = await upsertUser({ id, provider: 'guest', nickname, avatar, secretHash: hashSecret(secret) });
  await authResponse(res, user);
}));

// 자동화 테스트 전용 로그인: 메모리 DB(MONGODB_URI=memory) + ALLOW_TEST_LOGIN=1 일 때만 켜짐 (실제 MongoDB 에서는 절대 켜지지 않음)
if (store.isMemory() && process.env.ALLOW_TEST_LOGIN === '1') {
  console.warn('[auth] 테스트 로그인 사용 중 (/api/auth/test)');
  app.post('/api/auth/test', route(async (req, res) => {
    const { id, provider, nickname } = req.body || {};
    if (!['google', 'apple', 'guest'].includes(provider) || typeof id !== 'string') throw fail('invalid');
    const user = await upsertUser({ id: `${provider}:${id}`, provider, nickname });
    await authResponse(res, user);
  }));
}

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: config.maxUploadMb * 1024 * 1024, files: 1 } });

async function storageUsage(userId) {
  const list = await store.files().find({ 'metadata.uploaderId': userId, 'metadata.persistent': true }, { projection: { length: 1 } }).toArray();
  return list.reduce((n, f) => n + (f.length || 0), 0);
}
async function checkQuota(userId, add) {
  if ((await storageUsage(userId)) + add > config.storageQuotaMb * 1024 * 1024) throw fail('quota_exceeded', 413);
}
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

// ── 아두이노 스케치 컴파일 (avr-gcc 가 설치된 서버에서만. 없으면 클라이언트가 간이 변환기로 실행) ──
const arduino = createArduinoBuilder();
// 라이브러리 관리: 목록(arduino-libs.json)에 있는 것만 설치 · 삭제. 설치 상태는 DB 에 적어 두어 서버를 다시 띄워도 유지
const arduinoLibs = createLibraryManager({
  builder: arduino,
  libsDir: arduino.libsDir,
  loadState: async () => (store.isReady() ? store.col('settings').findOne({ _id: 'arduinoLibs' }) : null),
  saveState: async (s) => {
    if (!store.isReady()) return;
    const doc = { on: s.on, off: s.off, updatedAt: Date.now() };
    if (await store.col('settings').findOne({ _id: 'arduinoLibs' })) await store.col('settings').updateOne({ _id: 'arduinoLibs' }, { $set: doc });
    else await store.col('settings').insertOne({ _id: 'arduinoLibs', ...doc });
  },
});
app.get('/api/arduino/libraries', requireDb, route(async (req, res) => {
  const user = await authHttp(req);
  res.json({ available: await arduino.available(), canManage: can(user, 'editWorkspace'), libraries: arduinoLibs.list() });
}));
app.post('/api/arduino/libraries/:id', requireDb, route(async (req, res) => {
  const user = await authHttp(req);
  if (!can(user, 'editWorkspace')) throw fail('forbidden', 403);
  if (!(await arduino.available())) throw fail('compiler_unavailable', 501);
  if (!limiters.compile.take(user.id, 2)) throw fail('rate_limited', 429);
  const action = req.body?.action;
  try {
    if (action === 'install') await arduinoLibs.install(req.params.id);
    else if (action === 'remove') await arduinoLibs.remove(req.params.id);
    else throw fail('bad_action', 400);
  } catch (e) {
    if (e.message === 'unknown_library') throw fail('unknown_library', 404);
    if (e.message === 'library_in_use') return res.status(409).json({ error: 'library_in_use', users: e.users });
    if (e instanceof HttpError) throw e;
    console.error('arduino library', action, req.params.id, e.message);
    throw fail('library_install_failed', 502);
  }
  return res.json({ libraries: arduinoLibs.list() });
}));
app.get('/api/arduino/status', route(async (req, res) => res.json({ available: await arduino.available(), ...arduino.stats() })));
app.post('/api/arduino/compile', requireDb, route(async (req, res) => {
  const user = await authHttp(req);
  if (!(await arduino.available())) throw fail('compiler_unavailable', 501);
  if (!limiters.compile.take(user.id)) throw fail('rate_limited', 429);
  try {
    const out = await arduino.compile({ sketch: req.body?.sketch, board: req.body?.board || 'uno', files: req.body?.files || [] });
    res.json({ ok: true, ...out });
  } catch (e) {
    if (!(e instanceof CompileError)) throw e;
    if (e.code === 'compile_error') {
      // 설치되지 않은 라이브러리를 include 했으면 어디서 설치하는지 알려 줌
      const errors = e.errors.map((x) => { const h = /^([\w+.-]+\.h(?:pp)?): No such file or directory/.exec(x.message); const lib = h && arduinoLibs.missingFor(h[1]); return lib ? { ...x, message: `${h[1]} 을(를) 찾을 수 없습니다. "라이브러리" 창에서 '${lib.name}' 을(를) 설치하세요.`, library: lib.id } : h ? { ...x, message: `${h[1]} 을(를) 찾을 수 없습니다. 설치된 라이브러리가 아닙니다 — "라이브러리" 창의 목록을 확인하거나, 그 파일을 스케치와 같은 폴더에 올리세요.` } : x; });
      return res.json({ ok: false, errors, log: e.log }); // 스케치의 오류는 정상 응답
    }
    if (e.code === 'compiler_busy') throw fail('compiler_busy', 429);
    if (e.code.startsWith('bad_')) throw fail(e.code, 400);
    console.error('arduino compile', e.code, e.log);
    throw fail(e.code, 500);
  }
  return undefined;
}));

app.post('/api/upload', requireDb, route(async (req, res) => {
  const user = await authHttp(req);
  if (!can(user, 'sendMessage')) throw fail('forbidden', 403);
  if (!limiters.upload.take(user.id)) throw fail('rate_limited', 429);
  const keep = req.query.keep === '1';
  if (keep && !can(user, 'storage')) throw fail('forbidden', 403);
  await new Promise((resolve, reject) => upload.single('file')(req, res, (err) => {
    if (err) reject(fail(err.code === 'LIMIT_FILE_SIZE' ? 'file_too_large' : 'upload_failed', err.code === 'LIMIT_FILE_SIZE' ? 413 : 400));
    else resolve();
  }));
  if (!req.file) throw fail('no_file');
  const id = validId(req.query.id) ? req.query.id : randomUUID();
  const existing = await store.files().findOne({ _id: id });
  if (existing) {
    if (existing.metadata?.uploaderId !== user.id) throw fail('conflict', 409);
    return res.json(fileMeta(existing));
  }
  const name = cleanStr(req.query.name, 200) || Buffer.from(req.file.originalname || 'file', 'latin1').toString('utf8');
  const mime = /^[\w.+-]+\/[\w.+-]+$/.test(req.file.mimetype || '') ? req.file.mimetype : 'application/octet-stream';
  // 파일 무결성: 클라이언트가 계산한 SHA-256 과 서버가 받은 내용의 해시가 다르면 거부
  const hash = sha256(req.file.buffer);
  const claimed = String(req.query.sha256 || '').toLowerCase();
  if (claimed && SHA256_RE.test(claimed) && claimed !== hash) throw fail('integrity_failed', 422);
  if (keep) await checkQuota(user.id, req.file.size);
  const metadata = {
    uploaderId: user.id, mime, kind: kindOf(mime), sha256: hash,
    ...(keep ? { persistent: true, expiresAt: 0 } : { expiresAt: Date.now() + config.fileTtlHours * 3600_000 }),
  };
  await new Promise((resolve, reject) => {
    const s = store.getBucket().openUploadStreamWithId(id, name, { metadata });
    s.on('error', reject);
    s.on('finish', resolve);
    s.end(req.file.buffer);
  });
  res.json(fileMeta({ _id: id, filename: name, length: req.file.size, metadata }));
}));

app.get('/api/files/:id', requireDb, route(async (req, res) => {
  const user = await authHttp(req);
  const f = await store.files().findOne({ _id: req.params.id });
  if (!f || isFileExpired(f)) throw fail('expired', 410);
  // 1:1 대화의 첨부파일은 대화 참여자만
  if (f.metadata?.members && !f.metadata.members.includes(user.id)) throw fail('not_found', 404);
  const mime = f.metadata?.mime || 'application/octet-stream';
  res.set({
    'Content-Type': mime,
    'Content-Length': String(f.length),
    'Content-Disposition': `${INLINE_MIME.test(mime) ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(f.filename)}`,
    // 서버 주소로 직접 열어도 스크립트가 실행되지 않도록
    'Content-Security-Policy': "sandbox; default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'",
    'Cache-Control': 'private, no-store',
    'X-Expires-At': String(f.metadata?.persistent ? 0 : f.metadata?.expiresAt || 0),
    ...(f.metadata?.sha256 ? { 'X-Content-SHA256': f.metadata.sha256 } : {}),
  });
  store.getBucket().openDownloadStream(f._id)
    .on('error', () => res.destroy())
    .pipe(res);
}));

/** 메시지 첨부파일 삭제 (내 보관함의 영구 파일은 남김) */
async function deleteFiles(ids) {
  if (!ids.length) return;
  const keep = new Set((await store.files().find({ _id: { $in: ids }, 'metadata.persistent': true }, { projection: { _id: 1 } }).toArray()).map((f) => f._id));
  for (const id of ids) {
    if (keep.has(id)) continue;
    try { await store.getBucket().delete(id); } catch { /* 이미 삭제됨 */ }
  }
}

// 유효기간이 지난 파일 정리 (메시지의 첨부 정보는 남아 있어 기기에 저장된 사본은 계속 볼 수 있음)
setInterval(async () => {
  if (!store.isReady()) return;
  try {
    const expired = await store.files().find({ 'metadata.persistent': { $ne: true }, 'metadata.expiresAt': { $lt: Date.now() } }, { projection: { _id: 1 } }).toArray();
    await deleteFiles(expired.map((f) => f._id));
    if (expired.length) console.log(`[files] 만료 파일 ${expired.length}개 삭제`);
  } catch (e) {
    console.warn('[files] 정리 실패', e.message);
  }
}, 15 * 60_000).unref();

// ───────────────────────── Socket.IO ─────────────────────────
const server = http.createServer(app);
const io = new Server(server, { cors: corsOptions, maxHttpBufferSize: 1e6 });

const onlineCount = new Map(); // userId → 연결 수
const calls = new Map(); // roomId → Map(sid → {sid, userId, state})
const socketCall = new Map(); // sid → roomId

// 방 정보 캐시 (메시지마다 방을 DB에서 다시 찾지 않도록). 서버 인스턴스는 1개를 전제로 합니다.
const roomCache = new Map(); // roomId → {type, name, readonly, slowmode, createdBy, members}
const cacheRoom = (n) => roomCache.set(n._id, {
  type: n.type, name: n.name, readonly: !!n.readonly, slowmode: n.slowmode || 0, createdBy: n.createdBy, ...(n.members ? { members: n.members } : {}),
});
async function roomInfo(roomId) {
  if (typeof roomId !== 'string') return null;
  if (roomCache.has(roomId)) return roomCache.get(roomId);
  const n = await store.col('nodes').findOne({ _id: roomId });
  if (n) cacheRoom(n);
  return roomCache.get(roomId) || null;
}
const roomType = async (roomId) => (await roomInfo(roomId))?.type || null;
const lastSent = new Map(); // `${roomId}:${userId}` → 마지막 전송 시각 (슬로우 모드)

// 접속 상태: '오프라인으로 표시(invisible)' 사용자는 다른 사람에게 오프라인으로 보임
const presenceOf = new Map(); // userId → presence
const visibleOnline = () => [...onlineCount.keys()].filter((id) => presenceOf.get(id) !== 'invisible');

/** 방 설정 값 정리 (이모지, 색상, 공지 전용, 슬로우 모드) */
function roomSettings(src, type) {
  const set = {};
  if (src.emoji !== undefined) set.emoji = cleanStr(src.emoji, LIMITS.emoji);
  if (src.color !== undefined) set.color = HEX_COLOR.test(src.color || '') ? src.color : null;
  if (type === 'board' && src.view !== undefined) set.view = BOARD_VIEWS.includes(src.view) ? src.view : 'tree';
  if (type === 'text') {
    if (src.readonly !== undefined) set.readonly = !!src.readonly;
    if (src.slowmode !== undefined) set.slowmode = Math.max(0, Math.min(21600, Math.floor(Number(src.slowmode) || 0)));
  }
  return set;
}

// 1:1 대화방의 이벤트는 두 참여자에게만, 나머지는 모두에게
const audience = (members) => (members ? io.to(members.map((u) => `user:${u}`)) : io);
const emitNode = (doc) => audience(doc.type === 'dm' ? doc.members : null).emit('node:upsert', out(doc));
const emitMsg = (doc) => audience(doc.members).emit('msg:upsert', out(doc));
const emitMsgRemove = (m) => audience(m.members).emit('msg:remove', { id: m._id, roomId: m.roomId });

const callList = (roomId) => [...(calls.get(roomId)?.values() || [])];
const callsSnapshot = () => Object.fromEntries([...calls.keys()].map((r) => [r, callList(r)]));
const emitCall = (roomId) => io.emit('call:participants', { roomId, list: callList(roomId) });

function leaveCall(socket) {
  const roomId = socketCall.get(socket.id);
  if (!roomId) return;
  socketCall.delete(socket.id);
  const m = calls.get(roomId);
  m?.delete(socket.id);
  if (m && !m.size) calls.delete(roomId);
  socket.leave(`call:${roomId}`);
  emitCall(roomId);
}

function cleanState(s = {}) {
  return { muted: !!s.muted, deaf: !!s.deaf, video: !!s.video, screen: !!s.screen };
}

io.use(async (socket, next) => {
  try {
    if (!store.isReady()) return next(new Error('db_unavailable'));
    const s = await verifySession(socket.handshake.auth?.token);
    const u = await store.col('users').findOne({ _id: s.sub });
    if (!u) return next(new Error('unauthorized'));
    socket.data.user = cleanUser(u);
    next();
  } catch (e) {
    next(new Error(e.status === 401 ? 'unauthorized' : 'db_unavailable'));
  }
});

store.onStatus((ok) => io.emit('server:db', { ok }));

io.on('connection', (socket) => {
  const me = () => socket.data.user;
  const userId = me().id;
  onlineCount.set(userId, (onlineCount.get(userId) || 0) + 1);
  presenceOf.set(userId, me().presence || 'online');
  if (onlineCount.get(userId) === 1 && presenceOf.get(userId) !== 'invisible') io.emit('presence', { userId, online: true });
  socket.join(`user:${userId}`);

  // 요청 제한: 사용자별(여러 기기 합산) 토큰 버킷. 제한에 걸리면 다시 시도할 수 있는 시간(retryAfter)을 알려 줌
  const on = (event, { perm, db = true, limit = true, cost = 1 } = {}, fn) => {
    socket.on(event, async (payload, ack) => {
      const reply = typeof ack === 'function' ? ack : () => {};
      if (limit && !limiters.user.take(userId, cost)) return reply({ ok: false, error: 'rate_limited', retryAfter: limiters.user.retryAfter(userId, cost) });
      if (perm && !can(me(), perm)) return reply({ ok: false, error: 'forbidden' });
      if (db && !store.isReady()) return reply({ ok: false, error: 'db_unavailable' });
      try {
        const r = await fn(payload && typeof payload === 'object' ? payload : {});
        reply({ ok: true, ...(r || {}) });
      } catch (e) {
        if (store.isNetworkError(e)) {
          store.markDown();
          return reply({ ok: false, error: 'db_unavailable' });
        }
        if (!e.expose) { console.error(`[${event}]`, e); noteError(event, e); }
        reply({ ok: false, error: e.expose ? e.message : 'server_error', ...(e.retryAfter ? { retryAfter: e.retryAfter } : {}) });
      }
    });
  };

  const nodes = () => store.col('nodes');
  const messages = () => store.col('messages');

  /** 이 사용자가 볼 수 있는 방인지 확인 (1:1 대화방은 참여자만) */
  async function accessRoom(roomId) {
    const room = await roomInfo(roomId);
    if (!visibleTo(room, userId)) throw fail('room_not_found', 404);
    return room;
  }
  /** 이 사용자가 볼 수 있는 메시지인지 확인 */
  async function accessMessage(id) {
    const m = typeof id === 'string' ? await messages().findOne({ _id: id }) : null;
    if (!m || (m.members && !m.members.includes(userId))) throw fail('not_found', 404);
    return m;
  }
  const canDelete = (m) => m.authorId === userId || (!m.members && can(me(), 'deleteAnyMessage'));

  on('sync', {}, async () => {
    const [n, u] = await Promise.all([
      nodes().find({ $or: [{ type: { $ne: 'dm' } }, { members: userId }] }).toArray(),
      store.col('users').find({}, { projection: { secretHash: 0 } }).toArray(),
    ]);
    return {
      nodes: n.map(out),
      users: u.map(cleanUser),
      online: visibleOnline(),
      calls: callsSnapshot(),
      me: me(),
      serverTime: Date.now(),
    };
  });

  // 세션 갱신: 만료(30일) 전에 새 토큰을 받아 로그인 상태를 계속 유지
  on('session:refresh', { db: false }, async () => ({ token: await signSession({ _id: userId, provider: me().provider }) }));

  // ── 1:1 대화 ──
  on('dm:open', { perm: 'directMessage' }, async ({ userId: other }) => {
    if (typeof other !== 'string' || other === userId) throw fail('invalid_user');
    const target = await store.col('users').findOne({ _id: other }, { projection: { _id: 1 } });
    if (!target) throw fail('not_found', 404);
    const _id = dmIdFor(userId, other);
    const existing = await nodes().findOne({ _id });
    if (existing) return { node: out(existing) };
    const t = Date.now();
    const doc = {
      _id, type: 'dm', name: '', parentId: null, order: 0, members: [userId, other].sort(), createdBy: userId, createdAt: t, updatedAt: t, lastMessageAt: 0,
    };
    try {
      await nodes().insertOne(doc);
    } catch (e) {
      if (e.code === 11000) return { node: out(await nodes().findOne({ _id })) };
      throw e;
    }
    cacheRoom(doc);
    emitNode(doc);
    return { node: out(doc) };
  });

  // ── 폴더 / 채팅방 / 통화방 ──
  on('node:create', { perm: 'manageNodes' }, async ({ id, type, name, parentId = null, topic, order, ...extra }) => {
    if (!NODE_TYPES.includes(type)) throw fail('invalid_type');
    const nm = cleanStr(name, LIMITS.name);
    if (!nm) throw fail('invalid_name');
    const _id = validId(id) ? id : randomUUID();
    const existing = await nodes().findOne({ _id });
    if (existing) return { node: out(existing) };
    if (parentId !== null) {
      const p = await nodes().findOne({ _id: parentId });
      if (!p || p.type !== 'folder') throw fail('invalid_parent');
    }
    let ord = Number(order);
    if (!Number.isFinite(ord)) {
      const lastNode = await nodes().find({ parentId }).sort({ order: -1 }).limit(1).next();
      ord = (lastNode?.order ?? 0) + 1;
    }
    const doc = {
      _id, type, name: nm, parentId, topic: cleanStr(topic, LIMITS.topic), order: ord,
      createdBy: userId, createdAt: Date.now(), updatedAt: Date.now(), lastMessageAt: 0, ...roomSettings(extra, type),
    };
    await nodes().insertOne(doc);
    cacheRoom(doc);
    emitNode(doc);
    return { node: out(doc) };
  });

  on('node:update', { perm: 'manageNodes' }, async ({ id, name, topic, parentId, order, ...extra }) => {
    const node = await nodes().findOne({ _id: id });
    if (!node) throw fail('not_found', 404);
    if (node.type === 'dm') throw fail('invalid_type');
    const set = { updatedAt: Date.now() };
    if (name !== undefined) {
      const nm = cleanStr(name, LIMITS.name);
      if (!nm) throw fail('invalid_name');
      set.name = nm;
    }
    if (topic !== undefined) set.topic = cleanStr(topic, LIMITS.topic);
    if (parentId !== undefined && parentId !== node.parentId) {
      if (parentId !== null) {
        const all = await nodes().find({}, { projection: { parentId: 1, type: 1 } }).toArray();
        const byId = new Map(all.map((n) => [n._id, n]));
        const target = byId.get(parentId);
        if (!target || target.type !== 'folder') throw fail('invalid_parent');
        for (let cur = target; cur; cur = byId.get(cur.parentId)) {
          if (cur._id === id) throw fail('invalid_move');
        }
      }
      set.parentId = parentId;
    }
    if (order !== undefined && Number.isFinite(Number(order))) set.order = Number(order);
    Object.assign(set, roomSettings(extra, node.type));
    await nodes().updateOne({ _id: id }, { $set: set });
    const doc = { ...node, ...set };
    cacheRoom(doc);
    emitNode(doc);
    return { node: out(doc) };
  });

  on('node:delete', { perm: 'manageNodes' }, async ({ id }) => {
    const all = await nodes().find({ type: { $ne: 'dm' } }, { projection: { parentId: 1, type: 1 } }).toArray();
    if (!all.some((n) => n._id === id)) return { ids: [] };
    const ids = [id];
    for (let i = 0; i < ids.length; i++) {
      for (const n of all) if (n.parentId === ids[i]) ids.push(n._id);
    }
    const msgs = await messages().find({ roomId: { $in: ids } }, { projection: { attachments: 1 } }).toArray();
    await deleteFiles(msgs.flatMap((m) => (m.attachments || []).map((a) => a.id)));
    await messages().deleteMany({ roomId: { $in: ids } });
    await store.col('wsitems').deleteMany({ roomId: { $in: ids } });
    await nodes().deleteMany({ _id: { $in: ids } });
    for (const rid of ids) roomCache.delete(rid);
    for (const rid of ids) {
      for (const p of callList(rid)) {
        const s = io.sockets.sockets.get(p.sid);
        if (s) leaveCall(s);
      }
    }
    io.emit('node:remove', { ids });
    return { ids };
  });

  // ── 메시지 ──
  on('msg:list', {}, async ({ roomId, before, limit }) => {
    await accessRoom(roomId);
    const n = Math.min(Math.max(Number(limit) || 50, 1), 100);
    const q = { roomId };
    if (Number.isFinite(Number(before))) q.createdAt = { $lt: Number(before) };
    const list = await messages().find(q).sort({ createdAt: -1 }).limit(n).toArray();
    return { messages: list.reverse().map(out) };
  });

  on('msg:send', { perm: 'sendMessage' }, async ({
    id, roomId, content, attachments, replyTo, createdAt, kind, poll, spoilers, forward,
  }) => {
    if (!limiters.send.take(userId)) throw Object.assign(fail('rate_limited', 429), { retryAfter: limiters.send.retryAfter(userId) });
    const _id = validId(id) ? id : randomUUID();
    const k = MSG_KINDS.includes(kind) ? kind : 'text';
    let text = cleanStr(content, LIMITS.content);
    const attIds = Array.isArray(attachments) ? attachments.filter((a) => typeof a === 'string').slice(0, LIMITS.attachments) : [];
    const fwdId = forward && typeof forward.messageId === 'string' ? forward.messageId : null;
    // 서로 관계없는 조회는 동시에 (MongoDB 왕복 횟수를 줄여 전송 지연 감소)
    const [room, found, r, orig] = await Promise.all([
      roomInfo(roomId),
      attIds.length ? store.files().find({ _id: { $in: attIds }, 'metadata.uploaderId': userId }).toArray() : [],
      typeof replyTo === 'string' ? messages().findOne({ _id: replyTo, roomId }) : null,
      fwdId ? messages().findOne({ _id: fwdId }) : null,
    ]);
    if (!visibleTo(room, userId) || !CHAT_TYPES.includes(room.type)) throw fail('room_not_found', 404);
    if (room.readonly && !can(me(), 'manageNodes')) throw fail('readonly', 403);
    const members = room.type === 'dm' ? room.members : null;
    const t = Date.now();
    const slowKey = `${roomId}:${userId}`;
    if (room.slowmode && room.createdBy !== userId && t - (lastSent.get(slowKey) || 0) < room.slowmode * 1000) throw fail('slowmode', 429);

    const spoilerSet = new Set(Array.isArray(spoilers) ? spoilers : []);
    let atts = attIds.map((a) => found.find((f) => f._id === a)).filter(Boolean).map((f) => ({ ...fileMeta(f), ...(spoilerSet.has(f._id) ? { spoiler: true } : {}) }));
    let forwarded = null;
    if (fwdId) {
      if (!orig || (orig.members && !orig.members.includes(userId))) throw fail('not_found', 404);
      const src = await roomInfo(orig.roomId);
      text = orig.kind === 'poll' ? `📊 ${orig.content}` : orig.content;
      atts = orig.attachments || [];
      forwarded = { messageId: orig._id, roomId: orig.roomId, roomName: src?.name || '', authorId: orig.authorId, authorNickname: orig.author?.nickname || '', createdAt: orig.createdAt };
    }
    let pollDoc = null;
    if (k === 'poll') {
      if (!can(me(), 'react')) throw fail('forbidden', 403);
      const opts = (Array.isArray(poll?.options) ? poll.options : []).map((o) => cleanStr(o, LIMITS.pollOption)).filter(Boolean).slice(0, LIMITS.pollOptions);
      if (!text || opts.length < 2) throw fail('invalid_poll');
      pollDoc = { multi: !!poll.multi, options: opts.map((o, i) => ({ id: `o${i + 1}`, text: o, votes: [] })) };
    }
    if (!text && !atts.length) throw fail('empty');
    const replyPreview = r
      ? { authorId: r.authorId, author: r.author, content: (r.content || '').slice(0, 120), attachments: (r.attachments || []).length }
      : null;
    const c = Number(createdAt);
    const doc = {
      _id,
      roomId,
      kind: fwdId ? 'text' : k,
      ...(members ? { members } : {}),
      authorId: userId,
      author: { nickname: me().nickname, provider: me().provider },
      content: text,
      attachments: atts,
      ...(pollDoc ? { poll: pollDoc } : {}),
      ...(forwarded ? { forwarded } : {}),
      replyTo: replyPreview ? replyTo : null,
      replyPreview,
      reactions: {},
      pinned: false,
      createdAt: Number.isFinite(c) && c > t - 30 * 86400_000 && c <= t + 60_000 ? c : t,
      editedAt: null,
    };
    try {
      await messages().insertOne(doc);
    } catch (e) {
      // 중복 메시지 방지: 같은 id 로 다시 보낸 경우(오프라인 재전송, 응답 시간 초과 후 재시도) → 새로 만들지 않고 기존 메시지 반환
      if (e.code === 11000) {
        const existing = await messages().findOne({ _id });
        if (!existing || existing.authorId !== userId) throw fail('conflict', 409);
        return { message: out(existing), duplicate: true };
      }
      throw e;
    }
    lastSent.set(slowKey, t);
    track(metrics.sends, t, 60_000);
    // 1:1 대화의 첨부파일은 참여자만 내려받을 수 있게 표시
    if (members && atts.length && !fwdId) {
      store.files().updateMany({ _id: { $in: atts.map((a) => a.id) }, 'metadata.persistent': { $ne: true } }, { $set: { 'metadata.members': members } }).catch(() => {});
    }
    emitMsg(doc);
    // 방의 마지막 메시지 시각은 전송 완료를 기다리지 않고 갱신
    nodes().updateOne({ _id: roomId, lastMessageAt: { $lt: doc.createdAt } }, { $set: { lastMessageAt: doc.createdAt } }).catch(() => {});
    return { message: out(doc) };
  });

  on('msg:vote', { perm: 'react' }, async ({ id, optionId, on: add }) => {
    const m = await accessMessage(id);
    if (!m.poll) throw fail('not_found', 404);
    const pollDoc = m.poll;
    if (!pollDoc.options.some((o) => o.id === optionId)) throw fail('invalid_option');
    for (const o of pollDoc.options) {
      const has = o.votes.includes(userId);
      if (o.id === optionId) {
        if (add && !has) o.votes.push(userId);
        if (!add && has) o.votes = o.votes.filter((v) => v !== userId);
      } else if (add && !pollDoc.multi && has) {
        o.votes = o.votes.filter((v) => v !== userId); // 하나만 고르는 투표
      }
    }
    await messages().updateOne({ _id: id }, { $set: { poll: pollDoc } });
    emitMsg({ ...m, poll: pollDoc });
    return {};
  });

  // 수정 충돌 처리: base 는 수정하기 전에 보고 있던 버전(수정 시각, 없으면 작성 시각).
  // 그 사이 다른 기기에서 먼저 수정했으면 conflict 를 알려 주되, 덮어쓴 내용은 수정 기록에 남아 잃어버리지 않음
  on('msg:edit', { perm: 'sendMessage' }, async ({ id, content, base }) => {
    const m = await accessMessage(id);
    if (m.authorId !== userId) throw fail('forbidden', 403);
    const text = cleanStr(content, LIMITS.content);
    if (!text && !(m.attachments || []).length) throw fail('empty');
    if (text === m.content) return {};
    const current = m.editedAt || m.createdAt;
    const conflict = Number.isFinite(Number(base)) && base !== null && Number(base) !== current;
    // 수정 기록 (최근 20개)
    const editHistory = [...(m.editHistory || []), { content: m.content, at: current }].slice(-20);
    const set = { content: text, editedAt: Math.max(Date.now(), current + 1), editHistory };
    await messages().updateOne({ _id: id }, { $set: set });
    emitMsg({ ...m, ...set });
    return conflict ? { conflict: true } : {};
  });

  on('msg:delete', {}, async ({ id }) => {
    const m = typeof id === 'string' ? await messages().findOne({ _id: id }) : null;
    if (!m || (m.members && !m.members.includes(userId))) return {};
    if (!canDelete(m)) throw fail('forbidden', 403);
    await messages().deleteOne({ _id: id });
    await deleteFiles((m.attachments || []).map((a) => a.id));
    emitMsgRemove(m);
    return {};
  });

  // 메시지 여러 개 한 번에 삭제 (최대 100개). 지울 권한이 있는 것만 지우고, 지운 id 목록을 돌려줌
  on('msg:deleteMany', { cost: 5 }, async ({ ids }) => {
    const list = Array.isArray(ids) ? [...new Set(ids.filter((x) => typeof x === 'string'))].slice(0, 100) : [];
    if (!list.length) return { deleted: [] };
    const found = await messages().find({ _id: { $in: list } }).toArray();
    const ok = found.filter((m) => (!m.members || m.members.includes(userId)) && canDelete(m));
    if (!ok.length) return { deleted: [] };
    await messages().deleteMany({ _id: { $in: ok.map((m) => m._id) } });
    await deleteFiles(ok.flatMap((m) => (m.attachments || []).map((a) => a.id)));
    for (const m of ok) emitMsgRemove(m);
    return { deleted: ok.map((m) => m._id) };
  });

  on('msg:react', { perm: 'react' }, async ({ id, emoji, on: add }) => {
    if (typeof emoji !== 'string' || !emoji || emoji.length > 16 || /[.$\u0000]/.test(emoji)) throw fail('invalid_emoji');
    await accessMessage(id);
    const key = `reactions.${emoji}`;
    const m = await messages().findOneAndUpdate(
      { _id: id },
      add ? { $addToSet: { [key]: userId } } : { $pull: { [key]: userId } },
      { returnDocument: 'after' },
    );
    if (!m) throw fail('not_found', 404);
    if (m.reactions?.[emoji]?.length === 0) {
      await messages().updateOne({ _id: id, [key]: { $size: 0 } }, { $unset: { [key]: '' } });
      delete m.reactions[emoji];
    }
    emitMsg(m);
    return {};
  });

  on('msg:pin', { perm: 'pin' }, async ({ id, pinned }) => {
    await accessMessage(id);
    const set = pinned ? { pinned: true, pinnedBy: userId, pinnedAt: Date.now() } : { pinned: false, pinnedBy: null, pinnedAt: null };
    const m = await messages().findOneAndUpdate({ _id: id }, { $set: set }, { returnDocument: 'after' });
    if (!m) throw fail('not_found', 404);
    emitMsg(m);
    return {};
  });

  on('msg:pins', {}, async ({ roomId }) => {
    await accessRoom(roomId);
    const list = await messages().find({ roomId, pinned: true }).sort({ pinnedAt: -1 }).limit(100).toArray();
    return { messages: list.map(out) };
  });

  // 검색: 내용/파일 이름, 보낸 사람(from), 종류(has), 기간(before/after), 나를 멘션한 메시지(mentions)
  on('msg:search', {}, async ({
    roomId, q, from, has, before, after, mentions,
  }) => {
    const esc = (v) => v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const and = [];
    const query = cleanStr(q, 100);
    if (query) {
      const re = new RegExp(esc(query), 'i');
      and.push({ $or: [{ content: re }, { 'attachments.name': re }] });
    }
    if (typeof roomId === 'string' && roomId) and.push({ roomId });
    if (typeof from === 'string' && from) and.push({ authorId: from });
    if (['image', 'video', 'audio', 'file'].includes(has)) and.push({ 'attachments.kind': has });
    if (has === 'media') and.push({ 'attachments.kind': { $in: ['image', 'video'] } });
    if (has === 'link') and.push({ content: /https?:\/\//i });
    if (has === 'pin') and.push({ pinned: true });
    if (has === 'poll') and.push({ kind: 'poll' });
    if (Number.isFinite(Number(before)) && before !== null) and.push({ createdAt: { $lt: Number(before) } });
    if (Number.isFinite(Number(after)) && after !== null) and.push({ createdAt: { $gte: Number(after) } });
    if (mentions) and.push({ content: new RegExp(`(^|\\s)@(${esc(me().nickname)}|everyone|here)(?=\\s|$)`) });
    const scoped = and.filter((c) => !('roomId' in c));
    if (!scoped.length) return { messages: [] };
    if (typeof roomId === 'string' && roomId) await accessRoom(roomId);
    // 내가 참여하지 않은 1:1 대화는 검색하지 않음
    and.push({ $or: [{ members: { $exists: false } }, { members: userId }] });
    const list = await messages().find({ $and: and }).sort({ createdAt: -1 }).limit(has ? 100 : 50).toArray();
    return { messages: list.map(out) };
  });

  on('room:stats', {}, async ({ roomId }) => {
    await accessRoom(roomId);
    const [count, pins, authors] = await Promise.all([
      messages().countDocuments({ roomId }),
      messages().countDocuments({ roomId, pinned: true }),
      messages().distinct('authorId', { roomId }),
    ]);
    return { count, pins, authors: authors.length };
  });

  // ── 프로필 ──
  on('profile:update', {}, async ({
    nickname, avatar, status, bio, banner, presence,
  }) => {
    const set = {};
    if (status !== undefined) set.status = cleanStr(status, LIMITS.status);
    if (bio !== undefined) set.bio = cleanStr(bio, LIMITS.bio);
    if (banner !== undefined) set.banner = HEX_COLOR.test(banner || '') ? banner : null;
    if (presence !== undefined && PRESENCE.includes(presence)) set.presence = presence;
    if (nickname !== undefined) {
      const n = cleanStr(nickname, LIMITS.nickname);
      if (!n) throw fail('invalid_nickname');
      set.nickname = n;
    }
    if (avatar !== undefined) set.avatar = avatar === null ? null : sanitizeAvatar(avatar);
    await store.col('users').updateOne({ _id: userId }, { $set: set });
    socket.data.user = { ...me(), ...set };
    for (const s of io.sockets.sockets.values()) {
      if (s.data.user?.id === userId) s.data.user = { ...s.data.user, ...set };
    }
    if (set.presence) {
      const was = presenceOf.get(userId);
      presenceOf.set(userId, set.presence);
      if (was !== 'invisible' && set.presence === 'invisible') io.emit('presence', { userId, online: false });
      if (was === 'invisible' && set.presence !== 'invisible') io.emit('presence', { userId, online: true });
    }
    io.emit('user:upsert', me());
    return { user: me() };
  });

  // 연결 진단 (설정 화면에서 사용)
  on('latency', { db: false }, async () => ({ dbMs: await store.pingMs().catch(() => null) }));

  on('typing', { db: false }, async ({ roomId }) => {
    if (typeof roomId !== 'string') return;
    const room = roomCache.get(roomId) || (store.isReady() ? await roomInfo(roomId).catch(() => null) : null);
    if (room?.type === 'dm') {
      if (room.members.includes(userId)) socket.to(room.members.map((u) => `user:${u}`)).emit('typing', { roomId, userId });
      return;
    }
    socket.broadcast.emit('typing', { roomId, userId });
  });

  // ── 내 보관함 (만료 없는 개인 파일 공간) ──
  on('files:mine', { perm: 'storage' }, async () => {
    const list = await store.files().find({ 'metadata.uploaderId': userId, 'metadata.persistent': true }).sort({ uploadDate: -1 }).toArray();
    return { files: list.map((f) => ({ ...fileMeta(f), savedAt: f.metadata?.savedAt || +new Date(f.uploadDate || 0) || 0 })), usage: list.reduce((n, f) => n + f.length, 0), quota: config.storageQuotaMb * 1024 * 1024 };
  });

  // 채팅 첨부파일을 만료되기 전에 내 보관함으로 복사
  on('file:keep', { perm: 'storage', cost: 5 }, async ({ id }) => {
    const f = typeof id === 'string' ? await store.files().findOne({ _id: id }) : null;
    if (!f || isFileExpired(f)) throw fail('expired', 410);
    if (f.metadata?.members && !f.metadata.members.includes(userId)) throw fail('not_found', 404);
    if (f.metadata?.persistent && f.metadata.uploaderId === userId) return { file: fileMeta(f) };
    await checkQuota(userId, f.length);
    const newId = randomUUID();
    const metadata = {
      uploaderId: userId, mime: f.metadata?.mime, kind: f.metadata?.kind || 'file', sha256: f.metadata?.sha256, persistent: true, expiresAt: 0, keptFrom: f._id, savedAt: Date.now(),
    };
    await new Promise((resolve, reject) => {
      const up = store.getBucket().openUploadStreamWithId(newId, f.filename, { metadata });
      up.on('error', reject);
      up.on('finish', resolve);
      store.getBucket().openDownloadStream(f._id).on('error', reject).pipe(up);
    });
    return { file: fileMeta({ _id: newId, filename: f.filename, length: f.length, metadata }) };
  });

  on('file:remove', { perm: 'storage' }, async ({ id }) => {
    const f = typeof id === 'string' ? await store.files().findOne({ _id: id }) : null;
    if (!f) return {};
    if (!f.metadata?.persistent || f.metadata.uploaderId !== userId) throw fail('forbidden', 403);
    await store.getBucket().delete(id);
    return {};
  });

  // ── 작업 공간 (코드 작업실의 프로젝트·폴더·파일, 보드 방의 카드) ──
  const ws = () => store.col('wsitems');
  async function accessWorkspace(roomId) {
    const room = await accessRoom(roomId);
    if (!WORKSPACE_TYPES.includes(room.type)) throw fail('room_not_found', 404);
    return room;
  }
  const num = (v, min, max) => (Number.isFinite(Number(v)) ? Math.max(min, Math.min(max, Number(v))) : undefined);
  /** 클라이언트가 보낸 항목에서 허용된 값만 골라 정리 */
  function wsFields(src, kind) {
    const set = {};
    if (src.name !== undefined) set.name = cleanStr(src.name, WS_LIMITS.name).replace(/[\\/]/g, '_');
    if (src.parentId !== undefined) set.parentId = validId(src.parentId) ? src.parentId : null;
    if (src.order !== undefined) set.order = num(src.order, -1e9, 1e9) ?? 0;
    if (kind === 'file' && src.content !== undefined) {
      if (typeof src.content !== 'string' || src.content.length > WS_LIMITS.content) throw fail('file_too_large', 413);
      set.content = src.content.replace(/\u0000/g, '');
    }
    if (kind === 'project' && src.template !== undefined) set.template = cleanStr(src.template, 20);
    if (kind === 'card') {
      if (src.text !== undefined) set.text = typeof src.text === 'string' ? src.text.replace(/\u0000/g, '').slice(0, WS_LIMITS.text) : '';
      if (src.x !== undefined) set.x = num(src.x, -20000, 20000) ?? 0;
      if (src.y !== undefined) set.y = num(src.y, -20000, 20000) ?? 0;
      if (src.color !== undefined) set.color = HEX_COLOR.test(src.color || '') ? src.color : null;
      if (src.status !== undefined) set.status = WS_STATUS.includes(src.status) ? src.status : null;
      if (src.stance !== undefined) set.stance = WS_STANCE.includes(src.stance) ? src.stance : null;
      if (src.date !== undefined) set.date = num(src.date, 0, 4e12) ?? null;
      if (src.msgId !== undefined) set.msgId = validId(src.msgId) ? src.msgId : null;
      if (src.sourceAuthor !== undefined) set.sourceAuthor = cleanStr(src.sourceAuthor, LIMITS.nickname);
      if (src.ai !== undefined) set.ai = !!src.ai;
    }
    return set;
  }
  /** 항목 하나 저장 (없으면 만들고 있으면 고침). 반환: { doc, conflict } */
  async function wsSave(roomId, src) {
    if (!src || !validId(src.id) || !WS_KINDS.includes(src.kind)) throw fail('invalid_item');
    const existing = await ws().findOne({ _id: src.id });
    const t = Date.now();
    if (!existing) {
      const fields = wsFields(src, src.kind);
      if (src.kind !== 'card' && !fields.name) throw fail('invalid_name');
      const doc = {
        _id: src.id, roomId, kind: src.kind, parentId: null, name: '', order: t, ...fields, createdBy: userId, createdAt: t, updatedBy: userId, updatedAt: t, rev: 1,
      };
      await ws().insertOne(doc);
      return { doc };
    }
    if (existing.roomId !== roomId || existing.kind !== src.kind) throw fail('conflict', 409);
    const set = wsFields(src, existing.kind);
    if (set.name === '' && existing.kind !== 'card') delete set.name;
    // 자기 자신이나 자기 하위 항목 안으로는 옮길 수 없음
    if (set.parentId && set.parentId !== existing.parentId) {
      const all = await ws().find({ roomId }, { projection: { parentId: 1 } }).toArray();
      const byId = new Map(all.map((x) => [x._id, x]));
      for (let cur = byId.get(set.parentId); cur; cur = byId.get(cur.parentId)) if (cur._id === existing._id) throw fail('invalid_move');
    }
    // 동시 편집: 내가 보던 버전(baseRev) 이후 다른 사람이 내용을 바꿨으면 conflict 로 알림. 덮어쓴 내용은 버전 기록에 남음
    const changed = set.content !== undefined && set.content !== existing.content;
    const conflict = changed && Number.isFinite(Number(src.baseRev)) && Number(src.baseRev) !== existing.rev;
    if (changed) {
      set.history = [...(existing.history || []), { content: existing.content || '', at: existing.updatedAt, by: existing.updatedBy }]
        .filter((h, i, a) => i === a.length - 1 || h.content !== a[i + 1].content).slice(-WS_LIMITS.history);
    }
    Object.assign(set, { updatedBy: userId, updatedAt: t, rev: (existing.rev || 1) + 1 });
    await ws().updateOne({ _id: existing._id }, { $set: set });
    return { doc: { ...existing, ...set }, conflict };
  }
  // 목록에서는 파일 버전 기록을 빼고 보냄 (필요할 때 ws:history 로 받음)
  const wsOut = (d) => { const { history, ...rest } = out(d); return { ...rest, versions: (history || []).length }; };

  on('ws:list', {}, async ({ roomId }) => {
    await accessWorkspace(roomId);
    return { items: (await ws().find({ roomId }).toArray()).map(wsOut) };
  });

  on('ws:put', { perm: 'editWorkspace' }, async ({ roomId, item }) => {
    await accessWorkspace(roomId);
    if (!(await ws().findOne({ _id: item?.id }, { projection: { _id: 1 } })) && (await ws().countDocuments({ roomId })) >= WS_LIMITS.perRoom) throw fail('workspace_full', 413);
    const { doc, conflict } = await wsSave(roomId, item);
    io.emit('ws:upsert', { roomId, items: [wsOut(doc)], by: userId });
    return { item: wsOut(doc), ...(conflict ? { conflict: true } : {}) };
  });

  // 여러 항목 한 번에 (프로젝트 템플릿, 파일 가져오기, 대화 → 보드 변환)
  on('ws:putMany', { perm: 'editWorkspace', cost: 5 }, async ({ roomId, items }) => {
    await accessWorkspace(roomId);
    const list = Array.isArray(items) ? items.slice(0, WS_LIMITS.batch) : [];
    if ((await ws().countDocuments({ roomId })) + list.length > WS_LIMITS.perRoom) throw fail('workspace_full', 413);
    const saved = [];
    for (const it of list) saved.push(wsOut((await wsSave(roomId, it)).doc));
    if (saved.length) io.emit('ws:upsert', { roomId, items: saved, by: userId });
    return { items: saved };
  });

  // 삭제: 하위 항목(폴더 안의 파일, 카드의 하위 카드)도 함께
  on('ws:delete', { perm: 'editWorkspace' }, async ({ roomId, ids }) => {
    await accessWorkspace(roomId);
    const all = await ws().find({ roomId }, { projection: { parentId: 1 } }).toArray();
    const have = new Set(all.map((x) => x._id));
    const del = (Array.isArray(ids) ? ids : []).filter((x) => have.has(x));
    for (let i = 0; i < del.length; i++) for (const x of all) if (x.parentId === del[i] && !del.includes(x._id)) del.push(x._id);
    if (del.length) {
      await ws().deleteMany({ _id: { $in: del } });
      io.emit('ws:remove', { roomId, ids: del, by: userId });
    }
    return { ids: del };
  });

  on('ws:history', {}, async ({ roomId, id }) => {
    await accessWorkspace(roomId);
    const d = await ws().findOne({ _id: id, roomId });
    if (!d) throw fail('not_found', 404);
    return { history: d.history || [] };
  });

  // 누가 어떤 파일을 열고 있는지 (저장하지 않는 실시간 표시)
  on('ws:focus', { db: false }, async ({ roomId, id }) => {
    if (typeof roomId === 'string' && WORKSPACE_TYPES.includes(roomCache.get(roomId)?.type)) socket.broadcast.emit('ws:focus', { roomId, id: validId(id) ? id : null, userId });
  });

  // 대화를 AI 로 분석해 보드 카드 초안 만들기 (저장하지 않음 → 사용자가 미리 보고 승인하면 ws:putMany 로 저장)
  on('ai:board', { perm: 'useAi' }, async ({ roomId, messageIds, view }) => {
    if (!aiEnabled()) throw fail('ai_disabled', 501);
    await accessRoom(roomId);
    if (!limiters.ai.take(userId)) throw Object.assign(fail('rate_limited', 429), { retryAfter: limiters.ai.retryAfter(userId) });
    const ids = Array.isArray(messageIds) ? messageIds.filter((x) => typeof x === 'string').slice(0, 300) : null;
    const list = ids?.length
      ? await messages().find({ _id: { $in: ids }, roomId }).sort({ createdAt: 1 }).toArray()
      : (await messages().find({ roomId }).sort({ createdAt: -1 }).limit(150).toArray()).reverse();
    if (!list.length) throw fail('empty');
    try {
      return await askBoard({ view: BOARD_VIEWS.includes(view) ? view : 'tree', messages: list });
    } catch (e) {
      throw fail(e.code || 'ai_unavailable', 503);
    }
  });

  // ── AI 도우미 (서버에 ANTHROPIC_API_KEY 가 있을 때) ──
  on('ai:ask', { perm: 'useAi' }, async ({ roomId, mode, question }) => {
    if (!aiEnabled()) throw fail('ai_disabled', 501);
    const room = await accessRoom(roomId);
    const q = cleanStr(question, 500);
    if (mode !== 'summary' && !q) throw fail('empty');
    if (!limiters.ai.take(userId)) throw Object.assign(fail('rate_limited', 429), { retryAfter: limiters.ai.retryAfter(userId) });
    const recent = await messages().find({ roomId }).sort({ createdAt: -1 }).limit(300).toArray();
    const roomName = room.type === 'dm' ? '1:1 대화' : room.name;
    try {
      return await askAi({ mode: mode === 'summary' ? 'summary' : 'ask', question: q, roomName, messages: recent.reverse() });
    } catch (e) {
      throw fail(e.code || 'ai_unavailable', 503);
    }
  });

  // ── 통화 (WebRTC 시그널링) ──
  on('call:join', { perm: 'joinCall' }, async ({ roomId, state }) => {
    if ((await roomType(roomId)) !== 'voice') throw fail('room_not_found', 404);
    const already = calls.get(roomId)?.has(socket.id);
    if (!already && callList(roomId).length >= config.callMaxParticipants) throw fail('call_full', 409);
    leaveCall(socket);
    const peers = callList(roomId);
    if (!calls.has(roomId)) calls.set(roomId, new Map());
    calls.get(roomId).set(socket.id, { sid: socket.id, userId, state: cleanState(state) });
    socketCall.set(socket.id, roomId);
    socket.join(`call:${roomId}`);
    emitCall(roomId);
    return { sid: socket.id, peers, max: config.callMaxParticipants, mode: config.sfuUrl ? 'sfu' : 'mesh' };
  });

  on('call:leave', { db: false }, async () => {
    leaveCall(socket);
  });

  on('call:state', { db: false }, async ({ state }) => {
    const roomId = socketCall.get(socket.id);
    const p = roomId && calls.get(roomId)?.get(socket.id);
    if (!p) return;
    p.state = cleanState(state);
    emitCall(roomId);
  });

  on('call:signal', { db: false, limit: false }, async ({ to, data }) => {
    const roomId = socketCall.get(socket.id);
    if (!roomId || socketCall.get(to) !== roomId) return;
    io.to(to).emit('call:signal', { from: socket.id, userId, data });
  });

  socket.on('disconnect', () => {
    leaveCall(socket);
    const n = (onlineCount.get(userId) || 1) - 1;
    if (n <= 0) {
      onlineCount.delete(userId);
      io.emit('presence', { userId, online: false });
      if (store.isReady()) store.col('users').updateOne({ _id: userId }, { $set: { lastSeen: Date.now() } }).catch(() => {});
    } else {
      onlineCount.set(userId, n);
    }
  });
});

await store.startDb();
arduino.available().then((ok) => { if (ok) arduinoLibs.sync().then((done) => { if (done.length) console.log('[arduino] 라이브러리 다시 설치:', done.join(', ')); }); });
server.listen(config.port, () => console.log(`[server] http://localhost:${config.port}`));
