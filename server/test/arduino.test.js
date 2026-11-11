// 아두이노 시뮬레이터: 스케치 변환기(compiler) · 회로 연결 계산(parts) · 런타임(runtime) 테스트.
// 화면 없이 Node 에서 스케치를 실제로 실행해 시리얼 출력과 부품 상태를 확인합니다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { compileSketch, CompileError } from '../../client/js/arduino/compiler.js';
import { createRuntime } from '../../client/js/arduino/runtime.js';
import { buildNetlist, starterCircuit, emptyCircuit, parseCircuit, STARTER_SKETCH } from '../../client/js/arduino/parts.js';

/** 스케치를 ms 동안 실행하고 시리얼 출력 · 마지막 상태 · 알림을 돌려줌 */
async function simulate(source, circuit, { ms = 250, during } = {}) {
  const out = { serial: '', hints: [], errors: [], state: null };
  const rt = createRuntime({
    post(m) {
      if (m.type === 'serial') out.serial += m.text;
      else if (m.type === 'hint') out.hints.push(m.text);
      else if (m.type === 'error') out.errors.push(m);
      else if (m.type === 'state') out.state = m.state;
    },
  });
  rt.setNet(buildNetlist(circuit || emptyCircuit()));
  const done = rt.run(compileSketch(source).js);
  if (during) await during(rt, out);
  await new Promise((r) => { setTimeout(r, ms); });
  out.state = rt.snapshot();
  rt.stop();
  await done;
  return out;
}
const once = (body, globals = '') => `${globals}\nvoid setup() { Serial.begin(115200);\n${body}\n}\nvoid loop() { delay(1000); }`;
const lines = (r) => r.serial.trim().split('\n');
/** 빵판 없이 부품 핀을 보드 핀에 직접 전선으로 연결한 회로 */
function wired(parts, links) {
  const c = emptyCircuit('uno');
  parts.forEach((p, i) => c.parts.push({ id: p.id, type: p.type, x: 400 + i * 80, y: 400, props: p.props || {} }));
  links.forEach(([a, b], i) => c.wires.push({ id: `w${i}`, a: a.includes(':') ? a : `mcu:${a}`, b: b.includes(':') ? b : `mcu:${b}`, color: '#e53935' }));
  return c;
}

test('compiler: C 자료형 흉내 (16비트 int 넘침, 정수 나눗셈, 부호 없는 수, 형 변환)', async () => {
  const r = await simulate(once(`
    int big = 30000 + 10000; Serial.println(big);
    Serial.println(7 / 2); Serial.println(7 / 2.0); Serial.println(-7 / 2); Serial.println(7 % 3);
    byte b = 250; b += 10; Serial.println(b);
    unsigned int u = 0; u--; Serial.println(u);
    long big2 = 100000L * 3; Serial.println(big2);
    unsigned long t = 4294967295UL; t += 2; Serial.println(t);
    float f = 10 / 4; Serial.println(f); Serial.println((float)10 / 4);
    int x = 3.99; Serial.println(x); Serial.println((int)2.7 + int(1.9));
    char c = 'A' + 2; Serial.println(c); Serial.println(c, DEC);
    Serial.println(255, HEX); Serial.println(5, BIN); Serial.println(3.14159, 3);
    Serial.println(1 << 4 | 0x0F); Serial.println(B101);
    bool ok = 5 > 3 && !(2 == 3); Serial.println(ok); Serial.println(ok ? "yes" : "no");
  `));
  assert.deepEqual(lines(r), ['-25536', '3', '3.50', '-3', '1', '4', '65535', '300000', '1', '2.00', '2.50', '3', '3', 'C', '67', 'FF', '101', '3.142', '31', '5', '1', 'yes']);
  assert.deepEqual(r.errors, []);
});

