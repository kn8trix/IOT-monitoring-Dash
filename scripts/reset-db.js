#!/usr/bin/env node
'use strict';

/**
 * Reset the database to a pristine, **empty** state.
 *
 *   node scripts/reset-db.js            # wipe iot.db, recreate the schema, keep the 4 baseline rules
 *   node scripts/reset-db.js --no-rules # …and leave the rules table empty too
 *
 * There is deliberately no device seeder: the dashboard is populated only by real
 * hardware posting to /api/webhook/data or publishing to iot/+/telemetry.
 */

const fs = require('fs');
const path = require('path');

const config = require('../src/config');

function parseArgs(argv) {
  const args = { rules: true, quiet: false };
  for (let i = 2; i < argv.length; i += 1) {
    switch (argv[i]) {
      case '--no-rules':
        args.rules = false;
        break;
      case '--quiet':
      case '-q':
        args.quiet = true;
        break;
      case '--help':
      case '-h':
        console.log('usage: node scripts/reset-db.js [--no-rules] [--quiet]');
        process.exit(0);
        break;
      default:
        console.warn(`[reset] ignoring unknown option ${argv[i]}`);
    }
  }
  return args;
}

const args = parseArgs(process.argv);

let removed = 0;
for (const suffix of ['', '-wal', '-shm']) {
  const file = `${config.db.path}${suffix}`;
  if (!fs.existsSync(file)) continue;
  // A server still holding the file open would keep writing to the old inode.
  if (suffix === '' && fs.existsSync(`${file}-wal`)) {
    console.warn('[reset] a -wal file is present — stop the server first, or it will keep using the old file');
  }
  fs.unlinkSync(file);
  removed += 1;
  if (!args.quiet) console.log(`[reset] removed ${path.relative(config.rootDir, file)}`);
}

// Required after the wipe so the file is recreated with the full schema.
const db = require('../src/db');

db.init();
const rules = args.rules ? db.seedDefaultRules() : 0;

const stats = db.stats();
console.log(`[reset] files removed:  ${removed}`);
console.log(`[reset] default rules:  ${rules}`);
console.log(`[reset] devices:        ${stats.devices.total}`);
console.log(`[reset] telemetry rows: ${stats.telemetry.total}`);
console.log('[reset] ready — the grid shows its empty state until a device reports in');

db.close();
