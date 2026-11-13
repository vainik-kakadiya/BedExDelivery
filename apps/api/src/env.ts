import { z } from 'zod';

/** Empty strings in .env mean "not set". */
const optional = z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? undefined : v), z.string().optional());

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().default(4000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  DATABASE_URL: z.string().url(),
  /**
   * Connections per API process. Supabase's session pooler caps *all* clients
   * (pool_size, 15 on small plans), so keep this × processes well below it.
   */
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(50).default(5),
  JWT_ACCESS_SECRET: z.string().min(32, 'JWT_ACCESS_SECRET must be at least 32 characters'),
  CORS_ORIGIN: z
    .string()
    .default('http://localhost:5173')
    .transform((v) =>
      v
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  COOKIE_SECURE: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  TRUST_PROXY: z.coerce.number().int().min(0).default(1),
  // Google Maps Platform (all optional: the planner falls back to estimates).
  GOOGLE_MAPS_SERVER_KEY: optional,
  GOOGLE_CLOUD_PROJECT_ID: optional,
  /** Service account JSON (raw or base64) for the Route Optimization API, which needs OAuth. */
  GOOGLE_SERVICE_ACCOUNT_JSON: optional,
  // Supabase Storage for proof-of-delivery photos (DRP-05). Backend only: never expose the key.
  SUPABASE_URL: z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? undefined : v), z.string().url().optional()),
  SUPABASE_SERVICE_ROLE_KEY: optional,
  SUPABASE_PHOTO_BUCKET: z.string().trim().min(1).default('delivery-photos'),
});

export type Env = z.infer<typeof envSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid environment configuration:\n${problems}`);
  }
  if (parsed.data.NODE_ENV === 'production' && !parsed.data.COOKIE_SECURE) {
    throw new Error('COOKIE_SECURE must be true in production');
  }
  return parsed.data;
}
