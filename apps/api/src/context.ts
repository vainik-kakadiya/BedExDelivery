import type { Db } from '@bedex/db';
import type { Env } from './env';
import type { ChangeFeed } from './lib/changeFeed';

/** Dependencies handed to every router. Tests substitute their own. */
export interface AppContext {
  db: Db;
  env: Env;
  /** Database change notifications for the realtime dashboard (DSH-07). */
  changes: ChangeFeed;
}
