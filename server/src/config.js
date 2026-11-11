import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

// .env 파일이 있으면 읽습니다 (Node 20.12+).
try {
  process.loadEnvFile(fileURLToPath(new URL('../.env', import.meta.url)));
} catch {
  /* .env 없음 */
}

const list = (v) => (v || '').split(',').map((s) => s.trim()).filter(Boolean);

// 'https://ish0503.github.io/chat_site/' 처럼 경로나 끝의 / 가 붙어 있어도 출처(origin)만 남깁니다.
const toOrigin = (v) => {
  if (v === '*') return v;
  try { return new URL(v).origin; } catch { return v.replace(/\/+$/, ''); }
};

export const config = {
  port: Number(process.env.PORT) || 8080,
  mongoUri: process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017',
  dbName: process.env.MONGODB_DB || 'chat_site',
  jwtSecret: process.env.JWT_SECRET || '',
  googleClientIds: list(process.env.GOOGLE_CLIENT_ID),
  appleClientIds: list(process.env.APPLE_CLIENT_ID),
  allowedOrigins: [...new Set(list(process.env.ALLOWED_ORIGINS || '*').map(toOrigin))],
  fileTtlHours: Number(process.env.FILE_TTL_HOURS) || 72,
  maxUploadMb: Number(process.env.MAX_UPLOAD_MB) || 25,
  // 내 보관함(만료 없는 개인 파일 공간) 사용자당 용량
  storageQuotaMb: Number(process.env.STORAGE_QUOTA_MB) || 100,
  // 통화방 최대 인원. 참가자끼리 직접 연결(mesh)하므로 많을수록 각자 업로드가 늘어납니다.
  callMaxParticipants: Number(process.env.CALL_MAX_PARTICIPANTS) || 8,
  // 대규모 통화용 SFU(미디어 서버) 주소. 비워 두면 mesh 로 동작합니다. (client/env.js 의 SFU_URL 과 함께 설정)
  sfuUrl: process.env.SFU_URL || '',
  // 이 기간 동안 접속하지 않은 게스트 계정은 자동으로 삭제 (0 이면 끔)
  guestTtlDays: process.env.GUEST_TTL_DAYS === undefined ? 7 : Number(process.env.GUEST_TTL_DAYS) || 0,
  // 계정이 삭제된 뒤 이 기간이 지나면 그 사람과 나눈 1:1 대화를 서버에서 지움
  deletedDmGraceDays: process.env.DELETED_DM_GRACE_DAYS === undefined ? 7 : Number(process.env.DELETED_DM_GRACE_DAYS) || 0,
  version: process.env.APP_VERSION || process.env.KOYEB_GIT_SHA?.slice(0, 8) || 'dev',
};

console.log(`[config] 허용 출처(ALLOWED_ORIGINS): ${config.allowedOrigins.join(', ')}`);

if (!config.jwtSecret) {
  config.jwtSecret = randomBytes(32).toString('hex');
  console.warn('[config] JWT_SECRET이 설정되지 않아 임시 키를 사용합니다. 서버를 재시작하면 모든 세션이 만료됩니다.');
}
