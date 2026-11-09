// 앱 설치 (홈 화면 / 바탕화면 바로가기). 크롬·엣지·삼성 인터넷은 설치 창을 바로 띄우고,
// 그 밖의 브라우저(아이폰 사파리, 파이어폭스, 카카오톡·네이버 앱 안 브라우저 등)는 단계별 안내를 보여줍니다.
import { h, Emitter, toast } from './util.js';
import { openModal } from './ui/common.js';
import { icon } from './ui/icons.js';

export const install = new Emitter();
let deferred = null;

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault(); // 브라우저 기본 안내 대신 우리 버튼으로 설치
  deferred = e;
  install.emit('change');
});
window.addEventListener('appinstalled', () => {
  deferred = null;
  try { localStorage.setItem('cs.installed', '1'); } catch { /* noop */ }
  toast('📲 앱을 설치했습니다. 홈 화면(바탕화면)에서 열 수 있어요.', 'success', 5000);
  install.emit('change');
});

const ua = navigator.userAgent;
export const isStandalone = () => matchMedia('(display-mode: standalone)').matches || matchMedia('(display-mode: window-controls-overlay)').matches || navigator.standalone === true;
const isIOS = () => /iPhone|iPad|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isAndroid = () => /Android/.test(ua);
const inApp = () => (/KAKAOTALK/i.test(ua) ? 'kakao' : /NAVER\(inapp|NAVER/.test(ua) && !/Whale/.test(ua) ? 'naver' : /Instagram|FBAN|FBAV|Line\//.test(ua) ? 'sns' : null);
const browser = () => {
  if (/SamsungBrowser/.test(ua)) return 'samsung';
  if (/Whale/.test(ua)) return 'whale';
  if (/Edg\//.test(ua)) return 'edge';
  if (/CriOS/.test(ua)) return 'chrome-ios';
  if (/FxiOS/.test(ua)) return 'firefox-ios';
  if (/Firefox/.test(ua)) return 'firefox';
  if (/Chrome/.test(ua)) return 'chrome';
  if (/Safari/.test(ua)) return 'safari';
  return 'other';
};

/** 설치 버튼을 보여줄지 (이미 앱으로 실행 중이면 숨김) */
export const installable = () => !isStandalone();
/** 바로 설치 창을 띄울 수 있는지 */
export const canPrompt = () => !!deferred;

export async function openInstall() {
  if (isStandalone()) return toast('이미 앱으로 실행 중입니다. ✅');
  if (deferred) {
    const e = deferred;
    deferred = null;
    e.prompt();
    const { outcome } = await e.userChoice.catch(() => ({ outcome: 'dismissed' }));
    if (outcome !== 'accepted') toast('나중에 설정(⚙) → 앱으로 설치 에서 다시 설치할 수 있어요.');
    install.emit('change');
    return;
  }
  installGuide();
}

const step = (n, ...body) => h('li', { class: 'install-step' }, h('span', { class: 'step-no' }, String(n)), h('div', {}, ...body));
const key = (t) => h('span', { class: 'ui-key' }, t);

function externalLink() {
  const url = location.href.replace(/[?#].*$/, '');
  if (inApp() === 'kakao') return `kakaotalk://web/openExternal?url=${encodeURIComponent(url)}`;
  if (isAndroid()) return `intent://${url.replace(/^https?:\/\//, '')}#Intent;scheme=https;package=com.android.chrome;end`;
  return null;
}

/** 브라우저별 설치 방법 안내 */
export function installGuide() {
  const b = browser();
  const app = inApp();
  let title = '📲 앱으로 설치하기';
  let steps;
  let note = null;
  if (app) {
    title = '📲 기본 브라우저에서 열어 주세요';
    const link = externalLink();
    steps = [
      step(1, `${app === 'kakao' ? '카카오톡' : app === 'naver' ? '네이버 앱' : '이 앱'} 안의 브라우저에서는 설치할 수 없습니다.`),
      step(2, isIOS() ? ['오른쪽 아래(또는 위) ', key('⋯'), ' → ', key('Safari로 열기'), ' 를 누르세요.'] : ['오른쪽 위 ', key('⋮'), ' → ', key('다른 브라우저로 열기'), ' 를 누르세요.']),
      step(3, '열린 브라우저에서 다시 이 안내를 따라 설치하세요.'),
    ];
    if (link) note = h('a', { class: 'btn primary', href: link }, app === 'kakao' ? '기본 브라우저로 열기' : 'Chrome 으로 열기');
  } else if (isIOS()) {
    steps = b === 'safari'
      ? [
        step(1, ['화면 아래(아이패드는 위)의 ', key('공유 □↑'), ' 버튼을 누르세요.']),
        step(2, ['목록을 내려서 ', key('홈 화면에 추가 ⊞'), ' 를 누르세요.']),
        step(3, ['오른쪽 위 ', key('추가'), ' 를 누르면 홈 화면에 아이콘이 생깁니다.']),
      ]
      : [
        step(1, ['주소창 옆 ', key('공유 □↑'), ' 버튼을 누르세요. (iOS 16.4 이상)']),
        step(2, ['', key('홈 화면에 추가'), ' 를 누르세요. 메뉴에 없으면 Safari 에서 열어 설치하세요.']),
      ];
    note = h('p', { class: 'muted small' }, '홈 화면 아이콘으로 열면 주소창 없이 앱처럼 열리고, 알림 배지도 표시됩니다.');
  } else if (isAndroid()) {
    steps = b === 'samsung'
      ? [step(1, ['아래쪽 ', key('≡'), ' 메뉴를 누르세요.']), step(2, ['', key('현재 페이지 추가'), ' → ', key('홈 화면'), ' 을 누르세요.'])]
      : b === 'firefox'
        ? [step(1, ['오른쪽 위 ', key('⋮'), ' 메뉴를 누르세요.']), step(2, ['', key('설치'), ' 또는 ', key('홈 화면에 추가'), ' 를 누르세요.'])]
        : [step(1, ['오른쪽 위 ', key('⋮'), ' 메뉴를 누르세요.']), step(2, ['', key('앱 설치'), ' 또는 ', key('홈 화면에 추가'), ' 를 누르세요.']), step(3, ['', key('설치'), ' 를 누르면 앱 목록과 홈 화면에 아이콘이 생깁니다.'])];
  } else {
    steps = {
      chrome: [step(1, ['주소창 오른쪽의 ', key('설치 ⊕'), ' 아이콘을 누르세요.']), step(2, ['보이지 않으면 오른쪽 위 ', key('⋮'), ' → ', key('전송, 저장, 공유'), ' → ', key('페이지를 앱으로 설치'), ' (또는 ', key('바로가기 만들기'), ' → "창으로 열기" 체크)'])],
      edge: [step(1, ['주소창 오른쪽의 ', key('앱 설치 ⊞'), ' 아이콘을 누르세요.']), step(2, ['보이지 않으면 ', key('⋯'), ' → ', key('앱'), ' → ', key('이 사이트를 앱으로 설치'), ' 를 누르세요.'])],
      whale: [step(1, ['오른쪽 위 ', key('⋯'), ' 메뉴 → ', key('앱으로 설치'), ' 를 누르세요.'])],
      safari: [step(1, ['메뉴 막대의 ', key('파일'), ' → ', key('Dock에 추가'), ' 를 누르세요. (macOS Sonoma 이상)'])],
      firefox: [step(1, '파이어폭스(PC)는 앱 설치를 지원하지 않습니다.'), step(2, ['주소창 왼쪽의 ', key('🔒'), ' 아이콘을 바탕화면으로 끌어다 놓으면 바로가기가 생깁니다.']), step(3, '앱처럼 쓰려면 Chrome 이나 Edge 에서 설치하세요.')],
    }[b] || [step(1, '브라우저 메뉴에서 "앱 설치" 또는 "바로가기 만들기"를 찾아 주세요. Chrome 이나 Edge 를 권장합니다.')];
    note = h('p', { class: 'muted small' }, '설치하면 바탕화면·시작 메뉴·Dock 에서 별도 창으로 열리고, 작업 표시줄 아이콘에 안 읽은 메시지 수가 표시됩니다.');
  }
  openModal({
    title,
    cls: 'install-modal',
    body: [
      h('div', { class: 'install-hero' }, h('img', { src: 'icons/icon-192.png', alt: '', width: '64', height: '64' }),
        h('div', {}, h('strong', {}, 'Chat Site'), h('p', { class: 'muted small' }, '홈 화면·바탕화면에서 바로 열기 · 주소창 없는 전체 화면 · 알림 배지 · 오프라인에서도 열림'))),
      h('ol', { class: 'install-steps' }, steps),
      note,
    ],
    actions: [{ label: '닫기' }],
  });
}

/** 모바일에서 처음 몇 번 방문할 때 하단에 설치 권유 배너 */
export function installBanner(container) {
  const KEY = 'cs.installBannerDismissed';
  const bar = h('div', { class: 'install-banner', hidden: true },
    h('img', { src: 'icons/icon-192.png', alt: '', width: '36', height: '36' }),
    h('div', { class: 'grow' }, h('strong', {}, '앱으로 설치하기'), h('span', { class: 'muted small' }, '홈 화면에서 바로 열 수 있어요')),
    h('button', { class: 'btn small primary', onclick: () => openInstall() }, '설치'),
    h('button', {
      class: 'icon-btn tiny', 'aria-label': '닫기',
      onclick: () => { bar.hidden = true; try { localStorage.setItem(KEY, String(Date.now())); } catch { /* noop */ } },
    }, icon('x', 16)));
  const update = () => {
    let dismissed = 0;
    try { dismissed = Number(localStorage.getItem(KEY)) || 0; } catch { /* noop */ }
    const mobile = isIOS() || isAndroid();
    const recentlyDismissed = Date.now() - dismissed < 30 * 86400_000; // 닫으면 30일 동안 안 보임
    bar.hidden = !(mobile && !isStandalone() && !recentlyDismissed && (deferred || isIOS() || inApp()));
  };
  install.on('change', update);
  setTimeout(update, 1500);
  container.append(bar);
  return bar;
}
