import { config, setServerUrl } from '../config.js';
import * as api from '../api.js';
import { h, toast, fmtFull, fmtBytes, imageToAvatar } from '../util.js';
import { blobStats } from '../db.js';
import { PROVIDER_LABEL } from '../permissions.js';
import { openModal, confirmDialog, field, avatar, badge } from './common.js';
import { icon } from './icons.js';
import { errorText } from './errors.js';

const TYPE_LABEL = { text: '채팅방', voice: '통화방', folder: '폴더' };

function folderOptions(data, { exclude = [], selected = null } = {}) {
  const sel = h('select', { class: 'input' });
  sel.append(h('option', { value: '' }, '📁 최상위'));
  const walk = (parentId, depth) => {
    for (const n of data.children(parentId)) {
      if (n.type !== 'folder' || exclude.includes(n.id)) continue;
      sel.append(h('option', { value: n.id, selected: n.id === selected }, `${'   '.repeat(depth + 1)}📁 ${n.name}`));
      walk(n.id, depth + 1);
    }
  };
  walk(null, 0);
  return sel;
}

export function createNodeDialog(ctx, { parentId = null, type = 'text' } = {}) {
  const { data } = ctx;
  const name = h('input', { class: 'input', maxlength: '100', required: true, autofocus: true, placeholder: '새 채팅방' });
  const topic = h('input', { class: 'input', maxlength: '300', placeholder: '선택 사항' });
  const parent = folderOptions(data, { selected: parentId });
  const typeRow = h('div', { class: 'type-picker', role: 'radiogroup' });
  let current = type;
  const placeholders = { text: '새 채팅방', voice: '새 통화방', folder: '새 폴더' };
  const render = () => {
    typeRow.replaceChildren(...['text', 'voice', 'folder'].map((t) => h('button', {
      type: 'button', role: 'radio', 'aria-checked': String(t === current), class: `type-opt${t === current ? ' active' : ''}`,
      onclick: () => { current = t; name.placeholder = placeholders[t]; topicField.hidden = t === 'folder'; render(); },
    }, icon(t === 'text' ? 'hash' : t === 'voice' ? 'voice' : 'folder', 22),
    h('span', { class: 'type-name' }, TYPE_LABEL[t]),
    h('span', { class: 'type-desc' }, t === 'text' ? '메시지·이미지·파일' : t === 'voice' ? '음성·영상·화면 공유' : '방과 폴더를 묶기'))));
  };
  const topicField = field('설명', topic);
  render();
  name.placeholder = placeholders[current];
  topicField.hidden = current === 'folder';
  openModal({
    title: '만들기',
    body: [h('div', { class: 'field' }, h('span', { class: 'field-label' }, '종류'), typeRow), field('이름', name), topicField, field('위치', parent)],
    actions: [
      { label: '취소' },
      {
        label: '만들기', kind: 'primary', submit: true,
        onClick: async () => {
          const nm = name.value.trim() || placeholders[current];
          try {
            const node = await data.createNode({ type: current, name: nm, parentId: parent.value || null, topic: current === 'folder' ? '' : topic.value });
            if (node.type !== 'folder') ctx.openRoom(node.id);
            else ctx.expandFolder(node.id);
          } catch (e) {
            toast(errorText(e), 'error');
            return false;
          }
        },
      },
    ],
  });
}

export function editNodeDialog(ctx, node) {
  const name = h('input', { class: 'input', maxlength: '100', required: true, value: node.name, autofocus: true });
  const topic = h('input', { class: 'input', maxlength: '300', value: node.topic || '' });
  openModal({
    title: `${TYPE_LABEL[node.type]} 편집`,
    body: [field('이름', name), node.type !== 'folder' ? field('설명', topic) : null],
    actions: [
      { label: '취소' },
      {
        label: '저장', kind: 'primary', submit: true,
        onClick: async () => {
          if (!name.value.trim()) return false;
          try {
            await ctx.data.updateNode(node.id, { name: name.value.trim(), ...(node.type !== 'folder' ? { topic: topic.value.trim() } : {}) });
          } catch (e) {
            toast(errorText(e), 'error');
            return false;
          }
        },
      },
    ],
  });
}

