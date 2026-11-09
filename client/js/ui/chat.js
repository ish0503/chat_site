import {
  h, toast, fmtTime, fmtDate, fmtStamp, fmtFull, fmtBytes, fmtRemain, sameDay, throttle, debounce, isTouch, isMobile,
} from '../util.js';
import { renderMarkdown, isEmojiOnly, mentionsMe } from '../markdown.js';
import * as files from '../files.js';
import { icon } from './icons.js';
import {
  avatar, badge, openMenu, openEmojiPicker, confirmDialog, QUICK_REACTIONS, emptyState,
} from './common.js';
import { profileDialog, lightbox, settings, editNodeDialog } from './dialogs.js';
import { errorText } from './errors.js';

const GROUP_MS = 7 * 60_000;
const AUTO_FETCH_BYTES = 20 * 1024 * 1024;
const drafts = new Map();

export function createChatView(ctx) {
  const { data } = ctx;
  const st = {
    roomId: null, messages: [], hasMore: false, loading: false, replyTo: null, editing: null, files: [], atBottom: true, newCount: 0, token: 0,
  };
  const els = new Map();

  // ───────── 헤더 ─────────
  const title = h('div', { class: 'room-title' });
  const pinBtn = h('button', { class: 'icon-btn', title: '고정된 메시지', 'aria-label': '고정된 메시지', onclick: () => ctx.togglePanel('pins') }, icon('pin'));
  const header = h('header', { class: 'room-head' },
    h('button', { class: 'icon-btn mobile-only', 'aria-label': '메뉴 열기', onclick: () => ctx.openDrawer() }, icon('menu')),
    title,
    h('div', { class: 'room-actions' },
      pinBtn,
      h('button', { class: 'icon-btn', title: '검색', 'aria-label': '메시지 검색', onclick: () => ctx.togglePanel('search') }, icon('search')),
      h('button', { class: 'icon-btn', title: '멤버', 'aria-label': '멤버 목록', onclick: () => ctx.togglePanel('members') }, icon('users'))));

  // ───────── 메시지 목록 ─────────
  const list = h('div', { class: 'msg-list', role: 'log', 'aria-live': 'polite' });
  const topLoader = h('div', { class: 'list-top' });
  const scroller = h('div', { class: 'msg-scroller', tabindex: '-1' }, topLoader, list, h('div', { class: 'list-bottom-pad' }));
  const jumpBtn = h('button', { class: 'jump-latest', hidden: true, onclick: () => scrollToBottom(true) }, icon('arrowDown', 16), h('span', {}, '최신 메시지로'));
  const typingEl = h('div', { class: 'typing', 'aria-live': 'polite' });

  // ───────── 입력창 ─────────
  const ta = h('textarea', { class: 'composer-input', rows: '1', placeholder: '메시지 보내기', 'aria-label': '메시지 입력', maxlength: '4000', enterkeyhint: 'send' });
  const fileInput = h('input', { type: 'file', multiple: true, hidden: true, onchange: () => { addFiles([...fileInput.files]); fileInput.value = ''; } });
  const tray = h('div', { class: 'attach-tray', hidden: true });
  const bar = h('div', { class: 'composer-bar', hidden: true });
  const counter = h('span', { class: 'char-count', hidden: true });
  const mentionBox = h('div', { class: 'mention-box', hidden: true, role: 'listbox' });
  const sendBtn = h('button', { class: 'icon-btn send-btn', title: '보내기', 'aria-label': '보내기', onclick: () => send() }, icon('send'));
  const composer = h('div', { class: 'composer' },
    mentionBox, bar, tray,
    h('div', { class: 'composer-box' },
      h('button', { class: 'icon-btn', title: '파일 첨부', 'aria-label': '파일 첨부', onclick: () => fileInput.click() }, icon('clip')),
      ta,
      h('button', { class: 'icon-btn', title: '이모지', 'aria-label': '이모지', onclick: (e) => openEmojiPicker(e.currentTarget, insertText) }, icon('smile')),
      sendBtn),
    counter, fileInput, typingEl);

  const dropOverlay = h('div', { class: 'drop-overlay', hidden: true }, h('div', {}, icon('clip', 40), h('p', {}, '여기에 놓아 파일 첨부')));
  const body = h('div', { class: 'chat-body' }, scroller, jumpBtn);
  const el = h('section', { class: 'chat-view', 'aria-label': '채팅' }, header, body, composer, dropOverlay);

  // ───────── 렌더링 ─────────
  const authorOf = (m) => data.user(m.authorId) || { id: m.authorId, nickname: m.author?.nickname || '알 수 없음', provider: m.author?.provider || 'guest' };

  function isCont(m, prev) {
    return prev && !m.replyTo && prev.authorId === m.authorId && m.createdAt - prev.createdAt < GROUP_MS && sameDay(m.createdAt, prev.createdAt);
  }

  function renderTitle() {
    const room = data.nodes.get(st.roomId);
    if (!room) return;
    const path = [];
    for (let p = data.nodes.get(room.parentId); p; p = data.nodes.get(p.parentId)) path.unshift(p.name);
    title.replaceChildren(
      icon('hash', 22, 'dim'),
      h('div', { class: 'room-title-text' },
        h('h2', { class: 'ellipsis' }, room.name),
        room.topic || path.length
          ? h('span', { class: 'room-topic ellipsis', title: room.topic || '' }, path.length ? `${path.join(' / ')}${room.topic ? ' · ' : ''}` : '', room.topic || '')
          : null),
    );
    title.onclick = data.can('manageNodes') ? () => editNodeDialog(ctx, room) : null;
    title.classList.toggle('clickable', data.can('manageNodes'));
  }

  function renderMessage(m, prev) {
    const u = authorOf(m);
    const cont = isCont(m, prev);
    const mine = m.authorId === data.me.id;
    const mention = !mine && mentionsMe(m.content, data.me);
    const cls = ['msg', cont && 'cont', mine && 'mine', mention && 'mention', m.pending && data.mode !== 'local' && 'pending', m.failed && 'failed', m.pinned && 'pinned'].filter(Boolean).join(' ');

    const openProfile = (e) => { e.stopPropagation(); profileDialog(ctx, m.authorId); };
    const reply = m.replyPreview ? h('button', { class: 'msg-reply', onclick: () => jumpTo(m.replyTo) },
      icon('reply', 14, 'dim'),
      avatar(data.user(m.replyPreview.authorId) || { id: m.replyPreview.authorId, nickname: m.replyPreview.author?.nickname }, 16),
      h('strong', {}, (data.user(m.replyPreview.authorId) || m.replyPreview.author)?.nickname || '알 수 없음'),
      h('span', { class: 'ellipsis muted' }, m.replyPreview.content || (m.replyPreview.attachments ? '📎 첨부파일' : ''))) : null;

    const head = cont ? null : h('div', { class: 'msg-head' },
      h('button', { class: 'msg-name', onclick: openProfile }, u.nickname),
      badge(u.provider),
      h('time', { class: 'msg-time', datetime: new Date(m.createdAt).toISOString(), title: fmtFull(m.createdAt) }, fmtStamp(m.createdAt)),
      m.pinned ? h('span', { class: 'pin-mark', title: '고정됨' }, icon('pin', 13)) : null);

    const gutter = cont
      ? h('div', { class: 'msg-gutter' }, h('time', { class: 'hover-time', title: fmtFull(m.createdAt) }, fmtTime(m.createdAt)))
      : h('button', { class: 'msg-gutter msg-avatar', onclick: openProfile, 'aria-label': `${u.nickname} 프로필` }, avatar(u, 40));

    const text = m.content ? h('div', {
      class: `msg-text${isEmojiOnly(m.content) ? ' jumbo' : ''}`,
      html: renderMarkdown(m.content, { me: data.me }) + (m.editedAt ? `<span class="edited" title="${fmtFull(m.editedAt)}">(수정됨)</span>` : ''),
    }) : null;

    const atts = m.attachments?.length ? h('div', { class: 'msg-atts' }, m.attachments.map((a) => renderAttachment(a, m))) : null;

    const reactions = Object.entries(m.reactions || {}).filter(([, us]) => us.length);
    const reactEl = reactions.length ? h('div', { class: 'reactions' },
      reactions.map(([emo, us]) => h('button', {
        class: `reaction${us.includes(data.me.id) ? ' me' : ''}`,
        title: us.map((id) => data.user(id)?.nickname || '알 수 없음').join(', '),
        disabled: !data.can('react'),
        onclick: () => react(m, emo),
      }, h('span', { class: 'r-emoji' }, emo), h('span', { class: 'r-count' }, String(us.length)))),
      data.can('react') ? h('button', { class: 'reaction add', title: '반응 추가', onclick: (e) => openEmojiPicker(e.currentTarget, (emo) => react(m, emo)) }, icon('smilePlus', 16)) : null) : null;

    const sentOk = !m.failed && !(m.pending && data.isOnline);
    const status = m.failed
      ? h('div', { class: 'msg-status error' }, icon('alert', 14), ' 전송 실패 ',
        h('button', { class: 'link-btn', onclick: () => data.retryMessage(m.id) }, '다시 보내기'), ' · ',
        h('button', { class: 'link-btn', onclick: () => data.deleteMessage(m.id) }, '삭제'))
      : m.pending && data.mode !== 'local'
        ? h('div', { class: 'msg-status' }, icon('clock', 13), data.isOnline ? ' 보내는 중…' : ' 기기에 저장됨 · 연결되면 전송')
        : null;

    const main = h('div', { class: 'msg-main' }, text, atts, reactEl, status);
    const actions = isTouch() ? null : h('div', { class: 'msg-actions', role: 'toolbar' },
      data.can('react') ? QUICK_REACTIONS.slice(0, 3).map((emo) => h('button', { class: 'icon-btn tiny emoji', title: emo, onclick: () => react(m, emo) }, emo)) : null,
      data.can('react') ? h('button', { class: 'icon-btn tiny', title: '반응 추가', onclick: (e) => openEmojiPicker(e.currentTarget, (emo) => react(m, emo)) }, icon('smilePlus', 18)) : null,
      h('button', { class: 'icon-btn tiny', title: '답장', onclick: () => startReply(m) }, icon('reply', 18)),
      mine && sentOk ? h('button', { class: 'icon-btn tiny', title: '수정', onclick: () => startEdit(m) }, icon('edit', 18)) : null,
      h('button', { class: 'icon-btn tiny', title: '더보기', onclick: (e) => messageMenu(m, e.currentTarget) }, icon('more', 18)));

    const node = h('div', {
      class: cls, dataset: { id: m.id }, id: `m-${m.id}`, role: 'article',
      oncontextmenu: (e) => {
        if (e.target.closest('a, video, audio')) return;
        e.preventDefault();
        messageMenu(m, e);
      },
    }, reply, head, gutter, main, actions);
    attachLongPress(node, () => messageMenu(m, null));
    return node;
  }

  function attachLongPress(node, fn) {
    if (!isTouch()) return;
    let t = null;
    let sx = 0;
    let sy = 0;
    node.addEventListener('touchstart', (e) => {
      if (e.target.closest('a, button, video, audio, .spoiler')) return;
      sx = e.touches[0].clientX;
      sy = e.touches[0].clientY;
      t = setTimeout(() => { t = null; navigator.vibrate?.(10); node.classList.add('pressed'); fn(); setTimeout(() => node.classList.remove('pressed'), 300); }, 450);
    }, { passive: true });
    const cancel = () => { if (t) clearTimeout(t); t = null; };
    node.addEventListener('touchmove', (e) => {
      if (Math.abs(e.touches[0].clientX - sx) > 10 || Math.abs(e.touches[0].clientY - sy) > 10) cancel();
    }, { passive: true });
    node.addEventListener('touchend', cancel);
    node.addEventListener('touchcancel', cancel);
  }

  function messageMenu(m, anchor) {
    const mine = m.authorId === data.me.id;
    const sent = !m.failed && !(m.pending && data.isOnline);
    const header = data.can('react') && sent ? h('div', { class: 'quick-reacts' },
      QUICK_REACTIONS.map((emo) => h('button', { class: 'emoji-btn big', onclick: () => { react(m, emo); closeAll(); } }, emo)),
      h('button', { class: 'emoji-btn big', title: '더보기', onclick: (e) => { closeAll(); openEmojiPicker(anchor || e.currentTarget, (emo) => react(m, emo)); } }, icon('smilePlus', 20))) : null;
    const items = [
      sent && data.can('sendMessage') ? { label: '답장', icon: 'reply', onClick: () => startReply(m) } : null,
      sent && data.can('pin') ? { label: m.pinned ? '고정 해제' : '메시지 고정', icon: 'pin', onClick: () => pin(m) } : null,
      mine && sent ? { label: '수정', icon: 'edit', onClick: () => startEdit(m) } : null,
      m.content ? { label: '텍스트 복사', icon: 'copy', onClick: () => navigator.clipboard?.writeText(m.content).then(() => toast('복사했습니다.')) } : null,
      m.failed ? { label: '다시 보내기', icon: 'refresh', onClick: () => data.retryMessage(m.id) } : null,
      { label: '작성자 프로필', icon: 'user', onClick: () => profileDialog(ctx, m.authorId) },
      mine || data.can('deleteAnyMessage') ? 'sep' : null,
      mine || data.can('deleteAnyMessage') ? { label: '삭제', icon: 'trash', danger: true, onClick: () => remove(m) } : null,
    ];
    const menu = openMenu(anchor || els.get(m.id) || el, items, { header });
    function closeAll() { menu.close(); }
  }

  // ───────── 첨부파일 ─────────
  function renderAttachment(att, m) {
    const box = h('div', { class: `att att-${att.kind}`, dataset: { att: att.id } });
    const expired = files.isExpired(att);
    const meta = (onDevice) => h('div', { class: 'att-meta' },
      h('span', { class: 'ellipsis', title: att.name }, att.name),
      h('span', { class: 'muted' }, fmtBytes(att.size)),
      m.pending ? null : h('span', { class: `expiry${expired ? ' expired' : ''}`, title: att.expiresAt ? `다운로드 가능 기한: ${fmtFull(att.expiresAt)}` : '' },
        expired ? icon('lock', 12) : icon('clock', 12), expired ? (onDevice ? ' 만료 · 기기 사본 보기 전용' : ' 만료됨') : ` ${fmtRemain(att.expiresAt - Date.now())}`),
      !expired ? h('button', { class: 'icon-btn tiny', title: '다운로드', 'aria-label': `${att.name} 다운로드`, onclick: () => download(att) }, icon('download', 16)) : null);

    const isMedia = att.kind === 'image' || att.kind === 'video' || att.kind === 'audio';
    const emoji = { image: '🖼️', video: '🎞️', audio: '🎵', file: '' }[att.kind] || '';

    const fileCard = (onDevice) => h('div', { class: 'file-card' },
      icon('file', 30, 'file-icon'),
      h('div', { class: 'file-info' },
        h('span', { class: 'file-name ellipsis', title: att.name }, emoji ? `${emoji} ${att.name}` : att.name),
        h('span', { class: 'muted small' }, fmtBytes(att.size),
          onDevice ? ' · 기기에 저장됨' : '',
          expired ? (onDevice ? ' · 만료되어 다시 내려받을 수 없음' : ' · 만료되어 볼 수 없음') : '',
          !expired && !onDevice && !data.isOnline ? ' · 서버에 연결되면 받을 수 있음' : '',
          !expired && !m.pending ? ` · ⏳ ${fmtRemain(att.expiresAt - Date.now())}` : '')),
      !expired
        ? h('button', { class: 'icon-btn', title: '다운로드', 'aria-label': `${att.name} 다운로드`, onclick: () => download(att) }, icon('download'))
        : h('span', { class: 'dim', title: '유효기간 만료' }, icon('lock', 18)));

    const fill = async () => {
      let url = await files.localUrl(att);
      const onDevice = !!url;
      if (!url && isMedia && !expired && data.isOnline && (att.kind === 'image' || att.size <= AUTO_FETCH_BYTES)) {
        box.replaceChildren(h('div', { class: 'att-loading shimmer' }));
        try { url = await files.fetchToDevice(att, data); } catch { /* 아래에서 처리 */ }
      }
      if (url && isMedia) {
        const view = () => lightbox({ url, name: att.name, kind: att.kind, canDownload: !files.isExpired(att), onDownload: () => download(att) });
        let media;
        if (att.kind === 'image') {
          media = h('img', { src: url, alt: att.name, loading: 'lazy', draggable: 'false', onclick: view, onload: () => keepBottom() });
        } else if (att.kind === 'video') {
          media = h('video', { src: url, controls: true, playsinline: true, preload: 'metadata', controlslist: expired ? 'nodownload' : null, onloadedmetadata: () => keepBottom() });
        } else {
          media = h('audio', { src: url, controls: true, preload: 'metadata', controlslist: expired ? 'nodownload' : null });
        }
        if (expired) media.addEventListener('contextmenu', (e) => e.preventDefault());
        box.replaceChildren(h('div', { class: 'att-media' }, media), meta(true));
        return;
      }
      if (isMedia && !expired && data.isOnline && !files.isExpired(att)) {
        // 큰 동영상/오디오: 눌러서 불러오기
        box.replaceChildren(h('div', { class: 'att-placeholder' }, icon('play', 22),
          h('span', {}, `${att.kind === 'video' ? '동영상' : att.kind === 'audio' ? '오디오' : '이미지'} 불러오기 (${fmtBytes(att.size)})`),
          h('button', {
            class: 'btn small primary',
            onclick: async (e) => {
              e.currentTarget.disabled = true;
              try { await files.fetchToDevice(att, data); } catch (er) { toast(errorText(er), 'error'); }
              fill();
            },
          }, icon('play', 14), ' 불러오기')), meta(false));
        return;
      }
      box.replaceChildren(fileCard(onDevice));
    };
    box.append(h('div', { class: 'att-loading' }));
    fill();
    return box;
  }

  async function download(att) {
    try {
      await files.saveToDevice(att, data);
    } catch (e) {
      toast(errorText(e), 'error');
    }
  }

  data.on('progress', ({ msgId, attId, p }) => {
    const box = els.get(msgId)?.querySelector(`[data-att="${attId}"]`);
    if (!box) return;
    let bar = box.querySelector('.upload-progress');
    if (!bar) { bar = h('div', { class: 'upload-progress' }, h('span')); box.append(bar); }
    bar.firstChild.style.width = `${Math.round(p * 100)}%`;
  });

  // ───────── 목록 조작 ─────────
  function divider(t) {
    return h('div', { class: 'day-divider', role: 'separator' }, h('span', {}, fmtDate(t)));
  }

  function renderAll({ preserve } = {}) {
    const oldH = scroller.scrollHeight;
    const oldTop = scroller.scrollTop;
    els.clear();
    const frag = document.createDocumentFragment();
    let prev = null;
    if (!st.hasMore && st.messages.length) frag.append(roomIntro());
    for (const m of st.messages) {
      if (!prev || !sameDay(prev.createdAt, m.createdAt)) frag.append(divider(m.createdAt));
      const node = renderMessage(m, prev);
      els.set(m.id, node);
      frag.append(node);
      prev = m;
    }
    if (!st.messages.length) frag.append(roomIntro(true));
    list.replaceChildren(frag);
    if (preserve) scroller.scrollTop = oldTop + (scroller.scrollHeight - oldH);
  }

  function roomIntro(empty = false) {
    const room = data.nodes.get(st.roomId);
    return h('div', { class: 'room-intro' },
      h('div', { class: 'intro-icon' }, icon('hash', 36)),
      h('h2', {}, `#${room?.name || ''}에 오신 것을 환영합니다!`),
      h('p', { class: 'muted' }, empty ? '첫 메시지를 보내 대화를 시작해 보세요.' : '이 채팅방의 시작입니다.'));
  }

  function upsert(m, { isNew }) {
    if (m.roomId !== st.roomId) return;
    const i = st.messages.findIndex((x) => x.id === m.id);
    if (i >= 0) {
      st.messages[i] = m;
      const old = els.get(m.id);
      const node = renderMessage(m, st.messages[i - 1]);
      els.set(m.id, node);
      if (old) old.replaceWith(node); else renderAll({ preserve: true });
      return;
    }
    const last = st.messages.at(-1);
    if (!last || m.createdAt >= last.createdAt) {
      const wasBottom = st.atBottom;
      if (!st.messages.length) { st.messages.push(m); renderAll(); } else {
        st.messages.push(m);
        if (!sameDay(last.createdAt, m.createdAt)) list.append(divider(m.createdAt));
        const node = renderMessage(m, last);
        els.set(m.id, node);
        list.append(node);
      }
      if (wasBottom || m.authorId === data.me.id) scrollToBottom();
      else if (isNew) { st.newCount += 1; updateJump(); }
    } else if (!st.hasMore || m.createdAt > st.messages[0].createdAt) {
      st.messages.push(m);
      st.messages.sort((a, b) => a.createdAt - b.createdAt);
      renderAll({ preserve: true });
    }
  }

  function removeMsg({ id, roomId }) {
    if (roomId !== st.roomId) return;
    const i = st.messages.findIndex((x) => x.id === id);
    if (i < 0) return;
    st.messages.splice(i, 1);
    renderAll({ preserve: true });
  }

  data.on('message', (m, info) => upsert(m, info || {}));
  data.on('messageRemoved', removeMsg);
  data.on('users', debounce(() => { if (st.roomId) renderAll({ preserve: true }); }, 300));
  data.on('nodes', () => { if (st.roomId) { renderTitle(); renderComposerState(); } });
  data.on('resync', () => { if (st.roomId) reload(); });
  data.on('status', () => renderComposerState());

  // ───────── 스크롤 ─────────
  const nearBottom = () => scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 80;

  function scrollToBottom(smooth = false) {
    requestAnimationFrame(() => {
      scroller.scrollTo({ top: scroller.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
      st.atBottom = true;
      st.newCount = 0;
      updateJump();
      ctx.markRead(st.roomId);
    });
  }

  function keepBottom() {
    if (st.atBottom) scroller.scrollTop = scroller.scrollHeight;
  }

  function updateJump() {
    jumpBtn.hidden = st.atBottom;
    jumpBtn.querySelector('span').textContent = st.newCount ? `새 메시지 ${st.newCount}개` : '최신 메시지로';
    jumpBtn.classList.toggle('has-new', st.newCount > 0);
  }

  scroller.addEventListener('scroll', () => {
    const b = nearBottom();
    if (b !== st.atBottom) {
      st.atBottom = b;
      if (b) { st.newCount = 0; ctx.markRead(st.roomId); }
      updateJump();
    }
    if (scroller.scrollTop < 300 && st.hasMore && !st.loading) loadOlder();
  }, { passive: true });

  new ResizeObserver(() => keepBottom()).observe(scroller);

  async function loadOlder() {
    if (!st.hasMore || st.loading || !st.messages.length) return false;
    st.loading = true;
    const token = st.token;
    topLoader.replaceChildren(h('div', { class: 'spinner' }));
    try {
      const res = await data.listMessages(st.roomId, { before: st.messages[0].createdAt });
      if (token !== st.token) return false;
      const ids = new Set(st.messages.map((m) => m.id));
      st.messages = [...res.messages.filter((m) => !ids.has(m.id)), ...st.messages];
      st.hasMore = res.hasMore;
      renderAll({ preserve: true });
      return true;
    } catch (e) {
      toast(errorText(e), 'error');
      return false;
    } finally {
      st.loading = false;
      topLoader.replaceChildren();
    }
  }

  async function jumpTo(id) {
    if (!id) return;
    for (let i = 0; i < 40 && !els.has(id); i++) {
      if (!(await loadOlder())) break;
    }
    const node = els.get(id);
    if (!node) return toast('원본 메시지를 찾을 수 없습니다.', 'warn');
    node.scrollIntoView({ block: 'center', behavior: 'smooth' });
    node.classList.remove('flash');
    void node.offsetWidth;
    node.classList.add('flash');
  }

  async function reload() {
    const token = ++st.token;
    const roomId = st.roomId;
    try {
      const res = await data.listMessages(roomId);
      if (token !== st.token) return;
      st.messages = res.messages;
      st.hasMore = res.hasMore;
      renderAll();
      scrollToBottom();
    } catch (e) {
      toast(errorText(e), 'error');
    }
    renderPins();
  }

  async function renderPins() {
    const roomId = st.roomId;
    try {
      const pins = await data.listPins(roomId);
      if (roomId !== st.roomId) return;
      pinBtn.classList.toggle('has-count', pins.length > 0);
      pinBtn.dataset.count = pins.length ? String(pins.length) : '';
    } catch { /* noop */ }
  }
  data.on('message', (m) => { if (m.roomId === st.roomId) renderPinsSoon(); });
  const renderPinsSoon = debounce(renderPins, 400);

  // ───────── 동작 ─────────
  async function react(m, emoji) {
    try { await data.toggleReaction(m.id, emoji); } catch (e) { toast(errorText(e), 'error'); }
  }

  async function pin(m) {
    try {
      await data.setPinned(m.id, !m.pinned);
      toast(m.pinned ? '고정을 해제했습니다.' : '메시지를 고정했습니다. 📌 버튼에서 모아 볼 수 있어요.');
    } catch (e) {
      toast(errorText(e), 'error');
    }
  }

  async function remove(m) {
    const ok = await confirmDialog({ title: '메시지 삭제', message: '이 메시지를 삭제할까요? 첨부파일도 함께 삭제됩니다.', confirmText: '삭제', danger: true });
    if (!ok) return;
    try { await data.deleteMessage(m.id); } catch (e) { toast(errorText(e), 'error'); }
  }

  function startReply(m) {
    st.editing = null;
    st.replyTo = m;
    renderBar();
    ta.focus();
  }

  function startEdit(m) {
    st.replyTo = null;
    st.editing = m;
    ta.value = m.content || '';
    renderBar();
    autosize();
    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);
  }

  function cancelBar() {
    if (st.editing) ta.value = drafts.get(st.roomId) || '';
    st.editing = null;
    st.replyTo = null;
    renderBar();
    autosize();
  }

  function renderBar() {
    if (st.editing) {
      bar.hidden = false;
      bar.replaceChildren(icon('edit', 14), h('span', {}, '메시지 수정 중'), h('span', { class: 'muted small' }, ' · Esc 취소'), h('button', { class: 'icon-btn tiny', 'aria-label': '취소', onclick: cancelBar }, icon('x', 16)));
    } else if (st.replyTo) {
      const u = authorOf(st.replyTo);
      bar.hidden = false;
      bar.replaceChildren(icon('reply', 14), h('span', {}, h('strong', {}, u.nickname), '님에게 답장'),
        h('span', { class: 'muted small ellipsis' }, st.replyTo.content?.slice(0, 60) || '📎 첨부파일'),
        h('button', { class: 'icon-btn tiny', 'aria-label': '답장 취소', onclick: cancelBar }, icon('x', 16)));
    } else {
      bar.hidden = true;
      bar.replaceChildren();
    }
  }

  function addFiles(list) {
    if (!data.can('sendMessage')) return;
    if (st.editing) cancelBar();
    for (const f of list) {
      if (f.size > data.maxUploadBytes) { toast(`'${f.name}' 파일이 너무 큽니다. (최대 ${fmtBytes(data.maxUploadBytes)})`, 'error'); continue; }
      if (st.files.length >= 10) { toast('한 번에 최대 10개까지 첨부할 수 있습니다.', 'warn'); break; }
      st.files.push(f);
    }
    renderTray();
    ta.focus();
  }

  function renderTray() {
    tray.hidden = !st.files.length;
    tray.replaceChildren(...st.files.map((f, i) => {
      const thumb = f.type.startsWith('image/') ? h('img', { src: URL.createObjectURL(f), alt: '' }) : icon(f.type.startsWith('video/') ? 'video' : 'file', 26);
      return h('div', { class: 'tray-item', title: f.name }, h('div', { class: 'tray-thumb' }, thumb),
        h('span', { class: 'tray-name ellipsis' }, f.name), h('span', { class: 'muted small' }, fmtBytes(f.size)),
        h('button', { class: 'tray-remove', 'aria-label': `${f.name} 제거`, onclick: () => { st.files.splice(i, 1); renderTray(); } }, icon('x', 14)));
    }));
  }

  function insertText(t) {
    const s = ta.selectionStart ?? ta.value.length;
    const e = ta.selectionEnd ?? ta.value.length;
    ta.value = ta.value.slice(0, s) + t + ta.value.slice(e);
    ta.setSelectionRange(s + t.length, s + t.length);
    ta.focus();
    autosize();
  }

  async function send() {
    const text = ta.value;
    if (st.editing) {
      const m = st.editing;
      if (text.trim() === (m.content || '').trim()) return cancelBar();
      try {
        await data.editMessage(m.id, text);
        cancelBar();
        ta.value = drafts.get(st.roomId) || '';
        autosize();
      } catch (e) {
        toast(errorText(e), 'error');
      }
      return;
    }
    if (!text.trim() && !st.files.length) return;
    if (text.length > 4000) return toast('메시지는 4000자까지 보낼 수 있습니다.', 'warn');
    const payload = { content: text, files: st.files, replyTo: st.replyTo?.id || null };
    st.files = [];
    st.replyTo = null;
    ta.value = '';
    drafts.delete(st.roomId);
    renderTray();
    renderBar();
    autosize();
    hideMentions();
    try {
      await data.sendMessage(st.roomId, payload);
    } catch (e) {
      toast(errorText(e), 'error');
    }
  }

  function autosize() {
    ta.style.height = 'auto';
    ta.style.height = `${Math.min(ta.scrollHeight, isMobile() ? 120 : 240)}px`;
    const n = ta.value.length;
    counter.hidden = n < 3500;
    counter.textContent = `${n} / 4000`;
    counter.classList.toggle('over', n > 4000);
  }

  // @멘션 자동완성
  let mentionState = null;
  function updateMentions() {
    const pos = ta.selectionStart;
    const before = ta.value.slice(0, pos);
    const mm = before.match(/(^|\s)@([^\s@]{0,32})$/);
    if (!mm) return hideMentions();
    const q = mm[2].toLowerCase();
    const users = [...data.users.values()].filter((u) => u.nickname?.toLowerCase().includes(q)).slice(0, 6);
    if (!users.length) return hideMentions();
    mentionState = { start: pos - mm[2].length - 1, users, index: 0 };
    renderMentions();
  }
  function renderMentions() {
    mentionBox.hidden = false;
    mentionBox.replaceChildren(h('div', { class: 'mention-head muted small' }, '멤버'), ...mentionState.users.map((u, i) => h('button', {
      class: `mention-opt${i === mentionState.index ? ' active' : ''}`, role: 'option', type: 'button',
      onmousedown: (e) => { e.preventDefault(); pickMention(i); },
    }, avatar(u, 22), h('span', {}, u.nickname), badge(u.provider))));
  }
  function pickMention(i) {
    const u = mentionState.users[i];
    const pos = ta.selectionStart;
    ta.value = `${ta.value.slice(0, mentionState.start)}@${u.nickname} ${ta.value.slice(pos)}`;
    const c = mentionState.start + u.nickname.length + 2;
    ta.setSelectionRange(c, c);
    hideMentions();
    ta.focus();
  }
  function hideMentions() {
    mentionState = null;
    mentionBox.hidden = true;
  }

  const sendTyping = throttle(() => data.sendTyping(st.roomId), 3000);
  ta.addEventListener('input', () => {
    autosize();
    if (!st.editing) drafts.set(st.roomId, ta.value);
    if (ta.value.trim()) sendTyping();
    updateMentions();
  });
  ta.addEventListener('keydown', (e) => {
    if (mentionState) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const n = mentionState.users.length;
        mentionState.index = (mentionState.index + (e.key === 'ArrowDown' ? 1 : n - 1)) % n;
        return renderMentions();
      }
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); return pickMention(mentionState.index); }
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); return hideMentions(); }
    }
    if (e.key === 'Escape' && (st.editing || st.replyTo)) { e.preventDefault(); e.stopPropagation(); return cancelBar(); }
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && settings.enterToSend && !isTouch()) {
      e.preventDefault();
      send();
    }
    if (e.key === 'ArrowUp' && !ta.value && !st.editing) {
      const mine = [...st.messages].reverse().find((m) => m.authorId === data.me.id && !m.failed && !(m.pending && data.isOnline));
      if (mine) { e.preventDefault(); startEdit(mine); }
    }
  });
  ta.addEventListener('blur', () => setTimeout(hideMentions, 150));
  ta.addEventListener('paste', (e) => {
    const fl = [...(e.clipboardData?.files || [])];
    if (fl.length) {
      e.preventDefault();
      addFiles(fl);
    }
  });

  // 드래그 앤 드롭 첨부
  let dragDepth = 0;
  const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
  el.addEventListener('dragenter', (e) => { if (!hasFiles(e) || !data.can('sendMessage')) return; dragDepth++; dropOverlay.hidden = false; });
  el.addEventListener('dragleave', (e) => { if (!hasFiles(e)) return; dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) dropOverlay.hidden = true; });
  el.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
  el.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth = 0;
    dropOverlay.hidden = true;
    addFiles([...e.dataTransfer.files]);
  });

  // 입력 중 표시
  const typers = new Map();
  function renderTyping() {
    const now = Date.now();
    const names = [...typers.entries()].filter(([, v]) => v.roomId === st.roomId && v.until > now).map(([id]) => data.user(id)?.nickname || '누군가');
    typingEl.replaceChildren(...(names.length ? [h('span', { class: 'dots' }, h('i'), h('i'), h('i')),
      h('span', {}, names.length > 3 ? '여러 명이 입력하고 있어요…' : `${names.join(', ')}님이 입력하고 있어요…`)] : []));
  }
  data.on('typing', ({ roomId, userId }) => {
    typers.set(userId, { roomId, until: Date.now() + 5000 });
    renderTyping();
    setTimeout(renderTyping, 5100);
  });
  data.on('message', (m) => { if (typers.delete(m.authorId)) renderTyping(); });

  function renderComposerState() {
    const room = data.nodes.get(st.roomId);
    const allowed = data.can('sendMessage') && !!room;
    ta.disabled = !allowed;
    ta.placeholder = allowed ? `#${room?.name || ''}에 메시지 보내기` : '메시지를 보낼 수 없습니다';
    composer.classList.toggle('disabled', !allowed);
  }

  return {
    el,
    get roomId() { return st.roomId; },
    async open(roomId) {
      if (st.roomId && !st.editing) drafts.set(st.roomId, ta.value);
      st.roomId = roomId;
      st.messages = [];
      st.files = [];
      st.replyTo = null;
      st.editing = null;
      st.newCount = 0;
      renderTitle();
      renderBar();
      renderTray();
      renderComposerState();
      typers.clear();
      renderTyping();
      ta.value = drafts.get(roomId) || '';
      autosize();
      list.replaceChildren(h('div', { class: 'list-loading' }, h('div', { class: 'spinner' })));
      await reload();
      if (!isTouch()) ta.focus({ preventScroll: true });
    },
    jumpTo,
    focus: () => ta.focus(),
    get atBottom() { return st.atBottom; },
    empty: () => emptyState('hash', '채팅방을 선택하세요', '왼쪽 목록에서 채팅방이나 통화방을 선택하세요.'),
  };
}
