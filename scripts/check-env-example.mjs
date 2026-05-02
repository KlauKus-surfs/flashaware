#!/usr/bin/env node
// Drift check: every process.env.X read by server code must appear in
// .env.example, and vice versa. Caught a real bug on first run
// (TWILIO_FROM_NUMBER referenced in capability check but no var by that
// name exists — actual sending uses TWILIO_FROM).
//
// Run: `node scripts/check-env-example.mjs` or `npm run check:env`.
// Exit 0 on match, 1 on drift.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(import.meta.url), '..', '..');

// Vars set by the runtime/platform, never expected in .env.example.
const RUNTIME_VARS = new Set([
  'NODE_ENV',
  'FLY_MACHINE_ID',
  'FLY_REGION',
  'FLY_APP_NAME',
  'FLY_PUBLIC_IP',
  'FLY_PRIVATE_IP',
  // Fly Postgres injects this when attached; dev uses POSTGRES_* instead.
  // We document the dev shape (POSTGRES_HOST/PORT/USER/PASSWORD/DB) and
  // don't list DATABASE_URL because it would mislead developers into
  // setting it locally.
  'DATABASE_URL',
]);

// Directories whose .ts/.js files we scan for `process.env.X` references.
const SCAN_DIRS = ['server'];

function walk(dir, files = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (entry === 'node_modules' || entry === 'dist' || entry === 'tests') continue;
      walk(full, files);
    } else if (full.endsWith('.ts') || full.endsWith('.js')) {
      files.push(full);
    }
  }
  return files;
}

function findEnvRefs() {
  const refs = new Set();
  const re = /process\.env\.([A-Z_][A-Z0-9_]*)/g;
  for (const dir of SCAN_DIRS) {
    for (const file of walk(join(ROOT, dir))) {
      const src = readFileSync(file, 'utf8');
      let m;
      while ((m = re.exec(src)) !== null) refs.add(m[1]);
    }
  }
  return refs;
}

function parseEnvExample() {
  const path = join(ROOT, '.env.example');
  const lines = readFileSync(path, 'utf8').split(/\r?\n/);
  const names = new Set();
  for (const line of lines) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)\s*=/);
    if (m) names.add(m[1]);
  }
  return names;
}

const refs = findEnvRefs();
const documented = parseEnvExample();

const missingFromExample = [...refs]
  .filter((v) => !documented.has(v) && !RUNTIME_VARS.has(v))
  .sort();
const undocumentedInCode = [...documented].filter((v) => !refs.has(v) && !RUNTIME_VARS.has(v)).sort();

let exitCode = 0;
if (missingFromExample.length > 0) {
  console.error('✗ Referenced in code but missing from .env.example:');
  for (const v of missingFromExample) console.error(`    ${v}`);
  exitCode = 1;
}
if (undocumentedInCode.length > 0) {
  console.error('✗ Listed in .env.example but never read in code:');
  for (const v of undocumentedInCode) console.error(`    ${v}`);
  console.error(
    '  (If a var is consumed elsewhere — Dockerfile, fly.toml, ingestion/ — add it to RUNTIME_VARS or extend SCAN_DIRS in scripts/check-env-example.mjs.)',
  );
  exitCode = 1;
}

if (exitCode === 0) {
  console.log(
    `✓ .env.example is in sync with server/ env references (${refs.size} vars, ${documented.size} documented, ${RUNTIME_VARS.size} runtime-set exempt).`,
  );
}
process.exit(exitCode);
