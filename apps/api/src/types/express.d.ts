import type { AuthUser } from '../lib/jwt';

declare global {
  namespace Express {
    interface Request {
      /** Set by requireAuth. */
      user?: AuthUser;
    }
  }
}

export {};
