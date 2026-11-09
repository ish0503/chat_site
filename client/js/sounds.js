// 효과음 (파일 없이 Web Audio 로 합성)
let ctx = null;
const ac = () => {
  try {
    ctx = ctx || new (window.AudioContext || window.webkitAudioContext)();
    if (ctx.state === 'suspended') ctx.resume();
  } catch { ctx = null; }
  return ctx;
};

function tone(notes, { type = 'sine', gain = 0.08 } = {}) {
  const c = ac();
  if (!c) return;
  let t = c.currentTime;
  for (const [freq, dur] of notes) {
    const o = c.createOscillator();
    const g = c.createGain();
    o.type = type;
    o.frequency.value = freq;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(gain, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(c.destination);
    o.start(t);
    o.stop(t + dur + 0.02);
    t += dur * 0.8;
  }
}

export const sounds = {
  message: () => tone([[880, 0.09], [1320, 0.12]]),
  mention: () => tone([[988, 0.1], [1319, 0.1], [1760, 0.16]], { gain: 0.1 }),
  join: () => tone([[523, 0.1], [784, 0.16]], { type: 'triangle' }),
  leave: () => tone([[784, 0.1], [523, 0.18]], { type: 'triangle' }),
  reminder: () => tone([[1047, 0.12], [1047, 0.12], [1319, 0.25]], { gain: 0.1 }),
  unlock: ac, // 사용자 동작 시 오디오 잠금 해제
};
