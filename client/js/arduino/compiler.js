// 아두이노 스케치(.ino, C++ 의 자주 쓰는 부분) → 비동기 JavaScript 변환기.
// 실제 AVR 컴파일러가 아니라 "가르치고 실험하는 용도"의 변환기입니다:
//   · 자료형 크기를 흉내 냄 (우노의 int 는 16비트라 32767 을 넘으면 음수가 됨, 정수 나눗셈은 버림 …)
//   · delay() 등은 await 로 바뀌어 화면이 멈추지 않음
// 보안: 사용자가 쓴 이름은 모두 `$이름` 으로 바뀌고, 배열 첨자는 숫자로 강제되며, constructor · __proto__ 같은
//       속성 이름은 거부하므로 변환된 코드는 런타임이 내준 것(__r, __g, __L, __S) 밖으로 나갈 수 없습니다.

export class CompileError extends Error {
  constructor(message, line) { super(message); this.name = 'CompileError'; this.line = line || 0; }
}

const table = (o) => Object.assign(Object.create(null), o); // 'constructor' 같은 이름이 걸리지 않도록 원형 없는 표
const TYPE_WORDS = table({
  void: 'void', bool: 'bool', boolean: 'bool', char: 'char', byte: 'uchar', uint8_t: 'uchar', int8_t: 'char',
  int: 'int', short: 'int', int16_t: 'int', uint16_t: 'uint', word: 'uint', size_t: 'uint', long: 'long', int32_t: 'long', uint32_t: 'ulong',
  float: 'float', double: 'float', String: 'String', int64_t: 'llong', uint64_t: 'llong', auto: 'any',
});
const QUALS = new Set(['const', 'volatile', 'extern', 'register', 'inline', 'constexpr', 'static', 'unsigned', 'signed']);
const INTS = new Set(['bool', 'char', 'uchar', 'int', 'uint', 'long', 'ulong']);
const SIZE = table({ bool: 1, char: 1, uchar: 1, int: 2, uint: 2, long: 4, ulong: 4, float: 4, llong: 8, cstr: 2, any: 2, String: 6 });
const BAD_PROPS = new Set(['constructor', 'prototype', '__proto__', '__defineGetter__', '__defineSetter__', '__lookupGetter__', '__lookupSetter__', 'caller', 'callee', 'arguments']);

/** 라이브러리 클래스 (런타임 __L 에 구현됨) */
export const LIB_CLASSES = new Set([
  'DHT', 'Adafruit_BMP280', 'Adafruit_BMP085', 'Adafruit_BME280', 'TinyGPSPlus', 'SoftwareSerial', 'HX711', 'MPU6050', 'Adafruit_MPU6050',
  'sensors_event_t', 'Servo', 'LiquidCrystal_I2C',
]);

// 내장 함수: 이름 → [반환형, 비동기?]  ('*' 는 인자의 자료형을 따름)
const F = (t, a) => [t, !!a];
const BUILTIN_FUNCS = table({
  pinMode: F('void'), digitalWrite: F('void'), digitalRead: F('int'), analogRead: F('int'), analogWrite: F('void'), analogReference: F('void'),
  delay: F('void', 1), delayMicroseconds: F('void', 1), yield: F('void', 1), millis: F('ulong'), micros: F('ulong'),
  map: F('long'), constrain: F('*'), min: F('*'), max: F('*'), abs: F('*'), sq: F('*'),
  sqrt: F('float'), pow: F('float'), sin: F('float'), cos: F('float'), tan: F('float'), atan: F('float'), atan2: F('float'), asin: F('float'), acos: F('float'),
  exp: F('float'), log: F('float'), log10: F('float'), floor: F('float'), ceil: F('float'), round: F('long'), fabs: F('float'), fmod: F('float'),
  radians: F('float'), degrees: F('float'), isnan: F('bool'), isinf: F('bool'),
  random: F('long'), randomSeed: F('void'), tone: F('void'), noTone: F('void'), pulseIn: F('ulong', 1), pulseInLong: F('ulong', 1),
  shiftOut: F('void'), shiftIn: F('int'), attachInterrupt: F('void'), detachInterrupt: F('void'), digitalPinToInterrupt: F('int'), interrupts: F('void'), noInterrupts: F('void'),
  bitRead: F('int'), bit: F('long'), lowByte: F('uchar'), highByte: F('uchar'), F: F('cstr'),
  isDigit: F('bool'), isAlpha: F('bool'), isAlphaNumeric: F('bool'), isSpace: F('bool'), isWhitespace: F('bool'), isUpperCase: F('bool'), isLowerCase: F('bool'), isPunct: F('bool'),
  isdigit: F('bool'), isalpha: F('bool'), isalnum: F('bool'), isspace: F('bool'), toupper: F('int'), tolower: F('int'),
  strlen: F('int'), strcpy: F('cstr'), strncpy: F('cstr'), strcat: F('cstr'), strcmp: F('int'), strncmp: F('int'), atoi: F('int'), atol: F('long'), atof: F('float'),
  itoa: F('cstr'), ltoa: F('cstr'), utoa: F('cstr'), ultoa: F('cstr'), dtostrf: F('cstr'), sprintf: F('int'), snprintf: F('int'), memset: F('void'),
});
const BUILTIN_CONSTS = table({
  HIGH: 'int', LOW: 'int', INPUT: 'int', OUTPUT: 'int', INPUT_PULLUP: 'int', LED_BUILTIN: 'int', PI: 'float', HALF_PI: 'float', TWO_PI: 'float',
  DEG_TO_RAD: 'float', RAD_TO_DEG: 'float', EULER: 'float', CHANGE: 'int', RISING: 'int', FALLING: 'int', DEC: 'int', HEX: 'int', OCT: 'int', BIN: 'int',
  MSBFIRST: 'int', LSBFIRST: 'int', A0: 'int', A1: 'int', A2: 'int', A3: 'int', A4: 'int', A5: 'int', A6: 'int', A7: 'int', SDA: 'int', SCL: 'int',
  DHT11: 'int', DHT12: 'int', DHT21: 'int', DHT22: 'int', AM2301: 'int', NULL: 'int', nullptr: 'int', DEFAULT: 'int', INTERNAL: 'int', EXTERNAL: 'int',
});
const BUILTIN_OBJECTS = new Set(['Serial', 'Wire']);
// String 메서드: 이름 → [반환형, 원본을 바꾸는가]
const STRING_METHODS = table({
  length: ['int'], charAt: ['char'], substring: ['String'], indexOf: ['int'], lastIndexOf: ['int'], toInt: ['long'], toFloat: ['float'], toDouble: ['float'],
  equals: ['bool'], equalsIgnoreCase: ['bool'], startsWith: ['bool'], endsWith: ['bool'], compareTo: ['int'], c_str: ['cstr'], isEmpty: ['bool'],
  trim: ['void', 1], toUpperCase: ['void', 1], toLowerCase: ['void', 1], replace: ['void', 1], remove: ['void', 1], concat: ['void', 1], setCharAt: ['void', 1], reserve: ['void', 1],
  toCharArray: ['void'], getBytes: ['void'],
});

// 실수를 돌려주는 라이브러리 메서드 · 속성 (Serial.print 가 소수 둘째 자리까지 찍도록)
const FLOAT_MEMBERS = new Set(['readTemperature', 'readHumidity', 'readPressure', 'readAltitude', 'computeHeatIndex', 'convertCtoF', 'convertFtoC', 'get_units', 'get_scale',
  'lat', 'lng', 'meters', 'feet', 'kilometers', 'kmph', 'mps', 'knots', 'mph', 'deg', 'hdop', 'parseFloat', 'distanceBetween', 'courseTo', 'temperature', 'relative_humidity', 'pressure', 'x', 'y', 'z']);

// ───────── 1. 전처리 + 토큰 ─────────
const OPS = ['>>=', '<<=', '...', '->', '++', '--', '<<', '>>', '<=', '>=', '==', '!=', '&&', '||', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '::',
  '+', '-', '*', '/', '%', '<', '>', '=', '!', '~', '&', '|', '^', '?', ':', ';', ',', '.', '(', ')', '[', ']', '{', '}'];
