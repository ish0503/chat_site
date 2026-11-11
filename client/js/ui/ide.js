// 코드 작업실 (IDE): 프로젝트 목록 → 탐색기(폴더·파일) + 편집기(탭) + 실행(콘솔·미리보기)
// 파일은 작업 공간 항목(kind: project / folder / file)으로 저장되어 서버와 동기화되고, 오프라인이면 기기에 저장됩니다.
import {
  h, toast, uid, escapeHtml, debounce, fmtStamp, fmtBytes, isMobile,
} from '../util.js';
import {
  run, runnable, langFromName, loadHighlighter,
} from '../runner.js';
import { makeZip } from '../zip.js';
import { icon } from './icons.js';
import {
  openModal, openMenu, confirmDialog, field, avatar,
} from './common.js';
import { errorText } from './errors.js';
import { createArduinoPane } from './arduino.js';
import { starterCircuit, emptyCircuit, STARTER_SKETCH } from '../arduino/parts.js';

const TEMPLATES = {
  empty: { label: '빈 프로젝트', desc: '파일 없이 시작', files: { 'README.md': '# 새 프로젝트\n' } },
  web: {
    label: '웹 (HTML · CSS · JS)', desc: '실행하면 미리보기',
    files: {
      'index.html': '<!doctype html>\n<html lang="ko">\n<head>\n  <meta charset="utf-8">\n  <title>내 웹 페이지</title>\n  <link rel="stylesheet" href="style.css">\n</head>\n<body>\n  <h1>안녕하세요 👋</h1>\n  <button id="btn">눌러 보세요</button>\n  <p id="out"></p>\n  <script src="main.js"></script>\n</body>\n</html>\n',
      'style.css': 'body {\n  font-family: system-ui, sans-serif;\n  padding: 24px;\n}\n\nbutton {\n  padding: 8px 16px;\n  font-size: 16px;\n}\n',
      'main.js': "let count = 0;\nconst out = document.getElementById('out');\n\ndocument.getElementById('btn').addEventListener('click', () => {\n  count += 1;\n  out.textContent = `${count}번 눌렀어요`;\n  console.log('클릭', count);\n});\n",
    },
  },
  python: {
    label: 'Python', desc: '여러 파일 import 가능',
    files: {
      'main.py': 'from utils import greet\n\nfor name in ["철수", "영희"]:\n    print(greet(name))\n',
      'utils.py': 'def greet(name):\n    return f"안녕, {name}!"\n',
    },
  },
  js: {
    label: 'JavaScript', desc: '모듈 import 가능',
    files: {
      'main.js': "import { add } from './lib/math.js';\n\nconsole.log('1 + 2 =', add(1, 2));\n",
      'lib/math.js': 'export function add(a, b) {\n  return a + b;\n}\n',
    },
  },
  arduino: {
    label: '아두이노 (.ino)', desc: '회로 연결 + 시리얼 모니터',
    files: { 'sketch.ino': STARTER_SKETCH, 'sketch.circuit.json': JSON.stringify(starterCircuit(), null, 1) },
  },
};
// 아두이노: 스케치(.ino) 옆에 같은 이름의 회로 파일(.circuit.json)을 둠
const isIno = (f) => !!f && f.kind === 'file' && /\.ino$/i.test(f.name);
const circuitName = (inoName) => `${inoName.replace(/\.ino$/i, '')}.circuit.json`;
const blankCircuit = () => ({ ...emptyCircuit(), parts: [{ id: 'bb1', type: 'breadboard', x: 0, y: 250, props: {} }] });
const LANG_NAME = { javascript: 'JavaScript', python: 'Python', html: 'HTML', css: 'CSS', json: 'JSON', markdown: 'Markdown', typescript: 'TypeScript', plaintext: '텍스트', cpp: 'C++', c: 'C' };
const PAIRS = { '(': ')', '[': ']', '{': '}', '"': '"', "'": "'", '`': '`' };
const COMMENT = { python: '# ', bash: '# ', yaml: '# ', sql: '-- ', html: null, css: null, markdown: null };
const ext = (name) => (name.includes('.') ? name.split('.').pop().toLowerCase() : '');
const b64 = (s) => btoa(String.fromCharCode(...new TextEncoder().encode(s)));

