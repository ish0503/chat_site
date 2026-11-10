// 브라우저 종단 간 테스트 (Playwright): 메모리 DB 서버 + 정적 클라이언트를 띄우고 두 사용자로 주요 흐름을 확인합니다.
// 실행: cd server && npm run test:e2e   (playwright 패키지와 Chromium 이 필요: npm i --no-save playwright && npx playwright install chromium)
// 스크린샷을 남기려면: node test/e2e.mjs <폴더>
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { mkdirSync, writeFileSync } from 'node:fs';

const { chromium } = createRequire(import.meta.url)('playwright');
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const SHOTS = process.argv[2] || null;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
const shot = (page, name) => (SHOTS ? page.screenshot({ path: `${SHOTS}/${name}.png` }) : null);
const port = 31000 + Math.floor(Math.random() * 1000);
const srv = spawn(process.execPath, [`${ROOT}/server/src/index.js`], { env: { ...process.env, PORT: String(port), MONGODB_URI: 'memory', ALLOW_TEST_LOGIN: '1', JWT_SECRET: 'x', ALLOWED_ORIGINS: '*', ANTHROPIC_API_KEY: '' }, stdio: 'ignore' });
// 정적 파일 서버 (client/)
const http = await import('node:http');
const { readFile } = await import('node:fs/promises');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
const webPort = port + 1;
const web = http.createServer(async (req, res) => {
  const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const file = `${ROOT}/client${path.endsWith('/') ? `${path}index.html` : path}`;
  try {
    res.writeHead(200, { 'Content-Type': TYPES[file.slice(file.lastIndexOf('.'))] || 'application/octet-stream' });
    res.end(await readFile(file));
  } catch { res.writeHead(404); res.end(); }
}).listen(webPort, '127.0.0.1');
const appUrl = `http://127.0.0.1:${webPort}/`;
const base = `http://127.0.0.1:${port}`;
await new Promise((r) => setTimeout(r, 1500));
const login = async (provider, id, nickname) => (await fetch(`${base}/api/auth/test`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ provider, id, nickname }) })).json();
const A = await login('google', 'alice', '앨리스');
const B = await login('apple', 'bob', '밥');
const sio = readFileSync(`${ROOT}/server/node_modules/socket.io-client/dist/socket.io.min.js`, 'utf8');
const browser = await chromium.launch();
const errors = [];
async function open(user, name) {
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 860 } });
  await ctx.route(/cdn\.jsdelivr\.net\/npm\/socket\.io-client/, (r) => r.fulfill({ body: sio, contentType: 'application/javascript' }));
  await ctx.route(/accounts\.google\.com|appleid\.cdn-apple|fonts\.|ytimg|cdnjs/, (r) => r.abort());
  await ctx.addInitScript(([u, t, b]) => {
    try { // 샌드박스 iframe(코드 실행 미리보기)에서는 localStorage 를 쓸 수 없음
      localStorage.setItem('cs.session', JSON.stringify({ user: u, serverToken: t, serverUrl: b }));
      localStorage.setItem('cs.serverUrl', b);
    } catch { /* noop */ }
  }, [user.user, user.token, base]);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`${name}: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(`${name} console: ${m.text()}`); }); // 테스트에서 막아 둔 CDN 요청은 제외
  await page.goto(appUrl);
  return page;
}
let failed = 0;
const step = async (label, fn) => { try { await fn(); console.log('✔', label); } catch (e) { failed += 1; console.log('✖', label, e.message.split('\n')[0]); } };
let a; let b;
try {
  a = await open(A, 'alice');
  b = await open(B, 'bob');
  await a.waitForSelector('.conn-online', { timeout: 10000 });
  await step('create room via UI', async () => {
    await a.click('button[aria-label="채팅방·통화방·폴더 만들기"]');
    await a.fill('.modal input.input', '일반');
    await a.click('.modal button.btn.primary');
    await a.waitForSelector('.chat-view .room-title h2:has-text("일반")', { timeout: 5000 });
  });
  await b.waitForSelector('.tree-row.text', { timeout: 5000 });
  await b.click('.tree-row.text');
  await step('send + receive', async () => {
    for (let i = 1; i <= 6; i++) { await a.fill('.composer-input', `메시지 ${i} 사과`); await a.keyboard.press('Enter'); }
    await b.waitForSelector('.msg:has-text("메시지 6 사과")', { timeout: 5000 });
  });
  await step('reply + replies button + back', async () => {
    const m1 = b.locator('.msg', { hasText: '메시지 1 사과' });
    await m1.hover();
    await m1.locator('button[title="답장"]').click();
    await b.fill('.composer-input', '1번에 대한 답장');
    await b.keyboard.press('Enter');
    await a.waitForSelector('.replies-btn', { timeout: 5000 });
    await a.click('.replies-btn');
    await a.waitForSelector('.msg.flash', { timeout: 3000 });
    if (await a.locator('.jump-back').isHidden()) throw new Error('back hidden');
    await a.click('.jump-back');
  });
  await step('edit history diff', async () => {
    const m = a.locator('.msg', { hasText: '메시지 2 사과' });
    await m.hover();
    await m.locator('button[title="수정"]').click();
    await a.fill('.composer-input', '메시지 2 바나나 맛');
    await a.keyboard.press('Enter');
    await a.click('.msg:has-text("메시지 2 바나나") .edited');
    await a.waitForSelector('.modal .diff ins', { timeout: 3000 });
    await shot(a, 'edit-diff');
    await a.keyboard.press('Escape');
  });
  await step('multi-select delete with undo', async () => {
    const m = a.locator('.msg', { hasText: '메시지 3 사과' });
    await m.click({ button: 'right' });
    await a.click('.menu-item:has-text("여러 개 선택")');
    await a.click('.msg:has-text("메시지 4 사과")');
    await a.waitForSelector('.select-bar strong:has-text("2개 선택")');
    await shot(a, 'select');
    await a.click('.select-bar button:has-text("삭제")');
    await a.click('.modal button.btn.danger');
    await a.waitForSelector('.toast-action');
    await a.click('.toast-action');
    await a.waitForSelector('.msg:has-text("메시지 3 사과"):not(.filtered-out)');
  });
  await step('single delete commits after 5s', async () => {
    const m = a.locator('.msg', { hasText: '메시지 5 사과' });
    await m.click({ button: 'right' });
    await a.click('.menu-item.danger');
    await b.waitForSelector('.msg:has-text("메시지 5 사과")', { state: 'detached', timeout: 9000 });
  });
  await step('author filter', async () => {
    const m = a.locator('.msg', { hasText: '1번에 대한 답장' });
    await m.click({ button: 'right' });
    await a.click('.menu-item:has-text("이 사람의 메시지만 보기")');
    await a.waitForSelector('.filter-bar:not([hidden])');
    const visible = await a.locator('.msg:not(.filtered-out)').count();
    if (visible !== 1) throw new Error(`visible ${visible}`);
    await a.click('.filter-bar button[aria-label="필터 해제"]');
  });
  await step('DM via profile', async () => {
    await a.click('.msg:has-text("1번에 대한 답장") .msg-name');
    await a.click('.modal button:has-text("메시지 보내기")');
    await a.waitForSelector('.room-title h2:has-text("밥")');
    await a.fill('.composer-input', '밥, 비밀 이야기');
    await a.keyboard.press('Enter');
    await b.waitForSelector('.tree-row.dm .unread-badge', { timeout: 5000 });
    await shot(b, 'bob-dm-sidebar');
  });
  await step('unified search', async () => {
    await a.keyboard.press('Control+Shift+F');
    await a.fill('.qs-modal input', '사과');
    await a.waitForSelector('.qs-group:has-text("메시지")', { timeout: 5000 });
    await shot(a, 'unified');
    await a.keyboard.press('Escape');
  });
  await step('split view', async () => {
    await a.click('.tree-row.text');
    await a.click('.split-btn');
    await a.fill('.qs-modal input', '밥');
    await a.keyboard.press('Enter');
    await a.waitForSelector('.main-content.split .split-pane .room-title h2:has-text("밥")', { timeout: 5000 });
    await shot(a, 'split');
  });
  await step('server status', async () => {
    await a.click('button.conn');
    await a.waitForSelector('.status-row.ok', { timeout: 5000 });
    await a.waitForTimeout(500);
    await shot(a, 'status');
    await a.keyboard.press('Escape');
  });
  await step('members dock + quick settings', async () => {
    await a.click('button[aria-label="빠른 설정"]');
    await a.click('.menu-item:has-text("멤버 목록 항상 표시")');
    await a.waitForSelector('.members-dock:not([hidden])', { timeout: 3000 });
    await shot(a, 'dock');
  });
  await step('unread bar on reopen', async () => {
    await b.click('.tree-row.dm');
    await b.click('.tree-row.text');
    await b.waitForTimeout(300);
    await b.click('.tree-row.dm');
    for (let i = 0; i < 3; i++) { await a.locator('.chat-view:not(.split-pane) .composer-input').fill(`새 소식 ${i}`); await a.locator('.chat-view:not(.split-pane) .composer-input').press('Enter'); }
    await b.waitForTimeout(500);
    await b.click('.tree-row.text');
    await b.waitForTimeout(800);
    await shot(b, 'unread');
  });
  await step('archive room', async () => {
    await b.click('.tree-row.dm', { button: 'right' });
    await b.click('.menu-item:has-text("보관하기")');
    await b.waitForSelector('.tree-section:has-text("보관한 방")');
  });
  await step('storage: upload, list, attach', async () => {
    await a.click('button[aria-label="빠른 설정"]');
    await a.click('.menu-item:has-text("내 보관함")');
    const tmp = `${ROOT}/server/test/.e2e-upload.txt`;
    writeFileSync(tmp, '보관할 내용');
    await a.setInputFiles('.modal input[type=file]', tmp);
    await a.waitForSelector('.storage-row:has-text(".e2e-upload.txt")', { timeout: 5000 });
    await a.keyboard.press('Escape');
    await a.locator('.chat-view:not(.split-pane) button[aria-label="첨부 메뉴"]').click();
    await a.click('.menu-item:has-text("내 보관함에서 첨부")');
    await a.check('.modal .storage-row input[type=checkbox]');
    await a.click('.modal button:has-text("첨부")');
    await a.locator('.chat-view:not(.split-pane) .composer-input').press('Enter');
    await b.waitForSelector('.msg:has-text(".e2e-upload.txt")', { timeout: 5000 });
    (await import('node:fs')).rmSync(tmp, { force: true });
  });
  await step('data tools + settings dialogs open', async () => {
    await a.click('button[aria-label="설정"]');
    await a.click('.modal button:has-text("데이터 복구")');
    await a.waitForSelector('.modal :text("기기에 저장된 메시지")', { timeout: 5000 });
    await shot(a, 'data-tools');
    await a.keyboard.press('Escape');
    await a.keyboard.press('Escape');
  });
  // ── 코드 작업실 · 보드 ──
  const main = (page) => page.locator('.main-content');
  const createRoom = async (page, typeLabel, name) => {
    await page.click('button[aria-label="채팅방·통화방·폴더 만들기"]');
    await page.click(`.type-opt:has-text("${typeLabel}")`);
    await page.fill('.modal input.input', name);
    await page.click('.modal button.btn.primary');
  };
  await step('code room: project from template, explorer, HTML preview', async () => {
    if (await a.locator('.split-pane').count()) await a.keyboard.press('Control+\\');
    await createRoom(a, '코드 작업실', '코딩방');
    await a.waitForSelector('.ide-home', { timeout: 5000 });
    await a.click('.ide-home button:has-text("새 프로젝트")');
    await a.fill('.modal input.input', '웹 프로젝트');
    await a.click('.modal button.btn.primary');
    await a.waitForSelector('.ide-row:has-text("index.html")', { timeout: 5000 });
    await a.waitForSelector('.ide-row:has-text("style.css")');
    await a.click('.ide-bar button:has-text("실행")');
    const frame = a.frameLocator('.ide-out iframe.run-preview');
    await frame.locator('#btn').click({ timeout: 8000 });
    await a.waitForSelector('.ide-out .run-line:has-text("클릭 1")', { timeout: 5000 });
    if ((await frame.locator('#out').textContent()) !== '1번 눌렀어요') throw new Error('script not inlined');
    const pad = await frame.locator('body').evaluate((el) => getComputedStyle(el).paddingTop);
    if (pad !== '24px') throw new Error(`css not inlined: ${pad}`);
    await shot(a, 'ide');
  });
  await step('code room: edit, autosave, live update for another user, version history', async () => {
    await b.click('.tree-row.code');
    await b.click('.project-card');
    await b.click('.ide-row:has-text("main.js")');
    await a.click('.ide-row:has-text("main.js")');
    await a.click('.ed-input');
    await a.keyboard.press('Control+End');
    await a.keyboard.type('\n// 앨리스가 추가함');
    await b.waitForFunction(() => document.querySelector('.ed-input')?.value.includes('앨리스가 추가함'), null, { timeout: 8000 });
    await a.waitForSelector('.ide-tab-x:not(.dirty)');
    await a.click('.ide-row:has-text("main.js")', { button: 'right' });
    await a.click('.menu-item:has-text("버전 기록")');
    await a.waitForSelector('.modal .history-item', { timeout: 5000 });
    await a.keyboard.press('Escape');
  });
  await step('code room: new file in folder, editor keys, JS modules run, share to chat', async () => {
    await a.click('button[aria-label="새 파일"]');
    await a.fill('.modal input.input', 'lib/util.js');
    await a.click('.modal button.btn.primary');
    await a.waitForSelector('.ide-row.folder:has-text("lib")');
    await a.click('.ed-input');
    await a.keyboard.type('export function twice(x) {\nreturn x * 2;');
    const v = await a.inputValue('.ed-input');
    if (v !== 'export function twice(x) {\n  return x * 2;\n}') throw new Error(`auto indent/close: ${JSON.stringify(v)}`);
    await a.click('button[aria-label="새 파일"]');
    await a.fill('.modal input.input', 'calc.js');
    await a.click('.modal button.btn.primary');
    await a.waitForSelector('.ide-tab.active:has-text("calc.js")');
    await a.click('.ed-input');
    await a.keyboard.type("import { twice } from './util.js';\nconsole.log('결과', twice(21));");
    await a.keyboard.press('Control+Enter');
    await a.waitForSelector('.ide-out .run-line:has-text("결과 42")', { timeout: 8000 });
    await a.click('button[aria-label="프로젝트 메뉴"]');
    await a.click('.menu-item:has-text("채팅으로 보내기")');
    await b.waitForSelector('.tree-row.code .unread-badge', { timeout: 5000 });
  });
  await step('code room: zip export', async () => {
    const [dl] = await Promise.all([a.waitForEvent('download', { timeout: 5000 }), (async () => { await a.click('button[aria-label="프로젝트 메뉴"]'); await a.click('.menu-item:has-text("ZIP")'); })()]);
    const { execFileSync } = await import('node:child_process');
    const listing = execFileSync('python3', ['-c', 'import zipfile,sys;print("\\n".join(zipfile.ZipFile(sys.argv[1]).namelist()))', await dl.path()]).toString();
    if (!listing.includes('웹 프로젝트/lib/util.js') || !listing.includes('웹 프로젝트/index.html')) throw new Error(`zip: ${listing}`);
  });
  await step('code room: chat view and back to workspace', async () => {
    await a.click('.ws-chat-btn');
    await a.waitForSelector('.chat-view .msg:has-text("calc.js")', { timeout: 5000 });
    await a.click('.ws-back-btn');
    await a.waitForSelector('.ide-project');
  });
  await step('board room: cards in all 7 views', async () => {
    await createRoom(a, '보드', '기획 보드');
    await a.waitForSelector('.view-tree', { timeout: 5000 });
    const addQuick = async (text) => { await a.fill('.quick-add-input >> nth=-1', text); await a.keyboard.press('Enter'); await a.waitForSelector(`.card:has-text("${text}")`); };
    await addQuick('게임 만들기');
    await a.hover('.card:has-text("게임 만들기")');
    await a.click('.card:has-text("게임 만들기") button[title="하위 카드 추가"]');
    await a.fill('.modal input.input', '전쟁 시뮬레이션');
    await a.click('.modal button.btn.primary');
    await a.waitForSelector('.card:has-text("전쟁 시뮬레이션")');
    await a.hover('.card:has-text("게임 만들기")');
    await a.click('.card:has-text("게임 만들기") button[title="하위 카드 추가"]');
    await a.fill('.modal input.input', '무역과 외교');
    await a.click('.modal button.btn.primary');
    await a.waitForSelector('.card:has-text("무역과 외교")');
    await shot(a, 'board-tree');
    for (const [label, sel] of [['포스트잇', '.view-sticky .card.note'], ['마인드맵', '.view-mindmap .mind-node'], ['브랜치', '.view-branch .branch-graph circle'], ['타임라인', '.view-timeline .tl-item'], ['토론', '.view-debate .debate-col'], ['칸반', '.view-kanban .kanban-col']]) {
      await a.click(`.board-tab:has-text("${label}")`);
      await a.waitForSelector(sel, { timeout: 5000 });
      await a.waitForTimeout(150);
      await shot(a, `board-${label}`);
    }
    // 칸반: 미분류 → 다음 칸으로 옮기면 다른 사용자에게도 반영
    await a.fill('.kanban-col.st-todo .quick-add-input', '지도 그리기');
    await a.keyboard.press('Enter');
    await a.waitForSelector('.kanban-col.st-todo .card:has-text("지도 그리기")');
    await a.click('.kanban-col.st-todo .card:has-text("지도 그리기") button[title="진행 중(으)로"]');
    await a.waitForSelector('.kanban-col.st-doing .card:has-text("지도 그리기")');
    await b.click('.tree-row.board');
    await b.click('.board-tab:has-text("칸반")');
    await b.waitForSelector('.kanban-col.st-doing .card:has-text("지도 그리기")', { timeout: 5000 });
    // 포스트잇: 끌어서 옮긴 위치가 저장됨
    await a.click('.board-tab:has-text("포스트잇")');
    const note = a.locator('.card.note', { hasText: '지도 그리기' });
    const box = await note.boundingBox();
    await a.mouse.move(box.x + 60, box.y + 20); await a.mouse.down(); await a.mouse.move(box.x + 260, box.y + 140, { steps: 5 }); await a.mouse.up();
    await a.waitForTimeout(400);
    const after = await note.boundingBox();
    if (Math.abs(after.x - box.x - 200) > 12) throw new Error(`note did not move: ${after.x - box.x}`);
  });
  await step('convert chat to board (rule-based, preview then approve)', async () => {
    await a.click('.tree-row.text', { button: 'right' });
    await a.click('.menu-item:has-text("대화를 보드로 변환")');
    await a.waitForSelector('.convert-modal');
    await a.selectOption('.convert-modal select >> nth=0', 'branch');
    await a.click('.convert-modal button.btn.primary');
    await a.waitForSelector('.convert-row', { timeout: 5000 });
    const rows = await a.locator('.convert-row').count();
    if (rows < 4) throw new Error(`preview rows ${rows}`);
    await shot(a, 'convert');
    await a.click('.convert-modal button.btn.primary');
    await a.waitForSelector('.view-branch .branch-row', { timeout: 8000 });
    // 답장은 하위 카드가 되고, 카드에서 원본 메시지로 이동할 수 있음
    await a.waitForSelector('.view-branch .card:has-text("1번에 대한 답장")');
    await a.waitForTimeout(500);
    await shot(a, 'board-from-chat');
    await a.click('.view-branch .card:has-text("1번에 대한 답장") .card-chip.link');
    await a.waitForSelector('.chat-view .msg.flash:has-text("1번에 대한 답장")', { timeout: 5000 });
  });
  await step('iPhone layout: composer sits at the bottom, page cannot shift up', async () => {
    const { devices } = createRequire(import.meta.url)('playwright');
    const ctx = await browser.newContext({ ...devices['iPhone 13'] });
    await ctx.route(/cdn\.jsdelivr\.net\/npm\/socket\.io-client/, (r) => r.fulfill({ body: sio, contentType: 'application/javascript' }));
    await ctx.route(/accounts\.google\.com|appleid\.cdn-apple|fonts\.|ytimg|cdnjs/, (r) => r.abort());
    await ctx.addInitScript(([u, t, bb]) => { localStorage.setItem('cs.session', JSON.stringify({ user: u, serverToken: t, serverUrl: bb })); localStorage.setItem('cs.serverUrl', bb); }, [B.user, B.token, base]);
    const p = await ctx.newPage();
    p.on('pageerror', (e) => errors.push(`iphone: ${e.message}`));
    await p.goto(appUrl);
    await p.waitForSelector('.conn-online', { state: 'attached', timeout: 10000 });
    await p.evaluate(() => { location.hash = ''; });
    await p.waitForSelector('.composer-box', { timeout: 8000 });
    const m = await p.evaluate(() => {
      const box = document.querySelector('.composer-box').getBoundingClientRect();
      window.scrollTo(0, 200);
      return { gap: innerHeight - box.bottom, layout: document.querySelector('.layout').getBoundingClientRect().height, inner: innerHeight, touch: document.documentElement.classList.contains('touch'), scrollY: window.scrollY, pos: getComputedStyle(document.body).position };
    });
    if (!m.touch || m.pos !== 'fixed') throw new Error(`not fixed: ${JSON.stringify(m)}`);
    if (m.gap > 12 || m.gap < 0) throw new Error(`composer gap ${m.gap}px`);
    if (Math.abs(m.layout - m.inner) > 1 || m.scrollY !== 0) throw new Error(JSON.stringify(m));
    if (SHOTS) await p.screenshot({ path: `${SHOTS}/iphone.png` });
    await ctx.close();
  });
  await step('mobile layout + drawer + back button', async () => {
    await a.setViewportSize({ width: 390, height: 800 });
    await a.waitForTimeout(400);
    const top = await a.evaluate(() => document.querySelector('main.main').getBoundingClientRect().top);
    if (top > 60) throw new Error(`main starts at ${top}px`);
    await shot(a, 'mobile');
    await a.locator('.chat-view:not(.split-pane) button[aria-label="메뉴 열기"]').click();
    await a.waitForSelector('.layout.drawer-open');
    await a.goBack();
    await a.waitForSelector('.layout:not(.drawer-open)', { timeout: 3000 });
    if (!a.url().startsWith(appUrl)) throw new Error('left the app');
  });
} finally {
  console.log(errors.length ? `브라우저 오류:\n${errors.join('\n')}` : '브라우저 오류 없음');
  await browser.close();
  srv.kill();
  web.close();
}
if (failed || errors.length) process.exit(1);
