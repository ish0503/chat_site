// 오프라인에서도 앱 화면을 열 수 있도록 앱 파일을 캐시합니다 (네트워크 우선).
const CACHE = 'chat-site-v9';
const SHELL = [
  './', './index.html', './env.js', './css/style.css', './manifest.webmanifest', './icons/icon.svg', './icons/icon-192.png', './icons/apple-touch-icon.png',
  './js/app.js', './js/config.js', './js/util.js', './js/markdown.js', './js/db.js', './js/api.js', './js/auth.js',
  './js/files.js', './js/data.js', './js/call.js', './js/permissions.js', './js/runner.js', './js/install.js', './js/local.js', './js/sounds.js', './js/commands.js', './js/errorlog.js', './js/zip.js', './js/convert.js', './js/ui/workspace.js', './js/ui/ide.js', './js/ui/board.js',
  './js/ui/icons.js', './js/ui/common.js', './js/ui/login.js', './js/ui/dialogs.js', './js/ui/errors.js',
  './js/ui/sidebar.js', './js/ui/chat.js', './js/ui/panels.js', './js/ui/callview.js', './js/ui/codeblock.js',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).catch(() => {}));
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))));
  self.clients.claim();
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  e.respondWith(
    fetch(e.request, { cache: 'no-cache' }) // 매번 서버에 최신인지 확인 (304 면 빠름)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
        }
        return res;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: true }).then((r) => r || caches.match('./index.html'))),
  );
});