test('compiler: 제어문 · 함수 · 참조 · 배열 · struct · enum · static · #define', async () => {
  const r = await simulate(once(`
    for (int i = 0; i < 3; i++) { if (i == 1) continue; Serial.print(i); } Serial.println();
    int n = 0; while (true) { if (++n >= 4) break; } Serial.println(n);
    do { n--; } while (n > 0); Serial.println(n);
    switch (MODE) { case IDLE: Serial.println("idle"); break; case RUN: Serial.println("run"); break; default: Serial.println("?"); }
    int p = 1, q = 2; swap(p, q); Serial.print(p); Serial.println(q);
    Serial.println(add(1)); Serial.println(add(1, 2)); Serial.println(SQ(3 + 1));
    Serial.println(sizeof(arr) / sizeof(arr[0])); Serial.println(sum(arr, 4));
    grid[1][2] = 7; Serial.println(grid[1][2] + grid[0][0]);
    pt.x += 2; Serial.println(pt.x + pt.y);
    Point copy = pt; copy.x = 100; Serial.println(pt.x);
    for (int i = 0; i < 3; i++) Serial.print(counter()); Serial.println();
    for (int v : arr) Serial.print(v); Serial.println();
    Serial.println(fact(5));
    int val = 5; int *ptr = &val; *ptr = 9; Serial.println(val);
    Serial.println(names[1]);
  `, `
    #define SQ(x) ((x) * (x))
    #define MODE RUN
    enum Mode { IDLE, RUN = 5, DONE };
    struct Point { int x; float y; };
    Point pt = {3, 1.5};
    int arr[] = {1, 2, 3, 4};
    int grid[2][3];
    const char *names[] = {"kim", "lee"};
    int add(int a, int b = 10) { return a + b; }
    void swap(int &a, int &b) { int t = a; a = b; b = t; }
    int sum(int *v, int n) { int s = 0; for (int i = 0; i < n; i++) s += v[i]; return s; }
    int counter() { static int c = 0; return ++c; }
    long fact(int n) { return n <= 1 ? 1 : n * fact(n - 1); }
  `));
  assert.deepEqual(r.errors, []);
  assert.deepEqual(lines(r), ['02', '4', '0', 'run', '21', '11', '3', '16', '4', '10', '7', '6.50', '5', '123', '1234', '120', '9', 'lee']);
});

test('compiler: String · char 배열 · sprintf', async () => {
  const r = await simulate(once(`
    String s = "abc"; s += 5; s += 'x'; s += 1.5; Serial.println(s);
    Serial.println(s.length()); Serial.println(s.substring(1, 3)); Serial.println(s.indexOf('x'));
    s.toUpperCase(); Serial.println(s); s.replace("ABC", "z"); Serial.println(s);
    String n = "42"; Serial.println(n.toInt() + 1); Serial.println(String(3.14159, 3)); Serial.println(String(255, HEX));
    if (s.startsWith("z") && n == "42") Serial.println("ok");
    Serial.println("t=" + String(21) + "C");
    char buf[24]; sprintf(buf, "v=%03d %s %5.1f|", 7, "ok", 2.25); Serial.println(buf);
    Serial.println(strlen(buf)); char txt[] = "hey"; txt[0] = 'H'; Serial.println(txt);
    dtostrf(3.14159, 6, 2, buf); Serial.println(buf);
  `));
  assert.deepEqual(r.errors, []);
  assert.deepEqual(lines(r), ['abc5x1.50', '9', 'bc', '4', 'ABC5X1.50', 'z5X1.50', '43', '3.142', 'ff', 'ok', 't=21C', 'v=007 ok   2.3|', '15', 'Hey', '  3.14']);
});

test('compiler: 오류에는 줄 번호와 설명이 붙음', () => {
  const err = (src) => { try { compileSketch(src); } catch (e) { assert.ok(e instanceof CompileError); return e; } return assert.fail('오류가 나야 함'); };
  assert.match(err('void setup() {}').message, /loop\(\)/);
  const semi = err('void setup() {\n  int a = 1\n  a = 2;\n}\nvoid loop() {}');
  assert.match(semi.message, /세미콜론/);
  assert.equal(semi.line, 2);
  const undef = err('void setup() {\n  cnt = 1;\n}\nvoid loop() {}');
  assert.match(undef.message, /cnt.*선언되지/);
  assert.equal(undef.line, 2);
  assert.match(err('void setup() { digitalWrit(1, 1); }\nvoid loop() {}').message, /digitalWrit/);
  assert.match(err('void setup() {\nvoid loop() {}').message, /닫는 중괄호/);
});

