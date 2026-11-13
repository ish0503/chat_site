// 보드 방: 종류별로 따로 나뉜 보드 (트리 · 포스트잇 · 마인드맵 · 브랜치 · 칸반 · 타임라인 · 토론 · 표 · 달력)
// 보드의 종류(방의 view)는 만들 때 정하고 바꾸지 않습니다. 보드마다 자기 카드(작업 공간 항목 kind: 'card')를 따로 가집니다.
import {
  h, toast, uid, fmtStamp, fmtDate, sameDay, fmtTime, isTouch,
} from '../util.js';
import { renderMarkdown } from '../markdown.js';
import { messagesToCards, messagesToTasks, draftToCards } from '../convert.js';
import { icon } from './icons.js';
import { openModal, openMenu, confirmDialog, field } from './common.js';
import { errorText } from './errors.js';

/** 보드의 종류. 만들 때 정해지고, 예전 보드처럼 값이 없으면 트리 */
export const boardKind = (room) => (BOARD_VIEWS[room?.view] ? room.view : 'tree');
export const BOARD_VIEWS = {
  tree: { label: '트리', emoji: '🌳', desc: '주제 → 하위 주제로 정리' },
  sticky: { label: '포스트잇', emoji: '🗒️', desc: '자유롭게 붙이고 옮기기' },
  mindmap: { label: '마인드맵', emoji: '🧠', desc: '주제의 연결 관계' },
  branch: { label: '브랜치', emoji: '🌿', desc: '갈라지는 논의의 흐름' },
  kanban: { label: '칸반', emoji: '📋', desc: '할 일 · 진행 · 완료' },
  timeline: { label: '타임라인', emoji: '🕒', desc: '시간 순서대로' },
  debate: { label: '토론', emoji: '⚖️', desc: '찬성 · 반대 나누기' },
  table: { label: '표', emoji: '📊', desc: '한 줄씩 정렬 · 바로 고치기' },
  calendar: { label: '달력', emoji: '📅', desc: '날짜별로 한 달 보기' },
};
const STATUS = { todo: '할 일', doing: '진행 중', review: '검토', done: '완료' };
const STANCE = { pro: '👍 찬성', con: '👎 반대', neutral: '💬 기타' };
const NOTE_COLORS = ['#fde68a', '#fca5a5', '#93c5fd', '#86efac', '#d8b4fe', '#fdba74', '#e5e7eb'];
const LANE_COLORS = ['#5865f2', '#23a559', '#f0b232', '#eb459e', '#1abc9c', '#e67e22', '#9b59b6', '#ed4245'];

