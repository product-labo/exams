import pg from 'pg';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Managed Postgres (Render external URL, Neon, Supabase...) requires SSL; set DATABASE_SSL=true for those.
const ssl = process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : undefined;
export const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl, max: 10 });
export const q = (text, params) => pool.query(text, params);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Wait for the database and create the schema on a fresh one, so the app deploys with no manual SQL step.
 * An advisory lock keeps two instances starting together from both creating it.
 */
export async function initDb() {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is not set. Create a Postgres database and add its connection URL to this service as the DATABASE_URL environment variable.');
  }
  let client;
  for (let attempt = 1; ; attempt++) {
    try { client = await pool.connect(); break; }
    catch (e) {
      // Node reports several failed addresses as an AggregateError with an empty message, so show the real causes.
      const why = e.message || (e.errors || []).map((x) => x.message).filter(Boolean).join('; ') || e.code || 'unknown reason';
      if (attempt >= 30) throw new Error('Database is not reachable: ' + why);
      console.log(`Waiting for the database (${attempt}/30): ${why}`);
      await sleep(2000);
    }
  }
  try {
    await client.query('SELECT pg_advisory_lock(727001)');
    const { rows: [r] } = await client.query(`SELECT to_regclass('public.courses') AS t`);
    if (!r.t) {
      const file = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'sql', 'schema.sql');
      await client.query(fs.readFileSync(file, 'utf8'));
      console.log('Database schema created.');
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock(727001)').catch(() => {});
    client.release();
  }
}
