const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

// Connect through flyctl proxy on port 5454
// Fly Postgres default superuser is 'postgres'
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
    // Check what tables exist
    const tables = await client.query(
      "SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename"
    );
    console.log('Existing tables:', tables.rows.map(r => r.tablename).join(', ') || 'NONE');

    if (tables.rows.length === 0) {
      console.log('No tables found — applying full schema...');
      const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
      await client.query(schema);
      console.log('Schema applied successfully.');
    } else {
      console.log('Tables exist — running migration only...');
      const migration = fs.readFileSync(path.join(__dirname, 'migrate_prod.sql'), 'utf8');
      const result = await client.query(migration);
      console.log('Migration result:', result[result.length - 1]?.rows);
    }

    // Verify
    const check = await client.query(
      "SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename"
    );
    console.log('Tables after:', check.rows.map(r => r.tablename).join(', '));

    const users = await client.query('SELECT email, role FROM users');
    console.log('Users:', users.rows);
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
