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
    localStorage.setItem('cs.session', JSON.stringify({ user: u, serverToken: t, serverUrl: b }));
    localStorage.setItem('cs.serverUrl', b);
  }, [user.user, user.token, base]);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`${name}: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`${name} console: ${m.text()}`); });
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
