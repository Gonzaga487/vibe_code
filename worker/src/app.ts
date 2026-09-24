import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { authMiddleware, requireAdmin } from './auth';
import { maybeBootstrapAdmin } from './bootstrap';
import { loadWorkerConfig } from './config';
import { first, normalizeD1Error } from './db';
import { AppError } from './errors';
import { assertContentLength } from './http';
import { publicSettingsResponse } from './settings-routes';
import { adminRouter } from './admin';
import { auditRouter } from './audit-routes';
import { authRoutes } from './auth-routes';
import { calendarRouter } from './calendar';
import { dashboardRouter } from './dashboard';
import { expensesRouter } from './expenses';
import { adjustmentsRouter, fuelRouter, pumpsRouter, restockRouter } from './fuel';
import { readingsRouter } from './readings';
import { reportsRouter } from './reports';
import { salesRouter } from './sales';
import { settingsRouter } from './settings-routes';
import { shiftsRouter } from './shifts';
import { usersRouter } from './users';
import type { AppEnv, Env, WorkerConfig } from './types';

const REQUIRED_TABLES = [
  'schema_migrations', 'users', 'app_settings', 'fuel_management', 'pumps', 'shifts', 'restocks',
  'stock_adjustments', 'sales', 'expenses', 'pump_readings', 'sales_readings', 'inventory_lots',
  'inventory_movements', 'inventory_allocations', 'audit_logs',
];

function requestId(value: string | undefined): string {
  return value && /^[A-Za-z0-9._:-]{1,100}$/.test(value) ? value : crypto.randomUUID();
}

function securityHeaders(response: Response, id: string, origin: string | undefined, config: WorkerConfig, secure: boolean): void {
  response.headers.set('x-request-id', id);
  response.headers.set('x-content-type-options', 'nosniff');
  response.headers.set('x-frame-options', 'DENY');
  response.headers.set('referrer-policy', 'no-referrer');
  response.headers.set('permissions-policy', 'camera=(), microphone=(), geolocation=()');
  response.headers.set('content-security-policy', "default-src 'none'; frame-ancestors 'none'; base-uri 'none'");
  response.headers.set('cross-origin-resource-policy', 'same-site');
  if (secure) response.headers.set('strict-transport-security', 'max-age=31536000; includeSubDomains');
  response.headers.append('vary', 'Origin');
  if (origin) {
    response.headers.set('access-control-allow-origin', origin);
  }
  response.headers.set('access-control-allow-methods', 'GET,POST,PATCH,DELETE,OPTIONS');
  response.headers.set('access-control-allow-headers', 'Authorization,Content-Type,X-Request-Id');
  response.headers.set('access-control-expose-headers', 'X-Request-Id,Content-Disposition,RateLimit,RateLimit-Policy');
  response.headers.set('access-control-max-age', '600');
  void config;
}

function corsOrigin(origin: string | undefined, config: WorkerConfig): string | undefined {
  if (!origin) return undefined;
  if (!config.origins.includes(origin)) throw new AppError(403, 'CORS_ORIGIN_DENIED', 'Origin is not allowed');
  return origin;
}

function errorResponse(error: unknown, c: any, config: WorkerConfig): Response {
  let normalized: unknown = error;
  if (!(error instanceof AppError)) {
    try {
      normalizeD1Error(error);
    } catch (converted) {
      normalized = converted;
    }
  }
  const appError = normalized instanceof AppError ? normalized : new AppError(500, 'INTERNAL_ERROR', 'An unexpected error occurred');
  const id = typeof c.get('requestId') === 'string' ? c.get('requestId') : crypto.randomUUID();
  if (appError.status >= 500) console.error(JSON.stringify({ requestId: id, code: appError.code, error: error instanceof Error ? error.message : 'unknown' }));
  const headers: Record<string, string> = { 'content-type': 'application/json; charset=utf-8', 'x-request-id': id };
  if (c.req.path.startsWith('/api/')) headers['cache-control'] = 'no-store';
  const origin = c.req.header('origin');
  if (origin && config.origins.includes(origin)) {
    headers['access-control-allow-origin'] = origin;
  }
  const response = new Response(JSON.stringify({
    success: false,
    error: { code: appError.code, message: appError.expose ? appError.message : 'An unexpected error occurred', ...(appError.details ? { details: appError.details } : {}), requestId: id },
  }), { status: appError.status, headers });
  securityHeaders(response, id, origin, config, new URL(c.req.url).protocol === 'https:');
  return response;
}

