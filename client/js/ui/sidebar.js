import { config } from '../config.js';
import { h, toast, isTouch } from '../util.js';
import { icon } from './icons.js';
import {
  avatar, badge, openMenu, openModal, PRESENCE_LABEL, confirmDialog,
} from './common.js';
import {
  createNodeDialog, editNodeDialog, moveNodeDialog, deleteNodeDialog, profileDialog, settingsDialog, roomInfoDialog, exportDialog, editProfileDialog,
  settings, saveSettings, settingsChanged, quickSettings, sidebarCustomizeDialog, SIDEBAR_SECTIONS, aiDialog,
} from './dialogs.js';
import {
  favorites, roomNotify, personal, archived, drafts,
} from '../local.js';
import { errorText } from './errors.js';
import { convertDialog } from './board.js';
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
      'sep',
      data.can('directMessage') ? { label: '새 1:1 대화', icon: 'message', onClick: () => newDmDialog() } : null,
      { label: '통합 탐색 (Ctrl+Shift+F)', icon: 'search', onClick: () => ctx.unifiedSearch() },
      { label: '사이드바 구성 바꾸기', icon: 'sliders', onClick: () => sidebarCustomizeDialog() },
    ]),
  }, icon('more'));
  const voiceBar = h('div', { class: 'voice-bar', hidden: true });
  const userPanel = h('div', { class: 'user-panel' });
  // 사이드바 너비 조절 (끌어서)
  const resizer = h('div', { class: 'resizer side-resizer', role: 'separator', 'aria-orientation': 'vertical', 'aria-label': '사이드바 너비 조절', title: '끌어서 너비 조절 (두 번 누르면 기본값)' });
  attachResizer(resizer, '--side-w', 'sidebarWidth', 200, 420, 1);
  const el = h('aside', { class: 'sidebar', 'aria-label': '사이드바' },
    h('header', { class: 'side-head' }, h('h1', { class: 'ellipsis' }, config.appName), installBtn, headMenuBtn, addBtn),
    h('div', { class: 'tree-filter-wrap' }, filter),
    tree, voiceBar, userPanel, resizer);

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
      const chat = ['text', 'dm', 'code', 'board'].includes(node.type);
      items.push(
        node.type === 'dm' ? { label: '상대 프로필', icon: 'user', onClick: () => profileDialog(ctx, data.dmPartner(node).id) } : null,
        node.type === 'dm' && data.isOnline ? {
          label: '대화 내용 지우기 (나에게서만)', icon: 'trash', onClick: async () => {
            const ok = await confirmDialog({ title: '대화 내용 지우기', message: `${data.dmPartner(node).nickname}님과 나눈 지금까지의 대화를 나에게서만 지울까요?\n상대에게는 그대로 남아 있습니다. 두 사람이 모두 지운 부분은 서버에서도 삭제됩니다.`, confirmText: '지우기', danger: true });
            if (!ok) return;
            try { await data.clearDm(node.id); toast('대화 내용을 지웠습니다.'); } catch (e) { toast(errorText(e), 'error'); }
          },
        } : null,
        { label: favorites.has(node.id) ? '즐겨찾기 해제' : '즐겨찾기에 추가', icon: 'star', onClick: () => { const on = favorites.toggle(node.id); toast(on ? '⭐ 즐겨찾기에 추가했습니다.' : '즐겨찾기에서 뺐습니다.'); } },
        { label: archived.has(node.id) ? '보관 해제 (목록에 다시 표시)' : '보관하기 (목록에서 숨김)', icon: 'archive', onClick: () => { const on = archived.toggle(node.id); toast(on ? '🗄 보관했습니다. 사이드바 아래 "보관한 방"에서 볼 수 있어요.' : '보관을 해제했습니다.'); } },
        chat && !ctx.isSplitOpen?.(node.id) ? { label: '분할 화면으로 열기', icon: 'columns', onClick: () => ctx.openSplit(node.id) } : null,
        chat ? { label: '읽음으로 표시', icon: 'check', onClick: () => ctx.markRead(node.id) } : null,
        chat && data.can('editWorkspace') ? { label: '대화를 보드로 변환', icon: 'grid', onClick: () => convertDialog(ctx, { roomId: node.id }) } : null,
        chat && data.can('editWorkspace') ? { label: '대화에서 할 일 뽑기', icon: 'check', onClick: () => convertDialog(ctx, { roomId: node.id, tasks: true }) } : null,
        chat && data.aiEnabled ? { label: 'AI 요약 · 질문', icon: 'sparkle', onClick: () => aiDialog(ctx, node.id) } : null,
        chat ? 'sep' : null,
        chat ? { label: `${notify === 'all' ? '✓ ' : ''}알림: 모든 메시지`, icon: 'bell', onClick: () => roomNotify.set(node.id, 'all') } : null,
        chat ? { label: `${notify === 'mentions' ? '✓ ' : ''}알림: 멘션만`, icon: 'at', onClick: () => roomNotify.set(node.id, 'mentions') } : null,
        chat ? { label: `${notify === 'none' ? '✓ ' : ''}알림 끄기 (음소거)`, icon: 'bellOff', onClick: () => roomNotify.set(node.id, 'none') } : null,
        'sep',
        node.type !== 'dm' ? { label: '방 정보', icon: 'info', onClick: () => roomInfoDialog(ctx, node) } : null,
        chat ? { label: '채팅 내보내기', icon: 'download', onClick: () => exportDialog(ctx, node) } : null,
        node.type !== 'dm' ? { label: '링크 복사', icon: 'link', onClick: () => copyLink(node) } : null,
      );
    }
    if (manage && node.type !== 'dm') {
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
    const dot = !unread && !active && isChat(node) && (node.lastMessageAt || 0) > (ctx.lastRead[node.id] || 0);
    const mention = ctx.mentions.has(node.id);
    const inCall = node.type === 'voice' ? data.calls[node.id] || [] : [];
    const muted = isChat(node) && roomNotify.get(node.id) === 'none';
    const draft = !active && isChat(node) && drafts.has(node.id);

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
      draggable: manage && !isTouch() && node.type !== 'dm' ? 'true' : null,
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
    node.type === 'dm' ? avatar(data.dmPartner(node), 22, { presence: data.presenceOf(data.dmPartner(node).id) })
      : node.emoji && !isFolder ? h('span', { class: 'node-emoji' }, node.emoji) : icon(isFolder ? (open ? 'folderOpen' : 'folder') : { voice: 'voice', code: 'code', board: 'grid' }[node.type] || 'hash', 18, `node-icon${node.color ? ' colored' : ''}`),
    h('span', { class: 'tree-name ellipsis' }, isFolder && node.emoji ? `${node.emoji} ${node.name}` : data.roomLabel(node)),
    draft ? h('span', { class: 'draft-mark', title: '보내지 않은 임시 저장 글이 있습니다' }, icon('pencil', 13)) : null,
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
      const kids = data.children(node.id).filter((k) => !archived.has(k.id));
      const group = h('div', { role: 'group', class: 'tree-group' });
      if (!kids.length) group.append(h('div', { class: 'tree-empty', style: { paddingLeft: `${30 + depth * 14}px` } }, '비어 있음'));
      for (const k of kids) group.append(...row(k, depth + 1));
      out.push(group);
    }
    return out;
  }

  const pathOf = (n) => { const p = []; for (let c = data.nodes.get(n.parentId); c; c = data.nodes.get(c.parentId)) p.unshift(c.name); return p.join(' / '); };
  const isChat = (n) => ['text', 'dm', 'code', 'board'].includes(n.type);

  // 접을 수 있는 구역 제목
  const sectionOpen = new Set(JSON.parse(localStorage.getItem('cs.sectionsOpen') || '["favorites","dms","rooms"]'));
  const sectionHead = (key, label, { count, extra } = {}) => h('div', {
    class: `tree-section clickable${sectionOpen.has(key) ? '' : ' closed'}`, role: 'button', tabindex: '0', 'aria-expanded': String(sectionOpen.has(key)),
    onclick: () => { if (sectionOpen.has(key)) sectionOpen.delete(key); else sectionOpen.add(key); try { localStorage.setItem('cs.sectionsOpen', JSON.stringify([...sectionOpen])); } catch { /* noop */ } render(); },
    onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.currentTarget.click(); } },
  }, icon(sectionOpen.has(key) ? 'chevronDown' : 'chevron', 12), h('span', { class: 'grow' }, label), count ? h('span', { class: 'unread-badge small' }, String(count)) : null, extra || null);

  const unreadOf = (ids) => ids.reduce((n, id) => n + (roomNotify.get(id) === 'none' ? 0 : ctx.unread.get(id) || 0), 0);

  function renderSection(key) {
    if (key === 'favorites') {
      const favs = favorites.list().map((id) => data.nodes.get(id)).filter((n) => n && !archived.has(n.id));
      if (!favs.length) return [];
      return [sectionHead('favorites', '즐겨찾기'), ...(sectionOpen.has('favorites') ? favs.flatMap((n) => row(n, 0).slice(0, 1)) : [])];
    }
    if (key === 'dms') {
      if (!data.can('directMessage')) return [];
      const dms = data.dmList().filter((n) => !archived.has(n.id));
      const addDm = h('button', { class: 'icon-btn tiny', title: '새 1:1 대화', 'aria-label': '새 1:1 대화', onclick: (e) => { e.stopPropagation(); newDmDialog(); } }, icon('plus', 14));
      return [sectionHead('dms', '개인 메시지', { count: sectionOpen.has('dms') ? 0 : unreadOf(dms.map((n) => n.id)), extra: addDm }),
        ...(sectionOpen.has('dms') ? (dms.length ? dms.slice(0, 30).flatMap((n) => row(n, 0)) : [h('div', { class: 'tree-empty' }, '최근 대화가 없습니다. 멤버 프로필에서 "메시지 보내기"')]) : [])];
    }
    if (key === 'rooms') {
      const roots = data.children(null).filter((n) => !archived.has(n.id));
      const head = sectionHead('rooms', '채팅방');
      if (!sectionOpen.has('rooms')) return [head];
      if (!roots.length) {
        return [head, h('div', { class: 'tree-placeholder' },
          h('p', {}, '아직 채팅방이 없습니다.'),
          data.can('manageNodes')
            ? h('button', { class: 'btn primary small', onclick: () => createNodeDialog(ctx) }, icon('plus', 16), ' 채팅방 만들기')
            : h('p', { class: 'muted small' }, '로그인한 사용자가 채팅방을 만들면 여기에 표시됩니다.'))];
      }
      return [head, ...roots.flatMap((n) => row(n, 0))];
    }
    if (key === 'archive') {
      const list = archived.list().map((id) => data.nodes.get(id)).filter(Boolean);
      if (!list.length) return [];
      return [sectionHead('archive', `보관한 방 (${list.length})`, { count: unreadOf(list.map((n) => n.id)) }),
        ...(sectionOpen.has('archive') ? list.flatMap((n) => { const r = row(n, 0).slice(0, 1); if (n.type !== 'dm' && pathOf(n)) r[0].append(h('span', { class: 'tree-path ellipsis' }, pathOf(n))); return r; }) : [])];
    }
    return [];
  }

  function render() {
    addBtn.hidden = !data.can('manageNodes');
    if (filterText) {
      const found = [...data.nodes.values()].filter((n) => n.type !== 'folder' && `${data.roomLabel(n)} ${n.topic || ''}`.toLowerCase().includes(filterText));
      tree.replaceChildren(...(found.length
        ? found.flatMap((n) => { const rows = row(n, 0); rows[0].append(h('span', { class: 'tree-path ellipsis' }, n.type === 'dm' ? '1:1' : pathOf(n))); return rows; })
        : [h('p', { class: 'muted small pad' }, '일치하는 방이 없습니다.')]));
      renderVoiceBar();
      return;
    }
    const hidden = new Set(settings.sidebarHidden || []);
    const order = [...new Set([...(settings.sidebarSections || []), ...Object.keys(SIDEBAR_SECTIONS)])].filter((k) => SIDEBAR_SECTIONS[k] && !hidden.has(k));
    tree.replaceChildren(...order.flatMap(renderSection));
    renderVoiceBar();
  }

  // 새 1:1 대화: 상대 고르기
  function newDmDialog() {
    const q = h('input', { class: 'input', type: 'search', placeholder: '이름으로 찾기', autofocus: true, 'aria-label': '대화 상대 찾기' });
    const results = h('div', { class: 'qs-results' });
    let modal = null;
    const renderList = () => {
      const s = q.value.trim().toLowerCase();
      const users = data.activeUsers().filter((u) => u.id !== data.me.id && (u.nickname || '').toLowerCase().includes(s))
        .sort((a, b) => (data.presenceOf(a.id) === 'offline') - (data.presenceOf(b.id) === 'offline') || (a.nickname || '').localeCompare(b.nickname || '', 'ko')).slice(0, 30);
      results.replaceChildren(...users.map((u) => h('button', {
        class: 'qs-item', type: 'button',
        onclick: async () => { modal.close(); try { const n = await data.openDm(u.id); ctx.openRoom(n.id); } catch (e) { toast(errorText(e), 'error'); } },
      }, avatar(u, 24, { presence: data.presenceOf(u.id) }), h('span', {}, u.nickname), badge(u.provider), u.status ? h('span', { class: 'muted small ellipsis' }, u.status) : null)));
      if (!users.length) results.append(h('p', { class: 'muted small pad' }, '사용자를 찾을 수 없습니다.'));
    };
    q.addEventListener('input', renderList);
    modal = openModal({ title: '새 1:1 대화', cls: 'qs-modal', body: [q, results] });
    renderList();
  }
  ctx.newDm = newDmDialog;

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
      h('button', { class: `conn conn-${st.mode}`, title: `${statusText} · 눌러서 서버 상태 보기`, 'aria-label': `${statusText}, 서버 상태 보기`, onclick: () => ctx.serverStatus() }, icon(statusIcon, 18), st.pendingOps && st.mode !== 'local' ? h('span', { class: 'conn-count' }, String(st.pendingOps)) : null),
      h('button', { class: 'icon-btn', title: '빠른 설정 (Ctrl+.)', 'aria-label': '빠른 설정', onclick: (e) => quickSettings(ctx, e.currentTarget) }, icon('sliders')),
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
  personal.on('cs.archived', render);
  personal.on('cs.drafts', render);
  data.on('presence', () => { if (data.dmList().length) render(); });
  settingsChanged.add((patch) => { if ('sidebarSections' in patch || 'sidebarHidden' in patch) render(); });
  ctx.on('room', render);

  render();
  renderUser();
  return { el, render };
}

/** 끌어서 패널 너비 조절. dir: 1 = 오른쪽으로 끌면 넓어짐(사이드바), -1 = 왼쪽으로 끌면 넓어짐(오른쪽 패널) */
export function attachResizer(handle, cssVar, key, min, max, dir) {
  handle.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const startX = e.clientX;
    const start = Number(settings[key]) || parseInt(getComputedStyle(document.documentElement).getPropertyValue(cssVar), 10) || min;
    let w = start;
    handle.setPointerCapture(e.pointerId);
    document.body.classList.add('resizing');
    const move = (ev) => {
      w = Math.round(Math.min(max, Math.max(min, start + (ev.clientX - startX) * dir)));
      document.documentElement.style.setProperty(cssVar, `${w}px`);
    };
    const up = () => {
      handle.removeEventListener('pointermove', move);
      document.body.classList.remove('resizing');
      saveSettings({ [key]: w });
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up, { once: true });
    handle.addEventListener('pointercancel', up, { once: true });
  });
  handle.addEventListener('dblclick', () => saveSettings({ [key]: key === 'sidebarWidth' ? 264 : 360 }));
}
