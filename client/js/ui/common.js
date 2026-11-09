import { h, safeImageUrl, colorFor, isMobile, isTouch } from '../util.js';
import { PROVIDER_LABEL } from '../permissions.js';
import { icon } from './icons.js';

// ───────── 아바타 / 로그인 종류 배지 ─────────
export const PRESENCE_LABEL = {
  online: '🟢 온라인', idle: '🌙 자리 비움', dnd: '⛔ 방해 금지', invisible: '⚫ 오프라인으로 표시', offline: '⚫ 오프라인',
};

export function avatar(user, size = 40, { online, presence } = {}) {
  const pres = presence || (online === undefined ? undefined : online ? 'online' : 'offline');
  const url = safeImageUrl(user?.avatar);
  const name = user?.nickname || '?';
  const inner = url
    ? h('img', { src: url, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer', draggable: 'false' })
    : h('span', { class: 'avatar-initial', style: { background: colorFor(user?.id || name) } }, [...name][0]?.toUpperCase() || '?');
  return h('span', { class: 'avatar', style: { width: `${size}px`, height: `${size}px`, fontSize: `${Math.round(size * 0.42)}px` } },
    inner,
    pres ? h('span', { class: `presence p-${pres}${pres === 'online' ? ' on' : pres === 'offline' || pres === 'invisible' ? ' off' : ''}`, title: PRESENCE_LABEL[pres] || '' }) : null);
}

export function badge(provider, { full = false } = {}) {
  const label = PROVIDER_LABEL[provider] || provider;
  const ic = provider === 'google' ? icon('google', 12) : provider === 'apple' ? icon('apple', 12) : icon('user', 12);
  return h('span', { class: `badge badge-${provider}${full ? ' badge-full' : ''}`, title: `${label} 로그인` }, ic, h('span', {}, full ? `${label} 로그인` : label));
}

// ───────── 모달 ─────────
const stack = [];
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && stack.length) {
    e.preventDefault();
    stack.at(-1).close();
  }
});

export function openModal({ title, body, actions = [], cls = '', onClose, dismissible = true }) {
  const close = () => {
    const i = stack.indexOf(api);
    if (i < 0) return;
    stack.splice(i, 1);
    back.classList.add('out');
    setTimeout(() => back.remove(), 150);
    onClose?.();
  };
  const footer = actions.length
    ? h('footer', { class: 'modal-actions' }, actions.map((a) => h('button', {
      class: `btn ${a.kind || 'secondary'}`, type: a.submit ? 'submit' : 'button', disabled: a.disabled,
      onclick: async (e) => {
        if (a.submit) return;
        e.preventDefault();
        const r = await a.onClick?.();
        if (r !== false) close();
      },
    }, a.label)))
    : null;
  const submit = actions.find((a) => a.submit);
  const box = h(submit ? 'form' : 'div', {
    class: `modal ${cls}`, role: 'dialog', 'aria-modal': 'true', 'aria-label': title,
    onsubmit: submit ? async (e) => {
      e.preventDefault();
      const r = await submit.onClick?.();
      if (r !== false) close();
    } : null,
  },
  h('header', { class: 'modal-head' },
    h('h2', {}, title),
    h('button', { class: 'icon-btn', type: 'button', 'aria-label': '닫기', onclick: close }, icon('x'))),
  h('div', { class: 'modal-body' }, body),
  footer);
  const back = h('div', { class: 'modal-backdrop', onmousedown: (e) => { if (dismissible && e.target === back) close(); } }, box);
  document.body.append(back);
  const api = { el: box, close };
  stack.push(api);
  setTimeout(() => (box.querySelector('[autofocus]') || box.querySelector('input,textarea,select'))?.focus(), 30);
  return api;
}

export function confirmDialog({ title, message, confirmText = '확인', danger = false }) {
  return new Promise((resolve) => {
    let ok = false;
    openModal({
      title,
      body: h('p', { class: 'muted pre' }, message),
      actions: [
        { label: '취소' },
        { label: confirmText, kind: danger ? 'danger' : 'primary', onClick: () => { ok = true; } },
      ],
      onClose: () => resolve(ok),
    });
  });
}

// ───────── 컨텍스트 메뉴 (모바일은 바텀시트) ─────────
let openMenuApi = null;

export function openMenu(anchor, items, { header } = {}) {
  openMenuApi?.close();
  const sheet = isMobile() || isTouch();
  const close = () => {
    if (openMenuApi !== api) return;
    openMenuApi = null;
    wrap.classList.add('out');
    setTimeout(() => wrap.remove(), 150);
    document.removeEventListener('keydown', onKey, true);
  };
  const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
  const list = h('div', { class: 'menu-list', role: 'menu' },
    header || null,
    items.filter(Boolean).map((it) => (it === 'sep'
      ? h('div', { class: 'menu-sep' })
      : h('button', {
        class: `menu-item${it.danger ? ' danger' : ''}`, role: 'menuitem', disabled: it.disabled, type: 'button',
        onclick: () => { close(); it.onClick?.(); },
      }, it.icon ? icon(it.icon, 18) : null, h('span', {}, it.label)))));
  const menu = h('div', { class: sheet ? 'sheet' : 'popover menu' }, sheet ? h('div', { class: 'sheet-grip' }) : null, list);
  const wrap = h('div', { class: sheet ? 'sheet-backdrop' : 'popover-layer', onmousedown: (e) => { if (e.target === wrap) close(); }, oncontextmenu: (e) => { e.preventDefault(); close(); } }, menu);
  document.body.append(wrap);
  if (!sheet) position(menu, anchor);
  document.addEventListener('keydown', onKey, true);
  const api = { close, el: menu };
  openMenuApi = api;
  return api;
}

