import { escapeHtml } from './util.js';

const EMOJI_ONLY = /^(?:\p{Extended_Pictographic}|\p{Emoji_Component}|‍|️|\s)+$/u;
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * 디스코드 스타일 마크다운.
 * 인라인: **굵게** *기울임* __밑줄__ ~~취소선~~ ||스포일러|| `코드` $수식$ #색상코드 @멘션 링크 \이스케이프
 * 블록:  ```코드블록``` $$수식$$ > 인용  # 제목  - 목록  1. 번호 목록  - [ ] 체크리스트  | 표 |
 */
export function renderMarkdown(text, { me, filterWords = [] } = {}) {
  const slots = [];
  const keep = (html) => `\u0000${slots.push(html) - 1}\u0000`;
  let s = escapeHtml(text);

  // 단어 필터 (개인 설정)
  for (const w of filterWords) {
    if (w) s = s.replace(new RegExp(escapeRe(escapeHtml(w)), 'gi'), (m) => '●'.repeat(Math.min(m.length, 8)));
  }

  // 백슬래시 이스케이프: \* \_ \~ \| \` \# \- \$ \\ \[ \]
  s = s.replace(/\\([*_~|`#\-$\\[\]])/g, (_, c) => keep(c));

  // 코드 블록 / 수식 블록
  s = s.replace(/```(?:([\w+#.-]{1,20})\n)?([\s\S]*?)```/g, (_, lang, code) =>
    keep(`<pre class="md-pre"><code${lang ? ` data-lang="${lang}"` : ''}>${code.replace(/^\n/, '').replace(/\n$/, '')}</code></pre>`));
  s = s.replace(/\$\$([\s\S]+?)\$\$/g, (_, tex) => keep(`<span class="math display" data-tex="${tex.trim()}">${tex.trim()}</span>`));
  s = s.replace(/`([^`\n]+)`/g, (_, code) => keep(`<code class="md-code">${code}</code>`));
  s = s.replace(/(^|[^\w$])\$(?!\s)([^$\n]{1,200}?)(?<!\s)\$(?![\w$])/g, (_, pre, tex) => `${pre}${keep(`<span class="math" data-tex="${tex}">${tex}</span>`)}`);
  s = s.replace(/\bhttps?:\/\/[^\s<]+/g, (url) => {
    const m = url.match(/[).,!?;:'"]+$/);
    const tail = m ? m[0] : '';
    const href = tail ? url.slice(0, -tail.length) : url;
    return keep(`<a href="${href}" target="_blank" rel="noopener noreferrer nofollow">${href}</a>`) + tail;
  });

  s = s
    .replace(/\*\*([^*\n][\s\S]*?)\*\*/g, '<strong>$1</strong>')
    .replace(/__([^_\n][\s\S]*?)__/g, '<u>$1</u>')
    .replace(/(^|[^\w*])\*([^*\s][^*\n]*?)\*(?!\w)/g, '$1<em>$2</em>')
    .replace(/(^|[^\w])_([^_\s][^_\n]*?)_(?!\w)/g, '$1<em>$2</em>')
    .replace(/~~([\s\S]+?)~~/g, '<s>$1</s>')
    .replace(/\|\|([\s\S]+?)\|\|/g, '<span class="spoiler" tabindex="0">$1</span>');

  // 색상 코드 견본 (#ff8800, #f80)
  s = s.replace(/(^|[\s(])#([0-9a-fA-F]{6}|[0-9a-fA-F]{3})(?![\w])/g, (all, pre, hex) => (hex.length === 3 && /^\d+$/.test(hex)
    ? all // '#123' 같은 번호는 색상으로 보지 않음
    : `${pre}<span class="color-chip"><span class="swatch" style="background:#${hex}"></span>#${hex}</span>`));

  s = s.replace(/(^|\s)@([^\s@<]{1,32})/g, (all, pre, name) => {
    const mine = me && (name === me.nickname || name === 'everyone' || name === 'here');
    return `${pre}<span class="mention${mine ? ' mention-me' : ''}">@${name}</span>`;
  });

  const html = blocks(s.split('\n'));
  return html.replace(/\u0000(\d+)\u0000/g, (_, i) => slots[Number(i)]);
}

/** 줄 단위 블록 처리: 인용, 제목, 목록, 체크리스트, 표 */
function blocks(lines) {
  const out = [];
  const push = (html, block) => out.push({ html, block });
  let i = 0;
  const item = (t) => {
    const c = t.match(/^\[( |x|X)\] (.*)$/);
    return c ? `<li class="task${c[1] === ' ' ? '' : ' done'}"><span class="task-box" aria-hidden="true">${c[1] === ' ' ? '' : '✓'}</span>${c[2]}</li>` : `<li>${t}</li>`;
  };
  while (i < lines.length) {
    const l = lines[i];
    if (/^&gt; ?/.test(l)) {
      const buf = [];
      while (i < lines.length && /^&gt; ?/.test(lines[i])) buf.push(lines[i++].replace(/^&gt; ?/, ''));
      push(`<blockquote>${buf.join('<br>')}</blockquote>`, true);
      continue;
    }
    const hm = l.match(/^(#{1,3}) (.+)$/);
    if (hm) {
      push(`<div class="md-h md-h${hm[1].length}">${hm[2]}</div>`, true);
      i++;
      continue;
    }
    if (/^\s*[-*] \S/.test(l)) {
      const buf = [];
      while (i < lines.length && /^\s*[-*] \S/.test(lines[i])) buf.push(item(lines[i++].replace(/^\s*[-*] /, '')));
      push(`<ul class="md-list">${buf.join('')}</ul>`, true);
      continue;
    }
    if (/^\s*\d{1,3}[.)] \S/.test(l)) {
      const start = Number(l.match(/\d+/)[0]);
      const buf = [];
      while (i < lines.length && /^\s*\d{1,3}[.)] \S/.test(lines[i])) buf.push(item(lines[i++].replace(/^\s*\d{1,3}[.)] /, '')));
      push(`<ol class="md-list"${start !== 1 ? ` start="${start}"` : ''}>${buf.join('')}</ol>`, true);
      continue;
    }
    if (/^\|.+\|\s*$/.test(l) && i + 1 < lines.length && /^\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(lines[i + 1])) {
      const cells = (row) => row.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
      const head = cells(l);
      const align = cells(lines[i + 1]).map((c) => (c.startsWith(':') && c.endsWith(':') ? 'center' : c.endsWith(':') ? 'right' : ''));
      i += 2;
      const rows = [];
      while (i < lines.length && /^\|.+\|\s*$/.test(lines[i])) rows.push(cells(lines[i++]));
      const td = (tag, c, j) => `<${tag}${align[j] ? ` style="text-align:${align[j]}"` : ''}>${c}</${tag}>`;
      push(`<div class="md-table-wrap"><table class="md-table"><thead><tr>${head.map((c, j) => td('th', c, j)).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${head.map((_, j) => td('td', r[j] ?? '', j)).join('')}</tr>`).join('')}</tbody></table></div>`, true);
      continue;
    }
    push(l, false);
    i++;
  }
  let html = '';
  let prevBlock = true;
  for (const o of out) {
    if (o.block) html += o.html;
    else html += (prevBlock ? '' : '<br>') + o.html;
    prevBlock = o.block;
  }
  return html;
}

export const isEmojiOnly = (text) => !!text && text.length <= 40 && EMOJI_ONLY.test(text) && /\p{Extended_Pictographic}/u.test(text);

export function mentionsMe(text, me, keywords = []) {
  if (!text || !me) return false;
  if (new RegExp(`(^|\\s)@(${escapeRe(me.nickname)}|everyone|here)(?=\\s|$)`).test(text)) return true;
  const lower = text.toLowerCase();
  return keywords.some((k) => k && lower.includes(k.toLowerCase()));
}

/** 메시지 안의 링크 목록 (임베드용) */
export function linksIn(text = '') {
  return [...text.matchAll(/\bhttps?:\/\/[^\s<]+/g)].map((m) => m[0].replace(/[).,!?;:'"]+$/, ''));
}

export function youtubeId(url) {
  const m = url.match(/^https?:\/\/(?:www\.|m\.)?(?:youtube\.com\/(?:watch\?(?:.*&)?v=|shorts\/|embed\/)|youtu\.be\/)([\w-]{11})/);
  return m ? m[1] : null;
}
