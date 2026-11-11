// 계정 정리 · 1:1 대화 '나에게서만 삭제' 통합 테스트 (메모리 DB, 시간 단위를 아주 짧게 줄여서 실행)
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, login, connect, sleep } from './helpers.js';

// 게스트 자동 삭제: 접속하지 않은 지 0.0000347일(3초), 삭제 후 1:1 대화 정리: 2.6초 뒤, 정리 작업은 0.4초마다
const DAY = 86400_000;
let srv;
before(async () => { srv = await startServer({ GUEST_TTL_DAYS: String(3000 / DAY), DELETED_DM_GRACE_DAYS: String(2600 / DAY), ACCOUNT_SWEEP_MS: '400' }); });
after(async () => { await srv?.stop(); });

const guestLogin = (id, secret, nickname = '손님') => fetch(`${srv.base}/api/auth/guest`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, secret, nickname }),
});

test('1:1 대화: 나에게서만 삭제 · 대화 내용 지우기 (상대에게는 남고, 둘 다 지우면 서버에서도 지움)', async () => {
  const [alice, bob] = await Promise.all([login(srv.base, 'google', 'hideA', '앨리스'), login(srv.base, 'apple', 'hideB', '밥')]);
  const [A, B] = await Promise.all([alice, bob].map((u) => connect(srv.base, u.token)));
  const dm = (await A.req('dm:open', { userId: bob.user.id })).node.id;
  const send = async (who, content) => (await who.req('msg:send', { roomId: dm, content })).message.id;
  const m1 = await send(A, '첫 번째');
  const m2 = await send(B, '두 번째');
  const m3 = await send(A, '세 번째');
  const ids = async (who) => (await who.req('msg:list', { roomId: dm })).messages.map((m) => m.content);

  // 앨리스가 m2 를 자기에게서만 지움: 앨리스에게는 안 보이고, 밥에게는 그대로
  assert.deepEqual((await A.req('msg:hide', { ids: [m2] })).hidden, [m2]);
  assert.deepEqual(await ids(A), ['첫 번째', '세 번째']);
  assert.deepEqual(await ids(B), ['첫 번째', '두 번째', '세 번째']);
  const listB = (await B.req('msg:list', { roomId: dm })).messages;
  assert.ok(listB.every((m) => !('hiddenFor' in m)), '상대가 지웠다는 사실은 알리지 않음');
  // 검색 · 반응에서도 숨김
  assert.equal((await A.req('msg:search', { q: '두 번째' })).messages.length, 0);
  assert.equal((await B.req('msg:search', { q: '두 번째' })).messages.length, 1);
  assert.equal((await A.req('msg:react', { id: m2, emoji: '👍', on: true })).error, 'not_found'); // 숨긴 메시지는 없는 것처럼
  // 숨긴 메시지가 수정되어도 숨긴 사람에게는 다시 전달되지 않음
  A.events.length = 0;
  await B.req('msg:edit', { id: m2, content: '두 번째 (수정)' });
  await sleep(150);
  assert.equal(A.events.filter((e) => e.name === 'msg:upsert' && e.payload.id === m2).length, 0);
  // 채널 메시지는 숨길 수 없음 (1:1 대화 전용)
  const room = (await A.req('node:create', { id: 'hideroom01', type: 'text', name: '일반' })).node.id;
  const pub = (await A.req('msg:send', { roomId: room, content: '공개' })).message.id;
  assert.deepEqual((await B.req('msg:hide', { ids: [pub] })).hidden, []);

  // 밥도 m2 를 지우면 → 두 사람 모두 지운 메시지는 서버에서 지움
  await B.req('msg:hide', { ids: [m2] });
  assert.deepEqual(await ids(B), ['첫 번째', '세 번째']);
  assert.equal((await A.req('msg:search', { q: '두 번째', from: bob.user.id })).messages.length, 0);

  // 대화 내용 지우기: 그 시각 이전 메시지가 나에게서만 사라짐, 이후 메시지는 보임
  await sleep(5);
  const { clearedAt } = await A.req('dm:clear', { roomId: dm });
  assert.ok(clearedAt > 0);
  assert.deepEqual(await ids(A), []);
  assert.deepEqual(await ids(B), ['첫 번째', '세 번째']);
  await sleep(5);
  await send(B, '네 번째');
  assert.deepEqual(await ids(A), ['네 번째']);
  // 둘 다 지우면 그 이전 부분은 서버에서 삭제
  await B.req('dm:clear', { roomId: dm });
  assert.deepEqual(await ids(B), []);
  await A.req('dm:clear', { roomId: dm }); // 앨리스가 다시 지워도 문제 없음
  void m1; void m3;
  A.close(); B.close();
});

