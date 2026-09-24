import fs from 'fs';
import path from 'path';
import type { IDatabase } from 'pg-promise';

/**
 * Applies every not-yet-applied .sql file in migrationsDir, in filename
 * order, tracked via a schema_migrations table — same logic
 * scripts/migrate.ts uses against the real deployment database, extracted
 * here so the Layer 2 integration test harness can apply the identical
 * migration chain against a throwaway testcontainers Postgres instance.
 * Two independent paths running different migration logic would be a real
 * risk: divergence there is exactly the kind of thing these integration
 * tests exist to catch in the schema itself, not just the app code.
 */
export async function applyMigrations(db: IDatabase<any>, migrationsDir: string): Promise<void> {
  await db.none(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  const applied = new Set((await db.any(`SELECT filename FROM schema_migrations`)).map((r: any) => r.filename));
  const files = fs.readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort();

  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
    await db.tx(async (t) => {
      await t.none(sql);
      await t.none(`INSERT INTO schema_migrations (filename) VALUES ($1)`, [file]);
    });
  }
}
