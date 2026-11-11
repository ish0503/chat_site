// 아두이노 시뮬레이터 런타임: 변환된 스케치가 쓰는 함수(pinMode · Serial · delay …)와 센서 라이브러리, 그리고 회로 계산.
// Worker 안에서 실행됩니다 (테스트에서는 Node 에서 직접 실행).
//
// 회로 계산: 화면에서 만든 회로는 "노드(전기적으로 이어진 점) 번호" 목록으로 넘어옵니다.
//   · 저항 · 버튼 · 가변저항 · 조도 센서 · LED 는 실제로 전압을 계산 (노드 해석법) → 분압, 풀업/풀다운, LED 전류가 그대로 나옴
//   · DHT · GPS 같은 모듈은 전원(VCC/GND)과 신호 핀이 올바른 아두이노 핀에 이어져 있는지만 확인하고, 화면에서 정한 값을 돌려줌

const INPUT = 0; const OUTPUT = 1; const INPUT_PULLUP = 2;
const PWM_PINS = new Set([3, 5, 6, 9, 10, 11]);
const LED_VF = { red: 1.8, yellow: 2.0, green: 2.1, blue: 3.0, white: 3.0 };
const LED_RS = 12; // 켜진 LED 의 내부 저항(Ω)
const LED_BURN_MA = 45; // 이보다 큰 전류가 계속 흐르면 LED 가 탐
const NEEDS_5V = new Set(['hcsr04', 'servo', 'lcd']); // 3.3V 로는 동작하지 않는 부품
const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });
const pinName = (n) => (n < 14 ? `D${n}` : `A${n - 14}`);
const pinLabel = (n) => (n < 14 ? `D${n}` : `A${n - 14}`);
const noise = (amp) => (Math.random() - 0.5) * 2 * amp;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

class StopSignal extends Error {}

/** char 배열(숫자들) 또는 문자열 → JS 문자열 */
function cs(x) {
  if (typeof x === 'string') return x;
  if (x == null) return '';
  if (typeof x === 'object' && typeof x.length === 'number') { let s = ''; for (let i = 0; i < x.length && x[i]; i++) s += String.fromCharCode(x[i] & 255); return s; }
  return String(x);
}
function cw(buf, s, max = Infinity) {
  if (buf == null || typeof buf !== 'object') throw new Error('문자열을 써 넣을 char 배열이 필요합니다');
  const n = Math.min(s.length, buf.length - 1, max);
  for (let i = 0; i < n; i++) buf[i] = s.charCodeAt(i);
  if (n < buf.length) buf[n] = 0;
  return buf;
}

function fmtPrint(v, f, t) {
  if (typeof v === 'string') return v;
  if (typeof v === 'boolean') return v ? '1' : '0';
  if (v == null) return '';
  if (typeof v === 'object') return cs(v);
  if (typeof v !== 'number') return String(v);
  if (t === 'char' && f === undefined) return String.fromCharCode(v & 255);
  if (t === 'float' || ((t === 'any' || t === undefined) && !Number.isInteger(v))) {
    if (Number.isNaN(v)) return 'nan';
    if (!Number.isFinite(v)) return v < 0 ? '-inf' : 'inf';
    return v.toFixed(clamp(f === undefined ? 2 : f | 0, 0, 20));
  }
  const n = Math.trunc(v);
  if (f === 16 || f === 2 || f === 8) return (n < 0 ? n >>> 0 : n).toString(f).toUpperCase();
  return String(n);
}

