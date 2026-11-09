// 채팅에 올라온 코드 실행기.
// 보안: 코드는 sandbox="allow-scripts" iframe (allow-same-origin 없음 → 고유한 빈 출처) 안에서 실행되므로
// 이 사이트의 로그인 토큰, localStorage, IndexedDB, 쿠키에 접근할 수 없습니다.
// JavaScript/Python 은 그 iframe 안의 Worker 에서 실행되어 화면이 멈추지 않고, 시간 제한이나 "중지" 시 iframe 째로 제거됩니다.

const PYODIDE_URL = 'https://cdn.jsdelivr.net/pyodide/v0.26.4/full/';

const ALIASES = {
  js: 'javascript', javascript: 'javascript', node: 'javascript', mjs: 'javascript',
  py: 'python', python: 'python', python3: 'python',
  html: 'html', htm: 'html',
};

export const LANG_LABEL = { javascript: 'JavaScript', python: 'Python', html: 'HTML' };

/** 실행 가능한 언어면 정규화된 이름, 아니면 null */
export const runnable = (lang) => ALIASES[(lang || '').toLowerCase()] || null;

/** 파일 확장자로 언어 추정 (파일 미리보기용) */
export function langFromName(name = '') {
  const ext = name.split('.').pop().toLowerCase();
  return {
    js: 'javascript', mjs: 'javascript', py: 'python', html: 'html', htm: 'html', css: 'css', json: 'json', md: 'markdown',
    ts: 'typescript', c: 'c', h: 'c', cpp: 'cpp', cc: 'cpp', java: 'java', go: 'go', rs: 'rust', sh: 'bash', sql: 'sql',
    yml: 'yaml', yaml: 'yaml', xml: 'xml', kt: 'kotlin', swift: 'swift', rb: 'ruby', php: 'php', csv: 'plaintext', txt: 'plaintext', log: 'plaintext',
  }[ext] || null;
}

// ── Worker 안에서 실행될 코드 (문자열로 변환되어 들어감) ──
function jsWorker() {
  const fmt = (v) => {
    if (typeof v === 'string') return v;
    if (v instanceof Error) {
      const at = (v.stack || '').match(/<anonymous>:(\d+):(\d+)/);
      return `${v.name}: ${v.message}${at ? ` (${Number(at[1]) - (self.lineOffset || 0)}번째 줄)` : ''}`;
    }
    if (typeof v === 'function') return v.toString();
    if (v === undefined) return 'undefined';
    if (typeof v === 'symbol' || typeof v === 'bigint') return String(v) + (typeof v === 'bigint' ? 'n' : '');
    try {
      const seen = new WeakSet();
      return JSON.stringify(v, (k, x) => {
        if (typeof x === 'object' && x) { if (seen.has(x)) return '[Circular]'; seen.add(x); }
        if (typeof x === 'bigint') return `${x}n`;
        if (x === undefined) return 'undefined';
        if (typeof x === 'function') return `[Function ${x.name || ''}]`;
        if (x instanceof Map) return Object.fromEntries(x);
        if (x instanceof Set) return [...x];
        return x;
      }, 2);
    } catch { return String(v); }
  };
  const send = (type, args) => postMessage({ type, text: args.map(fmt).join(' ') });
  for (const [k, t] of [['log', 'log'], ['info', 'log'], ['debug', 'log'], ['warn', 'warn'], ['error', 'error']]) console[k] = (...a) => send(t, a);
  console.table = (d) => send('log', [d]);
  self.alert = (m) => send('log', [`[alert] ${m}`]);
  self.prompt = () => { send('warn', ['prompt() 는 지원하지 않습니다.']); return null; };
  onmessage = async ({ data }) => {
    const t0 = performance.now();
    let ok = true;
    try {
      let r;
      if (/\bawait\b/.test(data.code)) {
        const AsyncFunction = (async () => {}).constructor;
        self.lineOffset = 2; // new AsyncFunction 이 앞에 붙이는 2줄
        r = await new AsyncFunction(data.code)();
      } else {
        r = (0, eval)(data.code); // 콘솔처럼 마지막 식의 값을 보여줌
        if (r && typeof r.then === 'function') r = await r;
      }
      if (r !== undefined) send('result', [r]);
    } catch (e) {
      ok = false;
      send('error', [e]);
    }
    postMessage({ type: 'done', ms: performance.now() - t0, ok });
  };
}

