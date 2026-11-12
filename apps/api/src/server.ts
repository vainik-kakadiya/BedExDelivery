import { createDb } from '@bedex/db';
import { config } from 'dotenv';
import { pino } from 'pino';
import { createApp } from './app';
import { loadEnv } from './env';
import { ChangeFeed } from './lib/changeFeed';

config({ path: ['../../.env', '.env'] });

const env = loadEnv();
const logger = pino({ level: env.LOG_LEVEL });
const { db, client } = createDb(env.DATABASE_URL);
const changes = new ChangeFeed();
const app = createApp({ db, env, changes }, { logger });

// DSH-07: database triggers NOTIFY on change; fan out to dashboard streams.
// Needs a session-mode connection (direct or Supabase session pooler on :5432);
// postgres.js reconnects and re-listens automatically if it drops.
client
  .listen(
    'bedex_changes',
    (table) => changes.publish(table),
    () => logger.info('Listening for database changes'),
  )
  .catch((err: unknown) => logger.error({ err }, 'Could not LISTEN for changes; dashboards fall back to polling'));

const server = app.listen(env.PORT, () => {
  logger.info(`BedEx API listening on http://localhost:${env.PORT}/api/v1`);
});

function shutdown(signal: string) {
  logger.info({ signal }, 'Shutting down');
  // Open SSE streams would otherwise hold server.close() open.
  server.closeAllConnections();
  server.close(async () => {
    await client.end({ timeout: 5 });
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
