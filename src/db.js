'use strict';

/**
 * SQLite persistence layer (better-sqlite3, synchronous + prepared statements).
 *
 * Tables
 *   devices           registered nodes, last transport metadata, liveness
 *   telemetry         append-only time series (device_id, sensor_name, value)
 *   latest_telemetry  one row per (device, sensor) -> O(1) device card render
 *   commands          command queue, HTTP-pollable, mirrored to MQTT
 *   automation_rules  "if sensor > threshold then action" rules
 *   rule_events       audit trail of every automation trigger
 *
 * Schema versions
 *   1  initial build
 *   2  devices.mac (shown on the dashboard device cards)
 */

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const config = require('./config');
const { bus, log } = require('./events');

const SCHEMA_VERSION = 2;

let db = null;
let stmts = {};

/* -------------------------------------------------------------------------- */
/* Schema                                                                     */
/* -------------------------------------------------------------------------- */

const DDL = `
CREATE TABLE IF NOT EXISTS devices (
  device_id     TEXT PRIMARY KEY,
  name          TEXT,
  ip            TEXT,
  mac           TEXT,
  location      TEXT,
  firmware      TEXT,
  status        TEXT    NOT NULL DEFAULT 'offline',
  last_seen     INTEGER,
  last_payload  TEXT,
  first_seen    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_devices_status_time ON devices (status, last_seen DESC);

CREATE TABLE IF NOT EXISTS telemetry (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id    TEXT    NOT NULL,
  sensor_name  TEXT    NOT NULL,
  value        REAL,
  raw_value    TEXT,
  unit         TEXT,
  created_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_telemetry_series  ON telemetry (device_id, sensor_name, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_telemetry_time    ON telemetry (created_at DESC);

CREATE TABLE IF NOT EXISTS latest_telemetry (
  device_id    TEXT    NOT NULL,
  sensor_name  TEXT    NOT NULL,
  value        REAL,
  unit         TEXT,
  created_at   INTEGER NOT NULL,
  PRIMARY KEY (device_id, sensor_name)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS commands (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id    TEXT    NOT NULL,
  payload      TEXT    NOT NULL,
  status       TEXT    NOT NULL DEFAULT 'pending',
  source       TEXT    NOT NULL DEFAULT 'api',
  transport    TEXT,
  mqtt_topic   TEXT,
  created_at   INTEGER NOT NULL,
  delivered_at INTEGER,
  acked_at     INTEGER,
  error        TEXT
);
CREATE INDEX IF NOT EXISTS idx_commands_queue  ON commands (device_id, status, id);
CREATE INDEX IF NOT EXISTS idx_commands_recent ON commands (created_at DESC);

CREATE TABLE IF NOT EXISTS automation_rules (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  name             TEXT    NOT NULL,
  device_id        TEXT    NOT NULL DEFAULT '*',
  sensor_name      TEXT    NOT NULL,
  operator         TEXT    NOT NULL DEFAULT '>',
  threshold        REAL    NOT NULL,
  action           TEXT    NOT NULL DEFAULT 'RELAY_OFF',
  action_payload   TEXT,
  enabled          INTEGER NOT NULL DEFAULT 1,
  cooldown_seconds INTEGER NOT NULL DEFAULT 60,
  last_triggered   INTEGER,
  trigger_count    INTEGER NOT NULL DEFAULT 0,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS rule_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  rule_id     INTEGER,
  rule_name   TEXT,
  device_id   TEXT,
  sensor_name TEXT,
  value       REAL,
  operator    TEXT,
  threshold   REAL,
  action      TEXT,
  payload     TEXT,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rule_events_time ON rule_events (created_at DESC);
`;

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

const now = () => Date.now();

/** Sensors we accept from devices; anything else is stored verbatim. */
function normalizeSensorName(name) {
  return String(name || 'sensor')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.:-]+/g, '_')
    .slice(0, 64) || 'sensor';
}

function coerceValue(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return { value, raw: null };
  }
  if (typeof value === 'boolean') return { value: value ? 1 : 0, raw: null };
  const parsed = Number.parseFloat(value);
  if (Number.isFinite(parsed)) return { value: parsed, raw: null };
  return { value: null, raw: value === undefined || value === null ? null : String(value) };
}

/* -------------------------------------------------------------------------- */
/* Lifecycle                                                                  */
/* -------------------------------------------------------------------------- */

function init() {
  if (db) return db;

  fs.mkdirSync(path.dirname(config.db.path), { recursive: true });
  db = new Database(config.db.path);

  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  db.pragma(`busy_timeout = 5000`);
  db.pragma('temp_store = MEMORY');

  db.exec(DDL);
  migrate();
  prepare();
  migrateDevicesToOffline();
  log('info', 'DB', `SQLite ready at ${config.db.path} (schema v${SCHEMA_VERSION})`);
  return db;
}