export function moveNodeDialog(ctx, node) {
  const { data } = ctx;
  const parent = folderOptions(data, { exclude: data.descendants(node.id), selected: node.parentId });
  const sib = () => data.children(node.parentId ?? null);
  const i = sib().findIndex((n) => n.id === node.id);
  let m = null;
  const shift = (delta) => async () => {
    m?.close();
    const target = sib()[i + delta];
    if (target) await data.moveNode(node.id, target.id, delta < 0 ? 'before' : 'after').catch((er) => toast(errorText(er), 'error'));
  };
  m = openModal({
    title: `'${node.name}' 이동`,
    body: [
      field('폴더', parent, '폴더를 바꾸면 그 폴더의 맨 아래로 이동합니다. 데스크톱에서는 사이드바에서 끌어서 옮길 수도 있습니다.'),
      h('div', { class: 'row gap' },
        h('button', { class: 'btn secondary', type: 'button', disabled: i <= 0, onclick: shift(-1) }, '▲ 위로'),
        h('button', { class: 'btn secondary', type: 'button', disabled: i < 0 || i >= sib().length - 1, onclick: shift(1) }, '▼ 아래로')),
    ],
    actions: [
      { label: '취소' },
      {
        label: '이동', kind: 'primary', submit: true,
        onClick: async () => {
          const target = parent.value || null;
          if (target === (node.parentId ?? null)) return;
          try {
            await data.moveNode(node.id, target, 'inside');
            if (target) ctx.expandFolder(target);
          } catch (e) {
            toast(errorText(e), 'error');
            return false;
          }
        },
      },
    ],
  });
}

export async function deleteNodeDialog(ctx, node) {
  const { data } = ctx;
  const count = data.descendants(node.id).length - 1;
  const ok = await confirmDialog({
    title: `${TYPE_LABEL[node.type]} 삭제`,
    message: node.type === 'folder'
      ? `'${node.name}' 폴더와 안에 있는 ${count}개 항목(채팅 내용 포함)이 모두 삭제됩니다.\n이 작업은 되돌릴 수 없습니다.`
      : `'${node.name}'과(와) 모든 메시지가 삭제됩니다.\n이 작업은 되돌릴 수 없습니다.`,
    confirmText: '삭제',
    danger: true,
  });
  if (!ok) return;
  try {
    await data.deleteNode(node.id);
    toast('삭제했습니다.');
  } catch (e) {
    toast(errorText(e), 'error');
  }
}

// ───────── 프로필 ─────────
export function profileDialog(ctx, userId) {
  const { data } = ctx;
  const u = data.user(userId) || { id: userId, nickname: '알 수 없음', provider: 'guest' };
  const isMe = userId === data.me.id;
  const online = data.online.has(userId);
  openModal({
    title: '프로필',
    cls: 'profile-modal',
    body: h('div', { class: 'profile' },
      h('div', { class: 'profile-banner', style: { background: `linear-gradient(135deg, var(--accent), ${u.provider === 'guest' ? '#6d6f78' : u.provider === 'apple' ? '#111' : '#34a853'})` } }),
      h('div', { class: 'profile-avatar' }, avatar(u, 96, { online })),
      h('div', { class: 'profile-name' }, h('h3', {}, u.nickname), badge(u.provider, { full: true })),
      h('dl', { class: 'profile-info' },
        h('dt', {}, '로그인 방식'), h('dd', {}, `${PROVIDER_LABEL[u.provider] || u.provider}${u.provider === 'guest' ? ' (채팅만 가능)' : ''}`),
        h('dt', {}, '상태'), h('dd', {}, online ? '🟢 온라인' : u.lastSeen ? `마지막 접속 ${fmtFull(u.lastSeen)}` : '오프라인'),
        u.createdAt ? [h('dt', {}, '가입일'), h('dd', {}, fmtFull(u.createdAt))] : null)),
    actions: isMe ? [{ label: '프로필 편집', kind: 'primary', onClick: () => { setTimeout(() => editProfileDialog(ctx), 160); } }] : [{ label: '닫기' }],
  });
}

