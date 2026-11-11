// 실제 기계어 실행기(avr-runtime.js)용 부품 모델 모음 — 라이브러리가 핀으로 내보내는 신호를 그대로 해석합니다.
//   DS18B20(1-Wire) · NeoPixel(WS2812) · RTC DS3231(I2C) · 스테퍼 모터 · 병렬 LCD(HD44780) · OLED SSD1306(I2C)
//   TM1637 숫자 표시기 · MAX7219 LED 매트릭스 · 로터리 엔코더 · 적외선 수신기(NEC 리모컨)
// ctx: avr-runtime 이 내주는 도구 { cpu, US, drive, after, powered, mcuDrive, pstate, touch, node, hint, wallStart, simMs, redo }

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const bcd = (v) => ((Math.floor(v / 10) % 10) << 4) | (v % 10);
const unbcd = (v) => (v >> 4) * 10 + (v & 15);

/** Dallas 1-Wire CRC8 */
export function crc8(bytes) {
  let crc = 0;
  for (let b of bytes) for (let i = 0; i < 8; i++) { const mix = (crc ^ b) & 1; crc >>= 1; if (mix) crc ^= 0x8C; b >>= 1; }
  return crc;
}

/** HD44780 글자 LCD 의 두뇌: 4비트씩 받은 값을 명령 · 글자로 해석해 2줄 화면을 만듦 */
export function hd44780(onShow) {
  let fourBit = false; let high = -1; let addr = 0; let on = false; let inc = 1;
  const ram = new Uint8Array(128).fill(32);
  const line = (base) => Array.from(ram.slice(base, base + 16), (c) => (c >= 32 && c < 127 ? String.fromCharCode(c) : c < 8 ? '▯' : '▒')).join('');
  const show = () => onShow(on ? [line(0), line(0x40)] : []);
  const command = (c) => {
    if (c & 0x80) addr = c & 0x7F;
    else if (c & 0x40) { /* 사용자 글자(CGRAM)는 그리지 않음 */ } else if (c & 0x20) { /* 기능 설정 */ } else if (c & 0x10) addr = (addr + (c & 4 ? 1 : -1)) & 0x7F;
    else if (c & 0x08) on = !!(c & 4);
    else if (c & 0x04) inc = c & 2 ? 1 : -1;
    else if (c & 0x02) addr = 0;
    else if (c & 0x01) { ram.fill(32); addr = 0; }
  };
  return {
    nibble(rs, nib) {
      if (!fourBit) { if (!rs && nib === 2) fourBit = true; return; }
      if (high < 0) { high = nib; return; }
      const v = (high << 4) | nib;
      high = -1;
      if (rs) { ram[addr & 0x7F] = v; addr = (addr + inc) & 0x7F; } else command(v);
      show();
    },
    reset() { fourBit = false; high = -1; on = false; ram.fill(32); addr = 0; },
  };
}

// 흔한 17키 리모컨의 NEC 명령 값
export const IR_KEYS = { 1: 0x45, 2: 0x46, 3: 0x47, 4: 0x44, 5: 0x40, 6: 0x43, 7: 0x07, 8: 0x15, 9: 0x09, '*': 0x16, 0: 0x19, '#': 0x0D, '▲': 0x18, '◀': 0x08, OK: 0x1C, '▶': 0x5A, '▼': 0x52 };

