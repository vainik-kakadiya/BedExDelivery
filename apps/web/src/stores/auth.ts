import type { SessionResponse, SessionUser } from '@bedex/shared';
import { create } from 'zustand';

type Status = 'unknown' | 'authenticated' | 'anonymous';

interface AuthState {
  status: Status;
  user: SessionUser | null;
  /** Kept in memory only; the refresh token lives in an httpOnly cookie. */
  accessToken: string | null;
  setSession: (session: SessionResponse) => void;
  clear: () => void;
}

export const useAuth = create<AuthState>()((set) => ({
  status: 'unknown',
  user: null,
  accessToken: null,
  setSession: ({ accessToken, user }) => set({ status: 'authenticated', accessToken, user }),
  clear: () => set({ status: 'anonymous', accessToken: null, user: null }),
}));