const ESC = { n: '\n', t: '\t', r: '\r', 0: '\0', '\\': '\\', "'": "'", '"': '"', a: '\x07', b: '\b', f: '\f', v: '\v', e: '\x1b', '?': '?' };

function stripComments(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    const d = src[i + 1];
    if (c === '/' && d === '/') { while (i < n && src[i] !== '\n') i++; } else if (c === '/' && d === '*') {
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) { if (src[i] === '\n') out += '\n'; i++; }
      i += 2;
      out += ' ';
    } else if (c === '"' || c === "'") {
      const q = c;
      out += c; i++;
      while (i < n && src[i] !== q && src[i] !== '\n') { if (src[i] === '\\') { out += src[i]; i++; } out += src[i] ?? ''; i++; }
      if (src[i] === q) { out += q; i++; }
    } else { out += c; i++; }
  }
  return out;
}

function unescape(body, line) {
  let s = '';
  for (let i = 0; i < body.length; i++) {
    if (body[i] !== '\\') { s += body[i]; continue; }
    i++;
    const c = body[i];
    if (c === 'x') { const m = /^[0-9a-fA-F]{1,2}/.exec(body.slice(i + 1)); if (!m) throw new CompileError('잘못된 \\x 이스케이프', line); s += String.fromCharCode(parseInt(m[0], 16)); i += m[0].length; } else if (/[0-7]/.test(c) && c !== '0') { const m = /^[0-7]{1,3}/.exec(body.slice(i)); s += String.fromCharCode(parseInt(m[0], 8)); i += m[0].length - 1; } else s += ESC[c] ?? c;
  }
  return s;
}

function tokenizeLine(text, line, out) {
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (c === ' ' || c === '\t' || c === '\r') { i++; continue; }
    const rest = text.slice(i);
    let m;
    if ((m = /^[A-Za-z_]\w*/.exec(rest))) {
      // B00101 형태의 2진수 상수
      if (/^B[01]{1,8}$/.test(m[0])) out.push({ t: 'num', v: parseInt(m[0].slice(1), 2), ty: 'int', line }); else out.push({ t: 'id', v: m[0], line });
      i += m[0].length;
    } else if ((m = /^(0[xX][0-9a-fA-F]+|0[bB][01]+|(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?)([uUlLfF]*)/.exec(rest)) && m[0]) {
      const body = m[1];
      const suf = m[4].toLowerCase();
      let v; let ty;
      if (/^0[xX]/.test(body)) v = parseInt(body, 16); else if (/^0[bB]/.test(body)) v = parseInt(body.slice(2), 2); else if (/^0\d+$/.test(body)) v = parseInt(body, 8); else v = Number(body);
      if (/[.eE]/.test(body) && !/^0[xX]/.test(body) || suf.includes('f')) ty = 'float';
      else if (suf.includes('u')) ty = suf.includes('l') || v > 65535 ? 'ulong' : 'uint';
      else if (suf.includes('l')) ty = 'long';
      else ty = v <= 32767 ? 'int' : v <= 2147483647 ? 'long' : 'ulong';
      if (!Number.isFinite(v)) throw new CompileError(`잘못된 숫자: ${m[0]}`, line);
      out.push({ t: 'num', v, ty, line });
      i += m[0].length;
    } else if (c === '"') {
      let j = i + 1;
      while (j < n && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      if (j >= n) throw new CompileError('문자열의 닫는 따옴표(") 가 없습니다', line);
      const v = unescape(text.slice(i + 1, j), line);
      const prev = out[out.length - 1];
      if (prev && prev.t === 'str' && prev.line === line) prev.v += v; else out.push({ t: 'str', v, line }); // "a" "b" 이어 붙이기
      i = j + 1;
    } else if (c === "'") {
      let j = i + 1;
      while (j < n && text[j] !== "'") j += text[j] === '\\' ? 2 : 1;
      if (j >= n) throw new CompileError("문자의 닫는 따옴표(') 가 없습니다", line);
      const v = unescape(text.slice(i + 1, j), line);
      out.push({ t: 'num', v: v.charCodeAt(0) || 0, ty: 'char', line });
      i = j + 1;
    } else {
      const op = OPS.find((o) => rest.startsWith(o));
      if (!op) throw new CompileError(`알 수 없는 문자: ${c}`, line);
      out.push({ t: 'op', v: op, line });
      i += op.length;
    }
  }
}

function preprocess(source) {
  const lines = stripComments(source.replace(/\r\n?/g, '\n')).split('\n');
  const toks = [];
  const macros = new Map();
  const includes = [];
  const cond = []; // #if 스택: true = 이 구간을 사용
  const active = () => cond.every(Boolean);
  for (let li = 0; li < lines.length; li++) {
    let text = lines[li];
    const line = li + 1;
    while (text.endsWith('\\') && li + 1 < lines.length) { li++; text = `${text.slice(0, -1)} ${lines[li]}`; }
    const d = /^\s*#\s*(\w+)\s*(.*)$/.exec(text);
    if (!d) { if (active()) tokenizeLine(text, line, toks); continue; }
    const [, dir, rest] = d;
    if (dir === 'ifdef') cond.push(macros.has(rest.trim()));
    else if (dir === 'ifndef') cond.push(!macros.has(rest.trim()));
    else if (dir === 'if') { const r = rest.trim(); const m = /^!?\s*defined\s*\(?\s*(\w+)\s*\)?$/.exec(r); cond.push(m ? macros.has(m[1]) !== r.startsWith('!') : r !== '0'); } else if (dir === 'else') { if (cond.length) cond[cond.length - 1] = !cond[cond.length - 1]; } else if (dir === 'elif') { if (cond.length) cond[cond.length - 1] = false; } else if (dir === 'endif') cond.pop();
    else if (!active()) continue;
    else if (dir === 'include') { const m = /[<"]([^>"]+)[>"]/.exec(rest); if (m) includes.push(m[1]); } else if (dir === 'define') {
      const m = /^(\w+)(\(([^)]*)\))?\s*(.*)$/.exec(rest);
      if (!m) throw new CompileError('잘못된 #define', line);
      const body = [];
      tokenizeLine(m[4], line, body);
      macros.set(m[1], { params: m[2] ? m[3].split(',').map((s) => s.trim()).filter(Boolean) : null, body });
    } else if (dir === 'undef') macros.delete(rest.trim());
  }
  // 매크로 펼치기
  const expand = (list, depth, hide) => {
    if (depth > 30) throw new CompileError('#define 이 너무 깊게 서로를 부릅니다', list[0]?.line);
    const out = [];
    for (let i = 0; i < list.length; i++) {
      const t = list[i];
      const mac = t.t === 'id' && !hide.has(t.v) ? macros.get(t.v) : null;
      if (!mac) { out.push(t); continue; }
      let body = mac.body;
      if (mac.params) {
        if (list[i + 1]?.v !== '(') { out.push(t); continue; }
        const args = [[]];
        let depthP = 0;
        let j = i + 2;
        for (; j < list.length; j++) {
          const a = list[j];
          if (a.t === 'op' && (a.v === '(' || a.v === '[' || a.v === '{')) depthP++;
          if (a.t === 'op' && (a.v === ')' || a.v === ']' || a.v === '}')) { if (!depthP) break; depthP--; }
          if (a.t === 'op' && a.v === ',' && !depthP) args.push([]); else args[args.length - 1].push(a);
        }
        if (j >= list.length) throw new CompileError(`매크로 ${t.v} 의 괄호가 닫히지 않았습니다`, t.line);
        body = body.flatMap((b) => { const k = b.t === 'id' ? mac.params.indexOf(b.v) : -1; return k >= 0 ? (args[k] || []) : [b]; });
        i = j;
      }
      out.push(...expand(body.map((b) => ({ ...b, line: t.line })), depth + 1, new Set([...hide, t.v])));
    }
    return out;
  };
  return { toks: expand(toks, 0, new Set()), includes };
}

