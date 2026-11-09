import http from 'node:http';
import { randomUUID } from 'node:crypto';
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

const LIMITS = {
  name: 100, topic: 300, content: 4000, nickname: 32, avatar: 300_000, attachments: 10, status: 80, bio: 300, emoji: 8, pollOption: 100, pollOptions: 10,
};
const PRESENCE = ['online', 'idle', 'dnd', 'invisible'];
const MSG_KINDS = ['text', 'me', 'poll'];
const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;
const ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
const GUEST_ID_RE = /^guest:[A-Za-z0-9_-]{8,64}$/;
const NODE_TYPES = ['folder', 'text', 'voice'];

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
    kind: f.metadata?.kind || 'file', expiresAt: f.metadata?.expiresAt || 0,
  };
}

// ───────────────────────── HTTP ─────────────────────────
const app = express();
const corsOptions = { origin: config.allowedOrigins.includes('*') ? true : config.allowedOrigins };
app.use(cors(corsOptions));
app.use(express.json({ limit: '1mb' }));

const route = (fn) => async (req, res) => {
  try {
    await fn(req, res);
  } catch (e) {
    if (store.isNetworkError(e)) {
      store.markDown();
      return res.status(503).json({ error: 'db_unavailable' });
    }
    if (!e.expose) console.error(e);
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
    fileTtlHours: config.fileTtlHours,
    maxUploadMb: config.maxUploadMb,
    providers: { google: config.googleClientIds.length > 0, apple: config.appleClientIds.length > 0, guest: true },
  });
});

app.post('/api/auth/google', requireDb, route(async (req, res) => {
  const p = await verifyGoogleToken(req.body?.credential);
  const user = await upsertUser({
    id: `google:${p.sub}`, provider: 'google', nickname: p.name || p.email?.split('@')[0], avatar: p.picture,
  });
  await authResponse(res, user);
}));

app.post('/api/auth/apple', requireDb, route(async (req, res) => {
  const p = await verifyAppleToken(req.body?.idToken);
  const user = await upsertUser({
    id: `apple:${p.sub}`,
    provider: 'apple',
    nickname: cleanStr(req.body?.name, LIMITS.nickname) || (p.email ? String(p.email).split('@')[0] : '') || 'Apple 사용자',
    avatar: req.body?.avatar,
  });
  await authResponse(res, user);
}));

app.post('/api/auth/guest', requireDb, route(async (req, res) => {
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

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: config.maxUploadMb * 1024 * 1024, files: 1 } });

