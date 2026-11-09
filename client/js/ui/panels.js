import { h, toast, fmtStamp, fmtBytes, escapeHtml, debounce } from '../util.js';
import { renderMarkdown } from '../markdown.js';
import * as files from '../files.js';
import { bookmarks, personal, blocked } from '../local.js';
import { icon } from './icons.js';
import { avatar, badge, PRESENCE_LABEL } from './common.js';
import { profileDialog, listSetting, lightbox } from './dialogs.js';
import { errorText } from './errors.js';

const HAS_ALIAS = {
  image: 'image', 이미지: 'image', 사진: 'image', video: 'video', 동영상: 'video', 영상: 'video', audio: 'audio', 오디오: 'audio', 음성: 'audio',
  file: 'file', 파일: 'file', media: 'media', 미디어: 'media', link: 'link', 링크: 'link', pin: 'pin', 고정: 'pin', poll: 'poll', 투표: 'poll',
};

/** 'from:철수 has:image before:2026-11-01 회의' → 검색 필터 */
export function parseSearch(text, data) {
  const f = { q: [], all: false };
  for (const tok of text.trim().split(/\s+/).filter(Boolean)) {
    const m = tok.match(/^(from|has|before|after|during|in|보낸사람|종류|이전|이후|날짜):(.+)$/i);
    if (!m) { f.q.push(tok); continue; }
    const key = { 보낸사람: 'from', 종류: 'has', 이전: 'before', 이후: 'after', 날짜: 'during' }[m[1]] || m[1].toLowerCase();
    const val = m[2];
    if (key === 'from') {
      const name = val.replace(/^@/, '').toLowerCase();
      const u = [...data.users.values()].find((x) => x.nickname?.toLowerCase() === name) || [...data.users.values()].find((x) => x.nickname?.toLowerCase().includes(name));
      f.from = u?.id || '__none__';
      f.fromName = u?.nickname || val;
    } else if (key === 'has') f.has = HAS_ALIAS[val.toLowerCase()] || val;
    else if (key === 'in') f.all = /^(all|전체|모두)$/i.test(val);
    else {
      const d = new Date(`${val}T00:00:00`);
      if (Number.isNaN(d.getTime())) continue;
      if (key === 'before') f.before = d.getTime();
      if (key === 'after') f.after = d.getTime();
      if (key === 'during') { f.after = d.getTime(); f.before = d.getTime() + 86400_000; }
    }
  }
  f.q = f.q.join(' ');
  return f;
}