test('compiler: 변환된 코드는 런타임 밖으로 나갈 수 없음 (샌드박스)', () => {
  const bad = (body) => assert.throws(() => compileSketch(`void setup() { ${body} }\nvoid loop() {}`), CompileError, body);
  bad('fetch("https://example.com");');
  bad('int x = globalThis;');
  bad('Serial.constructor.constructor("return 1")();');
  bad('String s = "a"; s.constructor;');
  bad('int a[2]; a.__proto__ = 0;');
  bad('int constructor = 1;');
  // 사용자가 쓴 이름은 모두 $ 가 붙고, 배열 첨자는 숫자로 강제됨
  const { js } = compileSketch('int self = 1; int process = 2; int a[2];\nvoid setup() { String k = "constructor"; a[self] = process; }\nvoid loop() {}');
  assert.match(js, /\$self/);
  assert.match(js, /\$process/);
  assert.doesNotMatch(js, /[^$\w.]process\b/);
  assert.doesNotMatch(js, /\[\$k\]/);
});

test('회로: 시작 회로의 LED 는 D13 이 HIGH 일 때 켜지고 전류가 제한됨', async () => {
  const r = await simulate(STARTER_SKETCH, starterCircuit(), { ms: 200 });
  assert.match(r.serial, /시작!/);
  assert.equal(r.state.pins.D13.v, 1);
  const mA = r.state.parts.led1.i;
  assert.ok(mA > 8 && mA < 20, `LED 전류 ${mA}mA`);
  assert.deepEqual(r.state.warn, []);
});

test('회로: 저항 없는 LED 는 과전류 경고, 거꾸로 꽂으면 안 켜짐, pinMode 누락은 알려 줌', async () => {
  const sketch = 'void setup() { pinMode(8, OUTPUT); digitalWrite(8, HIGH); }\nvoid loop() { delay(50); }';
  const direct = await simulate(sketch, wired([{ id: 'l', type: 'led' }], [['D8', 'l:A'], ['l:K', 'GND']]));
  assert.ok(direct.state.parts.l.i > 30);
  assert.match(direct.state.warn.join(), /저항/);
  const reversed = await simulate(sketch, wired([{ id: 'l', type: 'led' }, { id: 'r', type: 'resistor', props: { ohm: 220 } }], [['D8', 'r:A'], ['r:B', 'l:K'], ['l:A', 'GND']]));
  assert.equal(reversed.state.parts.l.i, 0);
  const noMode = await simulate('void setup() { digitalWrite(8, HIGH); }\nvoid loop() { delay(50); }', wired([], []));
  assert.match(noMode.hints.join(), /pinMode\(D8, OUTPUT\)/);
  const short = buildNetlist(wired([], [['5V', 'GND']]));
  assert.equal(short.short, true);
});

