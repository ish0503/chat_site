import { createHash, timingSafeEqual } from 'node:crypto';
import { createRemoteJWKSet, jwtVerify, SignJWT } from 'jose';
import { config } from './config.js';

const googleJwks = createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'));
const appleJwks = createRemoteJWKSet(new URL('https://appleid.apple.com/auth/keys'));
const secret = new TextEncoder().encode(config.jwtSecret);

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
    this.expose = true;
  }
}

export async function verifyGoogleToken(token) {
  if (!config.googleClientIds.length) throw new HttpError(501, 'google_not_configured');
  if (typeof token !== 'string') throw new HttpError(400, 'invalid_token');
  try {
    const { payload } = await jwtVerify(token, googleJwks, {
      issuer: ['https://accounts.google.com', 'accounts.google.com'],
      audience: config.googleClientIds,
    });
    return payload;
  } catch {
    throw new HttpError(401, 'invalid_token');
  }
}

export async function verifyAppleToken(token) {
  if (!config.appleClientIds.length) throw new HttpError(501, 'apple_not_configured');
  if (typeof token !== 'string') throw new HttpError(400, 'invalid_token');
  try {
    const { payload } = await jwtVerify(token, appleJwks, {
      issuer: 'https://appleid.apple.com',
      audience: config.appleClientIds,
    });
    return payload;
  } catch {
    throw new HttpError(401, 'invalid_token');
  }
}

export function signSession(user) {
  return new SignJWT({ prv: user.provider })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(user._id)
    .setIssuedAt()
    .setExpirationTime('30d')
    .sign(secret);
}

export async function verifySession(token) {
  if (typeof token !== 'string' || !token) throw new HttpError(401, 'unauthorized');
  try {
    const { payload } = await jwtVerify(token, secret, { algorithms: ['HS256'] });
    return payload;
  } catch {
    throw new HttpError(401, 'unauthorized');
  }
}

export const hashSecret = (s) => createHash('sha256').update(String(s)).digest('hex');

export function sameHash(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
}
