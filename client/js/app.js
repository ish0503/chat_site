import { config } from './config.js';
import { h, Emitter, toast, isMobile, safeImageUrl } from './util.js';
import { loadSession, saveSession, clearSession } from './auth.js';
import { DataService } from './data.js';
import { CallManager } from './call.js';
import { mentionsMe } from './markdown.js';
import { renderLogin } from './ui/login.js';
import { createSidebar } from './ui/sidebar.js';
import { createChatView } from './ui/chat.js';
import { createCallView } from './ui/callview.js';
import { createPanels } from './ui/panels.js';
import { applyTheme, settings, openServerSettings } from './ui/dialogs.js';
import { openModal, confirmDialog, emptyState, closeMenu } from './ui/common.js';
import { icon } from './ui/icons.js';

const root = document.getElementById('app');
document.title = config.appName;
applyTheme();
matchMedia('(prefers-color-scheme: light)').addEventListener?.('change', applyTheme);

if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('./sw.js').catch(() => {});
}

const store = {
  get(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* noop */ } },
};

let current = null;

function boot(reason) {
  current?.destroy();
  current = null;
  const session = loadSession();
  if (!session) {
    renderLogin(root, (s) => { saveSession(s); boot(); }, { reason });
    return;
  }
  current = start(session);
}