export function closeMenu() {
  openMenuApi?.close();
}

function position(el, anchor) {
  let x;
  let y;
  if (anchor instanceof Event) {
    x = anchor.clientX;
    y = anchor.clientY;
  } else {
    const r = anchor.getBoundingClientRect();
    x = r.right;
    y = r.bottom + 4;
  }
  el.style.visibility = 'hidden';
  requestAnimationFrame(() => {
    const w = el.offsetWidth;
    const ht = el.offsetHeight;
    const left = Math.max(8, Math.min(x - (anchor instanceof Event ? 0 : w), innerWidth - w - 8));
    let top = y;
    if (top + ht > innerHeight - 8) top = Math.max(8, (anchor instanceof Event ? y : anchor.getBoundingClientRect().top - 4) - ht);
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
    el.style.visibility = '';
  });
}

// ───────── 이모지 선택기 ─────────
const EMOJI = {
  '자주': ['👍', '❤️', '😂', '😮', '😢', '🎉', '🔥', '👀', '✅', '🙏', '💯', '😍'],
  '표정': ['😀', '😃', '😄', '😁', '😆', '🥹', '😅', '🤣', '😊', '😇', '🙂', '😉', '😌', '😍', '🥰', '😘', '😋', '😛', '😜', '🤪', '🤨', '🧐', '🤓', '😎', '🥳', '😏', '😒', '😞', '😔', '😟', '😕', '🙁', '😣', '😖', '😫', '😩', '🥺', '😢', '😭', '😤', '😠', '😡', '🤯', '😳', '🥵', '🥶', '😱', '😨', '😰', '🤗', '🤔', '🤭', '🤫', '😶', '😐', '😑', '😬', '🙄', '😯', '😴', '🤤', '😵', '🤐', '🤢', '🤮', '🤧', '😷', '🤒', '🤕', '🤑', '🤠', '😈', '👻', '💀', '🤖', '👽', '💩'],
  '손': ['👋', '🤚', '✋', '🖖', '👌', '🤌', '✌️', '🤞', '🤟', '🤘', '🤙', '👈', '👉', '👆', '👇', '☝️', '👍', '👎', '✊', '👊', '👏', '🙌', '🫶', '👐', '🤝', '🙏', '💪', '✍️'],
  '사물': ['❤️', '🧡', '💛', '💚', '💙', '💜', '🖤', '🤍', '💔', '💕', '💖', '✨', '⭐', '🌟', '🔥', '💥', '💯', '🎉', '🎊', '🎁', '🏆', '⚽', '🎮', '🎧', '🎵', '📷', '💻', '📱', '☕', '🍺', '🍕', '🍔', '🍜', '🍰', '🍎', '🌈', '☀️', '🌙', '⚡', '❄️', '🌸', '🍀', '🐶', '🐱', '🐻', '🐼', '🦊', '🐸'],
  '기호': ['✅', '❌', '⭕', '❗', '❓', '⚠️', '🚫', '💤', '🆗', '🆕', '🔝', '➕', '➖', '➡️', '⬅️', '⬆️', '⬇️', '🔄', '📌', '📎', '🔒', '🔑', '💡', '📢', '🔔'],
};

const RECENT_KEY = 'cs.recentEmoji';
const recent = () => { try { return JSON.parse(localStorage.getItem(RECENT_KEY)) || []; } catch { return []; } };
const pushRecent = (e) => { try { localStorage.setItem(RECENT_KEY, JSON.stringify([e, ...recent().filter((x) => x !== e)].slice(0, 24))); } catch { /* noop */ } };

export function openEmojiPicker(anchor, onPick) {
  const cats = { ...(recent().length ? { '최근': recent() } : {}), ...EMOJI };
  const grid = h('div', { class: 'emoji-grid' });
  const tabs = h('div', { class: 'emoji-tabs' });
  const show = (name) => {
    grid.replaceChildren(...cats[name].map((e) => h('button', {
      class: 'emoji-btn', type: 'button', title: e,
      onclick: () => { pushRecent(e); onPick(e); api.close(); },
    }, e)));
    [...tabs.children].forEach((t) => t.classList.toggle('active', t.dataset.cat === name));
  };
  for (const name of Object.keys(cats)) {
    tabs.append(h('button', { class: 'emoji-tab', type: 'button', dataset: { cat: name }, onclick: () => show(name) }, name));
  }
  const api = openMenu(anchor, [], { header: h('div', { class: 'emoji-picker' }, tabs, grid) });
  api.el.classList.add('emoji-pop');
  show(Object.keys(cats)[0]);
  return api;
}

export const QUICK_REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🎉'];

export function field(label, input, hint) {
  return h('label', { class: 'field' }, h('span', { class: 'field-label' }, label), input, hint ? h('span', { class: 'field-hint' }, hint) : null);
}

export function emptyState(ic, title, text) {
  return h('div', { class: 'empty' }, icon(ic, 40), h('h3', {}, title), text ? h('p', { class: 'muted' }, text) : null);
}
