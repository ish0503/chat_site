// 서버 통합 테스트: 로그인 → 방 만들기 → 메시지(전송·수정 충돌·반응·고정·검색·일괄 삭제) → 1:1 대화 권한
// → 첨부파일(무결성·보안 헤더·보관함) → 요청 제한 → 통화 인원 제한 → 상태 · 오류 보고 · 세션 갱신
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import {
  startServer, login, connect, sleep,
} from './helpers.js';

let srv;
let alice; let bob; let carol; let guest;
let A; let B; let C; let G;
let roomId;

before(async () => {
  srv = await startServer({ CALL_MAX_PARTICIPANTS: '2', STORAGE_QUOTA_MB: '1' });
  [alice, bob, carol, guest] = await Promise.all([
    login(srv.base, 'google', 'alice', '앨리스'),
    login(srv.base, 'apple', 'bob', '밥'),
    login(srv.base, 'google', 'carol', '캐럴'),
    login(srv.base, 'guest', 'guest00001', '손님'),
  ]);
  [A, B, C, G] = await Promise.all([alice, bob, carol, guest].map((u) => connect(srv.base, u.token)));
});

after(async () => {
  for (const c of [A, B, C, G]) c?.close();
  await srv?.stop();
});

const uuid = () => randomUUID();

test('sync 와 방 만들기 (게스트는 만들 수 없음)', async () => {
  const s = await A.req('sync');
  assert.equal(s.ok, true);
  assert.equal(s.me.id, 'google:alice');
  const folder = await A.req('node:create', { type: 'folder', name: '공부' });
  assert.equal(folder.ok, true);
  const room = await A.req('node:create', { type: 'text', name: '일반', parentId: folder.node.id });
  assert.equal(room.ok, true);
  roomId = room.node.id;
  const denied = await G.req('node:create', { type: 'text', name: '게스트방' });
  assert.deepEqual(denied, { ok: false, error: 'forbidden' });
});

test('메시지 전송 · 실시간 전달 · 중복 전송 방지', async () => {
  const id = uuid();
  const r = await A.req('msg:send', { id, roomId, content: '안녕하세요 @밥' });
  assert.equal(r.ok, true);
  const got = await B.waitFor('msg:upsert', (m) => m.id === id);
  assert.equal(got.content, '안녕하세요 @밥');
  // 같은 id 로 다시 보내면 새 메시지를 만들지 않음
  const again = await A.req('msg:send', { id, roomId, content: '안녕하세요 @밥' });
  assert.equal(again.ok, true);
  assert.equal(again.duplicate, true);
  // 다른 사람이 같은 id 를 쓰면 거부
  const stolen = await B.req('msg:send', { id, roomId, content: '가로채기' });
  assert.equal(stolen.error, 'conflict');
  const list = await A.req('msg:list', { roomId });
  assert.equal(list.messages.filter((m) => m.id === id).length, 1);
});

test('수정 충돌: 예전 버전을 기준으로 수정하면 conflict, 내용은 수정 기록에 남음', async () => {
  const id = uuid();
  const sent = await A.req('msg:send', { id, roomId, content: '원래 내용' });
  const base = sent.message.createdAt;
  const first = await A.req('msg:edit', { id, content: '기기 1의 수정', base });
  assert.deepEqual(first, { ok: true });
  const second = await A.req('msg:edit', { id, content: '기기 2의 수정', base });
  assert.equal(second.ok, true);
  assert.equal(second.conflict, true);
  const { messages } = await A.req('msg:list', { roomId });
  const m = messages.find((x) => x.id === id);
  assert.equal(m.content, '기기 2의 수정');
  assert.deepEqual(m.editHistory.map((h) => h.content), ['원래 내용', '기기 1의 수정']);
  const other = await B.req('msg:edit', { id, content: '남의 메시지 수정' });
  assert.equal(other.error, 'forbidden');
});