export function extraMakers(ctx) {
  const { cpu, US, drive, after, powered, mcuDrive, pstate, touch, hint } = ctx;
  const high = (nd) => mcuDrive(nd) === 1;
  const put = (dev, value) => { if (JSON.stringify(pstate.get(dev.part.id)) !== JSON.stringify(value)) { pstate.set(dev.part.id, value); touch(); } };

  return {
    // ── DS18B20: 1-Wire (리셋 → 존재 신호, ROM 검색, 온도 변환, 스크래치패드 읽기) ──
    ds18b20(dev) {
      const rom = [0x28, 0xAA, 0x3C, 0x11, 0x5A, 0x16, 0x01];
      rom.push(crc8(rom));
      const romBits = rom.flatMap((b) => Array.from({ length: 8 }, (_, i) => (b >> i) & 1));
      let lowSince = -1; let state = 'idle'; let tx = []; let rx = 0; let rxN = 0; let readSlot = false; let searchAt = 0; let skip = 0; let busyUntil = 0;
      let raw = 85 * 16; // 전원을 넣은 직후의 값은 85℃ (변환 명령을 받아야 실제 온도가 됨)
      dev.lines = ['DQ'];
      const bits = (bytes) => bytes.flatMap((b) => Array.from({ length: 8 }, (_, i) => (b >> i) & 1));
      const onByte = (b) => {
        if (state === 'rom') {
          if (b === 0xCC) state = 'func';
          else if (b === 0x55) { state = 'match'; skip = 8; } else if (b === 0x33) { tx = romBits.slice(); state = 'func'; } else if (b === 0xF0) { state = 'search'; searchAt = 0; tx = [romBits[0], 1 - romBits[0]]; } else state = 'idle';
        } else if (state === 'match') { skip--; if (!skip) state = 'func'; } else if (state === 'func') {
          if (b === 0x44) { raw = Math.round(clamp(Number(dev.part.props.temp), -55, 125) * 16 + (Math.random() - 0.5)); busyUntil = cpu.cycles + 750000 * US; state = 'idle'; } else if (b === 0xBE) { const t = raw & 0xFFFF; const sp = [t & 255, t >> 8, 0x4B, 0x46, 0x7F, 0xFF, 0x0C, 0x10]; sp.push(crc8(sp)); tx = bits(sp); } else if (b === 0x4E) { state = 'match'; skip = 3; } else if (b === 0xB4) tx = [1];
          else state = 'idle';
        }
      };
      dev.onLine = (nd, t) => {
        const d = mcuDrive(nd);
        if (d === 0) {
          if (lowSince >= 0) return;
          lowSince = t;
          readSlot = false;
          if (!powered(dev.part)) return;
          if (tx.length) { // 읽기 칸: 0 을 보낼 때만 선을 잠깐 잡아당김
            readSlot = true;
            const bit = tx.shift();
            if (!bit) { drive(nd, 0); after(38, () => drive(nd, null)); }
            if (state === 'search' && !tx.length) state = 'search-dir';
          } else if (cpu.cycles < busyUntil && state === 'idle') { readSlot = true; drive(nd, 0); after(38, () => drive(nd, null)); } // 변환 중에는 0
          return;
        }
        if (lowSince < 0) return;
        const us = (t - lowSince) / US;
        lowSince = -1;
        if (!powered(dev.part)) return;
        if (us >= 380) { // 리셋 → 30μs 뒤 120μs 동안 존재 신호
          state = 'rom'; tx = []; rx = 0; rxN = 0;
          after(30, () => drive(nd, 0)); after(150, () => drive(nd, null));
          return;
        }
        if (readSlot) return;
        const bit = us < 25 ? 1 : 0;
        if (state === 'search-dir') {
          if (bit !== romBits[searchAt]) { state = 'idle'; return; }
          searchAt++;
          if (searchAt >= 64) { state = 'func'; rx = 0; rxN = 0; } else { state = 'search'; tx = [romBits[searchAt], 1 - romBits[searchAt]]; }
          return;
        }
        if (state === 'idle' || state === 'search') return;
        rx |= bit << rxN; rxN++;
        if (rxN === 8) { const b = rx; rx = 0; rxN = 0; onByte(b); }
      };
    },

    // ── NeoPixel (WS2812): HIGH 구간이 짧으면 0, 길면 1 — 24비트(G R B)마다 LED 하나 ──
    neopixel(dev) {
      let rise = -1; let lastEdge = 0; let bitN = 0; let cur = 0; let px = []; let pending = false;
      dev.lines = ['DIN'];
      const publish = () => {
        if (cpu.cycles - lastEdge < 80 * US) { after(120, publish); return; }
        pending = false;
        const count = clamp(Number(dev.part.props.count) || 8, 1, 64);
        put(dev, { px: Array.from({ length: count }, (_, i) => px[i] || '#000000') });
      };
      dev.refresh = () => { if (!powered(dev.part) && pstate.has(dev.part.id)) { pstate.delete(dev.part.id); px = []; touch(); } };
      dev.onLine = (nd, t) => {
        if (high(nd)) { if (t - lastEdge > 50 * US) { bitN = 0; cur = 0; } rise = t; lastEdge = t; return; }
        if (rise < 0) return;
        const width = t - rise;
        rise = -1; lastEdge = t;
        if (!powered(dev.part) || width > 40) return;
        cur = (cur << 1) | (width > 9 ? 1 : 0);
        bitN++;
        if (bitN % 24 === 0) {
          const i = bitN / 24 - 1;
          const g = (cur >> 16) & 255; const r = (cur >> 8) & 255; const b = cur & 255;
          px[i] = `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
          cur = 0;
          if (!pending) { pending = true; after(300, publish); }
        }
      };
    },

    // ── RTC DS3231 (DS1307 과 시간 레지스터가 같음): I2C 0x68 ──
    rtc(dev) {
      let ptr = 0; let first = true; let base = null; let latched = new Uint8Array(7);
      const regs = new Uint8Array(0x13);
      regs[0x0E] = 0x1C;
      const now = () => new Date((base ?? ctx.wallStart - new Date(ctx.wallStart).getTimezoneOffset() * 60000) + ctx.simMs());
      const latch = () => { const d = now(); latched = Uint8Array.from([bcd(d.getUTCSeconds()), bcd(d.getUTCMinutes()), bcd(d.getUTCHours()), d.getUTCDay() + 1, bcd(d.getUTCDate()), bcd(d.getUTCMonth() + 1), bcd(d.getUTCFullYear() % 100)]); };
      let wrote = false;
      dev.i2c = {
        addr: 0x68,
        begin() { if (wrote) { // 시각을 써 넣었으면 그때부터 다시 흐름
          const t = Date.UTC(2000 + unbcd(latched[6]), unbcd(latched[5] & 0x1F) - 1, unbcd(latched[4]), unbcd(latched[2] & 0x3F), unbcd(latched[1]), unbcd(latched[0] & 0x7F));
          if (Number.isFinite(t)) base = t - ctx.simMs();
          wrote = false;
        } first = true; },
        write(v) {
          if (first) { ptr = v % 0x13; first = false; return; }
          if (ptr < 7) { if (!wrote) latch(); latched[ptr] = v; wrote = true; } else if (ptr === 0x0F) regs[ptr] = v & 0x7F; else regs[ptr] = v;
          ptr = (ptr + 1) % 0x13;
        },
        read() {
          if (ptr === 0) latch();
          let v = ptr < 7 ? latched[ptr] : regs[ptr];
          if (ptr === 0x0F && dev.part.props.battery === false && base === null) v |= 0x80; // 배터리가 없었으면 "시간을 잃음" 표시
          if (ptr === 0x11) v = 25;
          ptr = (ptr + 1) % 0x13;
          return v;
        },
      };
      if (dev.part.props.battery === false) base = Date.UTC(2000, 0, 1) - ctx.simMs(); // 배터리 없이 켜면 2000-01-01 부터
    },

    // ── 스테퍼 모터 28BYJ-48 + ULN2003: 코일(IN1~IN4)이 만드는 자기장의 방향이 돌아간 만큼 회전 ──
    stepper(dev) {
      let last = null; let pos = 0;
      dev.lines = ['IN1', 'IN2', 'IN3', 'IN4'];
      let stamp = 0;
      // 핀은 하나씩 바뀌므로 잠깐 스쳐 가는 상태가 생김 → 0.3ms 이상 유지된 상태만 코일 상태로 봄 (모터는 그보다 빨리 움직이지 못함)
      dev.onLine = (nd, t) => { stamp = t; after(300, () => { if (stamp === t) settle(); }); };
      const settle = () => {
        if (!powered(dev.part)) return;
        const P = dev.part.pins;
        const l = [P.IN1, P.IN2, P.IN3, P.IN4].map((nd) => (nd !== undefined && high(nd) ? 1 : 0));
        const x = l[0] - l[2]; const y = l[1] - l[3];
        if (!x && !y) return; // 마주 보는 코일이 함께 켜지거나 모두 꺼짐: 힘이 없음
        const ang = Math.atan2(y, x);
        if (last !== null) {
          let d = ang - last;
          while (d > Math.PI) d -= 2 * Math.PI;
          while (d < -Math.PI) d += 2 * Math.PI;
          if (Math.abs(Math.abs(d) - Math.PI) > 0.01) pos += d / (Math.PI / 2);
        }
        last = ang;
        const per = Number(dev.part.props.steps) || 2048;
        put(dev, { a: Math.round((((pos / per) * 360) % 360 + 360) % 360), n: Math.round(pos) });
      };
    },

    // ── 병렬 글자 LCD (RS · E · D4~D7 로 직접 연결) ──
    lcd16(dev) {
      let eHigh = false;
      const core = hd44780((lines) => put(dev, { l: lines, b: 1 }));
      dev.lines = ['E'];
      dev.off = () => core.reset();
      dev.onLine = (nd) => {
        const up = high(nd);
        if (up === eHigh) return;
        eHigh = up;
        if (up || !powered(dev.part)) return; // E 가 내려갈 때 읽음
        const P = dev.part.pins;
        const bit = (n) => (n !== undefined && high(n) ? 1 : 0);
        core.nibble(bit(P.RS), bit(P.D4) | (bit(P.D5) << 1) | (bit(P.D6) << 2) | (bit(P.D7) << 3));
      };
    },

    // ── OLED SSD1306 128x64: I2C 0x3C, 명령(0x00 …) / 화면 데이터(0x40 …) ──
    oled(dev) {
      const fb = new Uint8Array(1024);
      let mode = 0; let col = 0; let page = 0; let c0 = 0; let c1 = 127; let p0 = 0; let p1 = 7; let on = false; let inv = false;
      let control = -1; let args = 0; let cmd = 0; let argv = []; let dirtyFb = false;
      const ARGS = { 0x20: 1, 0x21: 2, 0x22: 2, 0x81: 1, 0x8D: 1, 0xA8: 1, 0xD3: 1, 0xD5: 1, 0xD9: 1, 0xDA: 1, 0xDB: 1, 0x26: 6, 0x27: 6, 0x29: 5, 0x2A: 5, 0xA3: 2 };
      const run = () => {
        if (cmd === 0x20) mode = argv[0] & 3;
        else if (cmd === 0x21) { c0 = argv[0] & 127; c1 = argv[1] & 127; col = c0; } else if (cmd === 0x22) { p0 = argv[0] & 7; p1 = argv[1] & 7; page = p0; }
      };
      const command = (b) => {
        if (args > 0) { argv.push(b); args--; if (!args) run(); return; }
        if (ARGS[b]) { cmd = b; args = ARGS[b]; argv = []; return; }
        if (b === 0xAE || b === 0xAF) { on = b === 0xAF; dirtyFb = true; } else if (b === 0xA6 || b === 0xA7) { inv = b === 0xA7; dirtyFb = true; } else if (b >= 0xB0 && b <= 0xB7) page = b & 7;
        else if (b <= 0x0F) col = (col & 0xF0) | b;
        else if (b >= 0x10 && b <= 0x1F) col = (col & 0x0F) | ((b & 0x0F) << 4);
      };
      const data = (b) => {
        fb[page * 128 + (col & 127)] = b;
        dirtyFb = true;
        col++;
        if (mode === 2) { if (col > 127) col = 0; return; }
        if (col > c1) { col = c0; page++; if (page > p1) page = p0; }
      };
      dev.refresh = () => {
        if (!powered(dev.part)) { if (pstate.has(dev.part.id)) { pstate.delete(dev.part.id); touch(); } on = false; return; }
        if (!dirtyFb) return;
        dirtyFb = false;
        let bin = '';
        for (let i = 0; i < 1024; i++) bin += String.fromCharCode(fb[i]);
        put(dev, { fb: btoa(bin), on: on ? 1 : 0, inv: inv ? 1 : 0 });
      };
      dev.fast = dev.refresh; // 화면은 자주 갱신
      dev.i2c = {
        addr: 0x3C,
        begin() { control = -1; },
        write(b) {
          if (control < 0) { control = b; return; }
          if (control & 0x40) data(b); else { command(b); if (control & 0x80) control = -1; }
        },
        read() { return on ? 0x00 : 0x40; },
      };
    },

    // ── TM1637 4자리 숫자 표시기: CLK · DIO 두 선 (시작/정지 조건이 있는 직렬 통신) ──
    tm1637(dev) {
      let clk = true; let dio = true; let bitN = 0; let cur = 0; let bytes = []; let active = false; let addr = 0;
      const seg = [0, 0, 0, 0, 0, 0];
      let bright = 7; let on = false;
      dev.lines = ['CLK', 'DIO'];
      const frame = () => {
        if (!bytes.length) return;
        const c = bytes[0];
        if ((c & 0xC0) === 0xC0) { addr = c & 7; bytes.slice(1).forEach((b, i) => { if (addr + i < 6) seg[addr + i] = b; }); } else if ((c & 0xC0) === 0x80) { on = !!(c & 8); bright = c & 7; }
        put(dev, { seg: seg.slice(0, 4), on: on ? 1 : 0, br: bright });
      };
      dev.refresh = () => { if (!powered(dev.part) && pstate.has(dev.part.id)) { pstate.delete(dev.part.id); on = false; touch(); } };
      dev.onLine = () => {
        const P = dev.part.pins;
        const c = mcuDrive(P.CLK) !== 0; const d = mcuDrive(P.DIO) !== 0; // 풀업: 아두이노가 0 으로 당기지 않으면 1
        if (!powered(dev.part)) { clk = c; dio = d; return; }
        if (c && clk && d !== dio) { // CLK 가 HIGH 인 동안 DIO 가 바뀜: 내려가면 시작, 올라가면 끝
          if (!d) { active = true; bitN = 0; cur = 0; bytes = []; } else if (active) { active = false; frame(); }
        } else if (c && !clk && active) { // CLK 가 올라갈 때 한 비트 (낮은 자리부터), 9번째는 응답 칸
          if (bitN < 8) { cur |= (d ? 1 : 0) << bitN; bitN++; } else { bytes.push(cur); cur = 0; bitN = 0; }
        }
        clk = c; dio = d;
      };
    },

    // ── MAX7219 8x8 LED 매트릭스: DIN · CLK 로 16비트를 밀어 넣고 CS 가 올라갈 때 적용 ──
    max7219(dev) {
      let shift = 0; let clk = false; let cs = true;
      const rows = new Array(8).fill(0);
      let on = false; let test = false;
      dev.lines = ['CLK', 'CS'];
      const latch = () => {
        const a = (shift >> 8) & 0x0F; const v = shift & 0xFF;
        if (a >= 1 && a <= 8) rows[a - 1] = v;
        else if (a === 0x0C) on = !!(v & 1);
        else if (a === 0x0F) test = !!(v & 1);
        put(dev, { rows: test ? new Array(8).fill(255) : rows.slice(), on: on || test ? 1 : 0 });
      };
      dev.refresh = () => { if (!powered(dev.part) && pstate.has(dev.part.id)) { pstate.delete(dev.part.id); on = false; rows.fill(0); touch(); } };
      dev.spi = (b) => { if (powered(dev.part)) shift = ((shift << 8) | b) & 0xFFFF; }; // 하드웨어 SPI 로 보낼 때 (DIN = D11, CLK = D13)
      dev.onLine = () => {
        const P = dev.part.pins;
        const c = high(P.CLK); const s = mcuDrive(P.CS) !== 0;
        if (!powered(dev.part)) { clk = c; cs = s; return; }
        if (c && !clk && !s) shift = ((shift << 1) | (high(P.DIN) ? 1 : 0)) & 0xFFFF;
        if (s && !cs) latch();
        clk = c; cs = s;
      };
    },

    // ── 로터리 엔코더: 손잡이를 돌리면 두 접점(CLK · DT)이 어긋난 순서로 붙었다 떨어짐 ──
    encoder(dev) {
      let cur = (Number(dev.part.props.pos) || 0) * 4; let moving = false;
      const step = () => {
        const target = Math.round(Number(dev.part.props.pos) || 0) * 4;
        if (cur === target) { moving = false; return; }
        cur += cur < target ? 1 : -1;
        dev.part.props.phase = ((cur % 4) + 4) % 4;
        ctx.redo();
        after(1500, step); // 접점 하나가 바뀌는 데 1.5ms
      };
      dev.part.props.phase = ((cur % 4) + 4) % 4;
      dev.refresh = () => { dev.part.props.phase = ((cur % 4) + 4) % 4; if (!moving && cur !== Math.round(Number(dev.part.props.pos) || 0) * 4) { moving = true; step(); } };
      dev.action = (key) => { if (key === 'pos') { after(10, () => dev.refresh()); } return false; };
    },

    // ── 적외선 수신기 (VS1838B): 리모컨 버튼을 누르면 NEC 신호가 OUT 에 나옴 (신호가 있을 때 LOW) ──
    irrecv(dev) {
      let busy = false;
      dev.refresh = () => { if (powered(dev.part)) { if (!busy) drive(dev.part.pins.OUT, 1); } else if (!busy) drive(dev.part.pins.OUT, null); };
      dev.action = (key, value) => {
        if (key !== 'send') return false;
        if (busy || !powered(dev.part)) { if (!powered(dev.part)) hint('적외선 수신기: 전원이 들어오지 않아 리모컨 신호를 받지 못합니다.'); return true; }
        const command = Number(value) & 255;
        const bytes = [0x00, 0xFF, command, ~command & 255];
        const edges = [[0, 0], [9000, 1]];
        let at = 13500;
        for (const b of bytes) for (let i = 0; i < 8; i++) { edges.push([at, 0]); at += 562; edges.push([at, 1]); at += (b >> i) & 1 ? 1687 : 562; }
        edges.push([at, 0], [at + 562, 1]);
        busy = true;
        const out = dev.part.pins.OUT;
        for (const [us, level] of edges) after(us + 5, () => drive(out, level));
        after(at + 3000, () => { busy = false; });
        return true;
      };
    },

    // 키패드는 전기적인 스위치일 뿐이라 회로 계산(circuit-sim.js)이 처리
  };
}
