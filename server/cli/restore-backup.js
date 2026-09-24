import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../config.js';
import { createDatabase, closeDatabase, databaseIntegrityCheck } from '../db/index.js';
import { validateSnapshot, restoreSnapshot } from '../services/backup.js';

const backupPath = process.argv[2];
if (!backupPath) {
  console.error('Usage: npm run restore:backup -- ./backup.json');
  process.exit(1);
}

const config = loadConfig();
const resolvedBackupPath = path.resolve(backupPath);
let db;
try {
  const candidate = JSON.parse(fs.readFileSync(resolvedBackupPath, 'utf8'));
  db = createDatabase(config.databasePath);
  const admin = candidate?.tables?.users?.rows?.find((user) => user.role === 'admin' && user.is_active === 1);
  if (!admin) throw new Error('Snapshot does not contain an active administrator');
  const snapshot = validateSnapshot(db, candidate, {
    schemaVersion: config.schemaVersion,
    requiredAdmin: {
      id: admin.id,
      username: admin.username,
      role: admin.role,
      sessionVersion: admin.session_version,
    },
  });
  const counts = restoreSnapshot(db, snapshot, { req: null, schemaVersion: config.schemaVersion });
  const integrity = databaseIntegrityCheck(db);
  if (integrity !== 'ok') throw new Error(`Restored database failed integrity check: ${integrity}`);
  console.log('ZENENERGIES backup restored successfully.');
  console.table(counts);
} catch (error) {
  console.error(`Restore failed: ${error.message}`);
  process.exitCode = 1;
} finally {
  if (db?.open) closeDatabase(db);
}