/** host: { ctx, roomId, items(Map), canEdit } */
export function createBoard(host) {
  const { ctx } = host;
  const { data } = ctx;
  const body = h('div', { class: 'board-body' });
  const tabs = h('div', { class: 'board-tabs' });
  const el = h('div', { class: 'board-view' }, h('div', { class: 'board-bar' }, tabs), body);
  const collapsed = new Set();
  let view = 'tree';
  let zoom = 1;
  let dragging = false;

  const cards = () => [...host.items.values()].filter((i) => i.kind === 'card');
  const byOrder = (a, b) => (a.order || 0) - (b.order || 0) || (a.createdAt || 0) - (b.createdAt || 0);
  const kidsOf = (id) => cards().filter((c) => (c.parentId || null) === id && (id === null || host.items.has(id))).sort(byOrder);
  // 상위 카드가 지워진 카드는 최상위로 취급
  const roots = () => cards().filter((c) => !c.parentId || !host.items.has(c.parentId)).sort(byOrder);
  const timeOf = (c) => c.date || c.createdAt || 0;
  const guard = (fn) => async (...a) => { try { return await fn(...a); } catch (e) { toast(errorText(e), 'error'); return null; } };
  const put = guard((patch) => data.putWs(host.roomId, { kind: 'card', ...patch }));
  const add = (fields) => (fields.text?.trim() ? put({ id: uid(), text: fields.text.trim().slice(0, 2000), ...fields }) : null);


  // ───────── 공통 부품 ─────────
  function quickAdd(placeholder, fields, cls = '') {
    if (!host.canEdit) return null;
    const input = h('input', { class: 'input quick-add-input', placeholder, maxlength: '2000', 'aria-label': placeholder });
    return h('form', { class: `quick-add ${cls}`, onsubmit: (e) => { e.preventDefault(); const text = input.value; input.value = ''; add({ ...(typeof fields === 'function' ? fields() : fields), text }); } },
      input, h('button', { class: 'icon-btn', type: 'submit', 'aria-label': '추가' }, icon('plus', 18)));
  }

  async function openSource(card) {
    const m = await data.getMessage(card.msgId);
    if (!m || !data.nodes.has(m.roomId)) return toast('원본 메시지를 이 기기에서 찾을 수 없습니다.', 'warn');
    ctx.jumpTo(m.roomId, m.id);
  }

  function meta(card) {
    const bits = [
      card.ai ? h('span', { class: 'card-chip ai', title: 'AI가 대화를 정리해 만든 카드 (실제 발언이 아님)' }, '✨ AI 정리') : null,
      card.msgId ? h('button', { class: 'card-chip link', title: '원본 메시지로 이동', onclick: (e) => { e.stopPropagation(); openSource(card); } }, `💬 ${card.sourceAuthor || '원본'}`) : null,
      card.status && view !== 'kanban' ? h('span', { class: `card-chip st-${card.status}` }, STATUS[card.status]) : null,
      card.stance && view !== 'debate' ? h('span', { class: 'card-chip' }, STANCE[card.stance]) : null,
    ].filter(Boolean);
    return bits.length ? h('div', { class: 'card-meta' }, bits) : null;
  }

  /** 카드 하나. extra: 보기마다 붙이는 버튼들 */
  function cardEl(card, { extra = null, cls = '', clamp = false } = {}) {
    const node = h('div', {
      class: `card ${cls}${clamp ? ' clamp' : ''}`, dataset: { id: card.id }, tabindex: '0', style: card.color ? { '--card-color': card.color } : null,
      onclick: (e) => { if (!e.target.closest('button, a, input, select') && !dragging) editDialog(card); },
      onkeydown: (e) => { if (e.key === 'Enter' && e.target === node) editDialog(card); },
    }, h('div', { class: 'card-text', html: renderMarkdown(card.text || '', { me: data.me }) }), meta(card), extra);
    return node;
  }

  function editDialog(card) {
    if (!host.canEdit) return;
    const text = h('textarea', { class: 'input', rows: '4', maxlength: '2000', autofocus: true }, card.text || '');
    let color = card.color || null;
    const swatches = h('div', { class: 'swatches' });
    const paint = () => swatches.replaceChildren(...[null, ...NOTE_COLORS].map((c) => h('button', {
      type: 'button', class: `swatch-btn${c === color ? ' active' : ''}`, style: c ? { background: c } : null, title: c || '색 없음', 'aria-label': c || '색 없음', onclick: () => { color = c; paint(); },
    }, c ? '' : '×')));
    paint();
    const sel = (opts, value) => h('select', { class: 'input' }, h('option', { value: '' }, '없음'), Object.entries(opts).map(([k, l]) => h('option', { value: k, selected: value === k }, l)));
    const status = sel(STATUS, card.status);
    const stance = sel(STANCE, card.stance);
    const d = new Date(timeOf(card) - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16);
    const date = h('input', { class: 'input', type: 'datetime-local', value: d });
    const parents = cards().filter((c) => c.id !== card.id && !isUnder(c, card.id));
    const parent = h('select', { class: 'input' }, h('option', { value: '' }, '(최상위)'), parents.map((c) => h('option', { value: c.id, selected: c.id === card.parentId }, (c.text || '').replace(/\s+/g, ' ').slice(0, 40))));
    openModal({
      title: '카드 편집',
      body: [field('내용', text), field('색', swatches),
        h('div', { class: 'row gap two-col' }, field('상태 (칸반)', status), field('입장 (토론)', stance)),
        h('div', { class: 'row gap two-col' }, field('날짜 (타임라인)', date), field('상위 카드 (트리 · 마인드맵 · 브랜치)', parent)),
        card.msgId ? h('p', { class: 'muted small' }, `💬 ${card.sourceAuthor || ''}님의 메시지에서 만든 카드입니다. 원본 메시지는 그대로 남아 있습니다.`) : null],
      actions: [
        { label: '삭제', kind: 'danger-ghost', onClick: () => { removeCard(card); } },
        { label: '취소' },
        {
          label: '저장', kind: 'primary', submit: true,
          onClick: () => {
            const t = new Date(date.value).getTime();
            put({
              id: card.id, text: text.value.trim().slice(0, 2000), color, status: status.value || null, stance: stance.value || null, parentId: parent.value || null,
              ...(Number.isFinite(t) && Math.abs(t - timeOf(card)) > 60_000 ? { date: t } : {}),
            });
          },
        },
      ],
    });
  }
  const isUnder = (c, ancestorId) => { for (let p = c; p; p = host.items.get(p.parentId)) if (p.parentId === ancestorId) return true; return false; };

  async function removeCard(card) {
    const n = cards().filter((c) => isUnder(c, card.id)).length;
    if (n && !(await confirmDialog({ title: '카드 삭제', message: `하위 카드 ${n}개도 함께 삭제됩니다. 삭제할까요?`, confirmText: '삭제', danger: true }))) return;
    guard(() => data.deleteWs(host.roomId, [card.id]))();
  }

  const btn = (ic, title, fn) => h('button', { class: 'icon-btn tiny', type: 'button', title, 'aria-label': title, onclick: (e) => { e.stopPropagation(); fn(e); } }, icon(ic, 15));
  function addChildPrompt(parent, fields = {}) {
    const input = h('input', { class: 'input', maxlength: '2000', autofocus: true, placeholder: '내용' });
    openModal({
      title: parent ? '하위 카드 추가' : '카드 추가',
      body: [parent ? h('p', { class: 'muted small ellipsis' }, `↳ ${(parent.text || '').slice(0, 80)}`) : null, input],
      actions: [{ label: '취소' }, { label: '추가', kind: 'primary', submit: true, onClick: () => { add({ parentId: parent?.id || null, ...fields, text: input.value }); if (parent) collapsed.delete(parent.id); } }],
    });
  }
  const empty = (text) => h('div', { class: 'empty' }, h('div', { class: 'board-empty-emoji' }, BOARD_VIEWS[view].emoji), h('h3', {}, '아직 카드가 없습니다'), h('p', { class: 'muted' }, text));

  // ───────── 1. 트리 ─────────
  function renderTree() {
    const row = (card, depth) => {
      const kids = kidsOf(card.id);
      const open = !collapsed.has(card.id);
      const r = h('div', {
        class: 'tree-card-row', style: { paddingLeft: `${depth * 22}px` }, draggable: host.canEdit && !isTouch() ? 'true' : null,
        ondragstart: (e) => { e.dataTransfer.setData('text/x-card', card.id); e.stopPropagation(); },
        ondragover: (e) => { if (e.dataTransfer.types.includes('text/x-card')) { e.preventDefault(); r.classList.add('drop'); } },
        ondragleave: () => r.classList.remove('drop'),
        ondrop: (e) => {
          r.classList.remove('drop');
          const id = e.dataTransfer.getData('text/x-card');
          const moved = host.items.get(id);
          if (!moved || id === card.id) return;
          e.preventDefault(); e.stopPropagation();
          if (isUnder(card, id)) return toast('카드를 자기 하위 카드 안으로 옮길 수 없습니다.', 'warn');
          put({ id, parentId: card.id });
        },
      },
      kids.length ? h('button', { class: 'icon-btn tiny', 'aria-label': open ? '접기' : '펼치기', 'aria-expanded': String(open), onclick: () => { if (open) collapsed.add(card.id); else collapsed.delete(card.id); render(); } }, icon(open ? 'chevronDown' : 'chevron', 14))
        : h('span', { class: 'tree-bullet' }, '•'),
      cardEl(card, { cls: 'flat', extra: host.canEdit ? h('div', { class: 'card-tools' }, btn('plus', '하위 카드 추가', () => addChildPrompt(card)), btn('trash', '삭제', () => removeCard(card))) : null }),
      kids.length && !open ? h('span', { class: 'muted small' }, `+${kids.length}`) : null);
      return [r, ...(open ? kids.flatMap((k) => row(k, depth + 1)) : [])];
    };
    const list = roots();
    const box = h('div', { class: 'view-tree' }, list.length ? list.flatMap((c) => row(c, 0)) : empty('주제를 적고, 그 아래에 하위 주제와 의견을 달아 보세요. 카드를 끌어 다른 카드 위에 놓으면 그 아래로 들어갑니다.'),
      quickAdd('새 주제 추가 (Enter)', {}));
    box.addEventListener('dragover', (e) => { if (e.dataTransfer.types.includes('text/x-card')) e.preventDefault(); });
    box.addEventListener('drop', (e) => { const id = e.dataTransfer.getData('text/x-card'); if (id && host.items.get(id)?.parentId) { e.preventDefault(); put({ id, parentId: null }); } });
    return box;
  }

  // ───────── 2. 포스트잇 ─────────
  function renderSticky() {
    const list = cards().sort(byOrder);
    const pos = new Map(list.map((c, i) => [c.id, { x: c.x ?? 24 + (i % 5) * 204, y: c.y ?? 24 + Math.floor(i / 5) * 156 }]));
    const W = Math.max(1600, ...[...pos.values()].map((p) => p.x + 600));
    const H = Math.max(1000, ...[...pos.values()].map((p) => p.y + 500));
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'links');
    svg.setAttribute('width', W); svg.setAttribute('height', H);
    const canvas = h('div', { class: 'sticky-canvas', style: { width: `${W}px`, height: `${H}px`, transform: `scale(${zoom})` } }, svg);
    const notes = new Map();
    const drawLinks = () => {
      svg.replaceChildren();
      for (const c of list) {
        const a = notes.get(c.parentId); const b = notes.get(c.id);
        if (!a || !b) continue;
        const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
        line.setAttribute('x1', a.offsetLeft + a.offsetWidth / 2); line.setAttribute('y1', a.offsetTop + a.offsetHeight / 2);
        line.setAttribute('x2', b.offsetLeft + b.offsetWidth / 2); line.setAttribute('y2', b.offsetTop + b.offsetHeight / 2);
        svg.append(line);
      }
    };
    for (const c of list) {
      const p = pos.get(c.id);
      const note = cardEl(c, { cls: 'note', extra: host.canEdit ? h('div', { class: 'card-tools' }, btn('plus', '연결된 메모 추가', () => addChildPrompt(c, { x: p.x + 40, y: p.y + 150, color: c.color })), btn('trash', '삭제', () => removeCard(c))) : null });
      note.style.left = `${p.x}px`; note.style.top = `${p.y}px`;
      if (!c.color) note.style.setProperty('--card-color', NOTE_COLORS[0]);
      if (host.canEdit) {
        note.addEventListener('pointerdown', (e) => {
          if (e.button !== 0 || e.target.closest('button, a')) return;
          const sx = e.clientX; const sy = e.clientY; const ox = p.x; const oy = p.y;
          let moved = false;
          note.setPointerCapture(e.pointerId);
          const move = (ev) => {
            const dx = (ev.clientX - sx) / zoom; const dy = (ev.clientY - sy) / zoom;
            if (!moved && Math.hypot(dx, dy) < 4) return;
            moved = true; dragging = true;
            p.x = Math.max(0, Math.round(ox + dx)); p.y = Math.max(0, Math.round(oy + dy));
            note.style.left = `${p.x}px`; note.style.top = `${p.y}px`;
            note.classList.add('moving');
            drawLinks();
          };
          const up = () => {
            note.removeEventListener('pointermove', move);
            note.classList.remove('moving');
            if (moved) { put({ id: c.id, x: p.x, y: p.y }); setTimeout(() => { dragging = false; }, 50); }
          };
          note.addEventListener('pointermove', move);
          note.addEventListener('pointerup', up, { once: true });
          note.addEventListener('pointercancel', up, { once: true });
        });
      }
      notes.set(c.id, note);
      canvas.append(note);
    }
    if (host.canEdit) {
      canvas.addEventListener('dblclick', (e) => {
        if (e.target !== canvas && e.target !== svg) return;
        const r = canvas.getBoundingClientRect();
        addChildPrompt(null, { x: Math.round((e.clientX - r.left) / zoom - 80), y: Math.round((e.clientY - r.top) / zoom - 30), color: NOTE_COLORS[cards().length % 6] });
      });
    }
    requestAnimationFrame(drawLinks);
    return h('div', { class: 'view-sticky' },
      h('div', { class: 'view-tools' }, quickAdd('메모 추가 (Enter) · 빈 곳을 두 번 눌러도 됩니다', () => ({ x: 40 + (cards().length % 6) * 30, y: 40 + (cards().length % 6) * 30, color: NOTE_COLORS[cards().length % 6] })), zoomTools()),
      h('div', { class: 'canvas-scroll' }, canvas, list.length ? null : h('div', { class: 'canvas-hint muted' }, '메모를 추가하고 끌어서 자유롭게 배치하세요.')));
  }
  function zoomTools() {
    const set = (z) => { zoom = Math.min(1.5, Math.max(0.4, Math.round(z * 10) / 10)); render(); };
    return h('div', { class: 'zoom-tools' }, btn('x', '축소', () => set(zoom - 0.1)), h('span', { class: 'muted small' }, `${Math.round(zoom * 100)}%`), btn('plus', '확대', () => set(zoom + 0.1)));
  }

  // ───────── 3. 마인드맵 ─────────
  function renderMindmap() {
    const ROW = 62; const COL = 250; const NW = 200;
    const room = data.nodes.get(host.roomId);
    const nodes = [];
    let leaf = 0;
    const place = (card, depth, kids) => {
      const node = { card, depth, kids: [] };
      const open = !card || !collapsed.has(card.id);
      node.kids = open ? kids.map((k) => place(k, depth + 1, kidsOf(k.id))) : [];
      node.y = node.kids.length ? (node.kids[0].y + node.kids.at(-1).y) / 2 : leaf++ * ROW;
      node.hidden = open ? 0 : kids.length;
      nodes.push(node);
      return node;
    };
    const root = place(null, 0, roots());
    const W = (Math.max(...nodes.map((n) => n.depth)) + 1) * COL + 80;
    const H = Math.max(leaf, 1) * ROW + 40;
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'links'); svg.setAttribute('width', W); svg.setAttribute('height', H);
    const canvas = h('div', { class: 'mind-canvas', style: { width: `${W}px`, height: `${H}px`, transform: `scale(${zoom})` } }, svg);
    const colorOf = (n, i) => n.card?.color || LANE_COLORS[i % LANE_COLORS.length];
    const draw = (n, color) => {
      const x = 20 + n.depth * COL; const y = 20 + n.y;
      n.kids.forEach((k, i) => {
        const c = n.depth === 0 ? colorOf(k, i) : color;
        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        const x1 = x + NW; const x2 = 20 + k.depth * COL; const y2 = 20 + k.y + 22;
        path.setAttribute('d', `M ${x1} ${y + 22} C ${x1 + 30} ${y + 22}, ${x2 - 30} ${y2}, ${x2} ${y2}`);
        path.setAttribute('stroke', c);
        svg.append(path);
        draw(k, c);
      });
      const tools = host.canEdit ? h('div', { class: 'card-tools' }, btn('plus', '가지 추가', () => addChildPrompt(n.card)), n.card ? btn('trash', '삭제', () => removeCard(n.card)) : null) : null;
      const box = n.card
        ? cardEl(n.card, { cls: 'mind-node', clamp: true, extra: [tools, n.hidden ? h('button', { class: 'mind-more', onclick: (e) => { e.stopPropagation(); collapsed.delete(n.card.id); render(); } }, `+${n.hidden}`) : n.kids.length ? h('button', { class: 'mind-more', title: '접기', onclick: (e) => { e.stopPropagation(); collapsed.add(n.card.id); render(); } }, '−') : null] })
        : h('div', { class: 'card mind-node mind-root' }, h('div', { class: 'card-text' }, room?.name || '주제'), tools);
      box.style.left = `${x}px`; box.style.top = `${y}px`; box.style.width = `${NW}px`;
      if (n.card && !n.card.color) box.style.setProperty('--card-color', color);
      canvas.append(box);
    };
    draw(root, LANE_COLORS[0]);
    return h('div', { class: 'view-mindmap' },
      h('div', { class: 'view-tools' }, quickAdd('가지 추가 (Enter)', {}), zoomTools()),
      h('div', { class: 'canvas-scroll' }, canvas));
  }

  // ───────── 4. 브랜치 (갈라지는 논의) ─────────
  function renderBranch() {
    // 시간 순서로 놓되, 상위 카드가 항상 먼저 오게
    const key = new Map();
    const keyOf = (c) => { if (!key.has(c.id)) { key.set(c.id, 0); const p = c.parentId && host.items.get(c.parentId); key.set(c.id, Math.max(timeOf(c), p ? keyOf(p) + 1 : 0)); } return key.get(c.id); };
    const list = cards().sort((a, b) => keyOf(a) - keyOf(b) || byOrder(a, b));
    if (!list.length) return h('div', { class: 'view-branch' }, empty('이야기를 적으면 본줄기로 이어지고, 카드의 "가지 치기"로 그 지점에서 갈라지는 논의를 만들 수 있습니다.'), quickAdd('본줄기에 이어 쓰기 (Enter)', {}));
    const lane = new Map();
    const first = new Map(); // 상위 카드 → 그 가지를 이어받는 첫 하위 카드
    // 최상위 카드는 시간 순서대로 이어지는 본줄기(가지 1), 하위 카드는 거기서 갈라져 나온 가지
    let lanes = 1;
    let trunk = null;
    const prevOf = new Map(); // 선으로 이어질 앞 카드
    for (const c of list) {
      const p = c.parentId && host.items.has(c.parentId) ? c.parentId : null;
      if (!p) { lane.set(c.id, 0); if (trunk) prevOf.set(c.id, trunk); trunk = c.id; continue; }
      prevOf.set(c.id, p);
      if (lane.get(p) !== 0 && !first.has(p)) { first.set(p, c.id); lane.set(c.id, lane.get(p)); } else lane.set(c.id, lanes++);
    }
    const ROW = 72; const LW = 22; const pad = 16;
    const gx = (l) => pad + l * LW; const gy = (i) => i * ROW + 30;
    const index = new Map(list.map((c, i) => [c.id, i]));
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    const sw = pad * 2 + Math.max(lanes - 1, 0) * LW;
    svg.setAttribute('class', 'branch-graph'); svg.setAttribute('width', sw); svg.setAttribute('height', list.length * ROW);
    for (const c of list) {
      const l = lane.get(c.id); const i = index.get(c.id);
      const color = LANE_COLORS[l % LANE_COLORS.length];
      if (prevOf.has(c.id)) {
        const pl = lane.get(prevOf.get(c.id)); const pi = index.get(prevOf.get(c.id));
        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path.setAttribute('d', pl === l ? `M ${gx(l)} ${gy(pi)} L ${gx(l)} ${gy(i)}` : `M ${gx(pl)} ${gy(pi)} C ${gx(pl)} ${gy(pi) + 34}, ${gx(l)} ${gy(pi) + 10}, ${gx(l)} ${gy(pi) + 44} L ${gx(l)} ${gy(i)}`);
        path.setAttribute('stroke', color);
        svg.append(path);
      }
      const dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      dot.setAttribute('cx', gx(l)); dot.setAttribute('cy', gy(i)); dot.setAttribute('r', 5.5);
      dot.setAttribute('fill', color);
      svg.append(dot);
    }
    const rows = list.map((c) => {
      const l = lane.get(c.id);
      const forked = prevOf.has(c.id) && lane.get(prevOf.get(c.id)) !== l;
      const label = l === 0 ? '본줄기' : forked ? `가지 ${l} 시작` : `가지 ${l}`;
      return h('div', { class: 'branch-row', style: { height: `${ROW}px` } },
        cardEl(c, {
          cls: 'flat', clamp: true,
          extra: h('div', { class: 'card-tools always' },
            h('span', { class: 'branch-tag', style: { background: LANE_COLORS[l % LANE_COLORS.length] } }, label),
            h('span', { class: 'muted small' }, fmtStamp(timeOf(c))),
            host.canEdit ? h('button', { class: 'link-btn small', onclick: (e) => { e.stopPropagation(); addChildPrompt(c); } }, l === 0 || first.has(c.id) ? '⑂ 가지 치기' : '↳ 이어 쓰기') : null),
        }));
    });
    return h('div', { class: 'view-branch' },
      h('div', { class: 'branch-wrap' }, svg, h('div', { class: 'branch-rows', style: { marginLeft: `${sw}px` } }, rows)),
      quickAdd('본줄기에 이어 쓰기 (Enter)', {}));
  }

  // ───────── 5. 칸반 ─────────
  function renderKanban() {
    const all = cards().sort(byOrder);
    const loose = all.filter((c) => !c.status);
    const cols = [...(loose.length ? [[null, '미분류']] : []), ...Object.entries(STATUS)];
    const order = Object.keys(STATUS);
    return h('div', { class: 'view-kanban' }, cols.map(([st, label]) => {
      const list = st ? all.filter((c) => c.status === st) : loose;
      const col = h('div', {
        class: `kanban-col st-${st || 'none'}`,
        ondragover: (e) => { if (e.dataTransfer.types.includes('text/x-card')) { e.preventDefault(); col.classList.add('drop'); } },
        ondragleave: (e) => { if (!col.contains(e.relatedTarget)) col.classList.remove('drop'); },
        ondrop: (e) => { col.classList.remove('drop'); const id = e.dataTransfer.getData('text/x-card'); if (id && host.items.get(id)?.status !== st) { e.preventDefault(); put({ id, status: st }); } },
      },
      h('div', { class: 'kanban-head' }, h('strong', {}, label), h('span', { class: 'muted small' }, String(list.length))),
      h('div', { class: 'kanban-list' }, list.map((c) => {
        const i = order.indexOf(c.status);
        const node = cardEl(c, {
          extra: host.canEdit ? h('div', { class: 'card-tools always' },
            i > 0 ? btn('chevronLeft', `${STATUS[order[i - 1]]}(으)로`, () => put({ id: c.id, status: order[i - 1] })) : null,
            i < order.length - 1 ? btn('chevron', `${STATUS[order[i + 1]]}(으)로`, () => put({ id: c.id, status: order[i + 1] })) : null,
            h('span', { class: 'grow' }), btn('trash', '삭제', () => removeCard(c))) : null,
        });
        if (host.canEdit && !isTouch()) { node.draggable = true; node.addEventListener('dragstart', (e) => e.dataTransfer.setData('text/x-card', c.id)); }
        return node;
      })),
      st ? quickAdd(`${label} 추가`, { status: st }) : null);
      return col;
    }));
  }

  // ───────── 6. 타임라인 ─────────
  function renderTimeline() {
    const list = cards().sort((a, b) => timeOf(a) - timeOf(b));
    const out = [];
    let prev = null;
    for (const c of list) {
      if (!prev || !sameDay(timeOf(prev), timeOf(c))) out.push(h('div', { class: 'tl-day' }, fmtDate(timeOf(c))));
      out.push(h('div', { class: 'tl-item' }, h('time', { class: 'tl-time muted small' }, fmtTime(timeOf(c))), h('span', { class: 'tl-dot', style: c.color ? { background: c.color } : null }),
        cardEl(c, { cls: 'flat', extra: host.canEdit ? h('div', { class: 'card-tools' }, btn('trash', '삭제', () => removeCard(c))) : null })));
      prev = c;
    }
    return h('div', { class: 'view-timeline' }, list.length ? h('div', { class: 'tl-line' }, out) : empty('결정 · 사건 · 일정을 적으면 날짜 순서로 정리됩니다. 카드를 눌러 날짜를 바꿀 수 있어요.'),
      quickAdd('지금 시각으로 추가 (Enter)', () => ({ date: Date.now() })));
  }

  // ───────── 7. 토론 (찬성 · 반대) ─────────
  function renderDebate() {
    const topics = roots();
    return h('div', { class: 'view-debate' }, topics.length ? topics.map((t) => {
      const kids = kidsOf(t.id);
      const of = (s) => kids.filter((k) => (k.stance || 'neutral') === s);
      const pro = of('pro').length; const con = of('con').length;
      return h('section', { class: 'debate-topic' },
        cardEl(t, { cls: 'flat debate-q', extra: host.canEdit ? h('div', { class: 'card-tools' }, btn('trash', '삭제', () => removeCard(t))) : null }),
        pro + con ? h('div', { class: 'debate-bar', title: `찬성 ${pro} · 반대 ${con}` }, h('span', { class: 'pro', style: { flex: pro || 0.001 } }, pro ? `${pro}` : ''), h('span', { class: 'con', style: { flex: con || 0.001 } }, con ? `${con}` : '')) : null,
        h('div', { class: 'debate-cols' }, Object.entries(STANCE).map(([s, label]) => h('div', { class: `debate-col ${s}` },
          h('div', { class: 'kanban-head' }, h('strong', {}, label), h('span', { class: 'muted small' }, String(of(s).length))),
          of(s).map((c) => cardEl(c, { extra: host.canEdit ? h('div', { class: 'card-tools' }, btn('trash', '삭제', () => removeCard(c))) : null })),
          quickAdd('의견 추가', { parentId: t.id, stance: s })))));
    }) : empty('쟁점(질문)을 적고, 찬성 · 반대 의견을 나눠 적어 보세요.'), quickAdd('새 쟁점 추가 (Enter)', {}, 'wide'));
  }

  // ───────── 8. 표 ─────────
  let sort = { key: 'order', dir: 1 };
  function renderTable() {
    const list = cards();
    if (!list.length) return h('div', { class: 'view-table' }, empty('카드를 한 줄씩 표로 봅니다. 상태 · 입장 · 날짜를 표에서 바로 고칠 수 있어요.'), quickAdd('새 카드 추가 (Enter)', {}, 'wide'));
    const val = {
      order: (c) => c.order || 0, text: (c) => (c.text || '').toLowerCase(), status: (c) => Object.keys(STATUS).indexOf(c.status),
      stance: (c) => Object.keys(STANCE).indexOf(c.stance), date: timeOf, parent: (c) => (host.items.get(c.parentId)?.text || '').toLowerCase(),
    };
    const get = val[sort.key] || val.order;
    list.sort((a, b) => { const x = get(a); const y = get(b); return (x < y ? -1 : x > y ? 1 : 0) * sort.dir || byOrder(a, b); });
    const th = (key, label) => h('th', { scope: 'col', 'aria-sort': sort.key === key ? (sort.dir > 0 ? 'ascending' : 'descending') : 'none' },
      h('button', { type: 'button', class: 'th-btn', onclick: () => { sort = { key, dir: sort.key === key ? -sort.dir : 1 }; render(); } }, label, sort.key === key ? (sort.dir > 0 ? ' ▲' : ' ▼') : ''));
    const pick = (opts, value, onPick, label) => (host.canEdit
      ? h('select', { class: 'input cell-sel', 'aria-label': label, onchange: (e) => onPick(e.target.value || null) }, h('option', { value: '' }, '—'), Object.entries(opts).map(([k, l]) => h('option', { value: k, selected: value === k }, l)))
      : h('span', {}, opts[value] || '—'));
    const day = (t) => new Date(t - new Date(t).getTimezoneOffset() * 60000).toISOString().slice(0, 10);
    return h('div', { class: 'view-table' },
      h('div', { class: 'table-scroll' }, h('table', { class: 'card-table' },
        h('thead', {}, h('tr', {}, th('text', '내용'), th('status', '상태'), th('stance', '입장'), th('date', '날짜'), th('parent', '상위 카드'), h('th', {}))),
        h('tbody', {}, list.map((c) => h('tr', { dataset: { id: c.id } },
          h('td', { class: 'cell-text', onclick: () => editDialog(c) }, c.color ? h('span', { class: 'cell-dot', style: { background: c.color } }) : null, (c.text || '').replace(/\s+/g, ' ').slice(0, 200)),
          h('td', {}, pick(STATUS, c.status, (v) => put({ id: c.id, status: v }), '상태')),
          h('td', {}, pick(STANCE, c.stance, (v) => put({ id: c.id, stance: v }), '입장')),
          h('td', {}, host.canEdit ? h('input', {
            class: 'input cell-sel', type: 'date', value: day(timeOf(c)), 'aria-label': '날짜',
            onchange: (e) => { const [y, m, d] = e.target.value.split('-').map(Number); if (y) { const old = new Date(timeOf(c)); put({ id: c.id, date: new Date(y, m - 1, d, old.getHours(), old.getMinutes()).getTime() }); } },
          }) : fmtDate(timeOf(c))),
          h('td', { class: 'muted small ellipsis cell-parent' }, (host.items.get(c.parentId)?.text || '').replace(/\s+/g, ' ').slice(0, 40)),
          h('td', {}, host.canEdit ? btn('trash', '삭제', () => removeCard(c)) : null)))))),
      quickAdd('새 카드 추가 (Enter)', {}, 'wide'));
  }

  // ───────── 9. 달력 ─────────
  let month = null; // 보고 있는 달의 1일
  function renderCalendar() {
    if (!month) { const n = new Date(); month = new Date(n.getFullYear(), n.getMonth(), 1); }
    const y = month.getFullYear(); const mo = month.getMonth();
    const first = new Date(y, mo, 1);
    const start = new Date(y, mo, 1 - first.getDay());
    const today = new Date();
    const all = cards();
    const cells = [];
    for (let i = 0; i < 42; i += 1) {
      const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
      if (i >= 35 && d.getMonth() !== mo) break;
      const mine = all.filter((c) => sameDay(timeOf(c), d.getTime())).sort((a, b) => timeOf(a) - timeOf(b));
      const at = () => { const n = new Date(); return new Date(d.getFullYear(), d.getMonth(), d.getDate(), n.getHours(), n.getMinutes()).getTime(); };
      cells.push(h('div', {
        class: `cal-cell${d.getMonth() !== mo ? ' other' : ''}${sameDay(d.getTime(), today.getTime()) ? ' today' : ''}`, dataset: { day: `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}` },
        ondragover: (e) => { if (host.canEdit && e.dataTransfer.types.includes('text/x-card')) e.preventDefault(); },
        ondrop: (e) => { const c = host.items.get(e.dataTransfer.getData('text/x-card')); if (c) { const old = new Date(timeOf(c)); put({ id: c.id, date: new Date(d.getFullYear(), d.getMonth(), d.getDate(), old.getHours(), old.getMinutes()).getTime() }); } },
      },
      h('div', { class: 'cal-day' }, h('span', {}, String(d.getDate())), host.canEdit ? btn('plus', `${d.getMonth() + 1}월 ${d.getDate()}일에 카드 추가`, () => addChildPrompt(null, { date: at() })) : null),
      mine.slice(0, 4).map((c) => h('button', {
        type: 'button', class: `cal-card st-${c.status || 'none'}`, title: c.text || '', style: c.color ? { borderLeftColor: c.color } : null,
        draggable: host.canEdit && !isTouch() ? 'true' : null, ondragstart: (e) => e.dataTransfer.setData('text/x-card', c.id),
        onclick: () => editDialog(c),
      }, (c.text || '').replace(/\s+/g, ' ').slice(0, 40))),
      mine.length > 4 ? h('span', { class: 'muted small' }, `+${mine.length - 4}개`) : null));
    }
    const go = (n) => { month = new Date(y, mo + n, 1); render(); };
    return h('div', { class: 'view-calendar' },
      h('div', { class: 'cal-head' },
        h('button', { class: 'icon-btn', type: 'button', 'aria-label': '이전 달', onclick: () => go(-1) }, icon('chevronLeft')),
        h('strong', { class: 'cal-title' }, `${y}년 ${mo + 1}월`),
        h('button', { class: 'icon-btn', type: 'button', 'aria-label': '다음 달', onclick: () => go(1) }, icon('chevron')),
        h('button', { class: 'btn small ghost', type: 'button', onclick: () => { month = null; render(); } }, '오늘')),
      h('div', { class: 'cal-grid' }, ['일', '월', '화', '수', '목', '금', '토'].map((w) => h('div', { class: 'cal-week muted small' }, w)), cells));
  }

  // ───────── 템플릿: 보드의 카드 구조를 파일로 내보내고 다른 보드에 가져오기 ─────────
  const TEMPLATE_FIELDS = ['text', 'color', 'status', 'stance', 'x', 'y', 'order'];
  function exportTemplate() {
    const list = cards().sort(byOrder);
    const tpl = { type: 'chat-site-board', version: 1, name: data.nodes.get(host.roomId)?.name || '', view, cards: list.map((c) => ({ key: c.id, parent: c.parentId && host.items.has(c.parentId) ? c.parentId : null, ...Object.fromEntries(TEMPLATE_FIELDS.filter((k) => c[k] != null).map((k) => [k, c[k]])) })) };
    const a = h('a', { href: URL.createObjectURL(new Blob([JSON.stringify(tpl, null, 2)], { type: 'application/json' })), download: `${tpl.name || 'board'}.board.json` });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
  }
  function importTemplate() {
    const input = h('input', { type: 'file', accept: '.json,application/json', hidden: true });
    input.addEventListener('change', guard(async () => {
      const file = input.files[0];
      input.remove();
      if (!file) return;
      let tpl;
      try { tpl = JSON.parse(await file.text()); } catch { tpl = null; }
      const src = Array.isArray(tpl?.cards) ? tpl.cards.filter((c) => c && typeof c.text === 'string' && c.text.trim()).slice(0, 500) : [];
      if (tpl?.type !== 'chat-site-board' || !src.length) { toast('보드 템플릿 파일이 아닙니다. (보드 메뉴의 "템플릿으로 내보내기"로 만든 .board.json 파일)', 'warn'); return; }
      const ids = new Map(src.map((c) => [c.key, uid()]));
      const t = Date.now();
      const sorted = [...src].sort((a, b) => (a.order || 0) - (b.order || 0));
      await data.putWsMany(host.roomId, sorted.map((c, i) => ({
        id: ids.get(c.key), kind: 'card', text: c.text.trim().slice(0, 2000), parentId: ids.get(c.parent) || null, order: t + i, date: t + i,
        ...(typeof c.color === 'string' && /^#[0-9a-f]{3,8}$/i.test(c.color) ? { color: c.color } : {}),
        ...(STATUS[c.status] ? { status: c.status } : {}), ...(STANCE[c.stance] ? { stance: c.stance } : {}),
        ...(Number.isFinite(c.x) && Number.isFinite(c.y) ? { x: c.x, y: c.y } : {}),
      })));
      toast(`카드 ${src.length}개를 가져왔습니다.`, 'success');
    }));
    document.body.append(input);
    input.click();
  }

  const RENDER = {
    tree: renderTree, sticky: renderSticky, mindmap: renderMindmap, branch: renderBranch, kanban: renderKanban, timeline: renderTimeline, debate: renderDebate, table: renderTable, calendar: renderCalendar,
  };

  function render() {
    const room = data.nodes.get(host.roomId);
    view = boardKind(room);
    tabs.replaceChildren(h('span', { class: 'board-kind', title: BOARD_VIEWS[view].desc },
      h('span', { 'aria-hidden': 'true' }, BOARD_VIEWS[view].emoji), ` ${BOARD_VIEWS[view].label} 보드`),
    h('span', { class: 'muted small board-kind-desc ellipsis' }, BOARD_VIEWS[view].desc),
    h('span', { class: 'grow' }),
    h('span', { class: 'muted small board-count' }, `카드 ${cards().length}개`),
    host.canEdit ? h('button', { class: 'btn small secondary', title: '이 방의 채팅 내용을 카드로 가져오기', onclick: () => convertDialog(ctx, { roomId: host.roomId, target: host.roomId }) }, icon('message', 14), ' 대화에서 가져오기') : null,
    h('button', {
      class: 'icon-btn', 'aria-label': '보드 메뉴', onclick: (e) => openMenu(e.currentTarget, [
        { label: '카드 내용 복사 (목록)', icon: 'copy', onClick: () => navigator.clipboard?.writeText(outline()).then(() => toast('복사했습니다.')) },
        cards().length ? { label: '템플릿으로 내보내기 (.board.json)', icon: 'download', onClick: exportTemplate } : null,
        host.canEdit ? { label: '템플릿 가져오기', icon: 'plus', onClick: importTemplate } : null,
        data.can('sendMessage') ? { label: '정리한 내용을 채팅으로 보내기', icon: 'send', onClick: guard(async () => { await data.sendMessage(host.roomId, { content: `📋 **보드 정리**\n${outline()}`.slice(0, 4000) }); toast('채팅으로 보냈습니다.'); }) } : null,
        host.canEdit && cards().length ? { label: '카드 모두 지우기', icon: 'trash', danger: true, onClick: async () => { if (await confirmDialog({ title: '카드 모두 지우기', message: `카드 ${cards().length}개를 모두 지울까요? 원본 채팅 메시지는 지워지지 않습니다.`, confirmText: '지우기', danger: true })) guard(() => data.deleteWs(host.roomId, cards().map((c) => c.id)))(); } } : null,
      ]),
    }, icon('more')));
    const top = body.firstChild?.querySelector?.('.canvas-scroll');
    const keep = top ? [top.scrollLeft, top.scrollTop] : null;
    body.replaceChildren(RENDER[view]());
    const now = body.firstChild?.querySelector?.('.canvas-scroll');
    if (keep && now) { now.scrollLeft = keep[0]; now.scrollTop = keep[1]; }
  }

  /** 카드들을 들여쓴 글머리 목록으로 */
  function outline() {
    const walk = (c, d) => [`${'  '.repeat(d)}- ${(c.text || '').replace(/\s+/g, ' ')}${c.status ? ` [${STATUS[c.status]}]` : ''}`, ...kidsOf(c.id).flatMap((k) => walk(k, d + 1))];
    return roots().flatMap((c) => walk(c, 0)).join('\n');
  }

  return {
    el,
    open() { render(); },
    changed() { if (!dragging) render(); },
    close() {},
  };
}