/**
 * Additive migrations for databases created by an older release.
 * `CREATE TABLE IF NOT EXISTS` never alters an existing table, so column
 * additions are applied explicitly here.
 */
function migrate() {
  const version = db.pragma('user_version', { simple: true });
  const columns = new Set(db.prepare('PRAGMA table_info(devices)').all().map((row) => row.name));

  if (!columns.has('mac')) {
    db.exec('ALTER TABLE devices ADD COLUMN mac TEXT');
    log('info', 'DB', 'migration applied: devices.mac (schema v2)');
  }

  if (version !== SCHEMA_VERSION) {
    db.pragma(`user_version = ${SCHEMA_VERSION}`);
    log('info', 'DB', `schema version ${version} -> ${SCHEMA_VERSION}`);
  }
}

/** A restart means we lost contact with everything: re-arm liveness. */
function migrateDevicesToOffline() {
  const { changes } = db
    .prepare(`UPDATE devices SET status = 'offline', updated_at = ? WHERE status <> 'offline'`)
    .run(now());
  if (changes > 0) log('warn', 'DB', `${changes} device(s) marked offline after restart`);
}

function close() {
  if (!db) return;
  try {
    db.pragma('wal_checkpoint(TRUNCATE)');
  } catch {
    /* best effort */
  }
  db.close();
  db = null;
  stmts = {};
}

