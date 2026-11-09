import {
  h, toast, fmtTime, fmtDate, fmtStamp, fmtFull, fmtBytes, fmtRemain, sameDay, throttle, debounce, isTouch, isMobile, compressImage, safeImageUrl,
} from '../util.js';
import {
  renderMarkdown, isEmojiOnly, mentionsMe, linksIn, youtubeId,
} from '../markdown.js';
import * as files from '../files.js';
import {
  bookmarks, blocked, drafts, reminders, personal,
} from '../local.js';
import {
  runCommand, COMMANDS, searchEmoji, replaceShortcodes,
} from '../commands.js';
import { LANG_LABEL, runnable, langFromName } from '../runner.js';
import { icon } from './icons.js';
import {
  avatar, badge, openMenu, openEmojiPicker, confirmDialog, QUICK_REACTIONS, emptyState,
} from './common.js';
import {
  profileDialog, lightbox, settings, listSetting, editNodeDialog, editHistoryDialog, forwardDialog, pollDialog, filePreviewDialog, commandsDialog,
} from './dialogs.js';
import { errorText } from './errors.js';
import { enhance } from './codeblock.js';

const GROUP_MS = 7 * 60_000;
const AUTO_FETCH_BYTES = 20 * 1024 * 1024;
const COLLAPSE_CHARS = 1500;
const COLLAPSE_LINES = 25;
const TEXT_PREVIEW = /^(text\/|application\/(json|xml|javascript|x-sh|x-python|sql))/;
const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;