test('실제처럼: 합선이면 보드가 꺼지고, 과전류 LED 는 타며, 연결이 빠지면 부품이 멈춤', async () => {
  // 합선: 스케치가 아예 돌지 않음
  const shorted = await simulate('void setup() { Serial.begin(115200); Serial.println("run"); }\nvoid loop() { delay(20); }', wired([], [['5V', 'GND']]));
  assert.equal(shorted.serial, '');
  assert.match(shorted.errors[0].message, /합선/);
  // 저항 없는 LED 는 1.5초 뒤 타서 꺼짐
  const burn = await simulate('void setup() { pinMode(8, OUTPUT); digitalWrite(8, HIGH); }\nvoid loop() { delay(50); }', wired([{ id: 'l', type: 'led' }], [['D8', 'l:A'], ['l:K', 'GND']]), { ms: 1900 });
  assert.deepEqual(burn.state.parts.l, { i: 0, x: 1 });
  assert.match(burn.state.warn.join(), /타 버렸/);
  // 로드셀: 연결이 없으면 값을 지어내지 않고 실제 라이브러리처럼 그 자리에서 기다림
  const hx = await simulate('#include <HX711.h>\nHX711 s;\nvoid setup() { Serial.begin(115200); s.begin(3, 2); Serial.println("a"); s.tare(); Serial.println("b"); }\nvoid loop() { delay(20); }', wired([{ id: 'h', type: 'hx711' }], [['h:VCC', '5V'], ['h:GND', 'GND'], ['h:DT', 'D3']]));
  assert.equal(hx.serial, 'a\n');
  assert.match(hx.hints.join(), /기다리고/);
  // 5V 가 필요한 부품은 3.3V 로 동작하지 않음
  const lcdSketch = '#include <LiquidCrystal_I2C.h>\nLiquidCrystal_I2C lcd(0x27, 16, 2);\nvoid setup() { lcd.init(); }\nvoid loop() { lcd.setCursor(0, 0); lcd.print("hi"); delay(30); }';
  const lcdAt = (vcc, extra = []) => wired([{ id: 'l', type: 'lcd' }], [['l:VCC', vcc], ['l:GND', 'GND'], ['l:SDA', 'A4'], ['l:SCL', 'A5'], ...extra]);
  const low = await simulate(lcdSketch, lcdAt('3V3'));
  assert.equal(low.state.parts.l, undefined);
  assert.match(low.hints.join(), /5V 전원이 필요/);
  // 실행 중에 전원선을 빼면 LCD 가 꺼짐
  const unplug = await simulate(lcdSketch, lcdAt('5V'), { ms: 300, during: async (rt, out) => {
    await new Promise((x) => { setTimeout(x, 120); });
    out.before = rt.snapshot().parts.l;
    const c = lcdAt('5V'); c.wires = c.wires.filter((w) => w.b !== 'mcu:5V');
    rt.setNet(buildNetlist(c));
  } });
  assert.equal(unplug.before.l[0].trimEnd(), 'hi');
  assert.equal(unplug.state.parts.l, undefined);
  // 신호선만 틀리면 백라이트는 켜지지만 글자는 없음
  const c = lcdAt('5V'); c.wires = c.wires.filter((w) => w.b !== 'mcu:A4');
  const noSda = await simulate(lcdSketch, c);
  assert.deepEqual(noSda.state.parts.l, { l: [], b: 1 });
  // GPS: 통신 속도가 다르면 위치를 읽지 못함
  const gps = await simulate(`#include <SoftwareSerial.h>\n#include <TinyGPS++.h>\nSoftwareSerial ss(4, 3);\nTinyGPSPlus gps;
    void setup() { Serial.begin(115200); ss.begin(4800); }
    void loop() { while (ss.available()) gps.encode(ss.read()); if (millis() > 1150) { Serial.println(gps.location.isValid() ? "fix" : "none"); delay(5000); } }`,
  wired([{ id: 'g', type: 'gps' }], [['g:VCC', '5V'], ['g:GND', 'GND'], ['g:TX', 'D4']]), { ms: 1300 });
  assert.equal(gps.serial.trim(), 'none');
});

test('회로: 버튼(INPUT_PULLUP) · 떠 있는 핀 · 가변저항 분압 · PWM', async () => {
  const circuit = wired(
    [{ id: 'btn', type: 'button' }, { id: 'pot', type: 'pot', props: { pos: 0.25 } }, { id: 'l', type: 'led' }, { id: 'r', type: 'resistor', props: { ohm: 220 } }],
    [['D2', 'btn:A'], ['btn:B', 'GND'], ['pot:1', 'GND'], ['pot:2', '5V'], ['pot:W', 'A0'], ['D9', 'r:A'], ['r:B', 'l:A'], ['l:K', 'GND']],
  );
  const sketch = `
    void setup() { Serial.begin(115200); pinMode(2, INPUT_PULLUP); pinMode(9, OUTPUT); }
    void loop() { Serial.print(digitalRead(2)); Serial.print(' '); Serial.println(analogRead(A0)); analogWrite(9, 64); delay(20); }`;
  const r = await simulate(sketch, circuit, { ms: 220, during: async (rt) => { await new Promise((x) => { setTimeout(x, 100); }); rt.setProp('btn', 'pressed', true); rt.setProp('pot', 'pos', 0.75); } });
  const rows = lines(r).map((l) => l.split(' ').map(Number));
  assert.equal(rows[0][0], 1);
  assert.ok(Math.abs(rows[0][1] - 256) < 6, `A0 ${rows[0][1]}`);
  assert.equal(rows.at(-1)[0], 0);
  assert.ok(Math.abs(rows.at(-1)[1] - 767) < 6);
  assert.ok(r.state.parts.l.i > 0.5 && r.state.parts.l.i < 6, `PWM LED ${r.state.parts.l.i}`);
  const floating = await simulate('void setup() { pinMode(2, INPUT); }\nvoid loop() { digitalRead(2); delay(20); }', wired([{ id: 'btn', type: 'button' }], [['D2', 'btn:A'], ['btn:B', 'GND']]));
  assert.match(floating.hints.join(), /떠 있음/);
});