function pyWorker(indexURL) {
  importScripts(`${indexURL}pyodide.js`);
  let pyP = null;
  onmessage = async ({ data }) => {
    const t0 = performance.now();
    let ok = true;
    try {
      if (!pyP) {
        postMessage({ type: 'info', text: 'Python 불러오는 중… (처음 실행은 몇 초 걸립니다)' });
        pyP = self.loadPyodide({ indexURL });
      }
      const py = await pyP;
      py.setStdout({ batched: (t) => postMessage({ type: 'log', text: t }) });
      py.setStderr({ batched: (t) => postMessage({ type: 'error', text: t }) });
      py.setStdin({ stdin: () => { postMessage({ type: 'warn', text: 'input() 은 지원하지 않습니다. 빈 문자열을 돌려줍니다.' }); return ''; } });
      await py.loadPackagesFromImports(data.code, { messageCallback: (m) => postMessage({ type: 'info', text: m }) });
      const r = await py.runPythonAsync(data.code);
      if (r !== undefined && r !== null) postMessage({ type: 'result', text: String(r) });
      r?.destroy?.();
    } catch (e) {
      ok = false;
      postMessage({ type: 'error', text: String(e?.message || e) });
    }
    postMessage({ type: 'done', ms: performance.now() - t0, ok });
  };
}

// sandbox iframe 안의 호스트: Worker 를 만들어 결과를 부모로 전달
function host() {
  addEventListener('message', (e) => {
    const { src, code } = e.data || {};
    if (!src) return;
    let w;
    try {
      w = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
    } catch (err) {
      parent.postMessage({ type: 'error', text: `이 브라우저에서는 코드 실행기를 만들 수 없습니다: ${err.message}` }, '*');
      parent.postMessage({ type: 'done', ok: false, ms: 0 }, '*');
      return;
    }
    w.onmessage = (m) => parent.postMessage(m.data, '*');
    w.onerror = (err) => {
      err.preventDefault?.();
      parent.postMessage({ type: 'error', text: err.message || '실행 오류' }, '*');
      parent.postMessage({ type: 'done', ok: false, ms: 0 }, '*');
    };
    w.postMessage({ code });
  });
  parent.postMessage({ type: 'ready' }, '*');
}

// HTML 미리보기 안에서 console 출력을 부모로 전달
function htmlBridge() {
  const fmt = (x) => { if (typeof x === 'string') return x; try { return JSON.stringify(x); } catch { return String(x); } };
  for (const k of ['log', 'info', 'warn', 'error']) {
    const o = console[k];
    console[k] = (...a) => {
      try { parent.postMessage({ type: k === 'warn' ? 'warn' : k === 'error' ? 'error' : 'log', text: a.map(fmt).join(' ') }, '*'); } catch { /* noop */ }
      o.apply(console, a);
    };
  }
  addEventListener('error', (e) => parent.postMessage({ type: 'error', text: e.message }, '*'));
}

const MAX_LINES = 1000;
const MAX_CHARS = 200_000;

/**
 * 코드 실행. onLine(type, text) 로 출력이 전달되고, onDone({ ok, ms, timedOut, stopped }) 로 끝납니다.
 * html 은 previewParent 안에 미리보기 iframe 을 만듭니다.
 */
