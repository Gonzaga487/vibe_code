import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const SCHEMA_VERSION = 2;

const PLACEHOLDER_SECRETS = new Set([
  'replace-with-a-strong-random-secret',
  'change-me',
  'changeme',
  'your-secret-here',
]);

function parseOrigins(raw) {
  const value = raw?.trim();
  if (!value) return [];

  const origins = value.split(',').map((item) => item.trim()).filter(Boolean);
  const parsed = [];
  for (const origin of origins) {
    if (origin === '*') throw new Error('Wildcard CORS origins are not allowed');
    const url = new URL(origin);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
      throw new Error(`Invalid CORS origin: ${origin}`);
    }
    parsed.push(url.origin);
  }
  return [...new Set(parsed)];
}

function parseTrustProxy(raw) {
  if (raw === undefined || raw === '' || raw === '0' || raw === 'false') return false;
  if (raw === '1' || raw === 'true') return 1;
  const hops = Number(raw);
  if (!Number.isInteger(hops) || hops < 1) throw new Error('TRUST_PROXY must be 0, 1, or a positive integer');
  return hops;
}

function resolveSqlitePath(databaseUrl, dbPath, { requireAbsolute = false } = {}) {
  let selected = databaseUrl?.trim() || dbPath?.trim() || 'data/zenenergies.sqlite';
  if (selected === ':memory:') return selected;
  const pathCandidate = selected.startsWith('file:') ? selected.slice('file:'.length) : selected;
  if (requireAbsolute && !path.isAbsolute(pathCandidate)) {
    throw new Error('Production DATABASE_URL must be an absolute persistent SQLite path');
  }

  if (selected.startsWith('file:')) {
    const raw = selected.slice('file:'.length);
    if (!raw) throw new Error('DATABASE_URL file path is empty');
    if (/^[a-zA-Z]:[\\/]/.test(raw)) {
      selected = raw;
    } else {
      const url = new URL(selected, pathToFileURL(`${PROJECT_ROOT}${path.sep}`));
      if (url.hostname && url.hostname !== 'localhost') {
        throw new Error('DATABASE_URL SQLite file URLs must be local');
      }
      if (url.search || url.hash) throw new Error('DATABASE_URL SQLite URL cannot contain query strings or fragments');
      selected = fileURLToPath(url);
    }
  } else if (/^[a-zA-Z][a-zA-Z\d+.-]*:\/\//.test(selected)) {
    throw new Error('DATABASE_URL must be a SQLite file path or file: URL');
  }

  return path.isAbsolute(selected) ? path.normalize(selected) : path.resolve(PROJECT_ROOT, selected);
}

function validateJwtSecret(secret, nodeEnv) {
  if (secret && Buffer.byteLength(secret, 'utf8') >= 40 && /[a-z]/.test(secret) && /[A-Z]/.test(secret) && /\d/.test(secret) && /[^A-Za-z0-9]/.test(secret) && !PLACEHOLDER_SECRETS.has(secret)) {
    return secret;
  }
  if (nodeEnv === 'production') {
    throw new Error('JWT_SECRET must be a strong, unique secret of at least 40 bytes in production');
  }
  return null;
}

export function loadConfig(env = process.env) {
  const nodeEnv = env.NODE_ENV || 'development';
  if (!['development', 'test', 'production'].includes(nodeEnv)) {
    throw new Error('NODE_ENV must be development, test, or production');
  }

  const configuredSecret = env.JWT_SECRET?.trim() || null;
  const jwtSecret = validateJwtSecret(configuredSecret, nodeEnv);
  const origins = parseOrigins(env.FRONTEND_ORIGINS || env.CORS_ORIGINS);
  const port = Number(env.PORT || 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be between 1 and 65535');
  const databasePath = resolveSqlitePath(env.DATABASE_URL, env.DB_PATH, { requireAbsolute: nodeEnv === 'production' });
  if (nodeEnv === 'production') {
    if (!origins.length) throw new Error('FRONTEND_ORIGINS must contain at least one explicit production origin');
    if (origins.some((origin) => new URL(origin).protocol !== 'https:')) throw new Error('Production FRONTEND_ORIGINS must use HTTPS');
    if (databasePath === ':memory:') throw new Error('Production DATABASE_URL cannot use an in-memory database');
  }

  return Object.freeze({
    nodeEnv,
    isProduction: nodeEnv === 'production',
    port,
    jwtSecret,
    origins: Object.freeze(origins),
    databasePath,
    trustProxy: parseTrustProxy(env.TRUST_PROXY),
    logLevel: env.LOG_LEVEL || (nodeEnv === 'test' ? 'silent' : 'info'),
    adminUsername: env.ADMIN_USERNAME?.trim() || null,
    adminPassword: env.ADMIN_PASSWORD || null,
    adminFullName: env.ADMIN_FULL_NAME?.trim() || 'Station Administrator',
    bodyLimit: '100kb',
    restoreBodyLimit: '25mb',
    schemaVersion: SCHEMA_VERSION,
  });
}