test('게스트 계정 정리: 로그인한 사용자가 접속하지 않은 게스트를 삭제, 메시지는 남고 "삭제된 계정" 으로 표시', async () => {
  const [alice, guest] = await Promise.all([login(srv.base, 'google', 'adminA', '관리자'), login(srv.base, 'guest', 'guestDel1', '지나가는 손님')]);
  const A = await connect(srv.base, alice.token);
  const G = await connect(srv.base, guest.token);
  const room = (await A.req('node:create', { id: 'guestroom01', type: 'text', name: '라운지' })).node.id;
  const gm = (await G.req('msg:send', { roomId: room, content: '안녕하세요' })).message.id;
  const dm = (await G.req('dm:open', { userId: alice.user.id })).node.id;
  await G.req('msg:send', { roomId: dm, content: '비밀 이야기' });

  // 게스트는 다른 게스트를 지울 수 없음, 접속 중인 게스트는 지울 수 없음
  assert.equal((await G.req('user:deleteGuests', { ids: [guest.user.id] })).error, 'forbidden');
  assert.equal((await A.req('user:deleteGuests', { ids: [guest.user.id] })).error, 'user_online');
  // 로그인 사용자 계정은 지울 수 없음
  assert.deepEqual((await A.req('user:deleteGuests', { ids: [alice.user.id] })).deleted, []);

  G.close();
  await sleep(200);
  const r = await A.req('user:deleteGuests', { ids: [guest.user.id] });
  assert.deepEqual(r.deleted, [guest.user.id]);
  const u = await A.waitFor('user:upsert', (x) => x.id === guest.user.id && x.deleted);
  assert.equal(u.nickname, '삭제된 계정');
  assert.ok(u.purgeAt > u.deletedAt);

  // 채널 메시지는 그대로 남고, 작성자는 삭제된 계정으로 보임
  const list = (await A.req('msg:list', { roomId: room })).messages;
  assert.ok(list.some((m) => m.id === gm && m.content === '안녕하세요'));
  const sync = await A.req('sync');
  assert.equal(sync.users.find((x) => x.id === guest.user.id).deleted, true);
  // 삭제된 계정은 다시 접속할 수 없고, 새로 1:1 대화를 시작하거나 보낼 수 없음
  await assert.rejects(connect(srv.base, guest.token), /account_deleted/);
  assert.equal((await A.req('dm:open', { userId: guest.user.id })).error, 'user_deleted');
  assert.equal((await A.req('msg:send', { roomId: dm, content: '답장' })).error, 'user_deleted');
  // 유예 기간 동안은 1:1 대화가 남아 있다가, 지나면 서버에서 지워지고 상대 화면에서도 사라짐
  assert.equal((await A.req('msg:list', { roomId: dm })).messages.length, 1);
  const removed = await A.waitFor('node:remove', (x) => x.ids.includes(dm), 5000);
  assert.deepEqual(removed.ids, [dm]);
  assert.equal((await A.req('msg:list', { roomId: dm })).error, 'room_not_found');
  assert.ok((await A.req('msg:list', { roomId: room })).messages.some((m) => m.id === gm), '채널 메시지는 계속 남음');
  A.close();
});

test('게스트 자동 삭제: 정해진 기간 동안 접속하지 않으면 삭제, 접속 중이면 유지, 삭제된 게스트는 다시 입장 불가', async () => {
  const id = 'guest:autoGuest01';
  const secret = 'x'.repeat(24);
  const res = await guestLogin(id, secret, '잠깐 손님');
  assert.equal(res.status, 200);
  const stay = await login(srv.base, 'guest', 'stayGuest1', '계속 있는 손님');
  const S = await connect(srv.base, stay.token); // 접속 중인 게스트는 기간이 지나도 지우지 않음
  const { token } = await res.json();
  const W = await connect(srv.base, (await login(srv.base, 'google', 'watcher1', '지켜보는 사람')).token);
  const del = await W.waitFor('user:upsert', (x) => x.id === id && x.deleted, 8000);
  assert.equal(del.nickname, '삭제된 계정');
  // 같은 게스트 정보로 다시 입장하면 account_deleted → 새로 입장해야 함
  const again = await guestLogin(id, secret, '잠깐 손님');
  assert.equal(again.status, 410);
  assert.equal((await again.json()).error, 'account_deleted');
  const st = await fetch(`${srv.base}/api/status`, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(st.status, 410);
  assert.ok(!(await W.req('sync')).users.find((x) => x.id === stay.user.id).deleted);
  S.close(); W.close();
});