export function run(lang, code, { onLine, onDone, previewParent, timeoutMs } = {}) {
  const kind = runnable(lang);
  if (!kind) throw new Error('실행할 수 없는 언어입니다.');
  const frame = document.createElement('iframe');
  frame.setAttribute('sandbox', 'allow-scripts');
  frame.setAttribute('referrerpolicy', 'no-referrer');
  frame.title = `${LANG_LABEL[kind]} 실행`;
  let lines = 0;
  let chars = 0;
  let finished = false;
  let truncated = false;
  const t0 = performance.now();

  const finish = (info) => {
    if (finished) return;
    finished = true;
    onDone?.({ ms: Math.round(performance.now() - t0), ...info });
  };

  const onMessage = (e) => {
    if (e.source !== frame.contentWindow) return;
    const d = e.data || {};
    if (d.type === 'ready') {
      const src = kind === 'python'
        ? `(${pyWorker.toString()})(${JSON.stringify(PYODIDE_URL)})`
        : `(${jsWorker.toString()})()`;
      frame.contentWindow.postMessage({ src, code }, '*');
      return;
    }
    if (d.type === 'done') {
      if (kind !== 'html' && !finished) {
        finish({ ok: d.ok, ms: Math.round(d.ms || 0) });
        // 늦게 실행되는 setTimeout 등의 출력을 잠깐 더 받은 뒤 정리
        clearTimeout(timer);
        grace = setTimeout(cleanup, 3000);
      }
      return;
    }
    if (truncated) return;
    const text = String(d.text ?? '');
    lines += 1;
    chars += text.length;
    if (lines > MAX_LINES || chars > MAX_CHARS) {
      truncated = true;
      onLine?.('warn', '출력이 너무 많아 나머지는 생략합니다.');
      return;
    }
    onLine?.(d.type || 'log', text);
  };
  window.addEventListener('message', onMessage);

  const limit = timeoutMs ?? (kind === 'python' ? 60_000 : 10_000);
  let grace = null;
  const timer = kind === 'html' ? null : setTimeout(() => {
    if (finished) return;
    onLine?.('error', `시간 제한(${limit / 1000}초)을 넘어 실행을 중지했습니다.`);
    stop(true);
  }, limit);

  function cleanup() {
    clearTimeout(timer);
    clearTimeout(grace);
    window.removeEventListener('message', onMessage);
    frame.remove();
  }

  function stop(timedOut = false) {
    finish({ ok: false, stopped: !timedOut, timedOut });
    cleanup();
  }

  if (kind === 'html') {
    frame.className = 'run-preview';
    frame.srcdoc = `<!doctype html><meta charset="utf-8"><script>(${htmlBridge.toString()})()<\/script>${code}`;
    previewParent.append(frame);
    frame.addEventListener('load', () => finish({ ok: true }), { once: true });
  } else {
    frame.style.display = 'none';
    frame.srcdoc = `<!doctype html><meta charset="utf-8"><script>(${host.toString()})()<\/script>`;
    document.body.append(frame);
  }

  return {
    stop: () => stop(false),
    close: cleanup,
    get finished() { return finished; },
  };
}

// ── 구문 강조 / 수식 (필요할 때만 CDN 에서 불러옴) ──
const HLJS = 'https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/highlight.min.js';
const KATEX_JS = 'https://cdnjs.cloudflare.com/ajax/libs/KaTeX/0.16.9/katex.min.js';
const KATEX_CSS = 'https://cdnjs.cloudflare.com/ajax/libs/KaTeX/0.16.9/katex.min.css';
let hljsP = null;
let katexP = null;

function script(src) {
  return new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = src;
    s.async = true;
    s.crossOrigin = 'anonymous';
    s.onload = res;
    s.onerror = rej;
    document.head.append(s);
  });
}

export async function highlight(codeEl, lang) {
  try {
    hljsP = hljsP || script(HLJS);
    await hljsP;
    const hl = window.hljs;
    if (!hl || codeEl.dataset.hl) return;
    codeEl.dataset.hl = '1';
    const l = (lang || '').toLowerCase();
    const name = l && hl.getLanguage(l) ? l : null;
    const text = codeEl.textContent;
    const r = name ? hl.highlight(text, { language: name, ignoreIllegals: true }) : hl.highlightAuto(text);
    codeEl.innerHTML = r.value;
    codeEl.classList.add('hljs');
    if (!codeEl.dataset.lang && r.language) codeEl.dataset.detected = r.language;
  } catch { /* 강조 없이 표시 */ }
}

export async function renderMath(el) {
  try {
    if (!katexP) {
      const l = document.createElement('link');
      l.rel = 'stylesheet';
      l.href = KATEX_CSS;
      l.crossOrigin = 'anonymous';
      document.head.append(l);
      katexP = script(KATEX_JS);
    }
    await katexP;
    window.katex.render(el.dataset.tex, el, { displayMode: el.classList.contains('display'), throwOnError: false, output: 'html' });
    el.classList.add('rendered');
  } catch { /* 원문 그대로 표시 */ }
}