// ───────── 2. 구문 분석 ─────────
const BIN_PREC = [['||'], ['&&'], ['|'], ['^'], ['&'], ['==', '!='], ['<', '>', '<=', '>='], ['<<', '>>'], ['+', '-'], ['*', '/', '%']];
const ASSIGN_OPS = new Set(['=', '+=', '-=', '*=', '/=', '%=', '<<=', '>>=', '&=', '|=', '^=']);

function parse(toks) {
  let i = 0;
  const structs = new Set();
  const enums = new Set();
  const typedefs = new Map();
  const libTypes = new Set(LIB_CLASSES);
  const vars = new Set();
  const eofLine = toks.length ? toks[toks.length - 1].line : 1;
  const peek = (k = 0) => toks[i + k] || { t: 'eof', v: '<끝>', line: eofLine };
  const next = () => toks[i++] || { t: 'eof', v: '<끝>', line: eofLine };
  const is = (v, k = 0) => { const t = peek(k); return t.t !== 'str' && t.t !== 'num' && t.v === v; };
  const eat = (v) => (is(v) ? (i++, true) : false);
  const fail = (msg, tok = peek()) => { throw new CompileError(msg, tok.line); };
  const expect = (v) => { if (!eat(v)) fail(`'${v}' 가 와야 하는데 '${peek().v}' 가 있습니다${v === ';' ? ' (세미콜론을 빠뜨렸나요?)' : ''}`, v === ';' && i > 0 ? toks[i - 1] : peek()); };
  const ident = () => { const t = next(); if (t.t !== 'id') fail(`이름이 와야 하는데 '${t.v}' 가 있습니다`, t); return t.v; };
  const isTypeName = (v) => structs.has(v) || enums.has(v) || typedefs.has(v) || libTypes.has(v);
  const strictTypeStart = (k = 0) => { const t = peek(k); return t.t === 'id' && (QUALS.has(t.v) || t.v in TYPE_WORDS || isTypeName(t.v) || t.v === 'struct' || t.v === 'enum' || t.v === 'class'); };

  /** 자료형 읽기. 자료형이 아니면 null (위치는 그대로) */
  function parseType() {
    const start = i;
    let unsigned = false; let isStatic = false; let isConst = false; let named = null; const words = [];
    for (;;) {
      const t = peek();
      if (t.t !== 'id') break;
      if (t.v === 'static') { isStatic = true; i++; } else if (t.v === 'unsigned') { unsigned = true; i++; } else if (QUALS.has(t.v)) { if (t.v === 'const' || t.v === 'constexpr') isConst = true; i++; } else if ((t.v === 'struct' || t.v === 'enum' || t.v === 'class') && peek(1).t === 'id' && !is('{', 2) && !words.length && !named) { i++; named = next().v; } else if (t.v in TYPE_WORDS && !named) { words.push(t.v); i++; } else if (!words.length && !named && !unsigned && isTypeName(t.v)) { named = t.v; i++; } else break;
    }
    if (!words.length && !named && !unsigned) { i = start; return null; }
    let type;
    if (named) type = typedefs.get(named) || (enums.has(named) ? 'int' : structs.has(named) ? `S:${named}` : `O:${named}`);
    else {
      const longs = words.filter((w) => w === 'long').length;
      const base = words.map((w) => TYPE_WORDS[w]);
      if (longs >= 2) type = 'llong';
      else if (base.includes('float')) type = 'float';
      else if (base.includes('char')) type = 'char';
      else if (longs) type = 'long';
      else type = base.find((b) => b !== 'int') || 'int';
      if (!words.length) type = 'int';
      if (unsigned) type = { char: 'uchar', int: 'uint', long: 'ulong' }[type] || type;
    }
    return { type, isStatic, isConst };
  }

  const ptrType = (type, ptr) => (!ptr ? type : (type === 'char' || type === 'uchar') ? 'cstr' : (type.startsWith('S:') || type.startsWith('O:') || type === 'cstr' || type === 'void') ? type : `R:${type}`);

  function isDeclStart() {
    const t = peek();
    if (t.t !== 'id') return false;
    if (t.v in TYPE_WORDS) return !is('(', 1);
    if (QUALS.has(t.v) || isTypeName(t.v)) return !is('(', 1) && !is('.', 1) && !is('::', 1);
    if ((t.v === 'struct' || t.v === 'enum' || t.v === 'class') && peek(1).t === 'id') return true;
    if (vars.has(t.v) || t.v in BUILTIN_FUNCS || t.v in BUILTIN_CONSTS || BUILTIN_OBJECTS.has(t.v)) return false;
    // 모르는 클래스 이름: `Foo bar;` `Foo bar(…);` `Foo *bar;`
    if (peek(1).t === 'id' || ((is('*', 1) || is('&', 1)) && peek(2).t === 'id' && [';', '=', ',', '['].includes(peek(3).v))) { libTypes.add(t.v); return true; }
    return false;
  }

  function parseInitList() {
    const line = peek().line;
    expect('{');
    const items = [];
    while (!is('}')) { items.push(is('{') ? parseInitList() : parseAssign()); if (!eat(',')) break; }
    expect('}');
    return { k: 'init', items, line };
  }

  function parseDeclarators(base, top) {
    const decls = [];
    do {
      let ptr = 0; let ref = false;
      for (;;) { if (eat('*')) ptr++; else if (eat('&')) ref = true; else if (is('const')) i++; else break; }
      const line = peek().line;
      const name = ident();
      vars.add(name);
      const dims = [];
      while (eat('[')) { dims.push(is(']') ? null : parseExpr()); expect(']'); }
      if (is('PROGMEM')) i++;
      const d = { name, type: ptrType(base.type, ptr), ref, dims, line };
      if (eat('=')) d.init = is('{') ? parseInitList() : parseAssign();
      else if (is('{')) d.init = parseInitList();
      else if (is('(') && !top) { i++; d.ctor = parseArgs(); } else if (is('(')) { i++; d.ctor = parseArgs(); }
      decls.push(d);
    } while (eat(','));
    return decls;
  }

  function parseArgs() { // '(' 는 이미 먹음
    const args = [];
    if (!eat(')')) { do args.push(parseAssign()); while (eat(',')); expect(')'); }
    return args;
  }

  // ── 식 ──
  function parseExpr() {
    const first = parseAssign();
    if (!is(',')) return first;
    const list = [first];
    while (eat(',')) list.push(parseAssign());
    return { k: 'seq', list, line: first.line };
  }
  function parseAssign() {
    const left = parseCond();
    const t = peek();
    if (t.t === 'op' && ASSIGN_OPS.has(t.v)) { i++; return { k: 'assign', op: t.v, a: left, b: is('{') ? parseInitList() : parseAssign(), line: t.line }; }
    return left;
  }
  function parseCond() {
    const c = parseBin(0);
    if (!is('?')) return c;
    const line = next().line;
    const a = parseAssign();
    expect(':');
    return { k: 'cond', c, a, b: parseAssign(), line };
  }
  function parseBin(level) {
    if (level >= BIN_PREC.length) return parseUnary();
    let left = parseBin(level + 1);
    for (;;) {
      const t = peek();
      if (t.t !== 'op' || !BIN_PREC[level].includes(t.v)) return left;
      i++;
      left = { k: 'bin', op: t.v, a: left, b: parseBin(level + 1), line: t.line };
    }
  }
  function tryCast() {
    if (!is('(') || !strictTypeStart(1)) return null;
    const save = i;
    i++;
    const ty = parseType();
    let ptr = 0;
    while (eat('*')) ptr++;
    if (!ty || !eat(')')) { i = save; return null; }
    return ptrType(ty.type, ptr);
  }
  function parseUnary() {
    const t = peek();
    if (t.t === 'op' && ['!', '~', '-', '+', '*', '&', '++', '--'].includes(t.v)) { i++; return { k: 'un', op: t.v, a: parseUnary(), line: t.line }; }
    if (t.t === 'id' && t.v === 'sizeof') {
      i++;
      if (is('(') && strictTypeStart(1)) { i++; const ty = parseType(); while (eat('*')) ty.type = 'cstr'; expect(')'); return { k: 'sizeof', type: ty.type, line: t.line }; }
      return { k: 'sizeof', a: parseUnary(), line: t.line };
    }
    const cast = tryCast();
    if (cast) return { k: 'cast', type: cast, a: parseUnary(), line: t.line };
    return parsePostfix();
  }
  function parsePostfix() {
    let e = parsePrimary();
    for (;;) {
      const t = peek();
      if (t.t !== 'op') return e;
      if (t.v === '(') { i++; e = { k: 'call', f: e, args: parseArgs(), line: t.line }; } else if (t.v === '[') { i++; const idx = parseExpr(); expect(']'); e = { k: 'idx', a: e, i: idx, line: t.line }; } else if (t.v === '.' || t.v === '->') { i++; e = { k: 'mem', a: e, name: ident(), line: t.line }; } else if (t.v === '++' || t.v === '--') { i++; e = { k: 'post', op: t.v, a: e, line: t.line }; } else return e;
    }
  }
  function parsePrimary() {
    const t = next();
    if (t.t === 'num') return { k: 'num', v: t.v, t: t.ty, line: t.line };
    if (t.t === 'str') return { k: 'str', v: t.v, line: t.line };
    if (t.t === 'op' && t.v === '(') { const e = parseExpr(); expect(')'); return { k: 'paren', a: e, line: t.line }; }
    if (t.t === 'id') {
      if (t.v === 'true' || t.v === 'false') return { k: 'num', v: t.v === 'true' ? 1 : 0, t: 'bool', line: t.line };
      if (['new', 'delete', 'goto', 'template', 'operator', 'this', 'throw', 'try'].includes(t.v)) fail(`'${t.v}' 는 이 시뮬레이터에서 지원하지 않습니다`, t);
      // 함수 모양 형 변환: int(x), float(x), String(x, 2) …
      if ((t.v in TYPE_WORDS || t.v === 'unsigned') && (is('(') || t.v === 'unsigned')) {
        i--;
        const ty = parseType();
        expect('(');
        const args = parseArgs();
        return { k: 'cast', type: ty.type, a: args[0] || { k: 'num', v: 0, t: 'int', line: t.line }, extra: args[1], line: t.line };
      }
      if (is('::')) { i++; return { k: 'scope', a: t.v, name: ident(), line: t.line }; }
      return { k: 'id', name: t.v, line: t.line };
    }
    return fail(`식이 와야 하는데 '${t.v}' 가 있습니다`, t);
  }

  // ── 문장 ──
  function parseBlock() {
    const line = peek().line;
    expect('{');
    const body = [];
    while (!is('}')) { if (peek().t === 'eof') fail("'}' 가 빠졌습니다 (중괄호의 짝이 맞지 않습니다)"); body.push(parseStatement()); }
    i++;
    return { k: 'block', body, line };
  }
  function parseLocalDecl() {
    const line = peek().line;
    const base = parseType() || (() => { const name = next().v; libTypes.add(name); return { type: `O:${name}` }; })();
    return { k: 'decl', base, decls: parseDeclarators(base, false), line };
  }
  function parseStatement() {
    const t = peek();
    if (t.t === 'op') {
      if (t.v === '{') return parseBlock();
      if (t.v === ';') { i++; return { k: 'empty', line: t.line }; }
    }
    if (t.t === 'id') {
      switch (t.v) {
        case 'if': {
          i++; expect('(');
          const c = parseExpr(); expect(')');
          const a = parseStatement();
          const b = eat('else') ? parseStatement() : null;
          return { k: 'if', c, a, b, line: t.line };
        }
        case 'while': { i++; expect('('); const c = parseExpr(); expect(')'); return { k: 'while', c, body: parseStatement(), line: t.line }; }
        case 'do': { i++; const body = parseStatement(); if (!eat('while')) fail("do 뒤에는 while 이 와야 합니다"); expect('('); const c = parseExpr(); expect(')'); expect(';'); return { k: 'do', c, body, line: t.line }; }
        case 'for': {
          i++; expect('(');
          let init = null;
          if (!is(';')) {
            if (isDeclStart()) {
              init = parseLocalDecl();
              if (eat(':')) { const coll = parseExpr(); expect(')'); return { k: 'forof', decl: init, coll, body: parseStatement(), line: t.line }; }
            } else init = { k: 'expr', e: parseExpr(), line: t.line };
          }
          expect(';');
          const c = is(';') ? null : parseExpr(); expect(';');
          const step = is(')') ? null : parseExpr(); expect(')');
          return { k: 'for', init, c, step, body: parseStatement(), line: t.line };
        }
        case 'switch': {
          i++; expect('('); const c = parseExpr(); expect(')'); expect('{');
          const cases = [];
          while (!eat('}')) {
            if (peek().t === 'eof') fail("switch 의 '}' 가 빠졌습니다");
            if (eat('case')) { const v = parseCond(); expect(':'); cases.push({ v, body: [] }); } else if (eat('default')) { expect(':'); cases.push({ v: null, body: [] }); } else { if (!cases.length) fail('switch 안에는 case 가 먼저 와야 합니다'); cases[cases.length - 1].body.push(parseStatement()); }
          }
          return { k: 'switch', c, cases, line: t.line };
        }
        case 'break': i++; expect(';'); return { k: 'break', line: t.line };
        case 'continue': i++; expect(';'); return { k: 'continue', line: t.line };
        case 'return': { i++; const e = is(';') ? null : parseExpr(); expect(';'); return { k: 'return', e, line: t.line }; }
        case 'else': return fail("짝이 되는 if 가 없는 else 입니다");
        default:
      }
      if (isDeclStart()) {
        const d = parseLocalDecl();
        if (is('{') && d.decls.at(-1).ctor) fail("함수 안에서는 다른 함수를 만들 수 없습니다. 바로 앞 함수의 닫는 중괄호 '}' 가 빠졌는지 확인하세요");
        expect(';');
        return d;
      }
    }
    const e = parseExpr();
    expect(';');
    return { k: 'expr', e, line: t.line };
  }

  // ── 최상위 ──
  function parseStruct(line) {
    let name = peek().t === 'id' ? next().v : null;
    if (eat(':')) { while (!is('{') && peek().t !== 'eof') i++; }
    expect('{');
    const fields = [];
    while (!eat('}')) {
      if (peek().t === 'eof') fail("struct 의 '}' 가 빠졌습니다");
      if ((is('public') || is('private') || is('protected')) && is(':', 1)) { i += 2; continue; }
      const base = parseType();
      if (!base) fail(`struct 안에서 알 수 없는 자료형 '${peek().v}'`);
      if (peek(1).v === '(' || peek().v === '(') fail('struct / class 안의 함수(메서드)는 이 시뮬레이터에서 지원하지 않습니다');
      for (const d of parseDeclarators(base, false)) { vars.delete(d.name); fields.push(d); }
      expect(';');
    }
    return { name, fields, line, setName(n) { name = n; this.name = n; } };
  }
  function parseEnum(line) {
    eat('class');
    const name = peek().t === 'id' ? next().v : null;
    if (eat(':')) parseType();
    expect('{');
    const items = [];
    while (!eat('}')) { const n = ident(); vars.add(n); items.push({ name: n, value: eat('=') ? parseCond() : null }); if (!eat(',')) { expect('}'); break; } }
    if (name) enums.add(name);
    return { k: 'enum', name, items, line };
  }

  const program = [];
  while (peek().t !== 'eof') {
    const t = peek();
    if (eat(';')) continue;
    if (t.t !== 'id') fail(`'${t.v}' 는 여기에 올 수 없습니다`);
    if (t.v === 'typedef') {
      i++;
      if ((is('struct') || is('class')) && (is('{', 1) || is('{', 2))) {
        i++;
        const s = parseStruct(t.line);
        const alias = ident();
        if (!s.name) s.setName(alias); else typedefs.set(alias, `S:${s.name}`);
        structs.add(s.name);
        program.push({ k: 'struct', name: s.name, fields: s.fields, line: t.line });
      } else if (is('enum')) { i++; const e = parseEnum(t.line); enums.add(ident()); program.push(e); } else {
        const base = parseType();
        if (!base) fail('typedef 뒤에 자료형이 와야 합니다');
        let ptr = 0;
        while (eat('*')) ptr++;
        typedefs.set(ident(), ptrType(base.type, ptr));
      }
      expect(';');
      continue;
    }
    if ((t.v === 'struct' || t.v === 'class') && (is('{', 1) || (peek(1).t === 'id' && (is('{', 2) || is(':', 2))))) {
      if (t.v === 'class') fail('class 정의는 이 시뮬레이터에서 지원하지 않습니다 (struct 는 변수만 담을 수 있습니다)');
      i++;
      const s = parseStruct(t.line);
      if (!s.name) s.setName(`__anon${program.length}`);
      structs.add(s.name);
      program.push({ k: 'struct', name: s.name, fields: s.fields, line: t.line });
      if (!is(';')) { const base = { type: `S:${s.name}` }; program.push({ k: 'decl', base, decls: parseDeclarators(base, true), line: t.line }); }
      expect(';');
      continue;
    }
    if (t.v === 'enum' && (is('{', 1) || is('{', 2) || is('class', 1) || is(':', 2))) { i++; program.push(parseEnum(t.line)); expect(';'); continue; }
    if (t.v === 'using' || t.v === 'namespace' || t.v === 'template') fail(`'${t.v}' 는 이 시뮬레이터에서 지원하지 않습니다`);
    if (!isDeclStart() && !(t.v in TYPE_WORDS)) fail(`'${t.v}' 는 무엇인지 알 수 없습니다. 자료형이나 함수 정의가 와야 합니다`);
    const base = parseType() || (() => { const name = next().v; libTypes.add(name); return { type: `O:${name}` }; })();
    // 함수 정의 / 선언인지 확인: 이름 뒤 '(' 안이 비었거나 자료형으로 시작
    let k = 0;
    while (is('*', k) || is('&', k)) k++;
    if (peek(k).t === 'id' && is('(', k + 1) && (is(')', k + 2) || strictTypeStart(k + 2))) {
      let ptr = 0;
      while (is('*') || is('&')) { if (next().v === '*') ptr++; }
      const name = ident();
      expect('(');
      const params = [];
      if (!eat(')')) {
        if (is('void') && is(')', 1)) i += 2;
        else {
          do {
            const pt = parseType();
            if (!pt) fail(`매개변수의 자료형을 알 수 없습니다: '${peek().v}'`);
            let pptr = 0; let ref = false;
            for (;;) { if (eat('*')) pptr++; else if (eat('&')) ref = true; else if (is('const')) i++; else break; }
            const pname = peek().t === 'id' ? next().v : `_p${params.length}`;
            vars.add(pname);
            let arr = 0;
            while (eat('[')) { if (!is(']')) parseExpr(); expect(']'); arr++; }
            let type = ptrType(pt.type, pptr);
            for (let a = 0; a < arr; a++) type = (type === 'char' || type === 'uchar') && !a ? 'cstr' : `${type}[]`;
            params.push({ name: pname, type, ref, def: eat('=') ? parseAssign() : null });
          } while (eat(','));
          expect(')');
        }
      }
      if (eat(';')) continue; // 함수 원형
      vars.add(name);
      program.push({ k: 'func', name, ret: ptrType(base.type, ptr), params, body: parseBlock(), line: t.line });
      continue;
    }
    program.push({ k: 'decl', base, decls: parseDeclarators(base, true), line: t.line });
    expect(';');
  }
  return program;
}

