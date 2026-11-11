// 데이터 계층: 서버(Socket.IO + MongoDB)에 연결되면 실시간으로 동기화하고,
// 서버/DB에 연결할 수 없으면 기기(IndexedDB)에 저장한 뒤 outbox 에 쌓아 두었다가 재연결 시 서버로 보냅니다.
import { config } from './config.js';
import * as idb from './db.js';
import * as api from './api.js';
import * as files from './files.js';
import { OpError, isConnectivity } from './api.js';
import {
  Emitter, uid, kindOf, jwtValid, decodeJwt,
} from './util.js';
import { can } from './permissions.js';

const PAGE = 50;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');

/** 파일 무결성 검사용 SHA-256 (브라우저가 지원하지 않으면 null) */
export async function sha256Of(blob) {
  try {
    if (!crypto.subtle || blob.size > 200 * 1024 * 1024) return null;
    return hex(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer()));
  } catch {
    return null;
  }
}

/** 1:1 대화방 id (server/src/index.js 의 dmIdFor 와 같은 규칙) */
export async function dmIdFor(a, b) {
  const text = new TextEncoder().encode([a, b].sort().join('|'));
  return `dm_${hex(await crypto.subtle.digest('SHA-256', text)).slice(0, 40)}`;
}

export const isChatRoom = (n) => ['text', 'dm', 'code', 'board'].includes(n?.type);
/** 작업 공간이 딸린 방: 코드 작업실, 보드 방 */
export const isWorkspace = (n) => n?.type === 'code' || n?.type === 'board';

const preview = (m) => ({
  authorId: m.authorId, author: m.author, content: (m.content || '').slice(0, 120), attachments: (m.attachments || []).length,
});

export class DataService extends Emitter {
  constructor() {
    super();
    this.mode = 'local'; // local | connecting | online | offline
    this.needsLogin = false;
    this.pendingOps = 0;
    this.lastError = null;
    this.nodes = new Map();
    this.users = new Map();
    this.online = new Set();
    this.calls = {};
    this.me = null;
    this.session = null;
    this.socket = null;
    this.server = null;
    this.retryDelay = 2000;
    this.bc = 'BroadcastChannel' in window ? new BroadcastChannel('chat_site') : null;
    this.bc?.addEventListener('message', (e) => this.#onBroadcast(e.data));
    window.addEventListener('online', () => { if (!this.destroyed && this.mode === 'offline' && !this.needsLogin) this.connect(); });
  }

  get isOnline() { return this.mode === 'online'; }
  get fileTtlMs() { return (this.server?.fileTtlHours ?? config.fileTtlHours) * 3600_000; }
  get maxUploadBytes() { return (this.server?.maxUploadMb ?? config.maxUploadMb) * 1024 * 1024; }
  can(perm) { return can(this.me, perm); }

  /** 아두이노 스케치를 서버의 실제 컴파일러로 컴파일 (서버에 연결되어 있을 때만) */
  async compileSketch(body) {
    if (!this.isOnline || !config.serverUrl || !this.token) throw new OpError('offline');
    return api.compileSketch(config.serverUrl, this.token, body);
  }

  async arduinoLibraries() {
    if (!this.isOnline || !config.serverUrl || !this.token) throw new OpError('offline');
    return api.arduinoLibraries(config.serverUrl, this.token);
  }

  async arduinoLibraryAction(id, action) {
    if (!this.isOnline || !config.serverUrl || !this.token) throw new OpError('offline');
    return api.arduinoLibraryAction(config.serverUrl, this.token, id, action);
  }

  status() {
    return {
      mode: this.mode, needsLogin: this.needsLogin, pendingOps: this.pendingOps, serverUrl: config.serverUrl, error: this.lastError, lastSync: this.lastSync || 0,
    };
  }

  #setStatus(mode, extra = {}) {
    this.mode = mode;
    Object.assign(this, extra);
    this.emit('status', this.status());
  }

  async init(session, onSession) {
    this.session = session;
    this.onSession = onSession;
    this.me = session.user;
    const [nodes, users, outbox] = await Promise.all([idb.all('nodes'), idb.all('users'), idb.outboxAll()]);
    for (const n of nodes) this.nodes.set(n.id, n);
    for (const u of users) this.users.set(u.id, u);
    this.users.set(this.me.id, { ...this.users.get(this.me.id), ...this.me });
    await idb.put('users', this.users.get(this.me.id));
    this.online = new Set([this.me.id]);
    this.pendingOps = outbox.length;
    this.emit('nodes');
    this.emit('users');
    this.connect();
  }

  // ───────────── 연결 관리 ─────────────
  disconnect() {
    clearTimeout(this.retryTimer);
    if (this.socket) {
      this.socket.removeAllListeners();
      this.socket.disconnect();
      this.socket = null;
    }
  }

  destroy() {
    this.disconnect();
    clearTimeout(this.refreshTimer);
    this.destroyed = true;
    try { this.bc?.close(); } catch { /* noop */ }
  }

  async connect() {
    if (this.destroyed) return;
    this.disconnect();
    if (!config.serverUrl) {
      this.server = null;
      this.#setStatus('local', { needsLogin: false, lastError: null });
      return;
    }
    this.#setStatus('connecting');
    try {
      this.server = await api.health(config.serverUrl).catch((e) => { throw new OpError(e.status ? `http_${e.status}` : 'offline'); });
      if (!this.server.db) throw new OpError('db_unavailable');
      const token = await this.#ensureToken();
      await api.loadSocketIo();
      this.#openSocket(token);
    } catch (e) {
      this.lastError = e.code || e.message;
      if (e.code === 'auth_needed') {
        this.#setStatus('offline', { needsLogin: true });
        return;
      }
      this.#setStatus('offline');
      this.#scheduleRetry();
    }
  }

