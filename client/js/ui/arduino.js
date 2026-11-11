// 아두이노 창: 위쪽은 "아두이노 연결"(보드 · 빵판 · 부품 · 전선을 놓는 회로 편집기), 아래쪽은 출력(시리얼 모니터).
// 스케치는 compiler.js 가 JS 로 바꾸고, Worker(runtime.js)가 회로 연결 상태에 따라 실행합니다.
import { h, toast, debounce } from '../util.js';
import { icon } from './icons.js';
import { openMenu } from './common.js';
import { compileSketch } from '../arduino/compiler.js';
import {
  BOARDS, PART_DEFS, WIRE_COLORS, PITCH, BB, PWM, bbHoles, holeNear, pinsOf, boardPins, terminalPos, snapPart, buildNetlist, newId, emptyCircuit, parseCircuit,
} from '../arduino/parts.js';

const NS = 'http://www.w3.org/2000/svg';
function s(tag, attrs, ...kids) {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs || {})) if (v !== null && v !== undefined && v !== false) el.setAttribute(k, String(v));
  for (const kid of kids.flat()) if (kid) el.append(kid);
  return el;
}
const LED_COLORS = { red: '#ff3b30', green: '#30d158', yellow: '#ffd60a', blue: '#3b82f6', white: '#f5f5f5' };
const KNOWN_HEADERS = /^(Arduino|DHT|DHT_U|Adafruit_Sensor|Wire|SPI|SoftwareSerial|TinyGPS\+\+|TinyGPSPlus|HX711|MPU6050|I2Cdev|Adafruit_MPU6050|Adafruit_BMP280|Adafruit_BMP085|Adafruit_BME280|Servo|LiquidCrystal_I2C|math|string|stdio|stdlib|avr\/pgmspace)\.h$/i;
const fmtOhm = (v) => (v >= 1e6 ? `${v / 1e6}MΩ` : v >= 1000 ? `${v / 1000}kΩ` : `${v}Ω`);
const BAND = ['#111', '#7a4a1f', '#e53935', '#fb8c00', '#fdd835', '#43a047', '#1e88e5', '#8e24aa', '#9e9e9e', '#fafafa'];

/** 부품의 클릭 영역 (첫 핀 기준 [x0, y0, x1, y1]) */
function bboxOf(part) {
  const def = PART_DEFS[part.type];
  if (part.type === 'breadboard') return [0, 0, BB.w, BB.h];
  if (part.type === 'resistor') return [4, -7, 36, 7];
  if (part.type === 'led') return [-5, -32, 15, -4];
  if (part.type === 'button') return [-4, -20, 24, -3];
  if (part.type === 'pot') return [-5, -34, 25, -4];
  if (part.type === 'ldr') return [-5, -26, 15, -4];
  if (part.type === 'buzzer') return [-9, -32, 19, -4];
  const n = def.pins.length;
  const cx = ((n - 1) * PITCH) / 2;
  const w = part.type === 'lcd' ? 112 : Math.max(52, (n - 1) * PITCH + 22);
  return [cx - w / 2, part.type === 'lcd' ? -72 : -60, cx + w / 2, -6];
}

/**
 * @param {object} host { canEdit, onGoto(line), saveCircuit(text) }
 */
