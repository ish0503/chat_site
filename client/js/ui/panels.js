import { h, toast, fmtStamp, escapeHtml, debounce } from '../util.js';
import { renderMarkdown } from '../markdown.js';
import { icon } from './icons.js';
import { avatar, badge } from './common.js';
import { profileDialog } from './dialogs.js';
import { errorText } from './errors.js';

/** 오른쪽 패널: 고정된 메시지 / 검색 / 멤버 */
export function createPanels(ctx) {
  const { data } = ctx;
  const titleEl = h('h3', {});
  const bodyEl = h('div', { class: 'panel-body' });
  const el = h('aside', { class: 'panel', hidden: true, 'aria-label': '사이드 패널' },
    h('header', { class: 'panel-head' }, titleEl, h('button', { class: 'icon-btn', 'aria-label': '패널 닫기', onclick: () => ctx.togglePanel(null) }, icon('x'))),
    bodyEl);
  let kind = null;
  let searchInput = null;
  let searchQ = '';

  const authorOf = (m) => data.user(m.authorId) || { id: m.authorId, nickname: m.author?.nickname || '알 수 없음', provider: m.author?.provider || 'guest' };

  function card(m, { highlight, actions } = {}) {
    const u = authorOf(m);
    let html = renderMarkdown(m.content || '', { me: data.me });
    if (highlight) {
      const re = new RegExp(`(${escapeHtml(highlight).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})(?![^<]*>)`, 'gi');
      html = html.replace(re, '<mark>$1</mark>');
    }
    return h('div', { class: 'mini-msg' },
      h('div', { class: 'mini-head' }, avatar(u, 24), h('strong', { class: 'ellipsis' }, u.nickname), badge(u.provider), h('span', { class: 'muted small' }, fmtStamp(m.createdAt))),
      m.content ? h('div', { class: 'mini-text', html }) : null,
      m.attachments?.length ? h('div', { class: 'muted small' }, `📎 ${m.attachments.map((a) => a.name).join(', ')}`) : null,
      h('div', { class: 'mini-actions' },
        h('button', { class: 'btn small secondary', onclick: () => { ctx.jumpTo(m.roomId, m.id); if (matchMedia('(max-width: 1100px)').matches) ctx.togglePanel(null); } }, '이동'),
        actions || null));
  }

  async function renderPins() {
    titleEl.replaceChildren(icon('pin', 18), ' 고정된 메시지');
    const roomId = ctx.roomId;
    if (!roomId) return bodyEl.replaceChildren(h('p', { class: 'muted pad' }, '채팅방을 선택하세요.'));
    try {
      const pins = await data.listPins(roomId);
      if (kind !== 'pins' || roomId !== ctx.roomId) return;
      if (!pins.length) {
        return bodyEl.replaceChildren(h('div', { class: 'empty small' }, icon('pin', 32), h('p', {}, '아직 고정된 메시지가 없습니다.'),
          h('p', { class: 'muted small' }, data.can('pin') ? '메시지의 ⋯ 메뉴에서 "메시지 고정"을 선택하세요.' : '로그인한 사용자가 메시지를 고정할 수 있습니다.')));
      }
      bodyEl.replaceChildren(h('p', { class: 'muted small pad' }, `${pins.length}개의 고정된 메시지`), ...pins.map((m) => card(m, {
        actions: data.can('pin') ? h('button', {
          class: 'btn small ghost',
          onclick: async () => { try { await data.setPinned(m.id, false); } catch (e) { toast(errorText(e), 'error'); } },
        }, '고정 해제') : null,
      })));
    } catch (e) {
      bodyEl.replaceChildren(h('p', { class: 'muted pad' }, errorText(e)));
    }
  }

  async function runSearch() {
    const q = searchInput.value.trim();
    searchQ = q;
    const results = bodyEl.querySelector('.search-results');
    if (!q) return results.replaceChildren(h('p', { class: 'muted small pad' }, '메시지 내용이나 파일 이름으로 검색합니다.'));
    results.replaceChildren(h('div', { class: 'spinner' }));
    try {
      const list = await data.search(ctx.roomId, q);
      if (searchQ !== q) return;
      results.replaceChildren(
        h('p', { class: 'muted small pad' }, list.length ? `검색 결과 ${list.length}개${list.length >= 50 ? '+' : ''}` : '검색 결과가 없습니다.'),
        ...list.map((m) => card(m, { highlight: q })),
      );
    } catch (e) {
      results.replaceChildren(h('p', { class: 'muted pad' }, errorText(e)));
    }
  }

  function renderSearch() {
    titleEl.replaceChildren(icon('search', 18), ' 검색');
    let timer;
    searchInput = h('input', {
      class: 'input', type: 'search', placeholder: '이 채팅방에서 검색', 'aria-label': '검색어', value: searchQ,
      oninput: () => { clearTimeout(timer); timer = setTimeout(runSearch, 300); },
      onkeydown: (e) => { if (e.key === 'Enter') { clearTimeout(timer); runSearch(); } },
    });
    bodyEl.replaceChildren(h('div', { class: 'pad' }, searchInput), h('div', { class: 'search-results' }));
    runSearch();
    setTimeout(() => searchInput.focus(), 50);
  }

  function renderMembers() {
    titleEl.replaceChildren(icon('users', 18), ' 멤버');
    const users = [...data.users.values()].sort((a, b) => (a.nickname || '').localeCompare(b.nickname || '', 'ko'));
    const on = users.filter((u) => data.online.has(u.id));
    const off = users.filter((u) => !data.online.has(u.id));
    const row = (u) => h('button', { class: `member${data.online.has(u.id) ? '' : ' offline'}`, onclick: () => profileDialog(ctx, u.id) },
      avatar(u, 32, { online: data.online.has(u.id) }),
      h('span', { class: 'member-name ellipsis' }, u.nickname, u.id === data.me.id ? h('span', { class: 'muted small' }, ' (나)') : null),
      badge(u.provider));
    bodyEl.replaceChildren(
      data.mode !== 'online' ? h('p', { class: 'muted small pad' }, '서버에 연결되어 있지 않아 접속 상태를 알 수 없습니다.') : null,
      h('div', { class: 'member-group' }, `온라인 — ${on.length}`), ...on.map(row),
      h('div', { class: 'member-group' }, `오프라인 — ${off.length}`), ...off.map(row),
    );
  }

  function render() {
    el.hidden = !kind;
    el.dataset.kind = kind || '';
    if (kind === 'pins') renderPins();
    else if (kind === 'search') renderSearch();
    else if (kind === 'members') renderMembers();
  }

  const refreshPins = debounce(() => kind === 'pins' && renderPins(), 300);
  data.on('message', (m) => { if (m.roomId === ctx.roomId) refreshPins(); });
  data.on('messageRemoved', () => refreshPins());
  const refreshMembers = debounce(() => kind === 'members' && renderMembers(), 300);
  data.on('presence', refreshMembers);
  data.on('users', refreshMembers);
  ctx.on('room', () => { if (kind === 'search') { searchQ = ''; } if (kind) render(); });

  return {
    el,
    get kind() { return kind; },
    show(k) { kind = k; render(); },
  };
}
