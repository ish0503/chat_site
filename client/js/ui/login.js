import { config } from '../config.js';
import { h, toast } from '../util.js';
import { renderGoogleButton, signInWithApple, guestSession } from '../auth.js';
import { icon } from './icons.js';
import { openServerSettings } from './dialogs.js';

/** 로그인 화면. onSession(session) 으로 결과를 돌려줍니다. */
export function renderLogin(root, onSession, { reason } = {}) {
  const googleSlot = h('div', { class: 'google-slot' });
  const nick = h('input', {
    class: 'input', placeholder: '게스트 닉네임', maxlength: '32', autocomplete: 'nickname', 'aria-label': '게스트 닉네임', required: true,
  });

  const appleBtn = h('button', {
    class: 'btn apple-btn', type: 'button', disabled: !config.appleClientId,
    onclick: async () => {
      try {
        appleBtn.disabled = true;
        const s = await signInWithApple();
        if (s) onSession(s);
      } catch (e) {
        toast(e.message, 'error');
      } finally {
        appleBtn.disabled = !config.appleClientId;
      }
    },
  }, icon('apple', 18), 'Apple로 로그인');

  const guestForm = h('form', {
    class: 'guest-form',
    onsubmit: (e) => {
      e.preventDefault();
      const n = nick.value.trim();
      if (!n) return nick.focus();
      onSession(guestSession(n.slice(0, 32)));
    },
  }, nick, h('button', { class: 'btn secondary', type: 'submit' }, '게스트로 입장'));

  const screen = h('div', { class: 'login-screen' },
    h('div', { class: 'login-card' },
      h('div', { class: 'login-logo' }, icon('hash', 34)),
      h('h1', {}, config.appName),
      h('p', { class: 'muted' }, '폴더로 정리하는 채팅방 · 통화방'),
      reason ? h('div', { class: 'notice warn' }, icon('alert', 16), reason) : null,
      h('div', { class: 'login-providers' },
        googleSlot,
        appleBtn,
        !config.googleClientId || !config.appleClientId
          ? h('p', { class: 'field-hint center' }, `${[!config.googleClientId && 'Google', !config.appleClientId && 'Apple'].filter(Boolean).join(', ')} 로그인은 env.js에 클라이언트 ID를 설정하면 활성화됩니다.`)
          : null),
      h('div', { class: 'divider' }, h('span', {}, '또는')),
      guestForm,
      h('p', { class: 'field-hint' }, '게스트는 채팅방에서 채팅만 할 수 있습니다. 방 만들기·삭제, 고정, 반응, 통화는 Google/Apple 로그인 사용자만 가능합니다.'),
      h('button', { class: 'link-btn', type: 'button', onclick: () => openServerSettings() }, icon('gear', 14), ' 서버 설정')));

  root.replaceChildren(screen);

  if (config.googleClientId) {
    renderGoogleButton(googleSlot, onSession, (m) => toast(m, 'error')).then((ok) => {
      if (!ok) googleSlot.replaceWith(disabledGoogle());
    });
  } else {
    googleSlot.replaceWith(disabledGoogle());
  }
}

const disabledGoogle = () => h('button', { class: 'btn google-btn', type: 'button', disabled: true }, icon('google', 18), 'Google로 로그인');
