import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as relations from './relations';
import * as tables from './schema';

export const schema = { ...tables, ...relations };

export function createDb(url: string, options: { max?: number } = {}) {
  const client = postgres(url, {
    max: options.max ?? 10,
    // Supabase's transaction-mode pooler does not support prepared statements.
    prepare: false,
  });
  const db = drizzle(client, { schema });
  return { db, client };
}

export type Db = ReturnType<typeof createDb>['db'];
/** A transaction handle has the same query API as Db. */
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
export type DbOrTx = Db | Tx;

export * from './schema';
