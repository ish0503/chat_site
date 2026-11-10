// 요청 제한 (토큰 버킷). 키(사용자 id, IP 등)마다 capacity 개까지 몰아서 쓸 수 있고, 초당 refill 개씩 다시 채워집니다.
export class RateLimiter {
  constructor({ capacity, refillPerSec, now = () => Date.now() }) {
    this.capacity = capacity;
    this.refill = refillPerSec;
    this.now = now;
    this.buckets = new Map();
    this.blocked = 0;
  }

  /** cost 만큼 쓸 수 있으면 true. 안 되면 false (blocked 수 증가) */
  take(key, cost = 1) {
    const t = this.now();
    const b = this.buckets.get(key) || { tokens: this.capacity, last: t };
    b.tokens = Math.min(this.capacity, b.tokens + ((t - b.last) / 1000) * this.refill);
    b.last = t;
    this.buckets.set(key, b);
    if (b.tokens < cost) {
      this.blocked += 1;
      return false;
    }
    b.tokens -= cost;
    return true;
  }

  /** 다시 쓸 수 있을 때까지 남은 시간(ms) */
  retryAfter(key, cost = 1) {
    const b = this.buckets.get(key);
    if (!b || b.tokens >= cost) return 0;
    return Math.ceil(((cost - b.tokens) / this.refill) * 1000);
  }

  /** 오래 쓰지 않은 버킷 정리 (가득 찬 버킷은 기억할 필요 없음) */
  sweep() {
    const t = this.now();
    for (const [k, b] of this.buckets) {
      if (b.tokens + ((t - b.last) / 1000) * this.refill >= this.capacity) this.buckets.delete(k);
    }
  }
}

/** Express 미들웨어: 키 함수(req → 문자열)로 제한 */
export function httpLimit(limiter, keyOf, cost = 1) {
  return (req, res, next) => {
    const key = keyOf(req);
    if (limiter.take(key, cost)) return next();
    res.set('Retry-After', String(Math.ceil(limiter.retryAfter(key, cost) / 1000) || 1));
    res.status(429).json({ error: 'rate_limited' });
  };
}
