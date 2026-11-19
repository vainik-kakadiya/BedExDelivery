import type { ApiErrorBody, LoginInput, Role, SessionResponse } from '@bedex/shared';
import { useAuth } from '../stores/auth';

const BASE = import.meta.env.VITE_API_URL || '/api/v1';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

interface ApiOptions extends RequestInit {
  /** Sent as JSON. Use `body` instead for raw uploads (e.g. a photo Blob). */
  json?: unknown;
  /** Set false for public endpoints so a 401 never triggers a refresh. */
  auth?: boolean;
}

/** Authenticated fetch: adds the bearer token, refreshes once on 401, throws ApiError on failure. */
export async function request(path: string, { json, auth = true, headers, body, ...init }: ApiOptions = {}): Promise<Response> {
  const send = () => {
    const token = useAuth.getState().accessToken;
    return fetch(`${BASE}${path}`, {
      ...init,
      credentials: 'include',
      headers: {
        Accept: 'application/json',
        ...(json !== undefined && { 'Content-Type': 'application/json' }),
        ...(auth && token && { Authorization: `Bearer ${token}` }),
        ...headers,
      },
      body: json !== undefined ? JSON.stringify(json) : body,
    });
  };

  let res = await send();
  if (res.status === 401 && auth && (await refreshSession())) res = await send();

  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as ApiErrorBody | null;
    throw new ApiError(res.status, body?.code ?? 'HTTP_ERROR', body?.message ?? `Request failed (${res.status})`, body?.details);
  }
  return res;
}

export async function api<T>(path: string, options: ApiOptions = {}): Promise<T> {
  const res = await request(path, options);
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

/** Download an authenticated file (exports) using the server's file name. */
export async function downloadFile(path: string): Promise<void> {
  const res = await request(path, { headers: { Accept: '*/*' } });
  const disposition = res.headers.get('Content-Disposition') ?? '';
  const filename = /filename="([^"]+)"/.exec(disposition)?.[1] ?? 'export';
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

// ---------- session ----------

/**
 * - ok: new access token.
 * - signed_out: the server rejected the refresh cookie (401); the session is over.
 * - unavailable: network down, API restarting (502), overloaded (5xx) or rate limited.
 *   The cookie may still be good, so the session is kept.
 */
type RefreshOutcome = 'ok' | 'signed_out' | 'unavailable';

let refreshing: Promise<RefreshOutcome> | null = null;

function refreshOnce(): Promise<RefreshOutcome> {
  refreshing ??= doRefresh().finally(() => {
    refreshing = null;
  });
  return refreshing;
}

/** Rotate the refresh cookie for a new access token. Concurrent callers share one request. */
export async function refreshSession(): Promise<boolean> {
  return (await refreshOnce()) === 'ok';
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function doRefresh(retry = true): Promise<RefreshOutcome> {
  let res: Response;
  try {
    res = await fetch(`${BASE}/auth/refresh`, { method: 'POST', credentials: 'include' });
  } catch {
    // Network failure: keep the current state so offline drivers aren't logged out.
    return 'unavailable';
  }
  if (res.ok) {
    useAuth.getState().setSession((await res.json()) as SessionResponse);
    return 'ok';
  }
  // Only a 401 means the session is really over. A deploy restart (502), a database
  // blip (500) or the rate limiter (429) must not sign anyone out.
  if (res.status !== 401) return 'unavailable';
  const body = (await res.json().catch(() => null)) as ApiErrorBody | null;
  // Another tab rotated the token at the same moment; its new cookie is ours too.
  if (body?.code === 'REFRESH_RACE' && retry) {
    await wait(400);
    return doRefresh(false);
  }
  useAuth.getState().clear();
  return 'signed_out';
}

/** Back-off between start-up attempts while the API can't be reached (≈ 30 s in total). */
const RESTORE_RETRY_MS = [1_000, 2_000, 4_000, 8_000, 15_000];

/** On page load / app start: sign back in from the refresh cookie, riding out a server restart. */
export async function restoreSession(): Promise<void> {
  for (const delay of [0, ...RESTORE_RETRY_MS]) {
    if (delay) await wait(delay);
    const outcome = await refreshOnce();
    if (outcome !== 'unavailable') return;
    if (useAuth.getState().status !== 'unknown') return;
  }
  if (useAuth.getState().status === 'unknown') useAuth.getState().clear();
}

export async function login(input: LoginInput): Promise<SessionResponse> {
  const session = await api<SessionResponse>('/auth/login', { method: 'POST', json: input, auth: false });
  useAuth.getState().setSession(session);
  return session;
}

export async function logout(): Promise<void> {
  try {
    await api('/auth/logout', { method: 'POST', auth: false });
  } finally {
    useAuth.getState().clear();
  }
}

export function homePathFor(role: Role): string {
  return role === 'driver' ? '/driver' : '/office';
}