// ───────── 3. 코드 생성 ─────────
const isNum = (t) => INTS.has(t) || t === 'float' || t === 'llong' || t === 'any';
const isStr = (t) => t === 'String' || t === 'cstr' || t === 'char[]';
const isBox = (t) => isNum(t) || t === 'String' || t === 'cstr'; // 참조(&)로 넘길 때 상자에 담아야 하는 자료형
const promote = (t) => (t === 'bool' || t === 'char' || t === 'uchar' || t === 'int' ? 'int' : t);
const RANK = ['int', 'uint', 'long', 'ulong', 'llong', 'any', 'float'];
function arithType(a, b) {
  const x = promote(a); const y = promote(b);
  if (!RANK.includes(x) || !RANK.includes(y)) return 'any';
  return RANK[Math.max(RANK.indexOf(x), RANK.indexOf(y))];
}
const wrapInt = (t, js) => (table({ int: `(${js}<<16>>16)`, uint: `(${js}&65535)`, long: `(${js}|0)`, ulong: `(${js}>>>0)`, char: `(${js}<<24>>24)`, uchar: `(${js}&255)` })[t] || js);
const RANGE = table({ int: [-32768, 32767], uint: [0, 65535], long: [-2147483648, 2147483647], ulong: [0, 4294967295], char: [-128, 127], uchar: [0, 255], bool: [0, 1] });
const q = (s) => JSON.stringify(s);

