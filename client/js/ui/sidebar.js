import { config } from '../config.js';
import { h, toast, isTouch } from '../util.js';
import { icon } from './icons.js';
import { avatar, badge, openMenu, PRESENCE_LABEL } from './common.js';
import {
  createNodeDialog, editNodeDialog, moveNodeDialog, deleteNodeDialog, profileDialog, settingsDialog, roomInfoDialog, exportDialog, editProfileDialog,
} from './dialogs.js';
import { favorites, roomNotify, personal } from '../local.js';
import { errorText } from './errors.js';
import { install, installable, openInstall } from '../install.js';

const COLLAPSED_KEY = 'cs.collapsed';
const collapsed = new Set((() => { try { return JSON.parse(localStorage.getItem(COLLAPSED_KEY)) || []; } catch { return []; } })());
const saveCollapsed = () => { try { localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...collapsed])); } catch { /* noop */ } };

export function createSidebar(ctx) {
  const { data, calls } = ctx;
  const tree = h('div', { class: 'tree', role: 'tree', 'aria-label': '채팅방 목록' });
  const addBtn = h('button', { class: 'icon-btn', title: '만들기', 'aria-label': '채팅방·통화방·폴더 만들기', onclick: () => createNodeDialog(ctx) }, icon('plus'));
  let filterText = '';
  const filter = h('input', {
    class: 'input tree-filter', type: 'search', placeholder: '방 찾기', 'aria-label': '방 이름으로 찾기',
    oninput: (e) => { filterText = e.target.value.trim().toLowerCase(); render(); },
    onkeydown: (e) => {
      if (e.key === 'Enter') tree.querySelector('.tree-row:not(.folder)')?.click();
      if (e.key === 'Escape') { filter.value = ''; filterText = ''; render(); }
    },
  });
  const installBtn = h('button', {
    class: 'icon-btn install-btn', title: '앱으로 설치 (홈 화면 · 바탕화면)', 'aria-label': '앱으로 설치', hidden: !installable(), onclick: () => openInstall(),
  }, icon('download'));
  install.on('change', () => { installBtn.hidden = !installable(); });
  const headMenuBtn = h('button', {
    class: 'icon-btn', title: '목록 메뉴', 'aria-label': '목록 메뉴',
    onclick: (e) => openMenu(e.currentTarget, [
      { label: '모든 폴더 펼치기', icon: 'chevronDown', onClick: () => { collapsed.clear(); saveCollapsed(); render(); } },
      { label: '모든 폴더 접기', icon: 'chevron', onClick: () => { for (const n of data.nodes.values()) if (n.type === 'folder') collapsed.add(n.id); saveCollapsed(); render(); } },
      { label: '모두 읽음으로 표시', icon: 'check', onClick: () => ctx.markAllRead() },
    ]),
  }, icon('more'));
  const voiceBar = h('div', { class: 'voice-bar', hidden: true });
  const userPanel = h('div', { class: 'user-panel' });
  const el = h('aside', { class: 'sidebar', 'aria-label': '사이드바' },
    h('header', { class: 'side-head' }, h('h1', { class: 'ellipsis' }, config.appName), installBtn, headMenuBtn, addBtn),
    h('div', { class: 'tree-filter-wrap' }, filter),
    tree, voiceBar, userPanel);

  let dragId = null;

  ctx.expandFolder = (id) => {
    let cur = data.nodes.get(id);
    while (cur) { collapsed.delete(cur.id); cur = data.nodes.get(cur.parentId); }
    saveCollapsed();
    render();
  };

  function nodeMenu(node, anchor) {
    const manage = data.can('manageNodes');
    const items = [];
    if (node.type === 'folder') {
      if (manage) {
        items.push(
          { label: '채팅방 만들기', icon: 'hash', onClick: () => createNodeDialog(ctx, { parentId: node.id, type: 'text' }) },
          { label: '통화방 만들기', icon: 'voice', onClick: () => createNodeDialog(ctx, { parentId: node.id, type: 'voice' }) },
          { label: '하위 폴더 만들기', icon: 'folder', onClick: () => createNodeDialog(ctx, { parentId: node.id, type: 'folder' }) },
          'sep',
        );
      }
      items.push({ label: collapsed.has(node.id) ? '펼치기' : '접기', icon: 'chevronDown', onClick: () => toggle(node.id) });
    } else {
      const notify = roomNotify.get(node.id);
      items.push(
        { label: favorites.has(node.id) ? '즐겨찾기 해제' : '즐겨찾기에 추가', icon: 'star', onClick: () => { const on = favorites.toggle(node.id); toast(on ? '⭐ 즐겨찾기에 추가했습니다.' : '즐겨찾기에서 뺐습니다.'); } },
        node.type === 'text' ? { label: '읽음으로 표시', icon: 'check', onClick: () => ctx.markRead(node.id) } : null,
        node.type === 'text' ? 'sep' : null,
        node.type === 'text' ? { label: `${notify === 'all' ? '✓ ' : ''}알림: 모든 메시지`, icon: 'bell', onClick: () => roomNotify.set(node.id, 'all') } : null,
        node.type === 'text' ? { label: `${notify === 'mentions' ? '✓ ' : ''}알림: 멘션만`, icon: 'at', onClick: () => roomNotify.set(node.id, 'mentions') } : null,
        node.type === 'text' ? { label: `${notify === 'none' ? '✓ ' : ''}알림 끄기 (음소거)`, icon: 'bellOff', onClick: () => roomNotify.set(node.id, 'none') } : null,
        'sep',
        { label: '방 정보', icon: 'info', onClick: () => roomInfoDialog(ctx, node) },
        node.type === 'text' ? { label: '채팅 내보내기', icon: 'download', onClick: () => exportDialog(ctx, node) } : null,
        { label: '링크 복사', icon: 'link', onClick: () => copyLink(node) },
      );
    }
    if (manage) {
      items.push('sep',
        { label: node.type === 'folder' ? '이름 변경' : '편집', icon: 'edit', onClick: () => editNodeDialog(ctx, node) },
        { label: '이동', icon: 'move', onClick: () => moveNodeDialog(ctx, node) },
        'sep',
        { label: '삭제', icon: 'trash', danger: true, onClick: () => deleteNodeDialog(ctx, node) });
    }
    openMenu(anchor, items.filter((x, i, a) => !(x === 'sep' && (i === 0 || a[i - 1] === 'sep'))));
  }
  ctx.roomMenu = (id, anchor) => { const n = data.nodes.get(id); if (n) nodeMenu(n, anchor); };

  function copyLink(node) {
    const url = `${location.origin}${location.pathname}#/room/${node.id}`;
    navigator.clipboard?.writeText(url).then(() => toast('링크를 복사했습니다.'), () => toast(url));
  }

  function toggle(id) {
    if (collapsed.has(id)) collapsed.delete(id); else collapsed.add(id);
    saveCollapsed();
    render();
  }

  function dropZone(e, row, node) {
    const r = row.getBoundingClientRect();
    const y = (e.clientY - r.top) / r.height;
    if (node.type === 'folder') return y < 0.25 ? 'before' : y > 0.75 && collapsed.has(node.id) ? 'after' : y > 0.75 ? 'after' : 'inside';
    return y < 0.5 ? 'before' : 'after';
  }

  function clearDrop() {
    tree.querySelectorAll('.drop-before,.drop-after,.drop-inside').forEach((x) => x.classList.remove('drop-before', 'drop-after', 'drop-inside'));
  }

  function row(node, depth) {
    const manage = data.can('manageNodes');
    const isFolder = node.type === 'folder';
    const open = isFolder && !collapsed.has(node.id);
    const active = ctx.roomId === node.id;
    const unread = ctx.unread.get(node.id) || 0;
    const dot = !unread && !active && node.type === 'text' && (node.lastMessageAt || 0) > (ctx.lastRead[node.id] || 0);
    const mention = ctx.mentions.has(node.id);
    const inCall = node.type === 'voice' ? data.calls[node.id] || [] : [];
    const muted = node.type === 'text' && roomNotify.get(node.id) === 'none';

    const more = h('button', {
      class: 'icon-btn tiny row-more', title: '더보기', 'aria-label': `${node.name} 메뉴`,
      onclick: (e) => { e.stopPropagation(); nodeMenu(node, e.currentTarget); },
    }, icon('more', 16));
    const add = isFolder && manage ? h('button', {
      class: 'icon-btn tiny row-add', title: '이 폴더에 만들기', 'aria-label': `${node.name}에 만들기`,
      onclick: (e) => { e.stopPropagation(); createNodeDialog(ctx, { parentId: node.id }); },
    }, icon('plus', 16)) : null;

    const r = h('div', {
      class: `tree-row ${node.type}${active ? ' active' : ''}${(unread || dot) && !muted ? ' unread' : ''}${muted ? ' muted-room' : ''}`,
      role: 'treeitem',
      tabindex: '0',
      'aria-expanded': isFolder ? String(open) : null,
      'aria-selected': active ? 'true' : null,
      style: { paddingLeft: `${8 + depth * 14}px`, ...(node.color ? { '--folder-color': node.color } : {}) },
      draggable: manage && !isTouch() ? 'true' : null,
      dataset: { id: node.id },
      onclick: () => (isFolder ? toggle(node.id) : ctx.openRoom(node.id)),
      onkeydown: (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); r.click(); }
        if (isFolder && e.key === 'ArrowRight' && !open) toggle(node.id);
        if (isFolder && e.key === 'ArrowLeft' && open) toggle(node.id);
      },
      oncontextmenu: (e) => { e.preventDefault(); nodeMenu(node, e); },
      ondragstart: (e) => { dragId = node.id; e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', node.id); r.classList.add('dragging'); },
      ondragend: () => { dragId = null; r.classList.remove('dragging'); clearDrop(); },
      ondragover: (e) => {
        if (!dragId || dragId === node.id) return;
        if (data.descendants(dragId).includes(node.id)) return;
        e.preventDefault();
        e.stopPropagation();
        clearDrop();
        r.classList.add(`drop-${dropZone(e, r, node)}`);
      },
      ondragleave: () => r.classList.remove('drop-before', 'drop-after', 'drop-inside'),
      ondrop: async (e) => {
        e.preventDefault();
        e.stopPropagation();
        const where = dropZone(e, r, node);
        const id = dragId;
        clearDrop();
        if (!id || id === node.id) return;
        try {
          await data.moveNode(id, node.id, where);
          if (where === 'inside') ctx.expandFolder(node.id);
        } catch (er) {
          toast(er.code === 'invalid_move' ? '하위 폴더로는 옮길 수 없습니다.' : '이동하지 못했습니다.', 'error');
        }
      },
    },
    isFolder ? icon(open ? 'chevronDown' : 'chevron', 14, 'chev') : null,
    node.emoji && !isFolder ? h('span', { class: 'node-emoji' }, node.emoji) : icon(isFolder ? (open ? 'folderOpen' : 'folder') : node.type === 'voice' ? 'voice' : 'hash', 18, `node-icon${node.color ? ' colored' : ''}`),
    h('span', { class: 'tree-name ellipsis' }, isFolder && node.emoji ? `${node.emoji} ${node.name}` : node.name),
    node.readonly ? h('span', { class: 'dim', title: '공지 전용' }, '📢') : null,
    muted ? icon('bellOff', 14, 'dim') : null,
    inCall.length ? h('span', { class: 'call-count', title: `${inCall.length}명 통화 중` }, `${inCall.length}`) : null,
    unread && (!muted || mention) ? h('span', { class: `unread-badge${mention ? ' mention' : ''}` }, unread > 99 ? '99+' : String(unread)) : dot && !muted ? h('span', { class: 'unread-dot', title: '새 메시지' }) : null,
    add, more);

    const out = [r];
    if (inCall.length) {
      out.push(h('div', { class: 'call-members', style: { paddingLeft: `${32 + depth * 14}px` } },
        inCall.map((p) => {
          const u = data.user(p.userId) || { id: p.userId, nickname: '…' };
          const speaking = calls.speaking.has(p.sid);
          return h('div', { class: `call-member${speaking ? ' speaking' : ''}`, dataset: { sid: p.sid }, onclick: () => profileDialog(ctx, p.userId) },
            avatar(u, 20), h('span', { class: 'ellipsis' }, u.nickname),
            p.state?.screen ? icon('screen', 13, 'dim') : p.state?.video ? icon('video', 13, 'dim') : null,
            p.state?.muted ? icon('micOff', 13, 'dim') : null,
            p.state?.deaf ? icon('headphonesOff', 13, 'dim') : null);
        })));
    }
    if (isFolder && open) {
      const kids = data.children(node.id);
      const group = h('div', { role: 'group', class: 'tree-group' });
      if (!kids.length) group.append(h('div', { class: 'tree-empty', style: { paddingLeft: `${30 + depth * 14}px` } }, '비어 있음'));
      for (const k of kids) group.append(...row(k, depth + 1));
      out.push(group);
    }
    return out;
  }

  const pathOf = (n) => { const p = []; for (let c = data.nodes.get(n.parentId); c; c = data.nodes.get(c.parentId)) p.unshift(c.name); return p.join(' / '); };

  function render() {
    addBtn.hidden = !data.can('manageNodes');
    const roots = data.children(null);
    if (filterText) {
      const found = [...data.nodes.values()].filter((n) => n.type !== 'folder' && `${n.name} ${n.topic || ''}`.toLowerCase().includes(filterText));
      tree.replaceChildren(...(found.length
        ? found.flatMap((n) => { const rows = row(n, 0); rows[0].append(h('span', { class: 'tree-path ellipsis' }, pathOf(n))); return rows; })
        : [h('p', { class: 'muted small pad' }, '일치하는 방이 없습니다.')]));
      renderVoiceBar();
      return;
    }
    const favs = favorites.list().map((id) => data.nodes.get(id)).filter(Boolean);
    const favSection = favs.length ? [h('div', { class: 'tree-section' }, icon('star', 12), ' 즐겨찾기'), ...favs.flatMap((n) => row(n, 0).slice(0, 1)), h('div', { class: 'tree-section' }, '전체')] : [];
    if (!roots.length) {
      tree.replaceChildren(h('div', { class: 'tree-placeholder' },
        h('p', {}, '아직 채팅방이 없습니다.'),
        data.can('manageNodes')
          ? h('button', { class: 'btn primary small', onclick: () => createNodeDialog(ctx) }, icon('plus', 16), ' 채팅방 만들기')
          : h('p', { class: 'muted small' }, '로그인한 사용자가 채팅방을 만들면 여기에 표시됩니다.')));
    } else {
      tree.replaceChildren(...favSection, ...roots.flatMap((n) => row(n, 0)));
    }
    renderVoiceBar();
  }

  tree.addEventListener('dragover', (e) => { if (dragId) { e.preventDefault(); } });
  tree.addEventListener('drop', async (e) => {
    if (!dragId || e.target !== tree) return;
    e.preventDefault();
    const id = dragId;
    clearDrop();
    await data.moveNode(id, null, 'inside').catch(() => toast('이동하지 못했습니다.', 'error'));
  });

  function renderVoiceBar() {
    if (!calls.active) { voiceBar.hidden = true; return; }
    voiceBar.hidden = false;
    const room = data.nodes.get(calls.roomId);
    voiceBar.replaceChildren(
      h('button', { class: 'voice-info', onclick: () => ctx.openRoom(calls.roomId) },
        h('span', { class: 'voice-status' }, icon('voice', 14), ' 통화 연결됨'),
        h('span', { class: 'muted small ellipsis' }, room?.name || '')),
      h('button', { class: `icon-btn${calls.state.muted ? ' danger-on' : ''}`, title: calls.state.muted ? '음소거 해제' : '음소거', onclick: () => calls.toggleMute() }, icon(calls.state.muted ? 'micOff' : 'mic', 18)),
      h('button', { class: 'icon-btn danger-on', title: '통화 나가기', onclick: () => calls.leave() }, icon('phoneOff', 18)),
    );
  }

  function presenceMenu(anchor) {
    const set = (presence) => data.updateProfile({ presence }).then(() => { ctx.manualPresence = presence; }, (e) => toast(errorText(e), 'error'));
    const cur = data.me.presence || 'online';
    openMenu(anchor, [
      ...['online', 'idle', 'dnd', 'invisible'].map((p) => ({ label: `${cur === p ? '✓ ' : ''}${PRESENCE_LABEL[p]}`, onClick: () => set(p) })),
      'sep',
      { label: data.me.status ? `상태 메시지 바꾸기 (${data.me.status})` : '상태 메시지 설정', icon: 'edit', onClick: () => editProfileDialog(ctx) },
      data.me.status ? { label: '상태 메시지 지우기', icon: 'x', onClick: () => data.updateProfile({ status: '' }) } : null,
      { label: '내 프로필 보기', icon: 'user', onClick: () => profileDialog(ctx, data.me.id) },
    ]);
  }

  function renderUser() {
    const st = data.status();
    const statusIcon = { online: 'cloud', offline: 'cloudOff', local: 'device', connecting: 'refresh' }[st.mode];
    const statusText = {
      online: '서버와 동기화 중', offline: st.needsLogin ? '오프라인 — 다시 로그인 필요' : '오프라인 — 기기에 저장 중', local: '로컬 모드 — 기기에만 저장', connecting: '서버 연결 중…',
    }[st.mode];
    userPanel.replaceChildren(
      h('button', { class: 'user-chip', onclick: (e) => presenceMenu(e.currentTarget), title: '상태 · 프로필' },
        avatar(data.me, 34, { presence: st.mode === 'online' ? (data.me.presence || 'online') : 'offline' }),
        h('span', { class: 'user-meta' }, h('span', { class: 'user-name ellipsis' }, data.me.nickname),
          data.me.status ? h('span', { class: 'user-status ellipsis' }, data.me.status) : badge(data.me.provider))),
      h('span', { class: `conn conn-${st.mode}`, title: statusText, 'aria-label': statusText }, icon(statusIcon, 18), st.pendingOps && st.mode !== 'local' ? h('span', { class: 'conn-count' }, String(st.pendingOps)) : null),
      h('button', { class: 'icon-btn', title: '설정', 'aria-label': '설정', onclick: () => settingsDialog(ctx) }, icon('gear')),
    );
  }

  data.on('nodes', render);
  data.on('calls', render);
  data.on('users', () => { render(); renderUser(); });
  data.on('me', renderUser);
  data.on('status', () => { renderUser(); render(); });
  calls.on('update', render);
  calls.on('speaking', () => tree.querySelectorAll('.call-member').forEach((m) => m.classList.toggle('speaking', calls.speaking.has(m.dataset.sid))));
  ctx.on('unread', render);
  personal.on('cs.favorites', render);
  personal.on('cs.roomNotify', render);
  ctx.on('room', render);

  render();
  renderUser();
  return { el, render };
}