test('반응 · 고정 · 검색 · 일괄 삭제', async () => {
  const ids = [uuid(), uuid(), uuid()];
  for (const [i, id] of ids.entries()) await A.req('msg:send', { id, roomId, content: `일괄 ${i} 바나나` });
  const mine = uuid();
  await B.req('msg:send', { id: mine, roomId, content: '밥의 바나나' });
  assert.equal((await B.req('msg:react', { id: ids[0], emoji: '👍', on: true })).ok, true);
  assert.equal((await G.req('msg:react', { id: ids[0], emoji: '👍', on: true })).error, 'forbidden');
  assert.equal((await A.req('msg:pin', { id: ids[1], pinned: true })).ok, true);
  const pins = await A.req('msg:pins', { roomId });
  assert.deepEqual(pins.messages.map((m) => m.id), [ids[1]]);
  const found = await C.req('msg:search', { q: '바나나' });
  assert.equal(found.messages.length, 4);
  const fromBob = await C.req('msg:search', { q: '바나나', from: 'apple:bob' });
  assert.deepEqual(fromBob.messages.map((m) => m.id), [mine]);
  // 게스트는 다른 사람 메시지를 지울 수 없으므로 자기 것만 지워짐 (여기선 없음)
  const g = await G.req('msg:deleteMany', { ids });
  assert.deepEqual(g.deleted, []);
  const del = await A.req('msg:deleteMany', { ids: [...ids, mine, 'nope-nope-nope'] });
  assert.deepEqual(del.deleted.sort(), [...ids, mine].sort());
  await B.waitFor('msg:remove', (e) => e.id === ids[2]);
  const after2 = await C.req('msg:search', { q: '바나나' });
  assert.equal(after2.messages.length, 0);
});

test('1:1 대화: 참여자만 보고, 검색되고, 실시간으로 받음', async () => {
  const dm = await A.req('dm:open', { userId: 'apple:bob' });
  assert.equal(dm.ok, true);
  assert.equal(dm.node.type, 'dm');
  assert.deepEqual(dm.node.members, ['apple:bob', 'google:alice']);
  // 반대쪽에서 열어도 같은 방
  const same = await B.req('dm:open', { userId: 'google:alice' });
  assert.equal(same.node.id, dm.node.id);
  await B.waitFor('node:upsert', (n) => n.id === dm.node.id);
  const id = uuid();
  const r = await A.req('msg:send', { id, roomId: dm.node.id, content: '비밀 이야기 키위' });
  assert.equal(r.ok, true);
  await B.waitFor('msg:upsert', (m) => m.id === id);
  await sleep(200);
  assert.ok(!C.events.some((e) => e.name === 'msg:upsert' && e.payload.id === id), '캐럴에게 전달되면 안 됨');
  assert.ok(!C.events.some((e) => e.name === 'node:upsert' && e.payload.id === dm.node.id), '캐럴에게 방이 보이면 안 됨');
  const syncC = await C.req('sync');
  assert.ok(!syncC.nodes.some((n) => n.id === dm.node.id));
  const syncB = await B.req('sync');
  assert.ok(syncB.nodes.some((n) => n.id === dm.node.id));
  assert.equal((await C.req('msg:list', { roomId: dm.node.id })).error, 'room_not_found');
  assert.equal((await C.req('msg:send', { roomId: dm.node.id, content: '끼어들기' })).error, 'room_not_found');
  assert.equal((await C.req('msg:search', { q: '키위' })).messages.length, 0);
  assert.equal((await C.req('msg:search', { q: '키위', roomId: dm.node.id })).error, 'room_not_found');
  assert.equal((await C.req('msg:edit', { id, content: 'x' })).error, 'not_found');
  assert.equal((await B.req('msg:search', { q: '키위' })).messages.length, 1);
  // 1:1 대화에서는 관리 권한이 있어도 상대 메시지를 지울 수 없음
  assert.equal((await B.req('msg:delete', { id })).error, 'forbidden');
  // 1:1 대화방은 방 관리 기능으로 바꾸거나 지울 수 없음
  assert.equal((await A.req('node:update', { id: dm.node.id, name: 'x' })).error, 'invalid_type');
  // 게스트도 1:1 대화는 가능, 자기 자신과는 불가
  assert.equal((await G.req('dm:open', { userId: 'google:alice' })).ok, true);
  assert.equal((await G.req('dm:open', { userId: 'guest:guest00001' })).error, 'invalid_user');
});

