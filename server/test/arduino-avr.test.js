// 실제 컴파일러 경로: avr-gcc 로 스케치를 컴파일하고(server/src/arduino.js), 그 기계어를 칩 에뮬레이터에서 실행해
// (client/js/arduino/avr-runtime.js) 실제 라이브러리가 부품 모델과 제대로 대화하는지 확인합니다.
// avr-gcc · 아두이노 코어 · 라이브러리가 없는 환경에서는 건너뜁니다 (준비: README 의 "아두이노 컴파일러").
import test from 'node:test';
import assert from 'node:assert/strict';
import { createArduinoBuilder, CompileError, findFunctions, inoToCpp } from '../src/arduino.js';
import { createAvrRuntime, bmpRaw } from '../../client/js/arduino/avr-runtime.js';
import { createLibraryManager, loadCatalog } from '../src/arduino-libs.js';
import { makeZip } from '../../client/js/zip.js';
import { createHash } from 'node:crypto';
import { mkdtempSync, existsSync, readFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildNetlist, emptyCircuit, starterCircuit, STARTER_SKETCH } from '../../client/js/arduino/parts.js';

const builder = createArduinoBuilder(process.getuid?.() === 0 ? {} : { mode: process.env.ARDUINO_COMPILER || '0' });
const available = await builder.available();
const libs = available ? builder.stats().libraries : [];
const has = (...names) => names.every((n) => libs.includes(n));
const opts = (...names) => ({ skip: !available ? 'avr-gcc 가 없음' : !has(...names) ? `라이브러리 없음: ${names.join(', ')}` : false });

/** 컴파일 → 에뮬레이터에서 ms(시뮬레이션 시간)만큼 실행 */
async function simulate(sketch, circuit, ms, during) {
  const out = { serial: '', hints: [], errors: [] };
  const { hex } = await builder.compile({ sketch });
  const rt = createAvrRuntime({ post(m) { if (m.type === 'serial') out.serial += m.text; else if (m.type === 'hint') out.hints.push(m.text); else if (m.type === 'error') out.errors.push(m.message); } });
  rt.setNet(buildNetlist(circuit || emptyCircuit()));
  rt.load(hex);
  if (during) await during(rt, out);
  rt.advance(ms);
  out.state = rt.snapshot();
  out.rt = rt;
  return out;
}
const lines = (r) => r.serial.trim().split(/\r?\n/);
function wired(parts, links) {
  const c = emptyCircuit('uno');
  parts.forEach((p, i) => c.parts.push({ id: p.id, type: p.type, x: 400 + i * 80, y: 400, props: p.props || {} }));
  links.forEach(([a, b], i) => c.wires.push({ id: `w${i}`, a: a.includes(':') ? a : `mcu:${a}`, b: b.includes(':') ? b : `mcu:${b}`, color: '#e53935' }));
  return c;
}
const power = (id, v = '5V') => [[`${id}:VCC`, v], [`${id}:GND`, 'GND']];
const bus = (id, v) => [...power(id, v), [`${id}:SDA`, 'A4'], [`${id}:SCL`, 'A5']];
const near = (actual, expected, tol, label) => assert.ok(Math.abs(Number(actual) - expected) <= tol, `${label || ''} ${actual} ≉ ${expected}`);

test('.ino → .cpp: 함수 원형을 만들어 넣고 줄 번호를 유지', () => {
  const src = '#include <Wire.h>\nint n = 0;\nstruct P { int x; };\nvoid setup() {\n  blink(3);\n}\nvoid loop() { if (n) { n = add(n); } }\nvoid blink(int times, int ms = 100) { }\nstatic int add(int a) { return a + 1; }\nconst char *name() { return "x"; }\nint arr[] = { 1, 2 };\nISR(TIMER1_COMPA_vect) { }\n';
  assert.deepEqual(findFunctions(src).map((f) => f.proto), ['void setup();', 'void loop();', 'void blink(int times, int ms);', 'static int add(int a);', 'const char * name();']);
  const cpp = inoToCpp(src).split('\n');
  assert.equal(cpp[0], '#include <Arduino.h>');
  assert.equal(cpp[cpp.indexOf('#line 4 "sketch.ino"') + 1], 'void setup() {');
});

