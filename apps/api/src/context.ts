import type { Db } from '@bedex/db';
import type { Env } from './env';
import type { ChangeFeed } from './lib/changeFeed';
import type { PhotoStorage } from './lib/storage';
import type { RoutingEngine } from './modules/planning/engine';

/** Dependencies handed to every router. Tests substitute their own. */
export interface AppContext {
  db: Db;
  env: Env;
  /** Database change notifications for realtime updates (DSH-07, RTE-09). */
  changes: ChangeFeed;
  /** Route optimisation + travel times: Google when configured, estimates otherwise. */
  routing: RoutingEngine;
  /** Proof-of-delivery photo store (Supabase Storage); null until SUPABASE_URL + key are set. */
  storage: PhotoStorage | null;
}
