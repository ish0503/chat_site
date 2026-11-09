import { config } from '../config.js';
import { h, toast, isTouch } from '../util.js';
import { icon } from './icons.js';
import { avatar, badge, openMenu } from './common.js';
import { createNodeDialog, editNodeDialog, moveNodeDialog, deleteNodeDialog, profileDialog, settingsDialog } from './dialogs.js';

const COLLAPSED_KEY = 'cs.collapsed';
const collapsed = new Set((() => { try { return JSON.parse(localStorage.getItem(COLLAPSED_KEY)) || []; } catch { return []; } })());
const saveCollapsed = () => { try { localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...collapsed])); } catch { /* noop */ } };

export function createSidebar(ctx) {
  const { data, calls } = ctx;
  const tree = h('div', { class: 'tree', role: 'tree', 'aria-label': '채팅방 목록' });
  const addBtn = h('button', { class: 'icon-btn', title: '만들기', 'aria-label': '채팅방·통화방·폴더 만들기', onclick: () => createNodeDialog(ctx) }, icon('plus'));
  const voiceBar = h('div', { class: 'voice-bar', hidden: true });
  const userPanel = h('div', { class: 'user-panel' });
  const el = h('aside', { class: 'sidebar', 'aria-label': '사이드바' },
    h('header', { class: 'side-head' }, h('h1', { class: 'ellipsis' }, config.appName), addBtn),
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
      items.push(
        { label: '링크 복사', icon: 'link', onClick: () => copyLink(node) },
        node.type === 'text' ? { label: '읽음으로 표시', icon: 'check', onClick: () => ctx.markRead(node.id) } : null,
      );
    }
    if (manage) {
      items.push('sep',
        { label: node.type === 'folder' ? '이름 변경' : '편집', icon: 'edit', onClick: () => editNodeDialog(ctx, node) },
        { label: '이동', icon: 'move', onClick: () => moveNodeDialog(ctx, node) },
        'sep',
        { label: '삭제', icon: 'trash', danger: true, onClick: () => deleteNodeDialog(ctx, node) });
    }
    openMenu(anchor, items);
  }

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

    const more = h('button', {
      class: 'icon-btn tiny row-more', title: '더보기', 'aria-label': `${node.name} 메뉴`,
      onclick: (e) => { e.stopPropagation(); nodeMenu(node, e.currentTarget); },
    }, icon('more', 16));
    const add = isFolder && manage ? h('button', {
      class: 'icon-btn tiny row-add', title: '이 폴더에 만들기', 'aria-label': `${node.name}에 만들기`,
      onclick: (e) => { e.stopPropagation(); createNodeDialog(ctx, { parentId: node.id }); },
    }, icon('plus', 16)) : null;

    const r = h('div', {
      class: `tree-row ${node.type}${active ? ' active' : ''}${unread || dot ? ' unread' : ''}`,
      role: 'treeitem',
      tabindex: '0',
      'aria-expanded': isFolder ? String(open) : null,
      'aria-selected': active ? 'true' : null,
      style: { paddingLeft: `${8 + depth * 14}px` },
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
    icon(isFolder ? (open ? 'folderOpen' : 'folder') : node.type === 'voice' ? 'voice' : 'hash', 18, 'node-icon'),
    h('span', { class: 'tree-name ellipsis' }, node.name),
    inCall.length ? h('span', { class: 'call-count', title: `${inCall.length}명 통화 중` }, `${inCall.length}`) : null,
    unread ? h('span', { class: `unread-badge${mention ? ' mention' : ''}` }, unread > 99 ? '99+' : String(unread)) : dot ? h('span', { class: 'unread-dot', title: '새 메시지' }) : null,
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

  function render() {
    addBtn.hidden = !data.can('manageNodes');
    const roots = data.children(null);
    if (!roots.length) {
      tree.replaceChildren(h('div', { class: 'tree-placeholder' },
        h('p', {}, '아직 채팅방이 없습니다.'),
        data.can('manageNodes')
          ? h('button', { class: 'btn primary small', onclick: () => createNodeDialog(ctx) }, icon('plus', 16), ' 채팅방 만들기')
          : h('p', { class: 'muted small' }, '로그인한 사용자가 채팅방을 만들면 여기에 표시됩니다.')));
    } else {
      tree.replaceChildren(...roots.flatMap((n) => row(n, 0)));
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

  function renderUser() {
    const st = data.status();
    const statusIcon = { online: 'cloud', offline: 'cloudOff', local: 'device', connecting: 'refresh' }[st.mode];
    const statusText = {
      online: '서버와 동기화 중', offline: st.needsLogin ? '오프라인 — 다시 로그인 필요' : '오프라인 — 기기에 저장 중', local: '로컬 모드 — 기기에만 저장', connecting: '서버 연결 중…',
    }[st.mode];
    userPanel.replaceChildren(
      h('button', { class: 'user-chip', onclick: () => profileDialog(ctx, data.me.id), title: '내 프로필' },
        avatar(data.me, 34, { online: st.mode === 'online' }),
        h('span', { class: 'user-meta' }, h('span', { class: 'user-name ellipsis' }, data.me.nickname), badge(data.me.provider))),
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
  ctx.on('room', render);

  render();
  renderUser();
  return { el, render };
}
