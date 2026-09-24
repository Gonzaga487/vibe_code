import { createApp } from './app';
import { purgeExpiredWorkerRows } from './auth';
import type { Env } from './types';

const appCache = new WeakMap<object, ReturnType<typeof createApp>>();

export default {
  async fetch(request: Request, env: Env, context: ExecutionContext): Promise<Response> {
    try {
      let app = appCache.get(env);
      if (!app) {
        app = createApp(env);
        appCache.set(env, app);
      }
      return await app.fetch(request, env, context);
    } catch (error) {
      const requestId = request.headers.get('x-request-id')?.match(/^[A-Za-z0-9._:-]{1,100}$/)?.[0] || crypto.randomUUID();
      console.error(JSON.stringify({ requestId, code: 'WORKER_STARTUP_ERROR', error: error instanceof Error ? error.message : 'unknown' }));
      return new Response(JSON.stringify({ success: false, error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred', requestId } }), {
        status: 500,
        headers: {
          'content-type': 'application/json; charset=utf-8', 'x-request-id': requestId,
          'x-content-type-options': 'nosniff', 'x-frame-options': 'DENY', 'referrer-policy': 'no-referrer',
          'content-security-policy': "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
        },
      });
    }
  },

  async scheduled(_event: ScheduledController, env: Env, context: ExecutionContext): Promise<void> {
    context.waitUntil(purgeExpiredWorkerRows(env.DB));
  },
};
