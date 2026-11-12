// 대화 → 보드 카드 변환 (AI 없이, 규칙 기반). 원본 메시지는 그대로 두고 카드에 원본 링크(msgId)만 남깁니다.
import { uid } from './util.js';

const DONE = /(완료|끝났|끝냈|했어요|했습니다|해결|done|fixed)/i;
const DOING = /(하는 중|진행 중|작업 중|하고 있|doing|wip)/i;
const TODO = /(해야|[어아여]야\s?(해|함|돼|됨|한다|합니다|할|겠|지)|하자|합시다|할 일|할게|할께|해\s?줘|해\s?주세요|부탁|필요|todo|to-do|- \[ \])/i;
const PRO = /(찬성|동의|좋아|좋은|좋다|맞아|괜찮|\+1|👍)/;
const CON = /(반대|별로|안 돼|안돼|아닌 것|문제가|위험|걱정|-1|👎)/;

const short = (text) => {
  const t = (text || '').replace(/```[\s\S]*?```/g, ' [코드] ').replace(/\s+/g, ' ').trim();
  return t.length > 300 ? `${t.slice(0, 300)}…` : t;
};

/**
 * 메시지 목록(오래된 것부터) → 카드 목록.
 * - 답장 관계는 상위/하위 카드로 (트리 · 마인드맵 · 브랜치에서 구조가 됨)
 * - 할 일처럼 보이는 말은 칸반 상태로, 찬성/반대처럼 보이는 말은 토론 입장으로 (추정이므로 미리 보기에서 고칠 수 있음)
 * - 작성 시각은 타임라인 날짜로
 */
export function messagesToCards(messages, { nameOf = (m) => m.author?.nickname || '' } = {}) {
  const idOf = new Map();
  const cards = [];
  for (const m of messages) {
    const text = short(m.kind === 'poll' ? `📊 ${m.content}` : m.content) || ((m.attachments || []).length ? `📎 ${(m.attachments || []).map((a) => a.name).join(', ')}` : '');
    if (!text) continue;
    const id = uid();
    idOf.set(m.id, id);
    const raw = m.content || '';
    cards.push({
      id, kind: 'card', text, parentId: idOf.get(m.replyTo) || null, msgId: m.id, sourceAuthor: nameOf(m), date: m.createdAt, order: m.createdAt,
      status: DONE.test(raw) ? 'done' : DOING.test(raw) ? 'doing' : TODO.test(raw) ? 'todo' : null,
      stance: PRO.test(raw) && !CON.test(raw) ? 'pro' : CON.test(raw) && !PRO.test(raw) ? 'con' : null,
    });
  }
  return cards;
}

/**
 * 대화에서 할 일만 뽑기: 메시지를 줄 단위로 보고 할 일처럼 보이는 줄마다 카드 하나 (칸반 상태 포함).
 *  · '- [ ] 장보기' / '- [x] 예약' 같은 체크 목록, '~해야 해', '~하자', '~해 줘', 'TODO: …'
 *  · 맡을 사람을 @이름 으로 불렀으면 카드 앞에 표시
 */
export function messagesToTasks(messages, { nameOf = (m) => m.author?.nickname || '' } = {}) {
  const cards = [];
  for (const m of messages) {
    if (m.kind === 'poll' || !m.content) continue;
    for (const raw of m.content.replace(/```[\s\S]*?```/g, '').split('\n')) {
      const line = raw.trim();
      if (!line || line.length < 3) continue;
      const box = /^[-*]\s*\[( |x|X)\]\s*(.+)$/.exec(line);
      const status = box ? (box[1] === ' ' ? 'todo' : 'done') : DONE.test(line) ? 'done' : DOING.test(line) ? 'doing' : TODO.test(line) ? 'todo' : null;
      if (!status) continue;
      const body = short(box ? box[2] : line.replace(/^(todo|to-do|할 일)\s*[:：-]\s*/i, ''));
      if (!body) continue;
      const who = [...body.matchAll(/@([^\s@]{1,20})/g)].map((x) => x[1]).filter((n) => !['everyone', 'here'].includes(n));
      cards.push({ id: uid(), kind: 'card', text: who.length ? `👤 ${who.join(', ')} — ${body}` : body, parentId: null, msgId: m.id, sourceAuthor: nameOf(m), date: m.createdAt, order: m.createdAt + cards.length / 1000, status, stance: null });
    }
  }
  return cards;
}

/** AI 가 만든 초안(key/parent) → 저장할 카드(id/parentId) */
export function draftToCards(draft) {
  const idOf = new Map(draft.map((c) => [c.key, uid()]));
  const t = Date.now();
  return draft.map((c, i) => ({
    id: idOf.get(c.key), kind: 'card', text: c.text, parentId: idOf.get(c.parent) || null, order: t + i,
    status: c.status || null, stance: c.stance || null,
    ...(c.msgId ? { msgId: c.msgId, sourceAuthor: c.sourceAuthor || '', date: c.date || null } : { ai: true }),
  }));
}