function start(session) {
  const ctx = new Emitter();
  const data = new DataService();
  const calls = new CallManager(data);
  data.me = session.user;
  data.session = session;
  Object.assign(ctx, {
    data,
    calls,
    roomId: null,
    unread: new Map(Object.entries(store.get('cs.unread', {}))),
    mentions: new Set(store.get('cs.mentions', [])),
    lastRead: store.get('cs.lastRead', {}),
  });

  const chat = createChatView(ctx);
  const callView = createCallView(ctx);
  const panels = createPanels(ctx);
  const sidebar = createSidebar(ctx);
  const banner = h('div', { class: 'banner', hidden: true, role: 'status' });
  const content = h('div', { class: 'main-content' });
  const scrim = h('div', { class: 'drawer-scrim', onclick: () => closeDrawer() });
  const main = h('main', { class: 'main' }, banner, content);
  const layout = h('div', { class: 'layout' }, sidebar.el, scrim, main, panels.el);
  root.replaceChildren(layout);

  // ───────── 화면 전환 ─────────
  function showEmpty() {
    ctx.roomId = null;
    content.replaceChildren(h('div', { class: 'empty-wrap' },
      h('header', { class: 'room-head' }, h('button', { class: 'icon-btn mobile-only', 'aria-label': '메뉴 열기', onclick: () => openDrawer() }, icon('menu')), h('div', { class: 'room-title' }, h('h2', {}, config.appName))),
      data.nodes.size
        ? emptyState('hash', '채팅방을 선택하세요', '왼쪽 목록에서 채팅방이나 통화방을 선택하세요.')
        : emptyState('folder', '아직 채팅방이 없습니다', data.can('manageNodes') ? '사이드바의 + 버튼으로 채팅방, 통화방, 폴더를 만들어 보세요.' : '로그인한 사용자가 채팅방을 만들면 여기에서 대화할 수 있습니다.')));
    ctx.emit('room', null);
  }

  ctx.openRoom = async (id, { replace } = {}) => {
    const node = data.nodes.get(id);
    if (!node || node.type === 'folder') return showEmpty();
    closeDrawer();
    closeMenu();
    if (location.hash !== `#/room/${id}`) {
      if (replace) history.replaceState(null, '', `#/room/${id}`); else history.pushState(null, '', `#/room/${id}`);
    }
    store.set('cs.lastRoom', id);
    if (ctx.roomId === id) return;
    ctx.roomId = id;
    ctx.expandFolder?.(node.parentId);
    if (node.type === 'voice') {
      content.replaceChildren(callView.el);
      callView.open(id);
      if (panels.kind === 'pins' || panels.kind === 'search') ctx.togglePanel(null);
    } else {
      content.replaceChildren(chat.el);
      ctx.markRead(id);
      await chat.open(id);
    }
    ctx.emit('room', id);
  };

  ctx.jumpTo = async (roomId, msgId) => {
    if (ctx.roomId !== roomId) await ctx.openRoom(roomId);
    chat.jumpTo(msgId);
  };

  ctx.togglePanel = (k) => {
    const next = k && panels.kind !== k ? k : null;
    panels.show(next);
    layout.classList.toggle('panel-open', !!next);
  };

  function openDrawer() { layout.classList.add('drawer-open'); }
  function closeDrawer() { layout.classList.remove('drawer-open'); }
  ctx.openDrawer = openDrawer;

  // ───────── 읽음 / 알림 ─────────
  const persistUnread = () => {
    store.set('cs.unread', Object.fromEntries(ctx.unread));
    store.set('cs.mentions', [...ctx.mentions]);
    store.set('cs.lastRead', ctx.lastRead);
    const total = [...ctx.unread.values()].reduce((a, b) => a + b, 0);
    document.title = total ? `(${total > 99 ? '99+' : total}) ${config.appName}` : config.appName;
  };

  ctx.markRead = (roomId) => {
    if (!roomId) return;
    const changed = ctx.unread.has(roomId) || ctx.mentions.has(roomId) || (data.nodes.get(roomId)?.lastMessageAt || 0) > (ctx.lastRead[roomId] || 0);
    ctx.unread.delete(roomId);
    ctx.mentions.delete(roomId);
    ctx.lastRead[roomId] = Date.now();
    persistUnread();
    if (changed) ctx.emit('unread');
  };

  data.on('message', (m, info) => {
    if (!info?.isNew || m.authorId === data.me.id) return;
    const viewing = ctx.roomId === m.roomId && document.visibilityState === 'visible' && chat.atBottom;
    if (viewing) { ctx.markRead(m.roomId); return; }
    ctx.unread.set(m.roomId, (ctx.unread.get(m.roomId) || 0) + 1);
    const mention = mentionsMe(m.content, data.me);
    if (mention) ctx.mentions.add(m.roomId);
    persistUnread();
    ctx.emit('unread');
    if (settings.notify && 'Notification' in window && Notification.permission === 'granted' && (document.hidden || ctx.roomId !== m.roomId)) {
      const u = data.user(m.authorId);
      const room = data.nodes.get(m.roomId);
      try {
        const n = new Notification(`${u?.nickname || m.author?.nickname || '새 메시지'} · #${room?.name || ''}`, {
          body: m.content?.slice(0, 140) || '📎 첨부파일', tag: m.roomId, icon: safeImageUrl(u?.avatar) || undefined, silent: !mention,
        });
        n.onclick = () => { window.focus(); ctx.openRoom(m.roomId); n.close(); };
      } catch { /* noop */ }
    }
  });
  document.addEventListener('visibilitychange', () => { if (!document.hidden && ctx.roomId && chat.atBottom) ctx.markRead(ctx.roomId); });

  // ───────── 연결 상태 배너 ─────────
  let lastMode = null;
  let localDismissed = sessionStorage.getItem('cs.localDismissed') === '1';
  // 연결이 안 되는 이유를 사람이 읽을 수 있게
  function reasonText(code) {
    if (!code) return '';
    if (code === 'offline') return `서버 주소에 접속하지 못했습니다. 서버가 꺼져 있거나, 서버 환경변수 ALLOWED_ORIGINS 에 ${location.origin} 이 없습니다.`;
    if (/^http_\d+$/.test(code)) return `서버가 ${code.slice(5)} 오류로 응답했습니다. SERVER_URL 주소가 맞는지 확인하세요.`;
    if (code === 'db_unavailable') return '서버는 응답하지만 MongoDB 에 연결되지 않았습니다.';
    if (code === 'unauthorized' || code === 'auth_needed') return '로그인 정보를 서버가 받아주지 않았습니다. 다시 로그인해 주세요.';
    if (/xhr poll error|websocket error|transport|timeout/i.test(code)) return `실시간 연결(Socket.IO)에 실패했습니다 (${code}). 서버 호스팅이 연결을 막고 있거나 ALLOWED_ORIGINS 설정을 확인하세요.`;
    if (/^load failed/.test(code)) return '실시간 연결 스크립트(socket.io)를 불러오지 못했습니다.';
    return `오류: ${code}`;
  }

  function renderBanner(st) {
    const btn = (label, fn) => h('button', { class: 'btn small secondary', onclick: fn }, label);
    const reason = st.error ? h('span', { class: 'banner-reason' }, reasonText(st.error)) : null;
    let content2 = null;
    let kind = 'info';
    if (st.mode === 'local' && !localDismissed) {
      content2 = [icon('device', 16), h('span', {}, isMobile() ? '로컬 모드 · 이 기기에만 저장됩니다.' : '로컬 모드 — 서버가 설정되지 않아 모든 대화가 이 기기에만 저장됩니다.'),
        btn('서버 설정', () => openServerSettings()), h('button', { class: 'icon-btn tiny', 'aria-label': '닫기', onclick: () => { localDismissed = true; sessionStorage.setItem('cs.localDismissed', '1'); renderBanner(data.status()); } }, icon('x', 14))];
    } else if (st.mode === 'offline' && st.needsLogin) {
      kind = 'warn';
      content2 = [icon('lock', 16), h('span', {}, '서버와 동기화하려면 다시 로그인해야 합니다. 그동안 메시지는 이 기기에 저장됩니다.'),
        btn('다시 로그인', () => relogin()), reason];
    } else if (st.mode === 'offline') {
      kind = 'warn';
      content2 = [icon('cloudOff', 16), h('span', {}, `${isMobile() ? '오프라인 · 기기에 저장 중, 연결되면 동기화' : '서버(MongoDB)에 연결할 수 없어 이 기기에 저장 중입니다. 연결되면 자동으로 동기화됩니다.'}${st.pendingOps ? ` (대기 ${st.pendingOps}개)` : ''}`),
        btn('다시 연결', () => data.connect()), reason];
    } else if (st.mode === 'connecting' && lastMode === 'offline') {
      kind = 'warn';
      content2 = [h('span', { class: 'spinner tiny' }), h('span', {}, '서버에 다시 연결하는 중…'), reason];
    }
    banner.hidden = !content2;
    banner.className = `banner banner-${kind}`;
    banner.replaceChildren(...(content2 || []));
    if (st.mode === 'online' && lastMode && lastMode !== 'online' && lastMode !== 'local') toast('서버에 연결되어 동기화했습니다.', 'success');
    if (st.mode !== 'connecting') lastMode = st.mode;
  }
  data.on('status', renderBanner);

  // ───────── 라우팅 ─────────
  const routeId = () => location.hash.match(/^#\/room\/([\w-]+)/)?.[1];
  const onHash = () => { const id = routeId(); if (id && id !== ctx.roomId && data.nodes.has(id)) ctx.openRoom(id, { replace: true }); };
  window.addEventListener('hashchange', onHash);
  window.addEventListener('popstate', onHash);

  let initialized = false;
  data.on('nodes', () => {
    if (ctx.roomId && !data.nodes.has(ctx.roomId)) {
      toast('보고 있던 방이 삭제되었습니다.', 'warn');
      showEmpty();
      return;
    }
    if (!initialized || !ctx.roomId) {
      const want = routeId() || store.get('cs.lastRoom', null);
      const first = [...data.nodes.values()].filter((n) => n.type === 'text').sort((a, b) => a.createdAt - b.createdAt)[0];
      const target = (want && data.nodes.has(want) && want) || (!initialized && first?.id);
      if (target) { initialized = true; ctx.openRoom(target, { replace: true }); } else if (!initialized) showEmpty();
    }
  });

  // ───────── 모바일 스와이프 (사이드바 열기/닫기) ─────────
  let touch = null;
  layout.addEventListener('touchstart', (e) => {
    const t = e.touches[0];
    touch = { x: t.clientX, y: t.clientY, open: layout.classList.contains('drawer-open') };
  }, { passive: true });
  layout.addEventListener('touchend', (e) => {
    if (!touch || !isMobile()) return;
    const t = e.changedTouches[0];
    const dx = t.clientX - touch.x;
    const dy = Math.abs(t.clientY - touch.y);
    if (dy < 50 && Math.abs(dx) > 70) {
      if (!touch.open && dx > 0 && touch.x < 40) openDrawer();
      else if (touch.open && dx < 0) closeDrawer();
    }
    touch = null;
  }, { passive: true });

  // ───────── 빠른 전환 (Ctrl/⌘+K) ─────────
  function quickSwitcher() {
    const input = h('input', { class: 'input', placeholder: '채팅방 · 통화방 이름', autofocus: true, 'aria-label': '방 검색' });
    const results = h('div', { class: 'qs-results' });
    let idx = 0;
    let items = [];
    const pathOf = (n) => { const p = []; for (let c = data.nodes.get(n.parentId); c; c = data.nodes.get(c.parentId)) p.unshift(c.name); return p.join(' / '); };
    const render = () => {
      const q = input.value.trim().toLowerCase();
      items = [...data.nodes.values()].filter((n) => n.type !== 'folder' && n.name.toLowerCase().includes(q)).slice(0, 12);
      idx = Math.min(idx, Math.max(0, items.length - 1));
      results.replaceChildren(...items.map((n, i) => h('button', {
        class: `qs-item${i === idx ? ' active' : ''}`, type: 'button', onclick: () => { m.close(); ctx.openRoom(n.id); },
      }, icon(n.type === 'voice' ? 'voice' : 'hash', 16), h('span', {}, n.name), h('span', { class: 'muted small' }, pathOf(n)),
      ctx.unread.get(n.id) ? h('span', { class: 'unread-badge' }, String(ctx.unread.get(n.id))) : null)));
      if (!items.length) results.append(h('p', { class: 'muted small pad' }, '일치하는 방이 없습니다.'));
    };
    input.addEventListener('input', () => { idx = 0; render(); });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') { e.preventDefault(); idx = Math.min(items.length - 1, idx + 1); render(); }
      if (e.key === 'ArrowUp') { e.preventDefault(); idx = Math.max(0, idx - 1); render(); }
      if (e.key === 'Enter' && items[idx]) { e.preventDefault(); m.close(); ctx.openRoom(items[idx].id); }
    });
    const m = openModal({ title: '빠른 이동', cls: 'qs-modal', body: [input, results] });
    render();
  }
  const onKey = (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); quickSwitcher(); }
  };
  document.addEventListener('keydown', onKey);

  // ───────── 로그아웃 / 재로그인 ─────────
  ctx.logout = async () => {
    const ok = await confirmDialog({ title: '로그아웃', message: '로그아웃할까요?\n이 기기에 저장된 대화와 파일 사본은 유지됩니다.', confirmText: '로그아웃', danger: true });
    if (!ok) return;
    document.querySelectorAll('.modal-backdrop').forEach((x) => x.remove());
    clearSession();
    history.replaceState(null, '', location.pathname);
    boot();
  };

  function relogin() {
    const keep = data.session;
    clearSession();
    boot(keep.user.provider === 'guest' ? '게스트 세션을 복구할 수 없습니다. 새로 입장해 주세요.' : `${keep.user.provider === 'google' ? 'Google' : 'Apple'} 계정으로 다시 로그인하면 이 기기에 저장된 대화가 서버로 동기화됩니다.`);
  }

  data.on('error', (e) => toast(e.message, 'error'));
  data.init(session, saveSession).then(() => {
    if (!data.nodes.size) showEmpty();
  });

  return {
    destroy() {
      calls.leave();
      data.destroy();
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('hashchange', onHash);
      window.removeEventListener('popstate', onHash);
    },
  };
}

boot();
