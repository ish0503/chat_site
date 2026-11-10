import { config } from './config.js';
import {
  h, Emitter, toast, isMobile, isTouch, safeImageUrl, debounce, fmtStamp, fmtBytes,
} from './util.js';
import { loadSession, saveSession, clearSession } from './auth.js';
import { DataService, isChatRoom, isWorkspace } from './data.js';
import { createWorkspaceView } from './ui/workspace.js';
import * as errorlog from './errorlog.js';
import { CallManager } from './call.js';
import { mentionsMe } from './markdown.js';
import { renderLogin } from './ui/login.js';
import { createSidebar } from './ui/sidebar.js';
import { createChatView } from './ui/chat.js';
import { createCallView } from './ui/callview.js';
import { createPanels, renderMemberList } from './ui/panels.js';
import {
  applyTheme, settings, openServerSettings, listSetting, settingsChanged, shortcutsDialog, serverStatusDialog, aiDialog, quickSettings, profileDialog,
} from './ui/dialogs.js';
import {
  roomNotify, blocked, reminders, recentRooms, workspace, archived,
} from './local.js';
import { sounds } from './sounds.js';
import { installBanner } from './install.js';
import {
  openModal, confirmDialog, emptyState, closeMenu, avatar,
} from './ui/common.js';
import { icon } from './ui/icons.js';

const root = document.getElementById('app');
document.title = config.appName;
applyTheme();
matchMedia('(prefers-color-scheme: light)').addEventListener?.('change', applyTheme);

if ('serviceWorker' in navigator && window.isSecureContext) {
  navigator.serviceWorker.register('./sw.js').catch(() => {});
}

const store = {
  get(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* noop */ } },
};

let current = null;