// ───────── 편집기 (구문 강조 층 위에 투명한 입력창을 겹침) ─────────
function createEditor({ onChange, onSave, onRun, readOnly }) {
  const ta = h('textarea', { class: 'ed-input', spellcheck: 'false', autocapitalize: 'off', autocomplete: 'off', autocorrect: 'off', wrap: 'off', 'aria-label': '코드 편집기', readonly: readOnly });
  const code = h('code', {});
  const pre = h('pre', { class: 'ed-hl', 'aria-hidden': 'true' }, code);
  const gutter = h('div', { class: 'ed-gutter', 'aria-hidden': 'true' });
  const el = h('div', { class: 'editor' }, gutter, h('div', { class: 'ed-body' }, pre, ta));
  let lang = null;
  let hl = null;
  let lines = 0;
  loadHighlighter().then((x) => { hl = x; paint(); });

  function paint() {
    const text = ta.value;
    let html;
    if (hl && lang && hl.getLanguage(lang) && text.length < 120_000) {
      try { html = hl.highlight(text, { language: lang, ignoreIllegals: true }).value; } catch { html = escapeHtml(text); }
    } else html = escapeHtml(text);
    code.innerHTML = `${html}\n`;
    const n = text.split('\n').length;
    if (n !== lines) { lines = n; gutter.textContent = Array.from({ length: n }, (_, i) => i + 1).join('\n'); }
  }
  const paintSoon = debounce(paint, 60);
  const changed = () => { if (ta.value.length < 20_000) paint(); else paintSoon(); onChange?.(ta.value); };
  const sync = () => { pre.scrollTop = ta.scrollTop; pre.scrollLeft = ta.scrollLeft; gutter.scrollTop = ta.scrollTop; };
  ta.addEventListener('scroll', sync, { passive: true });
  ta.addEventListener('input', changed);

  /** 선택 영역을 바꾸면서 실행 취소(Ctrl+Z) 기록을 유지 */
  function replace(start, end, text, selStart, selEnd) {
    ta.focus();
    ta.setSelectionRange(start, end);
    if (!document.execCommand?.('insertText', false, text)) { ta.setRangeText(text, start, end, 'end'); changed(); }
    if (selStart !== undefined) ta.setSelectionRange(selStart, selEnd ?? selStart);
  }
  const lineStart = (pos) => ta.value.lastIndexOf('\n', pos - 1) + 1;

  ta.addEventListener('keydown', (e) => {
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); onSave?.(); return; }
    if (mod && e.key === 'Enter') { e.preventDefault(); onRun?.(); return; }
    if (readOnly) return;
    const s = ta.selectionStart;
    const en = ta.selectionEnd;
    const v = ta.value;
    if (e.key === 'Tab') {
      e.preventDefault();
      if (s === en && !e.shiftKey) return replace(s, en, '  ');
      // 여러 줄 들여쓰기 / 내어쓰기
      const from = lineStart(s);
      const block = v.slice(from, en);
      const out = e.shiftKey ? block.replace(/^ {1,2}/gm, '') : block.replace(/^/gm, '  ');
      return replace(from, en, out, from, from + out.length);
    }
    if (e.key === 'Enter' && !e.isComposing) {
      e.preventDefault();
      const line = v.slice(lineStart(s), s);
      const indent = line.match(/^[ \t]*/)[0];
      const opener = /[{([:]\s*$/.test(line);
      const closer = opener && /^[})\]]/.test(v.slice(en));
      const ins = `\n${indent}${opener ? '  ' : ''}${closer ? `\n${indent}` : ''}`;
      const caret = s + 1 + indent.length + (opener ? 2 : 0);
      return replace(s, en, ins, caret);
    }
    if (mod && e.key === '/') {
      e.preventDefault();
      const mark = COMMENT[lang] === undefined ? '// ' : COMMENT[lang];
      if (!mark) return;
      const from = lineStart(s);
      const to = v.indexOf('\n', en) < 0 ? v.length : v.indexOf('\n', en);
      const rows = v.slice(from, to).split('\n');
      const all = rows.every((r) => !r.trim() || r.trimStart().startsWith(mark.trim()));
      const out = rows.map((r) => (all ? r.replace(new RegExp(`^(\\s*)${mark.trim().replace(/[/*#-]/g, '\\$&')} ?`), '$1') : r.replace(/^(\s*)/, `$1${mark}`))).join('\n');
      return replace(from, to, out, from, from + out.length);
    }
    if (PAIRS[e.key] && !mod && !e.altKey) {
      if (s !== en) { e.preventDefault(); return replace(s, en, e.key + v.slice(s, en) + PAIRS[e.key], s + 1, en + 1); }
      const next = v[s] || '';
      const quote = e.key === PAIRS[e.key];
      if (quote && next === e.key) { e.preventDefault(); return ta.setSelectionRange(s + 1, s + 1); }
      if ((!next || /[\s)\]}>,;]/.test(next)) && !(quote && /\w/.test(v[s - 1] || ''))) { e.preventDefault(); return replace(s, en, e.key + PAIRS[e.key], s + 1); }
    }
    if ([')', ']', '}'].includes(e.key) && s === en && v[s] === e.key) { e.preventDefault(); ta.setSelectionRange(s + 1, s + 1); }
    if (e.key === 'Backspace' && s === en && PAIRS[v[s - 1]] && v[s] === PAIRS[v[s - 1]]) { e.preventDefault(); replace(s - 1, s + 1, ''); }
  });

  return {
    el,
    ta,
    get value() { return ta.value; },
    set(text, language) { lang = language; ta.value = text; lines = 0; paint(); ta.scrollTop = 0; ta.scrollLeft = 0; sync(); },
    /** 내용만 바꾸고 커서 · 스크롤은 유지 (다른 사람의 수정 반영) */
    update(text) { const s = ta.selectionStart; const top = ta.scrollTop; ta.value = text; paint(); ta.setSelectionRange(Math.min(s, text.length), Math.min(s, text.length)); ta.scrollTop = top; sync(); },
    selection() {
      const v = ta.value;
      const a = ta.selectionStart; const b = ta.selectionEnd;
      return { text: v.slice(a, b), from: v.slice(0, a).split('\n').length, to: v.slice(0, b).split('\n').length };
    },
    goto(line) {
      const rows = ta.value.split('\n');
      const pos = rows.slice(0, line - 1).join('\n').length + (line > 1 ? 1 : 0);
      ta.focus();
      ta.setSelectionRange(pos, pos + (rows[line - 1] || '').length);
      ta.scrollTop = Math.max(0, (line - 4) * 20);
    },
    focus: () => ta.focus(),
  };
}