export function createArduinoPane(host) {
  const st = {
    circuit: emptyCircuit(), sel: null, view: { k: 1.5, tx: 12, ty: 12 }, fitted: false, pending: null, drag: null, running: false, state: null, hints: [], worker: null, baud: null, lastSaved: '', audio: null, osc: null,
  };
  const pointers = new Map();

  // ── 화면 뼈대 ──
  const layerParts = s('g', {});
  const layerWires = s('g', {});
  const layerOver = s('g', {});
  const world = s('g', {}, layerParts, layerWires, layerOver);
  const svg = s('svg', { class: 'ardu-svg', tabindex: '0', role: 'application', 'aria-label': '아두이노 회로. 단자를 눌러 전선을 잇고, 부품을 끌어 옮깁니다.' }, world);
  const boardSel = h('select', { class: 'input ardu-board', 'aria-label': '아두이노 기종', onchange: () => { st.circuit.board = boardSel.value; pruneWires(); st.fitted = false; changed(); fit(); } },
    Object.entries(BOARDS).map(([k, b]) => h('option', { value: k }, b.name)));
  const delBtn = h('button', { class: 'icon-btn tiny', title: '선택한 것 지우기 (Delete)', 'aria-label': '선택한 것 지우기', hidden: true, onclick: () => removeSelected() }, icon('trash', 16));
  const bar = h('div', { class: 'ardu-bar' },
    h('strong', { class: 'ardu-title' }, '아두이노 연결'), boardSel,
    h('button', { class: 'btn small secondary', type: 'button', onclick: (e) => partMenu(e.currentTarget) }, icon('plus', 14), ' 부품'),
    delBtn, h('span', { class: 'grow' }),
    h('button', { class: 'icon-btn tiny', title: '축소', 'aria-label': '축소', onclick: () => zoomBy(1 / 1.25) }, '−'),
    h('button', { class: 'icon-btn tiny', title: '확대', 'aria-label': '확대', onclick: () => zoomBy(1.25) }, '＋'),
    h('button', { class: 'icon-btn tiny', title: '전체 보기', 'aria-label': '전체 보기', onclick: () => fit() }, icon('grid', 16)));
  const tip = h('div', { class: 'ardu-tip' });
  const warnEl = h('div', { class: 'ardu-warn', hidden: true, role: 'status' });
  const inspect = h('div', { class: 'ardu-inspect', hidden: true }); // 선택한 부품의 설정: 회로 위에 떠 있는 카드
  const canvas = h('div', { class: 'ardu-canvas' }, svg, tip, inspect);
  const circuitEl = h('div', { class: 'ardu-circuit' }, bar, canvas, warnEl);

  const log = h('div', { class: 'ardu-log', role: 'log', 'aria-label': '시리얼 모니터 출력' });
  const statusEl = h('span', { class: 'run-status' }, '멈춤');
  const runBtn = h('button', { class: 'btn small primary', type: 'button', onclick: () => (st.running || st.compiling ? stop() : host.onRun?.()) }, icon('play', 14), ' 실행');
  const sendInput = h('input', { class: 'input ardu-send-input', placeholder: '아두이노로 보낼 글자 (Serial.read)', 'aria-label': '시리얼로 보낼 글자', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false' });
  const endSel = h('select', { class: 'input ardu-end', 'aria-label': '줄 끝' }, h('option', { value: '\n' }, '새 줄'), h('option', { value: '' }, '줄 끝 없음'), h('option', { value: '\r\n' }, 'CR+LF'));
  // 컴파일 방식: 자동 = 서버의 실제 컴파일러(avr-gcc) → 안 되면 브라우저 안의 간이 변환기
  const modeSel = h('select', { class: 'input ardu-mode', 'aria-label': '컴파일 방식', title: '컴파일 방식', onchange: () => { try { localStorage.setItem('cs.ardu.mode', modeSel.value); } catch { /* noop */ } } },
    h('option', { value: 'auto' }, '실제 컴파일러'), h('option', { value: 'simple' }, '간이 변환기'));
  try { if (localStorage.getItem('cs.ardu.mode') === 'simple') modeSel.value = 'simple'; } catch { /* noop */ }
  const serialEl = h('div', { class: 'ardu-serial' },
    h('div', { class: 'run-head' }, h('strong', {}, '시리얼 모니터'), statusEl,
      h('span', { class: 'run-actions' }, modeSel, runBtn, h('button', { class: 'btn small ghost', type: 'button', onclick: () => clearLog() }, '지우기'))),
    log,
    h('form', { class: 'ardu-send', onsubmit: (e) => { e.preventDefault(); sendSerial(); } }, sendInput, endSel, h('button', { class: 'btn small secondary', type: 'submit' }, '보내기')));
  const el = h('div', { class: 'ardu' }, circuitEl, serialEl);

  // ── 좌표 · 보기 ──
  const applyView = () => world.setAttribute('transform', `translate(${st.view.tx},${st.view.ty}) scale(${st.view.k})`);
  const toWorld = (e) => { const r = svg.getBoundingClientRect(); return { x: (e.clientX - r.left - st.view.tx) / st.view.k, y: (e.clientY - r.top - st.view.ty) / st.view.k }; };
  function bounds() {
    const b = BOARDS[st.circuit.board];
    const o = st.circuit.boardPos;
    let box = [o.x - 10, o.y - 4, o.x + b.w + 4, o.y + b.h + 4];
    for (const p of st.circuit.parts) { const bb = bboxOf(p); box = [Math.min(box[0], p.x + bb[0]), Math.min(box[1], p.y + bb[1]), Math.max(box[2], p.x + bb[2]), Math.max(box[3], p.y + bb[3] + 8)]; }
    return box;
  }
  function fit() {
    const r = svg.getBoundingClientRect();
    if (r.width < 40 || r.height < 40) return;
    const [x0, y0, x1, y1] = bounds();
    const k = Math.min(3, Math.max(0.3, Math.min((r.width - 24) / (x1 - x0), (r.height - 24) / (y1 - y0))));
    st.view = { k, tx: (r.width - (x1 - x0) * k) / 2 - x0 * k, ty: (r.height - (y1 - y0) * k) / 2 - y0 * k };
    st.fitted = true;
    st.userView = false;
    applyView();
  }
  function zoomBy(f, cx, cy) {
    const r = svg.getBoundingClientRect();
    const x = cx ?? r.width / 2; const y = cy ?? r.height / 2;
    const k = Math.min(6, Math.max(0.25, st.view.k * f));
    const g = k / st.view.k;
    st.view = { k, tx: x - (x - st.view.tx) * g, ty: y - (y - st.view.ty) * g };
    st.userView = true;
    applyView();
  }
  // 창 크기가 바뀌면 (설정 칸이 열리거나 닫힐 때 등) 직접 확대 · 이동한 적이 없는 한 전체가 보이게 다시 맞춤
  new ResizeObserver(() => { if (!st.fitted || !st.userView) fit(); }).observe(svg);

  // ── 그리기 ──
  const pinState = (id) => st.state?.pins?.[id.split('.')[0]];
  function drawBoard() {
    const b = BOARDS[st.circuit.board];
    const o = st.circuit.boardPos;
    const d13 = pinState('D13');
    const lit = d13 && d13.m === 1 && d13.v > 0;
    const g = s('g', { transform: `translate(${o.x},${o.y})`, class: st.sel?.kind === 'board' ? 'sel' : null },
      s('rect', { x: 0, y: 0, width: b.w, height: b.h, rx: 8, fill: b.color, stroke: 'rgba(0,0,0,.35)', class: 'ardu-body' }),
      b.usb ? s('rect', { x: b.usb[0], y: b.usb[1], width: b.usb[2], height: b.usb[3], rx: 2, fill: '#b9bec5', stroke: '#7d838a' }) : null,
      s('rect', { x: b.chip[0], y: b.chip[1], width: b.chip[2], height: b.chip[3], rx: 2, fill: '#1c1c1e' }),
      s('text', { x: b.w / 2 + 14, y: b.h / 2 - (st.circuit.board === 'uno' ? 22 : -22), class: 'ardu-board-name', 'text-anchor': 'middle' }, `ARDUINO ${st.circuit.board === 'promini' ? 'PRO MINI' : st.circuit.board.toUpperCase()}`),
      s('rect', { x: b.led[0], y: b.led[1], width: 7, height: 4, rx: 1, fill: lit ? '#ffb300' : '#5d4a16', class: lit ? 'ardu-glow' : null }),
      s('text', { x: b.led[0] + 3.5, y: b.led[1] - 2, class: 'ardu-pin-label', 'text-anchor': 'middle' }, 'L'));
    for (const p of b.pins) {
      const ps = pinState(p.id);
      const high = ps && ps.v > 0;
      g.append(s('rect', { x: p.x - 4.5, y: p.y - 4.5, width: 9, height: 9, fill: '#151515' }),
        s('rect', { x: p.x - 2.2, y: p.y - 2.2, width: 4.4, height: 4.4, rx: 0.8, fill: high ? (ps.m === 1 ? '#ffd54f' : '#7ee787') : '#8f969e', opacity: high && ps.v < 1 ? 0.45 + ps.v * 0.55 : 1 }));
      const label = (PWM.has(p.id) ? '~' : '') + p.label;
      if (p.side === 'in') g.append(s('text', { x: p.x + 7, y: p.y + 2.2, class: 'ardu-pin-label' }, label));
      else g.append(s('text', { x: 0, y: 0, class: 'ardu-pin-label', transform: `translate(${p.x + 2.2},${p.side === 'top' ? p.y + 8 : p.y - 8}) rotate(${p.side === 'top' ? 90 : -90})` }, label));
    }
    return g;
  }
  function drawBreadboard(part) {
    let holes = '';
    for (const hole of bbHoles()) holes += `M${hole.x - 1.6} ${hole.y - 1.6}h3.2v3.2h-3.2z`;
    const g = s('g', { transform: `translate(${part.x},${part.y})`, class: st.sel?.id === part.id ? 'sel' : null },
      s('rect', { x: 0, y: 0, width: BB.w, height: BB.h, rx: 5, fill: '#f3efe2', stroke: '#b9b29c', class: 'ardu-body' }),
      s('rect', { x: 8, y: 90, width: BB.w - 16, height: 4, fill: '#ddd6c2' }));
    for (const [y, color] of [[7, '#d32f2f'], [27, '#1565c0'], [157, '#d32f2f'], [177, '#1565c0']]) g.append(s('path', { d: `M14 ${y}H${BB.w - 14}`, stroke: color, 'stroke-width': 0.9 }));
    for (const [y, sign, color] of [[14.5, '+', '#d32f2f'], [24.5, '−', '#1565c0'], [164.5, '+', '#d32f2f'], [174.5, '−', '#1565c0']]) g.append(s('text', { x: 6, y, class: 'ardu-bb-label', fill: color }, sign));
    for (let c = 1; c <= BB.cols; c += c === 1 ? 4 : 5) g.append(s('text', { x: BB.x0 + (c - 1) * PITCH, y: 96.2, class: 'ardu-bb-label', 'text-anchor': 'middle' }, String(c)));
    'abcdefghij'.split('').forEach((ch, i) => g.append(s('text', { x: 9, y: (i < 5 ? 44 : 104 - 50) + i * PITCH, class: 'ardu-bb-label' }, ch)));
    g.append(s('path', { d: holes, fill: '#3a3a3a' }));
    return g;
  }
  function valueText(part) {
    const p = { ...PART_DEFS[part.type].props, ...part.props };
    switch (part.type) {
      case 'dht': return `${p.temp}℃ ${p.hum}%`;
      case 'bmp280': return `${p.alt}m`;
      case 'mpu6050': return `${p.ax},${p.ay},${p.az}g`;
      case 'gps': return p.fix === false ? '수신 안 됨' : `${Number(p.lat).toFixed(3)},${Number(p.lng).toFixed(3)}`;
      case 'hx711': return `${p.weight} g`;
      case 'hcsr04': return `${p.dist} cm`;
      default: return '';
    }
  }
  function drawPart(part) {
    const def = PART_DEFS[part.type];
    const p = { ...def.props, ...part.props };
    const live = st.state?.parts?.[part.id];
    const g = s('g', { transform: `translate(${part.x},${part.y})`, class: st.sel?.id === part.id ? 'sel' : null });
    const leg = (x, top) => s('path', { d: `M${x} 0V${top}`, class: 'ardu-leg' });
    const [x0, y0, x1, y1] = bboxOf(part);
    if (part.type === 'led') {
      const color = LED_COLORS[p.color] || LED_COLORS.red;
      const mA = live?.i || 0;
      const glow = Math.min(1, mA / 12);
      const dead = !!live?.x; // 과전류로 탐
      g.append(leg(0, -12), leg(PITCH, -12),
        glow > 0.02 ? s('circle', { cx: 5, cy: -20, r: 9 + glow * 9, fill: color, opacity: 0.15 + glow * 0.3, class: 'ardu-glow' }) : null,
        s('path', { d: 'M-2 -12V-20a7 7 0 0 1 14 0V-12z', fill: dead ? '#3a3a3a' : color, 'fill-opacity': dead ? 0.9 : 0.3 + glow * 0.7, stroke: mA > 30 ? '#ff1744' : 'rgba(0,0,0,.45)', 'stroke-width': mA > 30 ? 1.6 : 0.6, class: 'ardu-body' }),
        s('text', { x: -4, y: -3, class: 'ardu-mark' }, '+'));
      if (dead) g.append(s('path', { d: 'M1 -23l8 8M9 -23l-8 8', stroke: '#ff5252', 'stroke-width': 1.6, 'stroke-linecap': 'round' }), s('text', { x: 5, y: -31, class: 'ardu-val', 'text-anchor': 'middle' }, '탐'));
      else if (mA > 0.05) g.append(s('text', { x: 5, y: -31, class: 'ardu-val', 'text-anchor': 'middle' }, `${mA.toFixed(1)}mA`));
    } else if (part.type === 'resistor') {
      const ohm = Number(p.ohm) || 220;
      const exp = Math.floor(Math.log10(ohm)) - 1;
      const digits = String(Math.round(ohm / 10 ** exp)).padStart(2, '0');
      g.append(s('path', { d: `M0 0H${PITCH * 4}`, class: 'ardu-leg' }), s('rect', { x: 8, y: -4.5, width: 24, height: 9, rx: 3, fill: '#dcc48e', stroke: '#9a8351', 'stroke-width': 0.5, class: 'ardu-body' }));
      [digits[0], digits[1], exp].forEach((d, i) => g.append(s('rect', { x: 12 + i * 4.5, y: -4.5, width: 2.4, height: 9, fill: BAND[Number(d)] || '#111' })));
      g.append(s('rect', { x: 27, y: -4.5, width: 2.4, height: 9, fill: '#c9a227' }), s('text', { x: 20, y: -7, class: 'ardu-val', 'text-anchor': 'middle' }, fmtOhm(ohm)));
    } else if (part.type === 'button') {
      g.append(leg(0, -4), leg(PITCH * 2, -4), s('rect', { x: -4, y: -20, width: 28, height: 16, rx: 2, fill: '#3a3d42', stroke: '#111', 'stroke-width': 0.5, class: 'ardu-body' }),
        s('circle', { cx: 10, cy: -12, r: 5.5, fill: p.pressed ? '#c62828' : '#ef5350', stroke: '#7f1d1d', 'stroke-width': 0.6 }));
    } else if (part.type === 'pot') {
      const ang = -135 + 270 * Math.min(1, Math.max(0, Number(p.pos) || 0));
      g.append(leg(0, -6), leg(PITCH, -6), leg(PITCH * 2, -6), s('rect', { x: -5, y: -34, width: 30, height: 28, rx: 3, fill: '#1e5aa8', stroke: '#0d3b78', 'stroke-width': 0.5, class: 'ardu-body' }),
        s('circle', { cx: 10, cy: -20, r: 9, fill: '#e7e9ec', stroke: '#8b9097', 'stroke-width': 0.6 }),
        s('path', { d: 'M10 -20V-28', stroke: '#333', 'stroke-width': 1.8, 'stroke-linecap': 'round', transform: `rotate(${ang} 10 -20)` }));
    } else if (part.type === 'ldr') {
      g.append(leg(0, -8), leg(PITCH, -8), s('circle', { cx: 5, cy: -16, r: 9, fill: '#e8a33a', stroke: '#8a5a12', 'stroke-width': 0.6, class: 'ardu-body' }),
        s('path', { d: 'M0 -19h10v3h-10v3h10', fill: 'none', stroke: '#7a2e12', 'stroke-width': 1 }), s('text', { x: 5, y: -27, class: 'ardu-val', 'text-anchor': 'middle' }, `${p.light}%`));
    } else if (part.type === 'buzzer') {
      const f = live?.f || 0;
      g.append(leg(0, -6), leg(PITCH, -6), f ? s('circle', { cx: 5, cy: -18, r: 16, fill: 'none', stroke: '#ffb300', 'stroke-width': 1.2, class: 'ardu-ring' }) : null,
        s('circle', { cx: 5, cy: -18, r: 13, fill: '#1c1c1e', stroke: '#000', 'stroke-width': 0.6, class: 'ardu-body' }), s('circle', { cx: 5, cy: -18, r: 2.4, fill: '#555' }), s('text', { x: -8, y: -3, class: 'ardu-mark' }, '+'));
      if (f) g.append(s('text', { x: 5, y: -36, class: 'ardu-val', 'text-anchor': 'middle' }, `♪ ${f}Hz`));
    } else {
      const cx = (x0 + x1) / 2;
      g.append(s('rect', { x: x0, y: y0, width: x1 - x0, height: y1 - y0, rx: 3, fill: def.color || '#455a64', stroke: 'rgba(0,0,0,.4)', 'stroke-width': 0.6, class: 'ardu-body' }),
        s('text', { x: cx, y: y0 + 10, class: 'ardu-mod-title', 'text-anchor': 'middle' }, def.short || def.name));
      if (part.type === 'lcd') {
        const on = live && live.b !== 0;
        g.append(s('rect', { x: x0 + 5, y: y0 + 14, width: x1 - x0 - 10, height: 26, rx: 1.5, fill: on ? '#b6e34a' : '#5f7a2a', stroke: '#222', 'stroke-width': 0.5 }));
        (live?.l || []).slice(0, 2).forEach((line, i) => g.append(s('text', { x: x0 + 9, y: y0 + 24 + i * 11, class: 'ardu-lcd', 'xml:space': 'preserve' }, String(line).slice(0, 16))));
      } else if (part.type === 'servo') {
        g.append(s('circle', { cx, cy: y0 + 26, r: 8, fill: '#e7e9ec' }), s('path', { d: `M${cx} ${y0 + 26}h-14`, stroke: '#fff', 'stroke-width': 3.2, 'stroke-linecap': 'round', transform: `rotate(${live?.a ?? 90} ${cx} ${y0 + 26})` }),
          s('text', { x: cx, y: y0 + 44, class: 'ardu-val light', 'text-anchor': 'middle' }, `${live?.a ?? 90}°`));
      } else {
        if (part.type === 'hcsr04') g.append(s('circle', { cx: cx - 12, cy: y0 + 24, r: 7, fill: '#cfd8dc', stroke: '#546e7a' }), s('circle', { cx: cx + 12, cy: y0 + 24, r: 7, fill: '#cfd8dc', stroke: '#546e7a' }));
        g.append(s('text', { x: cx, y: y0 + (part.type === 'hcsr04' ? 38 : 22), class: 'ardu-val light', 'text-anchor': 'middle' }, valueText(part)));
      }
      for (const [, px, , label] of def.pins) g.append(leg(px, y1), s('text', { x: 0, y: 0, class: 'ardu-pin-label', transform: `translate(${px + 2},${y1 - 2}) rotate(-90)` }, label));
    }
    for (const [, px, py] of def.pins) g.append(s('circle', { cx: px, cy: py, r: 1.9, class: 'ardu-term' }));
    return g;
  }
  function wirePath(a, b) {
    const d = Math.hypot(b.x - a.x, b.y - a.y);
    const sag = Math.min(26, d * 0.16);
    return { d: `M${a.x} ${a.y}Q${(a.x + b.x) / 2} ${(a.y + b.y) / 2 + sag} ${b.x} ${b.y}`, mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 + sag } };
  }
  function drawWires() {
    const out = [];
    for (const w of st.circuit.wires) {
      const a = terminalPos(st.circuit, w.a); const b = terminalPos(st.circuit, w.b);
      if (!a || !b) continue;
      const { d } = wirePath(a, b);
      const selected = st.sel?.kind === 'wire' && st.sel.id === w.id;
      if (selected) out.push(s('path', { d, class: 'ardu-wire-sel' }));
      out.push(s('path', { d, class: 'ardu-wire-edge' }), s('path', { d, class: 'ardu-wire', stroke: w.color }),
        s('circle', { cx: a.x, cy: a.y, r: 2.6, fill: w.color, stroke: 'rgba(0,0,0,.5)', 'stroke-width': 0.5 }), s('circle', { cx: b.x, cy: b.y, r: 2.6, fill: w.color, stroke: 'rgba(0,0,0,.5)', 'stroke-width': 0.5 }));
    }
    layerWires.replaceChildren(...out);
  }
  function drawOver() {
    const out = [];
    if (st.pending) {
      const a = terminalPos(st.circuit, st.pending.from);
      if (a) {
        out.push(s('circle', { cx: a.x, cy: a.y, r: 5, class: 'ardu-pick' }));
        if (st.pending.to) out.push(s('path', { d: wirePath(a, st.pending.to).d, class: 'ardu-wire ghost', stroke: st.pending.color }));
        if (st.pending.snap) out.push(s('circle', { cx: st.pending.snap.x, cy: st.pending.snap.y, r: 5, class: 'ardu-pick' }));
      }
    }
    layerOver.replaceChildren(...out);
  }
  let els = new Map();
  function draw() {
    els = new Map();
    const boardG = drawBoard();
    els.set('mcu', boardG);
    const list = [boardG];
    for (const p of st.circuit.parts) if (p.type === 'breadboard') { const g = drawBreadboard(p); els.set(p.id, g); list.push(g); }
    for (const p of st.circuit.parts) if (p.type !== 'breadboard') { const g = drawPart(p); els.set(p.id, g); list.push(g); }
    layerParts.replaceChildren(...list);
    drawWires();
    drawOver();
  }
  let drawQueued = false;
  const drawSoon = () => { if (drawQueued) return; drawQueued = true; requestAnimationFrame(() => { drawQueued = false; draw(); }); };

  // ── 무엇을 눌렀는지 ──
  // 단자를 잡는 범위: 화면에서는 손가락 16px / 마우스 9px, 다만 구멍 간격(10)보다 넓어지지 않게
  const reach = () => (matchMedia('(pointer: coarse)').matches ? Math.min(9, Math.max(4.5, 16 / st.view.k)) : Math.min(6.5, Math.max(3.5, 9 / st.view.k)));
  function terminalAt(pt, except) {
    const r = reach();
    let best = null;
    const consider = (tid, x, y, bias) => { const d = Math.hypot(pt.x - x, pt.y - y) + bias; if (d <= r && tid !== except && (!best || d < best.d)) best = { tid, x, y, d, hole: bias > 0 }; };
    for (const p of boardPins(st.circuit)) consider(p.tid, p.x, p.y, 0);
    for (const part of st.circuit.parts) {
      if (part.type === 'breadboard') { const hole = holeNear(part, pt.x, pt.y, Math.min(r, PITCH * 0.5)); if (hole) consider(`${part.id}:${hole.name}`, hole.x, hole.y, 0.8); } else for (const pin of pinsOf(part)) consider(pin.tid, pin.x, pin.y, 0);
    }
    return best;
  }
  function wireAt(pt) {
    const r = reach() * 0.8;
    for (let i = st.circuit.wires.length - 1; i >= 0; i--) {
      const w = st.circuit.wires[i];
      const a = terminalPos(st.circuit, w.a); const b = terminalPos(st.circuit, w.b);
      if (!a || !b) continue;
      const { mid } = wirePath(a, b);
      for (let t = 0.08; t <= 0.92; t += 0.04) {
        const x = (1 - t) ** 2 * a.x + 2 * t * (1 - t) * mid.x + t * t * b.x;
        const y = (1 - t) ** 2 * a.y + 2 * t * (1 - t) * mid.y + t * t * b.y;
        if (Math.hypot(pt.x - x, pt.y - y) <= r) return w;
      }
    }
    return null;
  }
  function partAt(pt) {
    const inside = (p) => { const [x0, y0, x1, y1] = bboxOf(p); return pt.x >= p.x + x0 && pt.x <= p.x + x1 && pt.y >= p.y + y0 && pt.y <= p.y + y1; };
    const parts = st.circuit.parts;
    for (let i = parts.length - 1; i >= 0; i--) if (parts[i].type !== 'breadboard' && inside(parts[i])) return parts[i];
    for (let i = parts.length - 1; i >= 0; i--) if (parts[i].type === 'breadboard' && inside(parts[i])) return parts[i];
    return null;
  }
  const onBoard = (pt) => { const b = BOARDS[st.circuit.board]; const o = st.circuit.boardPos; return pt.x >= o.x && pt.x <= o.x + b.w && pt.y >= o.y && pt.y <= o.y + b.h; };

  // ── 회로 바꾸기 ──
  const save = debounce(() => {
    if (!host.canEdit) return;
    const text = JSON.stringify(st.circuit, null, 1);
    if (text === st.lastSaved) return;
    st.lastSaved = text;
    host.saveCircuit?.(text);
  }, 700);
  let netQueued = false;
  function sendNet() {
    if (!st.worker || netQueued) return;
    netQueued = true;
    queueMicrotask(() => { netQueued = false; st.worker?.postMessage({ type: 'net', net: buildNetlist(st.circuit) }); });
  }
  function changed() { draw(); renderInspect(); renderWarn(); sendNet(); save(); }
  function pruneWires() { st.circuit.wires = st.circuit.wires.filter((w) => terminalPos(st.circuit, w.a) && terminalPos(st.circuit, w.b)); }
  function autoColor(a, b) {
    const name = (t) => (t.startsWith('mcu:') ? t.slice(4).split('.')[0] : /:(tp|bp)\d+$/.test(t) ? '5V' : /:(tn|bn)\d+$/.test(t) ? 'GND' : t.split(':')[1]);
    const names = [name(a), name(b)];
    if (names.includes('GND') || names.includes('-')) return WIRE_COLORS[1];
    if (names.some((n) => n === '5V' || n === '3V3' || n === 'VIN' || n === 'VCC')) return WIRE_COLORS[0];
    const rest = WIRE_COLORS.slice(2, 7);
    return rest[st.circuit.wires.length % rest.length];
  }
  function addWire(a, b) {
    if (a === b || st.circuit.wires.some((w) => (w.a === a && w.b === b) || (w.a === b && w.b === a))) return;
    const w = { id: newId('w'), a, b, color: autoColor(a, b) };
    st.circuit.wires.push(w);
    st.sel = null;
    changed();
  }
  function addPart(type) {
    const r = svg.getBoundingClientRect();
    const c = { x: (r.width / 2 - st.view.tx) / st.view.k, y: (r.height / 2 - st.view.ty) / st.view.k };
    const part = { id: newId(type === 'breadboard' ? 'b' : 'p'), type, x: Math.round(c.x), y: Math.round(c.y), props: { ...(PART_DEFS[type].props || {}) } };
    if (type === 'breadboard') {
      const [x0, , , y1] = bounds();
      part.x = Math.round(x0 + 10); part.y = Math.round(y1 + 24);
      st.circuit.parts.unshift(part);
    } else {
      const n = st.circuit.parts.filter((p) => p.type !== 'breadboard').length;
      part.x += (n % 5) * 14 - 28; part.y += (n % 3) * 12;
      st.circuit.parts.push(part);
    }
    st.sel = { kind: 'part', id: part.id };
    changed();
    if (type === 'breadboard') fit();
  }
  function removeSelected() {
    const sel = st.sel;
    if (!sel || sel.kind === 'board') return;
    if (sel.kind === 'wire') st.circuit.wires = st.circuit.wires.filter((w) => w.id !== sel.id);
    else {
      st.circuit.parts = st.circuit.parts.filter((p) => p.id !== sel.id);
      st.circuit.wires = st.circuit.wires.filter((w) => !w.a.startsWith(`${sel.id}:`) && !w.b.startsWith(`${sel.id}:`));
    }
    st.sel = null;
    changed();
  }
  function setProp(part, key, value, { redraw = true } = {}) {
    part.props[key] = value;
    st.worker?.postMessage({ type: 'prop', id: part.id, key, value });
    if (redraw) drawSoon();
    if (key !== 'pressed') save();
  }
  function partMenu(anchor) {
    const groups = ['기본', '센서', '출력'];
    const items = [];
    for (const group of groups) {
      if (items.length) items.push('sep');
      for (const [type, def] of Object.entries(PART_DEFS)) if (def.group === group) items.push({ label: def.name, icon: type === 'breadboard' ? 'grid' : group === '센서' ? 'activity' : group === '출력' ? 'sliders' : 'plus', onClick: () => addPart(type) });
    }
    openMenu(anchor, items, { header: h('div', { class: 'menu-head muted small' }, '추가할 부품을 고르세요') });
  }

  // ── 선택한 것의 설정 ──
  function renderInspect() {
    const sel = st.sel;
    delBtn.hidden = !sel || sel.kind === 'board';
    if (!sel || sel.kind === 'board') { inspect.hidden = true; inspect.replaceChildren(); return; }
    inspect.hidden = false;
    // 선택한 것이 화면 아래쪽에 있으면 카드는 위에, 위쪽에 있으면 아래에
    const anchor = sel.kind === 'part' ? st.circuit.parts.find((p) => p.id === sel.id) : null;
    const mid = anchor ? (anchor.y + (bboxOf(anchor)[1] + bboxOf(anchor)[3]) / 2) * st.view.k + st.view.ty : 0;
    inspect.classList.toggle('top', mid > svg.getBoundingClientRect().height / 2);
    if (sel.kind === 'wire') {
      const w = st.circuit.wires.find((x) => x.id === sel.id);
      if (!w) { st.sel = null; return renderInspect(); }
      const nice = (t) => (t.startsWith('mcu:') ? t.slice(4).split('.')[0] : t.split(':')[1]);
      inspect.replaceChildren(h('div', { class: 'ardu-ins-head' }, h('strong', {}, `전선 · ${nice(w.a)} ↔ ${nice(w.b)}`),
        h('span', { class: 'ardu-swatches' }, WIRE_COLORS.map((c) => h('button', { type: 'button', class: `ardu-swatch${c === w.color ? ' active' : ''}`, style: { background: c }, 'aria-label': `전선 색 ${c}`, onclick: () => { w.color = c; changed(); } }))),
        h('button', { class: 'btn small danger-ghost', type: 'button', onclick: () => removeSelected() }, '지우기')));
      return undefined;
    }
    const part = st.circuit.parts.find((p) => p.id === sel.id);
    if (!part) { st.sel = null; return renderInspect(); }
    const def = PART_DEFS[part.type];
    const rows = [];
    for (const opt of def.options || []) {
      const cur = part.props[opt.key] ?? def.props[opt.key];
      const select = h('select', { class: 'input', onchange: () => { const pick = opt.choices[select.selectedIndex][0]; setProp(part, opt.key, pick); sendNet(); } },
        opt.choices.map(([v, label]) => h('option', { selected: v === cur }, label)));
      rows.push(h('label', { class: 'ardu-row' }, h('span', {}, opt.label), select));
    }
    for (const c of def.controls || []) {
      const scale = c.scale || 1;
      const cur = Number(part.props[c.key] ?? def.props[c.key]);
      const range = h('input', { type: 'range', min: String(c.min), max: String(c.max), step: String(c.step), value: String(cur), 'aria-label': c.label });
      const num = h('input', { class: 'input ardu-num', type: 'number', min: String(c.min * scale), max: String(c.max * scale), step: String(c.step * scale), value: String(Math.round(cur * scale * 1e4) / 1e4), 'aria-label': `${c.label} 값` });
      const apply = (v, from) => {
        if (!Number.isFinite(v)) return;
        const val = Math.min(c.max, Math.max(c.min, v));
        if (from !== range) range.value = String(val);
        if (from !== num) num.value = String(Math.round(val * scale * 1e4) / 1e4);
        setProp(part, c.key, val);
      };
      range.addEventListener('input', () => apply(Number(range.value), range));
      num.addEventListener('change', () => apply(Number(num.value) / scale, num));
      rows.push(h('label', { class: 'ardu-row' }, h('span', {}, c.label), range, num, h('span', { class: 'muted small ardu-unit' }, c.unit || '')));
    }
    inspect.replaceChildren(
      h('div', { class: 'ardu-ins-head' }, h('strong', { class: 'ellipsis' }, def.name), h('button', { class: 'btn small danger-ghost', type: 'button', onclick: () => removeSelected() }, '지우기')),
      ...rows, def.desc ? h('p', { class: 'muted small ardu-desc' }, def.desc) : null);
    return undefined;
  }
  function renderWarn() {
    const list = [...(st.state?.warn || []), ...st.hints];
    if (buildNetlist(st.circuit).short && !list.some((x) => x.startsWith('합선'))) list.unshift('합선(쇼트): 5V(또는 3.3V)와 GND 가 저항 없이 직접 이어져 있습니다.');
    warnEl.hidden = !list.length;
    warnEl.replaceChildren(...list.slice(0, 6).map((t) => h('div', {}, icon('alert', 14), h('span', {}, t))));
  }

  // ── 포인터 (끌기 · 전선 · 확대) ──
  function tipFor(pt) {
    const t = terminalAt(pt);
    if (!t) { tip.hidden = true; return; }
    const [owner, name] = [t.tid.slice(0, t.tid.indexOf(':')), t.tid.slice(t.tid.indexOf(':') + 1)];
    const part = st.circuit.parts.find((p) => p.id === owner);
    tip.textContent = owner === 'mcu' ? name.split('.')[0].replace('3V3', '3.3V') : part?.type === 'breadboard' ? `빵판 ${name.replace(/^(t|b)(p|n)/, (m, a, b) => `${a === 't' ? '위' : '아래'} ${b === 'p' ? '+' : '−'} `)}` : `${PART_DEFS[part.type].short || PART_DEFS[part.type].name} · ${PART_DEFS[part.type].pins.find((p) => p[0] === name)?.[3] || name}`;
    tip.hidden = false;
    tip.style.left = `${t.x * st.view.k + st.view.tx + 10}px`;
    tip.style.top = `${t.y * st.view.k + st.view.ty - 26}px`;
  }
  svg.addEventListener('pointerdown', (e) => {
    if (e.button > 0) return;
    svg.focus({ preventScroll: true });
    svg.setPointerCapture(e.pointerId);
    tip.hidden = true;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 2) { // 두 손가락: 확대 · 이동
      const [a, b] = [...pointers.values()];
      st.drag = { kind: 'pinch', d: Math.hypot(a.x - b.x, a.y - b.y), cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2 };
      st.pending = null; drawOver();
      return;
    }
    const pt = toWorld(e);
    const start = { x: e.clientX, y: e.clientY };
    const top = partAt(pt);
    let term = terminalAt(pt);
    if (term?.hole && top && top.type !== 'breadboard' && !st.pending) term = null; // 부품 몸통에 가려진 빵판 구멍은 잡지 않음
    if (st.pending) { // 두 번째 단자를 누르면 전선 완성
      const from = st.pending.from;
      st.pending = null;
      if (term && term.tid !== from) { addWire(from, term.tid); st.drag = { kind: 'none' }; return; }
      drawOver();
      if (term) { st.drag = { kind: 'none' }; return; }
    }
    if (term) { st.pending = { from: term.tid, to: null, color: '#fb8c00' }; st.drag = { kind: 'wire', start, moved: false }; drawOver(); return; }
    // 우선순위: 단자 → 부품 → 전선 → 빵판 → 보드 → 빈 곳(화면 이동)
    const wire = top && top.type !== 'breadboard' ? null : wireAt(pt);
    if (wire) { st.sel = { kind: 'wire', id: wire.id }; st.drag = { kind: 'none' }; draw(); renderInspect(); return; }
    const part = top;
    if (part) {
      if (st.running && part.type === 'button') { setProp(part, 'pressed', true); st.drag = { kind: 'press', part }; return; }
      st.sel = { kind: 'part', id: part.id };
      st.drag = { kind: 'part', part, start, ox: part.x, oy: part.y, moved: false, carry: part.type === 'breadboard' ? carried(part) : [] };
      draw(); renderInspect();
      return;
    }
    if (onBoard(pt)) { st.sel = { kind: 'board' }; st.drag = { kind: 'board', start, ox: st.circuit.boardPos.x, oy: st.circuit.boardPos.y, moved: false }; draw(); renderInspect(); return; }
    st.drag = { kind: 'pan', start, tx: st.view.tx, ty: st.view.ty, moved: false };
  });
  /** 빵판에 꽂힌 부품은 빵판과 함께 움직임 */
  function carried(bb) {
    return st.circuit.parts.filter((p) => p.type !== 'breadboard' && pinsOf(p).some((pin) => holeNear(bb, pin.x, pin.y, 2.5))).map((p) => ({ p, ox: p.x, oy: p.y }));
  }
  svg.addEventListener('pointermove', (e) => {
    if (pointers.has(e.pointerId)) pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const d = st.drag;
    if (!d) { if (e.pointerType === 'mouse') tipFor(toWorld(e)); if (st.pending) { st.pending.to = toWorld(e); st.pending.snap = terminalAt(st.pending.to, st.pending.from); drawOver(); } return; }
    if (d.kind === 'pinch' && pointers.size >= 2) {
      const [a, b] = [...pointers.values()];
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      const r = svg.getBoundingClientRect();
      const cx = (a.x + b.x) / 2; const cy = (a.y + b.y) / 2;
      st.view.tx += cx - d.cx; st.view.ty += cy - d.cy;
      zoomBy(dist / (d.d || 1), cx - r.left, cy - r.top);
      d.d = dist; d.cx = cx; d.cy = cy;
      return;
    }
    if (!d.start) return;
    const dx = e.clientX - d.start.x; const dy = e.clientY - d.start.y;
    if (!d.moved && Math.hypot(dx, dy) < 4) return;
    d.moved = true;
    tip.hidden = true;
    if (d.kind === 'wire' && st.pending) { st.pending.to = toWorld(e); st.pending.snap = terminalAt(st.pending.to, st.pending.from); drawOver(); } else if (d.kind === 'pan') { st.view.tx = d.tx + dx; st.view.ty = d.ty + dy; st.userView = true; applyView(); } else if (d.kind === 'part') {
      d.part.x = d.ox + dx / st.view.k; d.part.y = d.oy + dy / st.view.k;
      els.get(d.part.id)?.setAttribute('transform', `translate(${d.part.x},${d.part.y})`);
      for (const c of d.carry) { c.p.x = c.ox + dx / st.view.k; c.p.y = c.oy + dy / st.view.k; els.get(c.p.id)?.setAttribute('transform', `translate(${c.p.x},${c.p.y})`); }
      drawWires();
    } else if (d.kind === 'board') {
      st.circuit.boardPos = { x: d.ox + dx / st.view.k, y: d.oy + dy / st.view.k };
      els.get('mcu')?.setAttribute('transform', `translate(${st.circuit.boardPos.x},${st.circuit.boardPos.y})`);
      drawWires();
    }
  });
  const endPointer = (e) => {
    pointers.delete(e.pointerId);
    const d = st.drag;
    if (!d) return;
    if (d.kind === 'pinch') { if (pointers.size < 2) st.drag = pointers.size ? { kind: 'none' } : null; return; }
    st.drag = null;
    if (d.kind === 'press') { setProp(d.part, 'pressed', false); return; }
    if (d.kind === 'wire' && st.pending) {
      if (!d.moved) { drawOver(); return; } // 톡 누름: 다음에 누르는 단자와 연결
      const end = e.type === 'pointerup' ? terminalAt(toWorld(e), st.pending.from) : null;
      const from = st.pending.from;
      st.pending = null;
      if (end) addWire(from, end.tid); else drawOver();
      return;
    }
    if (d.kind === 'part' && d.moved) {
      const round = (p) => { p.x = Math.round(p.x * 2) / 2; p.y = Math.round(p.y * 2) / 2; };
      round(d.part); d.carry.forEach((c) => round(c.p));
      if (snapPart(st.circuit, d.part) && navigator.vibrate) navigator.vibrate(8);
      changed();
    } else if (d.kind === 'board' && d.moved) { st.circuit.boardPos = { x: Math.round(st.circuit.boardPos.x), y: Math.round(st.circuit.boardPos.y) }; changed(); } else if (d.kind === 'pan' && !d.moved && st.sel) { st.sel = null; draw(); renderInspect(); }
  };
  svg.addEventListener('pointerup', endPointer);
  svg.addEventListener('pointercancel', endPointer);
  svg.addEventListener('pointerleave', () => { tip.hidden = true; });
  svg.addEventListener('wheel', (e) => { e.preventDefault(); const r = svg.getBoundingClientRect(); zoomBy(e.deltaY < 0 ? 1.12 : 1 / 1.12, e.clientX - r.left, e.clientY - r.top); }, { passive: false });
  svg.addEventListener('keydown', (e) => {
    if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); removeSelected(); } else if (e.key === 'Escape') { st.pending = null; st.sel = null; draw(); renderInspect(); }
  });

  // ── 시리얼 모니터 ──
  let textNode = null;
  let pendingText = '';
  let flushQueued = false;
  function flushLog() {
    flushQueued = false;
    if (!pendingText) return;
    const stick = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
    if (!textNode || textNode.parentNode !== log || log.lastChild !== textNode) { textNode = h('span', { class: 'ardu-text' }); log.append(textNode); }
    let text = textNode.textContent + pendingText;
    pendingText = '';
    if (text.length > 60_000) text = text.slice(text.indexOf('\n', text.length - 40_000) + 1);
    textNode.textContent = text;
    while (log.childNodes.length > 200) log.firstChild.remove();
    if (stick) log.scrollTop = log.scrollHeight;
  }
  function appendText(text) { pendingText += text; if (!flushQueued) { flushQueued = true; requestAnimationFrame(flushLog); } }
  function note(text, cls = 'run-info', line = 0) {
    flushLog();
    const row = h('div', { class: `run-line ${cls}${line ? ' clickable' : ''}`, onclick: line ? () => host.onGoto?.(line) : null, title: line ? '눌러서 그 줄로 이동' : null }, line ? `${line}번째 줄: ${text}` : text);
    log.append(row);
    textNode = null;
    log.scrollTop = log.scrollHeight;
  }
  function clearLog() { log.replaceChildren(); textNode = null; pendingText = ''; }
  function sendSerial() {
    if (!st.running) return toast('먼저 ▶ 실행을 누르세요.', 'warn');
    st.worker.postMessage({ type: 'serial', text: sendInput.value + endSel.value });
    sendInput.value = '';
    return undefined;
  }

  // ── 부저 소리 ──
  function sound(freq) {
    try {
      if (!freq) { st.osc?.stop(); st.osc = null; return; }
      st.audio = st.audio || new (window.AudioContext || window.webkitAudioContext)();
      if (!st.osc) {
        const gain = st.audio.createGain();
        gain.gain.value = 0.03;
        st.osc = st.audio.createOscillator();
        st.osc.type = 'square';
        st.osc.connect(gain).connect(st.audio.destination);
        st.osc.start();
      }
      st.osc.frequency.value = Math.min(8000, Math.max(40, freq));
    } catch { /* 소리를 낼 수 없는 환경 */ }
  }

  // ── 실행 ──
  function setStatus() {
    const slow = st.running && st.state?.speed && st.state.speed < 93 ? ` · 속도 ${st.state.speed}%` : '';
    if (st.compiling) { statusEl.replaceChildren(h('span', { class: 'spinner tiny' }), ' 컴파일 중…'); runBtn.replaceChildren(icon('stop', 14), ' 취소'); runBtn.className = 'btn small secondary'; return; }
    statusEl.replaceChildren(st.running ? h('span', { class: 'spinner tiny' }) : '', st.running ? `${st.real ? ' 실제 기계어' : ' 간이 변환'} ·` : '', st.running ? ` 실행 중${st.baud ? ` · ${st.baud} baud` : ''}` : '멈춤');
    statusEl.append(slow);
    runBtn.replaceChildren(icon(st.running ? 'stop' : 'play', 14), st.running ? ' 중지' : ' 실행');
    runBtn.className = `btn small ${st.running ? 'secondary' : 'primary'}`;
    el.classList.toggle('running', st.running);
  }
  function stop({ quiet = false } = {}) {
    st.job = (st.job || 0) + 1; // 진행 중인 컴파일 결과는 버림
    if (st.compiling) { st.compiling = false; if (!quiet) note('■ 컴파일을 취소했습니다.'); }
    if (st.worker) { st.worker.terminate(); st.worker = null; if (!quiet) note('■ 중지했습니다.'); }
    for (const p of st.circuit.parts) if (p.props.pressed) p.props.pressed = false;
    st.running = false;
    st.state = null;
    st.baud = null;
    sound(0);
    setStatus();
    draw();
    renderWarn();
  }
  function onMessage({ data }) {
    if (data.type === 'serial') appendText(data.text);
    else if (data.type === 'state') {
      const speedWas = st.state?.speed;
      st.state = data.state;
      if (speedWas !== data.state.speed) setStatus();
      drawSoon();
      renderWarn();
      sound(Math.max(0, ...Object.values(data.state.parts || {}).map((p) => p.f || 0)));
    } else if (data.type === 'hint') { st.hints.push(data.text); renderWarn(); } else if (data.type === 'baud') { st.baud = data.baud; setStatus(); } else if (data.type === 'error') { note(`실행 중 오류: ${data.message}`, 'run-error', data.line); stop({ quiet: true }); }
  }
  const WHY = { offline: '서버에 연결되어 있지 않음', compiler_unavailable: '서버에 컴파일러가 설치되어 있지 않음', rate_limited: '컴파일 요청이 너무 잦음', compiler_busy: '서버가 다른 컴파일로 바쁨', compile_timeout: '컴파일 시간이 너무 오래 걸림', unauthorized: '로그인이 필요함' };
  /** 서버의 실제 컴파일러로 컴파일 → { hex, info } / 스케치 오류면 false / 서버를 쓸 수 없으면 null */
  async function compileOnServer(source, files) {
    if (modeSel.value === 'simple' || !host.compile) return null;
    const job = st.job;
    st.compiling = true;
    setStatus();
    note('⏳ 서버의 아두이노 컴파일러(avr-gcc)로 컴파일하는 중…');
    let r;
    try { r = await host.compile({ sketch: source, board: st.circuit.board, files }); } catch (e) {
      if (job !== st.job) return false;
      st.compiling = false;
      clearLog();
      note(`ℹ 실제 컴파일러를 쓸 수 없어(${WHY[e.code] || e.code || e.message}) 브라우저 안의 간이 변환기로 실행합니다. 일부 문법 · 라이브러리는 동작이 다를 수 있습니다.`, 'run-warn');
      return null;
    }
    if (job !== st.job) return false;
    st.compiling = false;
    clearLog();
    if (!r.ok) {
      const errs = r.errors?.length ? r.errors : [{ file: '', line: 0, message: (r.log || '알 수 없는 오류').slice(0, 600) }];
      for (const e of errs) note(`컴파일 오류: ${e.file && e.file !== 'sketch.ino' ? `[${e.file}${e.line ? `:${e.line}` : ''}] ` : ''}${e.message}`, 'run-error', e.file === 'sketch.ino' ? e.line : 0);
      const first = errs.find((e) => e.file === 'sketch.ino' && e.line);
      if (first) host.onGoto?.(first.line);
      setStatus();
      return false;
    }
    const pct = (a, b) => Math.round((a / b) * 100);
    return { hex: r.hex, info: `프로그램 ${r.flash.toLocaleString()}바이트 (${pct(r.flash, r.flashMax)}%) · 전역 변수 ${r.ram.toLocaleString()}바이트 (${pct(r.ram, r.ramMax)}%)`, ramTight: r.ram > r.ramMax * 0.75 };
  }
  /** 스케치를 컴파일하고 실행. 오류면 false */
  async function start(source, files = []) {
    stop({ quiet: true });
    st.hints = [];
    clearLog();
    if (buildNetlist(st.circuit).short) { note('합선(쇼트): 5V(또는 3.3V)와 GND 가 저항 없이 직접 이어져 있어 보드를 켤 수 없습니다. 그 전선을 없앤 뒤 다시 실행하세요.', 'run-error'); renderWarn(); return false; }
    const built = await compileOnServer(source, files);
    if (built === false) return false;
    let out = null;
    if (!built) {
      try { out = compileSketch(source); } catch (e) {
        note(`컴파일 오류: ${e.message}`, 'run-error', e.line || 0);
        if (e.line) host.onGoto?.(e.line);
        return false;
      }
      for (const inc of out.includes) if (!KNOWN_HEADERS.test(inc)) note(`⚠ <${inc}> 라이브러리는 간이 변환기가 알지 못합니다. 그 라이브러리의 함수는 동작하지 않을 수 있습니다.`, 'run-warn');
    }
    st.real = !!built;
    try {
      st.worker = new Worker(new URL('../arduino/worker.js', import.meta.url), { type: 'module' });
    } catch (e) {
      note(`시뮬레이터를 시작하지 못했습니다: ${e.message}`, 'run-error');
      return false;
    }
    st.worker.onmessage = onMessage;
    st.worker.onerror = (e) => { note(`시뮬레이터 오류: ${e.message || '이 브라우저에서는 실행할 수 없습니다.'}`, 'run-error'); stop({ quiet: true }); };
    st.worker.postMessage(built ? { type: 'start', mode: 'avr', hex: built.hex, net: buildNetlist(st.circuit) } : { type: 'start', js: out.js, net: buildNetlist(st.circuit) });
    st.running = true;
    if (built) { note(`✓ 컴파일 완료 · ${built.info}`); if (built.ramTight) note('⚠ 전역 변수가 메모리(2KB)의 대부분을 차지합니다. 실행 중 메모리가 모자라 이상하게 동작할 수 있습니다.', 'run-warn'); }
    note(`▶ ${BOARDS[st.circuit.board].name} 에서 실행 중 — 회로를 바꾸면 바로 반영됩니다.`);
    setStatus();
    renderWarn();
    return true;
  }

  setStatus();
  return {
    el,
    get running() { return st.running; },
    start,
    stop,
    /** 저장된 회로(JSON 문자열)를 불러옴. 내가 방금 저장한 내용이면 무시 */
    setCircuit(text, fallback) {
      if (text && (text === st.lastSaved || text === st.lastSeen)) return;
      if (st.drag) return;
      st.lastSeen = text || '';
      const c = (text && parseCircuit(text)) || fallback || emptyCircuit();
      st.circuit = c;
      st.lastSaved = JSON.stringify(c, null, 1); // 불러오기만 해서는 저장하지 않음
      st.sel = null;
      st.pending = null;
      boardSel.value = c.board;
      st.fitted = false;
      applyView();
      changed();
      fit();
    },
    /** 창이 다시 보이게 됐을 때 크기에 맞춤 */
    shown() { if (!st.fitted || !st.userView) fit(); },
    circuitText: () => JSON.stringify(st.circuit, null, 1),
  };
}
