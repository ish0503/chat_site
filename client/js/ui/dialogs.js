import { config, setServerUrl } from '../config.js';
import * as api from '../api.js';
import {
  h, toast, fmtFull, fmtBytes, fmtStamp, imageToAvatar, setClock24, safeImageUrl, isLowEndDevice,
} from '../util.js';
import { blobStats } from '../db.js';
import * as errorlog from '../errorlog.js';
import { PROVIDER_LABEL } from '../permissions.js';
import { renderMarkdown } from '../markdown.js';
import { notes, blocked } from '../local.js';
import { COMMANDS } from '../commands.js';
import { runnable, langFromName } from '../runner.js';
import * as files from '../files.js';
import {
  openModal, confirmDialog, field, avatar, badge, openEmojiPicker, PRESENCE_LABEL, openMenu,
} from './common.js';
import { icon } from './icons.js';
import { errorText } from './errors.js';
import { enhance } from './codeblock.js';
import { openInstall, isStandalone } from '../install.js';

const TYPE_LABEL = { text: '채팅방', voice: '통화방', code: '코드 작업실', board: '보드', folder: '폴더' };
const TYPE_INFO = {
  text: ['hash', '메시지·이미지·파일'], voice: ['voice', '음성·영상·화면 공유'], code: ['code', '프로젝트 · 파일 편집 · 실행'],
  board: ['grid', '트리·포스트잇·마인드맵·칸반…'], folder: ['folder', '방과 폴더를 묶기'],
};
const BOARD_VIEW_OPTS = [['tree', '🌳 트리'], ['sticky', '🗒️ 포스트잇'], ['mindmap', '🧠 마인드맵'], ['branch', '🌿 브랜치'], ['kanban', '📋 칸반'], ['timeline', '🕒 타임라인'], ['debate', '⚖️ 토론']];
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
  const placeholders = { text: '새 채팅방', voice: '새 통화방', code: '새 코드 작업실', board: '새 보드', folder: '새 폴더' };
  const viewSel = h('select', { class: 'input' }, BOARD_VIEW_OPTS.map(([v, l]) => h('option', { value: v }, l)));
  const viewField = field('처음 보기 방식', viewSel, '같은 카드를 여러 방식으로 볼 수 있고, 방 안에서 언제든 바꿀 수 있습니다.');
  const render = () => {
    viewField.hidden = current !== 'board';
    typeRow.replaceChildren(...['text', 'voice', 'code', 'board', 'folder'].map((t) => h('button', {
      type: 'button', role: 'radio', 'aria-checked': String(t === current), class: `type-opt${t === current ? ' active' : ''}`,
      onclick: () => { current = t; name.placeholder = placeholders[t]; topicField.hidden = t === 'folder'; extra = roomFields(t); extraBox.replaceChildren(details()); render(); },
    }, icon(TYPE_INFO[t][0], 22),
    h('span', { class: 'type-name' }, TYPE_LABEL[t]),
    h('span', { class: 'type-desc' }, TYPE_INFO[t][1]))));
  };
  const details = () => h('details', { class: 'more-opts' }, h('summary', {}, '추가 설정 (아이콘, 색, 공지 전용, 슬로우 모드)'), extra.els);
  const topicField = field('설명', topic);
  render();
  extraBox.append(details());
  name.placeholder = placeholders[current];
  topicField.hidden = current === 'folder';
  openModal({
    title: '만들기',
    body: [h('div', { class: 'field' }, h('span', { class: 'field-label' }, '종류'), typeRow), field('이름', name), viewField, topicField, field('위치', parent), extraBox],
    actions: [
      { label: '취소' },
      {
        label: '만들기', kind: 'primary', submit: true,
        onClick: async () => {
          const nm = name.value.trim() || placeholders[current];
          try {
            const node = await data.createNode({
              type: current, name: nm, parentId: parent.value || null, topic: current === 'folder' ? '' : topic.value, ...extra.values(), ...(current === 'board' ? { view: viewSel.value } : {}),
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
/** 단어 단위 비교 (수정 전후에서 지워진 부분 · 추가된 부분) */
export function diffWords(a = '', b = '') {
  const A = a.split(/(\s+)/);
  const B = b.split(/(\s+)/);
  if (A.length * B.length > 250_000) return [{ op: 'del', text: a }, { op: 'add', text: b }];
  const dp = Array.from({ length: A.length + 1 }, () => new Uint16Array(B.length + 1));
  for (let i = A.length - 1; i >= 0; i--) for (let j = B.length - 1; j >= 0; j--) dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out = [];
  const push = (op, text) => { if (out.at(-1)?.op === op) out.at(-1).text += text; else out.push({ op, text }); };
  let i = 0; let j = 0;
  while (i < A.length && j < B.length) {
    if (A[i] === B[j]) { push('same', A[i]); i++; j++; } else if (dp[i + 1][j] >= dp[i][j + 1]) push('del', A[i++]); else push('add', B[j++]);
  }
  while (i < A.length) push('del', A[i++]);
  while (j < B.length) push('add', B[j++]);
  return out;
}

export function editHistoryDialog(ctx, m) {
  const versions = [...(m.editHistory || []), { content: m.content, at: m.editedAt, current: true }];
  let showDiff = true;
  const box = h('div', { class: 'history' });
  const render = () => {
    box.replaceChildren(...versions.map((v, i) => ({ v, prev: versions[i - 1] })).reverse().map(({ v, prev }) => h('div', { class: `history-item${v.current ? ' current' : ''}` },
      h('div', { class: 'muted small' }, v.current ? `현재 · ${fmtStamp(v.at)}` : i18nVersion(versions.indexOf(v), v.at)),
      showDiff && prev
        ? h('div', { class: 'msg-text diff' }, diffWords(prev.content || '', v.content || '').map((d) => (d.op === 'same' ? d.text : h(d.op === 'add' ? 'ins' : 'del', {}, d.text))))
        : h('div', { class: 'msg-text', html: renderMarkdown(v.content || '', { me: ctx.data.me }) }))));
  };
  const i18nVersion = (i, at) => (i === 0 ? `원래 내용 · ${fmtStamp(at)}` : `${i}번째 수정 · ${fmtStamp(at)}`);
  render();
  openModal({
    title: `수정 기록 (${versions.length - 1}번 수정됨)`,
    body: [h('label', { class: 'switch-row small' }, h('span', {}, '바뀐 부분 표시 (지운 글 / 추가한 글)'),
      h('input', { type: 'checkbox', class: 'switch', checked: true, onchange: (e) => { showDiff = e.target.checked; render(); } })), box],
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
    const rooms = [...data.nodes.values()].filter((n) => ((n.type === 'text' && !(n.readonly && !data.can('manageNodes'))) || n.type === 'dm') && data.roomLabel(n).toLowerCase().includes(s))
      .sort((a, b) => (a.type === 'dm') - (b.type === 'dm') || (b.lastMessageAt || 0) - (a.lastMessageAt || 0));
    list.replaceChildren(...rooms.map((n) => h('button', {
      class: 'qs-item', type: 'button',
      onclick: async () => {
        modal.close();
        try {
          await data.sendMessage(n.id, { forward: m });
          toast(`${n.type === 'dm' ? '@' : '#'}${data.roomLabel(n)}(으)로 전달했습니다.`, 'success');
        } catch (e) {
          toast(errorText(e), 'error');
        }
      },
    }, n.type === 'dm' ? avatar(data.dmPartner(n), 18) : n.emoji ? h('span', {}, n.emoji) : icon('hash', 16), h('span', {}, data.roomLabel(n)), h('span', { class: 'muted small' }, n.type === 'dm' ? '1:1 대화' : pathOf(n)))));
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
        h('div', { class: 'row gap wrap' },
          data.can('directMessage') ? h('button', {
            class: 'btn primary small', type: 'button',
            onclick: async () => { modal.close(); try { const n = await data.openDm(userId); ctx.openRoom(n.id); } catch (e) { toast(errorText(e), 'error'); } },
          }, icon('message', 14), ' 메시지 보내기') : null,
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
    callSounds: true, ptt: false,
    // v1.0: 화면 크기 · 간격, 애니메이션 자동 조절, 사이드바 구성, 멤버 목록 고정, 오류 자동 보고
    autoMotion: true, density: 'normal', uiScale: 100, sidebarWidth: 264, panelWidth: 360, membersDock: false,
    sidebarSections: ['favorites', 'dms', 'rooms', 'archive'], sidebarHidden: [], errorReports: true, ...s,
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
  // 저사양 기기(메모리 2GB 이하, 코어 2개 이하, 데이터 절약, 시스템의 동작 줄이기)에서는 효과를 자동으로 가볍게
  root.classList.toggle('lite', !settings.reduceMotion && settings.autoMotion !== false && isLowEndDevice());
  root.dataset.density = settings.density || 'normal';
  root.style.setProperty('--side-w', `${Math.min(420, Math.max(200, Number(settings.sidebarWidth) || 264))}px`);
  root.style.setProperty('--panel-w', `${Math.min(560, Math.max(280, Number(settings.panelWidth) || 360))}px`);
  const scale = Math.min(130, Math.max(80, Number(settings.uiScale) || 100));
  root.style.zoom = scale === 100 ? '' : `${scale}%`;
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


export function settingsDialog(ctx) {
  const { data } = ctx;
  const select = (key, options, onChange) => h('select', { class: 'input', onchange: (e) => { saveSettings({ [key]: e.target.value }); onChange?.(e.target.value); } },
    options.map(([v, l]) => h('option', { value: v, selected: String(settings[key]) === v }, l)));
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
  const rangeField = (label, key, min, max) => {
    const out = h('span', { class: 'muted small' }, `${settings[key]}px`);
    return field(label, h('div', { class: 'row gap' }, h('input', {
      type: 'range', class: 'grow', min: String(min), max: String(max), step: '4', value: String(settings[key]),
      oninput: (e) => { out.textContent = `${e.target.value}px`; saveSettings({ [key]: Number(e.target.value) }); },
    }), out));
  };
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
        field('메시지 간격', select('density', [['compact', '좁게'], ['normal', '보통'], ['cozy', '넓게']])),
        field('화면 배율', select('uiScale', [['80', '80%'], ['90', '90%'], ['100', '100%'], ['110', '110%'], ['125', '125%']].map(([v, l]) => [v, l]), () => {}), '앱 전체(글자 · 버튼 · 여백)를 크게 또는 작게'),
        rangeField('사이드바 너비', 'sidebarWidth', 200, 420),
        rangeField('오른쪽 패널 너비', 'panelWidth', 280, 560),
        toggle('clock24', '24시간제 시각'),
        toggle('reduceMotion', '애니메이션 줄이기'),
        toggle('autoMotion', `저사양 기기에서 효과 자동 줄이기${isLowEndDevice() ? ' (이 기기: 적용 중)' : ''}`),
        toggle('membersDock', '넓은 화면에서 멤버 목록 항상 표시 (멀티 패널)'),
        h('button', { class: 'btn secondary small', type: 'button', onclick: () => sidebarCustomizeDialog() }, icon('sliders', 14), ' 사이드바 구성 바꾸기')),
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
      section('shield', '개인정보 · 오류 보고',
        toggle('errorReports', '오류 자동 보고 (오류 코드 · 브라우저 정보만, 메시지 내용 제외)'),
        h('div', { class: 'row gap wrap' },
          h('button', { class: 'btn secondary small', type: 'button', onclick: () => errorLogDialog() }, icon('alert', 14), ` 오류 기록 (${errorlog.list().length})`))),
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
        h('div', { class: 'row gap wrap' },
          h('button', { class: 'btn secondary', type: 'button', onclick: () => serverStatusDialog(ctx) }, icon('activity', 16), ' 서버 상태'),
          h('button', { class: 'btn secondary', type: 'button', onclick: () => dataToolsDialog(ctx) }, icon('refresh', 16), ' 데이터 복구 · 백업'),
          data.can('storage') ? h('button', { class: 'btn secondary', type: 'button', onclick: () => storageDialog(ctx) }, icon('archive', 16), ' 내 보관함') : null),
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
          isStandalone()
            ? h('span', { class: 'muted small' }, '✅ 앱으로 실행 중')
            : h('button', { class: 'btn primary', type: 'button', onclick: () => openInstall() }, '📲 앱으로 설치 (홈 화면 · 바탕화면)')),
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
    ['Ctrl/⌘ + Shift + F', '통합 탐색 (방 · 사람 · 파일 · 메시지)'], ['Ctrl/⌘ + \\', '분할 화면 열기 / 닫기'], ['Ctrl/⌘ + .', '빠른 설정'],
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

// ───────── 사이드바 구성 ─────────
export const SIDEBAR_SECTIONS = {
  favorites: '⭐ 즐겨찾기', dms: '💬 개인 메시지 (최근 대화)', rooms: '# 채팅방 · 통화방 · 폴더', archive: '🗄 보관한 방',
};
export function sidebarCustomizeDialog() {
  let order = [...new Set([...(settings.sidebarSections || []), ...Object.keys(SIDEBAR_SECTIONS)])].filter((k) => SIDEBAR_SECTIONS[k]);
  let hidden = new Set(settings.sidebarHidden || []);
  const box = h('div', { class: 'reorder-list' });
  const save = () => saveSettings({ sidebarSections: order, sidebarHidden: [...hidden] });
  const render = () => box.replaceChildren(...order.map((k, i) => h('div', { class: 'reorder-row' },
    h('input', { type: 'checkbox', class: 'switch', checked: !hidden.has(k), 'aria-label': `${SIDEBAR_SECTIONS[k]} 표시`, onchange: (e) => { if (e.target.checked) hidden.delete(k); else hidden.add(k); save(); } }),
    h('span', { class: 'grow' }, SIDEBAR_SECTIONS[k]),
    h('button', { class: 'icon-btn tiny', type: 'button', 'aria-label': '위로', disabled: i === 0, onclick: () => { [order[i - 1], order[i]] = [order[i], order[i - 1]]; save(); render(); } }, icon('chevronDown', 16, 'flip')),
    h('button', { class: 'icon-btn tiny', type: 'button', 'aria-label': '아래로', disabled: i === order.length - 1, onclick: () => { [order[i + 1], order[i]] = [order[i], order[i + 1]]; save(); render(); } }, icon('chevronDown', 16)))));
  render();
  openModal({
    title: '사이드바 구성',
    body: [h('p', { class: 'muted small' }, '사이드바에 보일 목록과 순서를 고르세요. (이 기기에만 적용)'), box,
      h('button', { class: 'btn ghost small', type: 'button', onclick: () => { order = Object.keys(SIDEBAR_SECTIONS); hidden = new Set(); save(); render(); } }, '기본값으로')],
    actions: [{ label: '닫기' }],
  });
}

// ───────── 빠른 설정 ─────────
export function quickSettings(ctx, anchor) {
  const { data } = ctx;
  const cycle = (key, values) => { const i = values.indexOf(String(settings[key])); saveSettings({ [key]: values[(i + 1) % values.length] }); };
  const themeLabel = { dark: '다크', light: '라이트', system: '시스템' }[settings.theme];
  const dnd = data.me.presence === 'dnd';
  return openMenu(anchor, [
    { label: `테마: ${themeLabel} (바꾸기)`, icon: 'smile', onClick: () => cycle('theme', ['dark', 'light', 'system']) },
    { label: `글자 크기: ${{ small: '작게', normal: '보통', large: '크게', xlarge: '아주 크게' }[settings.fontSize]}`, icon: 'edit', onClick: () => cycle('fontSize', ['small', 'normal', 'large', 'xlarge']) },
    { label: `메시지 간격: ${{ compact: '좁게', normal: '보통', cozy: '넓게' }[settings.density || 'normal']}`, icon: 'sliders', onClick: () => cycle('density', ['compact', 'normal', 'cozy']) },
    { label: `${settings.sound ? '✓ ' : ''}효과음`, icon: 'bell', onClick: () => saveSettings({ sound: !settings.sound }) },
    { label: `${dnd ? '✓ ' : ''}방해 금지`, icon: 'bellOff', onClick: () => data.updateProfile({ presence: dnd ? 'online' : 'dnd' }).catch((e) => toast(errorText(e), 'error')) },
    { label: `${settings.reduceMotion ? '✓ ' : ''}애니메이션 줄이기`, icon: 'play', onClick: () => saveSettings({ reduceMotion: !settings.reduceMotion }) },
    { label: `${settings.membersDock ? '✓ ' : ''}멤버 목록 항상 표시`, icon: 'users', onClick: () => saveSettings({ membersDock: !settings.membersDock }) },
    'sep',
    { label: '서버 상태', icon: 'activity', onClick: () => serverStatusDialog(ctx) },
    data.can('storage') ? { label: '내 보관함', icon: 'archive', onClick: () => storageDialog(ctx) } : null,
    { label: '사이드바 구성', icon: 'sliders', onClick: () => sidebarCustomizeDialog() },
    { label: '모든 설정', icon: 'gear', onClick: () => settingsDialog(ctx) },
  ]);
}

// ───────── 서버 상태 모니터링 ─────────
const fmtUptime = (sec) => (sec >= 86400 ? `${Math.floor(sec / 86400)}일 ${Math.floor((sec % 86400) / 3600)}시간` : sec >= 3600 ? `${Math.floor(sec / 3600)}시간 ${Math.floor((sec % 3600) / 60)}분` : `${Math.floor(sec / 60)}분`);

export function serverStatusDialog(ctx) {
  const { data } = ctx;
  const body = h('div', { class: 'status-grid' }, h('div', { class: 'spinner' }));
  let timer = null;
  const row = (label, ok, value, hint) => h('div', { class: `status-row ${ok === true ? 'ok' : ok === false ? 'bad' : 'unknown'}` },
    h('span', { class: 'status-dot', 'aria-hidden': 'true' }), h('span', { class: 'status-label' }, label), h('span', { class: 'status-value' }, value),
    hint ? h('span', { class: 'status-hint muted small' }, hint) : null);
  async function refresh() {
    const r = await data.serverStatus();
    const st = r.status;
    const items = [];
    if (!r.serverUrl) {
      items.push(row('서버', null, '로컬 모드', '서버 주소가 없어 이 기기에만 저장합니다.'));
    } else {
      items.push(row('API (HTTP)', !r.apiError, r.apiError ? `응답 없음 (${errorText({ code: r.apiError })})` : `정상 · ${r.apiMs}ms`, r.health?.version ? `서버 버전 ${r.health.version}` : null));
      items.push(row('데이터베이스 (MongoDB)', r.health ? !!r.health.db : null, r.health ? (r.health.db ? `연결됨${st?.db?.pingMs != null ? ` · ${st.db.pingMs}ms` : ''}${st?.db?.memory ? ' · 메모리 DB' : ''}` : '연결 끊김 → 기기에 저장 중') : '확인 불가'));
      items.push(row('실시간 연결 (WebSocket)', data.isOnline ? true : r.apiError ? false : null, data.isOnline ? `${r.ws?.transport === 'websocket' ? 'WebSocket' : 'HTTP polling'}${r.ws ? ` · 왕복 ${r.ws.rtt}ms` : ''}` : { connecting: '연결 중…', offline: '끊김', local: '사용 안 함' }[data.mode]));
      items.push(row('동기화', data.pendingOps ? null : data.isOnline, data.pendingOps ? `대기 중인 작업 ${data.pendingOps}개` : '모두 동기화됨', r.lastSync ? `마지막 동기화 ${fmtStamp(r.lastSync)}` : null));
      if (r.sessionExpiresAt) {
        const left = r.sessionExpiresAt - Date.now();
        items.push(row('로그인 세션', left > 86400_000, left > 0 ? `${fmtUptime(Math.floor(left / 1000))} 남음` : '만료됨', '연결되어 있으면 만료 7일 전에 자동으로 갱신됩니다.'));
      }
      if (st) {
        items.push(row('서버 가동 시간', true, fmtUptime(st.uptimeSec), `Node ${st.node} · 메모리 ${st.memoryMb.rss}MB`));
        items.push(row('접속', true, `${st.onlineUsers}명 온라인 · 연결 ${st.sockets}개`, `분당 메시지 ${st.messagesPerMin}개`));
        items.push(row('통화', true, `${st.calls.rooms}개 방 · ${st.calls.participants}명`, `방당 최대 ${st.calls.max}명 · ${st.calls.mode === 'sfu' ? 'SFU' : '직접 연결(mesh)'}`));
        const errs = st.errors.serverLastHour + st.errors.clientLastHour;
        items.push(row('오류 (최근 1시간)', errs === 0 ? true : errs < 20 ? null : false, `서버 ${st.errors.serverLastHour}건 · 앱 ${st.errors.clientLastHour}건`, st.errors.reportsLastDay != null ? `최근 24시간 오류 보고 ${st.errors.reportsLastDay}건` : null));
        const limited = Object.values(st.rateLimited || {}).reduce((a, b) => a + b, 0);
        if (limited) items.push(row('요청 제한', null, `${limited}건 차단됨`, Object.entries(st.rateLimited).filter(([, v]) => v).map(([k, v]) => `${k} ${v}`).join(' · ')));
        if (st.errors.recent?.length) {
          items.push(h('details', { class: 'status-errors' }, h('summary', {}, `최근 서버 오류 ${st.errors.recent.length}건 (관리자만 보임)`),
            ...st.errors.recent.map((e) => h('div', { class: 'muted small mono' }, `${fmtStamp(e.at)} [${e.where}] ${e.message}`))));
        }
      } else if (r.statusError) {
        items.push(row('상세 상태', null, '받을 수 없음', '이 서버가 상태 정보를 지원하지 않거나 로그인이 필요합니다.'));
      }
    }
    body.replaceChildren(...items, h('p', { class: 'muted small' }, `5초마다 자동 새로고침 · ${new Date().toLocaleTimeString('ko-KR')}`));
  }
  refresh();
  timer = setInterval(refresh, 5000);
  openModal({
    title: '서버 상태',
    cls: 'status-modal',
    body,
    onClose: () => clearInterval(timer),
    actions: [{ label: '다시 연결', onClick: () => { data.connect(); return false; } }, { label: '닫기', kind: 'primary' }],
  });
}

// ───────── 데이터 복구 · 백업 ─────────
export function dataToolsDialog(ctx) {
  const { data } = ctx;
  const report = h('div', { class: 'muted small' }, '검사 중…');
  const outbox = h('div', { class: 'outbox-list' });
  const inspect = async (fix = false) => {
    const r = await data.inspectLocal({ fix });
    report.replaceChildren(
      h('div', {}, `기기에 저장된 메시지 ${r.messages.toLocaleString()}개 · 방 ${r.rooms}개 · 파일 사본 ${r.blobs}개 · 동기화 대기 ${r.outbox}개`),
      r.failed ? h('div', { class: 'warn-text' }, `전송 실패한 메시지 ${r.failed}개 (메시지의 "다시 보내기"로 재전송)`) : null,
      !r.local && (r.orphanMsgs || r.orphanBlobs) ? h('div', {}, `정리할 수 있는 데이터: 삭제된 방의 메시지 ${r.orphanMsgs}개, 쓰이지 않는 파일 사본 ${r.orphanBlobs}개`) : h('div', {}, '✅ 정리할 데이터가 없습니다.'),
    );
    if (fix) toast('기기 데이터를 정리했습니다.', 'success');
  };
  const renderOutbox = async () => {
    const ops = await data.outboxList();
    const label = { 'msg:send': '메시지 보내기', upload: '파일 업로드', 'msg:edit': '메시지 수정', 'msg:delete': '메시지 삭제', 'msg:deleteMany': '메시지 여러 개 삭제', 'msg:react': '반응', 'msg:pin': '고정', 'msg:vote': '투표', 'node:create': '방 만들기', 'node:update': '방 수정', 'node:delete': '방 삭제', 'profile:update': '프로필 수정', 'dm:open': '1:1 대화 시작' };
    outbox.replaceChildren(...(ops.length ? ops.map((o) => h('div', { class: 'link-row' },
      h('span', { class: 'grow ellipsis' }, `${label[o.op] || o.op}${o.payload?.content ? ` · ${String(o.payload.content).slice(0, 40)}` : ''}`),
      h('span', { class: 'muted small' }, o.at ? fmtStamp(o.at) : ''),
      h('button', { class: 'btn small ghost', type: 'button', onclick: async () => { await data.discardOutbox(o.seq); renderOutbox(); } }, '취소'))) : [h('p', { class: 'muted small' }, '동기화를 기다리는 작업이 없습니다.')]),
    ...(data.dropped?.length ? [h('p', { class: 'muted small' }, `이번 접속에서 서버가 거부해 버린 작업 ${data.dropped.length}개: ${data.dropped.map((d) => `${label[d.op] || d.op}(${errorText({ code: d.error })})`).join(', ')}`)] : []));
  };
  const fileInput = h('input', {
    type: 'file', accept: 'application/json,.json', hidden: true,
    onchange: async () => {
      const f = fileInput.files[0];
      fileInput.value = '';
      if (!f) return;
      try {
        const r = await data.importBackup(JSON.parse(await f.text()));
        toast(`복원했습니다: 메시지 ${r.messages}개, 방 ${r.nodes}개, 다시 보낼 작업 ${r.requeued}개`, 'success', 6000);
        inspect(); renderOutbox();
      } catch (e) {
        toast(e instanceof SyntaxError ? '백업 파일을 읽을 수 없습니다.' : errorText(e), 'error');
      }
    },
  });
  inspect();
  renderOutbox();
  openModal({
    title: '데이터 복구 · 백업',
    cls: 'settings-modal',
    body: [
      h('section', { class: 'settings-section' }, h('h3', {}, icon('device', 16), ' 기기 데이터 검사'), report,
        h('div', { class: 'row gap wrap' },
          h('button', { class: 'btn secondary small', type: 'button', onclick: () => inspect() }, '다시 검사'),
          h('button', { class: 'btn secondary small', type: 'button', onclick: () => inspect(true) }, '정리하기'))),
      h('section', { class: 'settings-section' }, h('h3', {}, icon('clock', 16), ' 동기화 대기열'), outbox),
      h('section', { class: 'settings-section' }, h('h3', {}, icon('cloud', 16), ' 서버에서 다시 받기'),
        h('p', { class: 'muted small' }, '기기에 저장된 대화 사본이 서버와 다를 때 사용합니다. 아직 보내지 않은 메시지는 지우지 않습니다.'),
        h('button', {
          class: 'btn secondary small', type: 'button', disabled: !data.isOnline,
          onclick: async () => {
            const ok = await confirmDialog({ title: '서버에서 다시 받기', message: '기기에 캐시된 메시지를 지우고 서버에서 다시 받을까요?\n(보내지 않은 메시지, 파일 사본은 유지됩니다)', confirmText: '다시 받기' });
            if (!ok) return;
            try { await data.resyncFromServer(); toast('서버에서 다시 받았습니다.', 'success'); inspect(); } catch (e) { toast(errorText(e), 'error'); }
          },
        }, data.isOnline ? '서버에서 다시 받기' : '서버에 연결되면 사용할 수 있습니다')),
      h('section', { class: 'settings-section' }, h('h3', {}, icon('download', 16), ' 백업 · 복원'),
        h('p', { class: 'muted small' }, '이 기기에 저장된 방 · 메시지 · 동기화 대기 작업 · 개인 설정을 파일로 저장합니다 (첨부파일 내용과 로그인 정보는 제외). 다른 기기나 브라우저에서 복원하면 없는 메시지만 추가됩니다.'),
        h('div', { class: 'row gap wrap' },
          h('button', {
            class: 'btn secondary small', type: 'button',
            onclick: async () => {
              const b = await data.exportBackup();
              const url = URL.createObjectURL(new Blob([JSON.stringify(b)], { type: 'application/json' }));
              const a = h('a', { href: url, download: `chat-site-backup-${new Date().toISOString().slice(0, 10)}.json` });
              document.body.append(a); a.click(); a.remove();
              setTimeout(() => URL.revokeObjectURL(url), 5000);
              toast(`백업 파일을 저장했습니다 (메시지 ${b.messages.length}개).`, 'success');
            },
          }, '백업 파일 저장'),
          h('button', { class: 'btn secondary small', type: 'button', onclick: () => fileInput.click() }, '백업에서 복원'),
          fileInput)),
    ],
    actions: [{ label: '닫기' }],
  });
}

// ───────── 오류 기록 ─────────
export function errorLogDialog() {
  const list = errorlog.list();
  const box = h('div', { class: 'history' }, list.length ? list.map((e) => h('div', { class: 'history-item' },
    h('div', { class: 'muted small' }, `${fmtStamp(e.at)} · ${e.code} · v${e.version}${e.mode ? ` · ${e.mode}` : ''}`),
    h('div', { class: 'mono small' }, e.message), e.stack ? h('details', {}, h('summary', { class: 'muted small' }, '자세히'), h('pre', { class: 'mono small pre' }, e.stack)) : null))
    : h('p', { class: 'muted' }, '기록된 오류가 없습니다. 👍'));
  openModal({
    title: '오류 기록',
    body: [h('p', { class: 'muted small' }, `이 기기에서 난 최근 오류 (최대 50개). ${settings.errorReports !== false ? '서버에 연결되면 자동으로 보고됩니다.' : '자동 보고가 꺼져 있습니다.'}`), box],
    actions: [
      { label: '복사', onClick: () => { navigator.clipboard?.writeText(JSON.stringify(list, null, 2)).then(() => toast('복사했습니다.')); return false; } },
      { label: '지우기', kind: 'danger-ghost', onClick: () => { errorlog.clear(); toast('오류 기록을 지웠습니다.'); } },
      { label: '닫기', kind: 'primary' },
    ],
  });
}

// ───────── 내 보관함 (만료 없는 개인 파일) ─────────
async function loadStorage(data, box, { pick = null, onChange } = {}) {
  box.replaceChildren(h('div', { class: 'spinner' }));
  try {
    const r = await data.listStoredFiles();
    const pct = Math.min(100, Math.round((r.usage / r.quota) * 100));
    const chosen = new Set();
    box.replaceChildren(
      h('div', { class: 'quota' }, h('div', { class: 'quota-bar' }, h('span', { style: { width: `${pct}%` }, class: pct > 90 ? 'full' : '' })), h('span', { class: 'muted small' }, `${fmtBytes(r.usage)} / ${fmtBytes(r.quota)} 사용`)),
      ...(r.files.length ? r.files.map((f) => h('div', { class: 'link-row storage-row' },
        pick ? h('input', { type: 'checkbox', 'aria-label': `${f.name} 선택`, onchange: (e) => { if (e.target.checked) chosen.add(f); else chosen.delete(f); } }) : null,
        icon(f.kind === 'image' ? 'image' : f.kind === 'video' ? 'video' : f.kind === 'audio' ? 'mic' : 'file', 18, 'dim'),
        h('span', { class: 'grow ellipsis', title: f.name }, f.name),
        h('span', { class: 'muted small' }, fmtBytes(f.size)),
        pick ? null : h('button', { class: 'icon-btn tiny', title: '다운로드', type: 'button', onclick: () => files.saveToDevice(f, data).catch((e) => toast(errorText(e), 'error')) }, icon('download', 15)),
        pick ? null : h('button', {
          class: 'icon-btn tiny', title: '삭제', type: 'button',
          onclick: async () => {
            const ok = await confirmDialog({ title: '보관함에서 삭제', message: `'${f.name}' 을(를) 보관함에서 삭제할까요?\n이 파일을 첨부한 메시지에서도 더 이상 내려받을 수 없습니다.`, confirmText: '삭제', danger: true });
            if (!ok) return;
            try { await data.removeStoredFile(f.id); loadStorage(data, box, { onChange }); onChange?.(); } catch (e) { toast(errorText(e), 'error'); }
          },
        }, icon('trash', 15))))
        : [h('p', { class: 'muted small pad' }, '보관한 파일이 없습니다. 채팅 첨부파일의 🗄 버튼으로 보관하거나 직접 올려 보세요.')]),
    );
    return () => [...chosen];
  } catch (e) {
    box.replaceChildren(h('p', { class: 'muted' }, errorText(e)));
    return () => [];
  }
}

export function storageDialog(ctx) {
  const { data } = ctx;
  const box = h('div', { class: 'storage-list' });
  const progress = h('span', { class: 'muted small' });
  const input = h('input', {
    type: 'file', multiple: true, hidden: true,
    onchange: async () => {
      const fl = [...input.files];
      input.value = '';
      for (const f of fl) {
        try {
          await data.uploadToStorage(f, (p) => { progress.textContent = `${f.name} ${Math.round(p * 100)}%`; });
        } catch (e) { toast(`${f.name}: ${errorText(e)}`, 'error'); }
      }
      progress.textContent = '';
      loadStorage(data, box);
    },
  });
  loadStorage(data, box);
  openModal({
    title: '🗄 내 보관함',
    body: [h('p', { class: 'muted small' }, `채팅 첨부파일은 ${Math.round(data.fileTtlMs / 3600_000)}시간 뒤 만료되지만, 보관함 파일은 직접 지울 때까지 남습니다. 입력창 + → "내 보관함에서 첨부" 로 채팅에 보낼 수 있어요.`),
      h('div', { class: 'row gap' }, h('button', { class: 'btn secondary small', type: 'button', disabled: !data.isOnline, onclick: () => input.click() }, icon('plus', 14), ' 파일 올리기'), progress, input),
      box],
    actions: [{ label: '닫기' }],
  });
}

export function storagePicker(ctx, onPick) {
  const box = h('div', { class: 'storage-list' });
  let getChosen = () => [];
  loadStorage(ctx.data, box, { pick: true }).then((fn) => { getChosen = fn; });
  openModal({
    title: '보관함에서 첨부',
    body: box,
    actions: [{ label: '취소' }, { label: '첨부', kind: 'primary', onClick: () => { const c = getChosen(); if (c.length) onPick(c); } }],
  });
}

// ───────── AI 도우미 ─────────
export function aiDialog(ctx, roomId) {
  const { data } = ctx;
  const room = data.nodes.get(roomId);
  const q = h('input', { class: 'input', placeholder: '예: 지난주에 정한 회의 날짜가 언제였지?', maxlength: '500' });
  const out = h('div', { class: 'ai-answer' }, h('p', { class: 'muted small' }, '최근 메시지(최대 300개)를 읽고 요약하거나 질문에 답합니다. 기록은 AI 서비스로 전송됩니다.'));
  let last = null;
  const run = async (mode) => {
    if (mode === 'ask' && !q.value.trim()) { q.focus(); return; }
    out.replaceChildren(h('div', { class: 'spinner' }), h('p', { class: 'muted small' }, 'AI가 대화를 읽고 있어요…'));
    try {
      const r = await data.askAi(roomId, { mode, question: q.value.trim() });
      last = { mode, text: r.text, question: q.value.trim() };
      out.replaceChildren(h('div', { class: 'msg-text', html: renderMarkdown(r.text, { me: data.me }) }), h('p', { class: 'muted small' }, `🤖 ${r.model || 'AI'} · AI 답변은 틀릴 수 있습니다.`),
        data.can('sendMessage') ? h('button', {
          class: 'btn small secondary', type: 'button',
          onclick: () => data.sendMessage(roomId, { content: `🤖 **AI ${last.mode === 'summary' ? '요약' : `답변: ${last.question.slice(0, 100)}`}**\n${last.text}`.slice(0, 4000) }).then(() => toast('채팅에 공유했습니다.')).catch((e) => toast(errorText(e), 'error')),
        }, '채팅에 공유') : null);
    } catch (e) {
      out.replaceChildren(h('p', { class: 'warn-text' }, errorText(e)));
    }
  };
  q.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); run('ask'); } });
  openModal({
    title: `🤖 AI 도우미 · ${room?.type === 'dm' ? `@${data.roomLabel(room)}` : `#${room?.name || ''}`}`,
    body: [h('div', { class: 'row gap' }, h('button', { class: 'btn secondary', type: 'button', onclick: () => run('summary') }, icon('sparkle', 16), ' 최근 대화 요약')),
      field('대화 기록에 대해 묻기', h('div', { class: 'row gap' }, q, h('button', { class: 'btn primary', type: 'button', onclick: () => run('ask') }, '질문'))), out],
    actions: [{ label: '닫기' }],
  });
}
