// 작업 공간 화면: 코드 작업실(IDE) 또는 보드. 방의 채팅은 그대로 있고, 제목 막대에서 채팅 ↔ 작업 공간을 오갑니다.
import { h, toast, uid } from '../util.js';
import { icon } from './icons.js';
import { openModal, field } from './common.js';
import { errorText } from './errors.js';
import { createIde } from './ide.js';
import { createBoard } from './board.js';

export function createWorkspaceView(ctx) {
  const { data } = ctx;
  const title = h('div', { class: 'room-title' });
  const body = h('div', { class: 'ws-body' });
  const chatBtn = h('button', { class: 'btn small secondary ws-chat-btn', title: '이 방의 채팅 보기', onclick: () => ctx.showRoomChat(st.roomId) }, icon('message', 16), h('span', {}, ' 채팅'), h('span', { class: 'unread-badge', hidden: true }));
  const el = h('section', { class: 'ws-view', 'aria-label': '작업 공간' },
    h('header', { class: 'room-head' },
      h('button', { class: 'icon-btn mobile-only', 'aria-label': '메뉴 열기', onclick: () => ctx.openDrawer() }, icon('menu')),
      title,
      h('div', { class: 'room-actions' },
        chatBtn,
        h('button', { class: 'icon-btn desktop-only', title: '채팅을 옆에 나란히 열기', 'aria-label': '채팅 나란히 열기', onclick: () => ctx.openSplit(st.roomId) }, icon('columns')),
        h('button', { class: 'icon-btn', title: '멤버', 'aria-label': '멤버 목록', onclick: () => ctx.togglePanel('members') }, icon('users')),
        h('button', { class: 'icon-btn', title: '더보기', 'aria-label': '방 메뉴', onclick: (e) => ctx.roomMenu(st.roomId, e.currentTarget) }, icon('more')))),
    body);
  const st = { roomId: null, items: new Map(), view: null, token: 0 };

  function renderTitle() {
    const room = data.nodes.get(st.roomId);
    if (!room) return;
    title.replaceChildren(room.emoji ? h('span', { class: 'room-emoji' }, room.emoji) : icon(room.type === 'code' ? 'code' : 'grid', 22, 'dim'),
      h('div', { class: 'room-title-text' }, h('h2', { class: 'ellipsis' }, room.name),
        h('span', { class: 'room-topic ellipsis' }, [room.type === 'code' ? '코드 작업실' : '보드', room.topic, data.can('editWorkspace') ? null : '보기 전용 (로그인하면 편집 가능)'].filter(Boolean).join(' · '))));
    const n = ctx.unread.get(st.roomId) || 0;
    const badge = chatBtn.querySelector('.unread-badge');
    badge.hidden = !n;
    badge.textContent = n > 99 ? '99+' : String(n);
  }

  data.on('ws', (roomId, change) => {
    if (roomId !== st.roomId || !st.view) return;
    for (const it of change.items || []) st.items.set(it.id, { ...st.items.get(it.id), ...it });
    for (const id of change.removed || []) st.items.delete(id);
    st.view.changed(change);
  });
  data.on('nodes', () => { if (st.roomId) renderTitle(); });
  data.on('resync', () => { if (st.roomId) load(true); });
  ctx.on('unread', () => { if (st.roomId) renderTitle(); });

  async function load(refresh = false) {
    const token = ++st.token;
    const roomId = st.roomId;
    try {
      const list = await data.listWs(roomId);
      if (token !== st.token) return;
      st.items.clear();
      for (const it of list) st.items.set(it.id, it);
      if (refresh) st.view?.changed({});
      else st.view.open();
    } catch (e) {
      body.replaceChildren(h('p', { class: 'muted pad' }, errorText(e)));
    }
  }

  return {
    el,
    get roomId() { return st.roomId; },
    async open(roomId, { reload } = {}) {
      if (st.roomId === roomId && st.view && !reload) { renderTitle(); return; }
      st.view?.close();
      st.roomId = roomId;
      const room = data.nodes.get(roomId);
      const host = { ctx, roomId, items: st.items, canEdit: data.can('editWorkspace') };
      st.view = room.type === 'code' ? createIde(host) : createBoard(host);
      renderTitle();
      body.replaceChildren(h('div', { class: 'skeleton-list pad' }, h('span', { class: 'sk sk-line' }), h('span', { class: 'sk sk-line short' })));
      st.items.clear();
      await load();
      body.replaceChildren(st.view.el);
    },
    close() { st.view?.close(); st.view = null; st.roomId = null; st.token += 1; },
  };
}

/** 채팅의 코드 블록을 코드 작업실의 파일로 저장 */
export function saveCodeDialog(ctx, { code, lang }) {
  const { data } = ctx;
  if (!data.can('editWorkspace')) return toast(errorText({ code: 'forbidden' }), 'warn');
  const rooms = [...data.nodes.values()].filter((n) => n.type === 'code');
  if (!rooms.length) return toast('코드 작업실이 없습니다. 사이드바의 + 버튼으로 먼저 만들어 주세요.', 'warn');
  const extOf = { javascript: 'js', js: 'js', python: 'py', py: 'py', html: 'html', css: 'css', json: 'json', typescript: 'ts', ts: 'ts' }[(lang || '').toLowerCase()] || 'txt';
  const roomSel = h('select', { class: 'input' }, rooms.map((r) => h('option', { value: r.id, selected: r.id === ctx.roomId }, r.name)));
  const projSel = h('select', { class: 'input' });
  const name = h('input', { class: 'input', maxlength: '100', value: `snippet.${extOf}`, required: true });
  let items = [];
  const loadProjects = async () => {
    items = await data.listWs(roomSel.value).catch(() => []);
    projSel.replaceChildren(h('option', { value: '' }, '＋ 새 프로젝트'), ...items.filter((i) => i.kind === 'project').map((p) => h('option', { value: p.id, selected: true }, p.name)));
  };
  roomSel.addEventListener('change', loadProjects);
  loadProjects();
  openModal({
    title: '코드 작업실에 파일로 저장',
    body: [field('코드 작업실', roomSel), field('프로젝트', projSel), field('파일 이름', name), h('pre', { class: 'mono small pre history-code' }, code.slice(0, 600) + (code.length > 600 ? '\n…' : ''))],
    actions: [{ label: '취소' }, {
      label: '저장', kind: 'primary', submit: true,
      onClick: async () => {
        try {
          const add = [];
          let pid = projSel.value;
          if (!pid) { pid = uid(); add.push({ id: pid, kind: 'project', name: '채팅에서 가져온 코드' }); }
          const taken = new Set(items.filter((i) => i.parentId === pid).map((i) => i.name));
          let fname = name.value.trim().replace(/\//g, '_') || `snippet.${extOf}`;
          for (let i = 2; taken.has(fname); i++) fname = name.value.trim().replace(/(\.[^.]*)?$/, `-${i}$1`);
          const fid = uid();
          add.push({ id: fid, kind: 'file', name: fname, parentId: pid, content: code });
          await data.putWsMany(roomSel.value, add);
          try { localStorage.setItem(`cs.ide.${roomSel.value}`, JSON.stringify({ project: pid, tabs: [fid], active: fid })); } catch { /* noop */ }
          toast(`'${fname}' 파일로 저장했습니다.`, 'success', 4000, { label: '열기', onClick: () => ctx.openRoom(roomSel.value, { workspace: true, reload: true }) });
        } catch (e) { toast(errorText(e), 'error'); return false; }
      },
    }],
  });
}
