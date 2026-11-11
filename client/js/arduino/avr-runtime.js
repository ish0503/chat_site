// 실제 기계어 실행기: 서버의 avr-gcc 가 만든 .hex 를 ATmega328P 에뮬레이터(avr8js)에서 그대로 실행합니다.
// 스케치의 함수 호출을 가로채지 않으므로, 부품은 "핀에 나타나는 신호"로 흉내 냅니다.
//   · LED · 저항 · 버튼 · 가변저항 · 조도 센서: 회로 계산(circuit-sim.js) → 입력 핀 전압 · ADC 값
//   · DHT: 1-wire 응답 파형 (80μs + 40비트)        · HC-SR04: TRIG 펄스 → ECHO 펄스 길이
//   · HX711: SCK 에 맞춰 24비트를 한 비트씩          · GPS: 9600bps 직렬 파형으로 NMEA 문장
//   · MPU6050 · BMP280 · LCD(PCF8574 + HD44780): I2C 레지스터 수준
//   · 서보: 신호선의 펄스 폭(544~2400μs) → 각도     · 부저: 핀이 켜졌다 꺼지는 주파수
import {
  CPU, avrInstruction, AVRIOPort, portBConfig, portCConfig, portDConfig, AVRTimer, timer0Config, timer1Config, timer2Config,
  AVRUSART, usart0Config, AVRADC, adcConfig, AVRTWI, twiConfig, AVRSPI, spiConfig, AVREEPROM, EEPROMMemoryBackend, eepromConfig,
  AVRClock, clockConfig, AVRWatchdog, watchdogConfig, PinState,
} from './vendor/avr8js.js';
import { INPUT, OUTPUT, INPUT_PULLUP, LED_BURN_MA, NEEDS_5V, pinName, solveCircuit } from './circuit-sim.js';
import { extraMakers } from './avr-parts.js';

const F_CPU = 16_000_000;
const US = F_CPU / 1e6; // 1μs = 16 클럭
const FRAME = F_CPU / 100; // 10ms 마다 상태 정리
const noise = (amp) => (Math.random() - 0.5) * 2 * amp;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const pinLabel = pinName;

/** Intel HEX → 프로그램 메모리 */
export function loadHex(hex, target) {
  for (const line of hex.split('\n')) {
    if (line[0] !== ':' || line.substr(7, 2) !== '00') continue;
    const len = parseInt(line.substr(1, 2), 16);
    const addr = parseInt(line.substr(3, 4), 16);
    for (let i = 0; i < len; i++) target[addr + i] = parseInt(line.substr(9 + i * 2, 2), 16);
  }
}

// BMP280: 데이터시트의 보정값 예시. 원하는 온도 · 기압이 나오도록 센서의 원시값(ADC)을 거꾸로 구함
const BMP_CAL = { T1: 27504, T2: 26435, T3: -1000, P1: 36477, P2: -10685, P3: 3024, P4: 2855, P5: 140, P6: -7, P7: 15500, P8: -14600, P9: 6000 };
function bmpTemp(adcT) {
  const c = BMP_CAL;
  const v1 = (adcT / 16384 - c.T1 / 1024) * c.T2;
  const v2 = ((adcT / 131072 - c.T1 / 8192) ** 2) * c.T3;
  return v1 + v2; // t_fine (온도 = t_fine / 5120)
}
function bmpPress(adcP, tFine) {
  const c = BMP_CAL;
  let v1 = tFine / 2 - 64000;
  let v2 = (v1 * v1 * c.P6) / 32768;
  v2 += v1 * c.P5 * 2;
  v2 = v2 / 4 + c.P4 * 65536;
  v1 = ((c.P3 * v1 * v1) / 524288 + c.P2 * v1) / 524288;
  v1 = (1 + v1 / 32768) * c.P1;
  let p = 1048576 - adcP;
  p = ((p - v2 / 4096) * 6250) / v1;
  v1 = (c.P9 * p * p) / 2147483648;
  v2 = (p * c.P8) / 32768;
  return p + (v1 + v2 + c.P7) / 16;
}
function bisect(fn, target, increasing) {
  let lo = 0; let hi = 0xFFFFF;
  for (let i = 0; i < 24; i++) { const mid = (lo + hi) / 2; if ((fn(mid) < target) === increasing) lo = mid; else hi = mid; }
  return Math.round((lo + hi) / 2);
}
export function bmpRaw(tempC, pressPa) {
  const adcT = bisect((a) => bmpTemp(a) / 5120, tempC, true);
  const tFine = bmpTemp(adcT);
  return { adcT, adcP: bisect((a) => bmpPress(a, tFine), pressPa, false) };
}

