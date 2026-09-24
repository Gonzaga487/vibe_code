import crypto from 'node:crypto';
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import compression from 'compression';
import rateLimit from 'express-rate-limit';
import { authMiddleware, requireAdmin } from './middleware/auth.js';
import { errorHandler, notFoundHandler } from './middleware/error.js';
import { createHttpLogger } from './logger.js';
import { AppError } from './lib/errors.js';
import { createAuthRouter } from './routes/auth.js';
import { createUsersRouter } from './routes/users.js';
import { createDashboardRouter } from './routes/dashboard.js';
import { createSalesRouter } from './routes/sales.js';
import { createShiftsRouter } from './routes/shifts.js';
import { createAdjustmentsRouter, createFuelRouter, createPumpsRouter, createRestockRouter } from './routes/fuel.js';
import { createReadingsRouter } from './routes/readings.js';
import { createExpensesRouter } from './routes/expenses.js';
import { createReportsRouter } from './routes/reports.js';
import { createCalendarRouter } from './routes/calendar.js';
import { createPublicSettingsRouter, createSettingsRouter } from './routes/settings.js';
import { createAuditRouter } from './routes/audit.js';
import { createAdminRouter } from './routes/admin.js';

function limiter(options) {
  return rateLimit({
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    handler(req, res, next) {
      next(new AppError(429, 'RATE_LIMITED', 'Too many requests; retry later'));
    },
    ...options,
  });
}

export function createApp({ db, config, logger }) {
  if (!db?.open) throw new Error('An open database is required');
  const effectiveConfig = config.jwtSecret
    ? config
    : Object.freeze({ ...config, jwtSecret: crypto.randomBytes(48).toString('base64url') });

  const app = express();
  app.disable('x-powered-by');
  if (effectiveConfig.trustProxy !== false) app.set('trust proxy', effectiveConfig.trustProxy);
  app.use(createHttpLogger(logger));
  app.use(helmet({
    contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } },
    crossOriginResourcePolicy: { policy: 'same-site' },
    hsts: effectiveConfig.isProduction ? { maxAge: 31536000, includeSubDomains: true, preload: true } : false,
  }));
  app.use(cors({
    credentials: false,
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Authorization', 'Content-Type', 'X-Request-Id'],
    exposedHeaders: ['X-Request-Id', 'Content-Disposition', 'RateLimit', 'RateLimit-Policy'],
    maxAge: 600,
    origin(origin, callback) {
      if (!origin) return callback(null, true);
      if (effectiveConfig.origins.includes(origin)) return callback(null, true);
      return callback(new AppError(403, 'CORS_ORIGIN_DENIED', 'Origin is not allowed'));
    },
  }));
  app.use(compression());
  app.use('/api', (req, res, next) => {
    if (!['/health', '/settings/public'].includes(req.path)) {
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Pragma', 'no-cache');
    }
    next();
  });
  const standardJson = express.json({ limit: effectiveConfig.bodyLimit, strict: true, type: ['application/json', 'application/*+json'] });
  const restoreJson = express.json({ limit: effectiveConfig.restoreBodyLimit, strict: true, type: ['application/json', 'application/*+json'] });
  app.use((req, res, next) => (req.path === '/api/admin/restore' ? restoreJson : standardJson)(req, res, next));

  const apiLimiter = limiter({ windowMs: 15 * 60 * 1000, limit: 600 });
  const loginLimiter = limiter({ windowMs: 15 * 60 * 1000, limit: 10, skipSuccessfulRequests: true });
  app.use('/api', apiLimiter);

  app.get('/api/health', (_req, res) => {
    try {
      db.prepare('SELECT 1').get();
      const version = db.prepare('SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations').get().version;
      const violations = db.pragma('foreign_key_check');
      const required = ['users', 'fuel_management', 'shifts', 'sales', 'pump_readings', 'sales_readings', 'expenses', 'restocks', 'audit_logs'];
      const tableExists = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?");
      const missing = required.filter((table) => !tableExists.get(table));
      if (version !== effectiveConfig.schemaVersion || violations.length || missing.length) throw new Error('Database readiness validation failed');
      res.json({ status: 'ok', database: 'ok', schemaVersion: effectiveConfig.schemaVersion, timestamp: new Date().toISOString() });
    } catch {
      res.status(503).json({ status: 'degraded', database: 'unavailable', schemaVersion: effectiveConfig.schemaVersion, timestamp: new Date().toISOString() });
    }
  });

  const authenticate = authMiddleware({ db, jwtSecret: effectiveConfig.jwtSecret });
  app.use('/api/settings/public', createPublicSettingsRouter({ db }));
  app.use('/api/auth/login', loginLimiter);
  app.use('/api/auth', createAuthRouter({ db, config: effectiveConfig, authenticate }));
  app.use('/api/users', authenticate, requireAdmin, createUsersRouter({ db }));
  app.use('/api/dashboard', authenticate, createDashboardRouter({ db }));
  app.use('/api/sales', authenticate, createSalesRouter({ db }));
  app.use('/api/shifts', authenticate, createShiftsRouter({ db }));
  app.use('/api/fuel', authenticate, (req, res, next) => {
    if (['POST', 'PATCH', 'PUT', 'DELETE'].includes(req.method)) return requireAdmin(req, res, next);
    return next();
  }, createFuelRouter({ db }));
  app.use('/api/pumps', authenticate, (req, res, next) => {
    if (['POST', 'PATCH', 'PUT', 'DELETE'].includes(req.method)) return requireAdmin(req, res, next);
    return next();
  }, createPumpsRouter({ db }));
  app.use('/api/restock', authenticate, requireAdmin, createRestockRouter({ db }));
  app.use('/api/stock-adjustments', authenticate, requireAdmin, createAdjustmentsRouter({ db }));
  app.use('/api/pump-readings', authenticate, createReadingsRouter({ db, kind: 'pump' }));
  app.use('/api/sales-readings', authenticate, createReadingsRouter({ db, kind: 'sales' }));
  app.use('/api/expenses', authenticate, createExpensesRouter({ db }));
  app.use('/api/reports', authenticate, requireAdmin, createReportsRouter({ db }));
  app.use('/api/calendar', authenticate, createCalendarRouter({ db }));
  app.use('/api/settings', authenticate, createSettingsRouter({ db, config: effectiveConfig }));
  app.use('/api/audit', authenticate, requireAdmin, createAuditRouter({ db }));
  app.use('/api/admin', authenticate, requireAdmin, createAdminRouter({ db, config: effectiveConfig }));

  app.use(notFoundHandler);
  app.use(errorHandler(logger));
  app.locals.config = effectiveConfig;
  app.locals.db = db;
  app.locals.logger = logger;
  return app;
}
