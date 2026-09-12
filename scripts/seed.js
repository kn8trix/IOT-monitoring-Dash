#!/usr/bin/env node
'use strict';

/**
 * Seed helper — prepares `data/iot.db` without booting the web server.
 *
 *   node scripts/seed.js                  # create schema + 220 demo devices + default rules
 *   node scripts/seed.js --count 500      # register 500 devices
 *   node scripts/seed.js --reset          # delete the database first
 *   node scripts/seed.js --reset --count 0 --no-rules
 */

const fs = require('fs');
const path = require('path');

const config = require('../src/config');

function parseArgs(argv) {
  const args = { count: config.seed.deviceCount, reset: false, rules: true };
  for (let i = 2; i < argv.length; i += 1) {
    switch (argv[i]) {
      case '--count':
        args.count = Number(argv[++i]);
        break;
      case '--reset':
        args.reset = true;
        break;
      case '--no-rules':
        args.rules = false;
        break;
      case '--help':
      case '-h':
        console.log('usage: node scripts/seed.js [--count N] [--reset] [--no-rules]');
        process.exit(0);
        break;
      default:
        if (String(argv[i]).startsWith('--')) console.warn(`[seed] ignoring unknown option ${argv[i]}`);
    }
  }
  return args;
}

const args = parseArgs(process.argv);

if (args.reset) {
  for (const suffix of ['', '-wal', '-shm']) {
    const file = `${config.db.path}${suffix}`;
    if (fs.existsSync(file)) {
      fs.unlinkSync(file);
      console.log(`[seed] removed ${path.relative(config.rootDir, file)}`);
    }
  }
}

// Required after the optional reset so the DB is recreated cleanly.
const db = require('../src/db');

db.init();
const created = db.seedDevices(args.count);
const rules = args.rules ? db.seedDefaultRules() : 0;

console.log(`[seed] devices created: ${created}`);
console.log(`[seed] default rules created: ${rules}`);
console.log('[seed] stats:', JSON.stringify(db.stats()));

db.close();
