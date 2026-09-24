import { loadConfig } from '../config.js';
import { createDatabase, closeDatabase, databaseIntegrityCheck } from '../db/index.js';
import { createLogger } from '../logger.js';
import { bootstrapAdmin } from '../services/bootstrap.js';

const logger = createLogger();
let db;
try {
  const config = loadConfig();
  db = createDatabase(config.databasePath);
  if (databaseIntegrityCheck(db) !== 'ok') throw new Error('Database integrity check failed');
  if (!config.adminUsername || !config.adminPassword) {
    throw new Error('ADMIN_USERNAME and ADMIN_PASSWORD must both be explicitly provided');
  }
  const userId = await bootstrapAdmin(db, config, logger);
  if (!userId) {
    throw new Error('Admin bootstrap was not performed; the users table may no longer be empty');
  }
  logger.info({ userId }, 'Administrator bootstrap completed');
  closeDatabase(db);
} catch (error) {
  logger.error({ err: error }, 'Administrator bootstrap failed');
  if (db?.open) closeDatabase(db);
  process.exitCode = 1;
}