function prepare() {
  stmts = {
    insertDevice: db.prepare(`
      INSERT INTO devices (device_id, name, ip, mac, location, firmware, status, last_seen, last_payload, first_seen, updated_at)
      VALUES (@device_id, @name, @ip, @mac, @location, @firmware, 'online', @ts, @last_payload, @ts, @ts)
      ON CONFLICT(device_id) DO NOTHING
    `),
    touchDevice: db.prepare(`
      UPDATE devices
         SET status = 'online',
             last_seen = @ts,
             updated_at = @ts,
             ip = COALESCE(@ip, ip),
             mac = COALESCE(@mac, mac),
             name = COALESCE(@name, name),
             firmware = COALESCE(@firmware, firmware),
             location = COALESCE(@location, location),
             last_payload = COALESCE(@last_payload, last_payload)
       WHERE device_id = @device_id
    `),
    getDevice: db.prepare(`SELECT * FROM devices WHERE device_id = ?`),
    listDevices: db.prepare(`SELECT * FROM devices ORDER BY device_id ASC LIMIT ? OFFSET ?`),
    listDevicesFiltered: db.prepare(`
      SELECT * FROM devices
       WHERE (device_id LIKE @q OR IFNULL(name,'') LIKE @q OR IFNULL(ip,'') LIKE @q
              OR IFNULL(mac,'') LIKE @q OR IFNULL(location,'') LIKE @q)
       ORDER BY CASE status WHEN 'online' THEN 0 ELSE 1 END, last_seen DESC, device_id ASC
       LIMIT @limit OFFSET @offset
    `),
    countDevices: db.prepare(`SELECT COUNT(*) AS c FROM devices`),
    countDevicesFiltered: db.prepare(`
      SELECT COUNT(*) AS c FROM devices
       WHERE (device_id LIKE @q OR IFNULL(name,'') LIKE @q OR IFNULL(ip,'') LIKE @q
              OR IFNULL(mac,'') LIKE @q OR IFNULL(location,'') LIKE @q)
    `),
    setStatus: db.prepare(`UPDATE devices SET status = ?, updated_at = ? WHERE device_id = ? AND status <> ?`),
    offlineDevices: db.prepare(`
      UPDATE devices SET status = 'offline', updated_at = ?
       WHERE status = 'online' AND (last_seen IS NULL OR last_seen < ?)
    `),
    listOfflineChanged: db.prepare(`
      SELECT * FROM devices WHERE status = 'offline' AND updated_at = ?
    `),

    insertTelemetry: db.prepare(`
      INSERT INTO telemetry (device_id, sensor_name, value, raw_value, unit, created_at)
      VALUES (@device_id, @sensor_name, @value, @raw_value, @unit, @created_at)
    `),
    upsertLatest: db.prepare(`
      INSERT INTO latest_telemetry (device_id, sensor_name, value, unit, created_at)
      VALUES (@device_id, @sensor_name, @value, @unit, @created_at)
      ON CONFLICT(device_id, sensor_name) DO UPDATE SET
        value = excluded.value, unit = excluded.unit, created_at = excluded.created_at
    `),
    latestForDevice: db.prepare(`
      SELECT sensor_name, value, unit, created_at FROM latest_telemetry
       WHERE device_id = ? ORDER BY sensor_name ASC
    `),
    latestAll: db.prepare(`SELECT * FROM latest_telemetry`),
    history: db.prepare(`
      SELECT ts, value FROM (
        SELECT created_at AS ts, value FROM telemetry
         WHERE device_id = @device_id AND sensor_name = @sensor_name AND created_at >= @since AND value IS NOT NULL
         ORDER BY created_at DESC
         LIMIT @limit
      ) ORDER BY ts ASC
    `),
    recentTelemetry: db.prepare(`
      SELECT id, device_id, sensor_name, value, unit, created_at
        FROM telemetry ORDER BY id DESC LIMIT ?
    `),
    // Last N samples per (device, sensor) — feeds the device-card sparklines.
    // Bounded by time so a multi-million row table still answers in ticks.
    recentSeries: db.prepare(`
      SELECT device_id, sensor_name, value, created_at FROM (
        SELECT device_id, sensor_name, value, created_at,
               ROW_NUMBER() OVER (
                 PARTITION BY device_id, sensor_name ORDER BY created_at DESC, id DESC
               ) AS rn
          FROM telemetry
         WHERE created_at >= @since AND value IS NOT NULL
      )
       WHERE rn <= @points
       ORDER BY device_id, sensor_name, created_at ASC
       LIMIT @maxRows
    `),
    sensorsForDevice: db.prepare(`
      SELECT sensor_name, COUNT(*) AS samples, MAX(created_at) AS last_at
        FROM telemetry WHERE device_id = ? GROUP BY sensor_name ORDER BY sensor_name ASC
    `),
    countTelemetry: db.prepare(`SELECT COUNT(*) AS c FROM telemetry`),
    countTelemetrySince: db.prepare(`SELECT COUNT(*) AS c FROM telemetry WHERE created_at >= ?`),
    pruneTelemetry: db.prepare(`DELETE FROM telemetry WHERE created_at < ?`),
    pruneTelemetryOverflow: db.prepare(`
      DELETE FROM telemetry WHERE id <= (
        SELECT id FROM telemetry ORDER BY id DESC LIMIT 1 OFFSET @maxRows
      )
    `),

    insertCommand: db.prepare(`
      INSERT INTO commands (device_id, payload, status, source, transport, mqtt_topic, created_at)
      VALUES (@device_id, @payload, 'pending', @source, @transport, @mqtt_topic, @created_at)
    `),
    getCommand: db.prepare(`SELECT * FROM commands WHERE id = ?`),
    pendingCommands: db.prepare(`
      SELECT * FROM commands WHERE device_id = ? AND status = 'pending' ORDER BY id ASC LIMIT ?
    `),
    markDelivered: db.prepare(`
      UPDATE commands SET status = 'delivered', delivered_at = @ts
       WHERE id = @id AND status = 'pending'
    `),
    markMqttDelivered: db.prepare(`
      UPDATE commands SET status = 'delivered', transport = 'mqtt', delivered_at = @ts
       WHERE id = @id AND status = 'pending'
    `),
    ackCommand: db.prepare(`
      UPDATE commands
         SET status = @status, acked_at = @ts, error = @error
       WHERE id = @id
    `),
    listCommands: db.prepare(`
      SELECT c.*, d.name AS device_name FROM commands c
        LEFT JOIN devices d ON d.device_id = c.device_id
       ORDER BY c.id DESC LIMIT ?
    `),
    listCommandsForDevice: db.prepare(`
      SELECT * FROM commands WHERE device_id = ? ORDER BY id DESC LIMIT ?
    `),
    countCommands: db.prepare(`SELECT COUNT(*) AS c FROM commands`),
    countCommandsByStatus: db.prepare(`SELECT COUNT(*) AS c FROM commands WHERE status = ?`),
    pruneCommands: db.prepare(`
      DELETE FROM commands WHERE status <> 'pending' AND id <= (
        SELECT id FROM commands WHERE status <> 'pending' ORDER BY id DESC LIMIT 1 OFFSET @maxRows
      )
    `),

    listRules: db.prepare(`SELECT * FROM automation_rules ORDER BY id DESC`),
    getRule: db.prepare(`SELECT * FROM automation_rules WHERE id = ?`),
    rulesForSensor: db.prepare(`
      SELECT * FROM automation_rules
       WHERE enabled = 1 AND sensor_name = ? AND (device_id = '*' OR device_id = ?)
       ORDER BY id ASC
    `),
    insertRule: db.prepare(`
      INSERT INTO automation_rules
        (name, device_id, sensor_name, operator, threshold, action, action_payload, enabled, cooldown_seconds, created_at, updated_at)
      VALUES
        (@name, @device_id, @sensor_name, @operator, @threshold, @action, @action_payload, @enabled, @cooldown_seconds, @ts, @ts)
    `),
    updateRule: db.prepare(`
      UPDATE automation_rules SET
        name = COALESCE(@name, name),
        device_id = COALESCE(@device_id, device_id),
        sensor_name = COALESCE(@sensor_name, sensor_name),
        operator = COALESCE(@operator, operator),
        threshold = COALESCE(@threshold, threshold),
        action = COALESCE(@action, action),
        action_payload = COALESCE(@action_payload, action_payload),
        enabled = COALESCE(@enabled, enabled),
        cooldown_seconds = COALESCE(@cooldown_seconds, cooldown_seconds),
        updated_at = @ts
      WHERE id = @id
    `),
    markRuleTriggered: db.prepare(`
      UPDATE automation_rules
         SET last_triggered = @ts, trigger_count = trigger_count + 1, updated_at = @ts
       WHERE id = @id
    `),
    deleteRule: db.prepare(`DELETE FROM automation_rules WHERE id = ?`),
    countRules: db.prepare(`SELECT COUNT(*) AS c FROM automation_rules`),
    countRulesEnabled: db.prepare(`SELECT COUNT(*) AS c FROM automation_rules WHERE enabled = 1`),

    insertRuleEvent: db.prepare(`
      INSERT INTO rule_events
        (rule_id, rule_name, device_id, sensor_name, value, operator, threshold, action, payload, created_at)
      VALUES
        (@rule_id, @rule_name, @device_id, @sensor_name, @value, @operator, @threshold, @action, @payload, @created_at)
    `),
    listRuleEvents: db.prepare(`
      SELECT * FROM rule_events ORDER BY id DESC LIMIT ?
    `),
    pruneRuleEvents: db.prepare(`
      DELETE FROM rule_events WHERE id <= (
        SELECT id FROM rule_events ORDER BY id DESC LIMIT 1 OFFSET @maxRows
      )
    `),
  };
}