  #scheduleRetry() {
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => this.connect(), this.retryDelay);
    this.retryDelay = Math.min(this.retryDelay * 2, 60_000);
  }

  async #ensureToken(force = false) {
    const s = this.session;
    if (!force && s.serverToken && s.serverUrl === config.serverUrl && jwtValid(s.serverToken)) return s.serverToken;
    const res = await api.exchange(config.serverUrl, s);
    s.serverToken = res.token;
    s.serverUrl = config.serverUrl;
    this.#applyUser(res.user);
    return res.token;
  }

  get token() { return this.session?.serverToken; }

  #openSocket(token) {
    const s = window.io(config.serverUrl, {
      // WebSocket 을 막는 호스팅 환경도 있으므로 polling 으로 연결한 뒤 가능하면 WebSocket 으로 올립니다.
      auth: { token }, transports: ['polling', 'websocket'], tryAllTransports: true, reconnectionDelayMax: 10_000,
    });
    this.socket = s;
    let authRetried = false;
    s.on('connect', () => this.#onConnect());
    s.on('disconnect', () => {
      if (this.socket !== s) return;
      this.online = new Set([this.me.id]);
      this.calls = {};
      this.#setStatus('offline');
      this.emit('presence');
      this.emit('calls');
      this.emit('disconnected');
    });
    s.on('connect_error', async (err) => {
      if (this.socket !== s) return;
      this.lastError = err.message;
      if (err.message === 'unauthorized' && !authRetried) {
        authRetried = true;
        try {
          s.auth.token = await this.#ensureToken(true);
          s.connect();
        } catch (e) {
          this.#setStatus('offline', { needsLogin: e.code === 'auth_needed' });
        }
        return;
      }
      this.#setStatus('offline');
      if (!s.active) { // 서버 미들웨어가 거부 → 자동 재연결이 없으므로 직접 재시도
        this.socket = null;
        s.removeAllListeners();
        this.#scheduleRetry();
      }
    });
    s.on('server:db', ({ ok }) => {
      if (!ok) this.#setStatus('offline');
      else if (s.connected) this.#onConnect();
    });
    s.on('node:upsert', (n) => this.#applyNode(n));
    s.on('node:remove', ({ ids }) => this.#removeNodes(ids));
    s.on('msg:upsert', (m) => this.#applyMessage(m));
    s.on('msg:remove', ({ id, roomId }) => this.#removeMessage(id, roomId));
    s.on('user:upsert', (u) => this.#applyUser(u));
    s.on('presence', ({ userId, online }) => {
      if (online) this.online.add(userId); else this.online.delete(userId);
      this.emit('presence');
    });
    s.on('typing', (e) => this.emit('typing', e));
    s.on('ws:upsert', ({ roomId, items, by }) => this.#applyWs(roomId, items, { by }));
    s.on('ws:remove', ({ roomId, ids }) => this.#removeWs(roomId, ids));
    s.on('ws:focus', (e) => this.emit('wsFocus', e));
    s.on('call:participants', ({ roomId, list }) => {
      if (list.length) this.calls[roomId] = list; else delete this.calls[roomId];
      this.emit('calls', roomId);
    });
    s.on('call:signal', (e) => this.emit('call:signal', e));
  }

  async #onConnect() {
    if (this.syncing) return;
    this.syncing = true;
    try {
      this.#setStatus('connecting');
      const flushed = await this.flushOutbox();
      if (!flushed) throw new OpError('timeout');
      const res = await this.request('sync', {});
      const serverIds = new Set(res.nodes.map((n) => n.id));
      const stale = [...this.nodes.keys()].filter((id) => !serverIds.has(id));
      if (stale.length) await this.#removeNodes(stale);
      this.nodes = new Map(res.nodes.map((n) => [n.id, n]));
      await idb.putMany('nodes', res.nodes);
      for (const u of res.users) this.users.set(u.id, u);
      await idb.putMany('users', res.users);
      this.#applyUser(res.me);
      this.online = new Set(res.online);
      this.calls = res.calls || {};
      this.retryDelay = 2000;
      this.lastSync = Date.now();
      this.serverClockOffset = res.serverTime ? res.serverTime - Date.now() : 0;
      this.#setStatus('online', { needsLogin: false, lastError: null });
      for (const e of ['nodes', 'users', 'presence', 'calls', 'resync']) this.emit(e);
      this.refreshSessionSoon();
    } catch (e) {
      console.warn('[data] sync 실패', e);
      this.#setStatus('offline');
      if (this.socket?.connected) setTimeout(() => this.socket?.connected && this.#onConnect(), this.retryDelay);
    } finally {
      this.syncing = false;
    }
  }

  request(event, payload, timeout = 10_000) {
    const s = this.socket;
    if (!s?.connected) return Promise.reject(new OpError('offline'));
    return s.timeout(timeout).emitWithAck(event, payload).then(
      (res) => {
        if (!res?.ok) throw Object.assign(new OpError(res?.error || 'server_error'), res?.retryAfter ? { retryAfter: res.retryAfter } : {});
        return res;
      },
      (e) => { throw e instanceof OpError ? e : new OpError('timeout'); },
    );
  }

  // ───────────── 세션 갱신 ─────────────
  /** 서버 세션 토큰이 7일 안에 만료되면 미리 새 토큰을 받습니다 (연결될 때와 6시간마다 확인) */
  async refreshSessionSoon() {
    clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => this.refreshSessionSoon(), 6 * 3600_000);
    const exp = decodeJwt(this.token)?.exp;
    if (!this.isOnline || !exp || exp * 1000 - Date.now() > 7 * 86400_000) return;
    try {
      const { token } = await this.request('session:refresh', {});
      this.session.serverToken = token;
      if (this.socket) this.socket.auth.token = token;
      this.onSession?.(this.session);
    } catch (e) {
      console.warn('[data] 세션 갱신 실패', e);
      if (exp * 1000 - Date.now() < 86400_000) this.emit('notice', { text: '로그인이 곧 만료됩니다. 설정에서 로그아웃 후 다시 로그인해 주세요.', type: 'warn' });
    }
  }

  /** 세션 만료 시각 (ms, 없으면 null) */
  get sessionExpiresAt() {
    const exp = decodeJwt(this.token)?.exp;
    return exp ? exp * 1000 : null;
  }

  // ───────────── 동기화 대기열 (outbox) ─────────────
  async flushOutbox() {
    const run = async () => {
      const ops = await idb.outboxAll();
      const done = new Set(); // 중복 메시지 방지: 같은 작업(같은 id)이 두 번 쌓여 있으면 한 번만 보냄
      for (let i = 0; i < ops.length; i++) {
        const op = ops[i];
        const key = op.payload?.id && ['msg:send', 'upload', 'dm:open', 'node:create'].includes(op.op) ? `${op.op}:${op.payload.id}` : null;
        if (op.op === 'ws:put' && op.payload?.item) delete op.payload.item.baseRev; // 오프라인에서 고친 파일: 다시 연결됐을 때 버전 비교 없이 반영 (이전 내용은 버전 기록에)
        try {
          if (key && done.has(key)) { await idb.del('outbox', op.seq); continue; }
          if (op.op === 'upload') await this.#uploadStored(op.payload.id);
          else {
            const res = await this.request(op.op, op.payload);
            if (res?.conflict) this.emit('notice', { text: '다른 기기에서 먼저 수정한 메시지를 덮어썼습니다. 이전 내용은 수정 기록에서 볼 수 있어요.', type: 'warn' });
          }
          if (key) done.add(key);
          await idb.del('outbox', op.seq);
        } catch (e) {
          if (e.code === 'rate_limited') { // 요청 제한: 잠시 기다렸다가 같은 작업을 다시 보냄
            await sleep(Math.min(e.retryAfter || 1000, 10_000));
            i -= 1;
            continue;
          }
          if (isConnectivity(e)) {
            this.pendingOps = ops.length - i;
            this.emit('status', this.status());
            return false;
          }
          console.warn('[data] 동기화할 수 없는 작업을 버립니다', op, e);
          await idb.del('outbox', op.seq);
          this.dropped = [...(this.dropped || []), { op: op.op, error: e.code, at: Date.now() }].slice(-20);
          if (op.op === 'msg:send') await this.#markFailed(op.payload.id, e.code);
          // 충돌: 그 사이 다른 곳에서 지워진 메시지를 수정·반응·고정하려 함 → 기기 사본도 지움
          if (e.code === 'not_found' && ['msg:edit', 'msg:react', 'msg:pin', 'msg:vote'].includes(op.op)) {
            await this.#removeMessage(op.payload.id, null, true);
            this.emit('notice', { text: '오프라인일 때 바꾼 메시지가 그 사이 삭제되어 변경을 적용하지 못했습니다.', type: 'warn' });
          }
        }
      }
      this.pendingOps = 0;
      this.#post({ t: 'outbox', count: 0 });
      this.emit('status', this.status());
      return true;
    };
    return navigator.locks ? navigator.locks.request('cs-outbox', run) : run();
  }

  async #enqueue(op, payload) {
    await idb.outboxAdd({ op, payload });
    this.pendingOps += 1;
    this.#post({ t: 'outbox', count: this.pendingOps });
    this.emit('status', this.status());
  }

  /** 온라인이면 서버에 요청하고, 연결 문제면 기기에 적용 + outbox 에 저장 */
  async #mutate(event, payload, localApply) {
    if (this.isOnline) {
      try {
        return await this.request(event, payload);
      } catch (e) {
        if (!isConnectivity(e)) throw e;
      }
    }
    await localApply();
    await this.#enqueue(event, payload);
    return null;
  }

  // ───────────── 탭 간 동기화 (로컬 모드) ─────────────
  #post(msg) {
    try { this.bc?.postMessage(msg); } catch { /* noop */ }
  }

  #onBroadcast(d) {
    if (!d || !this.me) return;
    switch (d.t) {
      case 'node': this.nodes.set(d.node.id, d.node); this.emit('nodes'); break;
      case 'nodeRemove': for (const id of d.ids) this.nodes.delete(id); this.emit('nodes'); this.emit('nodesRemoved', d.ids); break;
      case 'msg': this.emit('message', d.msg, { isNew: d.isNew }); break;
      case 'msgRemove': this.emit('messageRemoved', { id: d.id, roomId: d.roomId }); break;
      case 'user': this.users.set(d.user.id, d.user); this.emit('users'); break;
      case 'outbox': this.pendingOps = d.count; this.emit('status', this.status()); break;
      case 'ws': this.emit('ws', d.roomId, { items: d.items, by: d.by }); break;
      case 'wsRemove': this.emit('ws', d.roomId, { removed: d.ids }); break;
      default:
    }
  }

  // ───────────── 내부 적용 ─────────────
  async #applyNode(n, broadcast = false) {
    this.nodes.set(n.id, n);
    await idb.put('nodes', n);
    this.emit('nodes');
    if (broadcast) this.#post({ t: 'node', node: n });
  }

  descendants(id) {
    const ids = [id];
    for (let i = 0; i < ids.length; i++) {
      for (const n of this.nodes.values()) if (n.parentId === ids[i]) ids.push(n.id);
    }
    return ids;
  }

  async #removeNodes(ids, broadcast = false) {
    for (const id of ids) {
      const msgs = await idb.roomAll(id);
      const att = msgs.flatMap((m) => (m.attachments || []).map((a) => a.id));
      await idb.delMany('messages', msgs.map((m) => m.id));
      await idb.delMany('blobs', att);
      await idb.delMany('wsitems', (await idb.wsRoom(id)).map((x) => x.id));
      files.forget(att);
      this.nodes.delete(id);
    }
    await idb.delMany('nodes', ids);
    this.emit('nodes');
    this.emit('nodesRemoved', ids);
    if (broadcast) this.#post({ t: 'nodeRemove', ids });
  }

  async #applyMessage(m, broadcast = false) {
    const prev = await idb.get('messages', m.id);
    await idb.put('messages', m);
    const room = this.nodes.get(m.roomId);
    if (room && (room.lastMessageAt || 0) < m.createdAt) {
      room.lastMessageAt = m.createdAt;
      idb.put('nodes', room);
    }
    if (!this.users.has(m.authorId) && m.author) {
      const u = { id: m.authorId, provider: m.author.provider, nickname: m.author.nickname, avatar: null };
      this.users.set(u.id, u);
      idb.put('users', u);
      this.emit('users');
    }
    const isNew = !prev;
    this.emit('message', m, { isNew, prev });
    if (broadcast) this.#post({ t: 'msg', msg: m, isNew });
  }

  async #removeMessage(id, roomId, broadcast = false) {
    const m = await idb.get('messages', id);
    if (m) {
      const att = (m.attachments || []).map((a) => a.id);
      await idb.delMany('blobs', att);
      files.forget(att);
      await idb.del('messages', id);
    }
    this.emit('messageRemoved', { id, roomId: roomId || m?.roomId });
    if (broadcast) this.#post({ t: 'msgRemove', id, roomId: roomId || m?.roomId });
  }

  #applyUser(u, broadcast = false) {
    if (!u?.id) return;
    const merged = { ...this.users.get(u.id), ...u };
    this.users.set(u.id, merged);
    idb.put('users', merged);
    if (u.id === this.me?.id) {
      this.me = { ...this.me, ...u };
      this.session.user = this.me;
      this.onSession?.(this.session);
      this.emit('me', this.me);
    }
    this.emit('users');
    if (broadcast) this.#post({ t: 'user', user: merged });
  }

  async #markFailed(id, code = 'failed') {
    const m = await idb.get('messages', id);
    if (m) await this.#applyMessage({ ...m, pending: false, failed: code }, true);
  }

  // ───────────── 폴더 / 채팅방 / 통화방 ─────────────
  children(parentId = null) {
    return [...this.nodes.values()]
      .filter((n) => n.type !== 'dm' && (n.parentId ?? null) === parentId)
      .sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.createdAt - b.createdAt);
  }

  // ───────────── 1:1 대화 ─────────────
  /** 1:1 대화방 목록 (최근 대화 순) */
  dmList() {
    return [...this.nodes.values()].filter((n) => n.type === 'dm').sort((a, b) => (b.lastMessageAt || b.createdAt) - (a.lastMessageAt || a.createdAt));
  }

  /** 1:1 대화 상대 */
  dmPartner(node) {
    const id = (node?.members || []).find((x) => x !== this.me.id) || node?.members?.[0];
    return this.users.get(id) || { id, nickname: '알 수 없음', provider: 'guest' };
  }

  /** 화면에 보일 방 이름 (1:1 대화는 상대 닉네임) */
  roomLabel(node) {
    if (!node) return '';
    return node.type === 'dm' ? this.dmPartner(node).nickname : node.name;
  }

  /** 상대와의 1:1 대화방을 열거나 만듦 (오프라인이면 기기에 만들고 나중에 서버와 맞춤) */
  async openDm(userId) {
    if (!this.can('directMessage')) throw new OpError('forbidden');
    if (!userId || userId === this.me.id) throw new OpError('invalid_user');
    const id = await dmIdFor(this.me.id, userId);
    if (this.nodes.has(id)) return this.nodes.get(id);
    const t = Date.now();
    const node = {
      id, type: 'dm', name: '', parentId: null, order: 0, members: [this.me.id, userId].sort(), createdBy: this.me.id, createdAt: t, updatedAt: t, lastMessageAt: 0,
    };
    const res = await this.#mutate('dm:open', { userId }, () => this.#applyNode(node, true));
    if (res?.node) await this.#applyNode(res.node);
    return res?.node || node;
  }

  async createNode({ type, name, parentId = null, topic = '', ...extra }) {
    if (!this.can('manageNodes')) throw new OpError('forbidden');
    const sib = this.children(parentId);
    const node = {
      id: uid(), type, name: name.trim().slice(0, 100), parentId, topic: topic.trim().slice(0, 300),
      order: (sib.at(-1)?.order ?? 0) + 1, createdBy: this.me.id, createdAt: Date.now(), updatedAt: Date.now(), lastMessageAt: 0,
      ...extra,
    };
    const res = await this.#mutate('node:create', node, () => this.#applyNode(node, true));
    if (res?.node) await this.#applyNode(res.node);
    return res?.node || node;
  }

  async updateNode(id, patch) {
    if (!this.can('manageNodes')) throw new OpError('forbidden');
    const node = this.nodes.get(id);
    if (!node) throw new OpError('not_found');
    if (patch.parentId !== undefined && patch.parentId !== null && this.descendants(id).includes(patch.parentId)) {
      throw new OpError('invalid_move');
    }
    const res = await this.#mutate('node:update', { id, ...patch }, () => this.#applyNode({ ...node, ...patch, updatedAt: Date.now() }, true));
    if (res?.node) await this.#applyNode(res.node);
  }

  /** target 앞(before) / 뒤(after) / 안(inside) 으로 이동 */
  async moveNode(id, targetId, where) {
    const target = targetId ? this.nodes.get(targetId) : null;
    if (where === 'inside' || !target) {
      const parentId = target ? target.id : null;
      const sib = this.children(parentId).filter((n) => n.id !== id);
      return this.updateNode(id, { parentId, order: (sib.at(-1)?.order ?? 0) + 1 });
    }
    const parentId = target.parentId ?? null;
    const sib = this.children(parentId).filter((n) => n.id !== id);
    const i = sib.findIndex((n) => n.id === target.id);
    const a = where === 'before' ? sib[i - 1] : sib[i];
    const b = where === 'before' ? sib[i] : sib[i + 1];
    const order = a && b ? (a.order + b.order) / 2 : a ? a.order + 1 : b.order - 1;
    return this.updateNode(id, { parentId, order });
  }

  async deleteNode(id) {
    if (!this.can('manageNodes')) throw new OpError('forbidden');
    const ids = this.descendants(id);
    const res = await this.#mutate('node:delete', { id }, () => this.#removeNodes(ids, true));
    if (res?.ids) await this.#removeNodes(res.ids);
  }

  // ───────────── 메시지 ─────────────
  async listMessages(roomId, { before } = {}) {
    if (this.isOnline) {
      try {
        const res = await this.request('msg:list', { roomId, before, limit: PAGE });
        await this.#reconcile(roomId, res.messages, before);
      } catch (e) {
        if (!isConnectivity(e)) throw e;
      }
    }
    const list = await idb.roomMessages(roomId, { before: before ?? Infinity, limit: PAGE });
    return { messages: list, hasMore: list.length >= PAGE };
  }

  async #reconcile(roomId, msgs, before) {
    const lower = msgs.length < PAGE ? -Infinity : msgs[0].createdAt;
    const cached = await idb.roomMessages(roomId, { before: before ?? Infinity, after: lower, limit: 1e6 });
    const ids = new Set(msgs.map((m) => m.id));
    const stale = cached.filter((m) => !m.pending && !m.failed && !ids.has(m.id)).map((m) => m.id);
    await idb.delMany('messages', stale);
    await idb.putMany('messages', msgs);
  }

  getMessage(id) {
    return idb.get('messages', id);
  }

  /**
   * 메시지 보내기. kind: 'text' | 'me' | 'poll'
   * poll: { options: [텍스트], multi }, spoilers: [첨부 인덱스], forward: 전달할 원본 메시지 객체
   */
  async sendMessage(roomId, {
    content = '', files: fileList = [], replyTo = null, kind = 'text', poll = null, spoilers = [], forward = null, stored = [],
  }) {
    if (!this.can('sendMessage')) throw new OpError('forbidden');
    const room = this.nodes.get(roomId);
    if (room?.readonly && !this.can('manageNodes')) throw new OpError('readonly');
    if (kind === 'poll' && !this.can('react')) throw new OpError('forbidden');
    let text = content.trim().slice(0, 4000);
    if (forward) text = forward.kind === 'poll' ? `📊 ${forward.content}` : forward.content || '';
    if (!text && !fileList.length && !stored.length && !forward?.attachments?.length) return null;
    for (const f of fileList) {
      if (f.size > this.maxUploadBytes) throw new OpError('file_too_large');
    }
    const createdAt = Date.now();
    const attachments = forward ? (forward.attachments || []).map((a) => ({ ...a, local: false })) : fileList.map((f, i) => ({
      id: uid(), name: f.name || 'file', size: f.size, mime: f.type || 'application/octet-stream', kind: kindOf(f.type), expiresAt: createdAt + this.fileTtlMs, local: true,
      ...(spoilers.includes(i) ? { spoiler: true } : {}),
    })).concat(stored.map((f) => ({ ...f, local: false, stored: true })));
    // 화면에 먼저 보여주고(저장소 쓰기를 기다리지 않음), 저장은 뒤에서 진행
    fileList.forEach((f, i) => files.remember(attachments[i], f));
    const reply = replyTo && typeof replyTo === 'object' ? replyTo : replyTo ? await idb.get('messages', replyTo) : null;
    const msg = {
      id: uid(),
      roomId,
      kind: forward ? 'text' : kind,
      authorId: this.me.id,
      author: { nickname: this.me.nickname, provider: this.me.provider },
      content: text,
      attachments,
      ...(kind === 'poll' && poll ? {
        poll: { multi: !!poll.multi, options: poll.options.map((o, i) => ({ id: `o${i + 1}`, text: o.trim().slice(0, 100), votes: [] })) },
      } : {}),
      ...(forward ? {
        forwardOf: forward.id,
        forwarded: {
          messageId: forward.forwarded?.messageId || forward.id,
          roomId: forward.roomId, roomName: this.nodes.get(forward.roomId)?.name || '', authorId: forward.authorId, authorNickname: (this.user(forward.authorId) || forward.author)?.nickname || '', createdAt: forward.createdAt,
        },
      } : {}),
      replyTo: reply ? reply.id : null,
      replyPreview: reply ? preview(reply) : null,
      reactions: {},
      pinned: false,
      createdAt,
      editedAt: null,
      pending: true,
    };
    this.emit('message', msg, { isNew: true });
    this.#post({ t: 'msg', msg, isNew: true });
    const blobsSaved = Promise.all(fileList.map((f, i) => files.storeBlob(attachments[i], f)));
    await this.#persistMessage(msg);
    this.#deliver(msg, blobsSaved);
    return msg;
  }

  async #persistMessage(m) {
    await idb.put('messages', m);
    const room = this.nodes.get(m.roomId);
    if (room && (room.lastMessageAt || 0) < m.createdAt) {
      room.lastMessageAt = m.createdAt;
      idb.put('nodes', room);
    }
  }

  /** 첨부 업로드 → 메시지 전송. 연결 문제면 outbox 에 저장 */
  async #deliver(msg, blobsSaved = null) {
    const payload = {
      id: msg.id,
      roomId: msg.roomId,
      content: msg.content,
      attachments: msg.attachments.filter((a) => a.local).map((a) => a.id),
      replyTo: msg.replyTo,
      createdAt: msg.createdAt,
      kind: msg.kind,
      ...(msg.poll ? { poll: { multi: msg.poll.multi, options: msg.poll.options.map((o) => o.text) } } : {}),
      spoilers: msg.attachments.filter((a) => a.spoiler).map((a) => a.id),
      ...(msg.forwardOf ? { forward: { messageId: msg.forwardOf } } : {}),
    };
    payload.attachments.push(...msg.attachments.filter((a) => a.stored).map((a) => a.id));
    const remaining = msg.attachments.filter((a) => a.local).map((a) => a.id);
    if (this.isOnline) {
      try {
        while (remaining.length) {
          await this.#uploadStored(remaining[0], (p) => this.emit('progress', { msgId: msg.id, attId: remaining[0], p }));
          remaining.shift();
        }
        await this.request('msg:send', payload);
        blobsSaved?.then(() => msg.attachments.forEach((a) => files.release(a.id)));
        return;
      } catch (e) {
        if (e.code === 'rate_limited') {
          // 요청 제한: 실패로 처리하지 않고 대기열에 넣어 잠시 뒤 자동으로 다시 보냄
          setTimeout(() => this.isOnline && this.flushOutbox(), Math.min(e.retryAfter || 2000, 10_000));
        } else if (!isConnectivity(e)) {
          await this.#markFailed(msg.id, e.code);
          this.emit('error', e);
          return;
        }
      }
    }
    await blobsSaved; // 오프라인 전송용 outbox 는 기기 저장소의 파일을 사용
    msg.attachments.forEach((a) => files.release(a.id));
    for (const id of remaining) await this.#enqueue('upload', { id });
    await this.#enqueue('msg:send', payload);
  }

  async #uploadStored(id, onProgress) {
    const rec = files.memBlob(id) || (await idb.get('blobs', id));
    if (!rec?.blob) throw new OpError('missing_file');
    if (!this.socket?.connected) throw new OpError('offline');
    const sha256 = await sha256Of(rec.blob);
    return api.upload(config.serverUrl, this.token, rec.blob, {
      id, name: rec.name, onProgress, sha256,
    });
  }

  async retryMessage(id) {
    const m = await idb.get('messages', id);
    if (!m?.failed) return;
    const upd = { ...m, failed: null, pending: true, createdAt: Date.now() };
    await idb.del('messages', id);
    await this.#applyMessage(upd, true);
    this.#deliver(upd);
  }

  async editMessage(id, content) {
    const m = await idb.get('messages', id);
    if (!m || m.authorId !== this.me.id || m.failed || (m.pending && this.isOnline)) throw new OpError('forbidden');
    const text = content.trim().slice(0, 4000);
    if (!text && !m.attachments?.length) throw new OpError('empty');
    if (text === m.content) return;
    const base = m.editedAt || m.createdAt; // 수정 충돌 확인용: 내가 보고 있던 버전
    const editHistory = [...(m.editHistory || []), { content: m.content, at: base }].slice(-20);
    const res = await this.#mutate('msg:edit', { id, content: text, base }, () => this.#applyMessage({
      ...m, content: text, editedAt: Date.now(), editHistory,
    }, true));
    if (res?.conflict) this.emit('notice', { text: '다른 기기에서 먼저 수정된 메시지였습니다. 이전 내용은 수정 기록에서 볼 수 있어요.', type: 'warn' });
  }

  /** 투표하기 / 취소 */
  async vote(id, optionId) {
    if (!this.can('react')) throw new OpError('forbidden');
    const m = await idb.get('messages', id);
    if (!m?.poll || m.failed || (m.pending && this.isOnline)) return;
    const me = this.me.id;
    const on = !m.poll.options.find((o) => o.id === optionId)?.votes.includes(me);
    const options = m.poll.options.map((o) => {
      if (o.id === optionId) return { ...o, votes: on ? [...o.votes, me] : o.votes.filter((v) => v !== me) };
      if (on && !m.poll.multi) return { ...o, votes: o.votes.filter((v) => v !== me) };
      return o;
    });
    await this.#mutate('msg:vote', { id, optionId, on }, () => this.#applyMessage({ ...m, poll: { ...m.poll, options } }, true));
  }

  /** 방 통계 (메시지 수, 고정 수, 참여자 수) */
  async roomStats(roomId) {
    if (this.isOnline) {
      try {
        const r = await this.request('room:stats', { roomId });
        return { count: r.count, pins: r.pins, authors: r.authors };
      } catch (e) {
        if (!isConnectivity(e)) throw e;
      }
    }
    const all = await idb.roomAll(roomId);
    return { count: all.length, pins: all.filter((m) => m.pinned).length, authors: new Set(all.map((m) => m.authorId)).size, local: true };
  }

  /** 접속 상태: online | idle | dnd | offline (나 자신은 invisible 도 반환) */
  presenceOf(userId) {
    const u = this.users.get(userId);
    if (userId === this.me?.id) return this.isOnline ? (this.me.presence || 'online') : 'offline';
    if (!this.online.has(userId)) return 'offline';
    const p = u?.presence || 'online';
    return p === 'invisible' ? 'offline' : p;
  }

  async deleteMessage(id) {
    const m = await idb.get('messages', id);
    if (!m) return;
    if (m.authorId !== this.me.id && !this.can('deleteAnyMessage')) throw new OpError('forbidden');
    if (m.pending || m.failed) {
      // 아직 서버에 보내지 않은 메시지 → outbox 에서 제거
      const ops = await idb.outboxAll();
      const att = new Set((m.attachments || []).map((a) => a.id));
      const drop = ops.filter((o) => (o.op === 'msg:send' && o.payload.id === id) || (o.op === 'upload' && att.has(o.payload.id)));
      await idb.delMany('outbox', drop.map((o) => o.seq));
      this.pendingOps = Math.max(0, this.pendingOps - drop.length);
      this.emit('status', this.status());
      return this.#removeMessage(id, m.roomId, true);
    }
    await this.#mutate('msg:delete', { id }, () => this.#removeMessage(id, m.roomId, true));
  }

  /** 여러 메시지 한 번에 삭제. 지울 권한이 있는 것만 지우고 지운 개수를 돌려줌 */
  async deleteMessages(ids) {
    const list = (await Promise.all(ids.map((id) => idb.get('messages', id)))).filter(Boolean);
    const mayDelete = (m) => m.authorId === this.me.id || (this.nodes.get(m.roomId)?.type !== 'dm' && this.can('deleteAnyMessage'));
    const ok = list.filter(mayDelete);
    const unsent = ok.filter((m) => m.pending || m.failed);
    for (const m of unsent) await this.deleteMessage(m.id);
    const sent = ok.filter((m) => !m.pending && !m.failed);
    for (let i = 0; i < sent.length; i += 100) {
      const chunk = sent.slice(i, i + 100);
      await this.#mutate('msg:deleteMany', { ids: chunk.map((m) => m.id) }, async () => {
        for (const m of chunk) await this.#removeMessage(m.id, m.roomId, true);
      });
    }
    return ok.length;
  }

  async toggleReaction(id, emoji) {
    if (!this.can('react')) throw new OpError('forbidden');
    const m = await idb.get('messages', id);
    if (!m || m.failed || (m.pending && this.isOnline)) return;
    const users = m.reactions?.[emoji] || [];
    const on = !users.includes(this.me.id);
    const reactions = { ...m.reactions };
    const next = on ? [...users, this.me.id] : users.filter((u) => u !== this.me.id);
    if (next.length) reactions[emoji] = next; else delete reactions[emoji];
    await this.#mutate('msg:react', { id, emoji, on }, () => this.#applyMessage({ ...m, reactions }, true));
  }

  async setPinned(id, pinned) {
    if (!this.can('pin')) throw new OpError('forbidden');
    const m = await idb.get('messages', id);
    if (!m || m.failed || (m.pending && this.isOnline)) return;
    const patch = pinned ? { pinned: true, pinnedBy: this.me.id, pinnedAt: Date.now() } : { pinned: false, pinnedBy: null, pinnedAt: null };
    await this.#mutate('msg:pin', { id, pinned }, () => this.#applyMessage({ ...m, ...patch }, true));
  }

  async listPins(roomId) {
    if (this.isOnline) {
      try {
        const res = await this.request('msg:pins', { roomId });
        await idb.putMany('messages', res.messages);
        return res.messages;
      } catch (e) {
        if (!isConnectivity(e)) throw e;
      }
    }
    return (await idb.roomAll(roomId)).filter((m) => m.pinned).sort((a, b) => (b.pinnedAt || 0) - (a.pinnedAt || 0));
  }

  /**
   * 검색. { roomId(null 이면 전체 방), q, from(userId), has(image|video|audio|file|media|link|pin|poll), before, after(ms), mentions }
   */
  async search(f) {
    const filter = typeof f === 'string' ? { q: f } : { ...f };
    filter.q = (filter.q || '').trim();
    const any = filter.q || filter.from || filter.has || filter.before || filter.after || filter.mentions;
    if (!any) return [];
    if (this.isOnline) {
      try {
        return (await this.request('msg:search', filter)).messages;
      } catch (e) {
        if (!isConnectivity(e)) throw e;
      }
    }
    const lower = filter.q.toLowerCase();
    const mentionRe = filter.mentions ? new RegExp(`(^|\\s)@(${this.me.nickname.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}|everyone|here)(?=\\s|$)`) : null;
    const pool = filter.roomId ? await idb.roomAll(filter.roomId) : await idb.all('messages');
    const kinds = (m) => (m.attachments || []).map((a) => a.kind);
    return pool.filter((m) => {
      if (lower && !(m.content || '').toLowerCase().includes(lower) && !(m.attachments || []).some((a) => a.name.toLowerCase().includes(lower))) return false;
      if (filter.from && m.authorId !== filter.from) return false;
      if (filter.before && !(m.createdAt < filter.before)) return false;
      if (filter.after && !(m.createdAt >= filter.after)) return false;
      if (mentionRe && !mentionRe.test(m.content || '')) return false;
      const h = filter.has;
      if (['image', 'video', 'audio', 'file'].includes(h) && !kinds(m).includes(h)) return false;
      if (h === 'media' && !kinds(m).some((k) => k === 'image' || k === 'video')) return false;
      if (h === 'link' && !/https?:\/\//i.test(m.content || '')) return false;
      if (h === 'pin' && !m.pinned) return false;
      if (h === 'poll' && m.kind !== 'poll') return false;
      return true;
    }).sort((a, b) => b.createdAt - a.createdAt).slice(0, filter.has ? 100 : 50);
  }

  /** 연결 진단: 전송 방식, 서버 왕복 시간, 서버↔MongoDB 시간 */
  async diagnose() {
    if (!this.isOnline) return null;
    const t0 = performance.now();
    const res = await this.request('latency', {}, 5000).catch(() => null);
    if (!res) return null;
    return { rtt: Math.round(performance.now() - t0), dbMs: res.dbMs, transport: this.socket?.io?.engine?.transport?.name || '?' };
  }

  sendTyping(roomId) {
    if (this.isOnline) this.socket.emit('typing', { roomId });
  }

  async fetchFile(id) {
    if (!this.isOnline) throw new OpError('offline');
    const { blob, sha256 } = await api.fetchFile(config.serverUrl, this.token, id);
    // 파일 무결성: 서버가 알려 준 해시와 받은 내용이 다르면 (전송 중 손상) 저장하지 않음
    if (sha256) {
      const got = await sha256Of(blob);
      if (got && got !== sha256) throw new OpError('integrity_failed');
    }
    return blob;
  }

  // ───────────── 내 보관함 (만료 없는 개인 파일) ─────────────
  async listStoredFiles() {
    return this.request('files:mine', {});
  }

  /** 채팅 첨부파일을 만료 전에 보관함으로 복사 */
  async keepFile(att) {
    if (!this.can('storage')) throw new OpError('forbidden');
    return (await this.request('file:keep', { id: att.id }, 60_000)).file;
  }

  async uploadToStorage(file, onProgress) {
    if (!this.can('storage')) throw new OpError('forbidden');
    if (!this.isOnline) throw new OpError('offline');
    const id = uid();
    const meta = await api.upload(config.serverUrl, this.token, file, {
      id, name: file.name, onProgress, keep: true, sha256: await sha256Of(file),
    });
    await idb.put('blobs', { id: meta.id, blob: file, name: meta.name, mime: meta.mime, savedAt: Date.now(), stored: true });
    return meta;
  }

  async removeStoredFile(id) {
    await this.request('file:remove', { id });
    await idb.del('blobs', id);
    files.forget([id]);
  }

  // ───────────── 작업 공간 (코드 프로젝트 · 보드 카드) ─────────────
  async #applyWs(roomId, items, { by, broadcast } = {}) {
    await idb.putMany('wsitems', items);
    this.emit('ws', roomId, { items, by });
    if (broadcast) this.#post({ t: 'ws', roomId, items, by });
  }

  async #removeWs(roomId, ids, broadcast = false) {
    await idb.delMany('wsitems', ids);
    this.emit('ws', roomId, { removed: ids });
    if (broadcast) this.#post({ t: 'wsRemove', roomId, ids });
  }

  /** 방의 작업 공간 항목 전체. 온라인이면 서버 기준으로 기기 사본을 맞춤 (아직 보내지 못한 변경은 유지) */
  async listWs(roomId) {
    if (this.isOnline) {
      try {
        const res = await this.request('ws:list', { roomId });
        const pending = new Set((await idb.outboxAll()).filter((o) => o.op.startsWith('ws:')).flatMap((o) => [o.payload.item?.id, ...(o.payload.items || []).map((i) => i.id)]));
        const ids = new Set(res.items.map((i) => i.id));
        const local = await idb.wsRoom(roomId);
        await idb.delMany('wsitems', local.filter((i) => !ids.has(i.id) && !pending.has(i.id)).map((i) => i.id));
        await idb.putMany('wsitems', res.items.filter((i) => !pending.has(i.id)));
      } catch (e) {
        if (!isConnectivity(e)) throw e;
      }
    }
    return idb.wsRoom(roomId);
  }

  /** 항목 저장 (만들기 · 고치기). patch 에 id 와 kind 는 꼭 있어야 함. 반환: 저장된 항목 */
  async putWs(roomId, patch) {
    if (!this.can('editWorkspace')) throw new OpError('forbidden');
    const prev = await idb.get('wsitems', patch.id);
    const t = Date.now();
    const local = {
      roomId, parentId: null, name: '', order: t, createdBy: this.me.id, createdAt: t, rev: 0, ...prev, ...patch, updatedBy: this.me.id, updatedAt: t,
    };
    delete local.baseRev;
    const res = await this.#mutate('ws:put', { roomId, item: { ...patch, ...(patch.content !== undefined && prev?.rev ? { baseRev: prev.rev } : {}) } }, () => this.#applyWs(roomId, [local], { by: this.me.id, broadcast: true }));
    if (res?.item) await this.#applyWs(roomId, [res.item], { by: this.me.id });
    if (res?.conflict) this.emit('notice', { text: '다른 사람이 먼저 고친 파일을 덮어썼습니다. 이전 내용은 버전 기록에서 되살릴 수 있어요.', type: 'warn' });
    return res?.item || local;
  }

  async putWsMany(roomId, items) {
    if (!this.can('editWorkspace')) throw new OpError('forbidden');
    const t = Date.now();
    const out = [];
    for (let i = 0; i < items.length; i += 200) {
      const chunk = items.slice(i, i + 200);
      const local = chunk.map((it, k) => ({
        roomId, parentId: null, name: '', order: t + i + k, createdBy: this.me.id, createdAt: t, rev: 0, updatedBy: this.me.id, updatedAt: t, ...it,
      }));
      const res = await this.#mutate('ws:putMany', { roomId, items: chunk.map((it, k) => ({ order: t + i + k, ...it })) }, () => this.#applyWs(roomId, local, { by: this.me.id, broadcast: true }));
      if (res?.items) await this.#applyWs(roomId, res.items, { by: this.me.id });
      out.push(...(res?.items || local));
    }
    return out;
  }

  /** 삭제 (하위 항목 포함) */
  async deleteWs(roomId, ids) {
    if (!this.can('editWorkspace')) throw new OpError('forbidden');
    const all = await idb.wsRoom(roomId);
    const del = [...ids];
    for (let i = 0; i < del.length; i++) for (const x of all) if (x.parentId === del[i] && !del.includes(x.id)) del.push(x.id);
    const res = await this.#mutate('ws:delete', { roomId, ids }, () => this.#removeWs(roomId, del, true));
    if (res?.ids) await this.#removeWs(roomId, res.ids);
  }

  async wsHistory(roomId, id) {
    if (!this.isOnline) return [];
    return (await this.request('ws:history', { roomId, id })).history;
  }

  sendWsFocus(roomId, id) {
    if (this.isOnline) this.socket.emit('ws:focus', { roomId, id });
  }

  /** 대화를 AI 로 분석해 보드 카드 초안 받기 (저장은 사용자가 승인한 뒤 putWsMany 로) */
  async aiBoard(roomId, { messageIds, view }) {
    if (!this.isOnline) throw new OpError('offline');
    return this.request('ai:board', { roomId, messageIds, view }, 120_000);
  }

  // ───────────── AI 도우미 ─────────────
  get aiEnabled() { return !!this.server?.features?.ai && this.can('useAi'); }

  async askAi(roomId, { mode = 'ask', question = '' } = {}) {
    if (!this.isOnline) throw new OpError('offline');
    return this.request('ai:ask', { roomId, mode, question }, 120_000);
  }

  // ───────────── 서버 상태 · 데이터 복구 ─────────────
  /** API · DB · WebSocket 상태 (설정 → 서버 상태) */
  async serverStatus() {
    const out = { mode: this.mode, pendingOps: this.pendingOps, lastSync: this.lastSync || 0, serverUrl: config.serverUrl, sessionExpiresAt: this.sessionExpiresAt };
    if (!config.serverUrl) return out;
    const t0 = performance.now();
    try {
      out.health = await api.health(config.serverUrl);
      out.apiMs = Math.round(performance.now() - t0);
    } catch (e) {
      out.apiError = e.code || 'offline';
      return out;
    }
    if (this.token) {
      try { out.status = await api.status(config.serverUrl, this.token); } catch (e) { out.statusError = e.code; }
    }
    if (this.isOnline) out.ws = await this.diagnose();
    return out;
  }

  async outboxList() {
    return idb.outboxAll();
  }

  async discardOutbox(seq) {
    const op = (await idb.outboxAll()).find((o) => o.seq === seq);
    if (!op) return;
    await idb.del('outbox', seq);
    if (op.op === 'msg:send') await this.#markFailed(op.payload.id, 'discarded');
    this.pendingOps = Math.max(0, this.pendingOps - 1);
    this.emit('status', this.status());
  }

  /** 기기 데이터 검사: 없어진 방의 메시지, 전송 실패 메시지, 주인 없는 파일 사본 */
  async inspectLocal({ fix = false } = {}) {
    const [msgs, blobs, outbox] = await Promise.all([idb.all('messages'), idb.all('blobs'), idb.outboxAll()]);
    const orphanMsgs = msgs.filter((m) => !this.nodes.has(m.roomId));
    const failed = msgs.filter((m) => m.failed);
    const used = new Set(msgs.flatMap((m) => (m.attachments || []).map((a) => a.id)));
    const keep = new Set(outbox.filter((o) => o.op === 'upload').map((o) => o.payload.id));
    const orphanBlobs = blobs.filter((b) => !used.has(b.id) && !keep.has(b.id) && !b.stored);
    if (fix && this.mode !== 'local') {
      await idb.delMany('messages', orphanMsgs.map((m) => m.id));
      await idb.delMany('blobs', orphanBlobs.map((b) => b.id));
      files.forget(orphanBlobs.map((b) => b.id));
    }
    return {
      messages: msgs.length, rooms: this.nodes.size, orphanMsgs: orphanMsgs.length, failed: failed.length, blobs: blobs.length, orphanBlobs: orphanBlobs.length, outbox: outbox.length, local: this.mode === 'local',
    };
  }

  /** 서버에서 다시 받기: 기기에 캐시된 메시지(보내지 않은 것 제외)를 지우고 서버 내용으로 다시 채움 */
  async resyncFromServer() {
    if (!this.isOnline) throw new OpError('offline');
    const msgs = await idb.all('messages');
    await idb.delMany('messages', msgs.filter((m) => !m.pending && !m.failed).map((m) => m.id));
    await this.#onConnect();
  }

  /** 백업: 이 기기에 저장된 방 · 메시지 · 사용자 · 대기 작업 · 개인 설정 (파일 내용 제외) */
  async exportBackup() {
    const [nodes, messages, users, outbox] = await Promise.all([idb.all('nodes'), idb.all('messages'), idb.all('users'), idb.outboxAll()]);
    const personalKeys = Object.keys(localStorage).filter((k) => k.startsWith('cs.') && !['cs.session'].includes(k));
    const personal = Object.fromEntries(personalKeys.map((k) => [k, localStorage.getItem(k)]));
    return {
      format: 'chat_site-backup', version: 1, exportedAt: Date.now(), user: { id: this.me.id, nickname: this.me.nickname }, nodes, messages, users, outbox, personal,
    };
  }

  /** 백업 복원: 기기에 없는 메시지 · 방만 추가하고, 보내지 못했던 작업은 다시 대기열에 넣음 */
  async importBackup(b) {
    if (b?.format !== 'chat_site-backup' || !Array.isArray(b.messages)) throw new OpError('invalid_backup');
    const have = new Set((await idb.all('messages')).map((m) => m.id));
    const add = b.messages.filter((m) => m?.id && m.roomId && !have.has(m.id));
    await idb.putMany('messages', add);
    const newNodes = (b.nodes || []).filter((n) => n?.id && !this.nodes.has(n.id));
    if (this.mode === 'local' || !config.serverUrl) {
      await idb.putMany('nodes', newNodes);
      for (const n of newNodes) this.nodes.set(n.id, n);
    }
    await idb.putMany('users', (b.users || []).filter((u) => u?.id && !this.users.has(u.id)));
    let requeued = 0;
    if (b.user?.id === this.me.id) {
      const queued = new Set((await idb.outboxAll()).map((o) => `${o.op}:${o.payload?.id}`));
      for (const o of b.outbox || []) {
        if (!o?.op || queued.has(`${o.op}:${o.payload?.id}`) || o.op === 'upload') continue;
        await idb.outboxAdd({ op: o.op, payload: o.payload });
        requeued += 1;
      }
    }
    for (const [k, v] of Object.entries(b.personal || {})) {
      if (k.startsWith('cs.') && k !== 'cs.session' && localStorage.getItem(k) == null) try { localStorage.setItem(k, v); } catch { /* noop */ }
    }
    this.pendingOps = (await idb.outboxAll()).length;
    this.emit('nodes');
    this.emit('resync');
    this.emit('status', this.status());
    if (requeued && this.isOnline) this.flushOutbox();
    return { messages: add.length, nodes: newNodes.length, requeued };
  }

  // ───────────── 프로필 ─────────────
  async updateProfile(patch) {
    const res = await this.#mutate('profile:update', patch, async () => this.#applyUser({ ...this.me, ...patch }, true));
    if (res?.user) this.#applyUser(res.user);
  }

  user(id) {
    return this.users.get(id);
  }

  async clearFileCache() {
    const ops = await idb.outboxAll();
    const keep = new Set(ops.filter((o) => o.op === 'upload').map((o) => o.payload.id));
    const list = await idb.all('blobs');
    const drop = list.filter((b) => !keep.has(b.id)).map((b) => b.id);
    files.forget(drop);
    await idb.delMany('blobs', drop);
    return drop.length;
  }
}
