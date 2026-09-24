import { createApp } from './server/app.js';
import { loadConfig } from './server/config.js';
import { createDatabase, closeDatabase, databaseIntegrityCheck } from './server/db/index.js';
import { createLogger } from './server/logger.js';
import { bootstrapAdmin } from './server/services/bootstrap.js';

const config = loadConfig();
const logger = createLogger({ level: config.logLevel });
let db;
let server;
let shuttingDown = false;

async function start() {
  db = createDatabase(config.databasePath);
  const integrity = databaseIntegrityCheck(db);
  if (integrity !== 'ok') throw new Error(`Database integrity check failed: ${integrity}`);

  if (!config.jwtSecret) {
    logger.warn('JWT_SECRET is not configured; using an ephemeral development/test secret. Configure a strong persistent secret before production use.');
  }
  await bootstrapAdmin(db, config, logger);
  const activeAdmins = db.prepare("SELECT COUNT(*) AS count FROM users WHERE role = 'admin' AND is_active = 1").get().count;
  if (config.isProduction && activeAdmins < 1) {
    throw new Error('Production startup requires at least one active administrator');
  }
  const app = createApp({ db, config, logger });
  server = app.listen(config.port, () => {
    logger.info({ port: config.port, environment: config.nodeEnv, schemaVersion: config.schemaVersion }, 'ZENENERGIES API listening');
  });
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;
  server.requestTimeout = 120_000;
}

async function shutdown(signal, exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'Graceful shutdown started');
  const forceTimer = setTimeout(() => {
    logger.error('Graceful shutdown timed out');
    process.exit(exitCode || 1);
  }, 10_000);
  forceTimer.unref();

  try {
    if (server?.listening) {
      await new Promise((resolve) => server.close(resolve));
    }
    if (db?.open) closeDatabase(db);
    clearTimeout(forceTimer);
    logger.info('Graceful shutdown complete');
    process.exit(exitCode);
  } catch (error) {
    logger.error({ err: error }, 'Graceful shutdown failed');
    process.exit(1);
  }
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (error) => {
  logger.fatal({ err: error }, 'Unhandled promise rejection');
  shutdown('unhandledRejection', 1);
});
process.on('uncaughtException', (error) => {
  logger.fatal({ err: error }, 'Uncaught exception');
  shutdown('uncaughtException', 1);
});

start().catch((error) => {
  logger.fatal({ err: error }, 'API startup failed');
  if (db?.open) closeDatabase(db);
  process.exit(1);
});