/* -------------------------------------------------------------------------- */
/* Devices                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Register or refresh a device. Emits `device` only when the row is new or the
 * liveness state actually flipped, so 200+ devices don't flood the socket.
 */
function upsertDevice({ device_id, name, ip, mac, location, firmware, last_payload } = {}) {
  const id = String(device_id || '').trim();
  if (!id) return null;

  const ts = now();
  const existing = stmts.getDevice.get(id);
  const params = {
    device_id: id,
    name: name || null,
    ip: ip || null,
    mac: mac ? String(mac).trim().slice(0, 32) : null,
    location: location || null,
    firmware: firmware || null,
    last_payload: last_payload ? String(last_payload).slice(0, 512) : null,
    ts,
  };

  if (!existing) {
    stmts.insertDevice.run(params);
    const device = stmts.getDevice.get(id);
    bus.emit('device', device);
    log('success', 'DB', `device registered: ${id}${ip ? ` @ ${ip}` : ''}${mac ? ` [${mac}]` : ''}`);
    return device;
  }

  const wasOffline = existing.status !== 'online';
  stmts.touchDevice.run(params);
  const device = stmts.getDevice.get(id);
  if (wasOffline) {
    bus.emit('device', device);
    log('success', 'DB', `device online: ${id}`);
  }
  return device;
}

function getDevice(deviceId) {
  return stmts.getDevice.get(String(deviceId)) || null;
}

/** Force a liveness transition (used by MQTT LWT / status topics). */
function setStatus(deviceId, status) {
  const id = String(deviceId || '').trim();
  const safe = status === 'online' ? 'online' : 'offline';
  if (!id) return null;
  if (!stmts.getDevice.get(id)) {
    upsertDevice({ device_id: id });
  }
  const ts = now();
  const { changes } = stmts.setStatus.run(safe, ts, id, safe);
  const device = stmts.getDevice.get(id);
  if (changes) {
    bus.emit('device', device);
    log(safe === 'online' ? 'success' : 'warn', 'MQTT', `device ${safe}: ${id}`);
  }
  return device;
}

/**
 * Device list joined with its latest sensor readings (and, optionally, the last
 * N samples of every series so the dashboard cards can draw a sparkline).
 *
 * @param {{ search?: string, limit?: number, offset?: number,
 *           sparkline?: boolean, sparklinePoints?: number }} opts
 */
function listDevices({ search = '', limit = 500, offset = 0, sparkline = false, sparklinePoints = 10 } = {}) {
  const safeLimit = Math.min(Math.max(Number(limit) || 500, 1), 2000);
  const safeOffset = Math.max(Number(offset) || 0, 0);
  const term = String(search || '').trim();

  const rows = term
    ? stmts.listDevicesFiltered.all({ q: `%${term}%`, limit: safeLimit, offset: safeOffset })
    : stmts.listDevices.all(safeLimit, safeOffset);

  const total = term
    ? stmts.countDevicesFiltered.get({ q: `%${term}%` }).c
    : stmts.countDevices.get().c;

  const latest = stmts.latestAll.all();
  const byDevice = new Map();
  for (const row of latest) {
    if (!byDevice.has(row.device_id)) byDevice.set(row.device_id, {});
    byDevice.get(row.device_id)[row.sensor_name] = {
      value: row.value,
      unit: row.unit || null,
      ts: row.created_at,
    };
  }

  let series = null;
  if (sparkline && rows.length) {
    series = getRecentSeries({ points: sparklinePoints });
  }

  const devices = rows.map((device) => ({
    ...device,
    metrics: byDevice.get(device.device_id) || {},
    ...(series ? { sparkline: series.get(device.device_id) || {} } : {}),
  }));

  return { devices, total, limit: safeLimit, offset: safeOffset };
}