export function editProfileDialog(ctx) {
  const { data } = ctx;
  let newAvatar = data.me.avatar || null;
  const preview = h('div', { class: 'avatar-edit' });
  const renderPreview = () => preview.replaceChildren(avatar({ ...data.me, avatar: newAvatar }, 96));
  renderPreview();
  const fileInput = h('input', {
    type: 'file', accept: 'image/*', hidden: true,
    onchange: async () => {
      const f = fileInput.files[0];
      if (!f) return;
      try {
        newAvatar = await imageToAvatar(f);
        renderPreview();
      } catch {
        toast('이미지를 불러올 수 없습니다.', 'error');
      }
    },
  });
  const nick = h('input', { class: 'input', maxlength: '32', required: true, value: data.me.nickname, autofocus: true });
  openModal({
    title: '프로필 편집',
    body: [
      h('div', { class: 'avatar-row' }, preview,
        h('div', { class: 'col gap' },
          h('button', { class: 'btn secondary', type: 'button', onclick: () => fileInput.click() }, icon('image', 16), ' 사진 변경'),
          h('button', { class: 'btn ghost', type: 'button', onclick: () => { newAvatar = null; renderPreview(); } }, '사진 삭제')),
        fileInput),
      field('닉네임', nick),
      h('div', { class: 'row gap' }, h('span', { class: 'muted' }, '로그인 방식'), badge(data.me.provider, { full: true })),
    ],
    actions: [
      { label: '취소' },
      {
        label: '저장', kind: 'primary', submit: true,
        onClick: async () => {
          const n = nick.value.trim();
          if (!n) return false;
          try {
            await data.updateProfile({ nickname: n, avatar: newAvatar });
            toast('프로필을 저장했습니다.');
          } catch (e) {
            toast(errorText(e), 'error');
            return false;
          }
        },
      },
    ],
  });
}