export function createChatView(ctx) {
  const { data } = ctx;
  const st = {
    roomId: null, messages: [], hasMore: false, loading: false, replyTo: null, editing: null, files: [], spoilers: new Set(), atBottom: true, newCount: 0, token: 0, since: 0, slowUntil: 0,
  };
  const els = new Map();
  const revealed = new Set(); // 차단한 사용자의 메시지 중 '보기'를 누른 것
  const expanded = new Set(); // 펼친 긴 메시지

  // ───────── 헤더 ─────────
  const title = h('div', { class: 'room-title' });
  const pinBtn = h('button', { class: 'icon-btn', title: '고정된 메시지', 'aria-label': '고정된 메시지', onclick: () => ctx.togglePanel('pins') }, icon('pin'));
  const header = h('header', { class: 'room-head' },
    h('button', { class: 'icon-btn mobile-only', 'aria-label': '메뉴 열기', onclick: () => ctx.openDrawer() }, icon('menu')),
    title,
    h('div', { class: 'room-actions' },
      pinBtn,
      h('button', { class: 'icon-btn', title: '검색', 'aria-label': '메시지 검색', onclick: () => ctx.togglePanel('search') }, icon('search')),
      h('button', { class: 'icon-btn desktop-only', title: '받은 멘션', 'aria-label': '받은 멘션', onclick: () => ctx.togglePanel('mentions') }, icon('at')),
      h('button', { class: 'icon-btn desktop-only', title: '미디어·파일·링크', 'aria-label': '미디어·파일·링크', onclick: () => ctx.togglePanel('media') }, icon('grid')),
      h('button', { class: 'icon-btn desktop-only', title: '저장한 메시지', 'aria-label': '저장한 메시지', onclick: () => ctx.togglePanel('bookmarks') }, icon('bookmark')),
      h('button', { class: 'icon-btn', title: '멤버', 'aria-label': '멤버 목록', onclick: () => ctx.togglePanel('members') }, icon('users')),
      h('button', { class: 'icon-btn', title: '더보기', 'aria-label': '채팅방 메뉴', onclick: (e) => ctx.roomMenu(st.roomId, e.currentTarget) }, icon('more'))));

  // ───────── 메시지 목록 ─────────
  const list = h('div', { class: 'msg-list', role: 'log', 'aria-live': 'polite' });
  const topLoader = h('div', { class: 'list-top' });
  const scroller = h('div', { class: 'msg-scroller', tabindex: '-1' }, topLoader, list, h('div', { class: 'list-bottom-pad' }));
  const jumpBtn = h('button', { class: 'jump-latest', hidden: true, onclick: () => scrollToBottom(true) }, icon('arrowDown', 16), h('span', {}, '최신 메시지로'));
  const typingEl = h('div', { class: 'typing', 'aria-live': 'polite' });

  // ───────── 입력창 ─────────
  const ta = h('textarea', { class: 'composer-input', rows: '1', placeholder: '메시지 보내기', 'aria-label': '메시지 입력', maxlength: '4000', enterkeyhint: 'send' });
  const fileInput = h('input', { type: 'file', multiple: true, hidden: true, onchange: () => { addFiles([...fileInput.files]); fileInput.value = ''; } });
  const cameraInput = h('input', { type: 'file', accept: 'image/*,video/*', capture: 'environment', hidden: true, onchange: () => { addFiles([...cameraInput.files]); cameraInput.value = ''; } });
  const tray = h('div', { class: 'attach-tray', hidden: true });
  const bar = h('div', { class: 'composer-bar', hidden: true });
  const slowBar = h('div', { class: 'composer-bar slow', hidden: true });
  const counter = h('span', { class: 'char-count', hidden: true });
  const suggestBox = h('div', { class: 'mention-box', hidden: true, role: 'listbox' });
  const sendBtn = h('button', { class: 'icon-btn send-btn', title: '보내기', 'aria-label': '보내기', onclick: () => send() }, icon('send'));
  const micBtn = SpeechRec ? h('button', { class: 'icon-btn', title: '음성으로 입력', 'aria-label': '음성으로 입력', onclick: () => toggleDictation() }, icon('mic')) : null;
  const plusBtn = h('button', { class: 'icon-btn', title: '첨부 · 투표 · 음성 메시지', 'aria-label': '첨부 메뉴', onclick: (e) => plusMenu(e.currentTarget) }, icon('plus'));
  const box = h('div', { class: 'composer-box' },
    plusBtn,
    ta,
    micBtn,
    h('button', { class: 'icon-btn', title: '이모지', 'aria-label': '이모지', onclick: (e) => openEmojiPicker(e.currentTarget, insertText) }, icon('smile')),
    sendBtn);
  const composer = h('div', { class: 'composer' }, suggestBox, slowBar, bar, tray, box, counter, fileInput, cameraInput, typingEl);

  const dropOverlay = h('div', { class: 'drop-overlay', hidden: true }, h('div', {}, icon('clip', 40), h('p', {}, '여기에 놓아 파일 첨부')));
  const body = h('div', { class: 'chat-body' }, scroller, jumpBtn);
  const el = h('section', { class: 'chat-view', 'aria-label': '채팅' }, header, body, composer, dropOverlay);

  // ───────── 렌더링 ─────────
  const authorOf = (m) => data.user(m.authorId) || { id: m.authorId, nickname: m.author?.nickname || '알 수 없음', provider: m.author?.provider || 'guest' };
  const mdOpts = () => ({ me: data.me, filterWords: listSetting('filterWords') });

  function isCont(m, prev) {
    return prev && !m.replyTo && !m.forwarded && m.kind !== 'poll' && prev.kind !== 'poll' && prev.authorId === m.authorId
      && m.createdAt - prev.createdAt < GROUP_MS && sameDay(m.createdAt, prev.createdAt);
  }

  function renderTitle() {
    const room = data.nodes.get(st.roomId);
    if (!room) return;
    const path = [];
    for (let p = data.nodes.get(room.parentId); p; p = data.nodes.get(p.parentId)) path.unshift(p.name);
    const tags = [room.readonly ? '📢 공지' : null, room.slowmode ? `🐢 ${room.slowmode}초` : null].filter(Boolean).join(' · ');
    title.replaceChildren(
      room.emoji ? h('span', { class: 'room-emoji' }, room.emoji) : icon('hash', 22, 'dim'),
      h('div', { class: 'room-title-text' },
        h('h2', { class: 'ellipsis' }, room.name),
        room.topic || path.length || tags
          ? h('span', { class: 'room-topic ellipsis', title: room.topic || '' }, [path.join(' / '), tags, room.topic].filter(Boolean).join(' · '))
          : null),
    );
    title.onclick = data.can('manageNodes') ? () => editNodeDialog(ctx, room) : null;
    title.classList.toggle('clickable', data.can('manageNodes'));
  }

  function sendResult(m) {
    return (output, kind) => {
      if (!data.can('sendMessage')) return;
      const content = `▶ ${LANG_LABEL[kind] || ''} 실행 결과\n\`\`\`\n${output.slice(0, 3800)}\n\`\`\``;
      data.sendMessage(st.roomId, { content, replyTo: m }).catch((e) => toast(errorText(e), 'error'));
    };
  }

  function renderPoll(m) {
    const p = m.poll;
    const total = new Set(p.options.flatMap((o) => o.votes)).size;
    const max = Math.max(1, ...p.options.map((o) => o.votes.length));
    const canVote = data.can('react') && !m.failed && !(m.pending && data.isOnline);
    return h('div', { class: 'poll' },
      h('div', { class: 'poll-q' }, icon('poll', 18), h('span', { html: renderMarkdown(m.content, mdOpts()) })),
      h('div', { class: 'poll-options' }, p.options.map((o) => {
        const mine = o.votes.includes(data.me.id);
        const pct = total ? Math.round((o.votes.length / total) * 100) : 0;
        return h('button', {
          class: `poll-opt${mine ? ' mine' : ''}${o.votes.length === max && o.votes.length ? ' top' : ''}`,
          disabled: !canVote,
          title: o.votes.map((id) => data.user(id)?.nickname || '?').join(', ') || '아직 투표 없음',
          onclick: () => data.vote(m.id, o.id).catch((e) => toast(errorText(e), 'error')),
        }, h('span', { class: 'poll-bar', style: { width: `${pct}%` } }),
        h('span', { class: 'poll-check' }, mine ? '✓' : ''), h('span', { class: 'poll-text' }, o.text),
        h('span', { class: 'poll-count' }, `${o.votes.length}표 · ${pct}%`));
      })),
      h('div', { class: 'muted small' }, `${total}명 참여 · ${p.multi ? '여러 개 선택 가능' : '하나만 선택'}${canVote ? '' : data.can('react') ? '' : ' · 게스트는 투표할 수 없습니다'}`));
  }

  function renderEmbeds(m) {
    if (!settings.embeds || !m.content) return null;
    const out = [];
    for (const url of linksIn(m.content).slice(0, 3)) {
      const yt = youtubeId(url);
      if (yt) {
        const card = h('div', { class: 'embed yt' });
        const play = () => card.replaceChildren(h('iframe', {
          src: `https://www.youtube-nocookie.com/embed/${yt}?autoplay=1`, title: 'YouTube', allow: 'autoplay; encrypted-media; picture-in-picture', allowfullscreen: true, loading: 'lazy',
        }));
        card.append(h('button', { class: 'yt-thumb', 'aria-label': 'YouTube 동영상 재생', onclick: play },
          h('img', { src: `https://i.ytimg.com/vi/${yt}/hqdefault.jpg`, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer', onload: () => keepBottom() }),
          h('span', { class: 'yt-play' }, icon('play', 28))));
        out.push(card);
      } else if (/\.(png|jpe?g|gif|webp|avif)(\?[^\s]*)?$/i.test(url) && safeImageUrl(url)) {
        const load = () => card.replaceChildren(h('img', { src: url, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer', onload: () => keepBottom(), onclick: () => lightbox({ url, name: url.split('/').pop(), kind: 'image', canDownload: false }) }));
        const card = h('div', { class: 'embed img' });
        if (settings.autoloadMedia) load();
        else card.append(h('button', { class: 'btn small secondary', onclick: load }, icon('image', 14), ' 링크 이미지 보기'));
        out.push(card);
      }
    }
    return out.length ? h('div', { class: 'embeds' }, out) : null;
  }

  function renderMessage(m, prev) {
    const u = authorOf(m);
    const mine = m.authorId === data.me.id;
    if (!mine && blocked.has(m.authorId) && !revealed.has(m.id)) {
      return h('div', { class: 'msg blocked-msg', dataset: { id: m.id }, id: `m-${m.id}` },
        h('div', { class: 'msg-main' }, h('span', { class: 'muted small' }, '🚫 차단한 사용자의 메시지입니다. '),
          h('button', { class: 'link-btn small', onclick: () => { revealed.add(m.id); rerender(m); } }, '보기')));
    }
    const cont = isCont(m, prev);
    const mention = !mine && mentionsMe(m.content, data.me, listSetting('keywords'));
    const cls = ['msg', cont && 'cont', mine && 'mine', mention && 'mention', m.pending && data.mode !== 'local' && 'pending', m.failed && 'failed', m.pinned && 'pinned', m.kind === 'me' && 'action'].filter(Boolean).join(' ');

    const openProfile = (e) => { e.stopPropagation(); profileDialog(ctx, m.authorId); };
    const reply = m.replyPreview ? h('button', { class: 'msg-reply', onclick: () => jumpTo(m.replyTo) },
      icon('reply', 14, 'dim'),
      avatar(data.user(m.replyPreview.authorId) || { id: m.replyPreview.authorId, nickname: m.replyPreview.author?.nickname }, 16),
      h('strong', {}, (data.user(m.replyPreview.authorId) || m.replyPreview.author)?.nickname || '알 수 없음'),
      h('span', { class: 'ellipsis muted' }, m.replyPreview.content || (m.replyPreview.attachments ? '📎 첨부파일' : ''))) : null;

    const head = cont ? null : h('div', { class: 'msg-head' },
      h('button', { class: 'msg-name', onclick: openProfile }, u.nickname),
      badge(u.provider),
      u.status ? h('span', { class: 'msg-status-text ellipsis', title: u.status }, u.status) : null,
      h('time', { class: 'msg-time', datetime: new Date(m.createdAt).toISOString(), title: fmtFull(m.createdAt) }, fmtStamp(m.createdAt)),
      m.pinned ? h('span', { class: 'pin-mark', title: '고정됨' }, icon('pin', 13)) : null,
      bookmarks.has(m.id) ? h('span', { class: 'pin-mark', title: '저장함' }, icon('bookmark', 13)) : null);

    const gutter = cont
      ? h('div', { class: 'msg-gutter' }, h('time', { class: 'hover-time', title: fmtFull(m.createdAt) }, fmtTime(m.createdAt)))
      : h('button', { class: 'msg-gutter msg-avatar', onclick: openProfile, 'aria-label': `${u.nickname} 프로필` }, avatar(u, 40));

    const fwd = m.forwarded ? h('button', {
      class: 'forwarded', title: '원래 메시지로 이동',
      onclick: () => (m.forwarded.messageId && data.nodes.has(m.forwarded.roomId) ? ctx.jumpTo(m.forwarded.roomId, m.forwarded.messageId) : null),
    }, icon('forward', 14), ` 전달됨 · ${m.forwarded.authorNickname || '?'} · #${m.forwarded.roomName || '?'} · ${fmtStamp(m.forwarded.createdAt)}`) : null;

    let text = null;
    if (m.kind === 'poll' && m.poll) {
      text = renderPoll(m);
    } else if (m.content) {
      const long = m.content.length > COLLAPSE_CHARS || m.content.split('\n').length > COLLAPSE_LINES;
      const edited = m.editedAt ? `<button class="edited" data-history title="${fmtFull(m.editedAt)}${m.editHistory?.length ? ' · 눌러서 수정 기록 보기' : ''}">(수정됨)</button>` : '';
      const html = m.kind === 'me'
        ? `<em class="me-line"><strong>${escapeName(u.nickname)}</strong> ${renderMarkdown(m.content, mdOpts())}</em>${edited}`
        : renderMarkdown(m.content, mdOpts()) + edited;
      text = h('div', { class: `msg-text${isEmojiOnly(m.content) ? ' jumbo' : ''}${long && !expanded.has(m.id) ? ' collapsed' : ''}`, html });
      text.querySelector('[data-history]')?.addEventListener('click', () => m.editHistory?.length && editHistoryDialog(ctx, m));
      enhance(text, { onSendResult: sendResult(m) });
      if (long) {
        text = h('div', {}, text, h('button', {
          class: 'link-btn small more-btn',
          onclick: (e) => { if (expanded.has(m.id)) expanded.delete(m.id); else expanded.add(m.id); e.currentTarget.previousSibling.classList.toggle('collapsed'); e.currentTarget.textContent = expanded.has(m.id) ? '접기' : '더보기'; },
        }, expanded.has(m.id) ? '접기' : '더보기'));
      }
    }

    const imgs = (m.attachments || []).filter((a) => a.kind === 'image').length;
    const atts = m.attachments?.length ? h('div', { class: `msg-atts${imgs >= 2 ? ` grid g${Math.min(imgs, 4)}` : ''}` }, m.attachments.map((a) => renderAttachment(a, m))) : null;

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
      ? h('div', { class: 'msg-status error' }, icon('alert', 14), ` 전송 실패${m.failed !== true && m.failed !== 'failed' ? ` (${errorText({ code: m.failed })})` : ''} `,
        h('button', { class: 'link-btn', onclick: () => data.retryMessage(m.id) }, '다시 보내기'), ' · ',
        h('button', { class: 'link-btn', onclick: () => data.deleteMessage(m.id) }, '삭제'))
      : m.pending && data.mode !== 'local'
        ? h('div', { class: `msg-status${data.isOnline ? ' late' : ''}` }, icon('clock', 13), data.isOnline ? ' 보내는 중…' : ' 기기에 저장됨 · 연결되면 전송')
        : null;

    const main = h('div', { class: 'msg-main' }, fwd, text, atts, renderEmbeds(m), reactEl, status);
    const actions = isTouch() ? null : h('div', { class: 'msg-actions', role: 'toolbar' },
      data.can('react') ? QUICK_REACTIONS.slice(0, 3).map((emo) => h('button', { class: 'icon-btn tiny emoji', title: emo, onclick: () => react(m, emo) }, emo)) : null,
      data.can('react') ? h('button', { class: 'icon-btn tiny', title: '반응 추가', onclick: (e) => openEmojiPicker(e.currentTarget, (emo) => react(m, emo)) }, icon('smilePlus', 18)) : null,
      h('button', { class: 'icon-btn tiny', title: '답장', onclick: () => startReply(m) }, icon('reply', 18)),
      mine && sentOk && m.kind !== 'poll' ? h('button', { class: 'icon-btn tiny', title: '수정', onclick: () => startEdit(m) }, icon('edit', 18)) : null,
      h('button', { class: 'icon-btn tiny', title: '더보기', onclick: (e) => messageMenu(m, e.currentTarget) }, icon('more', 18)));

    const node = h('div', {
      class: cls, dataset: { id: m.id }, id: `m-${m.id}`, role: 'article',
      oncontextmenu: (e) => {
        if (e.target.closest('a, video, audio, .run-box, pre')) return;
        e.preventDefault();
        messageMenu(m, e);
      },
    }, reply, head, gutter, main, actions);
    attachLongPress(node, () => messageMenu(m, null));
    return node;
  }

  const escapeName = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function rerender(m) {
    const i = st.messages.findIndex((x) => x.id === m.id);
    const old = els.get(m.id);
    if (i < 0 || !old) return;
    const node = renderMessage(st.messages[i], st.messages[i - 1]);
    els.set(m.id, node);
    old.replaceWith(node);
  }

  function attachLongPress(node, fn) {
    if (!isTouch()) return;
    let t = null;
    let sx = 0;
    let sy = 0;
    node.addEventListener('touchstart', (e) => {
      if (e.target.closest('a, button, video, audio, .spoiler, pre, .run-box')) return;
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

  const messageLink = (m) => `${location.origin}${location.pathname}#/room/${m.roomId}/m/${m.id}`;

  function speak(m) {
    if (!('speechSynthesis' in window)) return toast('이 브라우저는 읽어주기를 지원하지 않습니다.', 'warn');
    speechSynthesis.cancel();
    const plain = (m.content || '').replace(/```[\s\S]*?```/g, ' 코드 ').replace(/https?:\/\/\S+/g, ' 링크 ').replace(/[*_~|`#>]/g, '');
    const utter = new SpeechSynthesisUtterance(`${authorOf(m).nickname}. ${plain}`);
    utter.lang = 'ko-KR';
    speechSynthesis.speak(utter);
  }

  function messageMenu(m, anchor) {
    const mine = m.authorId === data.me.id;
    const sent = !m.failed && !(m.pending && data.isOnline);
    const saved = bookmarks.has(m.id);
    const header = data.can('react') && sent ? h('div', { class: 'quick-reacts' },
      QUICK_REACTIONS.map((emo) => h('button', { class: 'emoji-btn big', onclick: () => { react(m, emo); closeAll(); } }, emo)),
      h('button', { class: 'emoji-btn big', title: '더보기', onclick: (e) => { closeAll(); openEmojiPicker(anchor || e.currentTarget, (emo) => react(m, emo)); } }, icon('smilePlus', 20))) : null;
    const items = [
      sent && data.can('sendMessage') ? { label: '답장', icon: 'reply', onClick: () => startReply(m) } : null,
      sent && data.can('sendMessage') ? { label: '전달', icon: 'forward', onClick: () => forwardDialog(ctx, m) } : null,
      sent && data.can('pin') ? { label: m.pinned ? '고정 해제' : '메시지 고정', icon: 'pin', onClick: () => pin(m) } : null,
      { label: saved ? '저장 취소' : '메시지 저장 (북마크)', icon: 'bookmark', onClick: () => { const on = bookmarks.toggle(m); toast(on ? '저장했습니다. 🔖 저장한 메시지에서 볼 수 있어요.' : '저장을 취소했습니다.'); rerender(m); } },
      mine && sent && m.kind !== 'poll' ? { label: '수정', icon: 'edit', onClick: () => startEdit(m) } : null,
      m.editHistory?.length ? { label: `수정 기록 (${m.editHistory.length})`, icon: 'history', onClick: () => editHistoryDialog(ctx, m) } : null,
      m.content ? { label: '텍스트 복사', icon: 'copy', onClick: () => navigator.clipboard?.writeText(m.content).then(() => toast('복사했습니다.')) } : null,
      { label: '메시지 링크 복사', icon: 'link', onClick: () => navigator.clipboard?.writeText(messageLink(m)).then(() => toast('링크를 복사했습니다.'), () => toast(messageLink(m))) },
      navigator.share ? { label: '공유', icon: 'share', onClick: () => navigator.share({ title: authorOf(m).nickname, text: m.content || '', url: messageLink(m) }).catch(() => {}) } : null,
      m.content ? { label: '읽어주기', icon: 'speaker', onClick: () => speak(m) } : null,
      m.failed ? { label: '다시 보내기', icon: 'refresh', onClick: () => data.retryMessage(m.id) } : null,
      { label: '작성자 프로필', icon: 'user', onClick: () => profileDialog(ctx, m.authorId) },
      mine || data.can('deleteAnyMessage') ? 'sep' : null,
      mine || data.can('deleteAnyMessage') ? { label: '삭제', icon: 'trash', danger: true, onClick: () => remove(m) } : null,
    ];
    const menu = openMenu(anchor || els.get(m.id) || el, items, { header });
    function closeAll() { menu.close(); }
  }

  // ───────── 첨부파일 ─────────
  function galleryItems(current) {
    const imgs = [...list.querySelectorAll('.att-media img')].filter((i) => !i.closest('.spoiler-att.hidden'));
    const items = imgs.map((i) => i._item).filter(Boolean);
    return { items, cur: items.find((x) => x === current) || current };
  }

  function renderAttachment(att, m) {
    const box = h('div', { class: `att att-${att.kind}`, dataset: { att: att.id } });
    const expired = files.isExpired(att);
    const previewable = att.mime === 'application/pdf' || TEXT_PREVIEW.test(att.mime || '') || !!langFromName(att.name);
    const meta = (onDevice) => h('div', { class: 'att-meta' },
      h('span', { class: 'ellipsis', title: att.name }, att.name),
      h('span', { class: 'muted' }, fmtBytes(att.size)),
      m.pending ? null : h('span', { class: `expiry${expired ? ' expired' : ''}`, title: att.expiresAt ? `다운로드 가능 기한: ${fmtFull(att.expiresAt)}` : '' },
        expired ? icon('lock', 12) : icon('clock', 12), expired ? (onDevice ? ' 만료 · 기기 사본 보기 전용' : ' 만료됨') : ` ${fmtRemain(att.expiresAt - Date.now())}`),
      !expired ? h('button', { class: 'icon-btn tiny', title: '다운로드', 'aria-label': `${att.name} 다운로드`, onclick: () => download(att) }, icon('download', 16)) : null);

    const isMedia = att.kind === 'image' || att.kind === 'video' || att.kind === 'audio';
    const emoji = { image: '🖼️', video: '🎞️', audio: '🎵', file: '' }[att.kind] || '';
    const fileCard = (onDevice) => h('div', { class: 'file-card' },
      icon(runnable(langFromName(att.name)) ? 'code' : 'file', 30, 'file-icon'),
      h('div', { class: 'file-info' },
        h('span', { class: 'file-name ellipsis', title: att.name }, emoji ? `${emoji} ${att.name}` : att.name),
        h('span', { class: 'muted small' }, fmtBytes(att.size),
          onDevice ? ' · 기기에 저장됨' : '',
          expired ? (onDevice ? ' · 만료되어 다시 내려받을 수 없음' : ' · 만료되어 볼 수 없음') : '',
          !expired && !onDevice && !data.isOnline ? ' · 서버에 연결되면 받을 수 있음' : '',
          !expired && !m.pending ? ` · ⏳ ${fmtRemain(att.expiresAt - Date.now())}` : '')),
      previewable && (onDevice || !expired) && !(expired && att.mime === 'application/pdf')
        ? h('button', { class: 'btn small secondary', title: '미리보기', onclick: () => filePreviewDialog(ctx, att, { onSendResult: sendResult(m) }) }, runnable(langFromName(att.name)) ? '보기 · 실행' : '미리보기')
        : null,
      !expired
        ? h('button', { class: 'icon-btn', title: '다운로드', 'aria-label': `${att.name} 다운로드`, onclick: () => download(att) }, icon('download'))
        : h('span', { class: 'dim', title: '유효기간 만료' }, icon('lock', 18)));

    const fill = async (force = false) => {
      let url = await files.localUrl(att);
      const onDevice = !!url;
      const auto = force || settings.autoloadMedia;
      if (!url && isMedia && auto && !expired && data.isOnline && (att.kind === 'image' || att.size <= AUTO_FETCH_BYTES || force)) {
        box.replaceChildren(h('div', { class: 'att-loading shimmer' }));
        try { url = await files.fetchToDevice(att, data); } catch { /* 아래에서 처리 */ }
      }
      if (url && isMedia) {
        let media;
        const item = { url, name: att.name, kind: att.kind, canDownload: !files.isExpired(att), onDownload: () => download(att) };
        if (att.kind === 'image') {
          media = h('img', {
            src: url, alt: att.name, loading: 'lazy', draggable: 'false', onload: () => keepBottom(),
            onclick: () => { const g = galleryItems(item); lightbox(g.cur, g.items.length ? g.items : null); },
          });
          media._item = item;
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
        box.replaceChildren(h('div', { class: 'att-placeholder' }, icon(att.kind === 'image' ? 'image' : 'play', 22),
          h('span', {}, `${att.kind === 'video' ? '동영상' : att.kind === 'audio' ? '오디오' : '이미지'} 불러오기 (${fmtBytes(att.size)})`),
          h('button', {
            class: 'btn small primary',
            onclick: async (e) => {
              e.currentTarget.disabled = true;
              try { await files.fetchToDevice(att, data); } catch (er) { toast(errorText(er), 'error'); }
              fill(true);
            },
          }, icon('play', 14), ' 불러오기')), meta(false));
        return;
      }
      box.replaceChildren(fileCard(onDevice));
    };
    box.append(h('div', { class: 'att-loading' }));
    fill();
    if (!att.spoiler) return box;
    const wrap = h('div', { class: 'spoiler-att hidden' }, box,
      h('button', { class: 'spoiler-cover', onclick: (e) => { wrap.classList.remove('hidden'); e.currentTarget.remove(); } }, '스포일러 · 눌러서 보기'));
    return wrap;
  }

  async function download(att) {
    try {
      await files.saveToDevice(att, data);
    } catch (e) {
      toast(errorText(e), 'error');
    }
  }

  data.on('progress', ({ msgId, attId, p }) => {
    const b = els.get(msgId)?.querySelector(`[data-att="${attId}"]`);
    if (!b) return;
    let pb = b.querySelector('.upload-progress');
    if (!pb) { pb = h('div', { class: 'upload-progress' }, h('span')); b.append(pb); }
    pb.firstChild.style.width = `${Math.round(p * 100)}%`;
  });

  // ───────── 목록 조작 ─────────
  const divider = (t) => h('div', { class: 'day-divider', role: 'separator' }, h('span', {}, fmtDate(t)));
  const newDivider = () => h('div', { class: 'new-divider', role: 'separator' }, h('span', {}, '새 메시지'));

  function renderAll({ preserve } = {}) {
    const oldH = scroller.scrollHeight;
    const oldTop = scroller.scrollTop;
    els.clear();
    const frag = document.createDocumentFragment();
    let prev = null;
    let newShown = false;
    if (!st.hasMore && st.messages.length) frag.append(roomIntro());
    for (const m of st.messages) {
      if (!prev || !sameDay(prev.createdAt, m.createdAt)) frag.append(divider(m.createdAt));
      if (!newShown && st.since && m.createdAt > st.since && m.authorId !== data.me.id) { frag.append(newDivider()); newShown = true; }
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
      h('div', { class: 'intro-icon' }, room?.emoji ? h('span', { class: 'intro-emoji' }, room.emoji) : icon('hash', 36)),
      h('h2', {}, `#${room?.name || ''}에 오신 것을 환영합니다!`),
      h('p', { class: 'muted' }, empty ? '첫 메시지를 보내 대화를 시작해 보세요.' : '이 채팅방의 시작입니다.'),
      empty ? h('p', { class: 'muted small' }, '팁: / 를 입력하면 명령어, : 로 이모지, @ 로 멤버를 부를 수 있어요. 코드 블록(```js … ```)은 ▶ 버튼으로 실행할 수 있습니다.') : null);
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
  ctx.on('rerender', () => { if (st.roomId) renderAll({ preserve: true }); });
  personal.on('cs.blocked', () => { revealed.clear(); if (st.roomId) renderAll({ preserve: true }); });

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
  const renderPinsSoon = debounce(renderPins, 400);
  data.on('message', (m) => { if (m.roomId === st.roomId) renderPinsSoon(); });

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
    if (st.editing) ta.value = drafts.get(st.roomId);
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

  async function addFiles(fl) {
    if (!data.can('sendMessage')) return;
    if (st.editing) cancelBar();
    let incoming = fl;
    if (settings.compressImages) {
      tray.hidden = false;
      tray.classList.add('busy');
      incoming = await Promise.all(incoming.map((f) => compressImage(f)));
      tray.classList.remove('busy');
    }
    for (const f of incoming) {
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
      const thumb = f.type.startsWith('image/') ? h('img', { src: URL.createObjectURL(f), alt: '' }) : icon(f.type.startsWith('video/') ? 'video' : f.type.startsWith('audio/') ? 'mic' : 'file', 26);
      const spoiler = st.spoilers.has(f);
      return h('div', { class: `tray-item${spoiler ? ' spoiler' : ''}`, title: f.name }, h('div', { class: 'tray-thumb' }, thumb),
        h('span', { class: 'tray-name ellipsis' }, f.name), h('span', { class: 'muted small' }, fmtBytes(f.size)),
        h('button', {
          class: `tray-spoiler${spoiler ? ' on' : ''}`, type: 'button', title: '스포일러로 가리기',
          onclick: () => { if (spoiler) st.spoilers.delete(f); else st.spoilers.add(f); renderTray(); },
        }, spoiler ? '🙈 스포일러' : '👁 스포일러'),
        h('button', { class: 'tray-remove', 'aria-label': `${f.name} 제거`, onclick: () => { st.files.splice(i, 1); st.spoilers.delete(f); renderTray(); } }, icon('x', 14)));
    }));
  }

  function insertText(t) {
    const s = ta.selectionStart ?? ta.value.length;
    const e = ta.selectionEnd ?? ta.value.length;
    ta.value = ta.value.slice(0, s) + t + ta.value.slice(e);
    ta.setSelectionRange(s + t.length, s + t.length);
    ta.focus();
    autosize();
    saveDraft();
  }

  function wrapSelection(mark) {
    const s = ta.selectionStart;
    const e = ta.selectionEnd;
    const sel = ta.value.slice(s, e);
    ta.value = `${ta.value.slice(0, s)}${mark}${sel}${mark}${ta.value.slice(e)}`;
    ta.setSelectionRange(s + mark.length, e + mark.length);
    autosize();
    saveDraft();
  }

  const saveDraft = () => { if (!st.editing && st.roomId) drafts.set(st.roomId, ta.value); };

  function clearComposer() {
    st.files = [];
    st.spoilers = new Set();
    st.replyTo = null;
    ta.value = '';
    drafts.set(st.roomId, '');
    renderTray();
    renderBar();
    autosize();
    hideSuggest();
  }

  async function send() {
    const text = ta.value;
    if (st.editing) {
      const m = st.editing;
      if (text.trim() === (m.content || '').trim()) return cancelBar();
      try {
        await data.editMessage(m.id, replaceShortcodes(text));
        cancelBar();
        ta.value = drafts.get(st.roomId);
        autosize();
      } catch (e) {
        toast(errorText(e), 'error');
      }
      return;
    }
    if (!text.trim() && !st.files.length) return;
    if (text.length > 4000) return toast('메시지는 4000자까지 보낼 수 있습니다.', 'warn');
    if (st.slowUntil > Date.now()) return toast(`슬로우 모드: ${Math.ceil((st.slowUntil - Date.now()) / 1000)}초 후에 보낼 수 있어요.`, 'warn');

    // 슬래시 명령어
    let payload = { content: replaceShortcodes(text), files: st.files, replyTo: st.replyTo || null, spoilers: st.files.map((f, i) => (st.spoilers.has(f) ? i : -1)).filter((i) => i >= 0) };
    if (text.trim().startsWith('/') && !st.files.length) {
      const r = runCommand(text.trim());
      if (r?.error) return toast(r.error, 'warn');
      if (r?.help) { clearComposer(); return commandsDialog(); }
      if (r?.remind) {
        reminders.add({ ...r.remind, roomId: st.roomId });
        clearComposer();
        return toast(`⏰ ${new Date(r.remind.at).toLocaleString('ko-KR', { hour: 'numeric', minute: '2-digit', month: 'short', day: 'numeric' })}에 알려드릴게요.`, 'success');
      }
      if (r?.profile) {
        clearComposer();
        return data.updateProfile(r.profile).then(() => toast('프로필을 바꿨습니다.', 'success'), (e) => toast(errorText(e), 'error'));
      }
      if (r?.topic !== undefined) {
        clearComposer();
        if (!data.can('manageNodes')) return toast(errorText({ code: 'forbidden' }), 'warn');
        return data.updateNode(st.roomId, { topic: r.topic }).then(() => toast('채팅방 설명을 바꿨습니다.', 'success'), (e) => toast(errorText(e), 'error'));
      }
      if (r?.send) {
        if (r.send.kind === 'poll' && !data.can('react')) return toast('게스트는 투표를 만들 수 없습니다.', 'warn');
        payload = { ...payload, ...r.send, files: [] };
      }
    }
    clearComposer();
    try {
      await data.sendMessage(st.roomId, payload);
      startSlowmode();
    } catch (e) {
      toast(errorText(e), 'error');
    }
  }

  // 슬로우 모드 카운트다운
  let slowTimer = null;
  function startSlowmode() {
    const room = data.nodes.get(st.roomId);
    if (!room?.slowmode || room.createdBy === data.me.id) return;
    st.slowUntil = Date.now() + room.slowmode * 1000;
    clearInterval(slowTimer);
    const tick = () => {
      const left = Math.ceil((st.slowUntil - Date.now()) / 1000);
      if (left <= 0) { slowBar.hidden = true; clearInterval(slowTimer); sendBtn.disabled = false; return; }
      slowBar.hidden = false;
      sendBtn.disabled = true;
      slowBar.replaceChildren(h('span', {}, `🐢 슬로우 모드 · ${left}초 후에 다시 보낼 수 있어요`));
    };
    tick();
    slowTimer = setInterval(tick, 500);
  }

  function autosize() {
    ta.style.height = 'auto';
    ta.style.height = `${Math.min(ta.scrollHeight, isMobile() ? 120 : 240)}px`;
    const n = ta.value.length;
    counter.hidden = n < 3500;
    counter.textContent = `${n} / 4000`;
    counter.classList.toggle('over', n > 4000);
  }

  // ───────── + 메뉴: 파일, 사진 찍기, 음성 메시지, 투표, 위치, 코드 ─────────
  function plusMenu(anchor) {
    openMenu(anchor, [
      { label: '파일 올리기', icon: 'clip', onClick: () => fileInput.click() },
      isTouch() ? { label: '사진·동영상 찍기', icon: 'camera', onClick: () => cameraInput.click() } : null,
      window.MediaRecorder ? { label: '음성 메시지 녹음', icon: 'mic', onClick: () => recordVoice() } : null,
      data.can('react') ? { label: '투표 만들기', icon: 'poll', onClick: () => pollDialog(ctx, st.roomId) } : null,
      navigator.geolocation ? { label: '내 위치 보내기', icon: 'pinMap', onClick: () => shareLocation() } : null,
      { label: '코드 블록 넣기', icon: 'code', onClick: () => { insertText('```js\n\n```'); ta.setSelectionRange(ta.selectionStart - 4, ta.selectionStart - 4); } },
      'sep',
      { label: '명령어 보기', icon: 'info', onClick: () => commandsDialog() },
    ]);
  }

  function shareLocation() {
    toast('위치를 확인하는 중…');
    navigator.geolocation.getCurrentPosition((pos) => {
      const { latitude: lat, longitude: lon, accuracy } = pos.coords;
      const la = lat.toFixed(5);
      const lo = lon.toFixed(5);
      data.sendMessage(st.roomId, { content: `📍 내 위치 (오차 약 ${Math.round(accuracy)}m)\nhttps://www.openstreetmap.org/?mlat=${la}&mlon=${lo}#map=17/${la}/${lo}` })
        .catch((e) => toast(errorText(e), 'error'));
    }, () => toast('위치를 가져올 수 없습니다. 위치 권한을 확인하세요.', 'error'), { enableHighAccuracy: true, timeout: 15000 });
  }

  // 음성 메시지
  async function recordVoice() {
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      return toast('마이크를 사용할 수 없습니다.', 'error');
    }
    const type = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/ogg;codecs=opus', 'audio/webm'].find((t) => MediaRecorder.isTypeSupported?.(t)) || '';
    const rec = new MediaRecorder(stream, type ? { mimeType: type } : undefined);
    const chunks = [];
    let cancelled = false;
    const t0 = Date.now();
    const time = h('span', { class: 'rec-time' }, '0:00');
    const timer = setInterval(() => {
      const s = Math.floor((Date.now() - t0) / 1000);
      time.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
      if (s >= 300) rec.stop();
    }, 250);
    const ui = h('div', { class: 'rec-bar' }, h('span', { class: 'rec-dot' }), h('span', {}, '녹음 중'), time,
      h('button', { class: 'btn small ghost', onclick: () => { cancelled = true; rec.stop(); } }, '취소'),
      h('button', { class: 'btn small primary', onclick: () => rec.stop() }, icon('send', 14), ' 보내기'));
    box.hidden = true;
    box.after(ui);
    rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    rec.onstop = async () => {
      clearInterval(timer);
      stream.getTracks().forEach((t) => t.stop());
      ui.remove();
      box.hidden = false;
      if (cancelled || !chunks.length) return;
      const mime = rec.mimeType || chunks[0].type || 'audio/webm';
      const ext = mime.includes('mp4') ? 'm4a' : mime.includes('ogg') ? 'ogg' : 'webm';
      const d = new Date();
      const file = new File(chunks, `음성메시지-${d.getHours()}${String(d.getMinutes()).padStart(2, '0')}${String(d.getSeconds()).padStart(2, '0')}.${ext}`, { type: mime.split(';')[0] });
      try { await data.sendMessage(st.roomId, { files: [file], replyTo: st.replyTo }); st.replyTo = null; renderBar(); } catch (e) { toast(errorText(e), 'error'); }
    };
    rec.start(250);
  }

  // 음성으로 입력 (받아쓰기)
  let dictation = null;
  function toggleDictation() {
    if (dictation) { dictation.stop(); return; }
    const r = new SpeechRec();
    r.lang = 'ko-KR';
    r.interimResults = true;
    r.continuous = true;
    const base = ta.value ? `${ta.value} ` : '';
    let finalText = '';
    r.onresult = (e) => {
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        if (e.results[i].isFinal) finalText += e.results[i][0].transcript;
        else interim += e.results[i][0].transcript;
      }
      ta.value = base + finalText + interim;
      autosize();
    };
    r.onend = () => { dictation = null; micBtn.classList.remove('recording'); saveDraft(); };
    r.onerror = () => toast('음성 인식을 사용할 수 없습니다.', 'warn');
    r.start();
    dictation = r;
    micBtn.classList.add('recording');
    toast('말씀하세요… 다시 누르면 멈춥니다.');
  }

  // ───────── 자동완성: @멘션, :이모지, /명령어 ─────────
  let suggest = null;
  function updateSuggest() {
    const pos = ta.selectionStart;
    const before = ta.value.slice(0, pos);
    let m = before.match(/(^|\s)@([^\s@]{0,32})$/);
    if (m) {
      const q = m[2].toLowerCase();
      const items = [...data.users.values()].filter((u) => u.nickname?.toLowerCase().includes(q) && !blocked.has(u.id)).slice(0, 6)
        .map((u) => ({ key: u.id, view: [avatar(u, 22, { presence: data.presenceOf(u.id) }), h('span', {}, u.nickname), badge(u.provider)], insert: `@${u.nickname} ` }));
      ['everyone', 'here'].filter((x) => x.startsWith(q) && q).forEach((x) => items.push({ key: x, view: [h('strong', {}, `@${x}`), h('span', { class: 'muted small' }, '모두에게 알림')], insert: `@${x} ` }));
      return showSuggest('멤버', items, pos - m[2].length - 1, pos);
    }
    m = before.match(/(^|\s):([a-z0-9_+-]{2,30})$/i);
    if (m) {
      const items = searchEmoji(m[2]).map(([k, e]) => ({ key: k, view: [h('span', { class: 'sg-emoji' }, e), h('span', {}, `:${k}:`)], insert: `${e} ` }));
      return showSuggest('이모지', items, pos - m[2].length - 1, pos);
    }
    m = before.match(/^\/([a-z]*)$/i);
    if (m) {
      const q = m[1].toLowerCase();
      const items = COMMANDS.filter((c) => c.name.startsWith(q) && (!c.perm || data.can(c.perm)))
        .map((c) => ({ key: c.name, view: [h('strong', {}, `/${c.name}`), h('span', { class: 'muted small' }, ` ${c.args}`), h('span', { class: 'sg-desc' }, c.desc)], insert: `/${c.name} ` }));
      return showSuggest('명령어', items, 0, pos);
    }
    hideSuggest();
  }
  function showSuggest(label, items, start, end) {
    if (!items.length) return hideSuggest();
    suggest = { label, items, start, end, index: Math.min(suggest?.label === label ? suggest.index : 0, items.length - 1) };
    renderSuggest();
  }
  function renderSuggest() {
    suggestBox.hidden = false;
    suggestBox.replaceChildren(h('div', { class: 'mention-head muted small' }, suggest.label), ...suggest.items.map((it, i) => h('button', {
      class: `mention-opt${i === suggest.index ? ' active' : ''}`, role: 'option', type: 'button',
      onmousedown: (e) => { e.preventDefault(); pickSuggest(i); },
    }, ...it.view)));
  }
  function pickSuggest(i) {
    const it = suggest.items[i];
    const { start, end } = suggest;
    ta.value = `${ta.value.slice(0, start)}${it.insert}${ta.value.slice(end)}`;
    const c = start + it.insert.length;
    ta.setSelectionRange(c, c);
    hideSuggest();
    ta.focus();
    autosize();
    saveDraft();
  }
  function hideSuggest() {
    suggest = null;
    suggestBox.hidden = true;
  }

  const sendTyping = throttle(() => { if (settings.sendTyping) data.sendTyping(st.roomId); }, 3000);
  ta.addEventListener('input', () => {
    autosize();
    saveDraft();
    if (ta.value.trim() && !ta.value.startsWith('/')) sendTyping();
    updateSuggest();
  });
  ta.addEventListener('keydown', (e) => {
    if (suggest) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const n = suggest.items.length;
        suggest.index = (suggest.index + (e.key === 'ArrowDown' ? 1 : n - 1)) % n;
        return renderSuggest();
      }
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); return pickSuggest(suggest.index); }
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); return hideSuggest(); }
    }
    const mod = e.ctrlKey || e.metaKey;
    if (mod && !e.altKey) {
      const k = e.key.toLowerCase();
      if (k === 'b') { e.preventDefault(); return wrapSelection('**'); }
      if (k === 'i') { e.preventDefault(); return wrapSelection('*'); }
      if (k === 'u') { e.preventDefault(); return wrapSelection('__'); }
      if (k === 'e') { e.preventDefault(); return wrapSelection('`'); }
      if (k === 'x' && e.shiftKey) { e.preventDefault(); return wrapSelection('~~'); }
    }
    if (e.key === 'Escape') {
      if (st.editing || st.replyTo) { e.preventDefault(); e.stopPropagation(); return cancelBar(); }
      scrollToBottom(true);
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && settings.enterToSend && !isTouch()) {
      e.preventDefault();
      send();
    }
    if (e.key === 'ArrowUp' && !ta.value && !st.editing) {
      const mine = [...st.messages].reverse().find((m) => m.authorId === data.me.id && m.kind !== 'poll' && !m.failed && !(m.pending && data.isOnline));
      if (mine) { e.preventDefault(); startEdit(mine); }
    }
  });
  ta.addEventListener('blur', () => setTimeout(hideSuggest, 150));
  ta.addEventListener('paste', async (e) => {
    const fl = [...(e.clipboardData?.files || [])];
    if (fl.length) {
      e.preventDefault();
      addFiles(fl);
      return;
    }
    const txt = e.clipboardData?.getData('text') || '';
    if (txt.length > 2000 && !st.editing) {
      e.preventDefault();
      const asFile = await confirmDialog({ title: '긴 텍스트 붙여넣기', message: `${txt.length.toLocaleString()}자의 긴 텍스트입니다.\n파일(.txt)로 첨부할까요? (취소하면 그대로 붙여넣습니다)`, confirmText: '파일로 첨부' });
      if (asFile) addFiles([new File([txt], `붙여넣은-텍스트-${Date.now().toString(36)}.txt`, { type: 'text/plain' })]);
      else insertText(txt.slice(0, 4000 - ta.value.length));
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
    const names = [...typers.entries()].filter(([id, v]) => v.roomId === st.roomId && v.until > now && !blocked.has(id)).map(([id]) => data.user(id)?.nickname || '누군가');
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
    const readonly = room?.readonly && !data.can('manageNodes');
    const allowed = data.can('sendMessage') && !!room && !readonly;
    ta.disabled = !allowed;
    ta.placeholder = readonly ? '📢 공지 채널입니다. 로그인한 사용자만 글을 쓸 수 있어요.' : allowed ? `#${room?.name || ''}에 메시지 보내기` : '메시지를 보낼 수 없습니다';
    composer.classList.toggle('disabled', !allowed);
    plusBtn.disabled = !allowed;
    sendBtn.disabled = !allowed || st.slowUntil > Date.now();
  }

  return {
    el,
    get roomId() { return st.roomId; },
    async open(roomId, { since = 0 } = {}) {
      st.roomId = roomId;
      st.since = since;
      st.messages = [];
      st.files = [];
      st.spoilers = new Set();
      st.replyTo = null;
      st.editing = null;
      st.newCount = 0;
      st.slowUntil = 0;
      clearInterval(slowTimer);
      slowBar.hidden = true;
      renderTitle();
      renderBar();
      renderTray();
      renderComposerState();
      typers.clear();
      renderTyping();
      ta.value = drafts.get(roomId);
      autosize();
      list.replaceChildren(h('div', { class: 'list-loading' }, h('div', { class: 'spinner' })));
      await reload();
      if (!isTouch()) ta.focus({ preventScroll: true });
    },
    jumpTo,
    scrollToBottom,
    focus: () => ta.focus(),
    get atBottom() { return st.atBottom; },
    empty: () => emptyState('hash', '채팅방을 선택하세요', '왼쪽 목록에서 채팅방이나 통화방을 선택하세요.'),
  };
}
