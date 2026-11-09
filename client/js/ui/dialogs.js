import { config, setServerUrl } from '../config.js';
import * as api from '../api.js';
import {
  h, toast, fmtFull, fmtBytes, fmtStamp, imageToAvatar, setClock24, safeImageUrl,
} from '../util.js';
import { blobStats } from '../db.js';
import { PROVIDER_LABEL } from '../permissions.js';
import { renderMarkdown } from '../markdown.js';
import { notes, blocked } from '../local.js';
import { COMMANDS } from '../commands.js';
import { runnable, langFromName } from '../runner.js';
import * as files from '../files.js';
import {
  openModal, confirmDialog, field, avatar, badge, openEmojiPicker, PRESENCE_LABEL,
} from './common.js';
import { icon } from './icons.js';
import { errorText } from './errors.js';
import { enhance } from './codeblock.js';

const TYPE_LABEL = { text: '채팅방', voice: '통화방', folder: '폴더' };
export const COLORS = ['#5865f2', '#3ba55c', '#faa61a', '#ed4245', '#eb459e', '#9b59b6', '#1abc9c', '#e67e22', '#80848e'];
const SLOWMODE = [[0, '끄기'], [5, '5초'], [10, '10초'], [30, '30초'], [60, '1분'], [300, '5분'], [900, '15분'], [3600, '1시간']];

function folderOptions(data, { exclude = [], selected = null } = {}) {
  const sel = h('select', { class: 'input' });
  sel.append(h('option', { value: '' }, '📁 최상위'));
  const walk = (parentId, depth) => {
    for (const n of data.children(parentId)) {
      if (n.type !== 'folder' || exclude.includes(n.id)) continue;
      sel.append(h('option', { value: n.id, selected: n.id === selected }, `${'   '.repeat(depth + 1)}${n.emoji || '📁'} ${n.name}`));
      walk(n.id, depth + 1);
    }
  };
  walk(null, 0);
  return sel;
}

/** 색상 고르기 (폴더 색, 프로필 배너) */
function colorPicker(value, onChange, { allowNone = true } = {}) {
  let cur = value || null;
  const row = h('div', { class: 'color-picker', role: 'radiogroup' });
  const render = () => row.replaceChildren(...[
    allowNone ? h('button', { type: 'button', class: `color-dot none${!cur ? ' active' : ''}`, title: '기본', onclick: () => { cur = null; onChange(cur); render(); } }, icon('x', 12)) : null,
    ...COLORS.map((c) => h('button', {
      type: 'button', class: `color-dot${cur === c ? ' active' : ''}`, style: { background: c }, title: c, 'aria-label': c,
      onclick: () => { cur = c; onChange(cur); render(); },
    })),
  ].filter(Boolean));
  render();
  return row;
}

/** 방 설정 필드: 이모지, 색상, 공지 전용, 슬로우 모드 */
function roomFields(type, node = {}) {
  const v = { emoji: node.emoji || '', color: node.color || null, readonly: !!node.readonly, slowmode: node.slowmode || 0 };
  const emoji = h('input', { class: 'input emoji-input', maxlength: '8', value: v.emoji, placeholder: '없음', oninput: () => { v.emoji = emoji.value.trim(); } });
  const emojiRow = h('div', { class: 'row gap' }, emoji,
    h('button', { type: 'button', class: 'btn secondary small', onclick: (e) => openEmojiPicker(e.currentTarget, (x) => { emoji.value = x; v.emoji = x; }) }, icon('smile', 16), ' 고르기'),
    h('button', { type: 'button', class: 'btn ghost small', onclick: () => { emoji.value = ''; v.emoji = ''; } }, '지우기'));
  const readonly = h('input', { type: 'checkbox', class: 'switch', checked: v.readonly, onchange: () => { v.readonly = readonly.checked; } });
  const slow = h('select', { class: 'input', onchange: () => { v.slowmode = Number(slow.value); } },
    SLOWMODE.map(([s, l]) => h('option', { value: s, selected: v.slowmode === s }, l)));
  const els = h('div', { class: 'room-fields' },
    field('아이콘 이모지', emojiRow),
    type === 'folder' ? field('폴더 색', colorPicker(v.color, (c) => { v.color = c; })) : null,
    type === 'text' ? h('label', { class: 'switch-row' }, h('span', {}, '📢 공지 전용 (게스트는 읽기만 가능)'), readonly) : null,
    type === 'text' ? field('슬로우 모드', slow, '한 사람이 메시지를 보낸 뒤 다시 보낼 때까지 기다리는 시간. 방을 만든 사람은 제외됩니다.') : null);
  return { els, values: () => ({ emoji: v.emoji, ...(type === 'folder' ? { color: v.color } : {}), ...(type === 'text' ? { readonly: v.readonly, slowmode: v.slowmode } : {}) }) };
}

