/**
 * Idempotent seed: first admin user + default settings.
 * Usage: pnpm db:seed (reads SEED_ADMIN_* and DATABASE_URL from the root .env).
 */
import { hash } from '@node-rs/argon2';
import { DEFAULT_SETTINGS } from '@bedex/shared';
import { config } from 'dotenv';
import { sql } from 'drizzle-orm';
import { createDb, settings, users } from './index';

config({ path: ['../../.env', '.env'] });

async function main() {
  const url = process.env.DATABASE_URL;
  const email = process.env.SEED_ADMIN_EMAIL?.trim().toLowerCase();
  const password = process.env.SEED_ADMIN_PASSWORD;
  const name = process.env.SEED_ADMIN_NAME?.trim() || 'Admin';
  if (!url) throw new Error('DATABASE_URL is not set');
  if (!email || !password) throw new Error('SEED_ADMIN_EMAIL and SEED_ADMIN_PASSWORD are required');
  if (password.length < 8) throw new Error('SEED_ADMIN_PASSWORD must be at least 8 characters');

  const { db, client } = createDb(url, { max: 1 });
  try {
    const existing = await db.query.users.findFirst({ where: sql`lower(${users.email}) = ${email}` });
    if (existing) {
      console.log(`Admin ${email} already exists – skipped`);
    } else {
      await db.insert(users).values({ name, email, role: 'admin', passwordHash: await hash(password) });
      console.log(`Created admin ${email}`);
    }

    const rows = Object.entries(DEFAULT_SETTINGS).map(([key, value]) => ({ key, value }));
    await db.insert(settings).values(rows).onConflictDoNothing();
    console.log(`Ensured ${rows.length} default settings`);
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