test('컴파일러: 오류는 스케치의 줄 번호로, 서버의 비밀 값은 읽을 수 없음', opts(), async () => {
  const err = async (sketch) => { try { await builder.compile({ sketch }); } catch (e) { assert.ok(e instanceof CompileError); return e; } return assert.fail('오류가 나야 함'); };
  const e = await err('void setup() {\n  int a = 1\n}\nvoid loop() { foo(); }\n');
  assert.equal(e.code, 'compile_error');
  assert.deepEqual(e.errors.map((x) => [x.file, x.line]), [['sketch.ino', 3], ['sketch.ino', 4]]);
  assert.match(e.errors[1].message, /'foo' was not declared/);
  assert.doesNotMatch(e.log, /chat-site-arduino|\/tmp\//);
  // 컴파일러는 다른 사용자로, 환경 변수 없이 실행됨 → 서버 프로세스의 환경 변수를 포함할 수 없음
  if (process.getuid?.() === 0) assert.match((await err('#include "/proc/1/environ"\nvoid setup() {}\nvoid loop() {}')).errors[0].message, /Permission denied/);
  // 어셈블러의 .incbin 으로 컴파일러 자신의 환경 변수를 결과물에 넣어 보아도 서버의 값은 들어 있지 않음
  process.env.CHAT_SITE_TEST_SECRET = 'top-secret-value';
  const leak = await builder.compile({ sketch: 'asm(".section .progmem.data\\nleak: .incbin \\"/proc/self/environ\\"");\nextern const char leak[] PROGMEM;\nvoid setup() { Serial.begin(9600); Serial.write(pgm_read_byte(leak)); }\nvoid loop() {}' }).catch((e) => ({ hex: e.log }));
  const bytes = Buffer.from((leak.hex.match(/^:[0-9A-F]{8}([0-9A-F]*)[0-9A-F]{2}$/gm) || []).map((l) => l.slice(9, -2)).join(''), 'hex').toString('latin1');
  assert.doesNotMatch(bytes + leak.hex, /top-secret-value/);
  delete process.env.CHAT_SITE_TEST_SECRET;
  assert.equal((await err('')).code, 'bad_sketch');
  await assert.rejects(builder.compile({ sketch: 'void setup(){}void loop(){}', files: [{ name: '../x.h', content: '' }] }), { code: 'bad_files' });
  // 같은 폴더의 .h 파일, C++ 클래스(간이 변환기는 못 하는 것)
  const ok = await builder.compile({ sketch: '#include "led.h"\nLed led(13);\nvoid setup() { led.on(); }\nvoid loop() {}', files: [{ name: 'led.h', content: 'class Led { int pin; public: Led(int p) : pin(p) { pinMode(p, OUTPUT); } void on() { digitalWrite(pin, HIGH); } };' }] });
  assert.ok(ok.flash > 400 && ok.flash < 2000);
  assert.equal((await builder.compile({ sketch: 'void setup() {}\nvoid loop() {}', board: 'nano' })).flashMax, 30720);
});

test('실행: 깜빡이기 예제 — 시리얼(한글) · LED 전류 · 실제 시간', opts(), async () => {
  const r = await simulate(STARTER_SKETCH, starterCircuit(), 2300);
  assert.deepEqual(lines(r), ['시작!', '깜빡인 횟수: 1', '깜빡인 횟수: 2']);
  assert.equal(r.state.pins.D13.v, 1);
  near(r.state.parts.led1.i, 12.5, 1);
  assert.deepEqual(r.state.warn, []);
});

test('실행: 버튼(인터럽트) · 가변저항(ADC) · PWM · 시리얼 입력 · 합선 · 타는 LED', opts(), async () => {
  const circuit = wired(
    [{ id: 'btn', type: 'button' }, { id: 'pot', type: 'pot', props: { pos: 0.25 } }, { id: 'l', type: 'led' }, { id: 'r', type: 'resistor', props: { ohm: 220 } }],
    [['D2', 'btn:A'], ['btn:B', 'GND'], ['pot:1', 'GND'], ['pot:2', '5V'], ['pot:W', 'A0'], ['D5', 'r:A'], ['r:B', 'l:A'], ['l:K', 'GND']],
  );
  const r = await simulate(`volatile int hits = 0;
    void onPress() { hits++; }
    void setup() { Serial.begin(115200); pinMode(2, INPUT_PULLUP); attachInterrupt(digitalPinToInterrupt(2), onPress, FALLING); pinMode(5, OUTPUT); analogWrite(5, 64); }
    void loop() { if (Serial.available()) { int n = Serial.parseInt(); Serial.print("x2="); Serial.println(n * 2); } Serial.print(digitalRead(2)); Serial.print(' '); Serial.print(analogRead(A0)); Serial.print(' '); Serial.println(hits); delay(100); }`,
  circuit, 260, async (rt) => { rt.advance(250); rt.setProp('btn', 'pressed', true); rt.setProp('pot', 'pos', 0.75); rt.serialIn('21\n'); });
  const rows = lines(r);
  assert.equal(rows[0], '1 256 0');
  assert.ok(rows.includes('x2=42'));
  assert.equal(rows.at(-1), '0 767 1');
  near(r.state.parts.l.i, 3.1, 0.6, 'PWM 25% LED');
  const shorted = await simulate('void setup() { Serial.begin(9600); Serial.println("run"); }\nvoid loop() {}', wired([], [['5V', 'GND']]), 200);
  assert.equal(shorted.serial, '');
  assert.match(shorted.errors[0], /합선/);
  const burn = await simulate('void setup() { pinMode(8, OUTPUT); digitalWrite(8, HIGH); }\nvoid loop() {}', wired([{ id: 'l', type: 'led' }], [['D8', 'l:A'], ['l:K', 'GND']]), 1900);
  assert.deepEqual(burn.state.parts.l, { i: 0, x: 1 });
});

test('DHT: 실제 라이브러리가 1-wire 파형을 읽음 (DHT22 · DHT11 · 전원 없음 · 종류가 다름)', opts('DHT_sensor_library'), async () => {
  const sketch = (type) => `#include <DHT.h>\nDHT dht(2, ${type});\nvoid setup() { Serial.begin(115200); dht.begin(); }
    void loop() { delay(2100); float t = dht.readTemperature(); float h = dht.readHumidity(); if (isnan(t)) Serial.println("fail"); else { Serial.print(t, 1); Serial.print(' '); Serial.println(h, 0); } }`;
  const circuit = (props, links = [...power('d'), ['d:DATA', 'D2']]) => wired([{ id: 'd', type: 'dht', props }], links);
  const d22 = lines(await simulate(sketch('DHT22'), circuit({ temp: 31.4, hum: 64, model: 'DHT22' }), 2300))[0].split(' ');
  near(d22[0], 31.4, 0.2); near(d22[1], 64, 1);
  const cold = lines(await simulate(sketch('DHT22'), circuit({ temp: -7.5, hum: 30, model: 'DHT22' }), 2300))[0].split(' ');
  near(cold[0], -7.5, 0.2);
  assert.equal(lines(await simulate(sketch('DHT11'), circuit({ temp: 23, hum: 41 }), 2300))[0], '23.0 41');
  const noPower = await simulate(sketch('DHT11'), circuit({}, [['d:GND', 'GND'], ['d:DATA', 'D2']]), 2300);
  assert.equal(lines(noPower)[0], 'fail');
  assert.match(noPower.hints.join(), /전원/);
  const wrongPin = await simulate(sketch('DHT11'), circuit({}, [...power('d'), ['d:DATA', 'D3']]), 2300);
  assert.equal(lines(wrongPin)[0], 'fail');
  const mismatch = await simulate(sketch('DHT22'), circuit({ temp: 23, hum: 41 }), 2300); // DHT11 센서를 DHT22 로 읽음
  assert.equal(lines(mismatch)[0], 'fail');
  assert.match(mismatch.hints.join(), /DHT11/);
});

test('I2C: BMP280 (실제 보정 계산) · 주소가 다르면 실패', opts('Adafruit_BMP280_Library'), async () => {
  const raw = bmpRaw(25.08, 100653.27); // 데이터시트 예시: ADC 519888 / 415148 ↔ 25.08℃ / 100653.27Pa
  near(raw.adcT, 519888, 20); near(raw.adcP, 415148, 20);
  const sketch = (addr) => `#include <Adafruit_BMP280.h>\nAdafruit_BMP280 bmp;\nvoid setup() { Serial.begin(115200); Serial.println(bmp.begin(${addr}) ? "ok" : "fail"); }
    void loop() { Serial.print(bmp.readTemperature()); Serial.print(' '); Serial.print(bmp.readPressure() / 100.0); Serial.print(' '); Serial.println(bmp.readAltitude(1013.25)); delay(300); }`;
  const good = lines(await simulate(sketch('0x76'), wired([{ id: 'b', type: 'bmp280', props: { alt: 320, temp: 18.5 } }], bus('b', '3V3')), 500));
  assert.equal(good[0], 'ok');
  const [t, p, alt] = good[1].split(' ');
  near(t, 18.5, 0.1); near(p, 975.4, 0.3); near(alt, 320, 1.5);
  const wrong = await simulate(sketch(''), wired([{ id: 'b', type: 'bmp280' }], bus('b')), 300); // begin() 의 기본 주소는 0x77
  assert.equal(lines(wrong)[0], 'fail');
  assert.match(wrong.hints.join(), /0x77.*0x76/);
  const swapped = await simulate(sketch('0x76'), wired([{ id: 'b', type: 'bmp280' }], [...power('b'), ['b:SDA', 'A5'], ['b:SCL', 'A4']]), 300);
  assert.equal(lines(swapped)[0], 'fail');
  assert.match(swapped.hints.join(), /SDA → A4/);
});

test('I2C: MPU6050 (Adafruit 라이브러리 · Wire 로 직접 읽기 · 잠든 상태)', opts('Adafruit_MPU6050'), async () => {
  const circuit = wired([{ id: 'm', type: 'mpu6050', props: { ax: 0.5, ay: 0, az: 1, gx: 57.3, gy: 0, gz: 0, temp: 25 } }], bus('m'));
  const lib = lines(await simulate(`#include <Adafruit_MPU6050.h>\nAdafruit_MPU6050 mpu;
    void setup() { Serial.begin(115200); Serial.println(mpu.begin() ? "ok" : "fail"); mpu.setAccelerometerRange(MPU6050_RANGE_8_G); mpu.setGyroRange(MPU6050_RANGE_500_DEG); }
    void loop() { sensors_event_t a, g, t; mpu.getEvent(&a, &g, &t); Serial.print(a.acceleration.x); Serial.print(' '); Serial.print(a.acceleration.z); Serial.print(' '); Serial.print(g.gyro.x); Serial.print(' '); Serial.println(t.temperature); delay(300); }`, circuit, 900));
  assert.equal(lib[0], 'ok');
  const [ax, az, gx, temp] = lib[1].split(' ');
  near(ax, 4.9, 0.05); near(az, 9.81, 0.05); near(gx, 1.0, 0.02); near(temp, 25, 0.1);
  const read = (wake) => `#include <Wire.h>\nvoid setup() { Serial.begin(115200); Wire.begin(); ${wake ? 'Wire.beginTransmission(0x68); Wire.write(0x6B); Wire.write(0); Wire.endTransmission(true);' : ''} }
    void loop() { Wire.beginTransmission(0x68); Wire.write(0x3B); Wire.endTransmission(false); Wire.requestFrom(0x68, 6, true); int16_t x = Wire.read() << 8 | Wire.read(); Wire.read(); Wire.read(); int16_t z = Wire.read() << 8 | Wire.read(); Serial.print(x); Serial.print(' '); Serial.println(z); delay(300); }`;
  const awake = lines(await simulate(read(true), circuit, 400))[0].split(' ');
  near(awake[0], 8192, 40); near(awake[1], 16384, 40);
  assert.equal(lines(await simulate(read(false), circuit, 400))[0], '0 0'); // 깨우지 않으면(0x6B) 값이 나오지 않음
});

test('HX711(비트 단위) · HC-SR04(펄스 길이) · 서보(펄스 폭) · LCD(HD44780) · 부저(주파수)', opts('HX711', 'Servo', 'LiquidCrystal_I2C'), async () => {
  const circuit = wired(
    [{ id: 'h', type: 'hx711', props: { weight: 250 } }, { id: 'u', type: 'hcsr04', props: { dist: 80 } }, { id: 's', type: 'servo' }, { id: 'lcd', type: 'lcd' }, { id: 'bz', type: 'buzzer' }],
    [...power('h'), ['h:DT', 'D3'], ['h:SCK', 'D2'], ...power('u'), ['u:TRIG', 'D7'], ['u:ECHO', 'D6'], ...power('s'), ['s:SIG', 'D9'], ...bus('lcd'), ['bz:+', 'D8'], ['bz:-', 'GND']],
  );
  const sketch = `#include <HX711.h>\n#include <Servo.h>\n#include <LiquidCrystal_I2C.h>\nHX711 scale; Servo servo; LiquidCrystal_I2C lcd(0x27, 16, 2);
    void setup() {
      Serial.begin(115200);
      scale.begin(3, 2); scale.set_scale(430); scale.set_offset(84210);
      Serial.println(scale.get_units(3), 0);
      pinMode(7, OUTPUT); pinMode(6, INPUT);
      digitalWrite(7, LOW); delayMicroseconds(2); digitalWrite(7, HIGH); delayMicroseconds(10); digitalWrite(7, LOW);
      Serial.println(pulseIn(6, HIGH) / 58.2, 0);
      servo.attach(9); servo.write(135);
      lcd.init(); lcd.backlight(); lcd.setCursor(0, 0); lcd.print("Temp:"); lcd.print(23.5, 1); lcd.setCursor(3, 1); lcd.print(42);
      tone(8, 440);
    }
    void loop() {}`;
  const r = await simulate(sketch, circuit, 2000); // LCD 라이브러리의 init() 은 1초 넘게 기다림
  assert.deepEqual(lines(r).map(Number).map((v, i) => Math.abs(v - [250, 80][i]) <= 1), [true, true]);
  near(r.state.parts.s.a, 135, 1);
  assert.deepEqual(r.state.parts.lcd, { l: ['Temp:23.5       ', '   42           '], b: 1 });
  near(r.state.parts.bz.f, 440, 3);
  // 실행 중에 LCD 전원선을 빼면 화면이 꺼짐
  const cut = wired(circuit.parts, circuit.wires.filter((w) => w.a !== 'lcd:VCC').map((w) => [w.a, w.b]));
  r.rt.setNet(buildNetlist(cut));
  r.rt.advance(150);
  assert.equal(r.rt.snapshot().parts.lcd, undefined);
  // SCK 가 빠진 로드셀: 클럭이 전달되지 않아 DT 는 계속 LOW → 무게와 상관없이 0 만 읽힘 (값을 지어내지 않음)
  const noClock = await simulate('#include <HX711.h>\nHX711 s;\nvoid setup() { Serial.begin(115200); s.begin(3, 2); s.set_scale(430); s.set_offset(84210); Serial.println(s.get_units(2), 1); }\nvoid loop() {}', wired([{ id: 'h', type: 'hx711', props: { weight: 250 } }], [...power('h'), ['h:DT', 'D3']]), 800);
  assert.equal(noClock.serial.trim(), '-195.8');
  // 5V 가 필요한 초음파 센서를 3.3V 에 연결: 응답 없음 → 0
  const low = await simulate('void setup() { Serial.begin(115200); pinMode(7, OUTPUT); digitalWrite(7, HIGH); delayMicroseconds(10); digitalWrite(7, LOW); Serial.println(pulseIn(6, HIGH, 30000)); }\nvoid loop() {}', wired([{ id: 'u', type: 'hcsr04' }], [...power('u', '3V3'), ['u:TRIG', 'D7'], ['u:ECHO', 'D6']]), 300);
  assert.equal(low.serial.trim(), '0');
  assert.match(low.hints.join(), /5V 전원이 필요/);
});

test('GPS: 9600bps 파형 → SoftwareSerial → TinyGPS++ (속도가 다르면 읽지 못함)', opts('TinyGPSPlus', 'SoftwareSerial'), async () => {
  const circuit = wired([{ id: 'g', type: 'gps', props: { lat: 35.1796, lng: 129.0756, alt: 12, speed: 36, sats: 9, fix: true } }], [...power('g'), ['g:TX', 'D4']]);
  const sketch = (baud) => `#include <SoftwareSerial.h>\n#include <TinyGPS++.h>\nSoftwareSerial ss(4, 3); TinyGPSPlus gps; bool shown = false;
    void setup() { Serial.begin(115200); ss.begin(${baud}); }
    void loop() {
      while (ss.available()) if (gps.encode(ss.read()) && gps.location.isValid() && gps.speed.isValid() && !shown) {
        shown = true; Serial.println(gps.location.lat(), 4); Serial.println(gps.location.lng(), 4); Serial.println(gps.altitude.meters(), 0); Serial.println(gps.speed.kmph(), 0); Serial.println(gps.satellites.value());
      }
      if (millis() > 2400 && !shown) { shown = true; Serial.println("none"); }
    }`;
  assert.deepEqual(lines(await simulate(sketch(9600), circuit, 2600)), ['35.1796', '129.0756', '12', '36', '9']);
  assert.deepEqual(lines(await simulate(sketch(4800), circuit, 2600)), ['none']);
});

test('라이브러리 목록: 항목마다 경로 · 체크섬 · 헤더가 있고, 의존하는 라이브러리도 목록에 있음', () => {
  const catalog = loadCatalog();
  const ids = new Set(catalog.map((e) => e.id));
  assert.equal(ids.size, catalog.length);
  assert.ok(catalog.filter((e) => !e.optional).length >= 20);
  assert.ok(catalog.length >= 150, `목록 ${catalog.length}개`);
  for (const e of catalog) {
    assert.match(e.id, /^[A-Za-z0-9_]+$/);
    assert.match(e.sha256, /^[0-9a-f]{64}$/);
    assert.match(e.src, /^[\w.-]+(\/[\w.-]+)+\.zip$/);
    assert.ok(!e.src.includes('..'));
    assert.ok(e.headers.length && e.desc && e.version);
    for (const dep of e.requires) assert.ok(ids.has(dep), `${e.id} → ${dep}`);
  }
});

test('라이브러리 관리: 설치(의존 라이브러리 포함) · 삭제 · 체크섬 확인 · 상태 저장', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'libs-'));
  chmodSync(dir, 0o755); // 컴파일러(다른 사용자)가 읽을 수 있게
  const zipOf = async (name, files) => Buffer.from(await makeZip(Object.entries(files).map(([path, content]) => ({ path: `${name}-1.0.0/${path}`, content }))).arrayBuffer());
  const zips = { 'x/y/Base-1.0.0.zip': await zipOf('Base', { 'src/Base.h': '#define BASE 7\n', 'examples/a/a.ino': 'x' }), 'x/y/Extra-1.0.0.zip': await zipOf('Extra', { 'Extra.h': '#include <Base.h>\nint extra();\n', 'Extra.cpp': '#include "Extra.h"\nint extra() { return BASE; }\n' }) };
  const sha = (b) => createHash('sha256').update(b).digest('hex');
  const catalog = [
    { id: 'Base', name: 'Base', version: '1.0.0', author: 't', src: 'x/y/Base-1.0.0.zip', sha256: sha(zips['x/y/Base-1.0.0.zip']), headers: ['Base.h'], requires: [], sim: 'full', desc: 'd' },
    { id: 'Extra', name: 'Extra', version: '1.0.0', author: 't', src: 'x/y/Extra-1.0.0.zip', sha256: sha(zips['x/y/Extra-1.0.0.zip']), headers: ['Extra.h'], requires: ['Base'], sim: 'full', optional: true, desc: 'd' },
    { id: 'Bad', name: 'Bad', version: '1.0.0', author: 't', src: 'x/y/Base-1.0.0.zip', sha256: '0'.repeat(64), headers: ['Bad.h'], requires: [], sim: 'full', optional: true, desc: 'd' },
  ];
  const changed = [];
  let saved = null;
  const fetched = [];
  const fetchImpl = async (url) => { const key = url.split('/libraries/')[1]; fetched.push(key); return zips[key] ? { ok: true, arrayBuffer: async () => zips[key] } : { ok: false, status: 404 }; };
  const make = (state) => createLibraryManager({ builder: { libraryChanged: (id) => changed.push(id) }, libsDir: dir, catalog, fetchImpl, loadState: async () => state, saveState: async (st) => { saved = JSON.parse(JSON.stringify(st)); } });
  const mgr = make(null);
  assert.deepEqual(await mgr.sync(), ['Base']); // 기본 라이브러리는 자동으로
  assert.equal(readFileSync(join(dir, 'Base/src/Base.h'), 'utf8'), '#define BASE 7\n');
  assert.equal(existsSync(join(dir, 'Base/examples')), false);
  assert.deepEqual(mgr.list().filter((l) => !l.builtin).map((l) => [l.id, l.installed]), [['Base', true], ['Extra', false], ['Bad', false]]);
  assert.equal(mgr.missingFor('Extra.h').id, 'Extra');
  await mgr.install('Extra');
  assert.ok(existsSync(join(dir, 'Extra/Extra.cpp')));
  assert.deepEqual(saved, { on: ['Extra'], off: [] });
  assert.equal(mgr.missingFor('Extra.h'), null);
  await assert.rejects(mgr.install('Bad'), /checksum_mismatch/);
  assert.equal(existsSync(join(dir, 'Bad')), false);
  assert.throws(() => mgr.install('../etc'), /unknown_library/);
  assert.throws(() => mgr.remove('Base'), /library_in_use/); // Extra 가 쓰는 중
  await mgr.remove('Extra');
  await mgr.remove('Base');
  assert.deepEqual(saved, { on: [], off: ['Base'] });
  assert.deepEqual(changed, ['Base', 'Extra', 'Extra', 'Base']);
  // 서버를 다시 띄움: 지운 기본 라이브러리는 다시 받지 않고, 설치했던 선택 라이브러리는 (의존 라이브러리와 함께) 다시 받음
  assert.deepEqual(await make({ on: [], off: ['Base'] }).sync(), []);
  assert.deepEqual(await make({ on: ['Extra'], off: ['Base'] }).sync(), ['Extra']);
  assert.ok(existsSync(join(dir, 'Base/src/Base.h')) && existsSync(join(dir, 'Extra/Extra.h')));
  // 설치한 라이브러리로 실제 컴파일
  if (available) {
    const b = createArduinoBuilder({ libsDir: dir, workDir: mkdtempSync(join(tmpdir(), 'work-')), mode: process.getuid?.() === 0 ? 'auto' : process.env.ARDUINO_COMPILER || '0' });
    const out = await b.compile({ sketch: '#include <Extra.h>\nvoid setup() { pinMode(extra(), OUTPUT); }\nvoid loop() {}' });
    assert.deepEqual(out.libraries, ['Extra', 'Base']);
  }
});