/** 오른쪽 패널: 고정 / 검색 / 멤버 / 받은 멘션 / 미디어 / 저장한 메시지 */
export function createPanels(ctx) {
  const { data } = ctx;
  const titleEl = h('h3', {});
  const bodyEl = h('div', { class: 'panel-body' });
  const el = h('aside', { class: 'panel', hidden: true, 'aria-label': '사이드 패널' },
    h('header', { class: 'panel-head' }, titleEl, h('button', { class: 'icon-btn', 'aria-label': '패널 닫기', onclick: () => ctx.togglePanel(null) }, icon('x'))),
    bodyEl);
  let kind = null;
  let searchText = '';
  let searchAll = false;
  let mediaTab = 'media';

  const authorOf = (m) => data.user(m.authorId) || { id: m.authorId, nickname: m.author?.nickname || '알 수 없음', provider: m.author?.provider || 'guest' };
  const roomName = (id) => data.nodes.get(id)?.name;

  function card(m, { highlight, actions, showRoom } = {}) {
    const u = authorOf(m);
    let html = renderMarkdown(m.content || '', { me: data.me, filterWords: listSetting('filterWords') });
    if (highlight) {
      const re = new RegExp(`(${escapeHtml(highlight).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})(?![^<]*>)`, 'gi');
      html = html.replace(re, '<mark>$1</mark>');
    }
    const atts = Array.isArray(m.attachments) ? m.attachments.map((a) => (typeof a === 'string' ? a : a.name)) : [];
    return h('div', { class: 'mini-msg' },
      h('div', { class: 'mini-head' }, avatar(u, 24), h('strong', { class: 'ellipsis' }, u.nickname), badge(u.provider), h('span', { class: 'muted small' }, fmtStamp(m.createdAt))),
      showRoom && roomName(m.roomId) ? h('div', { class: 'muted small' }, `# ${roomName(m.roomId)}`) : null,
      m.kind === 'poll' ? h('div', { class: 'mini-text' }, `📊 ${m.content}`) : m.content ? h('div', { class: 'mini-text', html }) : null,
      atts.length ? h('div', { class: 'muted small' }, `📎 ${atts.join(', ')}`) : null,
      h('div', { class: 'mini-actions' },
        h('button', {
          class: 'btn small secondary',
          onclick: () => {
            if (!data.nodes.has(m.roomId)) return toast('채팅방이 삭제되었습니다.', 'warn');
            ctx.jumpTo(m.roomId, m.id);
            if (matchMedia('(max-width: 1100px)').matches) ctx.togglePanel(null);
          },
        }, '이동'),
        actions || null));
  }

  const loading = () => bodyEl.replaceChildren(h('div', { class: 'spinner' }));
  const emptyBox = (ic, text, sub) => h('div', { class: 'empty small' }, icon(ic, 32), h('p', {}, text), sub ? h('p', { class: 'muted small' }, sub) : null);

  async function renderPins() {
    titleEl.replaceChildren(icon('pin', 18), ' 고정된 메시지');
    const roomId = ctx.roomId;
    if (!roomId) return bodyEl.replaceChildren(h('p', { class: 'muted pad' }, '채팅방을 선택하세요.'));
    try {
      const pins = await data.listPins(roomId);
      if (kind !== 'pins' || roomId !== ctx.roomId) return;
      if (!pins.length) {
        return bodyEl.replaceChildren(emptyBox('pin', '아직 고정된 메시지가 없습니다.', data.can('pin') ? '메시지의 ⋯ 메뉴에서 "메시지 고정"을 선택하세요.' : '로그인한 사용자가 메시지를 고정할 수 있습니다.'));
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

  // ── 검색 ──
  async function runSearch() {
    const results = bodyEl.querySelector('.search-results');
    if (!results) return;
    const f = parseSearch(searchText, data);
    const any = f.q || f.from || f.has || f.before || f.after;
    if (!any) {
      return results.replaceChildren(h('div', { class: 'pad muted small' },
        h('p', {}, '메시지 내용이나 파일 이름으로 검색합니다. 필터를 함께 쓸 수 있어요:'),
        h('div', { class: 'chips' }, ['from:', 'has:image', 'has:file', 'has:link', 'has:pin', 'has:poll', 'before:2026-01-01', 'after:2026-01-01', 'during:2026-01-01'].map((c) => h('button', {
          class: 'chip', type: 'button',
          onclick: () => { const inp = bodyEl.querySelector('input[type=search]'); inp.value = `${inp.value} ${c}`.trim(); searchText = inp.value; inp.focus(); if (!c.endsWith(':')) runSearch(); },
        }, c)))));
    }
    if (f.from === '__none__') return results.replaceChildren(h('p', { class: 'muted small pad' }, `'${f.fromName}' 사용자를 찾을 수 없습니다.`));
    results.replaceChildren(h('div', { class: 'spinner' }));
    const all = searchAll || f.all;
    const myText = searchText;
    try {
      const list = await data.search({ roomId: all ? null : ctx.roomId, q: f.q, from: f.from, has: f.has, before: f.before, after: f.after });
      if (searchText !== myText) return;
      results.replaceChildren(
        h('p', { class: 'muted small pad' }, list.length ? `검색 결과 ${list.length}개${list.length >= 50 ? '+' : ''}${all ? ' · 모든 채팅방' : ''}` : '검색 결과가 없습니다.'),
        ...list.filter((m) => !blocked.has(m.authorId)).map((m) => card(m, { highlight: f.q, showRoom: all })),
      );
    } catch (e) {
      results.replaceChildren(h('p', { class: 'muted pad' }, errorText(e)));
    }
  }

  function renderSearch() {
    titleEl.replaceChildren(icon('search', 18), ' 검색');
    const runSoon = debounce(runSearch, 300);
    const input = h('input', {
      class: 'input', type: 'search', placeholder: '검색 (예: 회의 from:철수 has:file)', 'aria-label': '검색어', value: searchText,
      oninput: (e) => { searchText = e.target.value; runSoon(); },
      onkeydown: (e) => { if (e.key === 'Enter') runSearch(); },
    });
    const allToggle = h('label', { class: 'switch-row small' }, h('span', {}, '모든 채팅방에서 검색'),
      h('input', { type: 'checkbox', class: 'switch', checked: searchAll, onchange: (e) => { searchAll = e.target.checked; runSearch(); } }));
    bodyEl.replaceChildren(h('div', { class: 'pad' }, input, allToggle), h('div', { class: 'search-results' }));
    runSearch();
    setTimeout(() => input.focus(), 50);
  }

  // ── 받은 멘션 ──
  async function renderMentions() {
    titleEl.replaceChildren(icon('at', 18), ' 받은 멘션');
    loading();
    try {
      const list = (await data.search({ mentions: true })).filter((m) => m.authorId !== data.me.id && !blocked.has(m.authorId));
      if (kind !== 'mentions') return;
      bodyEl.replaceChildren(...(list.length
        ? [h('p', { class: 'muted small pad' }, `나(@${data.me.nickname}) 또는 @everyone 이 들어간 최근 메시지`), ...list.map((m) => card(m, { showRoom: true }))]
        : [emptyBox('at', '아직 받은 멘션이 없습니다.', '누군가 @닉네임 으로 부르면 여기에 모입니다.')]));
    } catch (e) {
      bodyEl.replaceChildren(h('p', { class: 'muted pad' }, errorText(e)));
    }
  }

  // ── 미디어 · 파일 · 링크 ──
  async function renderMedia() {
    titleEl.replaceChildren(icon('grid', 18), ' 미디어 · 파일 · 링크');
    const roomId = ctx.roomId;
    const tabs = h('div', { class: 'tabs' }, [['media', '사진·영상'], ['file', '파일'], ['link', '링크'], ['audio', '음성']].map(([k, l]) => h('button', {
      class: `tab${mediaTab === k ? ' active' : ''}`, type: 'button', onclick: () => { mediaTab = k; renderMedia(); },
    }, l)));
    const box = h('div', { class: 'pad' }, h('div', { class: 'spinner' }));
    bodyEl.replaceChildren(h('div', { class: 'pad' }, tabs), box);
    if (!roomId) return box.replaceChildren(h('p', { class: 'muted' }, '채팅방을 선택하세요.'));
    try {
      const list = await data.search({ roomId, has: mediaTab });
      if (kind !== 'media' || roomId !== ctx.roomId) return;
      if (!list.length) return box.replaceChildren(h('p', { class: 'muted small' }, '아직 없습니다.'));
      if (mediaTab === 'media') {
        const grid = h('div', { class: 'media-grid' });
        const items = [];
        for (const m of list) {
          for (const a of (m.attachments || []).filter((x) => x.kind === 'image' || x.kind === 'video')) {
            const cell = h('button', { class: 'media-cell', title: `${a.name} · ${authorOf(m).nickname}`, onclick: () => ctx.jumpTo(m.roomId, m.id) }, icon(a.kind === 'video' ? 'play' : 'image', 20));
            grid.append(cell);
            files.localUrl(a).then(async (url) => {
              let u = url;
              if (!u && !files.isExpired(a) && data.isOnline && a.kind === 'image') u = await files.fetchToDevice(a, data).catch(() => null);
              if (!u) { cell.classList.add('gone'); cell.title += files.isExpired(a) ? ' (만료)' : ''; return; }
              const item = { url: u, name: a.name, kind: a.kind, canDownload: !files.isExpired(a), onDownload: () => files.saveToDevice(a, data).catch((e) => toast(errorText(e), 'error')) };
              items.push(item);
              cell.replaceChildren(a.kind === 'image' ? h('img', { src: u, alt: a.name, loading: 'lazy' }) : h('video', { src: u, muted: true, preload: 'metadata' }));
              cell.onclick = () => lightbox(item, items);
            });
          }
        }
        box.replaceChildren(grid);
      } else if (mediaTab === 'link') {
        box.replaceChildren(...list.flatMap((m) => [...(m.content || '').matchAll(/\bhttps?:\/\/[^\s<]+/g)].map((x) => {
          const url = x[0].replace(/[).,!?;:'"]+$/, '');
          return h('div', { class: 'link-row' }, icon('link', 16, 'dim'),
            h('a', { href: url, target: '_blank', rel: 'noopener noreferrer nofollow', class: 'ellipsis' }, url),
            h('button', { class: 'icon-btn tiny', title: '메시지로 이동', onclick: () => ctx.jumpTo(m.roomId, m.id) }, icon('arrowDown', 14)));
        })));
      } else {
        box.replaceChildren(...list.flatMap((m) => (m.attachments || []).filter((a) => (mediaTab === 'audio' ? a.kind === 'audio' : a.kind === 'file')).map((a) => h('div', { class: 'link-row' },
          icon(mediaTab === 'audio' ? 'mic' : 'file', 16, 'dim'),
          h('span', { class: 'ellipsis grow', title: a.name }, a.name),
          h('span', { class: 'muted small' }, `${fmtBytes(a.size)}${files.isExpired(a) ? ' · 만료' : ''}`),
          !files.isExpired(a) ? h('button', { class: 'icon-btn tiny', title: '다운로드', onclick: () => files.saveToDevice(a, data).catch((e) => toast(errorText(e), 'error')) }, icon('download', 14)) : null,
          h('button', { class: 'icon-btn tiny', title: '메시지로 이동', onclick: () => ctx.jumpTo(m.roomId, m.id) }, icon('arrowDown', 14))))));
      }
    } catch (e) {
      box.replaceChildren(h('p', { class: 'muted' }, errorText(e)));
    }
  }

  // ── 저장한 메시지 (북마크) ──
  function renderBookmarks() {
    titleEl.replaceChildren(icon('bookmark', 18), ' 저장한 메시지');
    const list = bookmarks.list();
    bodyEl.replaceChildren(...(list.length
      ? [h('p', { class: 'muted small pad' }, `${list.length}개 · 이 기기에만 저장됩니다`), ...list.map((b) => card(b, {
        showRoom: true,
        actions: h('button', { class: 'btn small ghost', onclick: () => bookmarks.remove(b.id) }, '삭제'),
      }))]
      : [emptyBox('bookmark', '저장한 메시지가 없습니다.', '메시지의 ⋯ 메뉴에서 "메시지 저장"을 누르면 여기에 모입니다.')]));
  }

  // ── 멤버 ──
  function renderMembers() {
    titleEl.replaceChildren(icon('users', 18), ' 멤버');
    const users = [...data.users.values()].sort((a, b) => (a.nickname || '').localeCompare(b.nickname || '', 'ko'));
    const pres = (u) => data.presenceOf(u.id);
    const on = users.filter((u) => pres(u) !== 'offline');
    const off = users.filter((u) => pres(u) === 'offline');
    const row = (u) => h('button', { class: `member${pres(u) === 'offline' ? ' offline' : ''}`, onclick: () => profileDialog(ctx, u.id) },
      avatar(u, 32, { presence: pres(u) }),
      h('span', { class: 'member-meta' },
        h('span', { class: 'member-name ellipsis' }, u.nickname, u.id === data.me.id ? h('span', { class: 'muted small' }, ' (나)') : null, blocked.has(u.id) ? ' 🚫' : ''),
        u.status ? h('span', { class: 'member-status ellipsis' }, u.status) : pres(u) === 'idle' || pres(u) === 'dnd' ? h('span', { class: 'member-status' }, PRESENCE_LABEL[pres(u)]) : null),
      badge(u.provider));
    bodyEl.replaceChildren(...[
      data.mode !== 'online' ? h('p', { class: 'muted small pad' }, '서버에 연결되어 있지 않아 접속 상태를 알 수 없습니다.') : null,
      h('div', { class: 'member-group' }, `온라인 — ${on.length}`), ...on.map(row),
      h('div', { class: 'member-group' }, `오프라인 — ${off.length}`), ...off.map(row),
    ].filter(Boolean));
  }

  const RENDER = {
    pins: renderPins, search: renderSearch, members: renderMembers, mentions: renderMentions, media: renderMedia, bookmarks: renderBookmarks,
  };

  function render() {
    el.hidden = !kind;
    el.dataset.kind = kind || '';
    RENDER[kind]?.();
  }

  const refreshPins = debounce(() => kind === 'pins' && renderPins(), 300);
  data.on('message', (m) => { if (m.roomId === ctx.roomId) refreshPins(); });
  data.on('messageRemoved', () => refreshPins());
  const refreshMembers = debounce(() => kind === 'members' && renderMembers(), 300);
  data.on('presence', refreshMembers);
  data.on('users', refreshMembers);
  personal.on('cs.bookmarks', () => kind === 'bookmarks' && renderBookmarks());
  personal.on('cs.blocked', () => kind === 'members' && renderMembers());
  ctx.on('room', () => { if (kind === 'search' && !searchAll) searchText = ''; if (kind && kind !== 'bookmarks' && kind !== 'mentions') render(); });

  return {
    el,
    get kind() { return kind; },
    show(k) { kind = k; render(); },
    search(text, all = false) { searchText = text; searchAll = all; kind = 'search'; render(); },
  };
}