export function createApp(env: Env): Hono<AppEnv> {
  const config = loadWorkerConfig(env);
  const app = new Hono<AppEnv>();
  const auth = authMiddleware(config);
  const standardLimit = bodyLimit({ maxSize: config.standardBodyLimit, onError: () => { throw new AppError(413, 'PAYLOAD_TOO_LARGE', 'Request body exceeds the configured size limit'); } });
  const restoreLimit = bodyLimit({ maxSize: config.restoreBodyLimit, onError: () => { throw new AppError(413, 'PAYLOAD_TOO_LARGE', 'Restore body exceeds the configured size limit'); } });

  app.onError((error, c) => errorResponse(error, c, config));
  app.notFound((c) => {
    const id = typeof c.get('requestId') === 'string' ? c.get('requestId') : crypto.randomUUID();
    const rawOrigin = c.req.header('origin');
    const response = new Response(JSON.stringify({ success: false, error: { code: 'ROUTE_NOT_FOUND', message: `Route ${c.req.method} ${c.req.path} was not found`, requestId: id } }), { status: 404, headers: { 'content-type': 'application/json; charset=utf-8', 'x-request-id': id } });
    securityHeaders(response, id, rawOrigin && config.origins.includes(rawOrigin) ? rawOrigin : undefined, config, new URL(c.req.url).protocol === 'https:');
    return response;
  });

  app.use('*', async (c, next) => {
    const id = requestId(c.req.header('x-request-id'));
    c.set('requestId', id);
    const origin = corsOrigin(c.req.header('origin'), config);
    if (c.req.method === 'OPTIONS') {
      const response = new Response(null, { status: 204 });
      securityHeaders(response, id, origin, config, new URL(c.req.url).protocol === 'https:');
      return response;
    }
    await next();
    securityHeaders(c.res, id, origin, config, new URL(c.req.url).protocol === 'https:');
    if (c.req.path.startsWith('/api/') && !['/api/health', '/api/settings/public'].includes(c.req.path)) {
      c.res.headers.set('cache-control', 'no-store');
      c.res.headers.set('pragma', 'no-cache');
    }
  });

  app.use('/api/*', async (c, next) => {
    assertContentLength(c, c.req.path === '/api/admin/restore' ? config.restoreBodyLimit : config.standardBodyLimit);
    if (c.req.path === '/api/admin/restore') return restoreLimit(c, next);
    return standardLimit(c, next);
  });

  app.get('/api/health', async (c) => {
    try {
      const version = await first<{ version: number }>(c.env.DB, 'SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations');
      const foreignKeys = await first(c.env.DB, 'PRAGMA foreign_key_check');
      const missing: string[] = [];
      for (const table of REQUIRED_TABLES) {
        const row = await first(c.env.DB, "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?", table);
        if (!row) missing.push(table);
      }
      const admins = await first<{ count: number }>(c.env.DB, "SELECT COUNT(*) AS count FROM users WHERE role = 'admin' AND is_active = 1");
      if (Number(version?.version || 0) !== config.schemaVersion || foreignKeys || missing.length || Number(admins?.count || 0) < 1) throw new Error('Database readiness validation failed');
      return c.json({ status: 'ok', database: 'ok', schemaVersion: config.schemaVersion, timestamp: new Date().toISOString() });
    } catch {
      return c.json({ status: 'degraded', database: 'unavailable', schemaVersion: config.schemaVersion, timestamp: new Date().toISOString() }, 503);
    }
  });

  app.get('/api/settings/public', async (c) => c.json(await publicSettingsResponse(c.env.DB)));

  app.use('/api/auth/login', async (c, next) => {
    await maybeBootstrapAdmin(c.env, config);
    await next();
  });
  app.use('/api/auth/me', auth);
  app.use('/api/auth/change-password', auth);
  app.route('/api/auth', authRoutes(config));

  const protect = async (c: Parameters<typeof auth>[0], next: Parameters<typeof auth>[1]) => auth(c, next);
  for (const path of ['/api/users', '/api/dashboard', '/api/sales', '/api/shifts', '/api/expenses', '/api/calendar', '/api/settings', '/api/pump-readings', '/api/sales-readings']) {
    app.use(path, protect);
    app.use(`${path}/*`, protect);
  }
  app.use('/api/fuel', protect);
  app.use('/api/fuel/*', protect);
  app.use('/api/pumps', protect);
  app.use('/api/pumps/*', protect);
  for (const path of ['/api/restock', '/api/stock-adjustments', '/api/reports', '/api/audit', '/api/admin']) {
    app.use(path, protect);
    app.use(`${path}/*`, protect);
    app.use(path, requireAdmin);
    app.use(`${path}/*`, requireAdmin);
  }

  // Fuel and pump writes are administrator-only; reads remain role-scoped.
  const adminWrite = async (c: Parameters<typeof auth>[0], next: Parameters<typeof auth>[1]) => {
    if (['POST', 'PATCH', 'PUT', 'DELETE'].includes(c.req.method)) return requireAdmin(c, next);
    return next();
  };
  app.use('/api/fuel', adminWrite);
  app.use('/api/fuel/*', adminWrite);
  app.use('/api/pumps', adminWrite);
  app.use('/api/pumps/*', adminWrite);

  app.route('/api/users', usersRouter(config));
  app.route('/api/dashboard', dashboardRouter());
  app.route('/api/sales', salesRouter());
  app.route('/api/shifts', shiftsRouter());
  app.route('/api/fuel', fuelRouter());
  app.route('/api/pumps', pumpsRouter());
  app.route('/api/restock', restockRouter());
  app.route('/api/stock-adjustments', adjustmentsRouter());
  app.route('/api/pump-readings', readingsRouter('pump'));
  app.route('/api/sales-readings', readingsRouter('sales'));
  app.route('/api/expenses', expensesRouter());
  app.route('/api/reports', reportsRouter());
  app.route('/api/calendar', calendarRouter());
  app.route('/api/settings', settingsRouter(config));
  app.route('/api/audit', auditRouter());
  app.route('/api/admin', adminRouter());
  return app;
}
