'use strict';

/**
 * Vendors the browser libraries into `public/vendor/` so the dashboard runs on
 * an isolated LAN with no CDN access:
 *
 *   chart.js  -> public/vendor/chart.umd.js
 *
 * Socket.io's client is served automatically by the Socket.io server at
 * `/socket.io/socket.io.js`, so it needs no vendoring step.
 *
 * Run with `npm run vendor` (also part of `npm run build`).
 */

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const targetDir = path.join(root, 'public', 'vendor');

const ASSETS = [['chart.js', 'dist/chart.umd.min.js', 'chart.umd.js']];

fs.mkdirSync(targetDir, { recursive: true });

let copied = 0;
for (const [pkg, from, to] of ASSETS) {
  const source = path.join(root, 'node_modules', pkg, from);
  const target = path.join(targetDir, to);

  if (!fs.existsSync(source)) {
    console.error(`[vendor] missing ${source} — run "npm install" first`);
    process.exitCode = 1;
    continue;
  }

  const size = fs.statSync(source).size;
  const current = fs.existsSync(target) ? fs.statSync(target).size : -1;
  if (size === current) {
    console.log(`[vendor] ${to} up to date (${(size / 1024).toFixed(0)} kB)`);
    continue;
  }

  fs.copyFileSync(source, target);
  copied += 1;
  console.log(`[vendor] ${pkg}/${from} -> public/vendor/${to} (${(size / 1024).toFixed(0)} kB)`);
}

console.log(`[vendor] done (${copied} file(s) copied)`);
