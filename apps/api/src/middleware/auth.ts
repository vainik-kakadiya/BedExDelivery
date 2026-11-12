import type { Role } from '@bedex/shared';
import type { Request, RequestHandler } from 'express';
import { type AuthUser, verifyAccessToken } from '../lib/jwt';
import { forbidden, unauthorized } from '../lib/errors';

export function requireAuth(secret: string): RequestHandler {
  return async (req, _res, next) => {
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) return next(unauthorized());
    try {
      req.user = await verifyAccessToken(secret, header.slice('Bearer '.length));
      next();
    } catch {
      next(unauthorized('Your session has expired', 'TOKEN_INVALID'));
    }
  };
}

/** RBAC (ACC-02). Must run after requireAuth. */
export function requireRole(...roles: Role[]): RequestHandler {
  return (req, _res, next) => {
    if (!req.user) return next(unauthorized());
    if (!roles.includes(req.user.role)) return next(forbidden());
    next();
  };
}

/** Narrow req.user inside handlers that sit behind requireAuth. */
export function currentUser(req: Request): AuthUser {
  if (!req.user) throw unauthorized();
  return req.user;
}

/** Driver endpoints scope every query on this id (PRD §9). */
export function currentDriverId(req: Request): string {
  const user = currentUser(req);
  if (user.role !== 'driver' || !user.driverId) throw forbidden('No driver profile is linked to this login');
  return user.driverId;
}
