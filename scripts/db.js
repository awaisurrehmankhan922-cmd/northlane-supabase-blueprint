#!/usr/bin/env node
// scripts/db.js · create a fresh test database and apply every migration, in order.
//
//   node scripts/db.js reset      drop + create + migrate (what `npm test` runs first)
//   node scripts/db.js migrate    apply migrations to an existing database
//
// Connection comes from the usual PG* environment variables (PGHOST, PGPORT, PGUSER ...).
// Against Supabase use `supabase db push` instead; this script is for CI and local runs.

const { Client } = require('pg');
const fs = require('node:fs');
const path = require('node:path');

const DB_NAME = process.env.TEST_DB || 'northlane_test';
const MIGRATIONS = path.join(__dirname, '..', 'supabase', 'migrations');

async function reset() {
  const admin = new Client({ database: 'postgres' });
  await admin.connect();
  await admin.query(`select pg_terminate_backend(pid) from pg_stat_activity where datname = $1`, [DB_NAME]);
  await admin.query(`drop database if exists ${DB_NAME}`);
  await admin.query(`create database ${DB_NAME}`);
  await admin.end();
  await migrate();
}

async function migrate() {
  const db = new Client({ database: DB_NAME });
  await db.connect();
  const files = fs.readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort();
  for (const f of files) {
    const sql = fs.readFileSync(path.join(MIGRATIONS, f), 'utf8');
    try {
      await db.query(sql);
      console.log('  applied', f);
    } catch (e) {
      console.error('  FAILED', f, '\n', e.message);
      process.exitCode = 1;
      break;
    }
  }
  await db.end();
}

const cmd = process.argv[2] || 'reset';
({ reset, migrate }[cmd] || (() => { console.error('usage: db.js reset|migrate'); process.exit(2); }))();