test('자주 쓰는 라이브러리: ArduinoJson · NewPing · Bounce2 · TimerOne 은 시뮬레이터에서 그대로 동작', opts('ArduinoJson', 'NewPing', 'Bounce2', 'TimerOne'), async () => {
  const json = await simulate('#include <ArduinoJson.h>\nvoid setup() { Serial.begin(115200); JsonDocument doc; doc["temp"] = 23.5; doc["ok"] = true; serializeJson(doc, Serial); Serial.println(); JsonDocument in; deserializeJson(in, "{\\"a\\":[1,2,3]}"); Serial.println((int)in["a"][2]); }\nvoid loop() {}', null, 200);
  assert.deepEqual(lines(json), ['{"temp":23.5,"ok":true}', '3']);
  const ping = await simulate('#include <NewPing.h>\nNewPing sonar(7, 6, 200);\nvoid setup() { Serial.begin(115200); }\nvoid loop() { Serial.println(sonar.ping_cm()); delay(60); }', wired([{ id: 'u', type: 'hcsr04', props: { dist: 80 } }], [...power('u'), ['u:TRIG', 'D7'], ['u:ECHO', 'D6']]), 200);
  near(lines(ping)[0], 80, 2);
  const bounce = await simulate('#include <Bounce2.h>\nBounce b = Bounce(); int n = 0;\nvoid setup() { Serial.begin(115200); b.attach(2, INPUT_PULLUP); b.interval(5); }\nvoid loop() { b.update(); if (b.fell()) { n++; Serial.println(n); } }',
    wired([{ id: 'btn', type: 'button' }], [['D2', 'btn:A'], ['btn:B', 'GND']]), 100, async (rt) => { rt.advance(100); rt.setProp('btn', 'pressed', true); rt.advance(50); rt.setProp('btn', 'pressed', false); rt.advance(50); rt.setProp('btn', 'pressed', true); });
  assert.deepEqual(lines(bounce), ['1', '2']);
  const timer = await simulate('#include <TimerOne.h>\nvolatile int t = 0; void tick() { t++; }\nvoid setup() { Serial.begin(115200); Timer1.initialize(100000); Timer1.attachInterrupt(tick); }\nvoid loop() { delay(1000); Serial.println(t); }', null, 1100);
  assert.deepEqual(lines(timer), ['10']);
});