async function upload(token, body, { name = 'a.txt', type = 'text/plain', sha, keep } = {}) {
  const fd = new FormData();
  fd.append('file', new Blob([body], { type }), name);
  const q = new URLSearchParams({ id: uuid(), name, ...(sha ? { sha256: sha } : {}), ...(keep ? { keep: '1' } : {}) });
  const r = await fetch(`${srv.base}/api/upload?${q}`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: fd });
  return { status: r.status, body: await r.json() };
}
const hex = (s) => createHash('sha256').update(s).digest('hex');

test('첨부파일: 무결성 검사 · 안전한 내려받기 헤더', async () => {
  const bad = await upload(alice.token, 'hello', { sha: hex('different') });
  assert.equal(bad.status, 422);
  assert.equal(bad.body.error, 'integrity_failed');
  const ok = await upload(alice.token, 'hello', { sha: hex('hello') });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.sha256, hex('hello'));
  const r = await fetch(`${srv.base}/api/files/${ok.body.id}`, { headers: { Authorization: `Bearer ${bob.token}` } });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('x-content-sha256'), hex('hello'));
  assert.match(r.headers.get('content-security-policy'), /sandbox/);
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(await r.text(), 'hello');
  const html = await upload(alice.token, '<script>alert(1)</script>', { name: 'x.html', type: 'text/html' });
  const h = await fetch(`${srv.base}/api/files/${html.body.id}`, { headers: { Authorization: `Bearer ${bob.token}` } });
  assert.match(h.headers.get('content-disposition'), /^attachment/);
});

test('1:1 대화의 첨부파일은 참여자만 내려받음', async () => {
  const dmId = (await A.req('dm:open', { userId: 'apple:bob' })).node.id;
  const f = await upload(alice.token, 'dm-file');
  await A.req('msg:send', { id: uuid(), roomId: dmId, content: '', attachments: [f.body.id] });
  await sleep(100);
  const asBob = await fetch(`${srv.base}/api/files/${f.body.id}`, { headers: { Authorization: `Bearer ${bob.token}` } });
  assert.equal(asBob.status, 200);
  const asCarol = await fetch(`${srv.base}/api/files/${f.body.id}`, { headers: { Authorization: `Bearer ${carol.token}` } });
  assert.equal(asCarol.status, 404);
});

test('내 보관함: 첨부를 영구 보관, 메시지를 지워도 남음, 용량 제한', async () => {
  const f = await upload(alice.token, 'keep me');
  const id = uuid();
  await A.req('msg:send', { id, roomId, content: '보관할 파일', attachments: [f.body.id] });
  const kept = await B.req('file:keep', { id: f.body.id });
  assert.equal(kept.ok, true);
  assert.equal(kept.file.persistent, true);
  assert.equal(kept.file.expiresAt, 0);
  assert.equal((await G.req('file:keep', { id: f.body.id })).error, 'forbidden');
  await A.req('msg:delete', { id });
  const gone = await fetch(`${srv.base}/api/files/${f.body.id}`, { headers: { Authorization: `Bearer ${bob.token}` } });
  assert.equal(gone.status, 410);
  const still = await fetch(`${srv.base}/api/files/${kept.file.id}`, { headers: { Authorization: `Bearer ${bob.token}` } });
  assert.equal(await still.text(), 'keep me');
  const mine = await B.req('files:mine');
  assert.deepEqual(mine.files.map((x) => x.id), [kept.file.id]);
  assert.equal(mine.quota, 1024 * 1024);
  const big = await upload(bob.token, 'x'.repeat(1024 * 1024), { keep: true });
  assert.equal(big.status, 413);
  assert.equal(big.body.error, 'quota_exceeded');
  assert.equal((await A.req('file:remove', { id: kept.file.id })).error, 'forbidden');
  assert.equal((await B.req('file:remove', { id: kept.file.id })).ok, true);
  assert.equal((await B.req('files:mine')).files.length, 0);
});