function nmea(pr, date) {
  const two = (v) => String(v).padStart(2, '0');
  const time = `${two(date.getUTCHours())}${two(date.getUTCMinutes())}${two(date.getUTCSeconds())}.00`;
  const day = `${two(date.getUTCDate())}${two(date.getUTCMonth() + 1)}${two(date.getUTCFullYear() % 100)}`;
  const coord = (v, w) => { const a = Math.abs(v); const deg = Math.floor(a); return `${String(deg).padStart(w, '0')}${((a - deg) * 60).toFixed(4).padStart(7, '0')}`; };
  const sum = (s) => { let c = 0; for (const x of s) c ^= x.charCodeAt(0); return `$${s}*${c.toString(16).toUpperCase().padStart(2, '0')}\r\n`; };
  const fix = pr.fix !== false && pr.fix !== 0;
  const lat = Number(pr.lat) + noise(0.000004); const lng = Number(pr.lng) + noise(0.000004);
  const pos = fix ? `${coord(lat, 2)},${lat >= 0 ? 'N' : 'S'},${coord(lng, 3)},${lng >= 0 ? 'E' : 'W'}` : ',,,';
  return sum(`GPGGA,${time},${pos},${fix ? 1 : 0},${two(fix ? Math.round(Number(pr.sats) || 8) : 0)},${fix ? '0.9' : '99.9'},${fix ? (Number(pr.alt) || 0).toFixed(1) : ''},M,0.0,M,,`)
    + sum(`GPRMC,${time},${fix ? 'A' : 'V'},${pos},${fix ? ((Number(pr.speed) || 0) / 1.852).toFixed(2) : ''},${fix ? (Number(pr.course) || 0).toFixed(1) : ''},${day},,,${fix ? 'A' : 'N'}`);
}

/**
 * @param {object} io { post(msg) }
 */
