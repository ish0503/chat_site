// 슬래시 명령어와 이모지 단축코드

// ── 이모지 단축코드 (:smile:) ──
export const EMOJI_CODES = {
  smile: '😄', grin: '😁', joy: '😂', rofl: '🤣', smiley: '😃', wink: '😉', blush: '😊', heart_eyes: '😍', kiss: '😘', yum: '😋',
  thinking: '🤔', neutral: '😐', expressionless: '😑', rolling_eyes: '🙄', smirk: '😏', relieved: '😌', sleepy: '😪', sleeping: '😴',
  sunglasses: '😎', nerd: '🤓', confused: '😕', worried: '😟', cry: '😢', sob: '😭', angry: '😠', rage: '😡', scream: '😱',
  sweat_smile: '😅', sweat: '😓', flushed: '😳', dizzy_face: '😵', mask: '😷', partying: '🥳', pleading: '🥺', hugging: '🤗',
  shush: '🤫', zipper: '🤐', skull: '💀', ghost: '👻', robot: '🤖', alien: '👽', poop: '💩', clown: '🤡', devil: '😈', angel: '😇',
  thumbsup: '👍', '+1': '👍', thumbsdown: '👎', '-1': '👎', ok_hand: '👌', clap: '👏', wave: '👋', pray: '🙏', muscle: '💪',
  raised_hands: '🙌', point_up: '☝️', point_right: '👉', point_left: '👈', v: '✌️', crossed_fingers: '🤞', fist: '✊', punch: '👊',
  handshake: '🤝', eyes: '👀', brain: '🧠', heart: '❤️', orange_heart: '🧡', yellow_heart: '💛', green_heart: '💚', blue_heart: '💙',
  purple_heart: '💜', black_heart: '🖤', broken_heart: '💔', sparkling_heart: '💖', fire: '🔥', sparkles: '✨', star: '⭐', boom: '💥',
  100: '💯', tada: '🎉', confetti: '🎊', gift: '🎁', trophy: '🏆', medal: '🏅', rocket: '🚀', zap: '⚡', rainbow: '🌈', sunny: '☀️',
  moon: '🌙', snowflake: '❄️', cloud: '☁️', umbrella: '☔', coffee: '☕', beer: '🍺', pizza: '🍕', burger: '🍔', ramen: '🍜',
  cake: '🍰', apple: '🍎', dog: '🐶', cat: '🐱', bear: '🐻', panda: '🐼', fox: '🦊', frog: '🐸', unicorn: '🦄', bug: '🐛',
  computer: '💻', phone: '📱', camera: '📷', bulb: '💡', book: '📖', memo: '📝', pencil: '✏️', calendar: '📅', pushpin: '📌',
  paperclip: '📎', lock: '🔒', key: '🔑', bell: '🔔', mega: '📣', mag: '🔍', link: '🔗', check: '✅', x: '❌', warning: '⚠️',
  question: '❓', exclamation: '❗', no_entry: '⛔', recycle: '♻️', soccer: '⚽', basketball: '🏀', game: '🎮', music: '🎵',
  headphones: '🎧', microphone: '🎤', art: '🎨', money: '💰', chart: '📈', hourglass: '⏳', clock: '🕐', house: '🏠', car: '🚗',
  airplane: '✈️', korea: '🇰🇷', flower: '🌸', tree: '🌳', clover: '🍀', sweat_drops: '💦', zzz: '💤', wave_hand: '👋', salute: '🫡',
};

export function searchEmoji(q, limit = 8) {
  const s = q.toLowerCase();
  return Object.entries(EMOJI_CODES).filter(([k]) => k.startsWith(s)).concat(
    Object.entries(EMOJI_CODES).filter(([k]) => !k.startsWith(s) && k.includes(s)),
  ).slice(0, limit);
}