test('자주 쓰는 라이브러리: 부품이 없는 것도 컴파일 · 실행은 됨 (Stepper · LiquidCrystal · DallasTemperature · NeoPixel · RTClib)', opts('Stepper', 'LiquidCrystal', 'OneWire', 'DallasTemperature', 'Adafruit_NeoPixel', 'RTClib'), async () => {
  const r = await simulate(`#include <Stepper.h>\n#include <LiquidCrystal.h>\n#include <OneWire.h>\n#include <DallasTemperature.h>\n#include <Adafruit_NeoPixel.h>\n#include <RTClib.h>
    Stepper motor(200, 8, 9, 10, 11); LiquidCrystal lcd(12, A0, 5, 4, 3, A1); OneWire wire(2); DallasTemperature temps(&wire); Adafruit_NeoPixel strip(8, 6, NEO_GRB + NEO_KHZ800); RTC_DS3231 rtc;
    void setup() {
      Serial.begin(115200);
      motor.setSpeed(60); motor.step(10); lcd.begin(16, 2); lcd.print("hi");
      temps.begin(); temps.requestTemperatures(); Serial.println(temps.getTempCByIndex(0), 0);
      strip.begin(); strip.setPixelColor(0, strip.Color(255, 0, 0)); strip.show();
      Serial.println(rtc.begin() ? "rtc" : "no rtc");
    }
    void loop() {}`, null, 2500);
  assert.deepEqual(lines(r), ['-127', 'no rtc']); // 센서 · 시계가 연결되어 있지 않을 때의 실제 동작
});

