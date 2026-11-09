import { config } from './config.js';
import { decodeJwt, uid, randomSecret, loadScript } from './util.js';

const KEY = 'cs.session';

export function loadSession() {
  try {
    const s = JSON.parse(localStorage.getItem(KEY));
    return s?.user?.id ? s : null;
  } catch {
    return null;
  }
}

export function saveSession(s) {
  try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* noop */ }
}

export function clearSession() {
  try { localStorage.removeItem(KEY); } catch { /* noop */ }
  try { window.google?.accounts?.id?.disableAutoSelect(); } catch { /* noop */ }
}

// ── Google (Google Identity Services) ──
export async function renderGoogleButton(el, onSession, onError) {
  if (!config.googleClientId) return false;
  try {
    await loadScript('https://accounts.google.com/gsi/client');
  } catch {
    onError?.('Google 로그인 스크립트를 불러오지 못했습니다.');
    return false;
  }
  window.google.accounts.id.initialize({
    client_id: config.googleClientId,
    callback: (r) => {
      const p = decodeJwt(r.credential);
      if (!p?.sub) return onError?.('Google 로그인 응답이 올바르지 않습니다.');
      onSession({
        user: {
          id: `google:${p.sub}`,
          provider: 'google',
          nickname: p.name || p.email?.split('@')[0] || 'Google 사용자',
          avatar: p.picture || null,
        },
        idToken: r.credential,
      });
    },
    ux_mode: 'popup',
    auto_select: false,
  });
  window.google.accounts.id.renderButton(el, {
    theme: 'filled_black', size: 'large', shape: 'pill', text: 'signin_with', locale: 'ko', width: Math.min(300, el.clientWidth || 300),
  });
  return true;
}

// ── Apple (Sign in with Apple JS) ──
export async function signInWithApple() {
  if (!config.appleClientId) throw new Error('Apple 로그인이 설정되지 않았습니다.');
  await loadScript('https://appleid.cdn-apple.com/appleauth/static/jsapi/appleid/1/ko_KR/appleid.auth.js');
  window.AppleID.auth.init({
    clientId: config.appleClientId,
    scope: 'name email',
    redirectURI: config.appleRedirectUri,
    state: uid(),
    usePopup: true,
  });
  let r;
  try {
    r = await window.AppleID.auth.signIn();
  } catch (e) {
    if (e?.error === 'popup_closed_by_user' || e?.error === 'user_cancelled_authorize') return null;
    throw new Error('Apple 로그인에 실패했습니다.');
  }
  const idToken = r.authorization?.id_token;
  const p = decodeJwt(idToken);
  if (!p?.sub) throw new Error('Apple 로그인 응답이 올바르지 않습니다.');
  const n = r.user?.name;
  const name = n ? [n.lastName, n.firstName].filter(Boolean).join(/[가-힣]/.test(`${n.lastName}${n.firstName}`) ? '' : ' ') : '';
  return {
    user: {
      id: `apple:${p.sub}`,
      provider: 'apple',
      nickname: name || (p.email ? String(p.email).split('@')[0] : '') || 'Apple 사용자',
      avatar: null,
    },
    idToken,
    appleName: name || undefined,
  };
}

// ── 게스트 ──
export function guestSession(nickname) {
  return {
    user: { id: `guest:${uid()}`, provider: 'guest', nickname, avatar: null },
    guestSecret: randomSecret(),
  };
}
