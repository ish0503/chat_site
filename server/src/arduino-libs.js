// 아두이노 라이브러리 관리: 목록(server/arduino-libs.json)에 있는 라이브러리를 공식 배포처에서 받아 설치 · 삭제합니다.
// 아무 주소에서나 받지 않습니다 — 목록에 적힌 경로와 SHA-256 이 맞는 파일만 설치합니다.
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = 'https://downloads.arduino.cc/libraries/';
const PRUNE = ['examples', 'extras', 'docs', 'doc', 'assets', 'test', 'tests', '.github', 'fuzzing', 'extras'];
const BUILTIN = [
  { id: 'Wire', name: 'Wire', headers: ['Wire.h'], desc: 'I2C 통신 (SDA = A4, SCL = A5)' },
  { id: 'SoftwareSerial', name: 'SoftwareSerial', headers: ['SoftwareSerial.h'], desc: '아무 디지털 핀으로 하는 직렬 통신 (GPS 등)' },
  { id: 'SPI', name: 'SPI', headers: ['SPI.h'], desc: 'SPI 통신' },
  { id: 'EEPROM', name: 'EEPROM', headers: ['EEPROM.h'], desc: '전원이 꺼져도 남는 작은 저장 공간' },
];

export const loadCatalog = (path = fileURLToPath(new URL('../arduino-libs.json', import.meta.url))) => JSON.parse(readFileSync(path, 'utf8'));

const sh = (cmd, args) => new Promise((resolve, reject) => { execFile(cmd, args, { timeout: 60_000 }, (err) => (err ? reject(err) : resolve())); });

/** 라이브러리 하나를 받아 dest/<id> 에 풂 (이미 있으면 그대로 둠) */
export async function fetchLibrary(entry, dest, { fetchImpl = fetch } = {}) {
  const target = join(dest, entry.id);
  if (existsSync(target)) return false;
  await mkdir(dest, { recursive: true });
  const res = await fetchImpl(BASE + entry.src, { signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`download_failed_${res.status}`);
  const zip = Buffer.from(await res.arrayBuffer());
  if (zip.length > 8 * 1024 * 1024) throw new Error('too_large');
  if (createHash('sha256').update(zip).digest('hex') !== entry.sha256) throw new Error('checksum_mismatch');
  const tmp = await mkdtemp(join(dest, '.tmp-'));
  try {
    await writeFile(join(tmp, 'lib.zip'), zip);
    await sh('unzip', ['-q', join(tmp, 'lib.zip'), '-d', join(tmp, 'out')]);
    const top = (await readdir(join(tmp, 'out'), { withFileTypes: true })).filter((e) => e.isDirectory());
    if (top.length !== 1) throw new Error('unexpected_layout');
    const root = join(tmp, 'out', top[0].name);
    await Promise.all(PRUNE.map((d) => rm(join(root, d), { recursive: true, force: true })));
    await sh('chmod', ['-R', 'a+rX', root]); // 컴파일러(다른 사용자)가 읽을 수 있게
    await rename(root, target);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
  return true;
}

/**
 * @param {object} o { builder (createArduinoBuilder 의 결과), libsDir, catalog, loadState(), saveState(state) }
 *   state: { on: [선택 라이브러리 중 설치한 것], off: [기본 라이브러리 중 지운 것] } — 서버를 다시 띄워도 유지하기 위해 DB 에 저장
 */
export function createLibraryManager({ builder, libsDir, catalog = loadCatalog(), loadState = async () => null, saveState = async () => {}, fetchImpl }) {
  const byId = new Map(catalog.map((e) => [e.id, e]));
  let state = { on: [], off: [] };
  let queue = Promise.resolve();
  const installed = (id) => existsSync(join(libsDir, id));
  const serial = (fn) => { const t = queue.then(fn); queue = t.catch(() => {}); return t; };
  const wanted = () => catalog.filter((e) => (e.optional ? state.on.includes(e.id) : !state.off.includes(e.id)));
  const persist = async () => { try { await saveState(state); } catch { /* DB 가 없어도 설치 자체는 됨 */ } };

  async function installOne(id, seen = new Set()) {
    const e = byId.get(id);
    if (!e || seen.has(id)) return;
    seen.add(id);
    for (const dep of e.requires || []) await installOne(dep, seen);
    if (await fetchLibrary(e, libsDir, { fetchImpl })) builder.libraryChanged(id);
  }

  return {
    /** 화면에 보여 줄 목록 */
    list() {
      return [
        ...catalog.map((e) => ({ id: e.id, name: e.name, version: e.version, author: e.author, headers: e.headers, desc: e.desc, sim: e.sim, optional: !!e.optional, requires: e.requires || [], installed: installed(e.id) })),
        ...BUILTIN.map((e) => ({ ...e, version: '', author: 'Arduino', sim: 'full', optional: false, requires: [], installed: true, builtin: true })),
      ];
    },
    /** 헤더 이름으로, 설치되지 않은 라이브러리를 찾음 (컴파일 오류 안내용) */
    missingFor(header) { return catalog.find((e) => !installed(e.id) && e.headers.includes(header)) || null; },
    install(id) {
      if (!byId.has(id)) throw Object.assign(new Error('unknown_library'), { expose: true });
      return serial(async () => {
        await installOne(id);
        const mark = (x) => { const e = byId.get(x); if (e.optional) { if (!state.on.includes(x)) state.on.push(x); } else state.off = state.off.filter((y) => y !== x); (e.requires || []).forEach(mark); };
        mark(id);
        await persist();
      });
    },
    remove(id) {
      const e = byId.get(id);
      if (!e) throw Object.assign(new Error('unknown_library'), { expose: true });
      const users = catalog.filter((x) => x.id !== id && installed(x.id) && (x.requires || []).includes(id));
      if (users.length) throw Object.assign(new Error('library_in_use'), { expose: true, users: users.map((x) => x.name) });
      return serial(async () => {
        await rm(join(libsDir, id), { recursive: true, force: true });
        builder.libraryChanged(id);
        if (e.optional) state.on = state.on.filter((x) => x !== id); else if (!state.off.includes(id)) state.off.push(id);
        await persist();
      });
    },
    /** 서버 시작 시: 저장된 상태대로 빠진 라이브러리를 다시 받음 (배포할 때마다 디스크가 초기화되는 곳을 위해) */
    sync() {
      return serial(async () => {
        try { const s = await loadState(); if (s) state = { on: Array.isArray(s.on) ? s.on.filter((x) => byId.has(x)) : [], off: Array.isArray(s.off) ? s.off.filter((x) => byId.has(x)) : [] }; } catch { /* noop */ }
        const done = [];
        for (const e of wanted()) { if (installed(e.id)) continue; try { await installOne(e.id); done.push(e.id); } catch (err) { console.warn('[arduino] 라이브러리 설치 실패:', e.id, err.message); } }
        return done;
      });
    },
  };
}