test('통화 인원 제한', async () => {
  const voice = await A.req('node:create', { type: 'voice', name: '통화' });
  const j1 = await A.req('call:join', { roomId: voice.node.id });
  assert.equal(j1.ok, true);
  assert.equal(j1.max, 2);
  assert.equal(j1.mode, 'mesh');
  assert.equal((await B.req('call:join', { roomId: voice.node.id })).ok, true);
  assert.equal((await C.req('call:join', { roomId: voice.node.id })).error, 'call_full');
  assert.equal((await G.req('call:join', { roomId: voice.node.id })).error, 'forbidden');
  await A.req('call:leave');
  assert.equal((await C.req('call:join', { roomId: voice.node.id })).ok, true);
  await B.req('call:leave');
  await C.req('call:leave');
});

test('상태 모니터링 · 오류 보고 · 세션 갱신 · AI 꺼짐', async () => {
  const anon = await fetch(`${srv.base}/api/status`);
  assert.equal(anon.status, 401);
  const st = await (await fetch(`${srv.base}/api/status`, { headers: { Authorization: `Bearer ${alice.token}` } })).json();
  assert.equal(st.db.ready, true);
  assert.equal(st.db.memory, true);
  assert.ok(st.sockets >= 4);
  assert.ok(Array.isArray(st.errors.recent));
  const rep = await fetch(`${srv.base}/api/errors`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reports: [{ message: 'TypeError: x is undefined', code: 'js', version: 'test' }] }),
  });
  assert.equal((await rep.json()).received, 1);
  const st2 = await (await fetch(`${srv.base}/api/status`, { headers: { Authorization: `Bearer ${guest.token}` } })).json();
  assert.equal(st2.errors.clientLastHour, 1);
  assert.equal(st2.errors.reportsLastDay, 1);
  assert.equal(st2.errors.recent, undefined, '관리 권한이 없으면 오류 내용은 안 보임');
  const ref = await A.req('session:refresh');
  assert.equal(typeof ref.token, 'string');
  const again = await connect(srv.base, ref.token);
  assert.equal((await again.req('sync')).me.id, 'google:alice');
  again.close();
  assert.equal((await A.req('ai:ask', { roomId, mode: 'summary' })).error, 'ai_disabled');
  assert.equal((await G.req('ai:ask', { roomId, mode: 'summary' })).error, 'forbidden');
});

test('요청 제한: 메시지를 너무 빨리 보내면 rate_limited 와 재시도 시간', async () => {
  let limited = null;
  for (let i = 0; i < 30 && !limited; i++) {
    const r = await C.req('msg:send', { id: uuid(), roomId, content: `도배 ${i}` });
    if (!r.ok) limited = r;
  }
  assert.ok(limited, '제한에 걸려야 함');
  assert.equal(limited.error, 'rate_limited');
  assert.ok(limited.retryAfter > 0);
});

