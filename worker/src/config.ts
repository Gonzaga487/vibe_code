import { AppError } from './errors';
import type { Env, WorkerConfig } from './types';

const PLACEHOLDER_SECRETS = new Set([
  'replace-with-a-strong-random-secret',
  'change-me',
  'changeme',
  'your-secret-here',
  'replace-with-d1-database-id',
]);

function validateSecret(secret: string | undefined): string {
  const value = secret?.trim() || '';
  if (
    value.length < 40
    || new TextEncoder().encode(value).byteLength < 40
    || !/[a-z]/.test(value)
    || !/[A-Z]/.test(value)
    || !/\d/.test(value)
    || !/[^A-Za-z0-9]/.test(value)
    || PLACEHOLDER_SECRETS.has(value)
  ) {
    throw new Error('JWT_SECRET must be a strong Worker secret of at least 40 characters');
  }
  return value;
}

export function parseAllowedOrigins(raw: string | undefined): string[] {
  const origins = (raw || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  if (!origins.length) throw new Error('FRONTEND_ORIGINS must contain at least one exact origin');
  if (origins.includes('*')) throw new Error('Wildcard CORS origins are not allowed');

  const parsed = origins.map((origin) => {
    let url: URL;
    try {
      url = new URL(origin);
    } catch {
      throw new Error(`Invalid CORS origin: ${origin}`);
    }
    if (
      !['http:', 'https:'].includes(url.protocol)
      || url.username
      || url.password
      || url.pathname !== '/'
      || url.search
      || url.hash
    ) {
      throw new Error(`Invalid CORS origin: ${origin}`);
    }
    if (url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
      throw new Error('Non-local CORS origins must use HTTPS');
    }
    return url.origin;
  });
  return [...new Set(parsed)];
}

export function loadWorkerConfig(env: Env): WorkerConfig {
  return Object.freeze({
    schemaVersion: 2,
    jwtSecret: validateSecret(env.JWT_SECRET),
    origins: Object.freeze(parseAllowedOrigins(env.FRONTEND_ORIGINS)),
    bcryptRounds: 10,
    standardBodyLimit: 100 * 1024,
    restoreBodyLimit: 25 * 1024 * 1024,
    loginWindowMs: 15 * 60 * 1000,
    loginMaxFailures: 10,
    loginBlockMs: 15 * 60 * 1000,
  });
}

export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}
