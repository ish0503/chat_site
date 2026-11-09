// 데이터 계층: 서버(Socket.IO + MongoDB)에 연결되면 실시간으로 동기화하고,
// 서버/DB에 연결할 수 없으면 기기(IndexedDB)에 저장한 뒤 outbox 에 쌓아 두었다가 재연결 시 서버로 보냅니다.
import { config } from './config.js';
import * as idb from './db.js';
import * as api from './api.js';
import * as files from './files.js';
import { OpError, isConnectivity } from './api.js';
import { Emitter, uid, kindOf, jwtValid } from './util.js';
import { can } from './permissions.js';

const PAGE = 50;

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

  status() {
    return {
      mode: this.mode, needsLogin: this.needsLogin, pendingOps: this.pendingOps, serverUrl: config.serverUrl, error: this.lastError,
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
      this.server = await api.health(config.serverUrl);
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
      auth: { token }, transports: ['websocket', 'polling'], reconnectionDelayMax: 10_000,
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
      this.#setStatus('online', { needsLogin: false, lastError: null });
      for (const e of ['nodes', 'users', 'presence', 'calls', 'resync']) this.emit(e);
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
        if (!res?.ok) throw new OpError(res?.error || 'server_error');
        return res;
      },
      (e) => { throw e instanceof OpError ? e : new OpError('timeout'); },
    );
  }

  async flushOutbox() {
    const run = async () => {
      const ops = await idb.outboxAll();
      for (let i = 0; i < ops.length; i++) {
        const op = ops[i];
        try {
          if (op.op === 'upload') await this.#uploadStored(op.payload.id);
          else await this.request(op.op, op.payload);
          await idb.del('outbox', op.seq);
        } catch (e) {
          if (isConnectivity(e)) {
            this.pendingOps = ops.length - i;
            this.emit('status', this.status());
            return false;
          }
          console.warn('[data] 동기화할 수 없는 작업을 버립니다', op, e);
          await idb.del('outbox', op.seq);
          if (op.op === 'msg:send') await this.#markFailed(op.payload.id, e.code);
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
      .filter((n) => (n.parentId ?? null) === parentId)
      .sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.createdAt - b.createdAt);
  }

  async createNode({ type, name, parentId = null, topic = '' }) {
    if (!this.can('manageNodes')) throw new OpError('forbidden');
    const sib = this.children(parentId);
    const node = {
      id: uid(), type, name: name.trim().slice(0, 100), parentId, topic: topic.trim().slice(0, 300),
      order: (sib.at(-1)?.order ?? 0) + 1, createdBy: this.me.id, createdAt: Date.now(), updatedAt: Date.now(), lastMessageAt: 0,
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

  async sendMessage(roomId, { content = '', files: fileList = [], replyTo = null }) {
    if (!this.can('sendMessage')) throw new OpError('forbidden');
    const text = content.trim().slice(0, 4000);
    if (!text && !fileList.length) return null;
    for (const f of fileList) {
      if (f.size > this.maxUploadBytes) throw new OpError('file_too_large');
    }
    const createdAt = Date.now();
    const attachments = fileList.map((f) => ({
      id: uid(), name: f.name || 'file', size: f.size, mime: f.type || 'application/octet-stream', kind: kindOf(f.type), expiresAt: createdAt + this.fileTtlMs, local: true,
    }));
    await Promise.all(fileList.map((f, i) => files.storeBlob(attachments[i], f)));
    const reply = replyTo ? await idb.get('messages', replyTo) : null;
    const msg = {
      id: uid(),
      roomId,
      authorId: this.me.id,
      author: { nickname: this.me.nickname, provider: this.me.provider },
      content: text,
      attachments,
      replyTo: reply ? replyTo : null,
      replyPreview: reply ? preview(reply) : null,
      reactions: {},
      pinned: false,
      createdAt,
      editedAt: null,
      pending: true,
    };
    await this.#applyMessage(msg, true);
    this.#deliver(msg);
    return msg;
  }

  /** 첨부 업로드 → 메시지 전송. 연결 문제면 outbox 에 저장 */
  async #deliver(msg) {
    const payload = {
      id: msg.id, roomId: msg.roomId, content: msg.content, attachments: msg.attachments.map((a) => a.id), replyTo: msg.replyTo, createdAt: msg.createdAt,
    };
    const remaining = msg.attachments.filter((a) => a.local).map((a) => a.id);
    if (this.isOnline) {
      try {
        while (remaining.length) {
          await this.#uploadStored(remaining[0], (p) => this.emit('progress', { msgId: msg.id, attId: remaining[0], p }));
          remaining.shift();
        }
        await this.request('msg:send', payload);
        return;
      } catch (e) {
        if (!isConnectivity(e)) {
          await this.#markFailed(msg.id, e.code);
          this.emit('error', e);
          return;
        }
      }
    }
    for (const id of remaining) await this.#enqueue('upload', { id });
    await this.#enqueue('msg:send', payload);
  }

  async #uploadStored(id, onProgress) {
    const rec = await idb.get('blobs', id);
    if (!rec?.blob) throw new OpError('missing_file');
    if (!this.socket?.connected) throw new OpError('offline');
    return api.upload(config.serverUrl, this.token, rec.blob, { id, name: rec.name, onProgress });
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
    await this.#mutate('msg:edit', { id, content: text }, () => this.#applyMessage({ ...m, content: text, editedAt: Date.now() }, true));
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

  async search(roomId, q) {
    const query = q.trim();
    if (!query) return [];
    if (this.isOnline) {
      try {
        return (await this.request('msg:search', { roomId, q: query })).messages;
      } catch (e) {
        if (!isConnectivity(e)) throw e;
      }
    }
    const lower = query.toLowerCase();
    return (await idb.roomAll(roomId))
      .filter((m) => (m.content || '').toLowerCase().includes(lower) || (m.attachments || []).some((a) => a.name.toLowerCase().includes(lower)))
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, 50);
  }

  sendTyping(roomId) {
    if (this.isOnline) this.socket.emit('typing', { roomId });
  }

  async fetchFile(id) {
    if (!this.isOnline) throw new OpError('offline');
    return api.fetchFile(config.serverUrl, this.token, id);
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