// ───────── 대화 → 보드 변환 ─────────
/**
 * roomId: 원본 대화가 있는 방. messages: 변환할 메시지(없으면 최근 대화). target: 카드를 넣을 보드 방(없으면 고름).
 * 원본 메시지는 바꾸지 않고, 미리 본 뒤 고른 카드만 만듭니다.
 */
export async function convertDialog(ctx, { roomId, messages = null, target = null, tasks = false }) {
  const { data } = ctx;
  if (!data.can('editWorkspace')) return toast(errorText({ code: 'forbidden' }), 'warn');
  let source = messages;
  if (!source) {
    try { source = (await data.listMessages(roomId)).messages; } catch (e) { return toast(errorText(e), 'error'); }
  }
  source = source.filter((m) => !m.pending && !m.failed).sort((a, b) => a.createdAt - b.createdAt);
  if (!source.length) return toast('변환할 메시지가 없습니다. 먼저 채팅에서 이야기를 나눠 보세요.', 'warn');
  const boards = [...data.nodes.values()].filter((n) => n.type === 'board');
  const canCreate = data.can('manageNodes');
  if (!target && !boards.length && !canCreate) return toast('카드를 넣을 보드 방이 없습니다.', 'warn');

  let method = tasks ? 'tasks' : 'rule';
  let draft = null; // 미리 보기 카드 [{id, parentId, text, …, on}]
  const srcRoom = data.nodes.get(roomId);
  const viewSel = h('select', { class: 'input' }, Object.entries(BOARD_VIEWS).map(([k, v]) => h('option', { value: k }, `${v.emoji} ${v.label} — ${v.desc}`)));
  const targetSel = h('select', { class: 'input' }, canCreate ? h('option', { value: '' }, '＋ 새 보드 방 만들기') : null, boards.map((b) => h('option', { value: b.id, selected: b.id === target }, `${BOARD_VIEWS[boardKind(b)].emoji} ${b.name} (${BOARD_VIEWS[boardKind(b)].label})`)));
  const name = h('input', { class: 'input', maxlength: '100', value: `${data.roomLabel(srcRoom) || '대화'} 정리` });
  const nameField = h('div', {}, field('새 보드 종류', viewSel, '보드 종류는 만든 뒤에 바꿀 수 없습니다. 다른 형식이 필요하면 새 보드를 만드세요.'), field('새 보드 방 이름', name));
  // 카드를 넣을 보드의 종류 (기존 보드면 그 보드의 종류)
  const kindOfTarget = () => (targetSel.value ? boardKind(data.nodes.get(targetSel.value)) : viewSel.value);
  const methodRow = h('div', { class: 'tpl-picker' });
  const preview = h('div', { class: 'convert-preview' });
  const step2 = h('div', { hidden: true }, h('p', { class: 'muted small' }, '만들 카드를 확인하세요. 체크를 끄면 그 카드는 만들지 않습니다. 만든 뒤에도 자유롭게 고칠 수 있어요.'), preview);
  if (tasks) { viewSel.value = 'kanban'; name.value = `${data.roomLabel(srcRoom) || '대화'} 할 일`; }
  const syncTarget = () => { nameField.hidden = !!targetSel.value; };
  targetSel.addEventListener('change', syncTarget);
  syncTarget();
  const renderMethod = () => methodRow.replaceChildren(...[
    ['rule', '규칙으로 변환', '메시지마다 카드 하나, 답장은 하위 카드로'],
    ['tasks', '☑ 할 일만 뽑기', '해야 할 일 · 체크 목록을 찾아 칸반 카드로'],
    ...(data.aiEnabled ? [['ai', '✨ AI로 정리', '주제별로 묶고 할 일 · 찬반을 분류']] : []),
  ].map(([k, label, desc]) => h('button', { type: 'button', class: `type-opt${k === method ? ' active' : ''}`, onclick: () => { method = k; draft = null; step2.hidden = true; renderMethod(); } }, h('span', { class: 'type-name' }, label), h('span', { class: 'type-desc' }, desc))));
  renderMethod();

  const depthOf = (c) => { let d = 0; for (let p = draft.find((x) => x.id === c.parentId); p && d < 8; p = draft.find((x) => x.id === p.parentId)) d += 1; return d; };
  function renderPreview() {
    step2.hidden = false;
    preview.replaceChildren(...draft.map((c) => h('label', { class: 'convert-row', style: { paddingLeft: `${depthOf(c) * 18}px` } },
      h('input', { type: 'checkbox', checked: c.on !== false, onchange: (e) => { c.on = e.target.checked; } }),
      h('span', { class: 'grow' }, c.text),
      c.ai ? h('span', { class: 'card-chip ai', title: 'AI가 정리해 만든 카드' }, '✨') : c.sourceAuthor ? h('span', { class: 'card-chip' }, c.sourceAuthor) : null,
      c.status ? h('span', { class: `card-chip st-${c.status}` }, STATUS[c.status]) : null,
      c.stance ? h('span', { class: 'card-chip' }, STANCE[c.stance]) : null)));
    preview.scrollIntoView({ block: 'nearest' });
  }

  async function makeDraft() {
    if (method === 'ai') {
      preview.replaceChildren(h('div', { class: 'spinner' }), h('p', { class: 'muted small' }, 'AI가 대화를 읽고 정리하는 중…'));
      step2.hidden = false;
      const res = await data.aiBoard(roomId, { messageIds: messages ? source.map((m) => m.id) : null, view: kindOfTarget() });
      draft = draftToCards(res.cards);
      if (res.title && !targetSel.value && name.value.endsWith(' 정리')) name.value = res.title;
    } else if (method === 'tasks') {
      draft = messagesToTasks(source, { nameOf: (m) => (data.user(m.authorId) || m.author)?.nickname || '' });
      if (!draft.length) { draft = null; step2.hidden = true; toast('할 일처럼 보이는 메시지를 찾지 못했습니다. ("~해야 해", "- [ ] 할 일" 같은 표현을 찾습니다)', 'warn'); return; }
      if (!targetSel.value) viewSel.value = 'kanban';
    } else draft = messagesToCards(source, { nameOf: (m) => (data.user(m.authorId) || m.author)?.nickname || '' });
    renderPreview();
  }

  openModal({
    title: '대화를 보드로 변환',
    cls: 'convert-modal',
    body: [
      h('p', { class: 'muted small' }, `${srcRoom?.type === 'dm' ? '@' : '#'}${data.roomLabel(srcRoom)}의 메시지 ${source.length}개${messages ? ' (선택한 메시지)' : ' (최근 대화)'}를 카드로 만듭니다. 원본 메시지는 그대로 남고, 카드에서 원본으로 이동할 수 있습니다.`),
      h('div', { class: 'field' }, h('span', { class: 'field-label' }, '변환 방법'), methodRow),
      field('카드를 넣을 곳', targetSel), nameField, step2,
    ],
    actions: [
      { label: '취소' },
      {
        label: '미리 보기 → 만들기', kind: 'primary',
        onClick: async () => {
          try {
            if (!draft) { await makeDraft(); return false; } // 첫 번째: 미리 보기, 두 번째: 승인해서 만들기
            if (!draft) return false;
            const chosen = draft.filter((c) => c.on !== false);
            if (!chosen.length) { toast('만들 카드를 하나 이상 고르세요.', 'warn'); return false; }
            const ids = new Set(chosen.map((c) => c.id));
            let boardId = targetSel.value;
            if (!boardId) boardId = (await data.createNode({ type: 'board', name: name.value.trim() || '새 보드', parentId: srcRoom?.type === 'dm' ? null : srcRoom?.parentId ?? null, view: viewSel.value })).id;
            await data.putWsMany(boardId, chosen.map(({ on, ...c }) => ({ ...c, parentId: ids.has(c.parentId) ? c.parentId : null })));
            try { localStorage.removeItem('cs.boardView'); } catch { /* noop */ } // 예전 '보기 탭' 기억 값 정리
            toast(`카드 ${chosen.length}개를 만들었습니다.`, 'success');
            ctx.openRoom(boardId, { workspace: true, reload: true });
          } catch (e) {
            step2.hidden = !draft;
            toast(errorText(e), 'error');
            return false;
          }
        },
      },
    ],
  });
}
