import { type Db, orders } from '@bedex/db';
import { and, asc, eq } from 'drizzle-orm';
import type { Logger } from 'pino';
import type { ChangeFeed } from '../../lib/changeFeed';
import type { Geocoder } from '../../lib/geocoder';

const BATCH = 25;
const SWEEP_MS = 60_000;
/** After a configuration error (bad key, API disabled) wait before trying again. */
const CONFIG_ERROR_PAUSE_MS = 10 * 60_000;

/**
 * ORD-07: give orders a map location. New and re-addressed orders are saved with
 * geocode_status 'pending'; this picks them up when orders change and on a timer,
 * so it also catches up anything missed while the API was down.
 */
export function startGeocodeWorker({ db, geocoder, changes, logger }: { db: Db; geocoder: Geocoder; changes: ChangeFeed; logger: Logger }) {
  let running = false;
  let again = false;
  let pausedUntil = 0;

  async function run() {
    if (Date.now() < pausedUntil) return;
    if (running) {
      again = true;
      return;
    }
    running = true;
    try {
      do {
        again = false;
        const pending = await db.query.orders.findMany({
          where: eq(orders.geocodeStatus, 'pending'),
          columns: { id: true, orderNumber: true, addressLine1: true, addressLine2: true, town: true, postcode: true },
          orderBy: [asc(orders.createdAt)],
          limit: BATCH,
        });
        let progressed = false;
        for (const o of pending) {
          const result = await geocoder(o);
          if (result.kind === 'error') {
            logger.error({ order: o.orderNumber, err: result.message }, 'Geocoding failed');
            if (!result.retryable) pausedUntil = Date.now() + CONFIG_ERROR_PAUSE_MS;
            return;
          }
          // Only write if the address hasn't been edited meanwhile (an edit sets 'pending' again).
          await db
            .update(orders)
            .set(
              result.kind === 'ok'
                ? { lat: result.lat, lng: result.lng, geocodeStatus: result.precise ? 'ok' : 'approximate' }
                : { lat: null, lng: null, geocodeStatus: 'failed' },
            )
            .where(
              and(
                eq(orders.id, o.id),
                eq(orders.geocodeStatus, 'pending'),
                eq(orders.addressLine1, o.addressLine1),
                eq(orders.town, o.town),
                eq(orders.postcode, o.postcode),
              ),
            );
          progressed = true;
          if (result.kind === 'not_found') logger.warn({ order: o.orderNumber }, 'Address not found by geocoder');
          else if (!result.precise) logger.info({ order: o.orderNumber }, 'Geocoded to postcode/area level only');
        }
        if (pending.length === BATCH && progressed) again = true;
      } while (again);
    } catch (err) {
      logger.error({ err }, 'Geocode worker error');
    } finally {
      running = false;
    }
  }

  const unsubscribe = changes.subscribe((tables) => {
    if (tables.includes('orders') || tables.includes('*')) void run();
  });
  const timer = setInterval(() => void run(), SWEEP_MS);
  timer.unref();
  void run();

  return () => {
    unsubscribe();
    clearInterval(timer);
  };
}
