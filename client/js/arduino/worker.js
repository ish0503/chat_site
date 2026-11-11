// 아두이노 시뮬레이터 Worker: 변환된 스케치를 화면과 분리된 곳에서 실행 (무한 루프여도 화면이 멈추지 않고, "중지"는 Worker 를 없앰).
import { createRuntime } from './runtime.js';
import { createAvrRuntime } from './avr-runtime.js';

// 스케치는 런타임이 내준 함수만 쓸 수 있게 변환되지만, 만약을 대비해 네트워크 · 저장소 통로를 없앰
for (const k of ['fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'indexedDB', 'caches', 'importScripts', 'BroadcastChannel', 'WebTransport', 'Worker', 'SharedWorker']) {
  try { Object.defineProperty(self, k, { value: undefined, writable: false, configurable: false }); } catch { /* noop */ }
}

let rt = null;
self.onmessage = ({ data }) => {
  if (data.type === 'start') {
    // mode 'avr': 서버가 컴파일한 실제 기계어(.hex)를 칩 에뮬레이터로 실행 / 그 외: 브라우저 안에서 변환한 JS 를 실행
    rt = (data.mode === 'avr' ? createAvrRuntime : createRuntime)({ post: (m) => self.postMessage(m) });
    rt.setNet(data.net);
    rt.run(data.mode === 'avr' ? data.hex : data.js).then(() => self.postMessage({ type: 'done' }));
  } else if (!rt) { /* 아직 시작 전 */ } else if (data.type === 'net') rt.setNet(data.net);
  else if (data.type === 'prop') rt.setProp(data.id, data.key, data.value);
  else if (data.type === 'serial') rt.serialIn(data.text);
};