test('센서: DHT (연결됨 / 신호선 틀림 / 전원 없음)', async () => {
  const sketch = `#include <DHT.h>
    DHT dht(2, DHT22);
    void setup() { Serial.begin(115200); dht.begin(); }
    void loop() { float t = dht.readTemperature(); if (isnan(t)) Serial.println("fail"); else { Serial.print(t, 0); Serial.print("/"); Serial.println(dht.readHumidity(), 0); } delay(40); }`;
  const dht = { id: 'd', type: 'dht', props: { temp: 31, hum: 64 } };
  const good = await simulate(sketch, wired([dht], [['d:VCC', '5V'], ['d:GND', 'GND'], ['d:DATA', 'D2']]));
  assert.equal(lines(good)[0], '31/64');
  const wrongPin = await simulate(sketch, wired([dht], [['d:VCC', '5V'], ['d:GND', 'GND'], ['d:DATA', 'D3']]));
  assert.equal(lines(wrongPin)[0], 'fail');
  assert.match(wrongPin.hints.join(), /DATA → D2/);
  const noPower = await simulate(sketch, wired([dht], [['d:GND', 'GND'], ['d:DATA', 'D2']]));
  assert.match(noPower.hints.join(), /전원/);
});

test('센서: 빵판에 꽂은 부품은 같은 세로줄의 전선과 이어짐', async () => {
  const c = emptyCircuit('uno');
  c.parts.push({ id: 'bb', type: 'breadboard', x: 0, y: 250, props: {} }, { id: 'd', type: 'dht', x: 0 + 20 + 40, y: 250 + 102, props: { temp: 20, hum: 40 } }); // f5 · f6 · f7
  c.wires.push({ id: 'a', a: 'bb:j5', b: 'bb:bp5', color: '#f00' }, { id: 'b', a: 'bb:bp30', b: 'mcu:5V', color: '#f00' }, { id: 'c', a: 'bb:h7', b: 'mcu:GND.2', color: '#000' }, { id: 'd', a: 'bb:g6', b: 'mcu:D4', color: '#0f0' });
  const net = buildNetlist(c);
  const part = net.parts[0];
  assert.equal(part.pins.VCC, net.pins['5V']);
  assert.equal(part.pins.GND, net.pins.GND);
  assert.equal(part.pins.DATA, net.pins.D4);
  assert.notEqual(part.pins.DATA, net.pins.D5);
  assert.equal(net.short, false);
});

