// 단위 테스트: 권한 규칙(클라이언트·서버 동일), 요청 제한, 메모리 DB, 마크다운 XSS 방어
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PERMISSIONS as serverPerms, can } from '../src/permissions.js';
import { PERMISSIONS as clientPerms } from '../../client/js/permissions.js';
import { RateLimiter } from '../src/ratelimit.js';
import { createMemoryDb } from '../src/memdb.js';
import { renderMarkdown } from '../../client/js/markdown.js';

test('권한 규칙: client/js/permissions.js 와 server/src/permissions.js 가 같아야 함', () => {
  assert.deepEqual(clientPerms, serverPerms);
  for (const [provider, perms] of Object.entries(serverPerms)) {
    assert.deepEqual(Object.keys(perms).sort(), Object.keys(serverPerms.google).sort(), `${provider} 에 빠진 권한이 있음`);
  }
  assert.equal(can({ provider: 'guest' }, 'manageNodes'), false);
  assert.equal(can({ provider: 'guest' }, 'directMessage'), true);
  assert.equal(can(null, 'sendMessage'), false);
});

test('요청 제한: 한도까지 허용, 이후 거부, 시간이 지나면 다시 채워짐', () => {
  let now = 0;
  const l = new RateLimiter({ capacity: 3, refillPerSec: 1, now: () => now });
  assert.equal(l.take('u'), true);
  assert.equal(l.take('u'), true);
  assert.equal(l.take('u'), true);
  assert.equal(l.take('u'), false);
  assert.equal(l.take('other'), true, '사용자마다 따로');
  assert.equal(l.retryAfter('u'), 1000);
  now = 1000;
  assert.equal(l.take('u'), true);
  assert.equal(l.blocked, 1);
  now = 100_000;
  l.sweep();
  assert.equal(l.buckets.size, 0);
});

test('메모리 DB: 조회 · 갱신 연산자 · 정렬 · 중복 키', async () => {
  const { db, bucket } = createMemoryDb();
  const c = db.collection('m');
  await c.insertOne({ _id: 'a', roomId: 'r', n: 2, reactions: {} });
  await c.insertOne({ _id: 'b', roomId: 'r', n: 1, members: ['u1'] });
  await assert.rejects(c.insertOne({ _id: 'a' }), (e) => e.code === 11000);
  assert.deepEqual((await c.find({ roomId: 'r' }).sort({ n: 1 }).toArray()).map((d) => d._id), ['b', 'a']);
  assert.equal((await c.find({ $or: [{ members: { $exists: false } }, { members: 'u2' }] }).toArray()).length, 1);
  const after = await c.findOneAndUpdate({ _id: 'a' }, { $addToSet: { 'reactions.👍': 'u1' } }, { returnDocument: 'after' });
  assert.deepEqual(after.reactions['👍'], ['u1']);
  await c.updateOne({ _id: 'a' }, { $pull: { 'reactions.👍': 'u1' } });
  assert.equal(await c.countDocuments({ 'reactions.👍': { $size: 0 } }), 1);
  await c.updateOne({ _id: 'a' }, { $unset: { 'reactions.👍': '' } });
  assert.deepEqual((await c.findOne({ _id: 'a' })).reactions, {});
  assert.deepEqual(await c.distinct('roomId', {}), ['r']);
  assert.deepEqual(await c.findOne({ _id: 'b' }, { projection: { members: 0 } }), { _id: 'b', roomId: 'r', n: 1 });
  await new Promise((res) => { const s = bucket.openUploadStreamWithId('f', 'f.txt', { metadata: { x: 1 } }); s.on('finish', res); s.end(Buffer.from('hi')); });
  const chunks = [];
  for await (const ch of bucket.openDownloadStream('f')) chunks.push(ch);
  assert.equal(Buffer.concat(chunks).toString(), 'hi');
  assert.equal((await db.collection('uploads.files').findOne({ _id: 'f' })).length, 2);
});

test('마크다운 XSS 방어: 위험한 입력이 태그·속성·스크립트로 바뀌지 않음', () => {
  const payloads = [
    '<img src=x onerror=alert(1)>',
    '<script>alert(1)</script>',
    '[x](javascript:alert(1))',
    'javascript:alert(1)',
    '"><svg onload=alert(1)>',
    "```js\" onmouseover=\"alert(1)\n```",
    '```" onload="x\ncode```',
    '$x" onerror="alert(1)$',
    '$$" onclick="alert(1)$$',
    'https://example.com/"onmouseover="alert(1)',
    'https://example.com/<script>',
    '| a | b |\n|---|---|\n| <b onclick=x> | ` "x ` |',
    '#ff0000" onclick="x',
    '@<img src=x>',
    '> <iframe src=javascript:alert(1)>',
    '||<a href=javascript:x>spoil</a>||',
    '- [x] <img src=1 onerror=2>',
    '\\<script\\>',
  ];
  for (const p of payloads) {
    const html = renderMarkdown(p, { me: { nickname: 'me' } });
    assert.doesNotMatch(html, /<(script|img|svg|iframe|b |a href=javascript)/i, `태그가 그대로 나옴: ${p} → ${html}`);
    assert.doesNotMatch(html, /href="javascript:/i, `javascript: 링크: ${p} → ${html}`);
    // 속성 값 안에 따옴표가 깨지고 나와 새 속성이 생기면 안 됨
    // 실제 태그 안에 이벤트 속성(on…=)이 생기거나 따옴표가 깨져 새 속성이 생기면 안 됨
    for (const m of html.matchAll(/<[a-z][a-z0-9]*((?:\s+[a-z-]+(?:="[^"]*")?)*)\s*\/?>/gi)) {
      assert.doesNotMatch(m[1].replace(/="[^"]*"/g, ''), /(^|\s)on\w+/i, `이벤트 속성: ${p} → ${html}`);
    }
    assert.doesNotMatch(html.replace(/<[a-z][a-z0-9]*(?:\s+[a-z-]+(?:="[^"]*")?)*\s*\/?>|<\/[a-z0-9]+>/gi, ''), /<|>/, `닫히지 않은 태그·속성 조각: ${p} → ${html}`);
  }
  const link = renderMarkdown('see https://example.com/a?b=1&c=2.');
  assert.match(link, /<a href="https:\/\/example\.com\/a\?b=1&amp;c=2" target="_blank" rel="noopener noreferrer nofollow">/);
});
