import type { NextFunction, Request, Response } from 'express';

type RateLimitOptions = {
  windowMs: number;
  maxRequests: number;
  message: string;
  key: (request: Request) => string;
};

type RateLimitResult = {
  allowed: boolean;
  retryAfterSeconds: number;
};

/** A small, bounded sliding-window limiter for this single-server Phase 1 app. */
export class SlidingWindowRateLimiter {
  private readonly requestsByKey = new Map<string, number[]>();

  constructor(
    private readonly windowMs: number,
    private readonly maxRequests: number,
  ) {}

  check(key: string, now = Date.now()): RateLimitResult {
    const windowStart = now - this.windowMs;
    const recentRequests = (this.requestsByKey.get(key) ?? []).filter(
      (timestamp) => timestamp > windowStart,
    );

    if (recentRequests.length >= this.maxRequests) {
      const earliestRequest = recentRequests[0] ?? now;
      this.requestsByKey.set(key, recentRequests);
      return {
        allowed: false,
        retryAfterSeconds: Math.max(1, Math.ceil((earliestRequest + this.windowMs - now) / 1_000)),
      };
    }

    recentRequests.push(now);
    this.requestsByKey.set(key, recentRequests);
    return { allowed: true, retryAfterSeconds: 0 };
  }
}

export function createRateLimit(options: RateLimitOptions) {
  const limiter = new SlidingWindowRateLimiter(options.windowMs, options.maxRequests);

  return (request: Request, response: Response, next: NextFunction): void => {
    const result = limiter.check(options.key(request));
    if (result.allowed) {
      next();
      return;
    }

    response.setHeader('Retry-After', String(result.retryAfterSeconds));
    response.status(429).json({ error: options.message });
  };
}

function authenticatedRequestKey(request: Request): string {
  return request.authUser?.sub ?? request.ip ?? 'unknown-client';
}

export const authRateLimit = createRateLimit({
  windowMs: 15 * 60 * 1_000,
  maxRequests: 20,
  message: 'Too many authentication requests. Please try again later.',
  key: (request) => request.ip ?? 'unknown-client',
});

export const inviteRateLimit = createRateLimit({
  windowMs: 60 * 1_000,
  maxRequests: 20,
  message: 'Too many invite requests. Please wait a minute and try again.',
  key: authenticatedRequestKey,
});

export const chatHistoryRateLimit = createRateLimit({
  windowMs: 60 * 1_000,
  maxRequests: 60,
  message: 'Too many chat history requests. Please wait a moment and try again.',
  key: authenticatedRequestKey,
});

export const brainRateLimit = createRateLimit({
  windowMs: 60 * 1_000,
  maxRequests: 20,
  message: 'Too many workspace brain questions. Please wait a minute and try again.',
  key: authenticatedRequestKey,
});

export const gitRateLimit = createRateLimit({
  windowMs: 60 * 1_000,
  maxRequests: 20,
  message: 'Too many Git requests. Please wait a minute and try again.',
  key: authenticatedRequestKey,
});