// ── 새 부품: 실제 라이브러리가 부품 모델과 신호 수준에서 대화 ──
const pw = (id, v = '5V') => [[`${id}:VCC`, v], [`${id}:GND`, 'GND']];

test('DS18B20: 1-Wire 검색 · 변환 · 읽기 (풀업 저항이 없으면 찾지 못함)', opts('OneWire', 'DallasTemperature'), async () => {
  const sketch = '#include <OneWire.h>\n#include <DallasTemperature.h>\nOneWire ow(2); DallasTemperature s(&ow);\nvoid setup() { Serial.begin(115200); s.begin(); Serial.println(s.getDeviceCount()); s.requestTemperatures(); Serial.println(s.getTempCByIndex(0)); }\nvoid loop() {}';
  const sensor = { id: 't', type: 'ds18b20', props: { temp: 36.5 } };
  const good = await simulate(sketch, wired([sensor, { id: 'r', type: 'resistor', props: { ohm: 4700 } }], [...pw('t'), ['t:DQ', 'D2'], ['r:A', 'D2'], ['r:B', '5V']]), 1500);
  assert.deepEqual(lines(good), ['1', '36.50']);
  const cold = await simulate(sketch, wired([{ ...sensor, props: { temp: -10.5 } }, { id: 'r', type: 'resistor', props: { ohm: 4700 } }], [...pw('t'), ['t:DQ', 'D2'], ['r:A', 'D2'], ['r:B', '5V']]), 1500);
  assert.equal(lines(cold)[1], '-10.50');
  const noPullup = await simulate(sketch, wired([sensor], [...pw('t'), ['t:DQ', 'D2']]), 1500);
  assert.equal(lines(noPullup)[0], '0');
  assert.match(noPullup.hints.join(), /4\.7kΩ/);
});