test('센서: BMP280 고도 · MPU6050 (라이브러리와 Wire 직접 읽기) · I2C 스캔', async () => {
  const circuit = wired(
    [{ id: 'b', type: 'bmp280', props: { alt: 320, temp: 18, sea: 1013.25 } }, { id: 'm', type: 'mpu6050', props: { ax: 0.5, ay: 0, az: 1, gx: 10, gy: 0, gz: 0, temp: 25 } }],
    [['b:VCC', '3V3'], ['b:GND', 'GND'], ['b:SDA', 'A4'], ['b:SCL', 'A5'], ['m:VCC', '5V'], ['m:GND', 'GND'], ['m:SDA', 'A4'], ['m:SCL', 'A5']],
  );
  const r = await simulate(once(`
    Wire.begin();
    Serial.println(bmp.begin(0x76) ? "bmp ok" : "bmp fail");
    Serial.println(bmp.readAltitude(1013.25), 0); Serial.println(bmp.readTemperature(), 0); Serial.println(bmp.readPressure() / 100.0F, 0);
    Serial.println(mpu.begin() ? "mpu ok" : "mpu fail");
    mpu.setAccelerometerRange(MPU6050_RANGE_8_G);
    sensors_event_t a, g, temp; mpu.getEvent(&a, &g, &temp);
    Serial.println(a.acceleration.x, 1); Serial.println(a.acceleration.z, 1);
    Wire.beginTransmission(0x68); Wire.write(0x3B); Wire.endTransmission(false); Wire.requestFrom(0x68, 6, true);
    int16_t rawX = Wire.read() << 8 | Wire.read(); Serial.println(rawX / 16384.0, 1);
    int found = 0; for (byte addr = 1; addr < 127; addr++) { Wire.beginTransmission(addr); if (Wire.endTransmission() == 0) found++; } Serial.println(found);
  `, '#include <Wire.h>\n#include <Adafruit_BMP280.h>\n#include <Adafruit_MPU6050.h>\nAdafruit_BMP280 bmp;\nAdafruit_MPU6050 mpu;'), circuit);
  assert.deepEqual(r.errors, []);
  assert.deepEqual(lines(r), ['bmp ok', '320', '18', '975', 'mpu ok', '4.9', '9.8', '0.5', '2']);
  const none = await simulate(once('Serial.println(bmp.begin() ? "ok" : "fail");', 'Adafruit_BMP280 bmp;'), wired([{ id: 'b', type: 'bmp280' }], [['b:VCC', '5V'], ['b:GND', 'GND']]));
  assert.equal(lines(none)[0], 'fail');
  assert.match(none.hints.join(), /SDA → A4/);
});

test('센서: 로드셀(HX711) · 초음파(HC-SR04) · 서보 · LCD · 부저', async () => {
  const circuit = wired(
    [{ id: 'h', type: 'hx711', props: { weight: 250 } }, { id: 'u', type: 'hcsr04', props: { dist: 80 } }, { id: 's', type: 'servo' }, { id: 'lcd', type: 'lcd' }, { id: 'bz', type: 'buzzer' }],
    [['h:VCC', '5V'], ['h:GND', 'GND'], ['h:DT', 'D3'], ['h:SCK', 'D2'], ['u:VCC', '5V'], ['u:GND', 'GND'], ['u:TRIG', 'D7'], ['u:ECHO', 'D6'],
      ['s:VCC', '5V'], ['s:GND', 'GND'], ['s:SIG', 'D9'], ['lcd:VCC', '5V'], ['lcd:GND', 'GND'], ['lcd:SDA', 'A4'], ['lcd:SCL', 'A5'], ['bz:+', 'D8'], ['bz:-', 'GND']],
  );
  const r = await simulate(once(`
    scale.begin(3, 2); scale.set_scale(430); scale.set_offset(84210);
    Serial.println(round(scale.get_units(10) / 10.0));
    pinMode(7, OUTPUT); pinMode(6, INPUT);
    digitalWrite(7, LOW); delayMicroseconds(2); digitalWrite(7, HIGH); delayMicroseconds(10); digitalWrite(7, LOW);
    long us = pulseIn(6, HIGH); Serial.println(round(us / 58.2));
    servo.attach(9); servo.write(135);
    lcd.init(); lcd.backlight(); lcd.setCursor(0, 0); lcd.print("Temp:"); lcd.print(23.5, 1); lcd.setCursor(0, 1); lcd.print(42);
    tone(8, 440);
  `, '#include <HX711.h>\n#include <Servo.h>\n#include <LiquidCrystal_I2C.h>\nHX711 scale;\nServo servo;\nLiquidCrystal_I2C lcd(0x27, 16, 2);'), circuit);
  assert.deepEqual(r.errors, []);
  assert.deepEqual(lines(r), ['25', '80']);
  assert.equal(r.state.parts.s.a, 135);
  assert.deepEqual(r.state.parts.lcd.l.map((x) => x.trimEnd()), ['Temp:23.5', '42']);
  assert.equal(r.state.parts.bz.f, 440);
});

