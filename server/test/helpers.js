// 통합 테스트용: 메모리 DB 로 서버를 띄우고 Socket.IO 클라이언트로 접속합니다.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { io } from 'socket.io-client';

const entry = fileURLToPath(new URL('../src/index.js', import.meta.url));

export async function startServer(env = {}) {
  const port = 20000 + Math.floor(Math.random() * 20000);
  const child = spawn(process.execPath, [entry], {
    env: {
      ...process.env, PORT: String(port), MONGODB_URI: 'memory', ALLOW_TEST_LOGIN: '1', JWT_SECRET: 'test-secret', ALLOWED_ORIGINS: '*', ANTHROPIC_API_KEY: '', ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', (d) => { log += d; });
  child.stderr.on('data', (d) => { log += d; });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(`${base}/api/health`);
      if (r.ok && (await r.json()).db) break;
    } catch { /* 아직 시작 중 */ }
    await new Promise((r) => setTimeout(r, 100));
    if (i === 99) throw new Error(`서버가 시작되지 않았습니다:\n${log}`);
  }
  return { base, child, log: () => log, stop: () => new Promise((r) => { child.once('exit', r); child.kill(); }) };
}

export async function login(base, provider, id, nickname = id) {
  const r = await fetch(`${base}/api/auth/test`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ provider, id, nickname }),
  });
  if (!r.ok) throw new Error(`login ${r.status}`);
  return r.json();
}

export async function connect(base, token) {
  const s = io(base, { auth: { token }, transports: ['websocket'], reconnection: false });
  await new Promise((resolve, reject) => {
    s.once('connect', resolve);
    s.once('connect_error', reject);
  });
  const events = [];
  s.onAny((name, payload) => events.push({ name, payload }));
  return {
    s,
    events,
    req: (event, payload = {}) => s.timeout(5000).emitWithAck(event, payload),
    /** 조건에 맞는 이벤트가 올 때까지 기다림 */
    waitFor: (name, pred = () => true, ms = 2000) => new Promise((resolve, reject) => {
      const found = events.find((e) => e.name === name && pred(e.payload));
      if (found) return resolve(found.payload);
      const t = setTimeout(() => { s.offAny(h); reject(new Error(`이벤트 ${name} 대기 시간 초과`)); }, ms);
      const h = (n, p) => { if (n === name && pred(p)) { clearTimeout(t); s.offAny(h); resolve(p); } };
      s.onAny(h);
    }),
    close: () => s.disconnect(),
  };
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