test('NeoPixel(Adafruit · FastLED) · 스테퍼 · 병렬 LCD · 키패드', opts('Adafruit_NeoPixel', 'Stepper', 'LiquidCrystal', 'Keypad'), async () => {
  const strip = wired([{ id: 'n', type: 'neopixel' }], [...pw('n'), ['n:DIN', 'D6']]);
  const neo = await simulate('#include <Adafruit_NeoPixel.h>\nAdafruit_NeoPixel px(8, 6, NEO_GRB + NEO_KHZ800);\nvoid setup() { px.begin(); px.setPixelColor(0, px.Color(255, 0, 0)); px.setPixelColor(1, px.Color(0, 128, 0)); px.setPixelColor(7, px.Color(0, 0, 255)); px.show(); }\nvoid loop() {}', strip, 200);
  assert.deepEqual(neo.state.parts.n.px, ['#ff0000', '#008000', '#000000', '#000000', '#000000', '#000000', '#000000', '#0000ff']);
  if (has('FastLED')) {
    const fast = await simulate('#include <FastLED.h>\nCRGB leds[8];\nvoid setup() { FastLED.addLeds<WS2812, 6, GRB>(leds, 8); leds[0] = CRGB(255, 0, 0); leds[2] = CRGB(0, 0, 255); FastLED.show(); }\nvoid loop() {}', strip, 200);
    assert.deepEqual(fast.state.parts.n.px.slice(0, 3), ['#ff0000', '#000000', '#0000ff']);
  }
  const noPower = await simulate('#include <Adafruit_NeoPixel.h>\nAdafruit_NeoPixel px(8, 6, NEO_GRB + NEO_KHZ800);\nvoid setup() { px.begin(); px.fill(px.Color(9, 9, 9)); px.show(); }\nvoid loop() {}', wired([{ id: 'n', type: 'neopixel' }], [...pw('n', '3V3'), ['n:DIN', 'D6']]), 200);
  assert.equal(noPower.state.parts.n, undefined);
  // 스테퍼: 핀 순서가 맞으면 돌고, 틀리면 실제처럼 돌지 않음
  const motor = wired([{ id: 'm', type: 'stepper' }], [...pw('m'), ['m:IN1', 'D8'], ['m:IN2', 'D9'], ['m:IN3', 'D10'], ['m:IN4', 'D11']]);
  const turn = (pinsOrder) => simulate(`#include <Stepper.h>\nStepper m(2048, ${pinsOrder});\nvoid setup() { m.setSpeed(10); m.step(512); }\nvoid loop() {}`, motor, 2500);
  const ok = await turn('8, 10, 9, 11');
  assert.ok(Math.abs(ok.state.parts.m.n - 512) <= 2 && Math.abs(ok.state.parts.m.a - 90) <= 1, JSON.stringify(ok.state.parts.m));
  const wrong = await turn('8, 9, 10, 11');
  assert.ok(Math.abs(wrong.state.parts.m?.n || 0) <= 2, JSON.stringify(wrong.state.parts.m));
  const lcd = await simulate('#include <LiquidCrystal.h>\nLiquidCrystal lcd(12, 11, 5, 4, 3, 2);\nvoid setup() { lcd.begin(16, 2); lcd.print("Hello"); lcd.setCursor(2, 1); lcd.print(3.14); }\nvoid loop() {}',
    wired([{ id: 'l', type: 'lcd16' }], [...pw('l'), ['l:RS', 'D12'], ['l:E', 'D11'], ['l:D4', 'D5'], ['l:D5', 'D4'], ['l:D6', 'D3'], ['l:D7', 'D2']]), 500);
  assert.deepEqual(lcd.state.parts.l, { l: ['Hello           ', '  3.14          '], b: 1 });
  const keys = await simulate("#include <Keypad.h>\nchar keys[4][4] = {{'1','2','3','A'},{'4','5','6','B'},{'7','8','9','C'},{'*','0','#','D'}}; byte r[4] = {9, 8, 7, 6}; byte c[4] = {5, 4, 3, 2}; Keypad kp = Keypad(makeKeymap(keys), r, c, 4, 4);\nvoid setup() { Serial.begin(115200); }\nvoid loop() { char k = kp.getKey(); if (k) Serial.println(k); }",
    wired([{ id: 'k', type: 'keypad' }], ['R1:D9', 'R2:D8', 'R3:D7', 'R4:D6', 'C1:D5', 'C2:D4', 'C3:D3', 'C4:D2'].map((x) => [`k:${x.split(':')[0]}`, x.split(':')[1]])), 100,
    async (rt) => { rt.advance(100); rt.setProp('k', 'key', 6); rt.advance(100); rt.setProp('k', 'key', -1); rt.advance(100); rt.setProp('k', 'key', 13); });
  assert.deepEqual(lines(keys), ['6', '0']);
});

