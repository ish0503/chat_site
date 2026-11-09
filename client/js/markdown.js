import { escapeHtml } from './util.js';

const EMOJI_ONLY = /^(?:\p{Extended_Pictographic}|\p{Emoji_Component}|‍|️|\s)+$/u;

/**
 * 디스코드 스타일의 간단한 마크다운.
 * **굵게** *기울임* __밑줄__ ~~취소선~~ ||스포일러|| `코드` ```코드블록``` > 인용 @멘션 링크
 */
export function renderMarkdown(text, { me } = {}) {
  const slots = [];
  const keep = (html) => `\u0000${slots.push(html) - 1}\u0000`;
  let s = escapeHtml(text);

  s = s.replace(/```(?:([\w+-]{1,20})\n)?([\s\S]*?)```/g, (_, lang, code) =>
    keep(`<pre class="md-pre"><code${lang ? ` data-lang="${lang}"` : ''}>${code.replace(/^\n/, '')}</code></pre>`));
  s = s.replace(/`([^`\n]+)`/g, (_, code) => keep(`<code class="md-code">${code}</code>`));
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

  s = s.replace(/(^|\s)@([^\s@<]{1,32})/g, (all, pre, name) => {
    const mine = me && (name === me.nickname || name === 'everyone' || name === 'here');
    return `${pre}<span class="mention${mine ? ' mention-me' : ''}">@${name}</span>`;
  });

  // 인용 블록
  s = s.split('\n').reduce((acc, line) => {
    const q = line.match(/^&gt; ?(.*)$/);
    if (q) {
      if (acc.inQuote) acc.out[acc.out.length - 1] += `<br>${q[1]}`;
      else acc.out.push(`<blockquote>${q[1]}`);
      acc.inQuote = true;
    } else {
      if (acc.inQuote) acc.out[acc.out.length - 1] += '</blockquote>';
      acc.inQuote = false;
      acc.out.push(line);
    }
    return acc;
  }, { out: [], inQuote: false });
  const lines = s.out;
  if (s.inQuote) lines[lines.length - 1] += '</blockquote>';
  let html = lines.join('\n').replace(/<\/blockquote>\n/g, '</blockquote>').replace(/\n/g, '<br>');

  html = html.replace(/\u0000(\d+)\u0000/g, (_, i) => slots[Number(i)]);
  return html;
}

export const isEmojiOnly = (text) => !!text && text.length <= 40 && EMOJI_ONLY.test(text) && /\p{Extended_Pictographic}/u.test(text);

export function mentionsMe(text, me) {
  if (!text || !me) return false;
  return new RegExp(`(^|\\s)@(${escapeRe(me.nickname)}|everyone|here)(?=\\s|$)`).test(text);
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