/**
 * Latest samples per (device, sensor): `device_id -> sensor -> [{ts, value}]`.
 * Only recent history is scanned so the query stays fast as `telemetry` grows.
 */
function getRecentSeries({ points = 10, sinceMs = 5 * 60 * 1000, maxRows = 20000 } = {}) {
  const rows = stmts.recentSeries.all({
    points: Math.min(Math.max(Number(points) || 10, 1), 200),
    since: now() - Math.max(Number(sinceMs) || 0, 1000),
    maxRows: Math.min(Math.max(Number(maxRows) || 20000, 100), 200000),
  });

  const byDevice = new Map();
  for (const row of rows) {
    if (!byDevice.has(row.device_id)) byDevice.set(row.device_id, {});
    const deviceSeries = byDevice.get(row.device_id);
    if (!deviceSeries[row.sensor_name]) deviceSeries[row.sensor_name] = [];
    deviceSeries[row.sensor_name].push({ ts: row.created_at, value: row.value });
  }
  return byDevice;
}

/** Flip devices that stopped reporting to `offline`. Returns affected count. */
function sweepOffline() {
  const cutoff = now() - config.device.offlineAfterSeconds * 1000;
  const ts = now();
  const { changes } = stmts.offlineDevices.run(ts, cutoff);
  if (changes > 0) {
    for (const device of stmts.listOfflineChanged.all(ts)) {
      bus.emit('device', device);
    }
    log('warn', 'SWEEP', `${changes} device(s) went offline (no data > ${config.device.offlineAfterSeconds}s)`);
  }
  return changes;
}

/* -------------------------------------------------------------------------- */
/* Telemetry                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Persist one sensor reading (and refresh the device + latest-value cache).
 * @returns {{ inserted: boolean, telemetry: object|null, device: object|null }}
 */
function recordTelemetry({ device_id, sensor_name, value, unit, ip, mac, name, location, firmware, created_at } = {}) {
  const id = String(device_id || '').trim();
  if (!id) return { inserted: false, telemetry: null, device: null };

  const sensor = normalizeSensorName(sensor_name);
  const { value: numeric, raw } = coerceValue(value);
  const ts = Number.isFinite(Number(created_at)) && Number(created_at) > 0 ? Number(created_at) : now();

  const device = upsertDevice({
    device_id: id,
    ip,
    mac,
    name,
    location,
    firmware,
    last_payload: JSON.stringify({ sensor, value: numeric ?? raw, unit: unit ?? null }),
  });

  const row = {
    device_id: id,
    sensor_name: sensor,
    value: numeric,
    raw_value: raw,
    unit: unit ? String(unit).slice(0, 16) : null,
    created_at: ts,
  };

  const telemetry = {
    device_id: id,
    sensor_name: sensor,
    value: numeric,
    raw_value: raw,
    unit: row.unit,
    created_at: ts,
  };

  if (numeric === null && raw === null) {
    return { inserted: false, telemetry: null, device };
  }

  const write = db.transaction(() => {
    const info = stmts.insertTelemetry.run(row);
    telemetry.id = info.lastInsertRowid;
    if (numeric !== null) {
      stmts.upsertLatest.run({
        device_id: id,
        sensor_name: sensor,
        value: numeric,
        unit: row.unit,
        created_at: ts,
      });
    }
  });

  write();
  return { inserted: true, telemetry, device };
}

/** Chart data for one device/sensor series. */
function getHistory({ device_id, sensor_name, limit = 200, sinceMs = 60 * 60 * 1000 } = {}) {
  const since = now() - Math.max(Number(sinceMs) || 0, 1000);
  return stmts.history.all({
    device_id: String(device_id),
    sensor_name: normalizeSensorName(sensor_name),
    limit: Math.min(Math.max(Number(limit) || 200, 2), config.telemetryHistoryLimit),
    since,
  });
}

function getLatest(deviceId) {
  const rows = stmts.latestForDevice.all(String(deviceId));
  const metrics = {};
  for (const row of rows) {
    metrics[row.sensor_name] = { value: row.value, unit: row.unit || null, ts: row.created_at };
  }
  return metrics;
}

function getSensors(deviceId) {
  return stmts.sensorsForDevice.all(String(deviceId));
}

function recentTelemetry(limit = 50) {
  return stmts.recentTelemetry.all(Math.min(Math.max(Number(limit) || 50, 1), 500));
}