// ───────── 코드 작업실 ─────────
/** host: { ctx, roomId, items(Map), canEdit } — workspace.js 가 만들어 줌 */
export function createIde(host) {
  const { ctx } = host;
  const { data } = ctx;
  const el = h('div', { class: 'ide' });
  const st = {
    project: null, tabs: [], active: null, buffers: new Map(), collapsed: new Set(), runCtl: null, outOpen: false, explorerOpen: !isMobile(), remote: new Map(), focus: new Map(), arduFile: null,
  };
  const stateKey = () => `cs.ide.${host.roomId}`;
  const saveState = () => { try { localStorage.setItem(stateKey(), JSON.stringify({ project: st.project, tabs: st.tabs, active: st.active })); } catch { /* noop */ } };

  const all = () => [...host.items.values()];
  const kids = (parentId) => all().filter((i) => i.parentId === parentId && i.kind !== 'project')
    .sort((a, b) => (a.kind === 'file') - (b.kind === 'file') || a.name.localeCompare(b.name, 'ko', { numeric: true }));
  const projects = () => all().filter((i) => i.kind === 'project').sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  const descendants = (id) => { const out = []; const walk = (p) => { for (const k of kids(p)) { out.push(k); walk(k.id); } }; walk(id); return out; };
  const projectFiles = (pid = st.project) => descendants(pid).filter((i) => i.kind === 'file');
  const pathOf = (item) => { const p = []; for (let c = item; c && c.kind !== 'project'; c = host.items.get(c.parentId)) p.unshift(c.name); return p.join('/'); };
  const contentOf = (f) => (st.buffers.has(f.id) ? st.buffers.get(f.id) : f.content || '');
  const dirty = (id) => st.buffers.has(id) && st.buffers.get(id) !== (host.items.get(id)?.content || '');
  const guard = (fn) => async (...a) => { try { return await fn(...a); } catch (e) { toast(errorText(e), 'error'); return null; } };

  // ── 프로젝트 목록 ──
  function renderProjects() {
    const list = projects();
    el.className = 'ide ide-home';
    el.replaceChildren(
      h('div', { class: 'ide-home-head' }, h('h2', {}, icon('code', 22), ' 프로젝트'), h('span', { class: 'muted' }, `${list.length}개`),
        host.canEdit ? h('span', { class: 'ide-home-actions' },
          h('button', { class: 'btn secondary small', onclick: (e) => arduinoMenu(e.currentTarget) }, icon('chip', 16), ' 아두이노'),
          h('button', { class: 'btn primary small', onclick: () => newProject() }, icon('plus', 16), ' 새 프로젝트')) : null, inoInput),
      list.length ? h('div', { class: 'project-grid' }, list.map((p) => {
        const files = projectFiles(p.id);
        const langs = [...new Set(files.filter((f) => !/\.circuit\.json$/.test(f.name)).map((f) => (isIno(f) ? '아두이노' : LANG_NAME[langFromName(f.name)] || ext(f.name).toUpperCase())).filter(Boolean))].slice(0, 3);
        return h('div', { class: 'project-card', role: 'button', tabindex: '0', onclick: () => openProject(p.id), onkeydown: (e) => { if (e.key === 'Enter') openProject(p.id); } },
          h('div', { class: 'project-icon' }, icon(files.some(isIno) ? 'chip' : 'folder', 26)),
          h('div', { class: 'project-info' }, h('strong', { class: 'ellipsis' }, p.name), h('span', { class: 'muted small' }, `${langs.join(' · ') || '빈 프로젝트'} · 파일 ${files.length}개`),
            h('span', { class: 'muted small' }, `${fmtStamp(Math.max(p.updatedAt || 0, ...files.map((f) => f.updatedAt || 0)))} 수정`)),
          h('button', { class: 'icon-btn tiny', 'aria-label': `${p.name} 메뉴`, onclick: (e) => { e.stopPropagation(); projectMenu(p, e.currentTarget); } }, icon('more', 18)));
      })) : h('div', { class: 'empty' }, icon('code', 40), h('h3', {}, '아직 프로젝트가 없습니다'),
        h('p', { class: 'muted' }, host.canEdit ? '새 프로젝트를 만들어 파일을 추가하고, 편집하고, 바로 실행해 보세요.' : '로그인한 사용자가 프로젝트를 만들면 여기에 표시됩니다.')),
      h('p', { class: 'muted small ide-note' }, '코드는 브라우저 안의 격리된 샌드박스에서 실행됩니다 (HTML · JavaScript · Python). 이 사이트의 로그인 정보에는 접근할 수 없습니다. 아두이노 스케치(.ino)는 회로를 연결해 시뮬레이터로 실행합니다.'));
  }

  // ── 아두이노 스케치 만들기 · 불러오기 ──
  // accept 를 두지 않음: iPhone 은 .ino 처럼 모르는 확장자를 고를 수 없게 회색으로 막아 버림
  const inoInput = h('input', { type: 'file', hidden: true, onchange: () => { const f = inoInput.files[0]; inoInput.value = ''; if (f) importIno(f); } });
  function arduinoMenu(anchor) {
    openMenu(anchor, [
      { label: '새 아두이노 스케치 만들기', icon: 'plus', onClick: () => newProject('arduino') },
      { label: '.ino 파일 불러오기', icon: 'clip', onClick: () => inoInput.click() },
    ]);
  }
  const importIno = guard(async (file) => {
    if (file.size > 200_000) return toast('파일이 너무 큽니다 (최대 200KB).', 'warn');
    const text = await file.text();
    if (text.includes('\u0000')) return toast('텍스트 파일이 아닙니다.', 'warn');
    const base = file.name.replace(/\.[^.]+$/, '').replace(/\//g, '_').slice(0, 80) || 'sketch';
    const pid = uid();
    await data.putWsMany(host.roomId, [{ id: pid, kind: 'project', name: base, template: 'arduino' },
      ...filesToItems({ [`${base}.ino`]: text, [circuitName(`${base}.ino`)]: JSON.stringify(blankCircuit(), null, 1) }, pid)]);
    openProject(pid);
    toast('스케치를 불러왔습니다. 오른쪽에서 회로를 연결하고 ▶ 실행을 누르세요.', 'success', 4500);
    return null;
  });
  /** 열려 있는 프로젝트에 스케치 추가 */
  const addSketch = guard(async () => {
    const active = host.items.get(st.active);
    const parent = active ? active.parentId : st.project;
    const name = uniqueName(parent, 'sketch.ino');
    const id = uid();
    await data.putWsMany(host.roomId, [{ id, kind: 'file', name, parentId: parent, content: STARTER_SKETCH },
      { id: uid(), kind: 'file', name: circuitName(name), parentId: parent, content: JSON.stringify(starterCircuit(), null, 1) }]);
    openFile(id);
  });

  function projectMenu(p, anchor) {
    openMenu(anchor, [
      { label: '열기', icon: 'folderOpen', onClick: () => openProject(p.id) },
      { label: 'ZIP 으로 내보내기', icon: 'download', onClick: () => exportZip(p) },
      host.canEdit ? { label: '이름 변경', icon: 'edit', onClick: () => renameItem(p) } : null,
      host.canEdit ? 'sep' : null,
      host.canEdit ? { label: '삭제', icon: 'trash', danger: true, onClick: () => removeItem(p) } : null,
    ]);
  }

  function newProject(initial = 'web') {
    const name = h('input', { class: 'input', maxlength: '100', placeholder: initial === 'arduino' ? '내 아두이노' : '내 프로젝트', autofocus: true });
    let tpl = initial;
    const picker = h('div', { class: 'tpl-picker', role: 'radiogroup' });
    const render = () => picker.replaceChildren(...Object.entries(TEMPLATES).map(([k, t]) => h('button', {
      type: 'button', role: 'radio', 'aria-checked': String(k === tpl), class: `type-opt${k === tpl ? ' active' : ''}`, onclick: () => { tpl = k; render(); },
    }, h('span', { class: 'type-name' }, t.label), h('span', { class: 'type-desc' }, t.desc))));
    render();
    openModal({
      title: '새 프로젝트',
      body: [field('이름', name), h('div', { class: 'field' }, h('span', { class: 'field-label' }, '시작 템플릿'), picker)],
      actions: [{ label: '취소' }, {
        label: '만들기', kind: 'primary', submit: true,
        onClick: guard(async () => {
          const pid = uid();
          const items = [{ id: pid, kind: 'project', name: name.value.trim() || (tpl === 'arduino' ? '내 아두이노' : '내 프로젝트'), template: tpl }, ...filesToItems(TEMPLATES[tpl].files, pid)];
          await data.putWsMany(host.roomId, items);
          openProject(pid);
        }),
      }],
    });
  }

  /** { 'lib/math.js': '내용' } → 폴더 · 파일 항목 (이미 있는 폴더는 다시 만들지 않음) */
  function filesToItems(map, rootId) {
    const out = [];
    const folders = new Map();
    const folderId = (parts, parentId) => {
      let pid = parentId;
      let key = '';
      for (const name of parts) {
        key += `/${name}`;
        const k = `${parentId}${key}`;
        if (!folders.has(k)) {
          const existing = kids(pid).find((i) => i.kind === 'folder' && i.name === name);
          const id = existing?.id || uid();
          if (!existing) out.push({ id, kind: 'folder', name, parentId: pid });
          folders.set(k, id);
        }
        pid = folders.get(k);
      }
      return pid;
    };
    for (const [path, content] of Object.entries(map)) {
      const parts = path.split('/').filter(Boolean);
      const name = parts.pop();
      out.push({ id: uid(), kind: 'file', name, parentId: folderId(parts, rootId), content });
    }
    return out;
  }

  function exportZip(p) {
    const files = projectFiles(p.id).map((f) => ({ path: `${p.name}/${pathOf(f)}`, content: contentOf(f) }));
    if (!files.length) return toast('내보낼 파일이 없습니다.', 'warn');
    const url = URL.createObjectURL(makeZip(files));
    const a = h('a', { href: url, download: `${p.name}.zip` });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }

  // ── 프로젝트 화면 ──
  const editor = createEditor({
    readOnly: !host.canEdit,
    onChange: (text) => { if (!st.active) return; st.buffers.set(st.active, text); renderTabs(); autosave(); },
    onSave: () => save(st.active),
    onRun: () => runProject(),
  });
  const explorer = h('div', { class: 'ide-explorer', role: 'tree', 'aria-label': '파일 탐색기' });
  const tabsEl = h('div', { class: 'ide-tabs', role: 'tablist' });
  const editorWrap = h('div', { class: 'ide-editor' });
  const notice = h('div', { class: 'ide-notice', hidden: true });
  const outEl = h('div', { class: 'ide-out', hidden: true });
  const titleEl = h('strong', { class: 'ellipsis' });
  const statusEl = h('span', { class: 'muted small ide-status' });
  // 아두이노 창 (스케치 .ino 를 열면 오른쪽에 뜸): 위는 회로 연결, 아래는 시리얼 모니터
  const arduEl = h('div', { class: 'ide-ardu', hidden: true });
  let ardu = null;
  const arduToggle = h('button', { class: 'btn small secondary ide-ardu-toggle', hidden: true, onclick: () => (el.classList.contains('ardu-front') ? leave('ardu') : showArdu(true)) });
  function showArdu(front) {
    const was = el.classList.contains('ardu-front');
    el.classList.toggle('ardu-front', front);
    arduToggle.replaceChildren(icon(front ? 'code' : 'chip', 14), front ? ' 코드' : ' 회로 · 출력');
    if (front) ardu?.shown();
    if (front && !was && isMobile()) enter('ardu'); // 휴대폰: 회로 창이 코드를 덮으므로 한 단계로 셈
    if (!front) drop('ardu');
  }
  function setExplorer(open) {
    st.explorerOpen = open;
    el.classList.toggle('explorer-open', open);
    if (open && isMobile()) enter('explorer'); // 휴대폰: 탐색기가 편집기를 덮음
    if (!open) drop('explorer');
  }

  // ── 뒤로 가기: 지금 열린 단계를 하나씩 닫음 (회로 창 / 탐색기 → 코드 → 프로젝트 목록) ──
  // 휴대폰 · 브라우저의 뒤로 가기도 같은 순서로 동작하도록 단계마다 기록(history)을 하나씩 남김
  const nav = { layers: [], pushed: 0, base: 0 };
  const UNDO = { project: () => closeProject(), ardu: () => showArdu(false), explorer: () => setExplorer(false) };
  function enter(layer) {
    if (nav.layers.includes(layer)) return;
    nav.layers.push(layer);
    if (!nav.pushed) nav.base = nav.layers.length - 1;
    nav.pushed++;
    history.pushState({ ide: host.roomId, depth: nav.layers.length }, '', location.href);
  }
  /** 그 단계와 그 위의 단계를 목록에서 뺌 (화면은 이미 닫힌 상태) */
  function drop(layer) { const i = nav.layers.indexOf(layer); if (i >= 0) nav.layers.splice(i); }
  /** 그 단계를 닫음: 맨 위 단계이고 기록이 남아 있으면 브라우저 뒤로 가기로 (기록과 화면이 어긋나지 않게) */
  function leave(layer) {
    const s = history.state;
    if (nav.layers.at(-1) === layer && s?.ide === host.roomId && s.depth === nav.layers.length) history.back();
    else UNDO[layer]();
  }
  /** 뒤로 버튼: 맨 위 단계를 닫음 */
  const goBack = () => leave(nav.layers.at(-1) || 'project');
  function onPop(e) {
    const s = e.state;
    const target = s?.ide === host.roomId ? s.depth : nav.pushed ? nav.base : null;
    if (target === null) return;
    while (nav.layers.length > target) {
      const n = nav.layers.length;
      UNDO[nav.layers.at(-1)]();
      if (nav.layers.length === n) nav.layers.pop();
    }
    nav.pushed = Math.max(0, target - nav.base);
  }
  window.addEventListener('popstate', onPop);
  /** 스케치 맨 위(이미 있는 #include 들 바로 아래)에 #include 한 줄을 넣음 */
  function insertInclude(header) {
    if (!isIno(host.items.get(st.active))) return toast('스케치(.ino) 파일을 연 상태에서 넣을 수 있습니다.', 'warn');
    if (!host.canEdit) return toast('이 방에서는 파일을 고칠 수 없습니다.', 'warn');
    const text = editor.value;
    const name = header.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (new RegExp(`^[ \\t]*#[ \\t]*include[ \\t]*[<"]${name}[>"]`, 'm').test(text)) return toast(`#include <${header}> 는 이미 있습니다.`);
    const lines = text.split('\n');
    let at = -1;
    lines.forEach((l, i) => { if (/^[ \t]*#[ \t]*include\b/.test(l)) at = i; });
    lines.splice(at + 1, 0, `#include <${header}>`);
    const next = lines.join('\n');
    editor.update(next);
    st.buffers.set(st.active, next);
    renderTabs();
    autosave();
    return toast(`#include <${header}> 를 넣었습니다.`, 'success');
  }
  const arduCircuitFile = (ino) => kids(ino.parentId).find((k) => k.kind === 'file' && k.name === circuitName(ino.name));
  const saveCircuit = guard(async (text) => {
    const ino = host.items.get(st.arduFile);
    if (!ino || !host.canEdit) return;
    const file = arduCircuitFile(ino);
    st.buffers.delete(file?.id);
    await data.putWs(host.roomId, file ? { id: file.id, kind: 'file', content: text } : { id: uid(), kind: 'file', name: circuitName(ino.name), parentId: ino.parentId, content: text });
  });
  /** 지금 보는 파일이 스케치면 아두이노 창을 띄우고 그 스케치의 회로를 불러옴 */
  function syncArdu() {
    const f = host.items.get(st.active);
    const on = isIno(f);
    arduEl.hidden = !on;
    arduToggle.hidden = !on;
    el.classList.toggle('has-ardu', on);
    if (!on) { ardu?.stop({ quiet: true }); st.arduFile = null; el.classList.remove('ardu-front'); drop('ardu'); return; }
    if (!ardu) {
      ardu = createArduinoPane({
        canEdit: host.canEdit,
        onRun: () => runProject(),
        compile: (body) => data.compileSketch(body),
        libraries: { list: () => data.arduinoLibraries(), change: (id, action) => data.arduinoLibraryAction(id, action) },
        onInsertInclude: (header) => insertInclude(header),
        onGoto: (line) => { leave('ardu'); editor.goto(line); },
        onBack: () => leave('ardu'),
        saveCircuit,
      });
      arduEl.append(ardu.el);
    }
    if (st.arduFile !== f.id) { ardu.stop({ quiet: true }); st.arduFile = f.id; showArdu(false); ardu.setCircuit(arduCircuitFile(f)?.content, blankCircuit()); } else { const c = arduCircuitFile(f)?.content; if (c) ardu.setCircuit(c); }
    ardu.shown();
  }
  const uploadInput = h('input', { type: 'file', multiple: true, hidden: true, onchange: () => { importFiles([...uploadInput.files]); uploadInput.value = ''; } });

  const toolbar = h('div', { class: 'ide-bar' },
    h('button', { class: 'btn small ghost ide-back', title: '뒤로 (회로 창 · 탐색기를 닫고, 그다음 프로젝트 목록으로)', 'aria-label': '뒤로', onclick: () => goBack() }, icon('chevronLeft', 18), h('span', {}, '뒤로')),
    h('button', { class: 'icon-btn', title: '파일 탐색기', 'aria-label': '파일 탐색기 열기/닫기', onclick: () => (st.explorerOpen ? leave('explorer') : setExplorer(true)) }, icon('folder')),
    titleEl, statusEl, h('span', { class: 'grow' }), arduToggle,
    h('button', { class: 'btn small primary', title: '실행 (Ctrl+Enter)', onclick: () => runProject() }, icon('play', 14), ' 실행'),
    host.canEdit ? h('button', { class: 'icon-btn', title: '저장 (Ctrl+S)', 'aria-label': '저장', onclick: () => save(st.active) }, icon('check')) : null,
    h('button', { class: 'icon-btn', title: '프로젝트에서 찾기', 'aria-label': '프로젝트에서 찾기', onclick: () => searchDialog() }, icon('search')),
    h('button', { class: 'icon-btn', title: '더보기', 'aria-label': '프로젝트 메뉴', onclick: (e) => barMenu(e.currentTarget) }, icon('more')));
  const ideMain = h('div', { class: 'ide-main' },
    h('aside', { class: 'ide-side' },
      h('div', { class: 'ide-side-head' }, h('span', { class: 'grow' }, '탐색기'),
        host.canEdit ? h('button', { class: 'icon-btn tiny', title: '새 파일', 'aria-label': '새 파일', onclick: () => createItem('file') }, icon('file', 16)) : null,
        host.canEdit ? h('button', { class: 'icon-btn tiny', title: '새 폴더', 'aria-label': '새 폴더', onclick: () => createItem('folder') }, icon('folder', 16)) : null,
        host.canEdit ? h('button', { class: 'icon-btn tiny', title: '내 컴퓨터에서 파일 가져오기', 'aria-label': '파일 가져오기', onclick: () => uploadInput.click() }, icon('clip', 16)) : null),
      explorer, uploadInput),
    h('div', { class: 'ide-center' }, tabsEl, notice, editorWrap, outEl), arduEl);

  function openProject(id, restore = {}) {
    if (!host.items.has(id)) return renderProjects();
    st.project = id;
    st.tabs = (restore.tabs || []).filter((t) => host.items.get(t)?.kind === 'file');
    st.active = null;
    el.className = `ide ide-project${st.explorerOpen ? ' explorer-open' : ''}`;
    el.replaceChildren(toolbar, ideMain);
    // 뒤로 가기로 이 프로젝트의 기록에 돌아온 경우에는 기록을 새로 남기지 않음
    if (history.state?.ide === host.roomId && !nav.layers.length) { nav.layers = ['project']; nav.pushed = history.state.depth; nav.base = 0; } else enter('project');
    titleEl.textContent = host.items.get(id).name;
    renderExplorer();
    const files = projectFiles();
    const first = host.items.get(restore.active) || files.find((f) => /^(index\.html|main\.(py|js))$/.test(f.name)) || files.find(isIno) || files[0];
    if (first) openFile(first.id); else { renderTabs(); showEditor(); }
    saveState();
  }

  function closeProject() {
    drop('project');
    stopRun();
    ardu?.stop({ quiet: true });
    st.arduFile = null;
    st.project = null;
    st.tabs = [];
    st.active = null;
    data.sendWsFocus(host.roomId, null);
    saveState();
    renderProjects();
  }

  function renderExplorer() {
    const row = (item, depth) => {
      const folder = item.kind === 'folder';
      const open = folder && !st.collapsed.has(item.id);
      const watchers = [...st.focus.entries()].filter(([, v]) => v.id === item.id && v.until > Date.now()).map(([u]) => data.user(u)).filter(Boolean);
      const r = h('div', {
        class: `ide-row${item.id === st.active ? ' active' : ''}${folder ? ' folder' : ''}`, role: 'treeitem', tabindex: '0', style: { paddingLeft: `${8 + depth * 14}px` },
        draggable: host.canEdit ? 'true' : null, dataset: { id: item.id },
        onclick: () => { if (folder) { if (open) st.collapsed.add(item.id); else st.collapsed.delete(item.id); renderExplorer(); } else openFile(item.id); },
        onkeydown: (e) => { if (e.key === 'Enter') r.click(); if (e.key === 'F2' && host.canEdit) renameItem(item); if (e.key === 'Delete' && host.canEdit) removeItem(item); },
        oncontextmenu: (e) => { e.preventDefault(); itemMenu(item, e); },
        ondragstart: (e) => { e.dataTransfer.setData('text/x-ws', item.id); e.dataTransfer.effectAllowed = 'move'; },
        ondragover: (e) => { if (folder && e.dataTransfer.types.includes('text/x-ws')) { e.preventDefault(); r.classList.add('drop'); } },
        ondragleave: () => r.classList.remove('drop'),
        ondrop: (e) => { r.classList.remove('drop'); const id = e.dataTransfer.getData('text/x-ws'); if (folder && id) { e.preventDefault(); e.stopPropagation(); moveItem(id, item.id); } },
      }, folder ? icon(open ? 'chevronDown' : 'chevron', 12, 'dim') : h('span', { class: 'ide-indent' }),
      icon(folder ? (open ? 'folderOpen' : 'folder') : isIno(item) ? 'chip' : runnable(langFromName(item.name)) ? 'code' : 'file', 16, folder ? 'dim' : ''),
      h('span', { class: 'ellipsis grow' }, item.name),
      dirty(item.id) ? h('span', { class: 'ide-dot', title: '저장하지 않은 변경' }) : null,
      watchers.slice(0, 2).map((u) => h('span', { title: `${u.nickname}님이 보는 중` }, avatar(u, 16))),
      host.canEdit ? h('button', { class: 'icon-btn tiny row-more', 'aria-label': `${item.name} 메뉴`, onclick: (e) => { e.stopPropagation(); itemMenu(item, e.currentTarget); } }, icon('more', 14)) : null);
      return [r, ...(open ? kids(item.id).flatMap((k) => row(k, depth + 1)) : [])];
    };
    const roots = kids(st.project);
    explorer.replaceChildren(...(roots.length ? roots.flatMap((k) => row(k, 0)) : [h('p', { class: 'muted small pad' }, host.canEdit ? '파일이 없습니다. 위의 버튼으로 새 파일을 만드세요.' : '파일이 없습니다.')]));
  }
  // 탐색기 빈 곳에 놓으면 프로젝트 맨 위로 이동
  explorer.addEventListener('dragover', (e) => { if (e.dataTransfer.types.includes('text/x-ws')) e.preventDefault(); });
  explorer.addEventListener('drop', (e) => { const id = e.dataTransfer.getData('text/x-ws'); if (id) { e.preventDefault(); moveItem(id, st.project); } });

  function itemMenu(item, anchor) {
    const folder = item.kind === 'folder';
    openMenu(anchor, [
      folder && host.canEdit ? { label: '여기에 새 파일', icon: 'file', onClick: () => createItem('file', item.id) } : null,
      folder && host.canEdit ? { label: '여기에 새 폴더', icon: 'folder', onClick: () => createItem('folder', item.id) } : null,
      !folder ? { label: '열기', icon: 'file', onClick: () => openFile(item.id) } : null,
      !folder ? { label: '버전 기록', icon: 'history', onClick: () => historyDialog(item) } : null,
      !folder ? { label: '경로 복사', icon: 'copy', onClick: () => navigator.clipboard?.writeText(pathOf(item)).then(() => toast('경로를 복사했습니다.')) } : null,
      host.canEdit ? { label: '이름 변경 (F2)', icon: 'edit', onClick: () => renameItem(item) } : null,
      host.canEdit && !folder ? { label: '복제', icon: 'copy', onClick: guard(() => data.putWs(host.roomId, { id: uid(), kind: 'file', name: uniqueName(item.parentId, item.name), parentId: item.parentId, content: contentOf(item) })) } : null,
      host.canEdit ? 'sep' : null,
      host.canEdit ? { label: '삭제', icon: 'trash', danger: true, onClick: () => removeItem(item) } : null,
    ]);
  }

  function uniqueName(parentId, name) {
    const names = new Set(kids(parentId).map((k) => k.name));
    if (!names.has(name)) return name;
    const dot = name.lastIndexOf('.');
    const [base, e] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ''];
    for (let i = 2; ; i++) if (!names.has(`${base}-${i}${e}`)) return `${base}-${i}${e}`;
  }

  function askName(title, value, onOk) {
    const input = h('input', { class: 'input', maxlength: '100', value, autofocus: true, required: true });
    openModal({
      title,
      body: field('이름', input, '폴더까지 한 번에: src/app.js 처럼 / 로 구분'),
      actions: [{ label: '취소' }, { label: '확인', kind: 'primary', submit: true, onClick: () => { const v = input.value.trim(); if (!v) return false; onOk(v); } }],
    });
    setTimeout(() => { const dot = value.lastIndexOf('.'); input.setSelectionRange(0, dot > 0 ? dot : value.length); }, 50);
  }

  function createItem(kind, parentId) {
    const activeItem = host.items.get(st.active);
    const parent = parentId || (activeItem ? activeItem.parentId : st.project);
    askName(kind === 'file' ? '새 파일' : '새 폴더', kind === 'file' ? 'untitled.js' : '새 폴더', guard(async (path) => {
      const clean = path.split('/').map((x) => x.trim()).filter(Boolean).join('/');
      if (!clean) return;
      // 경로에 있는 폴더 중 없는 것은 함께 만듦
      const items = filesToItems({ [kind === 'file' ? clean : `${clean}/.keep`]: '' }, parent);
      const file = items.pop();
      if (kind === 'file') {
        if (kids(file.parentId).some((k) => k.name === file.name)) return toast('같은 이름이 이미 있습니다.', 'warn');
        items.push(file);
      } else if (!items.length) return toast('같은 이름의 폴더가 이미 있습니다.', 'warn');
      await data.putWsMany(host.roomId, items);
      st.collapsed.delete(file.parentId);
      if (kind === 'file') openFile(file.id); else renderExplorer();
    }));
  }

  function renameItem(item) {
    askName('이름 변경', item.name, guard(async (name) => {
      const clean = name.replace(/\//g, '_');
      if (clean === item.name) return;
      if (item.kind !== 'project' && kids(item.parentId).some((k) => k.name === clean)) return toast('같은 이름이 이미 있습니다.', 'warn');
      await data.putWs(host.roomId, { id: item.id, kind: item.kind, name: clean });
    }));
  }

  async function removeItem(item) {
    const n = descendants(item.id).length;
    const ok = await confirmDialog({ title: '삭제', message: `'${item.name}'${n ? ` 과(와) 그 안의 항목 ${n}개` : ''}를 삭제할까요?`, confirmText: '삭제', danger: true });
    if (ok) guard(() => data.deleteWs(host.roomId, [item.id]))();
  }

  const moveItem = guard(async (id, parentId) => {
    const item = host.items.get(id);
    if (!item || item.parentId === parentId || id === parentId) return;
    if (descendants(id).some((d) => d.id === parentId)) return toast('폴더를 자기 안으로 옮길 수 없습니다.', 'warn');
    if (kids(parentId).some((k) => k.name === item.name)) return toast('옮길 곳에 같은 이름이 있습니다.', 'warn');
    await data.putWs(host.roomId, { id, kind: item.kind, parentId });
  });

  async function importFiles(list) {
    const map = {};
    for (const f of list.slice(0, 50)) {
      if (f.size > 200_000) { toast(`'${f.name}' 은(는) 너무 큽니다 (최대 200KB).`, 'warn'); continue; }
      const text = await f.text();
      if (text.includes('\u0000')) { toast(`'${f.name}' 은(는) 텍스트 파일이 아닙니다.`, 'warn'); continue; }
      map[uniqueName(st.project, f.webkitRelativePath || f.name)] = text;
    }
    if (Object.keys(map).length) guard(() => data.putWsMany(host.roomId, filesToItems(map, st.project)))();
  }

  // ── 탭 · 편집 ──
  function openFile(id, line) {
    const f = host.items.get(id);
    if (!f || f.kind !== 'file') return;
    if (!st.tabs.includes(id)) st.tabs.push(id);
    st.active = id;
    st.remote.delete(id);
    for (let p = host.items.get(f.parentId); p && p.kind === 'folder'; p = host.items.get(p.parentId)) st.collapsed.delete(p.id);
    renderTabs();
    renderExplorer();
    showEditor();
    editor.set(contentOf(f), langFromName(f.name) || 'plaintext');
    if (line) editor.goto(line);
    if (isMobile() && st.explorerOpen) leave('explorer');
    data.sendWsFocus(host.roomId, id);
    saveState();
  }

  async function closeTab(id) {
    if (dirty(id) && host.canEdit) await save(id);
    st.buffers.delete(id);
    st.tabs = st.tabs.filter((t) => t !== id);
    if (st.active === id) {
      st.active = null;
      if (st.tabs.length) return openFile(st.tabs.at(-1));
      data.sendWsFocus(host.roomId, null);
    }
    renderTabs();
    renderExplorer();
    showEditor();
    saveState();
  }

  function renderTabs() {
    tabsEl.replaceChildren(...st.tabs.map((id) => {
      const f = host.items.get(id);
      if (!f) return null;
      return h('div', { class: `ide-tab${id === st.active ? ' active' : ''}`, role: 'tab', 'aria-selected': String(id === st.active), title: pathOf(f), onclick: () => openFile(id), onauxclick: (e) => { if (e.button === 1) closeTab(id); } },
        h('span', { class: 'ellipsis' }, f.name),
        h('button', { class: `ide-tab-x${dirty(id) ? ' dirty' : ''}`, 'aria-label': `${f.name} 닫기`, onclick: (e) => { e.stopPropagation(); closeTab(id); } }, dirty(id) ? '●' : '×'));
    }));
    const f = host.items.get(st.active);
    statusEl.textContent = f ? `${pathOf(f)}${dirty(f.id) ? ' · 저장 안 됨' : ''}` : '';
  }

  function showEditor() {
    renderNotice();
    syncArdu();
    if (st.active) { if (editorWrap.firstChild !== editor.el) editorWrap.replaceChildren(editor.el); return; }
    editorWrap.replaceChildren(h('div', { class: 'empty' }, icon('file', 40), h('h3', {}, '파일을 선택하세요'),
      h('p', { class: 'muted' }, '왼쪽 탐색기에서 파일을 열거나 새 파일을 만드세요.'),
      h('p', { class: 'muted small' }, 'Ctrl+S 저장 · Ctrl+Enter 실행 · Ctrl+/ 주석 · Tab 들여쓰기')));
  }

  async function save(id) {
    if (!id || !host.canEdit || !dirty(id)) return;
    const f = host.items.get(id);
    const content = st.buffers.get(id);
    if (content.length > 200_000) return toast('파일이 너무 큽니다 (최대 200,000자).', 'error');
    try {
      await data.putWs(host.roomId, { id, kind: 'file', content });
      if (st.buffers.get(id) === content) st.buffers.delete(id);
      st.remote.delete(id);
      renderTabs();
      renderExplorer();
      renderNotice();
    } catch (e) {
      toast(`'${f?.name}' 저장 실패: ${errorText(e)}`, 'error');
    }
  }
  // 입력을 멈추면 자동 저장 → 같이 보는 사람에게 바로 반영
  const autosave = debounce(() => { if (st.active) save(st.active); }, 1500);

  function renderNotice() {
    const r = st.remote.get(st.active);
    notice.hidden = !r;
    if (!r) return;
    const f = host.items.get(st.active);
    notice.replaceChildren(icon('alert', 14), h('span', { class: 'grow' }, `${data.user(r.by)?.nickname || '다른 사람'}님이 이 파일을 고쳤습니다. 내가 고친 내용과 다릅니다.`),
      h('button', { class: 'btn small secondary', onclick: () => { st.buffers.delete(f.id); st.remote.delete(f.id); editor.update(f.content || ''); renderTabs(); renderNotice(); } }, '불러오기'),
      h('button', { class: 'btn small ghost', onclick: () => { st.remote.delete(f.id); renderNotice(); } }, '내 것 유지'));
  }

  async function historyDialog(f) {
    const box = h('div', { class: 'history' }, h('div', { class: 'spinner' }));
    const m = openModal({ title: `버전 기록 · ${f.name}`, body: [h('p', { class: 'muted small' }, '저장할 때마다 이전 내용이 최근 10개까지 남습니다.'), box], actions: [{ label: '닫기' }] });
    const list = (await data.wsHistory(host.roomId, f.id).catch(() => [])).reverse();
    box.replaceChildren(...(list.length ? list.map((v) => h('div', { class: 'history-item' },
      h('div', { class: 'row gap' }, h('span', { class: 'muted small grow' }, `${fmtStamp(v.at)} · ${data.user(v.by)?.nickname || '?'} · ${fmtBytes(v.content.length)}`),
        host.canEdit ? h('button', {
          class: 'btn small secondary', onclick: guard(async () => { await data.putWs(host.roomId, { id: f.id, kind: 'file', content: v.content }); st.buffers.delete(f.id); if (st.active === f.id) editor.update(v.content); m.close(); toast('이 버전으로 되돌렸습니다.', 'success'); }),
        }, '되돌리기') : null),
      h('pre', { class: 'mono small pre history-code' }, v.content.slice(0, 1500) + (v.content.length > 1500 ? '\n…' : '')))) : [h('p', { class: 'muted' }, data.isOnline ? '아직 이전 버전이 없습니다.' : '버전 기록은 서버에 연결되어 있을 때 볼 수 있습니다.')]));
  }

  function searchDialog() {
    const input = h('input', { class: 'input', type: 'search', placeholder: '프로젝트 전체에서 찾기', autofocus: true });
    const results = h('div', { class: 'qs-results' });
    let m = null;
    input.addEventListener('input', () => {
      const q = input.value.toLowerCase();
      if (q.length < 2) return results.replaceChildren();
      const hits = [];
      for (const f of projectFiles()) {
        if (f.name.toLowerCase().includes(q)) hits.push({ f, line: 1, text: '(파일 이름)' });
        contentOf(f).split('\n').forEach((t, i) => { if (hits.length < 80 && t.toLowerCase().includes(q)) hits.push({ f, line: i + 1, text: t.trim().slice(0, 120) }); });
      }
      results.replaceChildren(...(hits.length ? hits.map((x) => h('button', { class: 'qs-item', type: 'button', onclick: () => { m.close(); openFile(x.f.id, x.line); } },
        h('span', { class: 'mono small' }, `${pathOf(x.f)}:${x.line}`), h('span', { class: 'muted small ellipsis' }, x.text))) : [h('p', { class: 'muted small pad' }, '찾는 내용이 없습니다.')]));
    });
    m = openModal({ title: '프로젝트에서 찾기', cls: 'qs-modal', body: [input, results] });
  }

  function barMenu(anchor) {
    const p = host.items.get(st.project);
    const sel = st.active ? editor.selection() : null;
    openMenu(anchor, [
      st.active && data.can('sendMessage') ? { label: sel?.text ? `선택한 ${sel.to - sel.from + 1}줄을 채팅으로 보내기` : '이 파일을 채팅으로 보내기', icon: 'message', onClick: () => shareToChat() } : null,
      st.active ? { label: '버전 기록', icon: 'history', onClick: () => historyDialog(host.items.get(st.active)) } : null,
      { label: 'ZIP 으로 내보내기', icon: 'download', onClick: () => exportZip(p) },
      host.canEdit ? { label: '파일 가져오기', icon: 'clip', onClick: () => uploadInput.click() } : null,
      host.canEdit ? { label: '아두이노 스케치 추가 (.ino)', icon: 'chip', onClick: () => addSketch() } : null,
      host.canEdit ? { label: '프로젝트 이름 변경', icon: 'edit', onClick: () => renameItem(p) } : null,
      { label: st.outOpen ? '실행 창 닫기' : '실행 창 열기', icon: 'play', onClick: () => toggleOut(!st.outOpen) },
    ]);
  }

  /** 코드와 대화 연결: 선택한 줄(또는 파일)을 줄 번호와 함께 이 방의 채팅으로 */
  const shareToChat = guard(async () => {
    const f = host.items.get(st.active);
    const sel = editor.selection();
    const body = (sel.text || editor.value).slice(0, 3500);
    const where = sel.text ? ` (${sel.from}${sel.to > sel.from ? `–${sel.to}` : ''}줄)` : '';
    await data.sendMessage(host.roomId, { content: `📄 **${host.items.get(st.project).name}/${pathOf(f)}**${where}\n\`\`\`${ext(f.name)}\n${body}\n\`\`\`` });
    toast('채팅으로 보냈습니다. 💬 채팅에서 이어서 이야기하세요.', 'success', 4000, { label: '채팅 열기', onClick: () => ctx.showRoomChat(host.roomId) });
  });

  // ── 실행 ──
  const fileAt = (base, rel) => {
    const parts = rel.startsWith('/') ? [] : base.split('/').slice(0, -1);
    for (const seg of rel.split(/[?#]/)[0].split('/')) { if (seg === '..') parts.pop(); else if (seg && seg !== '.') parts.push(seg); }
    const path = parts.join('/');
    return projectFiles().find((f) => pathOf(f) === path);
  };
  /** ES 모듈의 상대 경로 import 를 프로젝트 파일 내용(data: URL)으로 바꿈 */
  function bundleModule(file, seen = []) {
    const path = pathOf(file);
    if (seen.includes(path)) throw new Error(`서로를 import 하는 파일이 있습니다: ${[...seen, path].join(' → ')}`);
    const inline = (all, pre, q, spec) => {
      if (!/^\.{0,2}\//.test(spec)) return all;
      const dep = fileAt(path, spec) || fileAt(path, `${spec}.js`);
      if (!dep) throw new Error(`${path}: '${spec}' 파일을 찾을 수 없습니다.`);
      return `${pre}${q}data:text/javascript;charset=utf-8,${encodeURIComponent(bundleModule(dep, [...seen, path]))}${q}`;
    };
    return contentOf(file)
      .replace(/(\bfrom\s*)(['"])([^'"\n]+)\2/g, inline)
      .replace(/(\bimport\s*)(['"])([^'"\n]+)\2/g, inline)
      .replace(/(\bimport\s*\(\s*)(['"])([^'"\n]+)\2/g, inline);
  }
  /** HTML 안의 <link href> · <script src> 를 프로젝트 파일 내용으로 바꿈 */
  function buildHtml(file) {
    const path = pathOf(file);
    return contentOf(file)
      .replace(/<link\b[^>]*\bhref=(['"])([^'"]+)\1[^>]*>/gi, (all, q, href) => {
        const f = /stylesheet/i.test(all) && !/^[a-z]+:|^\/\//i.test(href) ? fileAt(path, href) : null;
        return f ? `<style>/* ${href} */\n${contentOf(f).replace(/<\/style/gi, '<\\/style')}</style>` : all;
      })
      .replace(/<script\b([^>]*)\bsrc=(['"])([^'"]+)\2([^>]*)>\s*<\/script>/gi, (all, a, q, src, b) => {
        const f = !/^[a-z]+:|^\/\//i.test(src) ? fileAt(path, src) : null;
        if (!f) return all;
        const module = /type=['"]module['"]/i.test(a + b);
        return `<script${a}${b}>/* ${src} */\n${(module ? bundleModule(f) : contentOf(f)).replace(/<\/script/gi, '<\\/script')}</script>`;
      });
  }

  function stopRun() { st.runCtl?.close(); st.runCtl = null; }
  function toggleOut(open) { st.outOpen = open; outEl.hidden = !open; if (!open) stopRun(); }

  async function runProject() {
    if (host.canEdit) await Promise.all(st.tabs.filter(dirty).map((id) => save(id)));
    const files = projectFiles();
    const active = host.items.get(st.active);
    // 아두이노 스케치: 회로 시뮬레이터로 실행
    const ino = isIno(active) ? active : (!files.some((f) => runnable(langFromName(f.name))) ? files.find(isIno) : null);
    if (ino) {
      if (st.active !== ino.id) openFile(ino.id);
      if (st.outOpen) toggleOut(false);
      // 같은 폴더의 .h / .cpp 파일도 함께 컴파일
      const extra = kids(ino.parentId).filter((k) => k.kind === 'file' && /^[A-Za-z0-9_][\w.-]*\.(h|hpp|cpp|c)$/.test(k.name)).map((k) => ({ name: k.name, content: contentOf(k) }));
      showArdu(true);
      ardu?.start(contentOf(ino), extra);
      return undefined;
    }
    const target = (active && runnable(langFromName(active.name)) ? active : null)
      || files.find((f) => pathOf(f) === 'index.html') || files.find((f) => /^main\.(py|js)$/.test(f.name)) || files.find((f) => runnable(langFromName(f.name)));
    if (!target) return toast('실행할 수 있는 파일이 없습니다 (.html · .js · .py · .ino).', 'warn');
    let kind = runnable(langFromName(target.name));
    let code;
    try {
      if (kind === 'html') code = buildHtml(target);
      else if (kind === 'javascript' && /^\s*(import|export)\s/m.test(contentOf(target))) {
        // import 를 쓰는 JS 는 모듈로 실행
        kind = 'html';
        code = `<body style="font:14px system-ui;color:#888;padding:12px">모듈 실행 중 — 출력은 아래 콘솔에 나옵니다.<script type="module">${bundleModule(target).replace(/<\/script/gi, '<\\/script')}</script></body>`;
      } else if (kind === 'python') {
        // 프로젝트의 다른 파일을 가상 파일 시스템에 써서 import · open() 이 되게 함 (한 줄이라 오류 줄 번호는 1 큼)
        const others = files.filter((f) => f.id !== target.id).map((f) => [pathOf(f), b64(contentOf(f))]);
        const prelude = others.length ? `import os as _o,base64 as _b;[(_o.makedirs(_o.path.dirname(_p) or '.',exist_ok=True),open(_p,'wb').write(_b.b64decode(_c))) for _p,_c in ${JSON.stringify(others)}]\n` : '';
        code = prelude + contentOf(target);
      } else code = contentOf(target);
    } catch (e) {
      toggleOut(true);
      outEl.replaceChildren(h('div', { class: 'run-line run-error pad' }, e.message));
      return undefined;
    }
    stopRun();
    toggleOut(true);
    const log = h('div', { class: 'run-out', role: 'log' });
    const preview = h('div', { class: 'run-preview-wrap' });
    const status = h('span', { class: 'run-status' }, h('span', { class: 'spinner tiny' }), ' 실행 중…');
    const stopBtn = h('button', { class: 'btn small secondary', onclick: () => st.runCtl?.stop() }, '중지');
    outEl.replaceChildren(
      h('div', { class: 'run-head' }, h('strong', {}, `▶ ${pathOf(target)}`), status,
        h('span', { class: 'run-actions' }, stopBtn,
          h('button', { class: 'btn small ghost', onclick: () => log.replaceChildren() }, '지우기'),
          h('button', { class: 'btn small ghost', onclick: () => toggleOut(false) }, '닫기'))),
      kind === 'html' ? preview : null, log);
    st.runCtl = run(kind, code, {
      previewParent: preview,
      onLine: (type, text) => { log.append(h('div', { class: `run-line run-${type}` }, type === 'result' ? '← ' : '', text)); log.scrollTop = log.scrollHeight; },
      onDone: ({ ok, ms, stopped, timedOut }) => {
        stopBtn.hidden = kind !== 'html';
        status.replaceChildren(kind === 'html' ? '미리보기' : stopped ? '⏹ 중지됨' : timedOut ? '⏱ 시간 초과' : ok ? `✅ 완료 (${ms}ms)` : `❌ 오류 (${ms}ms)`);
        status.className = `run-status ${ok ? 'ok' : 'bad'}`;
      },
    });
    return undefined;
  }

  // 다른 사람이 어떤 파일을 보고 있는지
  const offFocus = data.on('wsFocus', ({ roomId, id, userId }) => {
    if (roomId !== host.roomId) return;
    if (id) st.focus.set(userId, { id, until: Date.now() + 60_000 }); else st.focus.delete(userId);
    if (st.project) renderExplorer();
  });
  const focusTimer = setInterval(() => { if (st.project && st.active && document.visibilityState === 'visible') data.sendWsFocus(host.roomId, st.active); }, 30_000);

  return {
    el,
    open() {
      let saved = {};
      try { saved = JSON.parse(localStorage.getItem(stateKey())) || {}; } catch { /* noop */ }
      if (saved.project && host.items.has(saved.project)) openProject(saved.project, saved); else renderProjects();
    },
    /** 작업 공간 항목이 바뀜 (내가 바꿨거나 다른 사람이 바꿈) */
    changed({ items = [], removed = [], by } = {}) {
      if (!st.project) return renderProjects();
      if (!host.items.has(st.project)) { toast('보고 있던 프로젝트가 삭제되었습니다.', 'warn'); return closeProject(); }
      for (const id of removed) { st.buffers.delete(id); st.tabs = st.tabs.filter((t) => t !== id); if (st.active === id) st.active = null; }
      for (const it of items) {
        if (it.kind !== 'file' || by === data.me.id) continue;
        // 다른 사람이 고친 파일: 내가 고치던 중이 아니면 바로 반영, 고치던 중이면 알림
        if (!dirty(it.id)) { st.buffers.delete(it.id); if (it.id === st.active && editor.value !== (it.content || '')) editor.update(it.content || ''); } else if (st.buffers.get(it.id) !== it.content) st.remote.set(it.id, { by });
      }
      titleEl.textContent = host.items.get(st.project).name;
      if (!st.active && st.tabs.length) openFile(st.tabs.at(-1)); else { renderTabs(); renderExplorer(); showEditor(); }
    },
    close() {
      window.removeEventListener('popstate', onPop);
      stopRun();
      ardu?.stop({ quiet: true });
      clearInterval(focusTimer);
      offFocus();
      for (const id of st.tabs) if (dirty(id) && host.canEdit) save(id);
      data.sendWsFocus(host.roomId, null);
    },
  };
}
