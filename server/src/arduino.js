// 아두이노 스케치 컴파일: 진짜 컴파일러(avr-gcc)와 아두이노 코어 · 라이브러리로 .ino → 기계어(.hex).
// 브라우저는 이 .hex 를 ATmega328P 에뮬레이터에서 실행합니다.
//
// 필요한 것 (server/Dockerfile 이 설치): gcc-avr, avr-libc, arduino-core-avr 패키지 + 라이브러리 소스(ARDUINO_LIBS_DIR).
// 없으면 available() 이 false 이고, 클라이언트는 브라우저 안의 간이 변환기로 실행합니다.
//
// 보안: 컴파일러는 남이 쓴 코드를 읽으므로 `#include "/proc/1/environ"` 같은 방법으로 서버의 비밀 값을 오류 메시지나
// 결과물에 담아 빼낼 수 있습니다. 그래서 컴파일러는 (1) 환경 변수를 비운 채 (2) 서버와 다른 사용자(uid)로 실행합니다.
// 다른 사용자로 바꿀 수 없으면(루트가 아니면) ARDUINO_COMPILER=1 로 명시하지 않는 한 기능을 끕니다.
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile, chown, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

const BOARDS = {
  uno: { variant: 'standard', define: 'ARDUINO_AVR_UNO', flash: 32256 },
  nano: { variant: 'eightanaloginputs', define: 'ARDUINO_AVR_NANO', flash: 30720 },
  promini: { variant: 'eightanaloginputs', define: 'ARDUINO_AVR_PRO', flash: 30720 },
};
const RAM = 2048;
const MAX_SOURCE = 200_000;
const SAFE_NAME = /^[A-Za-z0-9_][\w.-]{0,60}\.(h|hpp|cpp|c)$/;
const COMMON = ['-Os', '-w', '-ffunction-sections', '-fdata-sections', '-mmcu=atmega328p', '-DF_CPU=16000000L', '-DARDUINO=10819', '-DARDUINO_ARCH_AVR'];
const CXX = ['-std=gnu++11', '-fpermissive', '-fno-exceptions', '-fno-threadsafe-statics', '-Wno-error=narrowing'];

export class CompileError extends Error {
  constructor(code, log = '', errors = []) { super(code); this.code = code; this.log = log; this.errors = errors; }
}

// ───────── .ino → .cpp (아두이노 IDE 처럼 #include <Arduino.h> 와 함수 원형을 넣어 줌) ─────────
const NOT_FUNCTION = /^(struct|class|enum|union|namespace|typedef|template|extern\s+"|if|for|while|switch|do|else|return|using)\b/;

/** 최상위 함수 정의를 찾음 → [{ line, proto }] */
export function findFunctions(src) {
  const out = [];
  let depth = 0;
  let paren = 0;
  let stmtStart = 0; // 지금 문장이 시작한 위치
  let line = 1;
  let stmtLine = 1;
  let fresh = true; // 문장의 첫 글자를 아직 못 만남
  const n = src.length;
  for (let i = 0; i < n; i++) {
    const c = src[i];
    if (c === '\n') { line++; continue; }
    if (c === '/' && src[i + 1] === '/') { while (i < n && src[i] !== '\n') i++; line++; continue; }
    if (c === '/' && src[i + 1] === '*') { i += 2; while (i < n && !(src[i] === '*' && src[i + 1] === '/')) { if (src[i] === '\n') line++; i++; } i++; continue; }
    if (c === '"' || c === "'") { i++; while (i < n && src[i] !== c && src[i] !== '\n') { if (src[i] === '\\') i++; i++; } continue; }
    if (c === '#' && /^[ \t]*$/.test(src.slice(src.lastIndexOf('\n', i - 1) + 1, i))) { // 전처리 줄
      while (i < n && src[i] !== '\n') { if (src[i] === '\\' && src[i + 1] === '\n') { i++; line++; } i++; }
      line++;
      if (depth === 0 && paren === 0) { stmtStart = i + 1; fresh = true; }
      continue;
    }
    if (/\s/.test(c)) continue;
    if (depth === 0 && fresh) { stmtStart = i; stmtLine = line; fresh = false; }
    if (c === '(') paren++;
    else if (c === ')') paren = Math.max(0, paren - 1);
    else if (c === '{') {
      if (depth === 0 && paren === 0) {
        const head = src.slice(stmtStart, i).replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, ' ').replace(/\s+/g, ' ').trim();
        const m = /^([\w\s*&:<>,]+?[\s*&])([A-Za-z_]\w*)\s*\((.*)\)$/.exec(head);
        if (m && !NOT_FUNCTION.test(head) && !/[={};]/.test(m[1]) && !/\boperator\b/.test(head) && !m[2].match(/^(if|for|while|switch)$/)) {
          // 기본값(= …)은 원형에서 뺌
          let params = ''; let d = 0; let skip = false;
          for (const ch of m[3]) {
            if (ch === '(' || ch === '<' || ch === '[') d++;
            if (ch === ')' || ch === '>' || ch === ']') d--;
            if (ch === '=' && d === 0) skip = true;
            if (ch === ',' && d === 0) skip = false;
            if (!skip) params += ch;
          }
          out.push({ line: stmtLine, name: m[2], proto: `${m[1].trim()} ${m[2]}(${params.trim()});` });
        }
      }
      depth++;
    } else if (c === '}') { depth = Math.max(0, depth - 1); if (depth === 0) { stmtStart = i + 1; fresh = true; } } else if (c === ';' && depth === 0 && paren === 0) { stmtStart = i + 1; fresh = true; }
  }
  return out;
}

