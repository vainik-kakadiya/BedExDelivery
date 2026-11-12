import type { Logger } from 'pino';
import { estimateLeg, optimiseLocally } from './estimate';
import { createTokenSource, googleLegs, googleOptimiser, parseServiceAccount } from './google';
import type { LatLng, LegsResult, RoutingEngine } from './types';

export * from './types';

export interface RoutingConfig {
  GOOGLE_MAPS_SERVER_KEY?: string;
  GOOGLE_CLOUD_PROJECT_ID?: string;
  GOOGLE_SERVICE_ACCOUNT_JSON?: string;
}

function estimateLegs(points: LatLng[]): LegsResult {
  const legs = points.slice(1).map((p, i) => estimateLeg(points[i]!, p));
  return { legs, polyline: null, engine: 'estimate' };
}

/**
 * Picks the best available provider for each job (see README):
 * Google Route Optimization if a service account is configured, Routes API if a
 * server key is, and the built-in estimate otherwise.
 */
export function createRoutingEngine(config: RoutingConfig, logger?: Logger): RoutingEngine {
  const optimiseWithGoogle =
    config.GOOGLE_SERVICE_ACCOUNT_JSON && config.GOOGLE_CLOUD_PROJECT_ID
      ? googleOptimiser(config.GOOGLE_CLOUD_PROJECT_ID, createTokenSource(parseServiceAccount(config.GOOGLE_SERVICE_ACCOUNT_JSON)))
      : null;
  const legsWithGoogle = config.GOOGLE_MAPS_SERVER_KEY ? googleLegs(config.GOOGLE_MAPS_SERVER_KEY) : null;

  return {
    optimiserKind: optimiseWithGoogle ? 'google' : 'estimate',
    travelKind: legsWithGoogle ? 'google' : 'estimate',
    async optimise(model) {
      if (optimiseWithGoogle) return optimiseWithGoogle(model);
      return optimiseLocally(model);
    },
    async legs(points) {
      if (!legsWithGoogle) return estimateLegs(points);
      try {
        return await legsWithGoogle(points);
      } catch (err) {
        // A Routes API outage shouldn't block planning; fall back and say so in the UI.
        logger?.warn({ err }, 'Routes API failed; using estimated travel times');
        return estimateLegs(points);
      }
    },
  };
}
