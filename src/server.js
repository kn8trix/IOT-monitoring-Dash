'use strict';

/**
 * IOT // DASHBOARD — server entrypoint.
 *
 *   HTTP        Express (REST + webhooks + static dashboard)
 *   Realtime    Socket.io fan-out of every telemetry / command / log event
 *   Persistence better-sqlite3 (WAL) at ./data/iot.db
 *   Transport   MQTT bridge to the mosquitto broker
 *   Logic       automation rule engine
 *
 * Boot order matters: DB -> automation -> MQTT -> HTTP/Socket.io.
 */

const http = require('http');
const path = require('path');

const express = require('express');
const compression = require('compression');
const { Server: SocketServer } = require('socket.io');

const config = require('./config');
const db = require('./db');
const mqtt = require('./mqtt');
const ingest = require('./ingest');
const automation = require('./automation');
const apiRoutes = require('./routes/api');
const { rateLimit, requestLogger } = require('./middleware');
const { bus, log } = require('./events');

/* -------------------------------------------------------------------------- */
/* Boot                                                                       */
/* -------------------------------------------------------------------------- */

db.init();
db.seedDevices(config.seed.deviceCount);
db.seedDefaultRules();
automation.start();

/* -------------------------------------------------------------------------- */
/* Express                                                                    */
/* -------------------------------------------------------------------------- */

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', true);

app.use(compression());
app.use(requestLogger);
app.use(express.json({ limit: '1mb' }));
app.use(express.text({ type: ['text/plain', 'application/x-ndjson'], limit: '1mb' }));
app.use(express.urlencoded({ extended: false, limit: '1mb' }));

// CORS for LAN clients / browser-based device flashers.
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Device-Id');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  return next();
});

// Public webhooks are the only "anonymous" surface: throttle them.
app.use('/api', rateLimit());

app.use('/api', apiRoutes);

// Unknown API route (never fall through to the dashboard HTML).
app.use('/api', (req, res) => {
  res.status(404).json({ ok: false, error: `no such endpoint: ${req.method} ${req.originalUrl}` });
});

// Static dashboard.
app.use(
  express.static(config.publicDir, {
    etag: true,
    maxAge: config.env === 'production' ? '1h' : 0,
    index: false,
    extensions: ['html'],
  }),
);

// SPA fallback.
const indexFile = path.join(config.publicDir, 'index.html');
app.use((req, res, next) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') return next();
  return res.sendFile(indexFile, (err) => {
    if (!err) return;
    if (err.code === 'ENOENT') {
      return res.status(503).type('text/plain').send('dashboard assets missing: public/index.html not found');
    }
    return next(err);
  });
});

// Error handler (4 args required by Express).
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  const status = err.status || err.statusCode || 500;
  log('error', 'HTTP', `${req.method} ${req.originalUrl} failed: ${err.message}`);
  res.status(status).json({
    ok: false,
    error: status === 400 ? `bad request: ${err.message}` : err.message,
  });
});

/* -------------------------------------------------------------------------- */
/* Socket.io                                                                  */
/* -------------------------------------------------------------------------- */

const server = http.createServer(app);
const io = new SocketServer(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  maxHttpBufferSize: 1e6,
  pingInterval: 20_000,
  pingTimeout: 25_000,
});

/**
 * Terminal ring buffer + token bucket. A 200-device fleet can produce hundreds
 * of log lines per second; the UI only needs the newest, so overflow is
 * counted and reported as a single line instead of queueing forever.
 */
const TERMINAL_BACKLOG = 250;
const TERMINAL_MAX_LINES_PER_SEC = 25;
const terminalBacklog = [];
let logTokens = TERMINAL_MAX_LINES_PER_SEC;
let suppressedLogs = 0;

setInterval(() => {
  logTokens = TERMINAL_MAX_LINES_PER_SEC;
  if (suppressedLogs > 0 && io) {
    io.emit('terminal', {
      level: 'warn',
      source: 'SYS',
      message: `… ${suppressedLogs} log line(s) suppressed (ingest rate exceeded ${TERMINAL_MAX_LINES_PER_SEC}/s)`,
      ts: Date.now(),
    });
    suppressedLogs = 0;
  }
}, 1000).unref?.();

function terminal(entry) {
  terminalBacklog.push(entry);
  if (terminalBacklog.length > TERMINAL_BACKLOG) terminalBacklog.splice(0, terminalBacklog.length - TERMINAL_BACKLOG);
  if (logTokens > 0) {
    logTokens -= 1;
    io.emit('terminal', entry);
  } else {
    suppressedLogs += 1;
  }
}

