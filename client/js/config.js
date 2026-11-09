const env = window.CHAT_ENV || {};

const read = (k) => {
  try { return localStorage.getItem(k); } catch { return null; }
};

const stripSlash = (u) => (u || '').trim().replace(/\/+$/, '');

export const config = {
  appName: env.APP_NAME || 'Chat Site',
  defaultServerUrl: stripSlash(env.SERVER_URL),
  serverUrl: stripSlash(read('cs.serverUrl') ?? env.SERVER_URL),
  googleClientId: env.GOOGLE_CLIENT_ID || '',
  appleClientId: env.APPLE_CLIENT_ID || '',
  appleRedirectUri: env.APPLE_REDIRECT_URI || location.origin + location.pathname,
  fileTtlHours: Number(env.FILE_TTL_HOURS) || 72,
  maxUploadMb: Number(env.MAX_UPLOAD_MB) || 25,
  iceServers: env.ICE_SERVERS || [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }],
  socketIoSrc: 'https://cdn.jsdelivr.net/npm/socket.io-client@4.8.1/dist/socket.io.min.js',
};

export function setServerUrl(url) {
  const v = stripSlash(url);
  try {
    if (v === config.defaultServerUrl) localStorage.removeItem('cs.serverUrl');
    else localStorage.setItem('cs.serverUrl', v);
  } catch { /* noop */ }
  config.serverUrl = v;
}
