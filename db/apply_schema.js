// Bootstrap helper for a fresh database. Connects through `flyctl proxy` and
// applies db/schema.sql when the target DB has no tables.
//
// This script does NOT apply migrations. Migrations are owned by
// server/migrate.ts and run on every server boot — anything beyond an empty
// schema is the server's job. The legacy db/migrate_prod.sql has been
// retired; if you find a database that's mid-state (some tables, some
// columns) just boot the server and let migrate.ts catch it up.
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

const pool = new Pool({
  host: '127.0.0.1',
  port: 5454,
  user: 'postgres',
  database: 'lightning_risk',
  ssl: false,
  connectionTimeoutMillis: 10000,
});

async function main() {
  const client = await pool.connect();
  try {
    const tables = await client.query(
      "SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename",
    );
    console.log('Existing tables:', tables.rows.map((r) => r.tablename).join(', ') || 'NONE');

    if (tables.rows.length === 0) {
      console.log('Empty database — applying schema.sql...');
      const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
      await client.query(schema);
      console.log('Schema applied. Migrations will run on next server boot.');
    } else {
      console.log('Database is non-empty — skipping. Boot the server to run migrations.');
    }

    const check = await client.query(
      "SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename",
    );
    console.log('Tables after:', check.rows.map((r) => r.tablename).join(', '));
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((e) => {
  console.error('ERROR:', e.message);
  process.exit(1);
});