function snapshot() {
  const devices = db.listDevices({ limit: 1000 });
  return {
    stats: { ...db.stats(), clients: io.engine.clientsCount },
    devices: devices.devices,
    total_devices: devices.total,
    rules: db.listRules(),
    rule_events: db.listRuleEvents(20),
    commands: db.listCommands({ limit: 25 }),
    recent_telemetry: db.recentTelemetry(40),
    mqtt: mqtt.getStatus(),
    ingest: ingest.getStatus(),
    terminal: terminalBacklog.slice(-80),
    server_time: Date.now(),
    version: require('../package.json').version,
  };
}

io.on('connection', (socket) => {
  log('info', 'SOCK', `dashboard client connected (${io.engine.clientsCount} online)`);

  socket.emit('bootstrap', snapshot());
  socket.emit('mqtt_status', mqtt.getStatus());

  socket.on('request:snapshot', (ack) => {
    const payload = snapshot();
    if (typeof ack === 'function') ack(payload);
    else socket.emit('bootstrap', payload);
  });

  socket.on('request:history', (payload = {}, ack) => {
    try {
      const { device_id, sensor_name, limit, since_ms } = payload || {};
      const points = db.getHistory({
        device_id,
        sensor_name,
        limit: Math.min(Number(limit) || 180, config.telemetryHistoryLimit),
        sinceMs: Number(since_ms) || 30 * 60 * 1000,
      });
      const response = { ok: true, device_id, sensor_name: db.normalizeSensorName(sensor_name), points };
      if (typeof ack === 'function') ack(response);
      else socket.emit('history', response);
    } catch (error) {
      if (typeof ack === 'function') ack({ ok: false, error: error.message });
    }
  });

  socket.on('request:devices', (payload = {}, ack) => {
    const devices = db.listDevices({
      search: payload && payload.search ? String(payload.search) : '',
      limit: 1000,
    });
    const response = { ok: true, ...devices };
    if (typeof ack === 'function') ack(response);
    else socket.emit('devices', response);
  });

  socket.on('disconnect', () => {
    log('info', 'SOCK', `dashboard client disconnected (${io.engine.clientsCount} online)`);
  });
});

/* -------------------------------------------------------------------------- */
/* Bus -> Socket.io fan-out                                                   */
/* -------------------------------------------------------------------------- */

bus.on('log', terminal);
bus.on('telemetry', (reading) => io.emit('telemetry_update', reading));
bus.on('device', (device) => io.emit('device_update', device));
bus.on('command:queued', (command) => io.emit('command_sent', command));
bus.on('command:delivered', (command) => io.emit('command_delivered', command));
bus.on('command:acked', (command) => io.emit('command_acked', command));
bus.on('rule:triggered', (payload) => io.emit('rule_triggered', payload));
bus.on('rules:changed', (rules) => io.emit('rules_changed', rules));
bus.on('mqtt:status', (status) => io.emit('mqtt_status', status));

let statsTimer = null;
function broadcastStats() {
  io.emit('stats', { ...db.stats(), clients: io.engine.clientsCount });
}

/* -------------------------------------------------------------------------- */
/* Background jobs                                                            */
/* -------------------------------------------------------------------------- */

const sweepMs = Math.max(config.device.sweepIntervalSeconds, 5) * 1000;

const sweepTimer = setInterval(() => {
  try {
    db.sweepOffline();
  } catch (error) {
    log('error', 'SWEEP', error.message);
  }
}, sweepMs);
sweepTimer.unref?.();

const pruneTimer = setInterval(() => {
  try {
    db.prune();
    db.checkpoint();
  } catch (error) {
    log('error', 'PRUNE', error.message);
  }
}, 60 * 60 * 1000);
pruneTimer.unref?.();

/* -------------------------------------------------------------------------- */
/* Listen                                                                     */
/* -------------------------------------------------------------------------- */

server.listen(config.port, config.host, () => {
  statsTimer = setInterval(broadcastStats, 5000);
  statsTimer.unref?.();

  log('success', 'HTTP', `IOT // DASHBOARD listening on http://${config.host}:${config.port}`);
  log('info', 'SYS', `env=${config.env} · db=${config.db.path} · offline-after=${config.device.offlineAfterSeconds}s`);
  broadcastStats();
});

mqtt.connect();

/* -------------------------------------------------------------------------- */
/* Graceful shutdown                                                          */
/* -------------------------------------------------------------------------- */

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log('warn', 'SYS', `${signal} received — shutting down`);

  clearInterval(statsTimer);
  clearInterval(sweepTimer);
  clearInterval(pruneTimer);
  automation.stop();

  io.emit('terminal', { level: 'error', source: 'SYS', message: 'server shutting down', ts: Date.now() });

  await new Promise((resolve) => server.close(resolve));
  await mqtt.close();
  db.close();

  log('info', 'SYS', 'shutdown complete');
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('unhandledRejection', (reason) => {
  log('error', 'SYS', `unhandled rejection: ${reason instanceof Error ? reason.message : reason}`);
});

module.exports = { app, server, io };
