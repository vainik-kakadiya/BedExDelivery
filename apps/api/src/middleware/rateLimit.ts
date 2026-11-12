import { rateLimit } from 'express-rate-limit';
import { AppError } from '../lib/errors';

export function limiter(options: { windowMs: number; limit: number; message?: string }) {
  return rateLimit({
    windowMs: options.windowMs,
    limit: options.limit,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    handler: (_req, _res, next) =>
      next(new AppError(429, 'RATE_LIMITED', options.message ?? 'Too many requests. Please wait a minute and try again.')),
  });
}