export function inoToCpp(src, name = 'sketch.ino') {
  const fns = findFunctions(src);
  const lines = src.split('\n');
  const first = fns.length ? fns[0].line : lines.length + 1;
  const protos = fns.map((f) => f.proto).join(' ');
  return [
    '#include <Arduino.h>',
    `#line 1 "${name}"`,
    ...lines.slice(0, first - 1),
    protos,
    `#line ${first} "${name}"`,
    ...lines.slice(first - 1),
    '',
  ].join('\n');
}

// ───────── 빌드 ─────────
function run(cmd, args, { cwd, runAs, timeout = 60_000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, {
      cwd, timeout, maxBuffer: 4 * 1024 * 1024, killSignal: 'SIGKILL',
      env: { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: cwd || '/tmp', TMPDIR: cwd || '/tmp', LANG: 'C' }, // 서버의 비밀 값이 든 환경 변수는 넘기지 않음
      ...(runAs ? { uid: runAs.uid, gid: runAs.gid } : {}),
    }, (err, stdout, stderr) => {
      if (err) { err.stderr = String(stderr || ''); err.timedOut = err.killed; reject(err); } else resolve(String(stdout));
    });
  });
}

const listFiles = (dir, recursive) => {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) { if (recursive || e.name === 'utility') out.push(...listFiles(p, recursive)); } else out.push(p);
  }
  return out;
};
const isSource = (f) => /\.(c|cpp|S)$/.test(f);

/**
 * @param {object} o { avrDir, libsDir, workDir, mode: 'auto' | '1' | '0', runAsUser: { uid, gid } }
 */
