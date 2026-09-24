import path from 'path';
import { db } from '../src/db';
import { logger } from '../src/services/logger';
import { applyMigrations } from '../src/migrationRunner';

// Compiled output lives at /app/dist/scripts/migrate.js, with migrations/
// copied to /app/migrations — two levels up from the compiled script.
const MIGRATIONS_DIR = path.join(__dirname, '../../migrations');

applyMigrations(db, MIGRATIONS_DIR)
  .then(() => {
    logger.info('Migrations up to date.');
    process.exit(0);
  })
  .catch((err) => {
    logger.error({ err }, 'Migration failed');
    process.exit(1);
  });
