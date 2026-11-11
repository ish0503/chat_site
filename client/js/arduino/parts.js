// 아두이노 회로: 보드 · 부품 정의, 좌표 계산, 그리고 "무엇이 무엇과 이어졌는가"(넷리스트) 계산.
// 화면(ui/arduino.js)과 테스트가 함께 씁니다. DOM 을 쓰지 않습니다.
//
// 회로 데이터(JSON, 프로젝트 안의 *.circuit.json 파일로 저장):
//   { v: 1, board: 'uno', boardPos: {x, y}, parts: [{ id, type, x, y, props }], wires: [{ id, a, b, color }] }
//   전선의 끝(단자) 이름: 'mcu:D13' (보드 핀) · '<부품 id>:<핀>' · '<빵판 id>:<구멍>' (예: 'b1:a12')

export const PITCH = 10; // 빵판 구멍 간격 (2.54mm)

// ───────── 보드 ─────────
function header(names, x0, y, pitch, side) {
  const seen = {};
  return names.map((name, i) => {
    if (!name) return null;
    const [id, label] = Array.isArray(name) ? name : [name, name.replace(/^D(\d)/, '$1').replace('3V3', '3.3V')];
    seen[id] = (seen[id] || 0) + 1;
    return { id: seen[id] > 1 ? `${id}.${seen[id]}` : id, label, x: x0 + i * pitch, y, side };
  }).filter(Boolean);
}
export const BOARDS = {
  uno: {
    name: '우노 (Uno R3)', w: 300, h: 200, color: '#0b7c86', chip: [150, 118, 110, 26], usb: [-8, 30, 46, 40], led: [118, 52],
    pins: [
      ...header(['GND', 'D13', 'D12', 'D11', 'D10', 'D9', 'D8', null, 'D7', 'D6', 'D5', 'D4', 'D3', 'D2', 'D1', 'D0'], 84, 12, 13, 'top'),
      ...header(['3V3', '5V', 'GND', 'GND', 'VIN', null, 'A0', 'A1', 'A2', 'A3', 'A4', 'A5'], 124, 188, 13, 'bottom'),
    ],
  },
  nano: {
    name: '나노 (Nano)', w: 236, h: 96, color: '#1d4f91', chip: [104, 34, 30, 30], usb: [-6, 30, 30, 36], led: [170, 48],
    pins: [
      ...header(['D12', 'D11', 'D10', 'D9', 'D8', 'D7', 'D6', 'D5', 'D4', 'D3', 'D2', 'GND', 'D0', 'D1'], 38, 12, 13, 'top'),
      ...header(['D13', '3V3', 'A0', 'A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'A7', '5V', 'GND', 'VIN'], 38, 84, 13, 'bottom'),
    ],
  },
  promini: {
    name: '프로 미니 (Pro Mini 5V)', w: 200, h: 96, color: '#b3261e', chip: [84, 34, 30, 30], usb: null, led: [150, 48],
    pins: [
      ...header([['VIN', 'RAW'], 'GND', ['5V', 'VCC'], 'A3', 'A2', 'A1', 'A0', 'D13', 'D12', 'D11', 'D10'], 34, 12, 13, 'top'),
      ...header(['D1', 'D0', 'GND', 'D2', 'D3', 'D4', 'D5', 'D6', 'D7', 'D8', 'D9'], 34, 84, 13, 'bottom'),
      { id: 'A4', label: 'A4', x: 130, y: 36, side: 'in' }, { id: 'A5', label: 'A5', x: 130, y: 60, side: 'in' },
      { id: 'A6', label: 'A6', x: 60, y: 36, side: 'in' }, { id: 'A7', label: 'A7', x: 60, y: 60, side: 'in' },
    ],
  },
};
export const PWM = new Set(['D3', 'D5', 'D6', 'D9', 'D10', 'D11']);

// ───────── 부품 ─────────
// pins: [이름, x, y, 표시]  (첫 핀이 기준점)   controls: 실행 중에 바꾸는 값(센서가 재는 값)   options: 부품 자체의 설정
const row = (...names) => names.map((n, i) => (Array.isArray(n) ? [n[0], i * PITCH, 0, n[1]] : [n, i * PITCH, 0, n]));
export const PART_DEFS = {
  breadboard: { name: '빵판 (브레드보드)', group: '기본', desc: '부품을 꽂는 판. 세로 5칸(a–e, f–j)이 서로 이어져 있고, 위아래 긴 줄(+ / −)은 가로로 이어져 있습니다.' },
  led: {
    name: 'LED', group: '기본', pins: [['A', 0, 0, '+'], ['K', PITCH, 0, '−']], props: { color: 'red' },
    options: [{ key: 'color', label: '색', choices: [['red', '빨강'], ['green', '초록'], ['yellow', '노랑'], ['blue', '파랑'], ['white', '흰색']] }],
    desc: '긴 다리(+)를 핀 쪽, 짧은 다리(−)를 GND 쪽으로. 반드시 저항(220Ω)과 직렬로 연결하세요.',
  },
  resistor: {
    name: '저항', group: '기본', pins: [['A', 0, 0, ''], ['B', PITCH * 4, 0, '']], props: { ohm: 220 },
    options: [{ key: 'ohm', label: '저항값', choices: [[100, '100Ω'], [220, '220Ω'], [330, '330Ω'], [1000, '1kΩ'], [4700, '4.7kΩ'], [10000, '10kΩ'], [100000, '100kΩ'], [1000000, '1MΩ']] }],
    desc: 'LED 보호, 버튼의 풀업/풀다운, 분압에 씁니다.',
  },
  button: { name: '버튼 (푸시 스위치)', group: '기본', pins: [['A', 0, 0, ''], ['B', PITCH * 2, 0, '']], props: {}, desc: '실행 중에 누르고 있는 동안 두 다리가 이어집니다. 한쪽은 핀, 한쪽은 GND 에 잇고 pinMode(핀, INPUT_PULLUP) 을 쓰면 저항이 필요 없습니다.' },
  pot: {
    name: '가변저항 (10kΩ)', group: '기본', pins: [['1', 0, 0, 'GND'], ['W', PITCH, 0, '출력'], ['2', PITCH * 2, 0, '5V']], props: { ohm: 10000, pos: 0.5 },
    controls: [{ key: 'pos', label: '돌린 정도', min: 0, max: 1, step: 0.01, scale: 100, unit: '%' }],
    desc: '양 끝을 GND 와 5V 에, 가운데를 아날로그 핀(A0)에 연결하고 analogRead 로 읽습니다.',
  },
  ldr: {
    name: '조도 센서 (CdS)', group: '기본', pins: [['A', 0, 0, ''], ['B', PITCH, 0, '']], props: { light: 50 },
    controls: [{ key: 'light', label: '밝기', min: 0, max: 100, step: 1, unit: '%' }],
    desc: '빛이 밝을수록 저항이 작아집니다. 10kΩ 저항과 분압 회로를 만들어 analogRead 로 읽습니다.',
  },
  buzzer: { name: '부저', group: '기본', pins: [['+', 0, 0, '+'], ['-', PITCH, 0, '−']], props: {}, desc: '+ 를 핀에, − 를 GND 에. tone(핀, 주파수) 로 소리를 냅니다.' },
  dht: {
    name: '온습도 센서 (DHT11 / DHT22)', short: 'DHT', group: '센서', color: '#2f80c2', pins: row('VCC', 'DATA', 'GND'), props: { temp: 25, hum: 50, model: 'DHT11' },
    options: [{ key: 'model', label: '종류', choices: [['DHT11', 'DHT11 (파란색 · 1℃ 단위)'], ['DHT22', 'DHT22 (흰색 · 0.1℃ 단위)']] }],
    controls: [{ key: 'temp', label: '온도', min: -10, max: 50, step: 0.5, unit: '℃' }, { key: 'hum', label: '습도', min: 0, max: 100, step: 1, unit: '%' }],
    desc: 'VCC → 5V, GND → GND, DATA → 디지털 핀.  #include <DHT.h> · DHT dht(2, DHT11); · dht.readTemperature()',
  },
  bmp280: {
    name: '기압 · 고도 센서 (BMP280)', short: 'BMP280', group: '센서', color: '#7b3fa0', pins: row('VCC', 'GND', 'SCL', 'SDA'), props: { temp: 25, alt: 50, sea: 1013.25, addr: 0x76 },
    options: [{ key: 'addr', label: 'I2C 주소', choices: [[0x76, '0x76 (대부분의 모듈)'], [0x77, '0x77']] }],
    controls: [{ key: 'alt', label: '고도', min: -100, max: 9000, step: 1, unit: 'm' }, { key: 'temp', label: '온도', min: -20, max: 60, step: 0.5, unit: '℃' }, { key: 'sea', label: '해수면 기압', min: 950, max: 1050, step: 0.25, unit: 'hPa' }],
    desc: 'I2C: SDA → A4, SCL → A5.  #include <Adafruit_BMP280.h> · bmp.begin(0x76) · bmp.readAltitude(1013.25)',
  },
  mpu6050: {
    name: '가속도 · 자이로 센서 (MPU6050)', short: 'MPU6050', group: '센서', color: '#23527c', pins: row('VCC', 'GND', 'SCL', 'SDA'), props: { ax: 0, ay: 0, az: 1, gx: 0, gy: 0, gz: 0, temp: 25 },
    controls: [
      { key: 'ax', label: '가속도 X', min: -2, max: 2, step: 0.01, unit: 'g' }, { key: 'ay', label: '가속도 Y', min: -2, max: 2, step: 0.01, unit: 'g' }, { key: 'az', label: '가속도 Z', min: -2, max: 2, step: 0.01, unit: 'g' },
      { key: 'gx', label: '자이로 X', min: -250, max: 250, step: 1, unit: '°/s' }, { key: 'gy', label: '자이로 Y', min: -250, max: 250, step: 1, unit: '°/s' }, { key: 'gz', label: '자이로 Z', min: -250, max: 250, step: 1, unit: '°/s' },
    ],
    desc: 'I2C: SDA → A4, SCL → A5.  Adafruit_MPU6050 · MPU6050(getMotion6) · Wire 로 직접 읽기(0x68) 모두 됩니다.',
  },
  gps: {
    name: 'GPS 모듈 (NEO-6M)', short: 'GPS', group: '센서', color: '#1f7a4a', pins: row('VCC', 'RX', 'TX', 'GND'), props: { lat: 37.5665, lng: 126.978, alt: 38, speed: 0, course: 0, sats: 8, fix: true },
    controls: [
      { key: 'lat', label: '위도', min: -90, max: 90, step: 0.0001, unit: '°' }, { key: 'lng', label: '경도', min: -180, max: 180, step: 0.0001, unit: '°' },
      { key: 'alt', label: '고도', min: 0, max: 9000, step: 1, unit: 'm' }, { key: 'speed', label: '속도', min: 0, max: 200, step: 0.5, unit: 'km/h' }, { key: 'sats', label: '위성 수', min: 0, max: 12, step: 1, unit: '개' },
    ],
    options: [{ key: 'fix', label: '수신 상태', choices: [[true, '위치 잡힘'], [false, '위성 찾는 중']] }],
    desc: 'GPS 의 TX → 아두이노의 RX 로 쓸 핀.  SoftwareSerial ss(4, 3); · ss.begin(9600) · TinyGPSPlus gps; · gps.encode(ss.read())',
  },
  hx711: {
    name: '로드셀 + HX711 (무게)', short: 'HX711', group: '센서', color: '#3d6b2e', pins: row('VCC', 'DT', 'SCK', 'GND'), props: { weight: 0 },
    controls: [{ key: 'weight', label: '올린 무게', min: 0, max: 5000, step: 1, unit: 'g' }],
    desc: 'HX711 scale; · scale.begin(DT핀, SCK핀) · scale.set_scale(430) (이 로드셀의 보정값) · scale.tare() · scale.get_units(10) → g',
  },
  hcsr04: {
    name: '초음파 거리 센서 (HC-SR04)', short: 'HC-SR04', group: '센서', color: '#2a6f97', pins: row('VCC', 'TRIG', 'ECHO', 'GND'), props: { dist: 50 },
    controls: [{ key: 'dist', label: '물체까지 거리', min: 2, max: 400, step: 1, unit: 'cm' }],
    desc: 'TRIG 에 10μs 펄스를 준 뒤 pulseIn(ECHO, HIGH) 로 시간을 재고, 거리(cm) = 시간 / 58.',
  },
  servo: { name: '서보 모터 (SG90)', short: 'SERVO', group: '출력', color: '#3f51b5', pins: row('GND', 'VCC', 'SIG'), props: {}, desc: '#include <Servo.h> · servo.attach(9) · servo.write(각도 0~180)' },
  lcd: { name: 'LCD 16x2 (I2C)', short: 'LCD', group: '출력', color: '#2e7d32', pins: row('GND', 'VCC', 'SDA', 'SCL'), props: {}, desc: 'I2C: SDA → A4, SCL → A5.  LiquidCrystal_I2C lcd(0x27, 16, 2); · lcd.init() · lcd.backlight() · lcd.print("안녕")' },
};
Object.setPrototypeOf(PART_DEFS, null); // 'constructor' 같은 이름의 부품 종류가 걸리지 않게
Object.setPrototypeOf(BOARDS, null);
export const WIRE_COLORS = ['#e53935', '#212121', '#fdd835', '#43a047', '#1e88e5', '#fb8c00', '#8e24aa', '#f5f5f5'];

// ───────── 빵판 ─────────
export const BB = { cols: 30, w: 330, h: 184, x0: 20 };
const BB_ROWS = [['tp', 12], ['tn', 22], ['a', 42], ['b', 52], ['c', 62], ['d', 72], ['e', 82], ['f', 102], ['g', 112], ['h', 122], ['i', 132], ['j', 142], ['bp', 162], ['bn', 172]];
export function bbHoles() { // [{ name, x, y, row, col }] — 빵판 왼쪽 위 기준
  const out = [];
  for (const [rowName, y] of BB_ROWS) for (let c = 1; c <= BB.cols; c++) out.push({ name: `${rowName}${c}`, x: BB.x0 + (c - 1) * PITCH, y, row: rowName, col: c });
  return out;
}
const BB_ROW_Y = Object.fromEntries(BB_ROWS);
function holePos(name) {
  const m = /^(tp|tn|bp|bn|[a-j])(\d+)$/.exec(name);
  if (!m || !(Number(m[2]) >= 1 && Number(m[2]) <= BB.cols)) return null;
  return { x: BB.x0 + (Number(m[2]) - 1) * PITCH, y: BB_ROW_Y[m[1]], row: m[1], col: Number(m[2]) };
}
/** 빵판 안에서 서로 이어진 줄의 이름 */
const strip = (h) => (h.row.length === 2 ? h.row : `${'abcde'.includes(h.row) ? 'T' : 'B'}${h.col}`);
/** 빵판 위의 좌표 → 가장 가까운 구멍 (없으면 null) */
export function holeNear(bb, x, y, tol = PITCH * 0.6) {
  const col = Math.round((x - bb.x - BB.x0) / PITCH) + 1;
  if (col < 1 || col > BB.cols) return null;
  let best = null;
  for (const [rowName, ry] of BB_ROWS) { const d = Math.abs(y - bb.y - ry); if (d <= tol && (!best || d < best.d)) best = { d, row: rowName }; }
  if (!best || Math.abs(x - bb.x - BB.x0 - (col - 1) * PITCH) > tol) return null;
  return { name: `${best.row}${col}`, x: bb.x + BB.x0 + (col - 1) * PITCH, y: bb.y + BB_ROW_Y[best.row] };
}

// ───────── 좌표 ─────────
export const pinsOf = (part) => (PART_DEFS[part.type]?.pins || []).map(([name, x, y, label]) => ({ name, label, tid: `${part.id}:${name}`, x: part.x + x, y: part.y + y }));
export const boardPins = (circuit) => { const b = BOARDS[circuit.board] || BOARDS.uno; const o = circuit.boardPos || { x: 0, y: 0 }; return b.pins.map((p) => ({ ...p, tid: `mcu:${p.id}`, x: o.x + p.x, y: o.y + p.y })); };

/** 단자 이름 → 화면 좌표 (없으면 null) */
export function terminalPos(circuit, tid) {
  const k = tid.indexOf(':');
  const owner = tid.slice(0, k);
  const name = tid.slice(k + 1);
  if (owner === 'mcu') { const p = boardPins(circuit).find((x) => x.id === name); return p ? { x: p.x, y: p.y } : null; }
  const part = circuit.parts.find((p) => p.id === owner);
  if (!part) return null;
  if (part.type === 'breadboard') { const h = holePos(name); return h ? { x: part.x + h.x, y: part.y + h.y } : null; }
  const pin = pinsOf(part).find((p) => p.name === name);
  return pin ? { x: pin.x, y: pin.y } : null;
}

/** 부품을 놓을 때: 첫 핀이 빵판 구멍 근처면 구멍에 딱 맞춤 */
export function snapPart(circuit, part) {
  if (part.type === 'breadboard') return false;
  for (const bb of circuit.parts) {
    if (bb.type !== 'breadboard') continue;
    const h = holeNear(bb, part.x, part.y, PITCH * 0.75);
    if (h) { part.x = h.x; part.y = h.y; return true; }
  }
  return false;
}

// ───────── 넷리스트 ─────────
/** 회로 → 런타임이 쓰는 연결 정보 { n, pins: { D13: 노드 }, parts: [{ id, type, props, pins: { 이름: 노드 } }], short } */
export function buildNetlist(circuit) {
  const parent = new Map();
  const find = (a) => { if (!parent.has(a)) parent.set(a, a); let r = a; while (parent.get(r) !== r) r = parent.get(r); let c = a; while (parent.get(c) !== r) { const nx = parent.get(c); parent.set(c, r); c = nx; } return r; };
  const union = (a, b) => { const x = find(a); const y = find(b); if (x !== y) parent.set(x, y); };
  const board = BOARDS[circuit.board] || BOARDS.uno;
  const base = (id) => id.split('.')[0];
  for (const p of board.pins) union(`mcu:${p.id}`, `mcu:${base(p.id)}`); // GND 여러 개는 하나
  const boards = circuit.parts.filter((p) => p.type === 'breadboard');
  for (const bb of boards) for (const h of bbHoles()) union(`${bb.id}:${h.name}`, `${bb.id}:#${strip(h)}`);
  const parts = circuit.parts.filter((p) => p.type !== 'breadboard' && PART_DEFS[p.type]);
  for (const part of parts) {
    for (const pin of pinsOf(part)) {
      find(pin.tid);
      for (const bb of boards) { const h = holeNear(bb, pin.x, pin.y, 2.5); if (h) union(pin.tid, `${bb.id}:${h.name}`); }
    }
  }
  const valid = (tid) => terminalPos(circuit, tid) !== null;
  for (const w of circuit.wires || []) if (valid(w.a) && valid(w.b)) union(w.a, w.b);
  const ids = new Map();
  const nodeOf = (tid) => { const r = find(tid); if (!ids.has(r)) ids.set(r, ids.size); return ids.get(r); };
  const pins = {};
  for (const p of board.pins) pins[base(p.id)] = nodeOf(`mcu:${base(p.id)}`);
  const outParts = parts.map((part) => ({ id: part.id, type: part.type, props: { ...PART_DEFS[part.type].props, ...part.props }, pins: Object.fromEntries(pinsOf(part).map((pin) => [pin.name, nodeOf(pin.tid)])) }));
  const short = pins.GND !== undefined && ['5V', '3V3', 'VIN'].some((k) => pins[k] !== undefined && pins[k] === pins.GND);
  return { n: ids.size, board: circuit.board, pins, parts: outParts, short };
}

// ───────── 새 회로 ─────────
let seq = 0;
export const newId = (prefix = 'p') => `${prefix}${Date.now().toString(36)}${(seq++).toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;
export const emptyCircuit = (board = 'uno') => ({ v: 1, board, boardPos: { x: 20, y: 20 }, parts: [], wires: [] });

/** 빵판에 LED + 저항이 D13 에 연결된 시작 회로 (깜빡이기 예제용) */
export function starterCircuit() {
  const c = emptyCircuit('uno');
  const bb = { id: 'bb1', type: 'breadboard', x: 0, y: 250, props: {} };
  const at = (hole) => { const h = holePos(hole); return { x: bb.x + h.x, y: bb.y + h.y }; };
  c.parts.push(bb,
    { id: 'led1', type: 'led', ...at('c12'), props: { color: 'red' } },
    { id: 'r1', type: 'resistor', ...at('d13'), props: { ohm: 220 } });
  c.wires.push(
    { id: 'w1', a: 'mcu:D13', b: 'bb1:a12', color: WIRE_COLORS[0] },
    { id: 'w2', a: 'bb1:a17', b: 'bb1:tn17', color: WIRE_COLORS[1] },
    { id: 'w3', a: 'bb1:tn1', b: 'mcu:GND.2', color: WIRE_COLORS[1] });
  return c;
}

export const STARTER_SKETCH = `// LED 깜빡이기 + 시리얼 모니터
// ▶ 실행을 누르면 오른쪽 회로의 LED 가 깜빡이고, 아래 시리얼 모니터에 글자가 나옵니다.
const int LED = 13;
int count = 0;

void setup() {
  Serial.begin(9600);
  pinMode(LED, OUTPUT);
  Serial.println("시작!");
}

void loop() {
  digitalWrite(LED, HIGH);
  delay(500);
  digitalWrite(LED, LOW);
  delay(500);

  count++;
  Serial.print("깜빡인 횟수: ");
  Serial.println(count);
}
`;

/** 저장된 JSON 을 안전하게 읽음 (모양이 틀리면 null) */
export function parseCircuit(text) {
  try {
    const c = JSON.parse(text);
    if (!c || typeof c !== 'object' || !Array.isArray(c.parts) || !Array.isArray(c.wires)) return null;
    const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
    return {
      v: 1,
      board: BOARDS[c.board] ? c.board : 'uno',
      boardPos: { x: num(c.boardPos?.x), y: num(c.boardPos?.y) },
      parts: c.parts.filter((p) => p && typeof p.id === 'string' && /^[\w-]{1,40}$/.test(p.id) && p.id !== 'mcu' && PART_DEFS[p.type]).slice(0, 200)
        .map((p) => ({ id: p.id, type: p.type, x: num(p.x), y: num(p.y), props: p.props && typeof p.props === 'object' ? { ...p.props } : {} })),
      wires: c.wires.filter((w) => w && typeof w.a === 'string' && typeof w.b === 'string').slice(0, 500)
        .map((w) => ({ id: typeof w.id === 'string' ? w.id : newId('w'), a: w.a, b: w.b, color: /^#[0-9a-fA-F]{3,8}$/.test(w.color) ? w.color : WIRE_COLORS[0] })),
    };
  } catch { return null; }
}