/** 보내기 전 :단축코드: 를 이모지로 바꿈 (코드 블록 안은 제외) */
export function replaceShortcodes(text) {
  return text.split(/(```[\s\S]*?```|`[^`\n]*`)/).map((part, i) => (i % 2
    ? part
    : part.replace(/:([a-z0-9_+-]{1,30}):/g, (m, k) => EMOJI_CODES[k] || m))).join('');
}

// ── 계산기 (안전한 수식 파서: eval 사용 안 함) ──
export function calc(expr) {
  const src = expr.replace(/×/g, '*').replace(/÷/g, '/').replace(/\s+/g, '');
  let i = 0;
  const FN = {
    sqrt: Math.sqrt, abs: Math.abs, round: Math.round, floor: Math.floor, ceil: Math.ceil, sin: Math.sin, cos: Math.cos,
    tan: Math.tan, log: Math.log10, ln: Math.log, exp: Math.exp, min: Math.min, max: Math.max,
  };
  const peek = () => src[i];
  const eat = (c) => { if (src[i] === c) { i++; return true; } return false; };
  const fail = () => { throw new Error('수식을 이해할 수 없습니다.'); };
  function expr0() {
    let v = term();
    for (;;) {
      if (eat('+')) v += term();
      else if (eat('-')) v -= term();
      else return v;
    }
  }
  function term() {
    let v = unary();
    for (;;) {
      if (eat('*')) v *= unary();
      else if (eat('/')) v /= unary();
      else if (eat('%')) v %= unary();
      else return v;
    }
  }
  // 부호는 거듭제곱보다 약하게: -2^2 = -4, 2^-1 = 0.5
  function unary() {
    if (eat('-')) return -unary();
    if (eat('+')) return unary();
    return power();
  }
  function power() {
    const b = atom();
    return eat('^') ? b ** unary() : b;
  }
  function atom() {
    if (eat('(')) { const v = expr0(); if (!eat(')')) fail(); return v; }
    const num = src.slice(i).match(/^\d+(\.\d+)?(e[+-]?\d+)?|^\.\d+/i);
    if (num) { i += num[0].length; return Number(num[0]); }
    const id = src.slice(i).match(/^[a-z]+/i);
    if (id) {
      i += id[0].length;
      const name = id[0].toLowerCase();
      if (name === 'pi') return Math.PI;
      if (name === 'e') return Math.E;
      if (FN[name] && eat('(')) {
        const args = [expr0()];
        while (eat(',')) args.push(expr0());
        if (!eat(')')) fail();
        return FN[name](...args);
      }
    }
    return fail();
  }
  const v = expr0();
  if (i < src.length || !Number.isFinite(v)) fail();
  return Math.round(v * 1e12) / 1e12;
}

function parseDelay(s) {
  const m = s.match(/^(\d+(?:\.\d+)?)\s*(s|초|m|분|h|시간|d|일)$/i);
  if (m) {
    const n = Number(m[1]);
    const mult = { s: 1, 초: 1, m: 60, 분: 60, h: 3600, 시간: 3600, d: 86400, 일: 86400 }[m[2].toLowerCase()];
    return Date.now() + n * mult * 1000;
  }
  const t = s.match(/^(\d{1,2}):(\d{2})$/);
  if (t && Number(t[1]) < 24 && Number(t[2]) < 60) {
    const d = new Date();
    d.setHours(Number(t[1]), Number(t[2]), 0, 0);
    if (d.getTime() <= Date.now()) d.setDate(d.getDate() + 1);
    return d.getTime();
  }
  return null;
}

// ── 명령어 목록 ──
export const COMMANDS = [
  { name: 'shrug', args: '[메시지]', desc: '¯\\_(ツ)_/¯ 붙이기' },
  { name: 'tableflip', args: '[메시지]', desc: '(╯°□°)╯︵ ┻━┻' },
  { name: 'unflip', args: '[메시지]', desc: '┬─┬ノ( º _ ºノ)' },
  { name: 'lenny', args: '[메시지]', desc: '( ͡° ͜ʖ ͡°)' },
  { name: 'me', args: '<행동>', desc: '행동 표시 (기울임체로 표시)' },
  { name: 'spoiler', args: '<메시지>', desc: '스포일러로 가려서 보내기' },
  { name: 'roll', args: '[2d6 | 100]', desc: '주사위 굴리기' },
  { name: 'flip', args: '', desc: '동전 던지기' },
  { name: 'calc', args: '<수식>', desc: '계산기 (예: /calc (3+4)*2^3)' },
  { name: 'poll', args: '질문 | 선택1 | 선택2 …', desc: '투표 만들기', perm: 'react' },
  { name: 'remind', args: '<10m | 2h | 14:30> <내용>', desc: '나에게 알림 예약' },
  { name: 'nick', args: '<닉네임>', desc: '닉네임 바꾸기' },
  { name: 'status', args: '<상태 메시지>', desc: '상태 메시지 바꾸기' },
  { name: 'topic', args: '<설명>', desc: '채팅방 설명 바꾸기', perm: 'manageNodes' },
  { name: 'code', args: '[언어] <코드>', desc: '코드 블록으로 보내기 (예: /code py print(1))' },
  { name: 'dm', args: '<닉네임> [메시지]', desc: '1:1 대화 열기 (메시지를 적으면 바로 보냄)', perm: 'directMessage' },
  { name: 'ai', args: '<질문>', desc: 'AI 도우미에게 이 방의 대화 기록에 대해 묻기', perm: 'useAi' },
  { name: 'summary', args: '', desc: 'AI 도우미로 최근 대화 요약', perm: 'useAi' },
  { name: 'help', args: '', desc: '명령어 도움말' },
];

const FACES = { shrug: '¯\\\\\\_(ツ)\\_/¯', tableflip: '(╯°□°)╯︵ ┻━┻', unflip: '┬─┬ノ( º _ ºノ)', lenny: '( ͡° ͜ʖ ͡°)' };

/**
 * 명령어 실행. 결과:
 *  { send: { content, kind?, poll? } }   → 메시지 보내기
 *  { remind: { at, text } }               → 리마인더 등록
 *  { profile: {...} } / { topic } / { help: true } / { error }
 *  null                                   → 명령어가 아님
 */
export function runCommand(text) {
  const m = text.match(/^\/([a-z]+)(?:\s+([\s\S]*))?$/i);
  if (!m) return null;
  const cmd = m[1].toLowerCase();
  const rest = (m[2] || '').trim();
  switch (cmd) {
    case 'shrug': case 'tableflip': case 'unflip': case 'lenny':
      return { send: { content: `${rest ? `${rest} ` : ''}${FACES[cmd]}` } };
    case 'me':
      return rest ? { send: { content: rest, kind: 'me' } } : { error: '/me 다음에 행동을 적어 주세요.' };
    case 'spoiler':
      return rest ? { send: { content: `||${rest}||` } } : { error: '가릴 내용을 적어 주세요.' };
    case 'roll': {
      let n = 1;
      let sides = 6;
      const d = rest.match(/^(\d{1,2})?d(\d{1,4})$/i);
      if (d) { n = Math.min(Number(d[1] || 1), 20); sides = Math.max(2, Number(d[2])); } else if (/^\d{1,6}$/.test(rest)) sides = Math.max(2, Number(rest));
      const rolls = Array.from({ length: n }, () => 1 + Math.floor(Math.random() * sides));
      return { send: { content: `🎲 ${n}d${sides} → **${rolls.join(', ')}**${n > 1 ? ` (합계 ${rolls.reduce((a, b) => a + b, 0)})` : ''}` } };
    }
    case 'flip':
      return { send: { content: `🪙 동전 던지기 → **${Math.random() < 0.5 ? '앞면' : '뒷면'}**` } };
    case 'calc':
      try {
        return { send: { content: `🧮 \`${rest}\` = **${calc(rest)}**` } };
      } catch (e) {
        return { error: e.message };
      }
    case 'poll': {
      const parts = rest.split('|').map((x) => x.trim()).filter(Boolean);
      if (parts.length < 3) return { error: '형식: /poll 질문 | 선택1 | 선택2' };
      return { send: { content: parts[0], kind: 'poll', poll: { options: parts.slice(1, 11), multi: false } } };
    }
    case 'remind': {
      const r = rest.match(/^(\S+)\s+([\s\S]+)$/);
      const at = r && parseDelay(r[1]);
      if (!at) return { error: '형식: /remind 10m 내용  또는  /remind 14:30 내용' };
      return { remind: { at, text: r[2] } };
    }
    case 'nick':
      return rest ? { profile: { nickname: rest.slice(0, 32) } } : { error: '새 닉네임을 적어 주세요.' };
    case 'status':
      return { profile: { status: rest.slice(0, 80) } };
    case 'topic':
      return { topic: rest.slice(0, 300) };
    case 'code': {
      const c = rest.match(/^([\w+#-]{1,15})\s+([\s\S]+)$/);
      if (c && /^(js|javascript|py|python|html|css|json|ts|c|cpp|java|go|rust|sql|bash|sh)$/i.test(c[1])) return { send: { content: `\`\`\`${c[1]}\n${c[2]}\n\`\`\`` } };
      return rest ? { send: { content: `\`\`\`\n${rest}\n\`\`\`` } } : { error: '코드를 적어 주세요.' };
    }
    case 'dm': {
      const d = rest.match(/^@?(\S+)(?:\s+([\s\S]+))?$/);
      return d ? { dm: { name: d[1], text: (d[2] || '').trim() } } : { error: '형식: /dm 닉네임 [메시지]' };
    }
    case 'ai':
      return rest ? { ai: { mode: 'ask', question: rest.slice(0, 500) } } : { error: '질문을 적어 주세요. 예: /ai 회의 날짜가 언제로 정해졌어?' };
    case 'summary':
      return { ai: { mode: 'summary' } };
    case 'help':
      return { help: true };
    default:
      return { error: `알 수 없는 명령어: /${cmd}  (/help 로 목록 보기)` };
  }
}
