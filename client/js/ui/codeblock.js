// 코드 블록: 언어 표시, 복사, 구문 강조, ▶ 실행 (JavaScript / Python / HTML)
import { h, toast } from '../util.js';
import { run, runnable, LANG_LABEL, highlight, renderMath } from '../runner.js';
import { icon } from './icons.js';

/** 실행 결과 패널을 pre 아래에 붙이고 코드를 실행합니다. */
export function runBox(anchor, lang, code, { onSendResult } = {}) {
  const kind = runnable(lang);
  anchor.nextElementSibling?.classList.contains('run-box') && anchor.nextElementSibling.remove();
  const out = h('div', { class: 'run-out', role: 'log', 'aria-live': 'polite' });
  const status = h('span', { class: 'run-status' }, h('span', { class: 'spinner tiny' }), ' 실행 중…');
  const preview = h('div', { class: 'run-preview-wrap' });
  const lines = [];
  let ctl = null;
  const stopBtn = h('button', { class: 'btn small secondary', onclick: () => ctl?.stop() }, icon('x', 14), ' 중지');
  const sendBtn = onSendResult ? h('button', {
    class: 'btn small secondary', hidden: true,
    onclick: () => onSendResult(lines.map((l) => (l.type === 'error' ? `❌ ${l.text}` : l.text)).join('\n') || '(출력 없음)', kind),
  }, icon('send', 14), ' 결과 보내기') : null;
  const box = h('div', { class: `run-box run-${kind}` },
    h('div', { class: 'run-head' },
      h('strong', {}, `▶ ${LANG_LABEL[kind]}`), status,
      h('span', { class: 'run-actions' }, stopBtn, sendBtn,
        h('button', { class: 'btn small ghost', onclick: () => { ctl?.close(); box.remove(); } }, '닫기'))),
    kind === 'html' ? preview : null,
    out,
    h('div', { class: 'run-note' }, '🔒 격리된 샌드박스에서 실행되어 이 사이트의 로그인 정보나 저장된 대화에 접근할 수 없습니다.'));
  anchor.after(box);
  const add = (type, text) => {
    lines.push({ type, text });
    out.append(h('div', { class: `run-line run-${type}` }, type === 'result' ? h('span', { class: 'run-arrow' }, '← ') : null, text));
    out.scrollTop = out.scrollHeight;
  };
  ctl = run(lang, code, {
    previewParent: preview,
    onLine: add,
    onDone: ({ ok, ms, stopped, timedOut }) => {
      stopBtn.hidden = true;
      status.replaceChildren(stopped ? '⏹ 중지됨' : timedOut ? '⏱ 시간 초과' : ok ? `✅ 완료 (${ms}ms)` : `❌ 오류 (${ms}ms)`);
      status.className = `run-status ${ok ? 'ok' : 'bad'}`;
      if (sendBtn && kind !== 'html') sendBtn.hidden = false;
      if (!lines.length && kind !== 'html') out.append(h('div', { class: 'run-line run-info' }, '(출력 없음)'));
    },
  });
  return box;
}

/** 렌더링된 메시지 안의 코드 블록과 수식을 꾸밉니다. */
export function enhance(root, { onSendResult } = {}) {
  for (const pre of root.querySelectorAll('pre.md-pre:not([data-ready])')) {
    pre.dataset.ready = '1';
    const code = pre.querySelector('code');
    const lang = code?.dataset.lang || '';
    const src = code?.textContent || '';
    const kind = runnable(lang);
    const bar = h('div', { class: 'code-bar' },
      h('span', { class: 'code-lang' }, lang || '코드'),
      h('button', {
        class: 'code-btn', title: '코드 복사',
        onclick: () => navigator.clipboard?.writeText(src).then(() => toast('코드를 복사했습니다.'), () => toast('복사하지 못했습니다.', 'error')),
      }, icon('copy', 14), ' 복사'),
      kind ? h('button', {
        class: 'code-btn run', title: `${LANG_LABEL[kind]} 실행`,
        onclick: () => runBox(pre, lang, src, { onSendResult }),
      }, icon('play', 14), kind === 'html' ? ' 미리보기' : ' 실행') : null);
    pre.prepend(bar);
    if (code) highlight(code, lang);
  }
  for (const m of root.querySelectorAll('.math:not(.rendered)')) renderMath(m);
}
