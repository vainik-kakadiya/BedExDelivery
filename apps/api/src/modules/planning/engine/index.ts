import type { Logger } from 'pino';
import { estimateLeg, optimiseLocally } from './estimate';
import { createTokenSource, detectMetadataAccount, googleLegs, googleOptimiser, metadataTokenSource, parseServiceAccount } from './google';
import type { LatLng, LegsResult, OptimiseResult, RoutingEngine } from './types';

export * from './types';

export interface RoutingConfig {
  GOOGLE_MAPS_SERVER_KEY?: string;
  GOOGLE_CLOUD_PROJECT_ID?: string;
  GOOGLE_SERVICE_ACCOUNT_JSON?: string;
}

export function estimateLegs(points: LatLng[]): LegsResult {
  const legs = points.slice(1).map((p, i) => estimateLeg(points[i]!, p));
  return { legs, polyline: null, engine: 'estimate' };
}

/**
 * Picks the best available provider for each job (see README):
 * - Optimisation: Google Route Optimization with a service-account key, or (no
 *   key) the Google Cloud VM's own service account; otherwise the built-in optimiser.
 * - Travel times: Routes API if a server key is set; otherwise the built-in estimate.
 */
export function createRoutingEngine(config: RoutingConfig, logger?: Logger, fetchImpl: typeof fetch = fetch): RoutingEngine {
  const projectId = config.GOOGLE_CLOUD_PROJECT_ID;
  let optimiseWithGoogle: ((model: Parameters<RoutingEngine['optimise']>[0]) => Promise<OptimiseResult>) | null = null;

  if (projectId && config.GOOGLE_SERVICE_ACCOUNT_JSON) {
    optimiseWithGoogle = googleOptimiser(projectId, createTokenSource(parseServiceAccount(config.GOOGLE_SERVICE_ACCOUNT_JSON), fetchImpl), fetchImpl);
  } else if (projectId) {
    // No key: if this is a Google Cloud VM, use its own service account.
    void detectMetadataAccount(fetchImpl).then((account) => {
      if (!account) {
        logger?.info('GOOGLE_CLOUD_PROJECT_ID is set but there is no service account (not a Google Cloud VM, no key): using the built-in optimiser');
      } else if (!account.cloudPlatformScope) {
        logger?.warn(
          { serviceAccount: account.email },
          "The VM's access scopes don't include Cloud APIs, so Google Route Optimization can't be used: set the VM's access scopes to \"Allow full access to all Cloud APIs\" (see deploy/google-cloud.md)",
        );
      } else {
        optimiseWithGoogle = googleOptimiser(projectId, metadataTokenSource(fetchImpl), fetchImpl);
        logger?.info({ serviceAccount: account.email }, "Route optimisation: google (using the VM's service account)");
      }
    });
  }
  const legsWithGoogle = config.GOOGLE_MAPS_SERVER_KEY ? googleLegs(config.GOOGLE_MAPS_SERVER_KEY, fetchImpl) : null;

  return {
    get optimiserKind() {
      return optimiseWithGoogle ? 'google' : 'estimate';
    },
    travelKind: legsWithGoogle ? 'google' : 'estimate',
    async optimise(model, options) {
      if (optimiseWithGoogle) {
        try {
          return await optimiseWithGoogle(model);
        } catch (err) {
          // Still produce a plan; the routes show as estimated and the log says why.
          logger?.error({ err }, 'Google Route Optimization failed; using the built-in optimiser');
        }
      }
      return optimiseLocally(model, options);
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