function generate(program) {
  const funcs = new Map();
  const structs = new Map();
  const scopes = [new Map()];
  const statics = [];
  let uniq = 0;
  let curFn = null;
  const fail = (msg, node) => { throw new CompileError(msg, node?.line); };
  const lookup = (name) => { for (let s = scopes.length - 1; s >= 0; s--) if (scopes[s].has(name)) return scopes[s].get(name); return null; };
  const declare = (name, info, node) => {
    const top = scopes[scopes.length - 1];
    if (top.has(name)) fail(`'${name}' 이(가) 같은 범위에서 두 번 선언되었습니다`, node);
    top.set(name, info);
    return info;
  };
  const scoped = (fn) => { scopes.push(new Map()); try { return fn(); } finally { scopes.pop(); } };

  for (const n of program) {
    if (n.k === 'func') { if (funcs.has(n.name)) fail(`함수 '${n.name}' 이(가) 두 번 정의되었습니다 (이름이 같은 함수 여러 개는 지원하지 않습니다)`, n); funcs.set(n.name, n); }
    if (n.k === 'struct') structs.set(n.name, n);
  }
  if (!funcs.has('setup')) throw new CompileError('setup() 함수가 없습니다. void setup() { } 를 만들어 주세요.', 1);
  if (!funcs.has('loop')) throw new CompileError('loop() 함수가 없습니다. void loop() { } 를 만들어 주세요.', 1);

  function coerce(t, e) {
    const { js } = e;
    if (t === e.t && !e.jb) return js;
    if (INTS.has(t)) {
      if (e.k === 'lit' && Number.isInteger(e.v) && e.v >= RANGE[t][0] && e.v <= RANGE[t][1]) return js;
      if (e.jb) return `(${js}?1:0)`;
      if (t === 'bool') return e.t === 'bool' ? js : `(${js}?1:0)`;
      if (e.t === 'bool') return js;
      if (isStr(e.t) || e.t.endsWith?.(']')) return js; // 잘못된 대입이지만 그대로 둠
      return wrapInt(t, js);
    }
    if (t === 'float') return (INTS.has(e.t) && !e.jb) || e.t === 'float' ? js : `+(${js})`;
    if (t === 'llong') return `Math.trunc(${js})`;
    if (t === 'String') return e.k === 'strlit' || e.t === 'String' ? js : `__r.str(${js},${q(e.t)})`;
    return js;
  }
  const toStr = (e) => (e.t === 'String' || e.k === 'strlit' ? e.js : `__r.str(${e.js},${q(e.t)})`);
  const cond = (node) => { const e = expr(node); return e.js; };
  const index = (e) => (INTS.has(e.t) && !e.jb ? e.js : `((${e.js})|0)`);

  function binary(op, a, b, node) {
    if (op === '&&' || op === '||') return { js: `!!(${a.js}${op}${b.js})`, t: 'bool', jb: true };
    if (['==', '!=', '<', '>', '<=', '>='].includes(op)) {
      if (isStr(a.t) || isStr(b.t)) return { js: `(${toStr(a)}${op}${toStr(b)})`, t: 'bool', jb: true };
      return { js: `(${a.js}${op}${b.js})`, t: 'bool', jb: true };
    }
    if (op === '+' && (isStr(a.t) || isStr(b.t))) return { js: `(${toStr(a)}+${toStr(b)})`, t: 'String' };
    if (isStr(a.t) || isStr(b.t)) fail(`문자열에는 '${op}' 연산을 쓸 수 없습니다`, node);
    const t = arithType(a.t, b.t);
    const x = a.jb ? `(${a.js}?1:0)` : a.js;
    const y = b.jb ? `(${b.js}?1:0)` : b.js;
    const shift = op === '<<' || op === '>>';
    if (t === 'float' || t === 'any' || t === 'llong') {
      if (['&', '|', '^', '<<', '>>'].includes(op)) return { js: `(${x}${op}${y})`, t: 'long' };
      if (t === 'llong' && op === '/') return { js: `Math.trunc(${x}/${y})`, t };
      return { js: `(${x}${op}${y})`, t };
    }
    const rt = shift ? promote(a.t) : t; // 시프트 결과는 왼쪽 피연산자의 자료형
    const rtt = RANK.includes(rt) ? rt : 'int';
    if (op === '/') return { js: wrapInt(rtt, `Math.trunc(${x}/${y})`), t: rtt };
    if (op === '*' && (rtt === 'long' || rtt === 'ulong')) return { js: wrapInt(rtt, `Math.imul(${x},${y})`), t: rtt };
    if (op === '>>' && (rtt === 'uint' || rtt === 'ulong')) return { js: `(${x}>>>${y})`, t: rtt };
    return { js: wrapInt(rtt, `${x}${op}${y}`), t: rtt };
  }

  /** 대입할 수 있는 식 → { js(읽기), t, set(값 js) } */
  function lvalue(node) {
    if (node.k === 'paren') return lvalue(node.a);
    if (node.k === 'id') {
      const v = lookup(node.name);
      if (!v) fail(funcs.has(node.name) || node.name in BUILTIN_FUNCS ? `'${node.name}' 은(는) 함수라서 값을 넣을 수 없습니다` : `'${node.name}' 이(가) 선언되지 않았습니다`, node);
      const js = v.ref ? `${v.js}.v` : v.js;
      return { js, t: v.t, set: (val) => `${js}=${val}`, simple: true };
    }
    if (node.k === 'idx') {
      const a = expr(node.a);
      const i = index(expr(node.i));
      if (a.t === 'String') { const base = lvalue(node.a); return { js: `__r.sat(${a.js},${i})`, t: 'char', set: (val) => base.set(`__S.setCharAt(${base.js},${i},${val})`) }; }
      if (a.t === 'cstr') return { js: `__r.sat(${a.js},${i})`, t: 'char', set: () => fail('문자열 상수의 글자는 바꿀 수 없습니다 (char 배열을 쓰세요)', node) };
      const t = a.t.endsWith('[]') ? a.t.slice(0, -2) : a.t.startsWith('R:') ? a.t.slice(2) : 'any';
      const js = `${a.js}[${i}]`;
      return { js, t, set: (val) => `${js}=${val}` };
    }
    if (node.k === 'mem') {
      if (BAD_PROPS.has(node.name)) fail(`'${node.name}' 은(는) 쓸 수 없는 이름입니다`, node);
      const a = expr(node.a);
      const s = a.t.startsWith('S:') ? structs.get(a.t.slice(2)) : null;
      const f = s?.fields.find((x) => x.name === node.name);
      if (s && !f) fail(`struct ${s.name} 에 '${node.name}' 이(가) 없습니다`, node);
      const js = s ? `${a.js}.$${node.name}` : `${a.js}.${node.name}`;
      return { js, t: f ? fieldType(f) : FLOAT_MEMBERS.has(node.name) ? 'float' : 'any', set: (val) => `${js}=${val}` };
    }
    if (node.k === 'un' && node.op === '*') {
      const a = expr(node.a);
      const js = `${a.js}.v`;
      return { js, t: a.t.startsWith('R:') ? a.t.slice(2) : 'any', set: (val) => `${js}=${val}` };
    }
    return fail('여기에는 값을 넣을 수 없습니다 (변수가 와야 합니다)', node);
  }
  const fieldType = (d) => d.type + '[]'.repeat(d.dims.length);

  function makeRef(node) {
    const lv = lvalue(node);
    if (!isBox(lv.t)) return lv.js;
    if (/\bawait\b/.test(lv.js)) fail('참조(&)로 넘기는 식이 너무 복잡합니다', node);
    return `{get v(){return ${lv.js}},set v(_v){${lv.set(coerce(lv.t, { js: '_v', t: 'any' }))}}}`;
  }

  function callArgs(args) { return args.map((a) => (a.k === 'un' && a.op === '&' ? makeRef(a.a) : expr(a).js)); }

  function call(node) {
    const f = node.f;
    // 메서드 호출
    if (f.k === 'mem') {
      if (BAD_PROPS.has(f.name)) fail(`'${f.name}' 은(는) 쓸 수 없는 이름입니다`, f);
      const recv = expr(f.a);
      if (recv.t === 'String' || recv.t === 'cstr') {
        const m = STRING_METHODS[f.name];
        if (!m) fail(`String 에 ${f.name}() 은(는) 없습니다`, f);
        const args = node.args.map((a) => { const e = expr(a); return e.t === 'char' ? `String.fromCharCode(${e.js})` : f.name === 'concat' ? toStr(e) : e.js; });
        const js = `__S.${f.name}(${[recv.js, ...args].join(',')})`;
        if (m[1]) { const lv = lvalue(f.a); return { js: `(${lv.set(js)},undefined)`, t: 'void' }; }
        return { js, t: m[0] };
      }
      let args;
      if (f.name === 'print' || f.name === 'println') {
        const a = node.args.map((x) => expr(x));
        args = a.length ? [a[0].js, a[1] ? a[1].js : 'undefined', q(a[0].jb ? 'bool' : a[0].t)] : [];
      } else args = callArgs(node.args);
      return { js: `(await ${recv.js}.${f.name}(${args.join(',')}))`, t: FLOAT_MEMBERS.has(f.name) ? 'float' : 'any' };
    }
    if (f.k === 'scope') return { js: `(await __r.st(${q(f.a)},${q(f.name)})(${callArgs(node.args).join(',')}))`, t: FLOAT_MEMBERS.has(f.name) ? 'float' : 'any' };
    if (f.k !== 'id') return fail('이렇게는 함수를 부를 수 없습니다', node);
    const name = f.name;
    const local = lookup(name);
    if (local) return { js: `(await ${local.ref ? `${local.js}.v` : local.js}(${callArgs(node.args).join(',')}))`, t: 'any' }; // 함수 포인터 변수
    const fn = funcs.get(name);
    if (fn) {
      if (node.args.length > fn.params.length) fail(`${name}() 에 인자가 너무 많습니다 (${fn.params.length}개가 필요한데 ${node.args.length}개를 넘김)`, node);
      if (node.args.length < fn.params.filter((p) => !p.def).length) fail(`${name}() 에 인자가 모자랍니다 (${fn.params.filter((p) => !p.def).length}개가 필요한데 ${node.args.length}개를 넘김)`, node);
      const args = node.args.map((a, k) => { const p = fn.params[k]; if (p.ref && isBox(p.type)) return makeRef(a); return a.k === 'un' && a.op === '&' ? makeRef(a.a) : expr(a).js; });
      return { js: `(await $${name}(${args.join(',')}))`, t: fn.ret };
    }
    // 변수를 직접 바꾸는 매크로들
    if (name === 'bitSet' || name === 'bitClear' || name === 'bitWrite' || name === 'bitToggle') {
      const lv = lvalue(node.args[0]);
      const bit = `(1<<${expr(node.args[1]).js})`;
      const v = name === 'bitSet' ? `${lv.js}|${bit}` : name === 'bitClear' ? `${lv.js}&~${bit}` : name === 'bitToggle' ? `${lv.js}^${bit}` : `(${expr(node.args[2]).js})?(${lv.js}|${bit}):(${lv.js}&~${bit})`;
      return { js: `(${lv.set(coerce(lv.t, { js: `(${v})`, t: 'long' }))})`, t: lv.t };
    }
    const b = BUILTIN_FUNCS[name];
    if (!b) fail(`함수 '${name}' 을(를) 찾을 수 없습니다 (오타이거나 지원하지 않는 함수입니다)`, node);
    const typed = node.args.map((a) => (a.k === 'un' && a.op === '&' ? { js: makeRef(a.a), t: 'any' } : expr(a)));
    let t = b[0];
    if (t === '*') t = typed.length ? typed.map((x) => x.t).reduce((x, y) => arithType(x, y)) : 'any';
    const js = `__g.${name}(${typed.map((x) => (x.jb ? `(${x.js}?1:0)` : x.js)).join(',')})`;
    return { js: b[1] ? `(await ${js})` : js, t };
  }

  function expr(node) {
    switch (node.k) {
      case 'num': {
        const neg = node.v < 0 || Object.is(node.v, -0);
        return { js: neg ? `(${node.v})` : String(node.v), t: node.t, k: 'lit', v: node.v };
      }
      case 'str': return { js: q(node.v), t: 'cstr', k: 'strlit' };
      case 'paren': { const e = expr(node.a); return { ...e, js: `(${e.js})` }; }
      case 'seq': { const list = node.list.map(expr); return { js: `(${list.map((e) => e.js).join(',')})`, t: list[list.length - 1].t }; }
      case 'id': {
        const v = lookup(node.name);
        if (v) return { js: v.ref ? `${v.js}.v` : v.js, t: v.t };
        if (funcs.has(node.name)) return { js: `$${node.name}`, t: 'fn' };
        if (node.name in BUILTIN_CONSTS) return { js: `__g.${node.name}`, t: BUILTIN_CONSTS[node.name] };
        if (BUILTIN_OBJECTS.has(node.name)) return { js: `__g.${node.name}`, t: `O:${node.name}` };
        if (/^[A-Z][A-Z0-9_]*$/.test(node.name)) return { js: `__g.K(${q(node.name)})`, t: 'int' }; // 라이브러리 상수
        if (node.name in BUILTIN_FUNCS) return fail(`'${node.name}' 은(는) 함수입니다. ${node.name}( ) 처럼 괄호를 붙여 부르세요`, node);
        return fail(`'${node.name}' 이(가) 선언되지 않았습니다 (오타이거나, 쓰기 전에 선언해야 합니다)`, node);
      }
      case 'scope': return { js: `__g.K(${q(node.name)})`, t: 'int' };
      case 'idx': case 'mem': { const lv = lvalue(node); return { js: lv.js, t: lv.t }; }
      case 'call': return call(node);
      case 'cond': { const a = expr(node.a); const b = expr(node.b); return { js: `(${cond(node.c)}?${a.js}:${b.js})`, t: a.t === b.t ? a.t : isStr(a.t) || isStr(b.t) ? (a.t === 'String' || b.t === 'String' ? 'any' : 'cstr') : arithType(a.t, b.t), jb: a.jb || b.jb }; }
      case 'bin': return binary(node.op, expr(node.a), expr(node.b), node);
      case 'cast': {
        const e = expr(node.a);
        if (node.type === 'String' && node.extra) return { js: `__r.fmt(${e.js},${expr(node.extra).js},${q(e.t)})`, t: 'String' };
        if (node.type === 'void') return { js: `(${e.js},undefined)`, t: 'void' };
        if (isStr(e.t) && INTS.has(node.type)) return { js: e.js, t: e.t };
        return { js: coerce(node.type, e.t === node.type ? e : { ...e, k: null }), t: node.type };
      }
      case 'sizeof': {
        if (node.type) return { js: String(SIZE[node.type] ?? 2), t: 'uint', k: 'lit', v: SIZE[node.type] ?? 2 };
        const e = expr(node.a);
        if (e.t.endsWith('[]')) return { js: `__r.size(${e.js},${SIZE[e.t.replace(/(\[\])+$/, '')] ?? 2})`, t: 'uint' };
        if (e.k === 'strlit') return { js: String(node.a.v.length + 1), t: 'uint' };
        return { js: String(SIZE[e.t] ?? 2), t: 'uint' };
      }
      case 'un': {
        if (node.op === '++' || node.op === '--') {
          const lv = lvalue(node.a);
          const op = node.op[0];
          if (INTS.has(lv.t) && lv.simple) return { js: `(${lv.set(wrapInt(lv.t, `${lv.js}${op}1`))})`, t: lv.t };
          return { js: `(${node.op}${lv.js})`, t: lv.t };
        }
        if (node.op === '&') return { js: makeRef(node.a), t: 'any' };
        if (node.op === '*') {
          const a = expr(node.a);
          if (a.t === 'cstr' || a.t === 'String') return { js: `__r.sat(${a.js},0)`, t: 'char' };
          const lv = lvalue(node);
          return { js: lv.js, t: lv.t };
        }
        const a = expr(node.a);
        if (node.op === '!') return { js: `(!${a.js})`, t: 'bool', jb: true };
        const x = a.jb ? `(${a.js}?1:0)` : a.js;
        if (node.op === '+') return { js: x, t: promote(a.t) };
        const t = promote(a.t);
        if (node.op === '-') {
          if (a.k === 'lit') return { js: `(-${a.v})`, t, k: 'lit', v: -a.v };
          return { js: INTS.has(t) ? wrapInt(t, `-${x}`) : `(-${x})`, t };
        }
        return { js: wrapInt(INTS.has(t) ? t : 'long', `~${x}`), t: INTS.has(t) ? t : 'long' };
      }
      case 'post': {
        const lv = lvalue(node.a);
        const op = node.op[0];
        const inv = op === '+' ? '-' : '+';
        if (INTS.has(lv.t) && lv.simple) return { js: `(${lv.set(wrapInt(lv.t, `${lv.js}${op}1`))},${wrapInt(lv.t, `${lv.js}${inv}1`)})`, t: lv.t };
        return { js: `(${lv.js}${node.op})`, t: lv.t };
      }
      case 'assign': {
        const lv = lvalue(node.a);
        if (node.b.k === 'init') {
          if (!lv.t.startsWith('S:')) fail('중괄호 { } 로는 struct 에만 값을 넣을 수 있습니다', node);
          return { js: `(${lv.set(`__r.sinit(new S$${lv.t.slice(2)}(),${initJs(node.b)})`)})`, t: lv.t };
        }
        let rhs = expr(node.b);
        if (node.op !== '=') {
          const cur = { js: lv.js, t: lv.t };
          if (lv.t === 'String' && node.op === '+=') rhs = { js: `(${lv.js}+${toStr(rhs)})`, t: 'String' };
          else rhs = binary(node.op.slice(0, -1), cur, rhs, node);
        }
        if (lv.t.startsWith('S:') && rhs.t === lv.t) return { js: `(${lv.set(`Object.assign(new S$${lv.t.slice(2)}(),${rhs.js})`)})`, t: lv.t };
        return { js: `(${lv.set(coerce(lv.t, rhs))})`, t: lv.t };
      }
      case 'init': return fail('중괄호 { } 목록은 여기에 쓸 수 없습니다', node);
      default: return fail('지원하지 않는 식입니다', node);
    }
  }

  const initJs = (node) => (node.k === 'init' ? `[${node.items.map(initJs).join(',')}]` : (() => { const e = expr(node); return e.jb ? `(${e.js}?1:0)` : e.js; })());
  const defaultJs = (t) => (t === 'String' || t === 'cstr' ? '""' : t.startsWith('S:') ? `new S$${t.slice(2)}()` : t.startsWith('O:') ? `__r.mk(${q(t.slice(2))},[])` : t.startsWith('R:') ? '{v:0}' : '0');
  const elemKind = (t) => (t.startsWith('S:') ? `()=>new S$${t.slice(2)}()` : t.startsWith('O:') ? `()=>__r.mk(${q(t.slice(2))},[])` : q(t));

  /** 선언 하나의 초기값 js 와 자료형 */
  function declInit(d, base) {
    if (BAD_PROPS.has(d.name)) fail(`'${d.name}' 은(는) 쓸 수 없는 이름입니다`, d);
    const t = d.type;
    if (d.dims.length) {
      const full = t + '[]'.repeat(d.dims.length);
      const dims = `[${d.dims.map((x) => (x ? expr(x).js : 'null')).join(',')}]`;
      const init = d.init ? (d.init.k === 'init' ? initJs(d.init) : expr(d.init).js) : 'undefined';
      return { js: `__r.arr(${elemKind(t)},${dims},${init})`, t: full };
    }
    if (t.startsWith('O:')) {
      if (d.init && d.init.k !== 'init') return { js: expr(d.init).js, t };
      return { js: `__r.mk(${q(t.slice(2))},[${(d.ctor || []).map((a) => expr(a).js).join(',')}])`, t };
    }
    if (t.startsWith('S:')) {
      if (!d.init) return { js: defaultJs(t), t };
      if (d.init.k === 'init') return { js: `__r.sinit(new S$${t.slice(2)}(),${initJs(d.init)})`, t };
      return { js: `Object.assign(new S$${t.slice(2)}(),${expr(d.init).js})`, t };
    }
    if (d.ref) { if (!d.init) fail('참조(&) 변수는 선언할 때 가리킬 변수를 정해야 합니다', d); return { js: makeRef(d.init), t, ref: isBox(t) }; }
    if (t.startsWith('R:')) return { js: d.init ? expr(d.init).js : '{v:0}', t };
    let init = d.init || (d.ctor && d.ctor[0]);
    if (init && init.k === 'init') init = init.items[0];
    if (t === 'void') fail('void 형 변수는 만들 수 없습니다', d);
    if (t === 'any' && init) { const e = expr(init); return { js: e.jb ? `(${e.js}?1:0)` : e.js, t: e.t === 'cstr' ? 'cstr' : e.t }; }
    if (d.ctor && d.ctor.length > 1 && t === 'String') return { js: `__r.fmt(${expr(d.ctor[0]).js},${expr(d.ctor[1]).js},"any")`, t };
    return { js: init ? coerce(t, expr(init)) : (base?.isConst ? defaultJs(t) : defaultJs(t)), t };
  }

  function declStmt(node, global) {
    let out = '';
    for (const d of node.decls) {
      const init = declInit(d, node.base);
      if (node.base.isStatic && !global) {
        const js = `$s${++uniq}_${d.name}`;
        statics.push(`let ${js}=${init.js};`);
        declare(d.name, { js, t: init.t, ref: init.ref }, d);
      } else {
        declare(d.name, { js: `$${d.name}`, t: init.t, ref: init.ref }, d);
        out += `__r.ln=${d.line};let $${d.name}=${init.js};`;
      }
    }
    return out;
  }

  const LOOP_CHECK = 'if(++__r.c>400)await __r.brk();';
  const body = (node) => (node.k === 'block' ? stmt(node) : `{${scoped(() => stmt(node))}}`);

  function stmt(node) {
    switch (node.k) {
      case 'empty': return ';';
      case 'block': return `{${scoped(() => node.body.map(stmt).join(''))}}`;
      case 'decl': return declStmt(node, false);
      case 'expr': return `__r.ln=${node.line};${expr(node.e).js};`;
      case 'if': return `__r.ln=${node.line};if(${cond(node.c)})${body(node.a)}${node.b ? `else ${body(node.b)}` : ''}`;
      case 'while': return `while(${cond(node.c)}){${LOOP_CHECK}${body(node.body)}}`;
      case 'do': return `do{${LOOP_CHECK}${body(node.body)}}while(${cond(node.c)});`;
      case 'for': return scoped(() => {
        const init = node.init ? (node.init.k === 'decl' ? declStmt(node.init, false) : `${expr(node.init.e).js};`) : '';
        return `{${init}for(;${node.c ? cond(node.c) : ''};${node.step ? expr(node.step).js : ''}){${LOOP_CHECK}${body(node.body)}}}`;
      });
      case 'forof': return scoped(() => {
        const d = node.decl.decls[0];
        const coll = expr(node.coll);
        declare(d.name, { js: `$${d.name}`, t: coll.t.endsWith('[]') ? coll.t.slice(0, -2) : d.type }, d);
        return `for(let $${d.name} of ${coll.js}){${LOOP_CHECK}${body(node.body)}}`;
      });
      case 'switch': return `__r.ln=${node.line};switch(${coerce('long', expr(node.c))}){${scoped(() => node.cases.map((c) => `${c.v ? `case ${coerce('long', expr(c.v))}:` : 'default:'}${c.body.map(stmt).join('')}`).join(''))}}`;
      case 'break': return 'break;';
      case 'continue': return 'continue;';
      case 'return': {
        if (!node.e) return 'return;';
        const e = expr(node.e);
        return `__r.ln=${node.line};return ${curFn.ret === 'void' ? e.js : coerce(curFn.ret, e)};`;
      }
      default: return fail('지원하지 않는 문장입니다', node);
    }
  }

  // 전역: struct → enum · 변수(쓰인 순서) → 함수
  let head = '';
  let globals = '';
  let fns = '';
  for (const n of program) {
    if (n.k === 'struct') {
      head += `class S$${n.name}{constructor(){${n.fields.map((f) => `this.$${f.name}=${f.dims.length ? `__r.arr(${elemKind(f.type)},[${f.dims.map((x) => (x ? expr(x).js : 'null')).join(',')}],undefined)` : f.init && f.init.k !== 'init' ? coerce(f.type, expr(f.init)) : defaultJs(f.type)};`).join('')}}}`;
    } else if (n.k === 'enum') {
      let prev = '-1';
      for (const it of n.items) {
        const v = it.value ? `(${expr(it.value).js})` : `(${prev}+1)`;
        declare(it.name, { js: `$${it.name}`, t: 'int' }, n);
        globals += `const $${it.name}=${v};`;
        prev = `$${it.name}`;
      }
    } else if (n.k === 'decl') globals += declStmt(n, true);
  }
  for (const n of program) {
    if (n.k !== 'func') continue;
    curFn = n;
    fns += scoped(() => {
      const params = n.params.map((p) => {
        const ref = p.ref && isBox(p.type);
        declare(p.name, { js: `$${p.name}`, t: p.type, ref }, n);
        return `$${p.name}${p.def ? `=${expr(p.def).js}` : ''}`;
      });
      const fix = n.params.filter((p) => !(p.ref && isBox(p.type)) && (INTS.has(p.type) || p.type === 'String')).map((p) => `$${p.name}=${coerce(p.type, { js: `$${p.name}`, t: 'any' })};`).join('');
      return `async function $${n.name}(${params.join(',')}){if(++__r.d>200)__r.deep();try{${fix}${n.body.body.map(stmt).join('')}}finally{__r.d--}}`;
    });
  }
  return `"use strict";const {__r,__g,__L,__S}=R;${head}${globals}${statics.join('')}${fns}return{setup:$setup,loop:$loop};`;
}

/**
 * 스케치를 변환합니다.
 * @returns {{ js: string, includes: string[] }}  js 는 `async function (R) { … }` 의 몸통
 * @throws {CompileError} 줄 번호가 있는 오류
 */
export function compileSketch(source) {
  const { toks, includes } = preprocess(String(source ?? ''));
  const program = parse(toks);
  return { js: generate(program), includes };
}
