import type { Env } from '../env';

/** Where proof-of-delivery photos are kept. Tests substitute an in-memory version. */
export interface PhotoStorage {
  upload(path: string, body: Buffer, contentType: string): Promise<void>;
  /** A short-lived link for viewing a private photo. */
  signedUrl(path: string, expiresInSeconds?: number): Promise<string>;
  remove(paths: string[]): Promise<void>;
}

export class StorageError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/**
 * Supabase Storage over its REST API with the service-role key (bypasses
 * storage RLS, so the bucket stays private and the API does all the checks).
 */
export function createSupabaseStorage(env: Pick<Env, 'SUPABASE_URL' | 'SUPABASE_SERVICE_ROLE_KEY' | 'SUPABASE_PHOTO_BUCKET'>): PhotoStorage | null {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) return null;
  const base = `${env.SUPABASE_URL.replace(/\/+$/, '')}/storage/v1`;
  const bucket = encodeURIComponent(env.SUPABASE_PHOTO_BUCKET);
  const key = env.SUPABASE_SERVICE_ROLE_KEY;
  const headers = { apikey: key, Authorization: `Bearer ${key}` };
  const objectPath = (path: string) => path.split('/').map(encodeURIComponent).join('/');

  async function call(url: string, init: RequestInit): Promise<Response> {
    const res = await fetch(url, { ...init, headers: { ...headers, ...init.headers }, signal: AbortSignal.timeout(30_000) });
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { message?: string; error?: string } | null;
      throw new StorageError(`Supabase Storage ${res.status}: ${body?.message ?? body?.error ?? res.statusText}`, res.status);
    }
    return res;
  }

  return {
    async upload(path, body, contentType) {
      await call(`${base}/object/${bucket}/${objectPath(path)}`, {
        method: 'POST',
        headers: { 'Content-Type': contentType, 'x-upsert': 'false', 'Cache-Control': 'max-age=31536000' },
        body: new Uint8Array(body),
      });
    },
    async signedUrl(path, expiresInSeconds = 600) {
      const res = await call(`${base}/object/sign/${bucket}/${objectPath(path)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ expiresIn: expiresInSeconds }),
      });
      const { signedURL } = (await res.json()) as { signedURL: string };
      return `${base}${signedURL}`;
    },
    async remove(paths) {
      if (paths.length === 0) return;
      await call(`${base}/object/${bucket}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prefixes: paths }),
      });
    },
  };
}