test('작업 공간: 코드 파일 저장 · 동시 편집 충돌 · 버전 기록 · 하위 삭제 · 권한', async () => {
  const room = (await A.req('node:create', { type: 'code', name: '코드방' })).node;
  assert.equal(room.type, 'code');
  const [proj, dir, file] = [uuid(), uuid(), uuid()];
  const many = await A.req('ws:putMany', { roomId: room.id, items: [
    { id: proj, kind: 'project', name: '내 프로젝트' },
    { id: dir, kind: 'folder', name: 'src', parentId: proj },
    { id: file, kind: 'file', name: 'main.js', parentId: dir, content: 'console.log(1)' },
  ] });
  assert.equal(many.items.length, 3);
  await B.waitFor('ws:upsert', (e) => e.roomId === room.id && e.items.some((i) => i.id === file));
  // 게스트는 볼 수는 있지만 고칠 수 없음
  assert.equal((await G.req('ws:list', { roomId: room.id })).items.length, 3);
  assert.equal((await G.req('ws:put', { roomId: room.id, item: { id: file, kind: 'file', content: 'x' } })).error, 'forbidden');
  const e1 = await A.req('ws:put', { roomId: room.id, item: { id: file, kind: 'file', content: 'console.log(2)', baseRev: 1 } });
  assert.equal(e1.item.rev, 2);
  assert.equal(e1.conflict, undefined);
  const e2 = await B.req('ws:put', { roomId: room.id, item: { id: file, kind: 'file', content: 'console.log(3)', baseRev: 1 } });
  assert.equal(e2.conflict, true);
  const hist = await A.req('ws:history', { roomId: room.id, id: file });
  assert.deepEqual(hist.history.map((h) => h.content), ['console.log(1)', 'console.log(2)']);
  // 폴더를 자기 안의 폴더로 옮길 수 없음
  const sub = uuid();
  await A.req('ws:put', { roomId: room.id, item: { id: sub, kind: 'folder', name: 'sub', parentId: dir } });
  assert.equal((await A.req('ws:put', { roomId: room.id, item: { id: dir, kind: 'folder', parentId: sub } })).error, 'invalid_move');
  // 이름의 경로 문자는 바뀜, 채팅도 가능
  const renamed = await A.req('ws:put', { roomId: room.id, item: { id: file, kind: 'file', name: '../evil.js' } });
  assert.equal(renamed.item.name, '.._evil.js');
  assert.equal((await A.req('msg:send', { id: uuid(), roomId: room.id, content: '코드방 채팅' })).ok, true);
  const del = await A.req('ws:delete', { roomId: room.id, ids: [dir] });
  assert.deepEqual(del.ids.sort(), [dir, file, sub].sort());
  assert.equal((await A.req('ws:list', { roomId: room.id })).items.length, 1);
  // 일반 채팅방에는 작업 공간이 없음
  assert.equal((await A.req('ws:list', { roomId })).error, 'room_not_found');
});

test('작업 공간: 보드 카드와 방 삭제 시 정리', async () => {
  const room = (await A.req('node:create', { type: 'board', name: '보드', view: 'kanban' })).node;
  assert.equal(room.view, 'kanban');
  const c1 = uuid(); const c2 = uuid();
  await A.req('ws:put', { roomId: room.id, item: { id: c1, kind: 'card', text: '주제', color: '#ffcc00', status: 'todo', x: 10, y: 20 } });
  const r = await A.req('ws:put', { roomId: room.id, item: { id: c2, kind: 'card', text: '의견', parentId: c1, stance: 'pro', status: 'bogus' } });
  assert.equal(r.item.stance, 'pro');
  assert.equal(r.item.status, null);
  const moved = await B.req('ws:put', { roomId: room.id, item: { id: c1, kind: 'card', status: 'done' } });
  assert.equal(moved.item.status, 'done');
  assert.equal(moved.item.text, '주제', '보내지 않은 값은 그대로');
  assert.equal((await A.req('node:update', { id: room.id, view: 'mindmap' })).node.view, 'mindmap');
  await A.req('node:delete', { id: room.id });
  assert.equal((await A.req('ws:list', { roomId: room.id })).error, 'room_not_found');
  assert.equal((await A.req('ai:board', { roomId })).error, 'ai_disabled');
});