test('센서: GPS NMEA → SoftwareSerial → TinyGPS++', async () => {
  const circuit = wired([{ id: 'g', type: 'gps', props: { lat: 35.1796, lng: 129.0756, alt: 12, speed: 36, sats: 9, fix: true } }], [['g:VCC', '5V'], ['g:GND', 'GND'], ['g:TX', 'D4'], ['g:RX', 'D3']]);
  const sketch = `#include <SoftwareSerial.h>
    #include <TinyGPS++.h>
    SoftwareSerial ss(4, 3);
    TinyGPSPlus gps;
    bool shown = false;
    void setup() { Serial.begin(115200); ss.begin(9600); }
    void loop() {
      while (ss.available() > 0) {
        if (gps.encode(ss.read()) && gps.location.isValid() && gps.speed.isValid() && !shown) {
          shown = true;
          Serial.println(gps.location.lat(), 3); Serial.println(gps.location.lng(), 3);
          Serial.println(gps.altitude.meters(), 0); Serial.println(gps.speed.kmph(), 0); Serial.println(gps.satellites.value());
          Serial.println(gps.date.year() > 2020 ? "date ok" : "date bad");
          Serial.println(TinyGPSPlus::distanceBetween(35.1796, 129.0756, 37.5665, 126.978) / 1000, 0);
        }
      }
    }`;
  const r = await simulate(sketch, circuit, { ms: 1300 });
  assert.deepEqual(r.errors, []);
  assert.deepEqual(lines(r), ['35.180', '129.076', '12', '36', '9', 'date ok', '325']);
});

test('런타임: 시리얼 입력 · 인터럽트 · millis · 실행 중 오류의 줄 번호', async () => {
  const echo = await simulate(`
    void setup() { Serial.begin(115200); }
    void loop() { if (Serial.available()) { String s = Serial.readStringUntil('\\n'); Serial.print("got "); Serial.println(s); int n = s.toInt(); Serial.println(n * 2); } }`,
  null, { during: async (rt) => { await new Promise((x) => { setTimeout(x, 60); }); rt.serialIn('21\n'); } });
  assert.deepEqual(lines(echo), ['got 21', '42']);
  const irq = await simulate(`
    volatile int hits = 0;
    void onPress() { hits++; }
    void setup() { Serial.begin(115200); pinMode(2, INPUT_PULLUP); attachInterrupt(digitalPinToInterrupt(2), onPress, FALLING); }
    void loop() { static unsigned long last = 0; if (millis() - last >= 150) { last = millis(); Serial.println(hits); } }`,
  wired([{ id: 'btn', type: 'button' }], [['D2', 'btn:A'], ['btn:B', 'GND']]),
  { ms: 380, during: async (rt) => { await new Promise((x) => { setTimeout(x, 40); }); rt.setProp('btn', 'pressed', true); rt.setProp('btn', 'pressed', false); rt.setProp('btn', 'pressed', true); } });
  assert.equal(lines(irq).at(-1), '2');
  const crash = await simulate('void boom(int n) { boom(n + 1); }\nvoid setup() {\n  boom(1);\n}\nvoid loop() {}');
  assert.match(crash.errors[0].message, /재귀/);
  const noBegin = await simulate('void setup() { Serial.println("x"); }\nvoid loop() { delay(10); }');
  assert.equal(noBegin.serial, '');
  assert.match(noBegin.hints.join(), /Serial\.begin/);
});

test('회로 파일: 잘못된 JSON · 모르는 부품은 걸러짐', () => {
  assert.equal(parseCircuit('{'), null);
  assert.equal(parseCircuit('{"parts":1}'), null);
  const c = parseCircuit(JSON.stringify({ board: 'mega', parts: [{ id: 'a', type: 'led', x: '5', y: null }, { id: 'b', type: 'constructor' }, { id: 'mcu', type: 'led' }, { id: '<x>', type: 'led' }], wires: [{ a: 'mcu:D1', b: 'a:A', color: 'red;' }, { a: 1 }] }));
  assert.equal(c.board, 'uno');
  assert.deepEqual(c.parts.map((p) => [p.id, p.x, p.y]), [['a', 5, 0]]);
  assert.equal(c.wires.length, 1);
  assert.match(c.wires[0].color, /^#/);
  assert.deepEqual(parseCircuit(JSON.stringify(starterCircuit())), starterCircuit());
});