export function createArduinoBuilder({
  avrDir = process.env.ARDUINO_AVR_DIR || '/usr/share/arduino/hardware/arduino/avr',
  libsDir = process.env.ARDUINO_LIBS_DIR || '/opt/arduino-libs',
  workDir = process.env.ARDUINO_WORK_DIR || join(tmpdir(), 'chat-site-arduino'),
  mode = process.env.ARDUINO_COMPILER || 'auto',
  runAsUser = { uid: Number(process.env.ARDUINO_RUN_UID) || 65534, gid: Number(process.env.ARDUINO_RUN_GID) || 65534 },
} = {}) {
  const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;
  const runAs = isRoot ? runAsUser : null;
  let ready = null; // Promise<boolean>
  let libs = null; // 이름 → { name, root, includes: [dir], sources: [file], headers: Set }
  const headerOwner = new Map();
  let queue = Promise.resolve();
  let waiting = 0;
  const cache = new Map(); // 해시 → 결과 (최근 40개)
  const stats = { compiled: 0, cached: 0, failed: 0 };

  function scanLibs() {
    libs = new Map();
    for (const base of [join(avrDir, 'libraries'), libsDir]) {
      if (!existsSync(base)) continue;
      for (const name of readdirSync(base)) {
        const dir = join(base, name);
        if (!statSync(dir).isDirectory()) continue;
        const src = existsSync(join(dir, 'src')) ? join(dir, 'src') : dir;
        const files = listFiles(src, src !== dir);
        const lib = { name, root: src, sources: files.filter(isSource), headers: readdirSync(src).filter((f) => /\.h(pp)?$/.test(f)) };
        libs.set(name, lib);
        for (const hname of lib.headers) if (!headerOwner.has(hname)) headerOwner.set(hname, name);
      }
    }
  }
  const includesOf = (text) => [...text.matchAll(/^[ \t]*#[ \t]*include[ \t]*[<"]([^>"]+)[>"]/gm)].map((m) => m[1]);
  /** 스케치가 쓰는 라이브러리 (라이브러리가 쓰는 라이브러리까지) */
  function neededLibs(texts) {
    const need = new Set();
    const visit = (text) => {
      for (const inc of includesOf(text)) {
        const owner = headerOwner.get(basename(inc));
        if (!owner || need.has(owner)) continue;
        need.add(owner);
        const lib = libs.get(owner);
        for (const f of [...lib.sources, ...lib.headers.map((x) => join(lib.root, x))]) { try { visit(readFileSync(f, 'utf8')); } catch { /* noop */ } }
      }
    };
    texts.forEach(visit);
    return [...need];
  }
  const allIncludes = () => [...libs.values()].flatMap((l) => ['-I', l.root]);
  const boardFlags = (board) => [`-D${BOARDS[board].define}`, '-I', join(avrDir, 'cores/arduino'), '-I', join(avrDir, 'variants', BOARDS[board].variant)];

  async function compileObjects(sources, outDir, board, extra = []) {
    await mkdir(outDir, { recursive: true });
    if (runAs) await chown(outDir, runAs.uid, runAs.gid);
    const objs = [];
    for (const [i, f] of sources.entries()) {
      const obj = join(outDir, `${i}_${basename(f)}.o`);
      const cxx = f.endsWith('.cpp');
      const args = f.endsWith('.S')
        ? ['-c', '-x', 'assembler-with-cpp', ...COMMON, ...boardFlags(board), ...extra, f, '-o', obj]
        : ['-c', ...COMMON, ...(cxx ? CXX : ['-std=gnu11']), ...boardFlags(board), ...allIncludes(), ...extra, f, '-o', obj];
      await run(cxx ? 'avr-g++' : 'avr-gcc', args, { cwd: outDir, runAs });
      objs.push(obj);
    }
    return objs;
  }
  /** 코어 · 라이브러리는 한 번만 컴파일해 보관 (.a) */
  async function archive(key, sources, board) {
    const variant = BOARDS[board].variant;
    const file = join(workDir, 'cache', variant, `${key}.a`);
    if (existsSync(file)) return file;
    const dir = join(workDir, 'cache', variant, `${key}.build`);
    await rm(dir, { recursive: true, force: true });
    const objs = await compileObjects(sources, dir, board);
    const tmp = join(dir, 'out.a');
    if (objs.length) await run('avr-gcc-ar', ['rcs', tmp, ...objs], { cwd: dir, runAs }); else await run('avr-gcc-ar', ['rcs', tmp], { cwd: dir, runAs });
    await rename(tmp, file);
    await rm(dir, { recursive: true, force: true });
    return file;
  }

  function parseErrors(log, jobDir) {
    const clean = log.split(jobDir).join('').replace(/^\//gm, '').replace(/(^|\s)\/?(tmp|opt|usr|app)\/[^\s:]*\/([^\/\s:]+)/g, '$1$3');
    const errors = [];
    for (const m of clean.matchAll(/^(?:\/)?([\w.-]+):(\d+):(?:(\d+):)?\s*(?:fatal )?error:\s*(.+)$/gm)) errors.push({ file: m[1], line: Number(m[2]), col: Number(m[3]) || 0, message: m[4] });
    for (const m of clean.matchAll(/undefined reference to [`'](.+?)'/g)) errors.push({ file: '', line: 0, col: 0, message: `'${m[1]}' 을(를) 찾을 수 없습니다 (선언만 있고 내용이 없거나, 라이브러리가 없습니다)` });
    return { clean: clean.slice(0, 6000), errors: errors.slice(0, 20) };
  }

  async function build({ sketch, board, files }) {
    await mkdir(join(workDir, 'jobs'), { recursive: true });
    const job = await mkdtemp(join(workDir, 'jobs', 'j-'));
    try {
      if (runAs) await chown(job, runAs.uid, runAs.gid);
      const extras = [];
      for (const f of files) { const p = join(job, f.name); await writeFile(p, f.content); extras.push(p); }
      const cpp = join(job, 'sketch.ino.cpp');
      await writeFile(cpp, inoToCpp(sketch));
      const need = neededLibs([sketch, ...files.map((f) => f.content)]);
      const core = await archive('core', listFiles(join(avrDir, 'cores/arduino'), false).filter(isSource), board);
      const libArchives = [];
      for (const name of need) libArchives.push(await archive(`lib-${name}`, libs.get(name).sources, board));
      let objs;
      try {
        objs = await compileObjects([cpp, ...extras.filter(isSource)], join(job, 'obj'), board, ['-I', job]);
      } catch (e) {
        if (e.timedOut) throw new CompileError('compile_timeout');
        const { clean, errors } = parseErrors(e.stderr || String(e.message), job);
        throw new CompileError('compile_error', clean, errors);
      }
      const elf = join(job, 'sketch.elf');
      try {
        // 라이브러리끼리 서로를 쓰므로 묶어서(--start-group) 연결
        await run('avr-gcc', ['-w', '-Os', '-Wl,--gc-sections', '-mmcu=atmega328p', '-o', elf, ...objs, '-Wl,--start-group', ...libArchives, core, '-lm', '-Wl,--end-group'], { cwd: job, runAs });
      } catch (e) {
        const { clean, errors } = parseErrors(e.stderr || String(e.message), job);
        throw new CompileError('compile_error', clean, errors);
      }
      await run('avr-objcopy', ['-O', 'ihex', '-R', '.eeprom', elf, join(job, 'sketch.hex')], { cwd: job, runAs });
      const size = await run('avr-size', ['-A', elf], { cwd: job, runAs });
      const sec = (n) => Number(new RegExp(`^\\.${n}\\s+(\\d+)`, 'm').exec(size)?.[1] || 0);
      const flash = sec('text') + sec('data');
      const ram = sec('data') + sec('bss');
      if (flash > BOARDS[board].flash) throw new CompileError('compile_error', `스케치가 너무 큽니다: ${flash} 바이트 (최대 ${BOARDS[board].flash} 바이트)`, [{ file: '', line: 0, col: 0, message: `스케치가 너무 큽니다: ${flash} 바이트 (이 보드는 최대 ${BOARDS[board].flash} 바이트)` }]);
      return { hex: await readFile(join(job, 'sketch.hex'), 'utf8'), flash, flashMax: BOARDS[board].flash, ram, ramMax: RAM, libraries: need };
    } finally {
      rm(job, { recursive: true, force: true }).catch(() => {});
    }
  }

  async function check() {
    if (mode === '0') return false;
    if (!isRoot && mode !== '1') return false; // 서버와 같은 사용자로는 실행하지 않음 (파일 머리말 참고)
    if (!existsSync(join(avrDir, 'cores/arduino/Arduino.h'))) return false;
    try {
      await mkdir(workDir, { recursive: true });
      if (runAs) await chown(workDir, runAs.uid, runAs.gid);
      await run('avr-gcc', ['--version'], { cwd: workDir, runAs, timeout: 10_000 });
      scanLibs();
      return true;
    } catch { return false; }
  }

  return {
    available() { ready = ready || check(); return ready; },
    stats: () => ({ ...stats, cacheSize: cache.size, libraries: libs ? [...libs.keys()] : [] }),
    /** @returns {Promise<{ hex, flash, flashMax, ram, ramMax, libraries, cached }>} */
    async compile({ sketch, board = 'uno', files = [] }) {
      if (!(await this.available())) throw new CompileError('compiler_unavailable');
      if (typeof sketch !== 'string' || !sketch.trim() || sketch.length > MAX_SOURCE) throw new CompileError('bad_sketch');
      if (!Object.hasOwn(BOARDS, board)) throw new CompileError('bad_board');
      if (!Array.isArray(files) || files.length > 20) throw new CompileError('bad_files');
      let total = sketch.length;
      const safe = [];
      for (const f of files) {
        if (!f || typeof f.name !== 'string' || typeof f.content !== 'string' || !SAFE_NAME.test(f.name) || f.name.startsWith('sketch.')) throw new CompileError('bad_files');
        total += f.content.length;
        safe.push({ name: f.name, content: f.content });
      }
      if (total > MAX_SOURCE * 2) throw new CompileError('bad_sketch');
      const key = createHash('sha256').update(JSON.stringify([board, sketch, safe])).digest('hex');
      const hit = cache.get(key);
      if (hit) { stats.cached++; cache.delete(key); cache.set(key, hit); if (hit.error) throw hit.error; return { ...hit, cached: true }; }
      if (waiting >= 6) throw new CompileError('compiler_busy');
      waiting++;
      const task = queue.then(() => build({ sketch, board, files: safe }));
      queue = task.catch(() => {});
      try {
        const result = await task;
        stats.compiled++;
        cache.set(key, result);
        return { ...result, cached: false };
      } catch (e) {
        stats.failed++;
        if (e instanceof CompileError && e.code === 'compile_error') cache.set(key, { error: e });
        if (e instanceof CompileError) throw e;
        throw new CompileError('compiler_failed', String(e.stderr || e.message || e).slice(0, 2000));
      } finally {
        waiting--;
        while (cache.size > 40) cache.delete(cache.keys().next().value);
      }
    },
  };
}