app.post('/api/upload', requireDb, route(async (req, res) => {
  const user = await authHttp(req);
  if (!can(user, 'sendMessage')) throw fail('forbidden', 403);
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
  const metadata = {
    uploaderId: user.id, mime, kind: kindOf(mime), expiresAt: Date.now() + config.fileTtlHours * 3600_000,
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
  await authHttp(req);
  const f = await store.files().findOne({ _id: req.params.id });
  if (!f || (f.metadata?.expiresAt || 0) < Date.now()) throw fail('expired', 410);
  res.set({
    'Content-Type': f.metadata?.mime || 'application/octet-stream',
    'Content-Length': String(f.length),
    'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(f.filename)}`,
    'Cache-Control': 'private, no-store',
    'X-Expires-At': String(f.metadata?.expiresAt || 0),
  });
  store.getBucket().openDownloadStream(f._id)
    .on('error', () => res.destroy())
    .pipe(res);
}));

async function deleteFiles(ids) {
  for (const id of ids) {
    try { await store.getBucket().delete(id); } catch { /* 이미 삭제됨 */ }
  }
}

// 유효기간이 지난 파일 정리 (메시지의 첨부 정보는 남아 있어 기기에 저장된 사본은 계속 볼 수 있음)
setInterval(async () => {
  if (!store.isReady()) return;
  try {
    const expired = await store.files().find({ 'metadata.expiresAt': { $lt: Date.now() } }, { projection: { _id: 1 } }).toArray();
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
const roomCache = new Map(); // roomId → {type, name, readonly, slowmode, createdBy}
const cacheRoom = (n) => roomCache.set(n._id, {
  type: n.type, name: n.name, readonly: !!n.readonly, slowmode: n.slowmode || 0, createdBy: n.createdBy,
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
  if (type === 'text') {
    if (src.readonly !== undefined) set.readonly = !!src.readonly;
    if (src.slowmode !== undefined) set.slowmode = Math.max(0, Math.min(21600, Math.floor(Number(src.slowmode) || 0)));
  }
  return set;
}

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

  // 간단한 토큰 버킷 rate limit
  let tokens = 30;
  let last = Date.now();
  const allow = () => {
    const t = Date.now();
    tokens = Math.min(30, tokens + ((t - last) / 1000) * 10);
    last = t;
    if (tokens < 1) return false;
    tokens -= 1;
    return true;
  };

  const on = (event, { perm, db = true, limit = true } = {}, fn) => {
    socket.on(event, async (payload, ack) => {
      const reply = typeof ack === 'function' ? ack : () => {};
      if (limit && !allow()) return reply({ ok: false, error: 'rate_limited' });
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
        if (!e.expose) console.error(`[${event}]`, e);
        reply({ ok: false, error: e.expose ? e.message : 'server_error' });
      }
    });
  };

  const nodes = () => store.col('nodes');
  const messages = () => store.col('messages');

  on('sync', {}, async () => {
    const [n, u] = await Promise.all([
      nodes().find({}).toArray(),
      store.col('users').find({}, { projection: { secretHash: 0 } }).toArray(),
    ]);
    return {
      nodes: n.map(out),
      users: u.map(cleanUser),
      online: visibleOnline(),
      calls: callsSnapshot(),
      me: me(),
    };
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
    io.emit('node:upsert', out(doc));
    return { node: out(doc) };
  });

  on('node:update', { perm: 'manageNodes' }, async ({ id, name, topic, parentId, order, ...extra }) => {
    const node = await nodes().findOne({ _id: id });
    if (!node) throw fail('not_found', 404);
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
    io.emit('node:upsert', out(doc));
    return { node: out(doc) };
  });

  on('node:delete', { perm: 'manageNodes' }, async ({ id }) => {
    const all = await nodes().find({}, { projection: { parentId: 1, type: 1 } }).toArray();
    if (!all.some((n) => n._id === id)) return { ids: [] };
    const ids = [id];
    for (let i = 0; i < ids.length; i++) {
      for (const n of all) if (n.parentId === ids[i]) ids.push(n._id);
    }
    const msgs = await messages().find({ roomId: { $in: ids } }, { projection: { attachments: 1 } }).toArray();
    await deleteFiles(msgs.flatMap((m) => (m.attachments || []).map((a) => a.id)));
    await messages().deleteMany({ roomId: { $in: ids } });
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
    const n = Math.min(Math.max(Number(limit) || 50, 1), 100);
    const q = { roomId };
    if (Number.isFinite(Number(before))) q.createdAt = { $lt: Number(before) };
    const list = await messages().find(q).sort({ createdAt: -1 }).limit(n).toArray();
    return { messages: list.reverse().map(out) };
  });

  on('msg:send', { perm: 'sendMessage' }, async ({
    id, roomId, content, attachments, replyTo, createdAt, kind, poll, spoilers, forward,
  }) => {
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
    if (room?.type !== 'text') throw fail('room_not_found', 404);
    if (room.readonly && !can(me(), 'manageNodes')) throw fail('readonly', 403);
    const t = Date.now();
    const slowKey = `${roomId}:${userId}`;
    if (room.slowmode && room.createdBy !== userId && t - (lastSent.get(slowKey) || 0) < room.slowmode * 1000) throw fail('slowmode', 429);

    const spoilerSet = new Set(Array.isArray(spoilers) ? spoilers : []);
    let atts = attIds.map((a) => found.find((f) => f._id === a)).filter(Boolean).map((f) => ({ ...fileMeta(f), ...(spoilerSet.has(f._id) ? { spoiler: true } : {}) }));
    let forwarded = null;
    if (fwdId) {
      if (!orig) throw fail('not_found', 404);
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
      // 같은 id 로 다시 보낸 경우(오프라인 재전송 등) → 기존 메시지 반환
      if (e.code === 11000) return { message: out(await messages().findOne({ _id })) };
      throw e;
    }
    lastSent.set(slowKey, t);
    io.emit('msg:upsert', out(doc));
    // 방의 마지막 메시지 시각은 전송 완료를 기다리지 않고 갱신
    nodes().updateOne({ _id: roomId, lastMessageAt: { $lt: doc.createdAt } }, { $set: { lastMessageAt: doc.createdAt } }).catch(() => {});
    return { message: out(doc) };
  });

  on('msg:vote', { perm: 'react' }, async ({ id, optionId, on: add }) => {
    const m = await messages().findOne({ _id: id });
    if (!m?.poll) throw fail('not_found', 404);
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
    io.emit('msg:upsert', out({ ...m, poll: pollDoc }));
    return {};
  });

  on('msg:edit', { perm: 'sendMessage' }, async ({ id, content }) => {
    const m = await messages().findOne({ _id: id });
    if (!m) throw fail('not_found', 404);
    if (m.authorId !== userId) throw fail('forbidden', 403);
    const text = cleanStr(content, LIMITS.content);
    if (!text && !(m.attachments || []).length) throw fail('empty');
    if (text === m.content) return {};
    // 수정 기록 (최근 20개)
    const editHistory = [...(m.editHistory || []), { content: m.content, at: m.editedAt || m.createdAt }].slice(-20);
    const set = { content: text, editedAt: Date.now(), editHistory };
    await messages().updateOne({ _id: id }, { $set: set });
    io.emit('msg:upsert', out({ ...m, ...set }));
    return {};
  });

  on('msg:delete', {}, async ({ id }) => {
    const m = await messages().findOne({ _id: id });
    if (!m) return {};
    if (m.authorId !== userId && !can(me(), 'deleteAnyMessage')) throw fail('forbidden', 403);
    await messages().deleteOne({ _id: id });
    await deleteFiles((m.attachments || []).map((a) => a.id));
    io.emit('msg:remove', { id, roomId: m.roomId });
    return {};
  });

  on('msg:react', { perm: 'react' }, async ({ id, emoji, on: add }) => {
    if (typeof emoji !== 'string' || !emoji || emoji.length > 16 || /[.$\u0000]/.test(emoji)) throw fail('invalid_emoji');
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
    io.emit('msg:upsert', out(m));
    return {};
  });

  on('msg:pin', { perm: 'pin' }, async ({ id, pinned }) => {
    const set = pinned ? { pinned: true, pinnedBy: userId, pinnedAt: Date.now() } : { pinned: false, pinnedBy: null, pinnedAt: null };
    const m = await messages().findOneAndUpdate({ _id: id }, { $set: set }, { returnDocument: 'after' });
    if (!m) throw fail('not_found', 404);
    io.emit('msg:upsert', out(m));
    return {};
  });

  on('msg:pins', {}, async ({ roomId }) => {
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
    const list = await messages().find({ $and: and }).sort({ createdAt: -1 }).limit(has ? 100 : 50).toArray();
    return { messages: list.map(out) };
  });

  on('room:stats', {}, async ({ roomId }) => {
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
    if (typeof roomId === 'string') socket.broadcast.emit('typing', { roomId, userId });
  });

  // ── 통화 (WebRTC 시그널링) ──
  on('call:join', { perm: 'joinCall' }, async ({ roomId, state }) => {
    if ((await roomType(roomId)) !== 'voice') throw fail('room_not_found', 404);
    leaveCall(socket);
    const peers = callList(roomId);
    if (!calls.has(roomId)) calls.set(roomId, new Map());
    calls.get(roomId).set(socket.id, { sid: socket.id, userId, state: cleanState(state) });
    socketCall.set(socket.id, roomId);
    socket.join(`call:${roomId}`);
    emitCall(roomId);
    return { sid: socket.id, peers };
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
server.listen(config.port, () => console.log(`[server] http://localhost:${config.port}`));