// ───────── 설정 ─────────
const SETTINGS_KEY = 'cs.settings';
export const settings = (() => {
  let s = {};
  try { s = JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {}; } catch { /* noop */ }
  return { theme: 'dark', enterToSend: true, notify: false, compact: false, ...s };
})();
export function saveSettings(patch) {
  Object.assign(settings, patch);
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch { /* noop */ }
  applyTheme();
}
export function applyTheme() {
  const t = settings.theme === 'system' ? (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark') : settings.theme;
  document.documentElement.dataset.theme = t;
  document.documentElement.classList.toggle('compact', !!settings.compact);
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', t === 'light' ? '#ffffff' : '#1e1f22');
}

function serverSection(onSaved) {
  const url = h('input', { class: 'input', type: 'url', placeholder: 'https://your-server.example.com (비우면 로컬 모드)', value: config.serverUrl });
  const result = h('span', { class: 'field-hint' }, config.serverUrl ? '' : '현재: 로컬 모드 (이 기기에만 저장)');
  const test = async () => {
    const v = url.value.trim().replace(/\/+$/, '');
    if (!v) { result.textContent = '서버 없이 이 기기에만 저장합니다.'; return; }
    result.textContent = '확인 중…';
    try {
      const r = await api.health(v);
      result.textContent = r.db ? `✅ 연결 성공 (MongoDB 정상, 파일 보관 ${r.fileTtlHours}시간)` : '⚠️ 서버는 응답하지만 MongoDB에 연결되지 않았습니다. 로컬 저장으로 동작합니다.';
    } catch {
      result.textContent = '❌ 서버에 연결할 수 없습니다.';
    }
  };
  return h('section', { class: 'settings-section' },
    h('h3', {}, icon('cloud', 16), ' 서버 (MongoDB)'),
    field('서버 주소', url, 'Socket.IO + MongoDB 서버. 연결할 수 없으면 자동으로 기기에 저장하고, 다시 연결되면 동기화합니다.'),
    result,
    h('div', { class: 'row gap' },
      h('button', { class: 'btn secondary', type: 'button', onclick: test }, '연결 테스트'),
      h('button', {
        class: 'btn primary', type: 'button',
        onclick: () => {
          setServerUrl(url.value);
          toast(config.serverUrl ? '서버 주소를 저장했습니다.' : '로컬 모드로 전환했습니다.');
          onSaved?.();
        },
      }, '저장'),
      config.defaultServerUrl && config.defaultServerUrl !== config.serverUrl
        ? h('button', { class: 'btn ghost', type: 'button', onclick: () => { url.value = config.defaultServerUrl; } }, '기본값')
        : null));
}

export function openServerSettings() {
  openModal({ title: '서버 설정', body: serverSection(() => {}), actions: [{ label: '닫기' }] });
}

export function settingsDialog(ctx) {
  const { data } = ctx;
  const theme = h('select', { class: 'input', onchange: () => saveSettings({ theme: theme.value }) },
    [['dark', '다크'], ['light', '라이트'], ['system', '시스템 설정']].map(([v, l]) => h('option', { value: v, selected: settings.theme === v }, l)));
  const toggle = (key, label, onChange) => h('label', { class: 'switch-row' },
    h('span', {}, label),
    h('input', {
      type: 'checkbox', class: 'switch', checked: !!settings[key],
      onchange: async (e) => {
        const v = e.target.checked;
        if (onChange && (await onChange(v)) === false) { e.target.checked = !v; return; }
        saveSettings({ [key]: v });
      },
    }));
  const storage = h('span', { class: 'muted' }, '계산 중…');
  blobStats().then((s) => { storage.textContent = `기기에 저장된 파일 ${s.count}개 · ${fmtBytes(s.bytes)}`; });
  const st = data.status();
  const modeText = { local: '로컬 모드 — 서버 없이 이 기기에만 저장', online: '온라인 — 서버(MongoDB)와 실시간 동기화', offline: '오프라인 — 기기에 저장 중, 재연결 시 동기화', connecting: '연결 중…' }[st.mode];

  openModal({
    title: '설정',
    cls: 'settings-modal',
    body: [
      h('section', { class: 'settings-section' },
        h('h3', {}, icon('user', 16), ' 계정'),
        h('div', { class: 'account-row' }, avatar(data.me, 48),
          h('div', { class: 'col' }, h('strong', {}, data.me.nickname), badge(data.me.provider, { full: true })),
          h('button', { class: 'btn secondary', type: 'button', onclick: () => editProfileDialog(ctx) }, '프로필 편집'))),
      h('section', { class: 'settings-section' },
        h('h3', {}, icon('smile', 16), ' 화면 · 입력'),
        field('테마', theme),
        toggle('compact', '컴팩트 메시지 표시'),
        toggle('enterToSend', 'Enter로 전송 (Shift+Enter 줄바꿈)'),
        toggle('notify', '새 메시지 알림', async (v) => {
          if (!v) return true;
          if (!('Notification' in window)) { toast('이 브라우저는 알림을 지원하지 않습니다.', 'warn'); return false; }
          const p = await Notification.requestPermission();
          if (p !== 'granted') { toast('알림 권한이 거부되었습니다.', 'warn'); return false; }
          return true;
        })),
      h('section', { class: 'settings-section' },
        h('h3', {}, icon('device', 16), ' 상태 · 저장 공간'),
        h('p', {}, modeText),
        st.pendingOps ? h('p', { class: 'muted' }, `동기화 대기 중인 작업 ${st.pendingOps}개`) : null,
        h('p', { class: 'field-hint' }, `첨부파일은 업로드 후 ${Math.round(data.fileTtlMs / 3600_000)}시간 동안만 내려받을 수 있습니다. 기간이 지나면 이 기기에 저장된 사본만 볼 수 있고 다시 내려받을 수는 없습니다.`),
        storage,
        h('div', { class: 'row gap' },
          h('button', {
            class: 'btn danger-ghost', type: 'button',
            onclick: async () => {
              const ok = await confirmDialog({ title: '파일 캐시 비우기', message: '기기에 저장된 이미지·동영상·파일 사본을 삭제합니다.\n유효기간이 지난 파일은 다시 볼 수 없게 됩니다.', confirmText: '비우기', danger: true });
              if (!ok) return;
              const n = await data.clearFileCache();
              toast(`${n}개 파일을 삭제했습니다.`);
              storage.textContent = '기기에 저장된 파일 0개';
            },
          }, '파일 캐시 비우기'))),
      serverSection(() => data.connect()),
      h('section', { class: 'settings-section' },
        h('button', { class: 'btn danger', type: 'button', onclick: () => ctx.logout() }, icon('logout', 16), ' 로그아웃')),
    ],
    actions: [{ label: '닫기' }],
  });
}

// ───────── 이미지 크게 보기 ─────────
export function lightbox({ url, name, kind, canDownload, onDownload }) {
  const media = kind === 'video'
    ? h('video', { src: url, controls: true, autoplay: true, playsinline: true, controlslist: canDownload ? null : 'nodownload' })
    : h('img', { src: url, alt: name, draggable: 'false' });
  if (!canDownload) media.addEventListener('contextmenu', (e) => e.preventDefault());
  const back = h('div', { class: 'lightbox', role: 'dialog', 'aria-label': name, onclick: (e) => { if (e.target === back || e.target === stage) close(); } });
  const stage = h('div', { class: 'lightbox-stage' }, media);
  const close = () => { back.remove(); document.removeEventListener('keydown', onKey); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  back.append(
    h('div', { class: 'lightbox-bar' },
      h('span', { class: 'ellipsis' }, name),
      canDownload ? h('button', { class: 'icon-btn', title: '다운로드', onclick: onDownload }, icon('download')) : h('span', { class: 'muted small' }, icon('lock', 14), ' 만료됨 · 보기 전용'),
      h('button', { class: 'icon-btn', title: '닫기', onclick: close }, icon('x'))),
    stage,
  );
  document.body.append(back);
  document.addEventListener('keydown', onKey);
}