export function createAvrRuntime({ post }) {
  const cpu = new CPU(new Uint16Array(0x8000 / 2));
  const portB = new AVRIOPort(cpu, portBConfig);
  const portC = new AVRIOPort(cpu, portCConfig);
  const portD = new AVRIOPort(cpu, portDConfig);
  const usart = new AVRUSART(cpu, usart0Config, F_CPU);
  const adc = new AVRADC(cpu, adcConfig);
  const twi = new AVRTWI(cpu, twiConfig, F_CPU);
  /* eslint-disable no-new */
  new AVRTimer(cpu, timer0Config); new AVRTimer(cpu, timer1Config); new AVRTimer(cpu, timer2Config);
  const spi = new AVRSPI(cpu, spiConfig, F_CPU);
  new AVREEPROM(cpu, new EEPROMMemoryBackend(1024), eepromConfig);
  new AVRWatchdog(cpu, watchdogConfig, new AVRClock(cpu, F_CPU, clockConfig));
  /* eslint-enable no-new */
  const PORTS = [[portD, 0, 8], [portB, 8, 6], [portC, 14, 6]];
  const portOf = (pin) => (pin < 8 ? [portD, pin] : pin < 14 ? [portB, pin - 8] : [portC, pin - 14]);

  const pins = Array.from({ length: 22 }, () => ({ mode: INPUT, out: 0, pwm: null, tone: 0, used: false }));
  const raw = new Array(20).fill(PinState.Input);
  const track = Array.from({ length: 20 }, () => ({ rise: 0, prevRise: -1, pulse: 0, period: 0, duty: 0, edges: 0, fast: false, level: 0 }));
  let net = { n: 0, pins: {}, parts: [] };
  let sol = { V: new Float64Array(0), floating: [], leds: new Map() };
  let dirty = true;
  let changed = true;
  let stopped = false;
  let nextFrame = FRAME;
  let lastReport = '';
  const hints = new Set();
  const burnt = new Set();
  const overSince = new Map();
  const driven = new Map(); // 노드 → 부품이 내보내는 값 (0 | 1)
  const pstate = new Map();
  const devices = new Map(); // 부품 id → 장치 모델
  let lineListeners = new Map(); // 노드 → [장치]
  let pinsOnNode = new Map();
  const wallStart = Date.now();
  let speed = 1;

  const hint = (text) => { if (hints.has(text)) return; hints.add(text); post({ type: 'hint', text }); };
  const node = (pin) => net.pins[pinName(pin)];
  const simMs = () => cpu.cycles / (F_CPU / 1000);
  const after = (us, fn) => cpu.addClockEvent(fn, Math.max(1, Math.round(us * US)));

  // ───────── 회로 ↔ 핀 ─────────
  function applyPin(pin) {
    const nd = node(pin);
    const tr = track[Math.min(pin, 19)];
    let level; let volts;
    if (nd !== undefined && driven.has(nd)) { level = driven.get(nd); volts = level * 5; } else if (nd === undefined || sol.floating[nd]) { level = Math.random() < 0.5 ? 1 : 0; volts = 1.4 + Math.random(); } else {
      volts = sol.V[nd];
      level = volts > 3 ? 1 : volts < 1.5 ? 0 : tr.level; // 그 사이 전압은 이전 값을 유지 (실제 입력의 히스테리시스)
    }
    if (pin >= 14) adc.channelValues[pin - 14] = clamp(volts, 0, 5);
    if (pin < 20) { tr.level = level; const [port, bit] = portOf(pin); port.setPin(bit, !!level); }
  }
  function resolve() {
    dirty = false;
    changed = true;
    sol = solveCircuit(net, pins, burnt);
    for (let pin = 0; pin < 22; pin++) applyPin(pin);
    const now = simMs();
    for (const [id, mA] of sol.leds) { if (mA > LED_BURN_MA) { if (!overSince.has(id)) overSince.set(id, now); } else overSince.delete(id); }
    for (const id of [...overSince.keys()]) if (!sol.leds.has(id)) overSince.delete(id);
  }
  const ensure = () => { if (dirty) resolve(); };
  const voltAt = (k) => { ensure(); return k === undefined || sol.floating[k] ? null : sol.V[k]; };
  function supply(part) { const a = voltAt(part.pins.VCC); const b = voltAt(part.pins.GND); return a === null || b === null ? 0 : a - b; }
  const powered = (part) => supply(part) >= (NEEDS_5V.has(part.type) ? 4.5 : 3.0);
  /** 부품이 선을 0/1 로 당기거나(level) 놓음(null) */
  function drive(nd, level) {
    if (nd === undefined) return;
    if (level === null) driven.delete(nd); else driven.set(nd, level);
    for (const pin of pinsOnNode.get(nd) || []) applyPin(pin);
  }
  /** 아두이노가 그 선을 직접 0 또는 1 로 내보내고 있으면 그 값, 아니면 null */
  function mcuDrive(nd) {
    for (const pin of pinsOnNode.get(nd) || []) { if (pin < 20 && raw[pin] === PinState.Low) return 0; }
    for (const pin of pinsOnNode.get(nd) || []) { if (pin < 20 && raw[pin] === PinState.High) return 1; }
    return null;
  }

  function onPort(port, base, count) {
    for (let b = 0; b < count; b++) {
      const pin = base + b;
      const s = port.pinState(b);
      const prev = raw[pin];
      if (s === prev) continue;
      raw[pin] = s;
      const p = pins[pin];
      const tr = track[pin];
      const t = cpu.cycles;
      p.used = true;
      if (s === PinState.High) {
        if (tr.prevRise >= 0) { tr.period = t - tr.prevRise; tr.duty = tr.period > 0 ? clamp(tr.pulse / tr.period, 0, 1) : 0; }
        tr.prevRise = t; tr.rise = t;
      } else if (prev === PinState.High) tr.pulse = t - tr.rise;
      const wasOut = prev === PinState.High || prev === PinState.Low;
      p.mode = s === PinState.High || s === PinState.Low ? OUTPUT : s === PinState.InputPullUp ? INPUT_PULLUP : INPUT;
      if (p.mode === OUTPUT) p.out = s === PinState.High ? 1 : 0;
      // PWM 처럼 출력이 빠르게 켜졌다 꺼지는 것만 "평균"으로 다루고, 입력 ↔ 출력이 바뀌면 회로를 바로 다시 계산
      if (wasOut && p.mode === OUTPUT) { tr.edges++; if (!tr.fast) dirty = true; } else { tr.fast = false; p.pwm = null; dirty = true; }
      const nd = node(pin);
      if (nd !== undefined) for (const dev of lineListeners.get(nd) || []) dev.onLine(nd, t);
    }
  }
  for (const [port, base, count] of PORTS) port.addListener(() => onPort(port, base, count));
  // 입력 핀 · ADC 를 읽는 순간에는 회로가 최신 상태여야 함
  for (const addr of [portBConfig.PIN, portCConfig.PIN, portDConfig.PIN]) cpu.readHooks[addr] = () => { if (dirty) resolve(); return cpu.data[addr]; };
  const adcRead = adc.onADCRead.bind(adc);
  adc.onADCRead = (input) => { if (dirty) resolve(); adcRead(input); };

  // ───────── 시리얼 ─────────
  const decoder = new TextDecoder('utf-8');
  let txBytes = [];
  const rxQueue = [];
  usart.onByteTransmit = (b) => { txBytes.push(b); };
  usart.onConfigurationChange = () => { post({ type: 'baud', baud: Math.round(usart.baudRate / 100) * 100 > 50000 ? Math.round(usart.baudRate / 100) * 100 : nearestBaud(usart.baudRate) }); };
  function nearestBaud(b) { return [300, 1200, 2400, 4800, 9600, 14400, 19200, 28800, 38400, 57600, 115200].reduce((x, y) => (Math.abs(y - b) < Math.abs(x - b) ? y : x)); }
  function pumpRx() { while (rxQueue.length && !usart.rxBusy) { if (usart.writeByte(rxQueue[0]) === false) { rxQueue.length = 0; return; } rxQueue.shift(); } }
  usart.onRxComplete = () => pumpRx();
  function flushTx() { if (!txBytes.length) return; const text = decoder.decode(Uint8Array.from(txBytes), { stream: true }); txBytes = []; if (text) post({ type: 'serial', text }); }

  // ───────── 부품 모델 ─────────
  const makers = {
    dht(dev) {
      let lowSince = -1; let busy = false;
      dev.lines = ['DATA'];
      dev.onLine = (nd, t) => {
        if (busy) return;
        const d = mcuDrive(nd);
        if (d === 0) { if (lowSince < 0) lowSince = t; return; }
        if (lowSince < 0) return;
        const lowUs = (t - lowSince) / US;
        lowSince = -1;
        const pr = dev.part.props;
        const is11 = pr.model !== 'DHT22';
        if (powered(dev.part) && is11 && lowUs >= 500 && lowUs < 10000) hint('온습도 센서: 회로의 센서는 DHT11 인데 스케치가 DHT22 방식(짧은 시작 신호)으로 읽고 있어 응답하지 않습니다. 부품의 종류나 스케치의 DHT11 / DHT22 를 맞추세요.');
        if (!powered(dev.part) || lowUs < (is11 ? 10000 : 800)) return; // 시작 신호가 너무 짧으면 응답하지 않음
        const bytes = is11
          ? [clamp(Math.round(Number(pr.hum)), 0, 100), 0, clamp(Math.round(Number(pr.temp)), 0, 60), 0]
          : (() => { const h = clamp(Math.round((Number(pr.hum) + noise(0.2)) * 10), 0, 1000); const tv = Math.round((Number(pr.temp) + noise(0.1)) * 10); const tt = tv < 0 ? (0x8000 | -tv) : tv; return [h >> 8, h & 255, tt >> 8, tt & 255]; })();
        bytes.push(bytes.reduce((a, b) => a + b, 0) & 255);
        // 응답: 25μs 뒤 80μs LOW → 80μs HIGH → 비트마다 50μs LOW + (0: 27μs, 1: 70μs) HIGH
        const edges = [[25, 0], [105, 1]];
        let at = 185;
        for (const byte of bytes) for (let bit = 7; bit >= 0; bit--) { edges.push([at, 0]); at += 50; edges.push([at, 1]); at += (byte >> bit) & 1 ? 70 : 27; }
        edges.push([at, 0], [at + 50, null]);
        busy = true;
        const dataNode = dev.part.pins.DATA;
        for (const [us, level] of edges) after(us, () => { drive(dataNode, level); if (level === null) busy = false; });
      };
    },
    hcsr04(dev) {
      let highSince = -1;
      dev.lines = ['TRIG'];
      dev.refresh = () => { if (powered(dev.part)) { if (!driven.has(dev.part.pins.ECHO)) drive(dev.part.pins.ECHO, 0); } else drive(dev.part.pins.ECHO, null); };
      dev.onLine = (nd, t) => {
        const d = mcuDrive(nd);
        if (d === 1) { highSince = t; return; }
        if (highSince < 0) return;
        const us = (t - highSince) / US;
        highSince = -1;
        if (us < 8 || !powered(dev.part) || dev.busy) return; // 10μs 보다 짧은 TRIG 는 무시
        const dist = Number(dev.part.props.dist);
        const echo = dist >= 2 && dist <= 400 ? dist * 58.2 * (1 + noise(0.003)) : 38000; // 범위 밖이면 38ms 뒤 포기
        dev.busy = true;
        const e = dev.part.pins.ECHO;
        after(460, () => drive(e, 1));
        after(460 + echo, () => { drive(e, 0); dev.busy = false; });
      };
    },
    hx711(dev) {
      let bit = 0; let value = 0; let ready = false; let sckHigh = false;
      dev.lines = ['SCK'];
      const sample = () => {
        if (!powered(dev.part)) { ready = false; drive(dev.part.pins.DT, null); return; }
        value = Math.round(84210 + (Number(dev.part.props.weight) || 0) * 430 + noise(25)) & 0xFFFFFF;
        bit = 0; ready = true;
        drive(dev.part.pins.DT, 0); // 준비되면 DT 가 LOW
      };
      dev.refresh = () => { if (!powered(dev.part)) { ready = false; drive(dev.part.pins.DT, null); } else if (!ready) { drive(dev.part.pins.DT, 1); if (!dev.pending) { dev.pending = true; after(100000, () => { dev.pending = false; sample(); }); } } }; // 준비 전에는 DT 가 HIGH
      dev.onLine = (nd) => {
        const up = mcuDrive(nd) === 1;
        if (up === sckHigh) return;
        sckHigh = up;
        if (!up || !ready) return;
        bit++;
        if (bit <= 24) drive(dev.part.pins.DT, (value >> (24 - bit)) & 1);
        else { drive(dev.part.pins.DT, 1); if (!dev.pending) { ready = false; dev.pending = true; after(100000, () => { dev.pending = false; sample(); }); } } // 다음 값은 0.1초 뒤 (초당 10번)
      };
    },
    servo(dev) {
      dev.lines = ['SIG'];
      let rise = -1;
      dev.onLine = (nd, t) => {
        const d = mcuDrive(nd);
        if (d === 1) { rise = t; return; }
        if (rise < 0) return;
        const us = (t - rise) / US;
        rise = -1;
        if (us < 400 || us > 2700 || !powered(dev.part)) return;
        const a = Math.round(clamp(((us - 544) * 180) / (2400 - 544), 0, 180));
        if (pstate.get(dev.part.id)?.a !== a) { pstate.set(dev.part.id, { a }); changed = true; }
      };
    },
    gps(dev) {
      dev.refresh = () => { if (powered(dev.part)) { if (!dev.sending && !driven.has(dev.part.pins.TX)) drive(dev.part.pins.TX, 1); } else if (!dev.sending) drive(dev.part.pins.TX, null); };
      dev.second = () => {
        if (!powered(dev.part) || dev.sending || dev.part.pins.TX === undefined) return;
        const text = nmea(dev.part.props, new Date(wallStart + simMs()));
        const tx = dev.part.pins.TX;
        if ((pinsOnNode.get(tx) || []).includes(0)) { // 하드웨어 시리얼(D0)로 받는 경우
          if (Math.abs(usart.baudRate - 9600) < 300) for (const ch of text) rxQueue.push(ch.charCodeAt(0)); else for (let i = 0; i < 40; i++) rxQueue.push(128 + Math.floor(Math.random() * 100));
          pumpRx();
        }
        // 9600bps 파형: 시작 비트(0) + 8비트(낮은 자리부터) + 정지 비트(1)
        const bitCycles = F_CPU / 9600;
        const edges = [];
        let level = 1; let k = 0;
        for (const ch of text) {
          const frame = [0, ...Array.from({ length: 8 }, (_, i) => (ch.charCodeAt(0) >> i) & 1), 1];
          for (const b of frame) { if (b !== level) { edges.push([Math.round(k * bitCycles), b]); level = b; } k++; }
        }
        dev.sending = true;
        const start = cpu.cycles + 16;
        let i = 0;
        const next = () => {
          drive(tx, edges[i][1]);
          i++;
          if (i < edges.length) cpu.addClockEvent(next, Math.max(1, start + edges[i][0] - cpu.cycles)); else dev.sending = false;
        };
        cpu.addClockEvent(next, Math.max(1, start + edges[0][0] - cpu.cycles));
      };
    },
    mpu6050(dev) {
      const regs = new Uint8Array(128);
      const reset = () => { regs.fill(0); regs[0x75] = 0x68; regs[0x6B] = 0x40; };
      reset();
      let ptr = 0; let first = true; let data = new Uint8Array(14);
      const latch = () => {
        const pr = dev.part.props;
        const asleep = regs[0x6B] & 0x40;
        const aLsb = 16384 >> ((regs[0x1C] >> 3) & 3);
        const gLsb = 131 / (1 << ((regs[0x1B] >> 3) & 3));
        const s16 = (v) => clamp(Math.round(v), -32768, 32767) & 0xFFFF;
        const words = asleep ? new Array(7).fill(0) : [
          ...['ax', 'ay', 'az'].map((k) => s16((Number(pr[k]) || 0) * aLsb + noise(aLsb / 500))),
          s16(((Number(pr.temp) || 25) - 36.53) * 340),
          ...['gx', 'gy', 'gz'].map((k) => s16((Number(pr[k]) || 0) * gLsb + noise(gLsb / 30))),
        ];
        data = Uint8Array.from(words.flatMap((w) => [w >> 8, w & 255]));
      };
      dev.i2c = {
        addr: 0x68,
        begin() { first = true; },
        write(v) { if (first) { ptr = v & 127; first = false; return; } if (ptr === 0x6B && v & 0x80) reset(); else regs[ptr] = v; ptr = (ptr + 1) & 127; },
        read() { if (ptr === 0x3B) latch(); const v = ptr >= 0x3B && ptr <= 0x48 ? data[ptr - 0x3B] : regs[ptr]; ptr = (ptr + 1) & 127; return v; },
      };
    },
    bmp280(dev) {
      const regs = new Uint8Array(256);
      const init = () => {
        regs.fill(0); regs[0xD0] = 0x58;
        Object.values(BMP_CAL).forEach((v, i) => { regs[0x88 + i * 2] = v & 255; regs[0x89 + i * 2] = (v >> 8) & 255; });
      };
      init();
      let ptr = 0; let first = true; let data = new Uint8Array(6);
      const latch = () => {
        const pr = dev.part.props;
        let adcT = 0x80000; let adcP = 0x80000; // 측정 모드가 아니면(sleep) 초기값 그대로
        if (regs[0xF4] & 3) {
          const press = (Number(pr.sea) || 1013.25) * 100 * (1 - (Number(pr.alt) || 0) / 44330) ** 5.255;
          ({ adcT, adcP } = bmpRaw(Number(pr.temp) + noise(0.01), press + noise(1.5)));
        }
        data = Uint8Array.from([adcP >> 12, (adcP >> 4) & 255, (adcP << 4) & 255, adcT >> 12, (adcT >> 4) & 255, (adcT << 4) & 255]);
      };
      dev.i2c = {
        get addr() { return Number(dev.part.props.addr) === 0x77 ? 0x77 : 0x76; },
        begin() { first = true; },
        write(v) { if (first) { ptr = v; first = false; return; } if (ptr === 0xE0 && v === 0xB6) init(); else if (ptr === 0xF4 || ptr === 0xF5) regs[ptr] = v; ptr = (ptr + 1) & 255; },
        read() { if (ptr === 0xF7 || ptr === 0xFA) latch(); const v = ptr >= 0xF7 && ptr <= 0xFC ? data[ptr - 0xF7] : regs[ptr]; ptr = (ptr + 1) & 255; return v; },
      };
    },
    lcd(dev) {
      // PCF8574 (P0=RS, P2=EN, P3=백라이트, P4~P7=데이터) 뒤의 HD44780
      let last = 0; let fourBit = false; let high = -1; let addr = 0; let on = false; let light = false; let inc = 1;
      const ram = new Uint8Array(128).fill(32);
      const show = () => {
        const line = (base) => Array.from(ram.slice(base, base + 16), (c) => (c >= 32 && c < 127 ? String.fromCharCode(c) : c < 8 ? '▯' : '▒')).join('');
        const next = { l: on ? [line(0), line(0x40)] : [], b: light ? 1 : 0 };
        if (JSON.stringify(pstate.get(dev.part.id)) !== JSON.stringify(next)) { pstate.set(dev.part.id, next); changed = true; }
      };
      const command = (c) => {
        if (c & 0x80) addr = c & 0x7F;
        else if (c & 0x40) { /* CGRAM (사용자 글자)은 그리지 않음 */ } else if (c & 0x20) { /* 기능 설정 */ } else if (c & 0x10) addr = (addr + (c & 4 ? 1 : -1)) & 0x7F;
        else if (c & 0x08) on = !!(c & 4);
        else if (c & 0x04) inc = c & 2 ? 1 : -1;
        else if (c & 0x02) addr = 0;
        else if (c & 0x01) { ram.fill(32); addr = 0; }
      };
      const byte = (rs, v) => { if (rs) { ram[addr & 0x7F] = v; addr = (addr + inc) & 0x7F; } else command(v); show(); };
      dev.off = () => { fourBit = false; high = -1; on = false; light = false; ram.fill(32); addr = 0; last = 0; };
      dev.i2c = {
        addr: 0x27,
        begin() {},
        write(v) {
          light = !!(v & 8);
          if ((last & 4) && !(v & 4)) { // EN 이 내려갈 때 4비트를 읽음
            const nib = last >> 4; const rs = last & 1;
            if (!fourBit) { if (!rs && nib === 2) fourBit = true; } else if (high < 0) high = nib; else { byte(rs, (high << 4) | nib); high = -1; }
          }
          last = v;
          show();
        },
        read() { return 0xFF; },
      };
    },
  };

  Object.assign(makers, extraMakers({
    cpu, US, drive, after, powered, mcuDrive, pstate, hint, node, wallStart,
    simMs: () => simMs(),
    touch: () => { changed = true; },
    redo: () => { dirty = true; },
  }));
  // 하드웨어 SPI 로 내보낸 바이트: DIN 이 D11(MOSI), CLK 가 D13(SCK)에 이어진 부품에게 전달
  spi.onByte = (value) => {
    for (const d of devices.values()) if (d.spi && d.part.pins.DIN !== undefined && d.part.pins.DIN === node(11) && d.part.pins.CLK !== undefined && d.part.pins.CLK === node(13)) d.spi(value);
    cpu.addClockEvent(() => spi.completeTransfer(0xFF), spi.transferCycles);
  };

  // I2C: 주소에 맞는 부품이 전원과 SDA(A4) · SCL(A5)에 제대로 이어져 있을 때만 응답
  const onBus = (part) => part.pins.SDA !== undefined && part.pins.SDA === node(18) && part.pins.SCL !== undefined && part.pins.SCL === node(19);
  let i2cTarget = null;
  twi.eventHandler = {
    start() { twi.completeStart(); },
    stop() { i2cTarget = null; twi.completeStop(); },
    connectToSlave(addr, write) {
      i2cTarget = null;
      const all = [...devices.values()].filter((d) => d.i2c);
      for (const d of all) if (d.i2c.addr === addr && onBus(d.part) && powered(d.part)) { i2cTarget = d.i2c; break; }
      if (i2cTarget) i2cTarget.begin(write);
      else if (addr > 7 && addr < 120) {
        const same = all.find((d) => d.i2c.addr === addr);
        const label = (d) => `${({ bmp280: 'BMP280', mpu6050: 'MPU6050', lcd: 'LCD', rtc: 'RTC', oled: 'OLED' })[d.part.type] || d.part.type}(0x${d.i2c.addr.toString(16)})`;
        if (same && !powered(same.part)) hint(`I2C: ${label(same)} 에 전원이 들어오지 않습니다. VCC → 5V${NEEDS_5V.has(same.part.type) ? '' : '(또는 3.3V)'}, GND → GND 를 확인하세요.`);
        else if (same) hint(`I2C: ${label(same)} 의 신호선을 확인하세요 (SDA → A4, SCL → A5).`);
        else if (all.length && !hints.has('i2c-scan')) { hints.add('i2c-scan'); if (!all.some((d) => d.i2c.addr === addr)) hint(`I2C: 스케치가 주소 0x${addr.toString(16)} 를 찾았지만 응답이 없습니다. 회로에 있는 장치: ${all.map(label).join(', ')}. (예: BMP280 은 bmp.begin(0x76))`); }
      }
      twi.completeConnect(!!i2cTarget);
    },
    writeByte(v) { if (i2cTarget) i2cTarget.write(v); twi.completeWrite(!!i2cTarget); },
    readByte() { twi.completeRead(i2cTarget ? i2cTarget.read() & 255 : 0xFF); },
  };

  /** 스케치와 상관없이 알 수 있는 배선 문제를 알려 줌 */
  function checkWiring() {
    const SIGNALS = { dht: ['DATA'], hcsr04: ['TRIG', 'ECHO'], hx711: ['DT', 'SCK'], servo: ['SIG'], gps: ['TX'], ds18b20: ['DQ'], neopixel: ['DIN'], stepper: ['IN1', 'IN2', 'IN3', 'IN4'], lcd16: ['RS', 'E', 'D4', 'D5', 'D6', 'D7'], tm1637: ['CLK', 'DIO'], max7219: ['DIN', 'CS', 'CLK'], irrecv: ['OUT'] };
    const NAMES = { dht: '온습도 센서(DHT)', hcsr04: '초음파 센서(HC-SR04)', hx711: '로드셀(HX711)', servo: '서보 모터', gps: 'GPS 모듈', bmp280: '기압·고도 센서(BMP280)', mpu6050: '가속도·자이로 센서(MPU6050)', lcd: 'LCD(I2C)', ds18b20: '온도 센서(DS18B20)', neopixel: 'NeoPixel', stepper: '스테퍼 모터', lcd16: 'LCD', tm1637: '숫자 표시기(TM1637)', max7219: 'LED 매트릭스(MAX7219)', irrecv: '적외선 수신기', rtc: '시계 모듈(RTC)', oled: 'OLED 화면', encoder: '로터리 엔코더' };
    for (const part of net.parts) {
      const name = NAMES[part.type];
      if (!name) continue;
      const v = supply(part);
      if (v < 3.0) hint(`${name}: 전원이 들어오지 않습니다. VCC → 5V${NEEDS_5V.has(part.type) ? '' : '(또는 3.3V)'}, GND → GND 를 연결하세요 (빵판의 + / − 줄을 쓴다면 그 줄도 보드에 이어져 있어야 합니다).`);
      else if (!powered(part)) hint(`${name}: 이 부품은 5V 전원이 필요합니다. VCC 를 3.3V 가 아니라 5V 에 연결하세요.`);
      const loose = (SIGNALS[part.type] || []).filter((sig) => !(pinsOnNode.get(part.pins[sig]) || []).length);
      if (loose.length) hint(`${name}: ${loose.join(', ')} 핀이 아두이노의 어느 핀에도 이어져 있지 않습니다.`);
      if (part.type === 'ds18b20' && v >= 3.0 && voltAt(part.pins.DQ) === null) hint('온도 센서(DS18B20): DQ 선에 풀업 저항이 없습니다. DQ 와 5V 사이에 4.7kΩ 저항을 연결하세요.');
      if (['bmp280', 'mpu6050', 'lcd', 'rtc', 'oled'].includes(part.type) && !onBus(part)) hint(`${name}: I2C 신호선을 확인하세요 (SDA → A4, SCL → A5).`);
    }
  }

  function refreshDevices() {
    ensure();
    for (const d of devices.values()) {
      d.refresh?.();
      if ((d.part.type === 'lcd' || d.part.type === 'lcd16') && !powered(d.part)) { d.off(); if (pstate.has(d.part.id)) { pstate.delete(d.part.id); changed = true; } }
      if (d.part.type === 'servo' && !powered(d.part)) changed = true;
    }
  }

  // ───────── 10ms 마다: PWM · 떠 있는 핀 · 타는 LED · 화면 알림 ─────────
  let frames = 0;
  function frame() {
    nextFrame += FRAME;
    frames++;
    for (let pin = 0; pin < 20; pin++) {
      const tr = track[pin]; const p = pins[pin];
      if (tr.edges >= 4 && p.mode === OUTPUT) {
        const pwm = clamp(Math.round(tr.duty * 255), 0, 255);
        if (!tr.fast || Math.abs((p.pwm ?? -9) - pwm) > 1) { p.pwm = pwm; dirty = true; }
        tr.fast = true;
      } else if (tr.fast && tr.edges === 0) { tr.fast = false; p.pwm = null; dirty = true; }
      tr.edges = 0;
      // 아무것도 잡아 주지 않는 입력 핀은 값이 제멋대로 바뀜
      const nd = node(pin);
      if (p.mode === INPUT && !(nd !== undefined && driven.has(nd)) && (nd === undefined || sol.floating[nd]) && frames % 3 === 0) {
        applyPin(pin);
        if (nd !== undefined && net.parts.some((part) => ['button', 'pot', 'ldr'].includes(part.type) && Object.values(part.pins).includes(nd))) hint(`${pinLabel(pin)} 핀이 떠 있습니다(전압을 정해 주는 것이 없음). 버튼이라면 풀업/풀다운 저항을 달거나 pinMode(${pinLabel(pin)}, INPUT_PULLUP) 을 쓰세요.`);
      }
    }
    if (frames % 3 === 0) for (const ch of [6, 7]) if (node(14 + ch) === undefined || sol.floating[node(14 + ch)]) applyPin(14 + ch);
    if (dirty) resolve();
    const now = simMs();
    for (const [id, since] of overSince) if (now - since > 1500) { burnt.add(id); overSince.delete(id); dirty = true; }
    if (frames % 100 === 0) for (const d of devices.values()) d.second?.();
    if (frames % 10 === 0) refreshDevices();
    else if (frames % 3 === 0) for (const d of devices.values()) d.fast?.();
    flushTx();
    if (frames % 5 === 0) report();
  }

  function snapshot() {
    ensure();
    const out = { pins: {}, parts: {}, warn: [], speed: Math.round(speed * 100) };
    pins.forEach((p, i) => { if (p.used && i < 20) out.pins[pinName(i)] = { m: p.mode, v: p.mode === OUTPUT ? (p.pwm != null ? Math.round((p.pwm / 255) * 100) / 100 : p.out) : track[i].level }; });
    let dim = false;
    for (const part of net.parts) {
      if (part.type === 'led') {
        const mA = sol.leds.get(part.id) || 0;
        out.parts[part.id] = burnt.has(part.id) ? { i: 0, x: 1 } : { i: Math.round(mA * 10) / 10 };
        if (burnt.has(part.id)) out.warn.push('LED 가 과전류로 타 버렸습니다. 220Ω 정도의 저항을 직렬로 연결한 뒤 다시 실행하세요 (다시 실행하면 새 LED 로 바뀝니다).');
        else if (mA > 30) out.warn.push(`LED 에 전류가 너무 많이 흐릅니다 (${mA.toFixed(0)}mA). 이대로 두면 곧 탑니다. 220Ω 정도의 저항을 LED 와 직렬로 연결하세요.`);
        else if (mA > 0.02 && mA < 0.3) dim = true;
      } else if (part.type === 'buzzer') {
        const a = voltAt(part.pins['+']); const b = voltAt(part.pins['-']);
        let f = 0;
        if (a !== null && b !== null && Math.abs(a - b) > 0.3) {
          const pin = [...(pinsOnNode.get(part.pins['+']) || []), ...(pinsOnNode.get(part.pins['-']) || [])].find((x) => x < 20 && pins[x].mode === OUTPUT && track[x].period > 0 && cpu.cycles - track[x].prevRise < track[x].period * 3 && track[x].period < F_CPU / 20);
          f = pin !== undefined ? Math.round(F_CPU / track[pin].period) : Math.abs(a - b) > 2 ? 2300 : 0;
        }
        out.parts[part.id] = { f };
      } else if (part.type === 'lcd') { if (powered(part)) out.parts[part.id] = pstate.get(part.id) || { l: [], b: 0 }; } else if (part.type === 'lcd16') { if (powered(part)) out.parts[part.id] = pstate.get(part.id) || { l: [], b: 1 }; } else if (pstate.has(part.id)) out.parts[part.id] = pstate.get(part.id);
    }
    if (dim && pins.some((p) => p.mode === INPUT_PULLUP)) hint('LED 가 아주 희미하게만 켜집니다. pinMode(핀, OUTPUT) 을 빠뜨리면 digitalWrite(HIGH) 는 약한 풀업 저항만 켭니다.');
    return out;
  }
  function report() {
    if (!changed) return;
    changed = false;
    const snap = snapshot();
    const text = JSON.stringify(snap);
    if (text !== lastReport) { lastReport = text; post({ type: 'state', state: snap }); }
  }

  /** 클럭을 target 까지 진행 */
  function runTo(target) {
    while (cpu.cycles < target && !stopped) {
      const stop = Math.min(target, cpu.cycles + 2000, nextFrame);
      while (cpu.cycles < stop) { avrInstruction(cpu); cpu.tick(); }
      if (dirty) resolve();
      if (cpu.cycles >= nextFrame) frame();
    }
  }

  function setNet(next) {
    net = next;
    pinsOnNode = new Map();
    for (let pin = 0; pin < 22; pin++) { const nd = node(pin); if (nd !== undefined) { if (!pinsOnNode.has(nd)) pinsOnNode.set(nd, []); pinsOnNode.get(nd).push(pin); } }
    driven.clear();
    lineListeners = new Map();
    const alive = new Set();
    for (const part of net.parts) {
      alive.add(part.id);
      const make = Object.hasOwn(makers, part.type) ? makers[part.type] : null;
      if (!make) continue;
      let dev = devices.get(part.id);
      if (!dev || dev.type !== part.type) { dev = { type: part.type, part, lines: [] }; make(dev); devices.set(part.id, dev); }
      dev.part = part;
      for (const name of dev.lines || []) { const nd = part.pins[name]; if (nd === undefined) continue; if (!lineListeners.has(nd)) lineListeners.set(nd, []); lineListeners.get(nd).push(dev); }
    }
    for (const id of [...devices.keys()]) if (!alive.has(id)) { devices.delete(id); pstate.delete(id); }
    dirty = true;
    resolve();
    refreshDevices();
    checkWiring();
    if (net.short && !stopped) {
      stopped = true;
      flushTx();
      post({ type: 'error', message: '합선(쇼트): 5V(또는 3.3V)와 GND 가 저항 없이 직접 이어져 보드의 전원이 꺼졌습니다. 그 전선을 없앤 뒤 다시 실행하세요.', line: 0 });
    }
  }

  return {
    setNet,
    setProp(id, key, value) {
      const p = net.parts.find((x) => x.id === id);
      if (!p) return;
      if (devices.get(id)?.action?.(key, value)) return; // 리모컨 버튼처럼 값이 아니라 동작인 것
      p.props[key] = value; dirty = true; resolve(); refreshDevices();
    },
    serialIn(text) { for (const b of new TextEncoder().encode(String(text))) rxQueue.push(b); pumpRx(); },
    snapshot,
    report,
    stop() { stopped = true; flushTx(); },
    /** 프로그램을 올림 */
    load(hex) {
      loadHex(hex, new Uint8Array(cpu.progMem.buffer));
      cpu.reset();
      devices.clear(); pstate.clear(); // 부품도 전원을 새로 넣은 상태에서 시작
      setNet(net);
      post({ type: 'started' });
    },
    /** (테스트용) 시뮬레이션 시간을 ms 만큼 바로 진행 */
    advance(ms) { runTo(cpu.cycles + ms * (F_CPU / 1000)); flushTx(); },
    /** 실제 시간에 맞춰 계속 실행. 기기가 느리면 실제보다 천천히 돌고, 그 비율(speed)을 알려 줌 */
    run(hex) {
      this.load(hex);
      return new Promise((done) => {
        let last = performance.now();
        const loop = () => {
          if (stopped) { flushTx(); report(); done(); return; }
          const now = performance.now();
          const want = Math.min(now - last, 40); // 한 번에 최대 40ms 치만 (밀려도 따라잡으려 하지 않음)
          last = now;
          const before = cpu.cycles;
          const budget = performance.now() + 14;
          const target = cpu.cycles + want * (F_CPU / 1000);
          while (cpu.cycles < target && performance.now() < budget && !stopped) runTo(Math.min(target, cpu.cycles + 16000));
          const ratio = want > 0 ? (cpu.cycles - before) / (want * (F_CPU / 1000)) : 1;
          const smooth = speed * 0.9 + clamp(ratio, 0, 1) * 0.1;
          if (Math.abs(Math.round(smooth * 20) - Math.round(speed * 20)) >= 1) changed = true;
          speed = smooth;
          setTimeout(loop, 0);
        };
        loop();
      });
    },
  };
}