export function createNodeDialog(ctx, { parentId = null, type = 'text' } = {}) {
  const { data } = ctx;
  const name = h('input', { class: 'input', maxlength: '100', required: true, autofocus: true, placeholder: '새 채팅방' });
  const topic = h('input', { class: 'input', maxlength: '300', placeholder: '선택 사항' });
  const parent = folderOptions(data, { selected: parentId });
  const typeRow = h('div', { class: 'type-picker', role: 'radiogroup' });
  const extraBox = h('div');
  let current = type;
  let extra = roomFields(current);
  const placeholders = { text: '새 채팅방', voice: '새 통화방', folder: '새 폴더' };
  const render = () => {
    typeRow.replaceChildren(...['text', 'voice', 'folder'].map((t) => h('button', {
      type: 'button', role: 'radio', 'aria-checked': String(t === current), class: `type-opt${t === current ? ' active' : ''}`,
      onclick: () => { current = t; name.placeholder = placeholders[t]; topicField.hidden = t === 'folder'; extra = roomFields(t); extraBox.replaceChildren(details()); render(); },
    }, icon(t === 'text' ? 'hash' : t === 'voice' ? 'voice' : 'folder', 22),
    h('span', { class: 'type-name' }, TYPE_LABEL[t]),
    h('span', { class: 'type-desc' }, t === 'text' ? '메시지·이미지·파일' : t === 'voice' ? '음성·영상·화면 공유' : '방과 폴더를 묶기'))));
  };
  const details = () => h('details', { class: 'more-opts' }, h('summary', {}, '추가 설정 (아이콘, 색, 공지 전용, 슬로우 모드)'), extra.els);
  const topicField = field('설명', topic);
  render();
  extraBox.append(details());
  name.placeholder = placeholders[current];
  topicField.hidden = current === 'folder';
  openModal({
    title: '만들기',
    body: [h('div', { class: 'field' }, h('span', { class: 'field-label' }, '종류'), typeRow), field('이름', name), topicField, field('위치', parent), extraBox],
    actions: [
      { label: '취소' },
      {
        label: '만들기', kind: 'primary', submit: true,
        onClick: async () => {
          const nm = name.value.trim() || placeholders[current];
          try {
            const node = await data.createNode({
              type: current, name: nm, parentId: parent.value || null, topic: current === 'folder' ? '' : topic.value, ...extra.values(),
            });
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
  const extra = roomFields(node.type, node);
  openModal({
    title: `${TYPE_LABEL[node.type]} 편집`,
    body: [field('이름', name), node.type !== 'folder' ? field('설명', topic) : null, extra.els],
    actions: [
      { label: '취소' },
      {
        label: '저장', kind: 'primary', submit: true,
        onClick: async () => {
          if (!name.value.trim()) return false;
          try {
            await ctx.data.updateNode(node.id, {
              name: name.value.trim(), ...(node.type !== 'folder' ? { topic: topic.value.trim() } : {}), ...extra.values(),
            });
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

/** 방 정보: 만든 사람, 날짜, 메시지 수, 설정 */
export function roomInfoDialog(ctx, node) {
  const { data } = ctx;
  const path = [];
  for (let p = data.nodes.get(node.parentId); p; p = data.nodes.get(p.parentId)) path.unshift(p.name);
  const creator = data.user(node.createdBy);
  const stats = h('dd', {}, '불러오는 중…');
  const statsDt = h('dt', {}, '메시지');
  if (node.type === 'text') {
    data.roomStats(node.id).then((s) => { stats.textContent = `${s.count.toLocaleString()}개 · 고정 ${s.pins}개 · 참여자 ${s.authors}명${s.local ? ' (이 기기 기준)' : ''}`; })
      .catch(() => { stats.textContent = '-'; });
  }
  openModal({
    title: `${node.emoji ? `${node.emoji} ` : ''}${node.name}`,
    body: h('dl', { class: 'profile-info info-list' },
      h('dt', {}, '종류'), h('dd', {}, TYPE_LABEL[node.type]),
      h('dt', {}, '위치'), h('dd', {}, path.length ? path.join(' / ') : '최상위'),
      node.topic ? [h('dt', {}, '설명'), h('dd', {}, node.topic)] : null,
      h('dt', {}, '만든 사람'), h('dd', {}, creator?.nickname || '알 수 없음'),
      h('dt', {}, '만든 날'), h('dd', {}, fmtFull(node.createdAt)),
      node.type === 'text' ? [statsDt, stats] : null,
      node.type === 'text' ? [h('dt', {}, '설정'), h('dd', {}, [node.readonly ? '📢 공지 전용' : '누구나 쓰기', node.slowmode ? `🐢 슬로우 모드 ${SLOWMODE.find(([s]) => s === node.slowmode)?.[1] || `${node.slowmode}초`}` : null].filter(Boolean).join(' · '))] : null,
      node.type === 'folder' ? [h('dt', {}, '안의 항목'), h('dd', {}, `${data.descendants(node.id).length - 1}개`)] : null),
    actions: [{ label: '닫기' }],
  });
}

/** 채팅 내보내기 (TXT / JSON) */
export function exportDialog(ctx, node) {
  const { data } = ctx;
  const status = h('p', { class: 'muted small' });
  const go = async (format) => {
    status.textContent = '메시지를 모으는 중…';
    const all = [];
    let before;
    try {
      for (let i = 0; i < 400; i++) {
        const res = await data.listMessages(node.id, { before });
        all.unshift(...res.messages.filter((m) => !all.some((x) => x.id === m.id)));
        status.textContent = `${all.length}개 모음…`;
        if (!res.hasMore || !res.messages.length) break;
        before = res.messages[0].createdAt;
      }
    } catch (e) {
      status.textContent = errorText(e);
      return;
    }
    const name = (m) => data.user(m.authorId)?.nickname || m.author?.nickname || '알 수 없음';
    let blob;
    if (format === 'json') {
      blob = new Blob([JSON.stringify({ room: { id: node.id, name: node.name, topic: node.topic }, exportedAt: Date.now(), messages: all.map((m) => ({ ...m, authorName: name(m) })) }, null, 2)], { type: 'application/json' });
    } else {
      const pad = (n) => String(n).padStart(2, '0');
      const ts = (t) => { const d = new Date(t); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`; };
      const lines = all.map((m) => {
        const body = m.kind === 'poll' ? `[투표] ${m.content} — ${m.poll.options.map((o) => `${o.text}(${o.votes.length})`).join(', ')}` : m.kind === 'me' ? `* ${m.content}` : m.content;
        const atts = m.attachments?.length ? ` [첨부: ${m.attachments.map((a) => a.name).join(', ')}]` : '';
        return `[${ts(m.createdAt)}] ${name(m)}: ${body}${atts}`;
      });
      blob = new Blob([`# ${node.name}\n# 내보낸 날짜: ${ts(Date.now())} · 메시지 ${all.length}개\n\n${lines.join('\n')}\n`], { type: 'text/plain;charset=utf-8' });
    }
    const a = h('a', { href: URL.createObjectURL(blob), download: `${node.name}-${new Date().toISOString().slice(0, 10)}.${format === 'json' ? 'json' : 'txt'}` });
    document.body.append(a);
    a.click();
    a.remove();
    status.textContent = `✅ 메시지 ${all.length}개를 내보냈습니다.`;
  };
  openModal({
    title: `'${node.name}' 내보내기`,
    body: [
      h('p', { class: 'muted' }, '이 채팅방의 모든 메시지를 파일로 저장합니다. 첨부파일은 이름만 포함됩니다.'),
      h('div', { class: 'row gap' },
        h('button', { class: 'btn primary', type: 'button', onclick: () => go('txt') }, icon('file', 16), ' 텍스트 (.txt)'),
        h('button', { class: 'btn secondary', type: 'button', onclick: () => go('json') }, icon('file', 16), ' JSON (.json)')),
      status,
    ],
    actions: [{ label: '닫기' }],
  });
}

// ───────── 메시지 관련 ─────────
export function editHistoryDialog(ctx, m) {
  const versions = [...(m.editHistory || []), { content: m.content, at: m.editedAt, current: true }].reverse();
  openModal({
    title: '수정 기록',
    body: h('div', { class: 'history' }, versions.map((v) => h('div', { class: `history-item${v.current ? ' current' : ''}` },
      h('div', { class: 'muted small' }, v.current ? `현재 · ${fmtStamp(v.at)}` : fmtStamp(v.at)),
      h('div', { class: 'msg-text', html: renderMarkdown(v.content || '', { me: ctx.data.me }) })))),
    actions: [{ label: '닫기' }],
  });
}

export function forwardDialog(ctx, m) {
  const { data } = ctx;
  const q = h('input', { class: 'input', type: 'search', placeholder: '채팅방 찾기', autofocus: true });
  const list = h('div', { class: 'qs-results' });
  const pathOf = (n) => { const p = []; for (let c = data.nodes.get(n.parentId); c; c = data.nodes.get(c.parentId)) p.unshift(c.name); return p.join(' / '); };
  let modal = null;
  const render = () => {
    const s = q.value.trim().toLowerCase();
    const rooms = [...data.nodes.values()].filter((n) => n.type === 'text' && n.name.toLowerCase().includes(s) && !(n.readonly && !data.can('manageNodes')));
    list.replaceChildren(...rooms.map((n) => h('button', {
      class: 'qs-item', type: 'button',
      onclick: async () => {
        modal.close();
        try {
          await data.sendMessage(n.id, { forward: m });
          toast(`#${n.name}(으)로 전달했습니다.`, 'success');
        } catch (e) {
          toast(errorText(e), 'error');
        }
      },
    }, n.emoji ? h('span', {}, n.emoji) : icon('hash', 16), h('span', {}, n.name), h('span', { class: 'muted small' }, pathOf(n)))));
    if (!rooms.length) list.append(h('p', { class: 'muted small pad' }, '전달할 수 있는 채팅방이 없습니다.'));
  };
  q.addEventListener('input', render);
  modal = openModal({
    title: '메시지 전달',
    cls: 'qs-modal',
    body: [h('div', { class: 'forward-preview muted small' }, (m.content || '').slice(0, 120) || `📎 첨부 ${m.attachments?.length || 0}개`), q, list],
  });
  render();
}

export function pollDialog(ctx, roomId) {
  const { data } = ctx;
  const question = h('input', { class: 'input', maxlength: '300', placeholder: '무엇을 물어볼까요?', required: true, autofocus: true });
  const opts = h('div', { class: 'poll-opts' });
  const multi = h('input', { type: 'checkbox', class: 'switch' });
  const addOpt = (v = '') => {
    if (opts.children.length >= 10) return toast('선택지는 10개까지 만들 수 있습니다.', 'warn');
    const row = h('div', { class: 'poll-opt-row' },
      h('input', { class: 'input', maxlength: '100', value: v, placeholder: `선택 ${opts.children.length + 1}` }),
      h('button', { type: 'button', class: 'icon-btn tiny', 'aria-label': '선택지 삭제', onclick: () => { if (opts.children.length > 2) row.remove(); } }, icon('x', 14)));
    opts.append(row);
    return row;
  };
  addOpt();
  addOpt();
  openModal({
    title: '📊 투표 만들기',
    body: [
      field('질문', question),
      h('div', { class: 'field' }, h('span', { class: 'field-label' }, '선택지'), opts,
        h('button', { type: 'button', class: 'btn ghost small', onclick: () => addOpt()?.querySelector('input').focus() }, icon('plus', 14), ' 선택지 추가')),
      h('label', { class: 'switch-row' }, h('span', {}, '여러 개 선택 허용'), multi),
    ],
    actions: [
      { label: '취소' },
      {
        label: '올리기', kind: 'primary', submit: true,
        onClick: async () => {
          const options = [...opts.querySelectorAll('input')].map((i) => i.value.trim()).filter(Boolean);
          if (!question.value.trim()) return false;
          if (options.length < 2) { toast('선택지를 2개 이상 입력하세요.', 'warn'); return false; }
          try {
            await data.sendMessage(roomId, { content: question.value, kind: 'poll', poll: { options, multi: multi.checked } });
          } catch (e) {
            toast(errorText(e), 'error');
            return false;
          }
        },
      },
    ],
  });
}

/** 텍스트·코드 파일 / PDF 미리보기 */
export async function filePreviewDialog(ctx, att, { onSendResult } = {}) {
  const expired = files.isExpired(att);
  let url = await files.localUrl(att);
  if (!url && !expired) {
    try { url = await files.fetchToDevice(att, ctx.data); } catch (e) { return toast(errorText(e), 'error'); }
  }
  if (!url) return toast('기기에 저장된 사본이 없고 유효기간이 지나 볼 수 없습니다.', 'warn');
  if (att.mime === 'application/pdf') {
    if (expired) return toast('만료된 PDF 는 미리보기를 지원하지 않습니다.', 'warn');
    openModal({ title: att.name, cls: 'preview-modal', body: h('iframe', { class: 'pdf-frame', src: url, title: att.name }), actions: [{ label: '닫기' }] });
    return;
  }
  const blob = await (await fetch(url)).blob();
  const text = await blob.slice(0, 512 * 1024).text();
  const lang = langFromName(att.name) || '';
  const pre = h('pre', { class: 'md-pre' }, h('code', { dataset: lang ? { lang } : {} }, text));
  const body = h('div', { class: 'file-preview' }, blob.size > 512 * 1024 ? h('p', { class: 'muted small' }, '앞부분 512KB만 표시합니다.') : null, pre);
  openModal({ title: att.name, cls: 'preview-modal', body, actions: [{ label: '닫기' }] });
  enhance(body, { onSendResult });
  if (runnable(lang)) pre.querySelector('.code-btn.run')?.classList.add('pulse');
}

// ───────── 프로필 ─────────
export function profileDialog(ctx, userId) {
  const { data } = ctx;
  const u = data.user(userId) || { id: userId, nickname: '알 수 없음', provider: 'guest' };
  const isMe = userId === data.me.id;
  const pres = data.presenceOf(userId);
  const note = h('textarea', { class: 'input note-input', rows: '2', maxlength: '500', placeholder: '이 사람에 대한 메모 (나만 볼 수 있음)' }, notes.get(userId));
  note.addEventListener('change', () => notes.set(userId, note.value));
  const isBlocked = blocked.has(userId);
  const bannerColor = safeColor(u.banner) || null;
  let modal = null;
  modal = openModal({
    title: '프로필',
    cls: 'profile-modal',
    body: h('div', { class: 'profile' },
      h('div', { class: 'profile-banner', style: { background: bannerColor || `linear-gradient(135deg, var(--accent), ${u.provider === 'guest' ? '#6d6f78' : u.provider === 'apple' ? '#111' : '#34a853'})` } }),
      h('div', { class: 'profile-avatar' }, avatar(u, 96, { presence: pres })),
      h('div', { class: 'profile-name' }, h('h3', {}, u.nickname), badge(u.provider, { full: true })),
      u.status ? h('p', { class: 'profile-status' }, `💬 ${u.status}`) : null,
      h('dl', { class: 'profile-info' },
        u.bio ? [h('dt', {}, '소개'), h('dd', { class: 'pre' }, u.bio)] : null,
        h('dt', {}, '로그인 방식'), h('dd', {}, `${PROVIDER_LABEL[u.provider] || u.provider}${u.provider === 'guest' ? ' (채팅만 가능)' : ''}`),
        h('dt', {}, '상태'), h('dd', {}, pres !== 'offline' ? PRESENCE_LABEL[pres] : u.lastSeen ? `마지막 접속 ${fmtFull(u.lastSeen)}` : '오프라인'),
        u.createdAt ? [h('dt', {}, '가입일'), h('dd', {}, fmtFull(u.createdAt))] : null),
      !isMe ? h('div', { class: 'profile-extra' },
        field('메모', note),
        h('div', { class: 'row gap' },
          h('button', { class: 'btn secondary small', type: 'button', onclick: () => { modal.close(); ctx.searchFrom(u); } }, icon('search', 14), ' 이 사람의 메시지'),
          h('button', {
            class: `btn small ${isBlocked ? 'secondary' : 'danger-ghost'}`, type: 'button',
            onclick: () => { const b = blocked.toggle(userId); toast(b ? `${u.nickname}님을 차단했습니다. 메시지가 숨겨집니다.` : '차단을 해제했습니다.'); modal.close(); },
          }, isBlocked ? '차단 해제' : '차단'))) : null),
    actions: isMe ? [{ label: '프로필 편집', kind: 'primary', onClick: () => { setTimeout(() => editProfileDialog(ctx), 160); } }] : [{ label: '닫기' }],
  });
}

const safeColor = (c) => (/^#[0-9a-fA-F]{6}$/.test(c || '') ? c : null);

export function editProfileDialog(ctx) {
  const { data } = ctx;
  let newAvatar = data.me.avatar || null;
  let banner = safeColor(data.me.banner);
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
  const status = h('input', { class: 'input', maxlength: '80', value: data.me.status || '', placeholder: '예: 공부 중 📚' });
  const bio = h('textarea', { class: 'input', rows: '3', maxlength: '300', placeholder: '자기소개 (300자)' }, data.me.bio || '');
  openModal({
    title: '프로필 편집',
    body: [
      h('div', { class: 'avatar-row' }, preview,
        h('div', { class: 'col gap' },
          h('button', { class: 'btn secondary', type: 'button', onclick: () => fileInput.click() }, icon('image', 16), ' 사진 변경'),
          h('button', { class: 'btn ghost', type: 'button', onclick: () => { newAvatar = null; renderPreview(); } }, '사진 삭제')),
        fileInput),
      field('닉네임', nick),
      field('상태 메시지', status),
      field('자기소개', bio),
      field('배너 색', colorPicker(banner, (c) => { banner = c; })),
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
            await data.updateProfile({
              nickname: n, avatar: newAvatar, status: status.value.trim(), bio: bio.value.trim(), banner,
            });
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
export const ACCENTS = {
  blurple: '#5865f2', green: '#23a559', pink: '#eb459e', orange: '#e67e22', red: '#ed4245', teal: '#1abc9c', purple: '#9b59b6',
};
const ACCENT_LABEL = { blurple: '블루퍼플', green: '초록', pink: '분홍', orange: '주황', red: '빨강', teal: '청록', purple: '보라' };
const FONT_SIZES = { small: 14, normal: 15, large: 17, xlarge: 19 };
export const settings = (() => {
  let s = {};
  try { s = JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {}; } catch { /* noop */ }
  return {
    theme: 'dark', enterToSend: true, notify: false, compact: false, compressImages: true,
    fontSize: 'normal', accent: 'blurple', clock24: false, reduceMotion: false, autoloadMedia: true, embeds: true,
    filterWords: '', keywords: '', sound: true, vibrate: true, notifyPreview: true, notifyMode: 'all', sendTyping: true,
    callSounds: true, ptt: false, ...s,
  };
})();
export const listSetting = (k) => (settings[k] || '').split(',').map((x) => x.trim()).filter(Boolean);
export function saveSettings(patch) {
  Object.assign(settings, patch);
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch { /* noop */ }
  applyTheme();
  settingsChanged.forEach((fn) => fn(patch));
}
export const settingsChanged = new Set();
export function applyTheme() {
  const t = settings.theme === 'system' ? (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark') : settings.theme;
  const root = document.documentElement;
  root.dataset.theme = t;
  root.classList.toggle('compact', !!settings.compact);
  root.classList.toggle('reduce-motion', !!settings.reduceMotion);
  const accent = ACCENTS[settings.accent] || ACCENTS.blurple;
  root.style.setProperty('--accent', accent);
  root.style.setProperty('--accent-soft', `${accent}2e`);
  root.style.setProperty('--msg-size', `${FONT_SIZES[settings.fontSize] || 15}px`);
  setClock24(!!settings.clock24);
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
      const r = await api.health(/^https?:\/\//.test(v) ? v : `https://${v}`);
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

let installPrompt = null;
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installPrompt = e; });

export function settingsDialog(ctx) {
  const { data } = ctx;
  const select = (key, options, onChange) => h('select', { class: 'input', onchange: (e) => { saveSettings({ [key]: e.target.value }); onChange?.(e.target.value); } },
    options.map(([v, l]) => h('option', { value: v, selected: settings[key] === v }, l)));
  const text = (key, placeholder) => h('input', { class: 'input', value: settings[key] || '', placeholder, onchange: (e) => saveSettings({ [key]: e.target.value }) });
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
  const section = (ic, title, ...kids) => h('section', { class: 'settings-section' }, h('h3', {}, icon(ic, 16), ` ${title}`), ...kids);
  const storage = h('span', { class: 'muted' }, '계산 중…');
  blobStats().then((s) => { storage.textContent = `기기에 저장된 파일 ${s.count}개 · ${fmtBytes(s.bytes)}`; });
  const connInfo = h('p', { class: 'muted small' });
  if (data.isOnline) {
    connInfo.textContent = '연결 속도 측정 중…';
    data.diagnose().then((d) => {
      if (!d) { connInfo.textContent = ''; return; }
      const tips = [];
      if (d.transport !== 'websocket') tips.push('WebSocket 을 쓸 수 없어 느린 방식(polling)으로 연결되어 있습니다. 서버 호스팅의 WebSocket 지원을 확인하세요.');
      if (d.dbMs > 60) tips.push('서버와 MongoDB 사이가 느립니다. 서버와 Atlas 클러스터를 같은 지역(리전)에 두면 빨라집니다.');
      if (d.rtt > 300) tips.push('이 기기와 서버 사이가 느립니다. 사용자와 가까운 지역에 서버를 두면 빨라집니다.');
      connInfo.replaceChildren(
        h('span', {}, `연결 방식 ${d.transport === 'websocket' ? 'WebSocket' : 'HTTP polling'} · 서버 응답 ${d.rtt}ms${d.dbMs != null ? ` · 서버↔MongoDB ${d.dbMs}ms` : ''}`),
        ...tips.map((t) => h('span', { class: 'warn-text' }, `⚠️ ${t}`)),
      );
    });
  }
  const st = data.status();
  const modeText = { local: '로컬 모드 — 서버 없이 이 기기에만 저장', online: '온라인 — 서버(MongoDB)와 실시간 동기화', offline: '오프라인 — 기기에 저장 중, 재연결 시 동기화', connecting: '연결 중…' }[st.mode];
  const blockedList = blocked.list();

  openModal({
    title: '설정',
    cls: 'settings-modal',
    body: [
      section('user', '계정',
        h('div', { class: 'account-row' }, avatar(data.me, 48),
          h('div', { class: 'col' }, h('strong', {}, data.me.nickname), badge(data.me.provider, { full: true })),
          h('button', { class: 'btn secondary', type: 'button', onclick: () => editProfileDialog(ctx) }, '프로필 편집'))),
      section('smile', '화면',
        field('테마', select('theme', [['dark', '다크'], ['light', '라이트'], ['system', '시스템 설정']])),
        field('강조 색', select('accent', Object.keys(ACCENTS).map((k) => [k, ACCENT_LABEL[k]]))),
        field('글자 크기', select('fontSize', [['small', '작게'], ['normal', '보통'], ['large', '크게'], ['xlarge', '아주 크게']])),
        toggle('compact', '컴팩트 메시지 표시'),
        toggle('clock24', '24시간제 시각'),
        toggle('reduceMotion', '애니메이션 줄이기')),
      section('edit', '채팅',
        toggle('enterToSend', 'Enter로 전송 (Shift+Enter 줄바꿈)'),
        toggle('compressImages', '사진 보낼 때 용량 줄이기 (더 빠르게 전송)'),
        toggle('autoloadMedia', '이미지·동영상 자동으로 불러오기 (끄면 데이터 절약)'),
        toggle('embeds', '링크 미리보기 (YouTube, 이미지 링크)'),
        toggle('sendTyping', '내가 입력 중임을 다른 사람에게 표시'),
        field('단어 필터', text('filterWords', '쉼표로 구분, 예: 욕설1, 욕설2'), '이 단어들은 ●●● 로 가려서 보여줍니다 (나에게만 적용).')),
      section('bell', '알림',
        toggle('notify', '데스크톱 알림', async (v) => {
          if (!v) return true;
          if (!('Notification' in window)) { toast('이 브라우저는 알림을 지원하지 않습니다.', 'warn'); return false; }
          const p = await Notification.requestPermission();
          if (p !== 'granted') { toast('알림 권한이 거부되었습니다.', 'warn'); return false; }
          return true;
        }),
        field('알림 받을 메시지', select('notifyMode', [['all', '모든 메시지'], ['mentions', '멘션과 키워드만']])),
        toggle('notifyPreview', '알림에 메시지 내용 보이기'),
        toggle('sound', '새 메시지 효과음'),
        toggle('vibrate', '진동 (모바일)'),
        field('키워드 알림', text('keywords', '쉼표로 구분, 예: 회의, 마감'), '이 단어가 들어간 메시지는 멘션처럼 강조하고 알려줍니다.'),
        h('p', { class: 'field-hint' }, '방해 금지 상태에서는 알림과 효과음이 울리지 않습니다. 방마다 알림은 사이드바의 방 메뉴에서 바꿀 수 있습니다.')),
      section('voice', '통화',
        toggle('callSounds', '참가자 입장·퇴장 효과음'),
        toggle('ptt', '눌러서 말하기 (Space 키를 누르는 동안만 마이크 켜기)')),
      blockedList.length ? section('lock', '차단한 사용자',
        ...blockedList.map((id) => h('div', { class: 'row gap' }, avatar(data.user(id) || { id, nickname: '?' }, 24), h('span', { class: 'grow' }, data.user(id)?.nickname || id),
          h('button', { class: 'btn small secondary', type: 'button', onclick: (e) => { blocked.toggle(id); e.currentTarget.closest('.row').remove(); } }, '해제')))) : null,
      section('device', '상태 · 저장 공간',
        h('p', {}, modeText),
        connInfo,
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
      section('gear', '앱',
        h('div', { class: 'row gap' },
          h('button', { class: 'btn secondary', type: 'button', onclick: () => shortcutsDialog() }, '⌨️ 단축키'),
          h('button', { class: 'btn secondary', type: 'button', onclick: () => commandsDialog() }, '/ 명령어'),
          h('button', {
            class: 'btn secondary', type: 'button',
            onclick: async () => {
              if (installPrompt) { installPrompt.prompt(); installPrompt = null; return; }
              toast(/iPhone|iPad/.test(navigator.userAgent) ? '사파리의 공유 버튼 → "홈 화면에 추가"를 누르세요.' : '이미 설치되었거나 이 브라우저는 앱 설치를 지원하지 않습니다. 브라우저 메뉴의 "앱 설치"를 확인하세요.', 'info', 5000);
            },
          }, '📲 앱으로 설치')),
        h('button', { class: 'btn danger', type: 'button', onclick: () => ctx.logout() }, icon('logout', 16), ' 로그아웃')),
    ],
    actions: [{ label: '닫기' }],
  });
}

export function shortcutsDialog() {
  const rows = [
    ['Ctrl/⌘ + K', '빠른 이동 (방 찾기)'], ['Alt + ↑ / ↓', '이전 / 다음 방'], ['Alt + Shift + ↑ / ↓', '이전 / 다음 안 읽은 방'],
    ['Esc', '읽음 처리하고 맨 아래로 · 답장/수정 취소'], ['↑ (빈 입력창)', '내 마지막 메시지 수정'], ['Enter / Shift + Enter', '보내기 / 줄바꿈'],
    ['Ctrl/⌘ + B · I · U', '굵게 · 기울임 · 밑줄'], ['Ctrl/⌘ + Shift + X', '취소선'], ['Ctrl/⌘ + E', '인라인 코드'],
    ['@ · : · /', '멘션 · 이모지 · 명령어 자동완성'], ['Space (통화 중, 설정 시)', '눌러서 말하기'], ['Ctrl/⌘ + /', '이 도움말'],
  ];
  openModal({
    title: '⌨️ 키보드 단축키',
    body: h('table', { class: 'kbd-table' }, rows.map(([k, d]) => h('tr', {}, h('td', {}, h('kbd', {}, k)), h('td', {}, d)))),
    actions: [{ label: '닫기' }],
  });
}

export function commandsDialog() {
  openModal({
    title: '/ 명령어',
    body: h('table', { class: 'kbd-table' }, COMMANDS.map((c) => h('tr', {}, h('td', {}, h('kbd', {}, `/${c.name}`), ' ', h('span', { class: 'muted small' }, c.args)), h('td', {}, c.desc)))),
    actions: [{ label: '닫기' }],
  });
}

// ───────── 이미지·동영상 크게 보기 (여러 장 넘기기, 확대) ─────────
export function lightbox(arg, list = null) {
  const items = list || [arg];
  let index = Math.max(0, items.indexOf(arg));
  let scale = 1;
  let tx = 0;
  let ty = 0;
  const stage = h('div', { class: 'lightbox-stage' });
  const title = h('span', { class: 'ellipsis' });
  const counter = h('span', { class: 'muted small' });
  const dl = h('span');
  const back = h('div', { class: 'lightbox', role: 'dialog' });
  const close = () => { back.remove(); document.removeEventListener('keydown', onKey); };
  const apply = () => { const m = stage.firstChild; if (m?.tagName === 'IMG') m.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`; stage.classList.toggle('zoomed', scale > 1); };
  const show = (i) => {
    index = (i + items.length) % items.length;
    scale = 1; tx = 0; ty = 0;
    const it = items[index];
    const media = it.kind === 'video'
      ? h('video', { src: it.url, controls: true, autoplay: true, playsinline: true, controlslist: it.canDownload ? null : 'nodownload' })
      : h('img', { src: it.url, alt: it.name, draggable: 'false' });
    if (!it.canDownload) media.addEventListener('contextmenu', (e) => e.preventDefault());
    stage.replaceChildren(media);
    title.textContent = it.name;
    counter.textContent = items.length > 1 ? `${index + 1} / ${items.length}` : '';
    dl.replaceChildren(it.canDownload ? h('button', { class: 'icon-btn', title: '다운로드', onclick: it.onDownload }, icon('download')) : h('span', { class: 'muted small' }, icon('lock', 14), ' 만료됨 · 보기 전용'));
  };
  const onKey = (e) => {
    if (e.key === 'Escape') close();
    if (e.key === 'ArrowRight' && items.length > 1) show(index + 1);
    if (e.key === 'ArrowLeft' && items.length > 1) show(index - 1);
  };
  const nav = (d, ic) => (items.length > 1 ? h('button', { class: `lb-nav lb-${d < 0 ? 'prev' : 'next'}`, 'aria-label': d < 0 ? '이전' : '다음', onclick: (e) => { e.stopPropagation(); show(index + d); } }, icon(ic, 28)) : null);
  back.append(
    h('div', { class: 'lightbox-bar' }, title, counter, dl,
      h('button', { class: 'icon-btn', title: '확대/축소 (더블클릭, 휠)', onclick: () => { scale = scale > 1 ? 1 : 2; tx = 0; ty = 0; apply(); } }, icon('search')),
      h('button', { class: 'icon-btn', title: '닫기', onclick: close }, icon('x'))),
    stage, nav(-1, 'chevronLeft'), nav(1, 'chevron'),
  );
  back.addEventListener('click', (e) => { if ((e.target === back || e.target === stage) && scale === 1) close(); });
  // 확대: 휠, 더블클릭 / 이동: 끌기 / 넘기기: 좌우 스와이프
  stage.addEventListener('wheel', (e) => {
    if (stage.firstChild?.tagName !== 'IMG') return;
    e.preventDefault();
    scale = Math.min(5, Math.max(1, scale * (e.deltaY < 0 ? 1.15 : 1 / 1.15)));
    if (scale === 1) { tx = 0; ty = 0; }
    apply();
  }, { passive: false });
  stage.addEventListener('dblclick', () => { scale = scale > 1 ? 1 : 2.5; tx = 0; ty = 0; apply(); });
  let drag = null;
  stage.addEventListener('pointerdown', (e) => { drag = { x: e.clientX, y: e.clientY, tx, ty, t: Date.now() }; });
  stage.addEventListener('pointermove', (e) => {
    if (!drag || scale === 1) return;
    tx = drag.tx + (e.clientX - drag.x);
    ty = drag.ty + (e.clientY - drag.y);
    apply();
  });
  stage.addEventListener('pointerup', (e) => {
    if (drag && scale === 1 && items.length > 1 && Math.abs(e.clientX - drag.x) > 60 && Math.abs(e.clientY - drag.y) < 80) show(index + (e.clientX < drag.x ? 1 : -1));
    drag = null;
  });
  document.body.append(back);
  document.addEventListener('keydown', onKey);
  show(index);
}