/* -------------------------------------------------------------------------- */
/* Commands                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Queue a command for a device. Transport marks whether it went out over MQTT,
 * stayed in the queue for HTTP polling, or both.
 */
function queueCommand({ device_id, payload, source = 'api', transport = 'queue', mqtt_topic = null } = {}) {
  const id = String(device_id || '').trim();
  if (!id) throw new Error('device_id is required');

  const serialized =
    typeof payload === 'string' ? payload : JSON.stringify(payload ?? {});

  const info = stmts.insertCommand.run({
    device_id: id,
    payload: serialized.slice(0, 8192),
    source: String(source).slice(0, 32),
    transport: String(transport).slice(0, 32),
    mqtt_topic,
    created_at: now(),
  });

  const command = stmts.getCommand.get(info.lastInsertRowid);
  bus.emit('command:queued', command);
  return command;
}

/** Atomically claim pending commands for an HTTP-polling device. */
function claimPendingCommands(deviceId, limit = 20) {
  const id = String(deviceId || '').trim();
  if (!id) throw new Error('device_id is required');

  const claim = db.transaction(() => {
    const rows = stmts.pendingCommands.all(id, Math.min(Math.max(Number(limit) || 20, 1), 100));
    const ts = now();
    for (const row of rows) {
      stmts.markDelivered.run({ id: row.id, ts });
      row.status = 'delivered';
      row.delivered_at = ts;
    }
    return rows;
  });

  const claimed = claim();
  for (const row of claimed) bus.emit('command:delivered', row);
  if (claimed.length) log('command', 'POLL', `${id} collected ${claimed.length} command(s)`);
  return claimed;
}

function markCommandDelivered(id, transport = 'mqtt') {
  const ts = now();
  const { changes } =
    transport === 'mqtt'
      ? stmts.markMqttDelivered.run({ id, ts })
      : stmts.markDelivered.run({ id, ts });
  if (changes) {
    const command = stmts.getCommand.get(id);
    bus.emit('command:delivered', command);
  }
  return changes;
}

function ackCommand({ id, status = 'acked', error = null } = {}) {
  const allowed = ['acked', 'failed', 'pending', 'delivered'];
  const safe = allowed.includes(status) ? status : 'acked';
  const { changes } = stmts.ackCommand.run({ id, status: safe, ts: now(), error });
  if (!changes) return null;
  const command = stmts.getCommand.get(id);
  log(safe === 'failed' ? 'error' : 'success', 'ACK', `command #${id} → ${safe}${error ? ` (${error})` : ''}`);
  bus.emit('command:acked', command);
  return command;
}

function listCommands({ device_id, limit = 50 } = {}) {
  const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), 500);
  return device_id
    ? stmts.listCommandsForDevice.all(String(device_id), safeLimit)
    : stmts.listCommands.all(safeLimit);
}

/* -------------------------------------------------------------------------- */
/* Automation rules                                                           */
/* -------------------------------------------------------------------------- */

const OPERATORS = ['>', '>=', '<', '<=', '==', '!='];

function listRules() {
  return stmts.listRules.all();
}

function getRule(id) {
  return stmts.getRule.get(Number(id)) || null;
}

function rulesForSensor(sensorName, deviceId) {
  return stmts.rulesForSensor.all(normalizeSensorName(sensorName), String(deviceId));
}

function createRule(input = {}) {
  const ts = now();
  const operator = OPERATORS.includes(input.operator) ? input.operator : '>';
  const action = String(input.action || 'RELAY_OFF').trim().slice(0, 120);
  const threshold = Number(input.threshold);
  if (!action) throw new Error('action is required');
  if (!Number.isFinite(threshold)) throw new Error('threshold must be a number');

  const params = {
    name: String(input.name || `${input.sensor_name} ${operator} ${threshold} → ${action}`).slice(0, 160),
    device_id: String(input.device_id || '*').trim() || '*',
    sensor_name: normalizeSensorName(input.sensor_name),
    operator,
    threshold,
    action,
    action_payload:
      input.action_payload === undefined || input.action_payload === null
        ? null
        : typeof input.action_payload === 'string'
          ? input.action_payload.slice(0, 1024)
          : JSON.stringify(input.action_payload).slice(0, 1024),
    enabled: input.enabled === false || input.enabled === 0 ? 0 : 1,
    cooldown_seconds: Math.min(Math.max(Number(input.cooldown_seconds) || 60, 0), 86_400),
    ts,
  };

  const info = stmts.insertRule.run(params);
  const rule = stmts.getRule.get(info.lastInsertRowid);
  log('info', 'RULE', `rule #${rule.id} created: ${rule.name}`);
  bus.emit('rules:changed', listRules());
  return rule;
}

