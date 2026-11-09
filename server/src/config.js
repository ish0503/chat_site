import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

// .env 파일이 있으면 읽습니다 (Node 20.12+).
try {
  process.loadEnvFile(fileURLToPath(new URL('../.env', import.meta.url)));
} catch {
  /* .env 없음 */
}

const list = (v) => (v || '').split(',').map((s) => s.trim()).filter(Boolean);

export const config = {
  port: Number(process.env.PORT) || 8080,
  mongoUri: process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017',
  dbName: process.env.MONGODB_DB || 'chat_site',
  jwtSecret: process.env.JWT_SECRET || '',
  googleClientIds: list(process.env.GOOGLE_CLIENT_ID),
  appleClientIds: list(process.env.APPLE_CLIENT_ID),
  allowedOrigins: list(process.env.ALLOWED_ORIGINS || '*'),
  fileTtlHours: Number(process.env.FILE_TTL_HOURS) || 72,
  maxUploadMb: Number(process.env.MAX_UPLOAD_MB) || 25,
};

if (!config.jwtSecret) {
  config.jwtSecret = randomBytes(32).toString('hex');
  console.warn('[config] JWT_SECRET이 설정되지 않아 임시 키를 사용합니다. 서버를 재시작하면 모든 세션이 만료됩니다.');
}
