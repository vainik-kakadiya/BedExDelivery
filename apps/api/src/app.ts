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
    pinoHttp({
      logger: options.logger,
      redact: ['req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]'],
      autoLogging: { ignore: (req) => req.url === '/api/v1/health' },
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
  v1.use('/routes', routesRouter(ctx));
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