function updateRule(id, input = {}) {
  const ruleId = Number(id);
  const existing = stmts.getRule.get(ruleId);
  if (!existing) return null;

  const params = {
    id: ruleId,
    name: input.name === undefined ? null : String(input.name).slice(0, 160),
    device_id: input.device_id === undefined ? null : String(input.device_id).trim() || '*',
    sensor_name: input.sensor_name === undefined ? null : normalizeSensorName(input.sensor_name),
    operator: input.operator === undefined || !OPERATORS.includes(input.operator) ? null : input.operator,
    threshold: input.threshold === undefined || !Number.isFinite(Number(input.threshold)) ? null : Number(input.threshold),
    action: input.action === undefined ? null : String(input.action).trim().slice(0, 120),
    action_payload:
      input.action_payload === undefined
        ? null
        : input.action_payload === null
          ? null
          : typeof input.action_payload === 'string'
            ? input.action_payload.slice(0, 1024)
            : JSON.stringify(input.action_payload).slice(0, 1024),
    enabled: input.enabled === undefined ? null : input.enabled === false || input.enabled === 0 ? 0 : 1,
    cooldown_seconds:
      input.cooldown_seconds === undefined ? null : Math.min(Math.max(Number(input.cooldown_seconds) || 0, 0), 86_400),
    ts: now(),
  };

  stmts.updateRule.run(params);
  const rule = stmts.getRule.get(ruleId);
  log('info', 'RULE', `rule #${ruleId} updated (enabled=${rule.enabled})`);
  bus.emit('rules:changed', listRules());
  return rule;
}

function deleteRule(id) {
  const { changes } = stmts.deleteRule.run(Number(id));
  if (changes) {
    log('warn', 'RULE', `rule #${id} deleted`);
    bus.emit('rules:changed', listRules());
  }
  return changes > 0;
}

function markRuleTriggered(rule) {
  const ts = now();
  stmts.markRuleTriggered.run({ id: rule.id, ts });
  rule.last_triggered = ts;
  rule.trigger_count = (rule.trigger_count || 0) + 1;
  return ts;
}

function recordRuleEvent(event) {
  const info = stmts.insertRuleEvent.run({
    rule_id: event.rule_id ?? null,
    rule_name: event.rule_name ?? null,
    device_id: event.device_id ?? null,
    sensor_name: event.sensor_name ?? null,
    value: event.value ?? null,
    operator: event.operator ?? null,
    threshold: event.threshold ?? null,
    action: event.action ?? null,
    payload: event.payload ? String(event.payload).slice(0, 1024) : null,
    created_at: now(),
  });
  return info.lastInsertRowid;
}

function listRuleEvents(limit = 25) {
  return stmts.listRuleEvents.all(Math.min(Math.max(Number(limit) || 25, 1), 200));
}

/* -------------------------------------------------------------------------- */
/* Stats + maintenance                                                        */
/* -------------------------------------------------------------------------- */

function stats() {
  const online = db.prepare(`SELECT COUNT(*) AS c FROM devices WHERE status = 'online'`).get().c;
  const total = stmts.countDevices.get().c;
  const minuteAgo = now() - 60_000;
  return {
    devices: { total, online, offline: total - online },
    telemetry: {
      total: stmts.countTelemetry.get().c,
      last_minute: stmts.countTelemetrySince.get(minuteAgo).c,
    },
    commands: {
      total: stmts.countCommands.get().c,
      pending: stmts.countCommandsByStatus.get('pending').c,
      delivered: stmts.countCommandsByStatus.get('delivered').c,
      acked: stmts.countCommandsByStatus.get('acked').c,
      failed: stmts.countCommandsByStatus.get('failed').c,
    },
    rules: { total: stmts.countRules.get().c, enabled: stmts.countRulesEnabled.get().c },
    uptime_seconds: Math.floor(process.uptime()),
    ts: now(),
  };
}

/** Retention: drop old telemetry / trimmed command + event history. */
function prune() {
  let removed = 0;
  if (config.retention.days > 0) {
    const cutoff = now() - config.retention.days * 86_400_000;
    removed += stmts.pruneTelemetry.run(cutoff).changes;
  }
  if (config.retention.maxRows > 0) {
    removed += stmts.pruneTelemetryOverflow.run({ maxRows: config.retention.maxRows }).changes;
  }
  if (removed > 0) log('info', 'PRUNE', `removed ${removed} telemetry row(s) older than retention window`);
  if (config.retention.maxCommands > 0) {
    stmts.pruneCommands.run({ maxRows: config.retention.maxCommands });
  }
  if (config.retention.maxRuleEvents > 0) {
    stmts.pruneRuleEvents.run({ maxRows: config.retention.maxRuleEvents });
  }
  return removed;
}

/** Checkpoint WAL so the mounted `./data` volume stays compact. */
function checkpoint() {
  try {
    db.pragma('wal_checkpoint(PASSIVE)');
  } catch {
    /* best effort */
  }
}

/* -------------------------------------------------------------------------- */
/* Demo seed                                                                  */
/* -------------------------------------------------------------------------- */

