import cookieParser from 'cookie-parser';
import cors from 'cors';
import express, { Router } from 'express';
import helmet from 'helmet';
import type { Logger } from 'pino';
import { pinoHttp } from 'pino-http';
import type { AppContext } from './context';
import { errorHandler, notFoundHandler } from './lib/errors';
import { authRouter } from './modules/auth/router';
import { dashboardRouter } from './modules/dashboard/router';
import { driverRouter } from './modules/driver/router';
import { exportsRouter } from './modules/exports/router';
import { healthRouter } from './modules/health';
import { depotsRouter } from './modules/depots/router';
import { driversRouter, vansRouter } from './modules/fleet/router';
import { ordersRouter } from './modules/orders/router';
import { routesRouter } from './modules/planning/router';
import { settingsRouter } from './modules/settings/router';
import { publicRouter } from './modules/public/router';

export function createApp(ctx: AppContext, options: { logger?: Logger } = {}) {
  const app = express();
  app.set('trust proxy', ctx.env.TRUST_PROXY);
  app.disable('x-powered-by');

  app.use(
    helmet({
      hsts: ctx.env.NODE_ENV === 'production' ? { maxAge: 31_536_000, includeSubDomains: true } : false,
    }),
  );
  app.use(cors({ origin: ctx.env.CORS_ORIGIN, credentials: true }));
  app.use(
    // One short line per request: "GET /api/v1/orders?limit=50 200 259ms", plus the
    // error code and message for 4xx/5xx. No headers, so tokens and cookies never reach the log.
    pinoHttp({
      logger: options.logger,
      autoLogging: { ignore: (req) => req.url === '/api/v1/health' },
      serializers: {
        req: (req: { method: string; url: string }) => ({ method: req.method, url: req.url }),
        res: (res: { statusCode: number }) => ({ status: res.statusCode }),
      },
      customLogLevel: (_req, res, err) => (err || res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info'),
      customSuccessMessage: (req, res, responseTime) => {
        const failure = (res as unknown as { locals?: { errorBody?: { code: string; message: string } } }).locals?.errorBody;
        const line = `${req.method} ${req.originalUrl ?? req.url} ${res.statusCode} ${Math.round(responseTime)}ms`;
        return failure ? `${line} – ${failure.code}: ${failure.message}` : line;
      },
      customErrorMessage: (req, res, err) => `${req.method} ${req.originalUrl ?? req.url} ${res.statusCode} – ${err.message}`,
    }),
  );
  // Order import sends the whole parsed spreadsheet back for preview and commit (ORD-05).
  app.use('/api/v1/orders/import', express.json({ limit: '15mb' }));
  app.use(express.json({ limit: '1mb' }));
  app.use(cookieParser());

  const v1 = Router();
  v1.use(healthRouter(ctx));
  v1.use('/auth', authRouter(ctx));
  v1.use('/orders', ordersRouter(ctx));
  v1.use('/drivers', driversRouter(ctx));
  v1.use('/vans', vansRouter(ctx));
  v1.use('/routes', routesRouter(ctx, options.logger));
  v1.use('/depots', depotsRouter(ctx));
  v1.use('/settings', settingsRouter(ctx));
  v1.use('/dashboard', dashboardRouter(ctx));
  v1.use('/exports', exportsRouter(ctx));
  v1.use('/driver', driverRouter(ctx));
  v1.use('/public', publicRouter(ctx));
  app.use('/api/v1', v1);

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