function sprintf(fmt, args) {
  let k = 0;
  return fmt.replace(/%([-+ 0#]*)(\d+)?(?:\.(\d+))?(l{0,2}|h{0,2})([diuxXcsf%eg])/g, (all, flags, width, prec, len, conv) => {
    if (conv === '%') return '%';
    const a = args[k++];
    let s;
    if (conv === 'd' || conv === 'i' || conv === 'u') s = String(Math.trunc(Number(a) || 0));
    else if (conv === 'x' || conv === 'X') { s = (Math.trunc(Number(a) || 0) >>> 0).toString(16); if (conv === 'X') s = s.toUpperCase(); } else if (conv === 'c') s = typeof a === 'string' ? a[0] || '' : String.fromCharCode(a & 255);
    else if (conv === 's') { s = cs(a); if (prec !== undefined) s = s.slice(0, Number(prec)); } else s = (Number(a) || 0).toFixed(prec === undefined ? 6 : Number(prec));
    if (flags.includes('+') && conv !== 's' && conv !== 'c' && !s.startsWith('-')) s = `+${s}`;
    const w = Number(width) || 0;
    if (s.length < w) {
      if (flags.includes('-')) s = s.padEnd(w);
      else if (flags.includes('0') && conv !== 's' && conv !== 'c') { const neg = /^[-+]/.test(s) ? s[0] : ''; s = neg + s.slice(neg.length).padStart(w - neg.length, '0'); } else s = s.padStart(w);
    }
    return s;
  });
}

// ── String 메서드 (값은 JS 문자열) ──
const toInt = (s) => { const m = /^\s*[-+]?\d+/.exec(cs(s)); return m ? clamp(parseInt(m[0], 10), -2147483648, 2147483647) : 0; };
const toFloat = (s) => { const m = /^\s*[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?/.exec(cs(s)); return m ? Number(m[0]) : 0; };
const chr = (x) => (typeof x === 'number' ? String.fromCharCode(x & 255) : cs(x));
const S = {
  length: (s) => cs(s).length,
  charAt: (s, i) => cs(s).charCodeAt(i) || 0,
  substring: (s, a, b) => cs(s).substring(a, b === undefined ? undefined : b),
  indexOf: (s, x, from) => cs(s).indexOf(chr(x), from || 0),
  lastIndexOf: (s, x, from) => (from === undefined ? cs(s).lastIndexOf(chr(x)) : cs(s).lastIndexOf(chr(x), from)),
  toInt, toFloat, toDouble: toFloat,
  equals: (s, x) => cs(s) === cs(x),
  equalsIgnoreCase: (s, x) => cs(s).toLowerCase() === cs(x).toLowerCase(),
  startsWith: (s, x, from) => cs(s).startsWith(cs(x), from || 0),
  endsWith: (s, x) => cs(s).endsWith(cs(x)),
  compareTo: (s, x) => (cs(s) < cs(x) ? -1 : cs(s) > cs(x) ? 1 : 0),
  c_str: (s) => cs(s),
  isEmpty: (s) => cs(s).length === 0,
  trim: (s) => cs(s).trim(),
  toUpperCase: (s) => cs(s).toUpperCase(),
  toLowerCase: (s) => cs(s).toLowerCase(),
  replace: (s, a, b) => cs(s).split(chr(a)).join(chr(b)),
  remove: (s, i, n) => { const t = cs(s); return n === undefined ? t.slice(0, i) : t.slice(0, i) + t.slice(i + n); },
  concat: (s, x) => cs(s) + cs(x),
  setCharAt: (s, i, c) => { const t = cs(s); return i >= 0 && i < t.length ? t.slice(0, i) + chr(c) + t.slice(i + 1) : t; },
  reserve: (s) => cs(s),
  toCharArray: (s, buf, len) => { cw(buf, cs(s), (len ?? buf.length) - 1); },
  getBytes: (s, buf, len) => { cw(buf, cs(s), (len ?? buf.length) - 1); },
};

const TYPED = { char: Int8Array, uchar: Uint8Array, bool: Uint8Array, int: Int16Array, uint: Uint16Array, long: Int32Array, ulong: Uint32Array, float: Float64Array, llong: Float64Array };

function sinit(obj, list) {
  const keys = Object.keys(obj);
  (list || []).forEach((v, i) => {
    const k = keys[i];
    if (k === undefined) return;
    const cur = obj[k];
    if (Array.isArray(v) && cur && typeof cur === 'object') { if (ArrayBuffer.isView(cur)) cur.set(v.slice(0, cur.length)); else if (Array.isArray(cur)) v.forEach((x, j) => { cur[j] = x; }); else sinit(cur, v); } else if (typeof v === 'string' && cur && typeof cur === 'object') cw(cur, v);
    else obj[k] = v;
  });
  return obj;
}

function makeArray(kind, dims, init) {
  const make = (d, ini) => {
    let n = dims[d];
    if (n == null) n = typeof ini === 'string' ? ini.length + 1 : Array.isArray(ini) ? ini.length : 0;
    n = Math.trunc(n);
    if (!(n >= 0) || n > 200000) throw new Error(`배열 크기가 잘못되었습니다 (${n})`);
    if (d < dims.length - 1) return Array.from({ length: n }, (_, i) => make(d + 1, Array.isArray(ini) ? ini[i] : undefined));
    if (typeof kind === 'function') return Array.from({ length: n }, (_, i) => (ini?.[i] === undefined ? kind() : Array.isArray(ini[i]) ? sinit(kind(), ini[i]) : ini[i]));
    const T = TYPED[kind];
    if (T) {
      const a = new T(n);
      if (typeof ini === 'string') { for (let i = 0; i < Math.min(n, ini.length); i++) a[i] = ini.charCodeAt(i); } else if (Array.isArray(ini)) a.set(ini.slice(0, n).map((x) => (typeof x === 'boolean' ? Number(x) : x)));
      return a;
    }
    const blank = kind === 'String' || kind === 'cstr' ? '' : 0;
    return Array.from({ length: n }, (_, i) => ini?.[i] ?? blank);
  };
  return make(0, init);
}
const sizeOf = (a, elem) => (a && typeof a === 'object' && a.length !== undefined ? a.length * (a[0] && typeof a[0] === 'object' ? sizeOf(a[0], elem) : elem) : elem);

/** 연립방정식 A·x = z (가우스 소거, 부분 피벗) */
function gauss(A, z) {
  const n = z.length;
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    if (Math.abs(A[p][c]) < 1e-18) continue;
    if (p !== c) { [A[p], A[c]] = [A[c], A[p]]; [z[p], z[c]] = [z[c], z[p]]; }
    for (let r = c + 1; r < n; r++) {
      const f = A[r][c] / A[c][c];
      if (!f) continue;
      for (let k = c; k < n; k++) A[r][k] -= f * A[c][k];
      z[r] -= f * z[c];
    }
  }
  const x = new Float64Array(n);
  for (let r = n - 1; r >= 0; r--) {
    let s = z[r];
    for (let k = r + 1; k < n; k++) s -= A[r][k] * x[k];
    x[r] = Math.abs(A[r][r]) < 1e-18 ? 0 : s / A[r][r];
  }
  return x;
}

/**
 * @param {object} io  { post(msg) } — 화면으로 보내는 통로
 */
export function createRuntime({ post }) {
  const t0 = performance.now();
  const pins = Array.from({ length: 22 }, () => ({ mode: INPUT, out: 0, pwm: null, tone: 0, fall: -1e9, used: false }));
  let net = { n: 0, pins: {}, parts: [] };
  const partById = new Map();
  const pstate = new Map(); // 부품의 표시 상태 (서보 각도, LCD 글자 …)
  let V = new Float64Array(0);
  let floating = [];
  let leds = new Map();
  const overSince = new Map(); // LED id → 과전류가 시작된 시각
  const burnt = new Set();
  const servoObjs = [];
  const lcdObjs = [];
  let dirty = true;
  let changed = true;
  let stopped = false;
  let lastReport = '';
  const hints = new Set();
  const interrupts = {};
  const softSerials = [];
  const timers = [];

  const hint = (text) => { if (hints.has(text)) return; hints.add(text); post({ type: 'hint', text }); };
  const node = (pin) => net.pins[pinName(pin)];
  const checkPin = (pin, fn) => { if (!Number.isInteger(pin) || pin < 0 || pin > 21) throw new Error(`${fn}(): 핀 번호가 잘못되었습니다 (${pin})`); if (node(pin) === undefined && pin !== 13) hint(`이 보드에는 ${pinLabel(pin)} 핀이 없습니다.`); return pins[pin]; };
  const touch = () => { dirty = true; changed = true; };

  // ───────── 회로 계산 ─────────
  function solve() {
    dirty = false;
    const n = net.n;
    const fixed = new Float64Array(n).fill(NaN);
    const setFixed = (name, v) => { const k = net.pins[name]; if (k !== undefined) fixed[k] = v; };
    setFixed('VIN', 5); setFixed('3V3', 3.3); setFixed('5V', 5); setFixed('GND', 0);
    const edges = []; // [a, b, 전도도]
    const sources = []; // [노드, 전도도, 전압, PWM 핀 번호(-1 = 아님)]
    const pulsed = []; // PWM · tone 으로 빠르게 켜졌다 꺼지는 핀: [핀 번호, 켜진 비율]
    pins.forEach((p, i) => {
      const k = node(i);
      if (k === undefined) return;
      if (p.mode === OUTPUT) {
        const duty = p.tone ? 0.5 : p.pwm != null ? p.pwm / 255 : null;
        if (duty !== null) pulsed.push([i, duty]);
        sources.push([k, 1 / 25, duty !== null ? 5 : p.out * 5, duty !== null ? i : -1]);
      } else if (p.mode === INPUT_PULLUP) sources.push([k, 1 / 35000, 5, -1]);
    });
    const ledParts = [];
    for (const part of net.parts) {
      const P = part.pins;
      const pr = part.props || {};
      const edge = (a, b, ohm) => { if (P[a] !== undefined && P[b] !== undefined && P[a] !== P[b]) edges.push([P[a], P[b], 1 / Math.max(ohm, 0.01)]); };
      switch (part.type) {
        case 'resistor': edge('A', 'B', Number(pr.ohm) || 220); break;
        case 'button': if (pr.pressed) edge('A', 'B', 0.05); break;
        case 'pot': { const R = Number(pr.ohm) || 10000; const x = clamp(Number(pr.pos) || 0, 0, 1); edge('1', 'W', R * x + 1); edge('W', '2', R * (1 - x) + 1); break; }
        case 'ldr': { const x = clamp(Number(pr.light) || 0, 0, 100) / 100; edge('A', 'B', 200000 * (0.0025 ** x)); break; } // 어두움 200kΩ → 밝음 500Ω
        case 'buzzer': edge('+', '-', 250); break;
        case 'led': if (P.A !== undefined && P.K !== undefined && P.A !== P.K && !burnt.has(part.id)) ledParts.push(part); break;
        default: if (P.VCC !== undefined && P.GND !== undefined) edge('VCC', 'GND', 5000); // 모듈이 쓰는 약한 전류
      }
    }
    // 고정 전압에 닿지 않는 노드 = 떠 있음(floating)
    const reach = new Uint8Array(n);
    const adj = Array.from({ length: n }, () => []);
    for (const [a, b] of edges) { adj[a].push(b); adj[b].push(a); }
    for (const part of ledParts) { adj[part.pins.A].push(part.pins.K); adj[part.pins.K].push(part.pins.A); }
    const stack = [];
    for (let k = 0; k < n; k++) if (!Number.isNaN(fixed[k])) { reach[k] = 1; stack.push(k); }
    for (const [k] of sources) if (!reach[k]) { reach[k] = 1; stack.push(k); }
    while (stack.length) for (const b of adj[stack.pop()]) if (!reach[b]) { reach[b] = 1; stack.push(b); }
    floating = Array.from(reach, (r) => !r);

    const unknown = [];
    const idx = new Int32Array(n).fill(-1);
    for (let k = 0; k < n; k++) if (Number.isNaN(fixed[k])) { idx[k] = unknown.length; unknown.push(k); }
    const m = unknown.length;
    /** 한 순간의 회로를 품 (lowPin: 이 PWM 핀만 꺼진 순간) → 노드 전압과 LED 전류(mA) */
    const phase = (lowPin) => {
    const on = new Map(ledParts.map((p) => [p.id, false]));
    let x = new Float64Array(m);
    const volt = (k) => (idx[k] < 0 ? fixed[k] : x[idx[k]]);
    for (let iter = 0; iter < 12; iter++) {
      const A = Array.from({ length: m }, () => new Float64Array(m));
      const z = new Float64Array(m);
      for (let k = 0; k < m; k++) A[k][k] = 1e-10;
      const addEdge = (a, b, g) => {
        const ia = idx[a]; const ib = idx[b];
        if (ia >= 0) { A[ia][ia] += g; if (ib >= 0) A[ia][ib] -= g; else z[ia] += g * fixed[b]; }
        if (ib >= 0) { A[ib][ib] += g; if (ia >= 0) A[ib][ia] -= g; else z[ib] += g * fixed[a]; }
      };
      for (const [a, b, g] of edges) addEdge(a, b, g);
      for (const [k, g, v, pin] of sources) if (idx[k] >= 0) { A[idx[k]][idx[k]] += g; z[idx[k]] += g * (pin === lowPin ? 0 : v); }
      for (const part of ledParts) {
        if (!on.get(part.id)) continue;
        const g = 1 / LED_RS;
        const vf = LED_VF[part.props?.color] || 1.8;
        addEdge(part.pins.A, part.pins.K, g);
        if (idx[part.pins.A] >= 0) z[idx[part.pins.A]] += g * vf;
        if (idx[part.pins.K] >= 0) z[idx[part.pins.K]] -= g * vf;
      }
      x = gauss(A, z);
      let flip = false;
      for (const part of ledParts) {
        const vf = LED_VF[part.props?.color] || 1.8;
        const vd = volt(part.pins.A) - volt(part.pins.K);
        const was = on.get(part.id);
        if (!was && vd > vf + 1e-3) { on.set(part.id, true); flip = true; } else if (was && vd < vf - 1e-3) { on.set(part.id, false); flip = true; }
      }
      if (!flip) break;
    }
    const v = Float64Array.from({ length: n }, (_, k) => volt(k));
    const cur = ledParts.map((part) => {
      const vf = LED_VF[part.props?.color] || 1.8;
      return on.get(part.id) ? Math.max(0, (v[part.pins.A] - v[part.pins.K] - vf) / LED_RS) * 1000 : 0;
    });
    return { v, cur };
    };
    // PWM 은 "모두 켜진 순간"을 기준으로, 각 PWM 핀이 꺼져 있는 시간만큼의 차이를 빼서 평균을 구함 (LED 밝기 = 평균 전류)
    const high = phase(-2);
    V = high.v.slice();
    const cur = high.cur.slice();
    for (const [pin, duty] of pulsed) {
      const low = phase(pin);
      for (let k = 0; k < n; k++) V[k] -= (1 - duty) * (high.v[k] - low.v[k]);
      for (let k = 0; k < cur.length; k++) cur[k] -= (1 - duty) * (high.cur[k] - low.cur[k]);
    }
    leds = new Map(ledParts.map((part, k) => [part.id, Math.max(0, cur[k])]));
    const now = performance.now();
    for (const [id, mA] of leds) { if (mA > LED_BURN_MA) { if (!overSince.has(id)) overSince.set(id, now); } else overSince.delete(id); }
    for (const id of [...overSince.keys()]) if (!leds.has(id)) overSince.delete(id);
  }
  /** 과전류가 1.5초 넘게 흐른 LED 는 타서 더는 켜지지 않음 (다시 실행하면 새 LED) */
  function burnCheck() {
    const now = performance.now();
    for (const [id, since] of overSince) if (now - since > 1500) { burnt.add(id); overSince.delete(id); touch(); }
  }
  const ensure = () => { if (dirty) solve(); };
  const voltAt = (k) => { ensure(); return k === undefined || floating[k] ? null : V[k]; };

  /** 부품에 걸린 전원 전압 (VCC − GND). 어느 한쪽이라도 이어지지 않았으면 0 */
  function supply(part) {
    const a = voltAt(part.pins.VCC); const b = voltAt(part.pins.GND);
    return a === null || b === null ? 0 : a - b;
  }
  const powered = (part) => supply(part) >= (NEEDS_5V.has(part.type) ? 4.5 : 3.0);
  /** 조건에 맞게 연결된 부품을 찾음. 없으면 무엇이 잘못됐는지 한 번 알려 줌 */
  function locate(type, label, wiring, test) {
    const all = net.parts.filter((p) => p.type === type);
    const ok = all.find((p) => test(p) && powered(p));
    if (ok) return ok;
    if (!all.length) hint(`${label}: 회로에 이 부품이 없습니다. "＋ 부품"에서 추가해 연결하세요.`);
    else if (all.some((p) => test(p) && supply(p) >= 3.0)) hint(`${label}: 이 부품은 5V 전원이 필요합니다. VCC 를 3.3V 가 아니라 5V 에 연결하세요.`);
    else if (all.some((p) => test(p))) hint(`${label}: 전원이 들어오지 않습니다. VCC → 5V${NEEDS_5V.has(type) ? '' : '(또는 3.3V)'}, GND → GND 를 연결하세요 (빵판의 + / − 줄을 쓴다면 그 줄도 보드의 5V / GND 에 이어져 있어야 합니다).`);
    else hint(`${label}: 신호선 연결을 확인하세요 (${wiring}).`);
    return null;
  }
  const i2c = (type, label) => locate(type, label, 'SDA → A4, SCL → A5', (p) => p.pins.SDA !== undefined && p.pins.SDA === node(18) && p.pins.SCL !== undefined && p.pins.SCL === node(19));

  // ───────── 시간 · 실행 제어 ─────────
  let lastYield = performance.now();
  const r = {
    c: 0,
    ln: 0,
    d: 0,
    deep() { throw new Error('함수가 자기 자신을 너무 깊게 부릅니다 (재귀 200단계 초과). 실제 우노는 메모리가 2KB 라 훨씬 일찍 멈춥니다.'); },
    async brk() {
      r.c = 0;
      if (stopped) throw new StopSignal();
      if (performance.now() - lastYield > 10) { await sleep(0); lastYield = performance.now(); if (stopped) throw new StopSignal(); }
    },
    str: (v, t) => fmtPrint(v, undefined, t),
    fmt: (v, f, t) => { const out = fmtPrint(v, f, t); return f === 16 ? out.toLowerCase() : out; }, // String(255, HEX) 는 소문자 "ff"
    sat: (s, i) => (typeof s === 'string' ? s.charCodeAt(i) || 0 : s?.[i] ?? 0),
    arr: makeArray,
    sinit,
    size: sizeOf,
    mk(name, args) { const C = Object.hasOwn(L, name) ? L[name] : null; if (!C) throw new Error(`'${name}' 라이브러리는 이 시뮬레이터에서 지원하지 않습니다`); return new C(...args); },
    st(cls, name) { const f = Object.hasOwn(L, cls) && Object.hasOwn(L[cls], name) ? L[cls][name] : null; if (typeof f !== 'function') throw new Error(`${cls}::${name} 은(는) 지원하지 않습니다`); return f; },
  };
  const delay = async (ms) => {
    if (stopped) throw new StopSignal();
    await sleep(Math.max(0, Number(ms) || 0));
    lastYield = performance.now();
    if (stopped) throw new StopSignal();
  };

  // ───────── 시리얼 ─────────
  let txBuf = '';
  let txFreeAt = 0;
  let txTimer = null;
  const flushTx = () => { txTimer = null; if (txBuf) { post({ type: 'serial', text: txBuf }); txBuf = ''; } };
  class Stream {
    constructor() { this.rx = []; this.timeout = 1000; }
    available() { return this.rx.length; }
    read() { return this.rx.length ? this.rx.shift() : -1; }
    peek() { return this.rx.length ? this.rx[0] : -1; }
    setTimeout(ms) { this.timeout = ms; }
    flush() {}
    end() {}
    async _wait() { // 글자가 올 때까지 (시간 제한 안에서) 기다림
      const until = performance.now() + this.timeout;
      while (!this.rx.length && performance.now() < until) await delay(5);
      return this.rx.length > 0;
    }
    async readString() { let s = ''; while (await this._wait()) s += String.fromCharCode(this.rx.shift()); return s; }
    async readStringUntil(end) { let s = ''; while (await this._wait()) { const c = this.rx.shift(); if (c === end) break; s += String.fromCharCode(c); } return s; }
    async readBytesUntil(end, buf, len) { let k = 0; while (k < len && await this._wait()) { const c = this.rx.shift(); if (c === end) break; buf[k++] = c; } return k; }
    async readBytes(buf, len) { let k = 0; while (k < len && await this._wait()) buf[k++] = this.rx.shift(); return k; }
    async _number(float) {
      let s = '';
      while (await this._wait()) { const c = String.fromCharCode(this.rx[0]); if (/[0-9]/.test(c) || (c === '-' && !s) || (float && c === '.' && !s.includes('.'))) { s += c; this.rx.shift(); } else if (!s || s === '-') { s = ''; this.rx.shift(); } else break; }
      return Number(s) || 0;
    }
    parseInt() { return this._number(false); }
    parseFloat() { return this._number(true); }
    async find(target) { const t = cs(target); let got = ''; while (await this._wait()) { got = (got + String.fromCharCode(this.rx.shift())).slice(-t.length); if (got === t) return true; } return false; }
    feed(text) { for (let i = 0; i < text.length; i++) this.rx.push(text.charCodeAt(i) & 255); while (this.rx.length > 4096) this.rx.shift(); }
    async _out() { /* 받는 장치가 없으면 버림 */ }
    print(v, f, t) { return this._out(fmtPrint(v, f, t)); }
    println(v, f, t) { return this._out(`${v === undefined ? '' : fmtPrint(v, f, t)}\n`); }
    write(v) { return this._out(typeof v === 'number' ? String.fromCharCode(v & 255) : cs(v)); }
  }
  class HardwareSerial extends Stream {
    constructor() { super(); this.on = false; this.baud = 9600; }
    begin(baud) { this.on = true; this.baud = Number(baud) || 9600; post({ type: 'baud', baud: this.baud }); }
    end() { this.on = false; }
    availableForWrite() { return 63; }
    async _out(text) {
      if (!text) return;
      if (!this.on) { hint('Serial.begin(9600) 을 setup() 에서 먼저 불러야 시리얼 모니터에 글자가 나옵니다.'); return; }
      txBuf += text;
      if (txBuf.length > 4000) flushTx(); else if (!txTimer) txTimer = setTimeout(flushTx, 30);
      // 통신 속도만큼만 내보냄 (9600 이면 1초에 960자) — 버퍼(64자)가 차면 실제 보드처럼 기다림
      const now = performance.now();
      const perChar = 10000 / this.baud;
      txFreeAt = Math.max(now, txFreeAt) + text.length * perChar;
      const wait = txFreeAt - now - 64 * perChar;
      if (wait > 1) await delay(wait);
    }
  }
  const Serial = new HardwareSerial();

  class SoftwareSerial extends Stream {
    constructor(rx, tx) { super(); this.rxPin = rx; this.txPin = tx; this.on = false; softSerials.push(this); }
    begin(baud) { this.on = true; this.baud = Number(baud) || 9600; if (this.baud !== 9600) hint(`SoftwareSerial.begin(${this.baud}): GPS 모듈(NEO-6M)은 보통 9600 으로 통신합니다.`); }
    listen() { return true; }
    isListening() { return true; }
    overflow() { return false; }
  }

  // ───────── 기본 함수 ─────────
  const g = Object.create(null);
  Object.assign(g, {
    HIGH: 1, LOW: 0, INPUT, OUTPUT, INPUT_PULLUP, LED_BUILTIN: 13, PI: Math.PI, HALF_PI: Math.PI / 2, TWO_PI: Math.PI * 2, DEG_TO_RAD: Math.PI / 180, RAD_TO_DEG: 180 / Math.PI, EULER: Math.E,
    CHANGE: 1, FALLING: 2, RISING: 3, DEC: 10, HEX: 16, OCT: 8, BIN: 2, MSBFIRST: 1, LSBFIRST: 0,
    A0: 14, A1: 15, A2: 16, A3: 17, A4: 18, A5: 19, A6: 20, A7: 21, SDA: 18, SCL: 19,
    DHT11: 11, DHT12: 12, DHT21: 21, DHT22: 22, AM2301: 21, NULL: 0, nullptr: 0, DEFAULT: 1, INTERNAL: 3, EXTERNAL: 0,
    Serial,
    K: () => 0, // 라이브러리 설정 상수 (MPU6050_RANGE_8_G 등)는 값이 필요 없음
    pinMode(pin, mode) { const p = checkPin(pin, 'pinMode'); p.mode = mode === OUTPUT ? OUTPUT : mode === INPUT_PULLUP ? INPUT_PULLUP : INPUT; p.used = true; touch(); },
    digitalWrite(pin, val) {
      const p = checkPin(pin, 'digitalWrite');
      p.used = true;
      if (p.mode !== OUTPUT) { p.mode = val ? INPUT_PULLUP : INPUT; hint(`digitalWrite(${pinLabel(pin)}, …) 를 썼지만 pinMode(${pinLabel(pin)}, OUTPUT) 이 없습니다. 출력으로 쓰려면 setup() 에서 pinMode 를 먼저 부르세요.`); touch(); return; }
      const v = val ? 1 : 0;
      if (p.out && !v) p.fall = performance.now();
      if (p.out !== v || p.pwm != null || p.tone) { p.out = v; p.pwm = null; p.tone = 0; touch(); }
    },
    digitalRead(pin) {
      const p = checkPin(pin, 'digitalRead');
      if (p.mode === OUTPUT) return p.pwm != null ? (p.pwm > 127 ? 1 : 0) : p.out;
      const v = voltAt(node(pin));
      if (v === null) { hint(`${pinLabel(pin)} 핀이 어디에도 이어져 있지 않아(떠 있음) 값이 제멋대로 읽힙니다. 버튼에는 풀업/풀다운 저항을 달거나 pinMode(${pinLabel(pin)}, INPUT_PULLUP) 을 쓰세요.`); return Math.random() < 0.5 ? 1 : 0; }
      return v >= 2.5 ? 1 : 0;
    },
    analogRead(pin) {
      const ch = pin >= 14 ? pin - 14 : pin;
      if (!Number.isInteger(ch) || ch < 0 || ch > 7) throw new Error(`analogRead(): 아날로그 핀이 아닙니다 (${pin})`);
      const v = voltAt(node(14 + ch));
      if (v === null) { hint(`A${ch} 핀이 어디에도 이어져 있지 않아(떠 있음) analogRead 값이 흔들립니다.`); return Math.round(300 + Math.random() * 200); }
      return clamp(Math.round((v / 5) * 1023 + noise(0.6)), 0, 1023);
    },
    analogWrite(pin, val) {
      const p = checkPin(pin, 'analogWrite');
      p.used = true; p.mode = OUTPUT; p.tone = 0;
      const v = clamp(Math.trunc(val) || 0, 0, 255);
      if (!PWM_PINS.has(pin)) { hint(`${pinLabel(pin)} 은(는) PWM(~) 핀이 아니어서 analogWrite 는 128 이상이면 켜짐, 아니면 꺼짐으로만 동작합니다. PWM 핀: 3, 5, 6, 9, 10, 11`); p.out = v > 127 ? 1 : 0; p.pwm = null; } else if (v === 0 || v === 255) { p.out = v ? 1 : 0; p.pwm = null; } else p.pwm = v;
      touch();
    },
    analogReference() {},
    delay,
    async delayMicroseconds(us) { if (us >= 1000) await delay(us / 1000); else { r.c += 20; if (r.c > 400) await r.brk(); } },
    yield: () => delay(0),
    millis: () => Math.floor(performance.now() - t0) >>> 0,
    micros: () => Math.floor((performance.now() - t0) * 1000) >>> 0,
    map: (x, a, b, c, d) => (b === a ? c : Math.trunc(((x - a) * (d - c)) / (b - a) + c)),
    constrain: (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x),
    min: Math.min, max: Math.max, abs: Math.abs, sq: (x) => x * x, sqrt: Math.sqrt, pow: Math.pow,
    sin: Math.sin, cos: Math.cos, tan: Math.tan, atan: Math.atan, atan2: Math.atan2, asin: Math.asin, acos: Math.acos, exp: Math.exp, log: Math.log, log10: Math.log10,
    floor: Math.floor, ceil: Math.ceil, round: (x) => Math.sign(x) * Math.round(Math.abs(x)), fabs: Math.abs, fmod: (a, b) => a % b,
    radians: (d) => (d * Math.PI) / 180, degrees: (x) => (x * 180) / Math.PI, isnan: (x) => Number.isNaN(x), isinf: (x) => x === Infinity || x === -Infinity,
    random(a, b) { const lo = b === undefined ? 0 : Math.trunc(a); const hi = Math.trunc(b === undefined ? a : b); return hi <= lo ? lo : lo + Math.floor(Math.random() * (hi - lo)); },
    randomSeed() {},
    tone(pin, freq, dur) { const p = checkPin(pin, 'tone'); p.used = true; p.mode = OUTPUT; p.tone = Math.max(0, Number(freq) || 0); p.pwm = null; touch(); if (dur) timers.push(setTimeout(() => { if (p.tone === freq) { p.tone = 0; touch(); } }, dur)); },
    noTone(pin) { const p = checkPin(pin, 'noTone'); p.tone = 0; touch(); },
    async pulseIn(pin, state, timeout) {
      checkPin(pin, 'pulseIn');
      const now = performance.now();
      const part = locate('hcsr04', `초음파 센서(HC-SR04) – ECHO 를 ${pinLabel(pin)} 에`, `ECHO → ${pinLabel(pin)}, TRIG → 디지털 핀`, (p) => p.pins.ECHO !== undefined && p.pins.ECHO === node(pin));
      const trig = part && pins.some((p, i) => node(i) === part.pins.TRIG && now - p.fall < 100);
      if (part && !trig) hint('초음파 센서: TRIG 핀에 HIGH → (10마이크로초) → LOW 신호를 준 직후에 pulseIn 을 불러야 합니다.');
      const d = Number(part?.props?.dist);
      if (!part || !trig || !(d >= 2 && d <= 400)) { await delay(Math.min(30, (timeout || 1e6) / 1000)); return 0; }
      const us = d * 58.2 * (1 + noise(0.004));
      await delay(us / 1000);
      return Math.round(us);
    },
    shiftOut() {}, shiftIn: () => 0,
    attachInterrupt(num, fn, mode) { if (num !== 0 && num !== 1) { hint('attachInterrupt: 우노/나노/미니에서는 D2(인터럽트 0), D3(인터럽트 1) 만 쓸 수 있습니다.'); return; } interrupts[num] = { fn, mode, last: null }; changed = true; },
    detachInterrupt(num) { delete interrupts[num]; },
    digitalPinToInterrupt: (pin) => (pin === 2 ? 0 : pin === 3 ? 1 : -1),
    interrupts() {}, noInterrupts() {},
    bitRead: (x, n) => (x >> n) & 1, bit: (n) => 1 << n, lowByte: (x) => x & 255, highByte: (x) => (x >> 8) & 255,
    F: (s) => s,
    isDigit: (c) => c >= 48 && c <= 57, isdigit: (c) => c >= 48 && c <= 57,
    isAlpha: (c) => /[A-Za-z]/.test(String.fromCharCode(c)), isalpha: (c) => /[A-Za-z]/.test(String.fromCharCode(c)),
    isAlphaNumeric: (c) => /[A-Za-z0-9]/.test(String.fromCharCode(c)), isalnum: (c) => /[A-Za-z0-9]/.test(String.fromCharCode(c)),
    isSpace: (c) => /\s/.test(String.fromCharCode(c)), isspace: (c) => /\s/.test(String.fromCharCode(c)), isWhitespace: (c) => c === 32 || c === 9,
    isUpperCase: (c) => c >= 65 && c <= 90, isLowerCase: (c) => c >= 97 && c <= 122, isPunct: (c) => /[!-/:-@[-`{-~]/.test(String.fromCharCode(c)),
    toupper: (c) => (c >= 97 && c <= 122 ? c - 32 : c), tolower: (c) => (c >= 65 && c <= 90 ? c + 32 : c),
    strlen: (s) => cs(s).length,
    strcpy: (d, s) => cw(d, cs(s)), strncpy: (d, s, n) => cw(d, cs(s).slice(0, n)), strcat: (d, s) => cw(d, cs(d) + cs(s)),
    strcmp: (a, b) => (cs(a) < cs(b) ? -1 : cs(a) > cs(b) ? 1 : 0), strncmp: (a, b, n) => { const x = cs(a).slice(0, n); const y = cs(b).slice(0, n); return x < y ? -1 : x > y ? 1 : 0; },
    atoi: toInt, atol: toInt, atof: toFloat,
    itoa: (v, buf, base) => cw(buf, Math.trunc(v).toString(base || 10)), ltoa: (v, buf, base) => cw(buf, Math.trunc(v).toString(base || 10)),
    utoa: (v, buf, base) => cw(buf, (Math.trunc(v) >>> 0).toString(base || 10)), ultoa: (v, buf, base) => cw(buf, (Math.trunc(v) >>> 0).toString(base || 10)),
    dtostrf: (v, width, prec, buf) => { const s = Number(v).toFixed(prec); return cw(buf, width < 0 ? s.padEnd(-width) : s.padStart(width)); },
    sprintf: (buf, fmt, ...args) => { const s = sprintf(cs(fmt), args); cw(buf, s); return s.length; },
    snprintf: (buf, n, fmt, ...args) => { const s = sprintf(cs(fmt), args); cw(buf, s, n - 1); return s.length; },
    memset: (buf, v, n) => { for (let i = 0; i < Math.min(n, buf.length); i++) buf[i] = v; },
  });

  // ───────── I2C (Wire) ─────────
  const mpuRaw = (p) => {
    const pr = p.props || {};
    const s16 = (v) => clamp(Math.round(v), -32768, 32767);
    return {
      a: ['ax', 'ay', 'az'].map((k) => s16((Number(pr[k]) || 0) * 16384 + noise(30))),
      g: ['gx', 'gy', 'gz'].map((k) => s16((Number(pr[k]) || 0) * 131 + noise(4))),
      t: s16(((Number(pr.temp) || 25) - 36.53) * 340),
    };
  };
  const i2cDevices = () => {
    const ok = (p) => p.pins.SDA !== undefined && p.pins.SDA === node(18) && p.pins.SCL !== undefined && p.pins.SCL === node(19) && powered(p);
    const out = new Map();
    for (const p of net.parts) {
      if (!ok(p)) continue;
      if (p.type === 'mpu6050') {
        out.set(0x68, { read(reg) {
          if (reg === 0x75) return 0x68;
          if (reg < 0x3B || reg > 0x48) return 0;
          const m = mpuRaw(p);
          const words = [...m.a, m.t, ...m.g];
          const w = words[(reg - 0x3B) >> 1] & 0xFFFF;
          return (reg - 0x3B) & 1 ? w & 255 : w >> 8;
        } });
      } else if (p.type === 'bmp280') out.set(0x76, { read: (reg) => (reg === 0xD0 ? 0x58 : 0) });
      else if (p.type === 'lcd') out.set(0x27, { read: () => 0 });
    }
    return out;
  };
  const Wire = {
    _addr: 0, _tx: [], _rx: [], _reg: 0,
    begin() {}, setClock() {}, end() {},
    beginTransmission(addr) { this._addr = addr; this._tx = []; },
    write(b) { this._tx.push(b & 255); return 1; },
    endTransmission() {
      const dev = i2cDevices().get(this._addr);
      if (!dev) return 2;
      if (this._tx.length) this._reg = this._tx[0];
      return 0;
    },
    requestFrom(addr, n) {
      const dev = i2cDevices().get(addr);
      this._rx = [];
      if (!dev) { hint(`Wire: I2C 주소 0x${Number(addr).toString(16)} 에서 응답이 없습니다. 센서의 SDA → A4, SCL → A5, 전원 연결을 확인하세요.`); return 0; }
      for (let k = 0; k < n; k++) this._rx.push(dev.read(this._reg + k));
      this._reg += n;
      return n;
    },
    available() { return this._rx.length; },
    read() { return this._rx.length ? this._rx.shift() : -1; },
  };
  g.Wire = Wire;

  // ───────── 센서 라이브러리 ─────────
  const pressurePa = (p) => (Number(p.props.sea) || 1013.25) * 100 * (1 - (Number(p.props.alt) || 0) / 44330) ** 5.255;
  class Bmp {
    _p() { return i2c('bmp280', '기압·고도 센서(BMP280)'); }
    begin() { return !!this._p(); }
    setSampling() {}
    sensorID() { return 0x58; }
    readTemperature() { const p = this._p(); return p ? Number(p.props.temp) + noise(0.02) : NaN; }
    readPressure() { const p = this._p(); return p ? pressurePa(p) + noise(2) : NaN; }
    readAltitude(sea = 1013.25) { const p = this._p(); return p ? 44330 * (1 - ((pressurePa(p) + noise(2)) / 100 / sea) ** 0.1903) : NaN; }
    readHumidity() { return this._p() ? 45 + noise(0.2) : NaN; }
    seaLevelForAltitude(alt, atm) { return atm / (1 - alt / 44330) ** 5.255; }
  }
  class Bmp085 extends Bmp {
    readAltitude(seaPa = 101325) { return super.readAltitude(seaPa / 100); }
    readSealevelPressure(alt = 0) { const p = this._p(); return p ? Math.round(pressurePa(p) / (1 - alt / 44330) ** 5.255) : 0; }
  }
  class SensorsEvent { constructor() { this.acceleration = { x: 0, y: 0, z: 0 }; this.gyro = { x: 0, y: 0, z: 0 }; this.temperature = 0; this.relative_humidity = 0; this.pressure = 0; } }
  const mpuPart = () => i2c('mpu6050', '가속도·자이로 센서(MPU6050)');
  const put = (ref, v) => { if (ref && typeof ref === 'object') ref.v = v; };
  class Mpu {
    initialize() { mpuPart(); }
    begin() { return !!mpuPart(); }
    testConnection() { return !!mpuPart(); }
    getMotion6(ax, ay, az, gx, gy, gz) { const p = mpuPart(); const m = p ? mpuRaw(p) : { a: [0, 0, 0], g: [0, 0, 0] }; [ax, ay, az].forEach((x, k) => put(x, m.a[k])); [gx, gy, gz].forEach((x, k) => put(x, m.g[k])); }
    getAcceleration(ax, ay, az) { this.getMotion6(ax, ay, az); }
    getRotation(gx, gy, gz) { this.getMotion6(null, null, null, gx, gy, gz); }
    _one(kind, k) { const p = mpuPart(); return p ? mpuRaw(p)[kind][k] : 0; }
    getAccelerationX() { return this._one('a', 0); } getAccelerationY() { return this._one('a', 1); } getAccelerationZ() { return this._one('a', 2); }
    getRotationX() { return this._one('g', 0); } getRotationY() { return this._one('g', 1); } getRotationZ() { return this._one('g', 2); }
    getTemperature() { const p = mpuPart(); return p ? mpuRaw(p).t : 0; }
    getEvent(a, gy, t) {
      const p = mpuPart();
      if (!p) return false;
      const pr = p.props;
      if (a) a.acceleration = { x: pr.ax * 9.80665 + noise(0.02), y: pr.ay * 9.80665 + noise(0.02), z: pr.az * 9.80665 + noise(0.02) };
      if (gy) gy.gyro = { x: (pr.gx * Math.PI) / 180 + noise(0.002), y: (pr.gy * Math.PI) / 180 + noise(0.002), z: (pr.gz * Math.PI) / 180 + noise(0.002) };
      if (t) t.temperature = Number(pr.temp) + noise(0.05);
      return true;
    }
  }
  // 설정 함수들은 값을 받기만 함
  for (const k of ['setAccelerometerRange', 'setGyroRange', 'setFilterBandwidth', 'setFullScaleAccelRange', 'setFullScaleGyroRange', 'setDLPFMode', 'setSleepEnabled', 'setClockSource', 'CalibrateAccel', 'CalibrateGyro', 'setXAccelOffset', 'setYAccelOffset', 'setZAccelOffset', 'setXGyroOffset', 'setYGyroOffset', 'setZGyroOffset', 'setMotionDetectionThreshold', 'setInterruptPinLatch']) Mpu.prototype[k] = function () {};

  class DHT {
    constructor(pin, type) { this.pin = pin; this.type = type; }
    begin() {}
    _p() { return locate('dht', `온습도 센서(DHT) – DATA 를 ${pinLabel(this.pin)} 에`, `DATA → ${pinLabel(this.pin)}`, (p) => p.pins.DATA !== undefined && p.pins.DATA === node(this.pin)); }
    read() { return !!this._p(); }
    readTemperature(isF) { const p = this._p(); if (!p) return NaN; const fine = this.type !== 11; const t = fine ? Math.round((Number(p.props.temp) + noise(0.1)) * 10) / 10 : Math.round(Number(p.props.temp)); return isF ? (t * 9) / 5 + 32 : t; }
    readHumidity() { const p = this._p(); if (!p) return NaN; return this.type !== 11 ? Math.round((Number(p.props.hum) + noise(0.2)) * 10) / 10 : Math.round(Number(p.props.hum)); }
    convertCtoF(c) { return (c * 9) / 5 + 32; }
    convertFtoC(f) { return ((f - 32) * 5) / 9; }
    computeHeatIndex(t, h, isF = true) {
      const T = isF ? t : (t * 9) / 5 + 32;
      let hi = 0.5 * (T + 61 + (T - 68) * 1.2 + h * 0.094);
      if (hi > 79) hi = -42.379 + 2.04901523 * T + 10.14333127 * h - 0.22475541 * T * h - 0.00683783 * T * T - 0.05481717 * h * h + 0.00122874 * T * T * h + 0.00085282 * T * h * h - 0.00000199 * T * T * h * h;
      return isF ? hi : ((hi - 32) * 5) / 9;
    }
  }

  class HX711 {
    constructor(dt, sck) { this.dt = dt; this.sck = sck; this.OFFSET = 0; this.SCALE = 1; }
    begin(dt, sck) { this.dt = dt; this.sck = sck; }
    _p() { return locate('hx711', '로드셀(HX711)', `DT → ${this.dt === undefined ? '?' : pinLabel(this.dt)}, SCK → ${this.sck === undefined ? '?' : pinLabel(this.sck)}`, (p) => p.pins.DT !== undefined && p.pins.DT === node(this.dt) && p.pins.SCK !== undefined && p.pins.SCK === node(this.sck)); }
    is_ready() { return !!this._p(); }
    // 실제 라이브러리는 HX711 이 "준비됨" 신호를 줄 때까지 기다림 → 연결이 틀리면 스케치가 그 자리에서 멈춤
    async wait_ready() { while (!this._p()) { hint('로드셀(HX711): 응답이 없어 스케치가 read() 에서 기다리고 있습니다 (실제 보드도 여기서 멈춥니다).'); await delay(100); } }
    async wait_ready_timeout(ms = 1000) { const until = performance.now() + ms; while (!this._p()) { if (performance.now() >= until) return false; await delay(20); } return true; }
    async wait_ready_retry(n = 3, ms = 0) { for (let i = 0; i < n; i++) { if (this._p()) return true; await delay(Math.max(ms, 10)); } return false; }
    set_gain() {}
    async read() { await this.wait_ready(); const p = this._p(); return p ? Math.round(84210 + (Number(p.props.weight) || 0) * 430 + noise(25)) : 0; }
    async read_average(n = 10) { let s = 0; const k = Math.max(1, n | 0); for (let i = 0; i < k; i++) s += await this.read(); return Math.round(s / k); }
    async get_value(n = 1) { return (await this.read_average(n)) - this.OFFSET; }
    async get_units(n = 1) { return (await this.get_value(n)) / this.SCALE; }
    async tare(n = 10) { this.OFFSET = await this.read_average(n); }
    set_scale(s = 1) { this.SCALE = s || 1; }
    get_scale() { return this.SCALE; }
    set_offset(o = 0) { this.OFFSET = o; }
    get_offset() { return this.OFFSET; }
    power_down() {} power_up() {}
  }

  // GPS: NMEA 문장을 실제로 읽어 해석
  class GpsField { constructor() { this.valid = false; this.updated = false; this.at = 0; this.val = 0; } set(v) { this.val = v; this.valid = true; this.updated = true; this.at = performance.now(); } isValid() { return this.valid; } isUpdated() { return this.updated; } age() { return this.valid ? Math.round(performance.now() - this.at) : 4294967295; } get() { this.updated = false; return this.val; } }
  class TinyGPSPlus {
    constructor() {
      this._line = ''; this._chars = 0; this._fix = 0; this._bad = 0; this._good = 0;
      const f = () => new GpsField();
      const loc = f(); loc.lat = () => loc.get().lat; loc.lng = () => loc.get().lng; loc.val = { lat: 0, lng: 0 };
      const alt = f(); alt.meters = () => alt.get(); alt.feet = () => alt.get() * 3.28084; alt.kilometers = () => alt.get() / 1000; alt.value = () => Math.round(alt.get() * 100);
      const spd = f(); spd.knots = () => spd.get(); spd.kmph = () => spd.get() * 1.852; spd.mps = () => spd.get() * 0.514444; spd.mph = () => spd.get() * 1.15078; spd.value = () => Math.round(spd.get() * 100);
      const crs = f(); crs.deg = () => crs.get(); crs.value = () => Math.round(crs.get() * 100);
      const sat = f(); sat.value = () => sat.get();
      const hd = f(); hd.value = () => Math.round(hd.get() * 100); hd.hdop = () => hd.get();
      const date = f(); date.val = { y: 2000, m: 0, d: 0 }; date.year = () => date.get().y; date.month = () => date.get().m; date.day = () => date.get().d; date.value = () => { const v = date.get(); return v.d * 10000 + v.m * 100 + (v.y % 100); };
      const time = f(); time.val = { h: 0, m: 0, s: 0 }; time.hour = () => time.get().h; time.minute = () => time.get().m; time.second = () => time.get().s; time.centisecond = () => 0; time.value = () => { const v = time.get(); return v.h * 1000000 + v.m * 10000 + v.s * 100; };
      Object.assign(this, { location: loc, altitude: alt, speed: spd, course: crs, satellites: sat, hdop: hd, date, time });
    }
    charsProcessed() { return this._chars; }
    sentencesWithFix() { return this._fix; }
    failedChecksum() { return this._bad; }
    passedChecksum() { return this._good; }
    encode(c) {
      const ch = typeof c === 'number' ? String.fromCharCode(c & 255) : cs(c);
      this._chars++;
      if (ch === '$') { this._line = '$'; return false; }
      if (ch !== '\n' && ch !== '\r') { if (this._line.length < 120) this._line += ch; return false; }
      const line = this._line;
      this._line = '';
      const m = /^\$(..)(GGA|RMC),(.*)\*([0-9A-Fa-f]{2})$/.exec(line);
      if (!m) return false;
      let sum = 0;
      for (const x of line.slice(1, line.lastIndexOf('*'))) sum ^= x.charCodeAt(0);
      if (sum !== parseInt(m[4], 16)) { this._bad++; return false; }
      this._good++;
      const p = m[3].split(',');
      const deg = (v, hemi) => { if (!v) return null; const d = Math.floor(Number(v) / 100); const x = d + (Number(v) - d * 100) / 60; return hemi === 'S' || hemi === 'W' ? -x : x; };
      const hms = (v) => { if (v && v.length >= 6) this.time.set({ h: Number(v.slice(0, 2)), m: Number(v.slice(2, 4)), s: Number(v.slice(4, 6)) }); };
      if (m[2] === 'GGA') {
        hms(p[0]);
        if (p[5] !== '0' && p[1]) { this.location.set({ lat: deg(p[1], p[2]), lng: deg(p[3], p[4]) }); this.altitude.set(Number(p[8])); this._fix++; }
        if (p[6]) this.satellites.set(Number(p[6]));
        if (p[7]) this.hdop.set(Number(p[7]));
      } else {
        hms(p[0]);
        if (p[1] === 'A') { this.location.set({ lat: deg(p[2], p[3]), lng: deg(p[4], p[5]) }); this.speed.set(Number(p[6]) || 0); this.course.set(Number(p[7]) || 0); this._fix++; }
        if (p[8] && p[8].length === 6) this.date.set({ d: Number(p[8].slice(0, 2)), m: Number(p[8].slice(2, 4)), y: 2000 + Number(p[8].slice(4, 6)) });
      }
      return true;
    }
    static distanceBetween(lat1, lng1, lat2, lng2) {
      const R = 6372795; const rad = Math.PI / 180;
      const dphi = (lat2 - lat1) * rad; const dl = (lng2 - lng1) * rad;
      const a = Math.sin(dphi / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dl / 2) ** 2;
      return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    }
    static courseTo(lat1, lng1, lat2, lng2) {
      const rad = Math.PI / 180; const dl = (lng2 - lng1) * rad;
      const y = Math.sin(dl) * Math.cos(lat2 * rad);
      const x = Math.cos(lat1 * rad) * Math.sin(lat2 * rad) - Math.sin(lat1 * rad) * Math.cos(lat2 * rad) * Math.cos(dl);
      return ((Math.atan2(y, x) / rad) + 360) % 360;
    }
  }
  function nmea(p) {
    const pr = p.props;
    const d = new Date();
    const two = (v) => String(v).padStart(2, '0');
    const time = `${two(d.getUTCHours())}${two(d.getUTCMinutes())}${two(d.getUTCSeconds())}.00`;
    const date = `${two(d.getUTCDate())}${two(d.getUTCMonth() + 1)}${two(d.getUTCFullYear() % 100)}`;
    const coord = (v, w) => { const a = Math.abs(v); const deg = Math.floor(a); return `${String(deg).padStart(w, '0')}${((a - deg) * 60).toFixed(4).padStart(7, '0')}`; };
    const sum = (s) => { let c = 0; for (const x of s) c ^= x.charCodeAt(0); return `$${s}*${c.toString(16).toUpperCase().padStart(2, '0')}\r\n`; };
    const fix = pr.fix !== false && pr.fix !== 0;
    const lat = Number(pr.lat) + noise(0.000004); const lng = Number(pr.lng) + noise(0.000004);
    const pos = fix ? `${coord(lat, 2)},${lat >= 0 ? 'N' : 'S'},${coord(lng, 3)},${lng >= 0 ? 'E' : 'W'}` : ',,,';
    return sum(`GPGGA,${time},${pos},${fix ? 1 : 0},${two(fix ? Math.round(Number(pr.sats) || 8) : 0)},${fix ? '0.9' : '99.9'},${fix ? (Number(pr.alt) || 0).toFixed(1) : ''},M,0.0,M,,`)
      + sum(`GPRMC,${time},${fix ? 'A' : 'V'},${pos},${fix ? ((Number(pr.speed) || 0) / 1.852).toFixed(2) : ''},${fix ? (Number(pr.course) || 0).toFixed(1) : ''},${date},,,${fix ? 'A' : 'N'}`);
  }
  function gpsTick() {
    for (const p of net.parts) {
      if (p.type !== 'gps' || p.pins.TX === undefined || !powered(p)) continue;
      const text = nmea(p);
      const garble = (t) => Array.from(t, (ch, i) => String.fromCharCode(((ch.charCodeAt(0) * 7 + i * 13) % 96) + 128)).join('').slice(0, 60);
      for (const s of softSerials) if (s.on && node(s.rxPin) === p.pins.TX) s.feed(s.baud === 9600 ? text : garble(text)); // 속도가 다르면 깨진 글자만 들어옴
      if (Serial.on && node(0) === p.pins.TX) Serial.feed(Serial.baud === 9600 ? text : garble(text));
    }
  }

  class Servo {
    constructor() { this.pin = -1; this.angle = 90; servoObjs.push(this); }
    _show() { changed = true; locate('servo', '서보 모터', `신호(SIG) → ${pinLabel(this.pin)}`, (p) => p.pins.SIG !== undefined && p.pins.SIG === node(this.pin)); }
    attach(pin) { checkPin(pin, 'Servo.attach'); this.pin = pin; pins[pin].used = true; pins[pin].mode = OUTPUT; touch(); return 1; }
    detach() { this.pin = -1; }
    attached() { return this.pin >= 0; }
    write(a) { if (this.pin < 0) { hint('Servo: write() 전에 attach(핀) 을 먼저 부르세요.'); return; } this.angle = clamp(Math.round(a), 0, 180); this._show(); }
    writeMicroseconds(us) { this.write(((us - 544) * 180) / (2400 - 544)); }
    read() { return this.angle; }
  }

  class LiquidCrystalI2C {
    constructor(addr, cols = 16, rows = 2) { this.cols = cols; this.rows = rows; this.x = 0; this.y = 0; this.light = true; this.lines = Array.from({ length: rows }, () => ' '.repeat(cols)); }
    _show() { changed = true; if (!lcdObjs.includes(this)) lcdObjs.push(this); this.shown = !!i2c('lcd', 'LCD(I2C)'); }
    init() { this._show(); } begin() { this._show(); }
    backlight() { this.light = true; this._show(); } noBacklight() { this.light = false; this._show(); }
    clear() { this.lines = this.lines.map(() => ' '.repeat(this.cols)); this.x = 0; this.y = 0; this._show(); }
    home() { this.x = 0; this.y = 0; }
    setCursor(c, row) { this.x = clamp(c | 0, 0, this.cols); this.y = clamp(row | 0, 0, this.rows - 1); }
    _put(text) { for (const ch of text) { if (this.x >= this.cols) break; const l = this.lines[this.y]; this.lines[this.y] = l.slice(0, this.x) + ch + l.slice(this.x + 1); this.x++; } this._show(); return text.length; }
    print(v, f, t) { return this._put(fmtPrint(v, f, t)); }
    write(v) { return this._put(typeof v === 'number' ? String.fromCharCode(v) : cs(v)); }
  }
  for (const k of ['display', 'noDisplay', 'cursor', 'noCursor', 'blink', 'noBlink', 'createChar', 'scrollDisplayLeft', 'scrollDisplayRight', 'autoscroll', 'noAutoscroll', 'leftToRight', 'rightToLeft']) LiquidCrystalI2C.prototype[k] = function () {};

  const L = {
    DHT, Adafruit_BMP280: Bmp, Adafruit_BME280: Bmp, Adafruit_BMP085: Bmp085, MPU6050: Mpu, Adafruit_MPU6050: Mpu, sensors_event_t: SensorsEvent,
    TinyGPSPlus, SoftwareSerial, HX711, Servo, LiquidCrystal_I2C: LiquidCrystalI2C,
  };

  // ───────── 화면에 상태 알리기 ─────────
  function snapshot() {
    ensure();
    const out = { pins: {}, parts: {}, warn: [] };
    pins.forEach((p, i) => { if (p.used) out.pins[pinName(i)] = { m: p.mode, v: p.mode === OUTPUT ? (p.tone ? 2 : p.pwm != null ? Math.round((p.pwm / 255) * 100) / 100 : p.out) : (voltAt(node(i)) ?? -1) >= 2.5 ? 1 : 0 }; });
    if (net.short) out.warn.push('합선(쇼트): 5V(또는 3.3V)와 GND 가 저항 없이 직접 이어져 있습니다. 실제 보드라면 고장 날 수 있습니다.');
    for (const part of net.parts) {
      if (part.type === 'led') {
        const mA = leds.get(part.id) || 0;
        out.parts[part.id] = burnt.has(part.id) ? { i: 0, x: 1 } : { i: Math.round(mA * 10) / 10 };
        if (burnt.has(part.id)) out.warn.push('LED 가 과전류로 타 버렸습니다. 220Ω 정도의 저항을 직렬로 연결한 뒤 다시 실행하세요 (다시 실행하면 새 LED 로 바뀝니다).');
        else if (mA > 30) out.warn.push(`LED 에 전류가 너무 많이 흐릅니다 (${mA.toFixed(0)}mA). 이대로 두면 곧 탑니다. 220Ω 정도의 저항을 LED 와 직렬로 연결하세요.`);
      } else if (part.type === 'buzzer') {
        const a = voltAt(part.pins['+']); const b = voltAt(part.pins['-']);
        let f = 0;
        if (a !== null && b !== null && Math.abs(a - b) > 0.5) {
          const tp = pins.find((p, i) => p.tone && p.mode === OUTPUT && (node(i) === part.pins['+'] || node(i) === part.pins['-']));
          f = tp ? Math.round(tp.tone) : Math.abs(a - b) > 2 ? 2300 : 0;
        }
        out.parts[part.id] = { f };
      } else if (part.type === 'servo') {
        // 전원과 신호선이 지금 이어져 있을 때만 움직임 (빠지면 마지막 각도에서 멈춤)
        const sv = powered(part) ? servoObjs.find((o) => o.pin >= 0 && part.pins.SIG !== undefined && node(o.pin) === part.pins.SIG) : null;
        if (sv) pstate.set(part.id, { a: sv.angle });
        if (pstate.has(part.id)) out.parts[part.id] = pstate.get(part.id);
      } else if (part.type === 'lcd') {
        // 전원이 없으면 화면이 꺼지고, 전원만 있고 신호선(SDA · SCL)이 틀리면 빈 화면만 켜짐
        const bus = part.pins.SDA !== undefined && part.pins.SDA === node(18) && part.pins.SCL !== undefined && part.pins.SCL === node(19);
        const obj = lcdObjs[0];
        if (powered(part)) out.parts[part.id] = bus && obj && obj.shown ? { l: obj.lines.slice(), b: obj.light ? 1 : 0 } : { l: [], b: 1 };
      }
    }
    return out;
  }
  function report() {
    burnCheck();
    if (!changed) return;
    changed = false;
    const snap = snapshot();
    const text = JSON.stringify(snap);
    if (text !== lastReport) { lastReport = text; post({ type: 'state', state: snap }); }
  }
  /** 외부 입력(버튼 등)이 바뀐 뒤: 인터럽트 확인 */
  function poke() {
    for (const [num, it] of Object.entries(interrupts)) {
      const v = voltAt(node(Number(num) + 2));
      const level = v === null ? it.last : v >= 2.5 ? 1 : 0;
      if (it.last !== null && level !== it.last && (it.mode === 1 || (it.mode === 3 && level === 1) || (it.mode === 2 && level === 0) || (it.mode === 0 && level === 0))) {
        Promise.resolve().then(() => it.fn()).catch((e) => { if (!(e instanceof StopSignal)) fail(e); });
      }
      it.last = level;
    }
  }

  function fail(e) {
    if (stopped) return;
    stopped = true;
    let message = e?.message || String(e);
    if (e instanceof RangeError && /call stack/i.test(message)) message = '함수가 자기 자신을 끝없이 부르고 있습니다 (재귀가 너무 깊음).';
    else if (e instanceof TypeError && /undefined|null|not a function|not iterable/i.test(message)) message = `값이 없는 것을 사용했습니다 — 배열 범위를 벗어났거나, 라이브러리에 없는 함수를 불렀을 수 있습니다. (${message})`;
    flushTx();
    post({ type: 'error', message, line: r.ln });
  }

  return {
    setNet(next) {
      net = next;
      partById.clear();
      for (const p of net.parts) partById.set(p.id, p);
      for (const id of [...pstate.keys()]) if (!partById.has(id)) pstate.delete(id);
      touch();
      solve();
      poke();
      if (net.short) fail(new Error('합선(쇼트): 5V(또는 3.3V)와 GND 가 저항 없이 직접 이어져 보드의 전원이 꺼졌습니다. 그 전선을 없앤 뒤 다시 실행하세요.'));
    },
    setProp(id, key, value) { const p = partById.get(id); if (!p) return; p.props[key] = value; touch(); solve(); poke(); },
    serialIn(text) { Serial.feed(String(text)); },
    report,
    snapshot,
    stop() { stopped = true; timers.forEach(clearTimeout); flushTx(); },
    /** 변환된 스케치를 실행 (setup 한 번 → loop 반복). 멈추거나 오류가 나면 끝남 */
    async run(js) {
      if (stopped) return; // 시작하기도 전에 합선으로 꺼짐
      const tick = setInterval(report, 50);
      const gps = setInterval(gpsTick, 1000);
      timers.push(tick, gps);
      try {
        const prog = await new Function('R', `return (async()=>{${js}\n})()`)({ __r: r, __g: g, __L: L, __S: S }); // eslint-disable-line no-new-func
        Object.values(interrupts).forEach((it) => { it.last = null; });
        post({ type: 'started' });
        await prog.setup();
        poke();
        while (!stopped) { await prog.loop(); r.c += 40; if (r.c > 400) await r.brk(); }
      } catch (e) {
        if (!(e instanceof StopSignal)) fail(e);
      } finally {
        clearInterval(tick); clearInterval(gps);
        flushTx();
        report();
      }
    },
  };
}