const SENSOR_KITS = [
  [{ sensor_name: 'temperature', unit: '°C', base: 22, spread: 4 }],
  [
    { sensor_name: 'temperature', unit: '°C', base: 24, spread: 5 },
    { sensor_name: 'humidity', unit: '%', base: 48, spread: 12 },
  ],
  [
    { sensor_name: 'temperature', unit: '°C', base: 26, spread: 6 },
    { sensor_name: 'pressure', unit: 'hPa', base: 1013, spread: 6 },
    { sensor_name: 'battery', unit: '%', base: 87, spread: 10 },
  ],
  [{ sensor_name: 'co2', unit: 'ppm', base: 640, spread: 220 }],
  [{ sensor_name: 'current', unit: 'A', base: 4.2, spread: 1.8 }],
];

const LOCATIONS = ['Plant A', 'Plant B', 'Warehouse', 'Server Room', 'Greenhouse', 'Cold Storage', 'Roof Deck'];

/** Deterministic demo MAC (A4:CF:12 is a real Espressif OUI prefix). */
function seedMac(index) {
  const hex = (value, width = 2) => (value & 0xff).toString(16).toUpperCase().padStart(width, '0');
  return `A4:CF:12:${hex(index >> 16)}:${hex(index >> 8)}:${hex(index)}`;
}

/**
 * Register `count` demo devices (used on first boot so a fresh install has a
 * populated grid). Idempotent: existing device ids are left untouched.
 */
function seedDevices(count = config.seed.deviceCount) {
  const target = Math.max(0, Number(count) || 0);
  if (target === 0) return 0;

  const insert = db.transaction((n) => {
    let created = 0;
    for (let i = 1; i <= n; i += 1) {
      const id = `ESP32-${String(i).padStart(4, '0')}`;
      if (stmts.getDevice.get(id)) continue;
      stmts.insertDevice.run({
        device_id: id,
        name: `Sensor Node ${i}`,
        ip: `10.${(Math.floor((i - 1) / 254) % 99) + 1}.${((i - 1) % 254) + 1}.10`,
        mac: seedMac(i),
        location: LOCATIONS[(i - 1) % LOCATIONS.length],
        firmware: `v1.${(i - 1) % 5}.${i % 9}`,
        last_payload: null,
        ts: now(),
      });
      // Newly seeded devices start offline until they report in.
      db.prepare(`UPDATE devices SET status = 'offline', last_seen = NULL WHERE device_id = ?`).run(id);
      created += 1;
    }
    return created;
  });

  const created = insert(target);
  if (created > 0) {
    log('info', 'SEED', `registered ${created} demo device(s) (SEED_DEVICE_COUNT=${target})`);
    bus.emit('rules:changed', listRules());
  }
  return created;
}

/** Sensor profile for a seeded device id, used by scripts/simulator.js. */
function sensorKitFor(deviceId) {
  const digits = String(deviceId).replace(/\D+/g, '') || '1';
  const index = (Number.parseInt(digits, 10) - 1) % SENSOR_KITS.length;
  return SENSOR_KITS[Number.isFinite(index) && index >= 0 ? index : 0];
}

/** Create the default automation rules on an empty rules table. */
function seedDefaultRules() {
  if (stmts.countRules.get().c > 0) return 0;
  const defaults = [
    { name: 'Cool down when hot', sensor_name: 'temperature', operator: '>', threshold: 30, action: 'RELAY_OFF', cooldown_seconds: 60 },
    { name: 'Heat when cold', sensor_name: 'temperature', operator: '<', threshold: 16, action: 'RELAY_ON', cooldown_seconds: 120 },
    { name: 'Ventilate on CO2 spike', sensor_name: 'co2', operator: '>', threshold: 1000, action: 'FAN_ON', cooldown_seconds: 90 },
    { name: 'Low battery warning', sensor_name: 'battery', operator: '<', threshold: 20, action: 'SEND_ALERT', action_payload: 'battery_low', cooldown_seconds: 600 },
  ];
  for (const rule of defaults) createRule(rule);
  return defaults.length;
}

module.exports = {
  init,
  close,
  checkpoint,
  normalizeSensorName,
  upsertDevice,
  getDevice,
  setStatus,
  listDevices,
  sweepOffline,
  recordTelemetry,
  getHistory,
  getLatest,
  getSensors,
  recentTelemetry,
  getRecentSeries,
  queueCommand,
  claimPendingCommands,
  markCommandDelivered,
  ackCommand,
  listCommands,
  listRules,
  getRule,
  rulesForSensor,
  createRule,
  updateRule,
  deleteRule,
  markRuleTriggered,
  recordRuleEvent,
  listRuleEvents,
  stats,
  prune,
  seedDevices,
  seedDefaultRules,
  sensorKitFor,
  SENSOR_KITS,
  OPERATORS,
};
