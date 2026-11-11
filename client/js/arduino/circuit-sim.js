// 회로 계산 (노드 해석법): 저항 · 버튼 · 가변저항 · 조도 센서 · LED 로 이루어진 회로의 각 노드 전압과 LED 전류를 구합니다.
// 간이 변환기 런타임(runtime.js)과 실제 기계어 에뮬레이터(avr-runtime.js)가 함께 씁니다.
export const INPUT = 0; export const OUTPUT = 1; export const INPUT_PULLUP = 2;
export const LED_VF = { red: 1.8, yellow: 2.0, green: 2.1, blue: 3.0, white: 3.0 };
export const LED_RS = 12; // 켜진 LED 의 내부 저항(Ω)
export const LED_BURN_MA = 45; // 이보다 큰 전류가 계속 흐르면 LED 가 탐
export const NEEDS_5V = new Set(['hcsr04', 'servo', 'lcd', 'lcd16', 'neopixel', 'stepper', 'max7219']); // 3.3V 로는 동작하지 않는 부품
export const pinName = (n) => (n < 14 ? `D${n}` : `A${n - 14}`);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

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
 * @param net   넷리스트 { n, pins: { D13: 노드 }, parts }
 * @param pins  아두이노 핀 22개의 상태 [{ mode, out, pwm(0~255 | null), tone(Hz) }]
 * @param burnt 타 버린 LED 의 id (Set)
 * @returns {{ V: Float64Array, floating: boolean[], leds: Map<string, number> }}  노드 전압 · 떠 있는 노드 · LED 전류(mA)
 */
export function solveCircuit(net, pins, burnt) {
  let V; let floating; let leds;
  const node = (pin) => net.pins[pinName(pin)];
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
      default:
        if (P.VCC !== undefined && P.GND !== undefined) edge('VCC', 'GND', 5000); // 모듈이 쓰는 약한 전류
        if (part.type === 'dht') edge('DATA', 'VCC', 10000); // 모듈에 달린 풀업 저항
        if (part.type === 'tm1637') { edge('CLK', 'VCC', 10000); edge('DIO', 'VCC', 10000); }
        if (part.type === 'keypad' && Number.isInteger(pr.key) && pr.key >= 0 && pr.key < 16) edge(`R${(pr.key >> 2) + 1}`, `C${(pr.key & 3) + 1}`, 30); // 누른 키가 줄과 칸을 이음
        if (part.type === 'encoder') {
          edge('CLK', 'VCC', 10000); edge('DT', 'VCC', 10000);
          const ph = Number(pr.phase) || 0; // 시계 방향으로 돌리면 0 → 1 → 2 → 3: DT 가 먼저 닫히고 CLK 가 따라옴 (Encoder(CLK, DT) 가 + 로 셈)
          if (ph === 2 || ph === 3) edge('CLK', 'GND', 1);
          if (ph === 1 || ph === 2) edge('DT', 'GND', 1);
          if (pr.pressed) edge('SW', 'GND', 1);
        }
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
  return { V, floating, leds };
}