function boot(reason) {
  window.__csBooted = true;
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

  errorlog.install(data);
  const chat = createChatView(ctx);
  let splitChat = null; // 분할 화면의 두 번째 채팅창 (처음 열 때 만듦)
  ctx.splitRoomId = null;
  const callView = createCallView(ctx);
  const wsView = createWorkspaceView(ctx);
  ctx.mainMode = 'chat'; // 지금 가운데에 보이는 것: chat | workspace | call
  const panels = createPanels(ctx);
  const sidebar = createSidebar(ctx);
  const banner = h('div', { class: 'banner', hidden: true, role: 'status' });
  const content = h('div', { class: 'main-content' });
  const scrim = h('div', { class: 'drawer-scrim', onclick: () => closeDrawer() });
  const main = h('main', { class: 'main' }, banner, content);
  installBanner(main);
  // 멀티 패널: 넓은 화면에서 채팅 옆에 멤버 목록을 항상 표시
  const dockBody = h('div', { class: 'panel-body' });
  const dock = h('aside', { class: 'members-dock', hidden: true, 'aria-label': '멤버 목록' },
    h('header', { class: 'panel-head' }, h('h3', {}, icon('users', 18), ' 멤버'), h('button', { class: 'icon-btn', 'aria-label': '멤버 목록 숨기기', title: '숨기기', onclick: () => import('./ui/dialogs.js').then((d) => d.saveSettings({ membersDock: false })) }, icon('x'))),
    dockBody);
  const layout = h('div', { class: 'layout' }, sidebar.el, scrim, main, panels.el, dock);
  root.replaceChildren(layout);
  const renderDock = debounce(() => {
    const show = !!settings.membersDock && panels.kind !== 'members' && matchMedia('(min-width: 1280px)').matches;
    dock.hidden = !show;
    layout.classList.toggle('dock-open', show);
    if (show) renderMemberList(ctx, dockBody);
  }, 100);
  data.on('presence', renderDock);
  data.on('users', renderDock);
  matchMedia('(min-width: 1280px)').addEventListener?.('change', renderDock);

  // ───────── 분할 화면 ─────────
  function layoutPanes(mainEl) {
    if (ctx.splitRoomId && splitChat && !isMobile()) {
      content.classList.add('split');
      content.replaceChildren(mainEl, h('div', { class: 'split-divider', 'aria-hidden': 'true' }), splitChat.el);
    } else {
      content.classList.remove('split');
      content.replaceChildren(mainEl);
    }
  }
  let mainEl = null;
  // 화면이 좁아지면(모바일) 분할 화면을 접고, 다시 넓어지면 펼침
  matchMedia('(max-width: 768px)').addEventListener?.('change', () => { if (mainEl && ctx.splitRoomId) layoutPanes(mainEl); });
  ctx.isSplitOpen = (id) => ctx.splitRoomId === id;
  ctx.openSplit = async (id) => {
    const node = data.nodes.get(id);
    if (!isChatRoom(node)) return;
    if (isMobile()) { ctx.openRoom(id); return; }
    if (id === ctx.roomId && ctx.mainMode !== 'workspace') { toast('이미 왼쪽에 열려 있는 방입니다.'); return; }
    if (!splitChat) splitChat = createChatView(ctx, { split: true });
    ctx.splitRoomId = id;
    workspace.set({ split: id });
    layoutPanes(mainEl || content.firstChild);
    await splitChat.open(id, {});
    ctx.markRead(id);
  };
  ctx.closeSplit = () => {
    ctx.splitRoomId = null;
    workspace.set({ split: null });
    splitChat?.close();
    layoutPanes(mainEl || content.firstChild);
  };
  ctx.pickSplit = () => roomPicker('분할 화면으로 열 방', (n) => ctx.openSplit(n.id), { exclude: [ctx.roomId] });

  // ───────── 화면 전환 ─────────
  function showEmpty() {
    ctx.roomId = null;
    mainEl = null;
    content.classList.remove('split');
    content.replaceChildren(h('div', { class: 'empty-wrap' },
      h('header', { class: 'room-head' }, h('button', { class: 'icon-btn mobile-only', 'aria-label': '메뉴 열기', onclick: () => openDrawer() }, icon('menu')), h('div', { class: 'room-title' }, h('h2', {}, config.appName))),
      data.nodes.size
        ? emptyState('hash', '채팅방을 선택하세요', '왼쪽 목록에서 채팅방이나 통화방을 선택하세요.')
        : emptyState('folder', '아직 채팅방이 없습니다', data.can('manageNodes') ? '사이드바의 + 버튼으로 채팅방, 통화방, 폴더를 만들어 보세요.' : '로그인한 사용자가 채팅방을 만들면 여기에서 대화할 수 있습니다.')));
    ctx.emit('room', null);
  }

  // 작업 공간이 딸린 방(코드 작업실 · 보드)의 채팅 보기
  ctx.showRoomChat = async (id) => {
    if (ctx.splitRoomId === id) ctx.closeSplit();
    ctx.roomId = id;
    ctx.mainMode = 'chat';
    mainEl = chat.el;
    layoutPanes(mainEl);
    const since = ctx.lastRead[id] || 0;
    const hadUnread = ctx.unread.has(id);
    ctx.markRead(id);
    await chat.open(id, { since: hadUnread ? since : 0 });
    ctx.emit('room', id);
  };

  ctx.openRoom = async (id, { replace, workspace: wantWs, reload } = {}) => {
    const node = data.nodes.get(id);
    if (!node || node.type === 'folder') return showEmpty();
    closeDrawer();
    closeMenu();
    if (!location.hash.startsWith(`#/room/${id}`)) {
      if (replace) history.replaceState(null, '', `#/room/${id}`); else history.pushState(null, '', `#/room/${id}`);
    }
    store.set('cs.lastRoom', id);
    recentRooms.push(id);
    if (isWorkspace(node)) {
      // 코드 작업실 · 보드: 작업 공간을 먼저 보여 주고, 채팅은 제목 막대의 '채팅'이나 분할 화면으로
      if (ctx.roomId === id && ctx.mainMode === 'workspace' && !reload) return;
      if (ctx.roomId === id && ctx.mainMode === 'chat' && !wantWs) return;
      ctx.roomId = id;
      ctx.mainMode = 'workspace';
      ctx.expandFolder?.(node.parentId);
      mainEl = wsView.el;
      layoutPanes(mainEl);
      if (panels.kind === 'pins' || panels.kind === 'search') ctx.togglePanel(null);
      await wsView.open(id, { reload });
      ctx.emit('room', id);
      return;
    }
    if (ctx.roomId === id) return;
    if (ctx.splitRoomId === id) ctx.closeSplit(); // 분할 화면에 있던 방을 왼쪽으로 열면 분할 닫기
    ctx.roomId = id;
    ctx.mainMode = node.type === 'voice' ? 'call' : 'chat';
    if (node.type !== 'dm') ctx.expandFolder?.(node.parentId);
    if (node.type === 'voice') {
      mainEl = callView.el;
      layoutPanes(mainEl);
      callView.open(id);
      if (panels.kind === 'pins' || panels.kind === 'search') ctx.togglePanel(null);
    } else {
      mainEl = chat.el;
      layoutPanes(mainEl);
      const since = ctx.lastRead[id] || 0;
      const hadUnread = ctx.unread.has(id) || (node.lastMessageAt || 0) > since;
      ctx.markRead(id);
      await chat.open(id, { since: hadUnread ? since : 0 });
    }
    ctx.emit('room', id);
  };

  ctx.jumpTo = async (roomId, msgId) => {
    if (ctx.splitRoomId === roomId && splitChat) { splitChat.jumpTo(msgId); return; }
    if (isWorkspace(data.nodes.get(roomId))) { if (ctx.roomId !== roomId || ctx.mainMode !== 'chat') await ctx.showRoomChat(roomId); } else if (ctx.roomId !== roomId) await ctx.openRoom(roomId);
    chat.jumpTo(msgId);
  };

  ctx.togglePanel = (k) => {
    const next = k && panels.kind !== k ? k : null;
    panels.show(next);
    layout.classList.toggle('panel-open', !!next);
    if (next && isMobile()) pushOverlay('panel');
    workspace.set({ panel: next && !['search'].includes(next) ? next : null });
    renderDock();
  };
  ctx.serverStatus = () => serverStatusDialog(ctx);
  ctx.aiDialog = (roomId) => aiDialog(ctx, roomId);
  settingsChanged.add((patch) => { if ('membersDock' in patch) renderDock(); });

  // ───────── 모바일 뒤로 가기: 패널 · 사이드바가 열려 있으면 앱을 나가지 않고 닫기 ─────────
  function pushOverlay(kind) {
    if (history.state?.overlay === kind) return;
    history.pushState({ overlay: kind }, '', location.href);
  }
  window.addEventListener('popstate', () => {
    if (layout.classList.contains('drawer-open')) { layout.classList.remove('drawer-open'); return; }
    if (panels.kind && isMobile()) { panels.show(null); layout.classList.remove('panel-open'); }
  });

  ctx.searchFrom = (u) => {
    panels.search(`from:${u.nickname}`, true);
    layout.classList.add('panel-open');
  };

  function openDrawer() { layout.classList.add('drawer-open'); if (isMobile()) pushOverlay('drawer'); }
  function closeDrawer() { layout.classList.remove('drawer-open'); }
  ctx.openDrawer = openDrawer;

  // ───────── 읽음 / 알림 ─────────
  const persistUnread = () => {
    store.set('cs.unread', Object.fromEntries(ctx.unread));
    store.set('cs.mentions', [...ctx.mentions]);
    store.set('cs.lastRead', ctx.lastRead);
    updateBadges();
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

  ctx.markAllRead = () => {
    for (const n of data.nodes.values()) if (isChatRoom(n)) ctx.lastRead[n.id] = Date.now();
    ctx.unread.clear();
    ctx.mentions.clear();
    persistUnread();
    ctx.emit('unread');
    toast('모두 읽음으로 표시했습니다.');
  };

  // 파비콘 · 앱 아이콘에 안 읽은 수 표시
  const favicon = document.querySelector('link[rel="icon"]');
  const baseIcon = favicon?.href;
  let iconImg = null;
  function updateBadges() {
    const total = [...ctx.unread.entries()].filter(([id]) => roomNotify.get(id) !== 'none').reduce((a, [, b]) => a + b, 0);
    const mention = ctx.mentions.size > 0;
    document.title = total ? `(${total > 99 ? '99+' : total}) ${config.appName}` : config.appName;
    try { if (navigator.setAppBadge) { if (total) navigator.setAppBadge(total); else navigator.clearAppBadge(); } } catch { /* noop */ }
    if (!favicon) return;
    if (!total) { favicon.href = baseIcon; return; }
    const draw = () => {
      const c = document.createElement('canvas');
      c.width = c.height = 64;
      const g = c.getContext('2d');
      g.drawImage(iconImg, 0, 0, 64, 64);
      g.fillStyle = mention ? '#f0b232' : '#ed4245';
      g.beginPath(); g.arc(46, 46, 18, 0, Math.PI * 2); g.fill();
      g.fillStyle = mention ? '#000' : '#fff';
      g.font = 'bold 22px sans-serif';
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText(total > 9 ? '9+' : String(total), 46, 47);
      favicon.href = c.toDataURL('image/png');
    };
    if (iconImg?.complete) draw();
    else { iconImg = new Image(); iconImg.onload = draw; iconImg.src = baseIcon; }
  }
  ctx.on('unread', updateBadges);

  data.on('message', (m, info) => {
    if (!info?.isNew || m.authorId === data.me.id || blocked.has(m.authorId)) return;
    const visible = document.visibilityState === 'visible';
    const viewing = visible && ((ctx.roomId === m.roomId && ctx.mainMode === 'chat' && chat.atBottom) || (ctx.splitRoomId === m.roomId && splitChat?.atBottom));
    if (viewing) { ctx.markRead(m.roomId); return; }
    // 보관한 1:1 대화에 새 메시지가 오면 다시 목록에 표시
    if (data.nodes.get(m.roomId)?.type === 'dm' && archived.has(m.roomId)) archived.remove(m.roomId);
    const mode = roomNotify.get(m.roomId);
    const mention = mentionsMe(m.content, data.me, listSetting('keywords'));
    ctx.unread.set(m.roomId, (ctx.unread.get(m.roomId) || 0) + 1);
    if (mention) ctx.mentions.add(m.roomId);
    persistUnread();
    ctx.emit('unread');
    // 알림 조건: 방 알림 설정 · 전체 알림 범위 · 방해 금지
    const dnd = data.me.presence === 'dnd';
    const wanted = !dnd && mode !== 'none' && (mention || (mode === 'all' && settings.notifyMode === 'all'));
    if (!wanted) return;
    if (settings.sound) (mention ? sounds.mention : sounds.message)();
    if (settings.vibrate && document.hidden) navigator.vibrate?.(mention ? [80, 60, 80] : 60);
    if (settings.notify && 'Notification' in window && Notification.permission === 'granted' && (document.hidden || ctx.roomId !== m.roomId)) {
      const u = data.user(m.authorId);
      const room = data.nodes.get(m.roomId);
      const body = !settings.notifyPreview ? '새 메시지가 도착했습니다.' : m.kind === 'poll' ? `📊 ${m.content}` : m.content?.slice(0, 140) || '📎 첨부파일';
      try {
        const n = new Notification(`${u?.nickname || m.author?.nickname || '새 메시지'} · ${room?.type === 'dm' ? '1:1 대화' : `#${room?.name || ''}`}`, {
          body, tag: m.roomId, icon: safeImageUrl(u?.avatar) || undefined, silent: true,
        });
        n.onclick = () => { window.focus(); ctx.jumpTo(m.roomId, m.id); n.close(); };
      } catch { /* noop */ }
    }
  });

  // 리마인더 (/remind)
  const reminderTimer = setInterval(() => {
    const due = reminders.list().filter((r) => r.at <= Date.now());
    for (const r of due) {
      reminders.remove(r.id);
      if (settings.sound) sounds.reminder();
      toast(`⏰ 리마인더: ${r.text}`, 'warn', 10000);
      if ('Notification' in window && Notification.permission === 'granted') {
        try { new Notification('⏰ 리마인더', { body: r.text, tag: r.id }); } catch { /* noop */ }
      }
    }
  }, 5000);

  // 자동 자리 비움 (10분 동안 활동이 없으면)
  let lastActive = Date.now();
  let autoIdle = false;
  const onActive = () => {
    lastActive = Date.now();
    if (autoIdle && data.isOnline) { autoIdle = false; data.updateProfile({ presence: 'online' }).catch(() => {}); }
  };
  for (const ev of ['pointerdown', 'keydown', 'focus']) window.addEventListener(ev, onActive, { passive: true });
  const idleTimer = setInterval(() => {
    if (!autoIdle && data.isOnline && (data.me.presence || 'online') === 'online' && Date.now() - lastActive > 10 * 60_000) {
      autoIdle = true;
      data.updateProfile({ presence: 'idle' }).catch(() => {});
    }
  }, 30_000);

  // 설정이 바뀌면 메시지 다시 그리기 (단어 필터, 키워드, 시간 형식 등)
  const onSettings = (patch) => {
    if (['filterWords', 'keywords', 'embeds', 'autoloadMedia', 'clock24'].some((k) => k in patch)) ctx.emit('rerender');
  };
  settingsChanged.add(onSettings);

  document.addEventListener('visibilitychange', () => { if (!document.hidden && ctx.roomId && ctx.mainMode === 'chat' && chat.atBottom) ctx.markRead(ctx.roomId); });

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
  data.on('notice', ({ text, type }) => toast(text, type || 'info', 6000));

  // ───────── 라우팅 ─────────
  const routeId = () => location.hash.match(/^#\/room\/([\w-]+)/)?.[1];
  // 앱 아이콘을 길게 눌러 나오는 바로가기: #/mentions, #/search, #/bookmarks
  const routePanel = () => location.hash.match(/^#\/(mentions|search|bookmarks)$/)?.[1];
  const openShortcut = (k) => {
    if (k === 'search') { panels.search('', true); layout.classList.add('panel-open'); } else if (panels.kind !== k) ctx.togglePanel(k);
  };
  const launchPanel = routePanel();
  const routeMsg = () => location.hash.match(/^#\/room\/[\w-]+\/m\/([\w-]+)/)?.[1];
  const onHash = () => {
    if (routePanel()) { openShortcut(routePanel()); return; }
    const id = routeId();
    const mid = routeMsg();
    if (id && data.nodes.has(id) && mid) ctx.jumpTo(id, mid);
    else if (id && id !== ctx.roomId && data.nodes.has(id)) ctx.openRoom(id, { replace: true });
  };
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
      if (!initialized) setTimeout(restoreWorkspace, 300);
      const target = (want && data.nodes.has(want) && want) || (!initialized && first?.id);
      if (target) {
        initialized = true;
        const mid = routeMsg();
        if (mid && target === routeId()) ctx.jumpTo(target, mid);
        else ctx.openRoom(target, { replace: true });
        if (launchPanel) openShortcut(launchPanel);
      } else if (!initialized) showEmpty();
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
      // 채팅방 제목 막대를 좌우로 밀면 최근 대화로 전환
      else if (!touch.open && touch.head) switchRecent(dx < 0 ? 1 : -1);
    }
    touch = null;
  }, { passive: true });
  layout.addEventListener('touchstart', (e) => { if (touch && e.target.closest('.room-head') && !e.target.closest('button')) touch.head = true; }, { passive: true });
  // 최근 대화 사이를 오가기 (모바일 제목 막대 스와이프)
  let recentIdx = 0;
  function switchRecent(dir) {
    const list = recentRooms.list().filter((id) => data.nodes.has(id));
    if (list.length < 2) return;
    const cur = list.indexOf(ctx.roomId);
    recentIdx = Math.max(0, Math.min(list.length - 1, (cur < 0 ? 0 : cur) + dir));
    const id = list[recentIdx];
    if (id && id !== ctx.roomId) {
      const keep = recentRooms.list();
      ctx.openRoom(id);
      // 스와이프로 오갈 때는 최근 목록 순서를 바꾸지 않음
      try { localStorage.setItem('cs.recentRooms', JSON.stringify(keep)); } catch { /* noop */ }
      toast(`${data.nodes.get(id).type === 'dm' ? '@' : '#'}${data.roomLabel(data.nodes.get(id))}`, 'info', 1200);
    }
  }

  // ───────── 작업 공간 복원 (분할 화면 · 패널) ─────────
  let restored = false;
  function restoreWorkspace() {
    if (restored) return;
    restored = true;
    const w = workspace.get();
    if (w.split && data.nodes.has(w.split) && w.split !== ctx.roomId && !isMobile()) ctx.openSplit(w.split);
    if (w.panel && !isMobile() && !panels.kind && !launchPanel) ctx.togglePanel(w.panel);
    renderDock();
  }

  // ───────── 통합 탐색: 방 · 사람 · 메시지 · 파일 (Ctrl/⌘+K 는 방·사람, Ctrl/⌘+Shift+F 는 전체) ─────────
  const pathOf = (n) => { if (n.type === 'dm') return '1:1 대화'; const p = []; for (let c = data.nodes.get(n.parentId); c; c = data.nodes.get(c.parentId)) p.unshift(c.name); return p.join(' / '); };
  const roomIcon = (n) => (n.type === 'dm' ? avatar(data.dmPartner(n), 18, { presence: data.presenceOf(data.dmPartner(n).id) }) : n.emoji ? h('span', {}, n.emoji) : icon({ voice: 'voice', code: 'code', board: 'grid' }[n.type] || 'hash', 16));
  function unifiedSearch({ full = false, title = full ? '통합 탐색' : '빠른 이동', onPickRoom = null, exclude = [] } = {}) {
    const input = h('input', { class: 'input', placeholder: full ? '방, 사람, 메시지, 파일 찾기' : '방 · 사람 이름', autofocus: true, 'aria-label': '검색' });
    const results = h('div', { class: 'qs-results', role: 'listbox' });
    let idx = 0;
    let items = [];
    let remote = { q: '', messages: [], files: [], loading: false };
    const go = (fn) => () => { m.close(); fn(); };
    const roomItem = (n) => ({ key: `r:${n.id}`, view: [roomIcon(n), h('span', {}, data.roomLabel(n)), h('span', { class: 'muted small' }, pathOf(n)), ctx.unread.get(n.id) ? h('span', { class: 'unread-badge' }, String(ctx.unread.get(n.id))) : null], run: go(() => (onPickRoom ? onPickRoom(n) : ctx.openRoom(n.id))) });
    const render = () => {
      const q = input.value.trim().toLowerCase();
      const groups = [];
      const rooms = [...data.nodes.values()].filter((n) => n.type !== 'folder' && !exclude.includes(n.id) && (!onPickRoom || isChatRoom(n)));
      if (!q) {
        const recent = recentRooms.list().map((id) => data.nodes.get(id)).filter((n) => n && rooms.includes(n)).slice(0, 8);
        if (recent.length) groups.push(['최근', recent.map(roomItem)]);
      } else {
        const match = rooms.filter((n) => `${data.roomLabel(n)} ${n.topic || ''}`.toLowerCase().includes(q))
          .sort((a, b) => (b.lastMessageAt || 0) - (a.lastMessageAt || 0)).slice(0, full ? 6 : 10);
        if (match.length) groups.push(['방', match.map(roomItem)]);
        if (!onPickRoom) {
          const people = [...data.users.values()].filter((u) => u.id !== data.me.id && (u.nickname || '').toLowerCase().includes(q)).slice(0, 6);
          if (people.length) {
            groups.push(['사람', people.map((u) => ({
              key: `u:${u.id}`,
              view: [avatar(u, 18, { presence: data.presenceOf(u.id) }), h('span', {}, u.nickname), h('span', { class: 'muted small' }, data.can('directMessage') ? 'Enter: 1:1 대화 · 프로필은 오른쪽' : '프로필'),
                h('button', { class: 'link-btn small', type: 'button', onclick: (e) => { e.stopPropagation(); m.close(); profileDialog(ctx, u.id); } }, '프로필')],
              run: go(async () => { if (!data.can('directMessage')) return profileDialog(ctx, u.id); try { const n = await data.openDm(u.id); ctx.openRoom(n.id); } catch (er) { toast(er.message, 'error'); } }),
            }))]);
          }
        }
        if (full && remote.q === q) {
          if (remote.messages.length) {
            groups.push(['메시지', remote.messages.slice(0, 8).map((x) => ({
              key: `m:${x.id}`, view: [icon('message', 16), h('span', { class: 'ellipsis' }, `${(data.user(x.authorId) || x.author)?.nickname || '?'}: ${(x.content || '📎').slice(0, 60)}`), h('span', { class: 'muted small' }, `${data.roomLabel(data.nodes.get(x.roomId))} · ${fmtStamp(x.createdAt)}`)],
              run: go(() => ctx.jumpTo(x.roomId, x.id)),
            }))]);
          }
          if (remote.files.length) {
            groups.push(['파일', remote.files.slice(0, 6).map(({ a, x }) => ({
              key: `f:${a.id}`, view: [icon(a.kind === 'image' ? 'image' : 'file', 16), h('span', { class: 'ellipsis' }, a.name), h('span', { class: 'muted small' }, `${fmtBytes(a.size)} · ${data.roomLabel(data.nodes.get(x.roomId))}`)],
              run: go(() => ctx.jumpTo(x.roomId, x.id)),
            }))]);
          }
        }
      }
      items = groups.flatMap(([, list]) => list);
      idx = Math.min(idx, Math.max(0, items.length - 1));
      let k = 0;
      results.replaceChildren(...groups.flatMap(([label, list]) => [h('div', { class: 'qs-group muted small' }, label),
        ...list.map((it) => { const i = k++; return h('div', { class: `qs-item${i === idx ? ' active' : ''}`, role: 'option', tabindex: '-1', onclick: it.run }, ...it.view); })]));
      if (full && q && remote.loading) results.append(h('p', { class: 'muted small pad' }, '메시지 · 파일 검색 중…'));
      if (!items.length && !(full && remote.loading)) results.append(h('p', { class: 'muted small pad' }, q ? '일치하는 결과가 없습니다.' : '이름을 입력하세요.'));
    };
    const searchRemote = debounce(async () => {
      const q = input.value.trim().toLowerCase();
      if (!full || q.length < 2) return;
      remote = { q, messages: [], files: [], loading: true };
      render();
      try {
        const list = (await data.search({ roomId: null, q })).filter((x) => !blocked.has(x.authorId) && data.nodes.has(x.roomId));
        if (input.value.trim().toLowerCase() !== q) return;
        remote = {
          q, loading: false,
          messages: list.filter((x) => (x.content || '').toLowerCase().includes(q)),
          files: list.flatMap((x) => (x.attachments || []).filter((a) => a.name.toLowerCase().includes(q)).map((a) => ({ a, x }))),
        };
      } catch { remote = { q, messages: [], files: [], loading: false }; }
      render();
    }, 300);
    input.addEventListener('input', () => { idx = 0; render(); searchRemote(); });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') { e.preventDefault(); idx = Math.min(items.length - 1, idx + 1); render(); }
      if (e.key === 'ArrowUp') { e.preventDefault(); idx = Math.max(0, idx - 1); render(); }
      if (e.key === 'Enter' && items[idx] && !e.isComposing) { e.preventDefault(); items[idx].run(); }
    });
    const m = openModal({ title, cls: 'qs-modal', body: [input, results] });
    render();
  }
  const quickSwitcher = () => unifiedSearch();
  ctx.unifiedSearch = () => unifiedSearch({ full: true });
  function roomPicker(title, onPick, opts = {}) { unifiedSearch({ title, onPickRoom: onPick, ...opts }); }
  // 사이드바에 보이는 순서대로 방 목록 (폴더 펼침과 무관하게 트리 순서)
  const orderedRooms = () => {
    const out = [];
    const walk = (pid) => { for (const n of data.children(pid)) { if (n.type === 'folder') walk(n.id); else out.push(n); } };
    walk(null);
    return out;
  };
  const isUnread = (n) => isChatRoom(n) && roomNotify.get(n.id) !== 'none' && (ctx.unread.has(n.id) || (n.lastMessageAt || 0) > (ctx.lastRead[n.id] || 0));
  const onKey = (e) => {
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.shiftKey && e.key.toLowerCase() === 'f') { e.preventDefault(); ctx.unifiedSearch(); return; }
    if (mod && e.key.toLowerCase() === 'k') { e.preventDefault(); quickSwitcher(); }
    if (mod && e.key === '\\') { e.preventDefault(); if (ctx.splitRoomId) ctx.closeSplit(); else ctx.pickSplit(); }
    if (mod && e.key === '.') { e.preventDefault(); quickSettings(ctx, document.querySelector('.user-panel') || document.body); }
    if (mod && e.key === '/') { e.preventDefault(); shortcutsDialog(); }
    if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      e.preventDefault();
      const rooms = orderedRooms();
      const d = e.key === 'ArrowDown' ? 1 : -1;
      const i = rooms.findIndex((n) => n.id === ctx.roomId);
      for (let k = 1; k <= rooms.length; k++) {
        const n = rooms[(i + d * k + rooms.length * 2) % rooms.length];
        if (!n) break;
        if (!e.shiftKey || isUnread(n)) { ctx.openRoom(n.id); return; }
      }
      if (e.shiftKey) toast('안 읽은 방이 없습니다.');
    }
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
    updateBadges();
  });
  window.addEventListener('pointerdown', () => sounds.unlock(), { once: true });

  return {
    destroy() {
      calls.leave();
      data.destroy();
      clearInterval(reminderTimer);
      clearInterval(idleTimer);
      settingsChanged.delete(onSettings);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('hashchange', onHash);
      window.removeEventListener('popstate', onHash);
    },
  };
}

boot();