test('RTC(DS3231) · OLED(SSD1306) · TM1637 · MAX7219 · 로터리 엔코더 · 적외선 리모컨', opts('RTClib', 'Adafruit_SSD1306', 'TM1637', 'LedControl', 'Encoder', 'IRremote'), async () => {
  const i2c = (id) => [...pw(id), [`${id}:SDA`, 'A4'], [`${id}:SCL`, 'A5']];
  const rtc = await simulate("#include <RTClib.h>\nRTC_DS3231 rtc;\nvoid setup() { Serial.begin(115200); Serial.println(rtc.begin() ? \"ok\" : \"no\"); Serial.println(rtc.lostPower()); Serial.println(rtc.now().year() >= 2024 ? \"now\" : \"old\"); rtc.adjust(DateTime(2024, 5, 6, 7, 8, 9)); delay(2000); DateTime n = rtc.now(); char buf[] = \"YYYY-MM-DD hh:mm:ss\"; Serial.println(n.toString(buf)); }\nvoid loop() {}", wired([{ id: 'c', type: 'rtc' }], i2c('c')), 2500);
  assert.deepEqual(lines(rtc), ['ok', '0', 'now', '2024-05-06 07:08:11']);
  const oled = await simulate('#include <Adafruit_GFX.h>\n#include <Adafruit_SSD1306.h>\nAdafruit_SSD1306 d(128, 64, &Wire, -1);\nvoid setup() { Serial.begin(115200); Serial.println(d.begin(SSD1306_SWITCHCAPVCC, 0x3C) ? "ok" : "fail"); d.clearDisplay(); d.drawPixel(0, 0, SSD1306_WHITE); d.fillRect(8, 8, 8, 8, SSD1306_WHITE); d.display(); }\nvoid loop() {}', wired([{ id: 'o', type: 'oled' }], i2c('o')), 1500);
  assert.equal(lines(oled)[0], 'ok');
  const fb = Buffer.from(oled.state.parts.o.fb, 'base64');
  assert.equal(fb.length, 1024);
  assert.equal(fb[0], 1); // (0,0)
  assert.deepEqual([...fb.subarray(128 + 8, 128 + 16)], new Array(8).fill(255)); // 둘째 줄(8~15행)의 8~15열
  assert.equal(fb.reduce((a, b) => a + (b ? 1 : 0), 0), 9);
  assert.equal(oled.state.parts.o.on, 1);
  const seg = await simulate('#include <TM1637Display.h>\nTM1637Display d(2, 3);\nvoid setup() { d.setBrightness(7); d.showNumberDec(1234); }\nvoid loop() {}', wired([{ id: 't', type: 'tm1637' }], [...pw('t'), ['t:CLK', 'D2'], ['t:DIO', 'D3']]), 300);
  assert.deepEqual(seg.state.parts.t, { seg: [0x06, 0x5B, 0x4F, 0x66], on: 1, br: 7 });
  const dots = await simulate('#include <LedControl.h>\nLedControl lc(12, 11, 10, 1);\nvoid setup() { lc.shutdown(0, false); lc.clearDisplay(0); lc.setLed(0, 0, 0, true); lc.setLed(0, 2, 5, true); lc.setRow(0, 7, 0xFF); }\nvoid loop() {}', wired([{ id: 'm', type: 'max7219' }], [...pw('m'), ['m:DIN', 'D12'], ['m:CLK', 'D11'], ['m:CS', 'D10']]), 300);
  assert.deepEqual(dots.state.parts.m, { rows: [128, 0, 4, 0, 0, 0, 0, 255], on: 1 });
  const enc = await simulate('#include <Encoder.h>\nEncoder e(2, 3); long last = -999;\nvoid setup() { Serial.begin(115200); }\nvoid loop() { long p = e.read(); if (p != last) { last = p; Serial.println(p); } }', wired([{ id: 'e', type: 'encoder' }], [...pw('e'), ['e:CLK', 'D2'], ['e:DT', 'D3']]), 100,
    async (rt) => { rt.advance(100); rt.setProp('e', 'pos', 3); rt.advance(200); rt.setProp('e', 'pos', 1); });
  assert.equal(Math.max(...lines(enc).map(Number)), 12); // 3칸 = 4 x 3
  assert.equal(lines(enc).at(-1), '4');
  const ir = await simulate('#include <IRremote.hpp>\nvoid setup() { Serial.begin(115200); IrReceiver.begin(2); }\nvoid loop() { if (IrReceiver.decode()) { Serial.println(IrReceiver.decodedIRData.command, HEX); IrReceiver.resume(); } }', wired([{ id: 'i', type: 'irrecv' }], [...pw('i'), ['i:OUT', 'D2']]), 300,
    async (rt) => { rt.advance(300); rt.setProp('i', 'send', 0x45); rt.advance(300); rt.setProp('i', 'send', 0x1C); });
  assert.deepEqual(lines(ir), ['45', '1C']);
});
