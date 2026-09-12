'use strict';

/**
 * REST API + webhook surface.
 *
 * Public webhooks (device -> server):
 *   POST /api/webhook/data              ingest telemetry
 *   POST /api/webhook/command           queue a command for a device
 *   GET  /api/webhook/command/poll      HTTP polling devices collect commands
 *   POST /api/webhook/command/ack       device acknowledges a command
 *
 * Dashboard API (browser -> server):
 *   GET  /api/health | /api/stats | /api/mqtt/status
 *   GET  /api/devices | /api/devices/:id | /api/devices/:id/telemetry
 *   GET  /api/telemetry/recent | /api/commands | /api/rule-events
 *   POST /api/commands
 *   GET|POST /api/rules  ·  PATCH|DELETE /api/rules/:id
 *
 * Device configuration (ESP/Arduino reads its own config at boot):
 *   GET  /api/device/:id/config        full config (+ defaults)
 *   POST /api/device/:id/config        save config from the dashboard
 *   (also available as /api/devices/:id/config)
 *
 * Upstream forwarding to MAIN_WEBSITE_WEBHOOK_URL:
 *   GET   /api/settings                effective + stored settings, runtime state
 *   PATCH /api/settings                set URL / enabled flag from the dashboard
 *   DELETE/api/settings/:key           clear a setting (revert to .env)
 *   GET   /api/forward-logs            delivery audit trail from SQLite
 *   POST  /api/forward/test            send a test document upstream now
 */

const express = require('express');

const config = require('../config');
const db = require('../db');
const mqtt = require('../mqtt');
const ingest = require('../ingest');
const automation = require('../automation');
const forwarder = require('../forwarder');
const { log } = require('../events');

const router = express.Router();

const DEVICE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/;

function sanitizeDeviceId(raw) {
  const value = String(raw ?? '').trim();
  if (!value) return { error: 'device_id is required' };
  if (!DEVICE_ID_RE.test(value)) {
    return { error: 'device_id must be 1-64 chars of A-Z a-z 0-9 _ . : -' };
  }
  return { value };
}

function fail(res, status, error, extra) {
  return res.status(status).json({ ok: false, error, ...(extra || {}) });
}

/**
 * Accept JSON, form-encoded and bare text/plain bodies (many ESP8266 sketches
 * can only afford to POST a single plain string).
 * @returns {{ body: object, raw: string|undefined }}
 */
function readBody(req) {
  const body = req.body;
  if (body && typeof body === 'object' && !Array.isArray(body)) return { body, raw: undefined };
  if (typeof body === 'string') {
    const text = body.trim();
    if (text.startsWith('{') || text.startsWith('[')) {
      try {
        const parsed = JSON.parse(text);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return { body: parsed, raw: text };
        if (Array.isArray(parsed)) return { body: { readings: parsed }, raw: text };
      } catch {
        /* fall through to raw */
      }
    }
    return { body: {}, raw: text };
  }
  return { body: {}, raw: undefined };
}

function intParam(value, fallback, { min = 1, max = 1000 } = {}) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}

/* -------------------------------------------------------------------------- */
/* Health + stats                                                             */
/* -------------------------------------------------------------------------- */

router.get('/health', (req, res) => {
  const mqttStatus = mqtt.getStatus();
  res.json({
    ok: true,
    service: 'iot-dashboard',
    version: require('../../package.json').version,
    env: config.env,
    uptime_seconds: Math.floor(process.uptime()),
    db: config.db.path,
    mqtt: mqttStatus,
    ingest: ingest.getStatus(),
    automation: automation.getStats(),
    ts: Date.now(),
  });
});

router.get('/stats', (req, res) => {
  res.json({
    ok: true,
    data: {
      ...db.stats(),
      ingest: ingest.getStatus(),
      mqtt: mqtt.getStatus(),
      forward: forwarder.getStatus(),
    },
  });
});

router.get('/mqtt/status', (req, res) => {
  res.json({ ok: true, data: mqtt.getStatus() });
});

/* -------------------------------------------------------------------------- */
/* Devices                                                                    */
/* -------------------------------------------------------------------------- */

router.get('/devices', (req, res) => {
  const { search, limit, offset, sparkline } = req.query;
  // `sparkline=true` adds the last N samples per sensor (device-card mini-graph).
  // Off by default: it costs ~45 ms and ~380 KB for a 1000-device fleet, and the
  // dashboard gets it once per connect through the Socket.io bootstrap instead.
  const withSparkline = sparkline === 'true' || sparkline === '1';
  const data = db.listDevices({
    search: search ? String(search).slice(0, 64) : '',
    limit: intParam(limit, 500, { min: 1, max: 2000 }),
    offset: intParam(offset, 0, { min: 0, max: 1_000_000 }),
    sparkline: withSparkline,
    sparklinePoints: intParam(req.query.sparkline_points, 10, { min: 2, max: 60 }),
  });
  res.json({ ok: true, count: data.devices.length, total: data.total, ...data });
});

router.get('/devices/:deviceId', (req, res) => {
  const id = sanitizeDeviceId(req.params.deviceId);
  if (id.error) return fail(res, 400, id.error);

  const device = db.getDevice(id.value);
  if (!device) return fail(res, 404, `unknown device: ${id.value}`);

  return res.json({
    ok: true,
    data: {
      ...device,
      metrics: db.getLatest(id.value),
      sensors: db.getSensors(id.value),
      commands: db.listCommands({ device_id: id.value, limit: 20 }),
      config: db.getDeviceConfig(id.value),
      forward_logs: db.listForwardLogs({ device_id: id.value, limit: 10 }),
    },
  });
});

router.get('/devices/:deviceId/telemetry', (req, res) => {
  const id = sanitizeDeviceId(req.params.deviceId);
  if (id.error) return fail(res, 400, id.error);

  const sensorName = req.query.sensor_name || req.query.sensor;
  if (!sensorName) return fail(res, 400, 'sensor_name query parameter is required');

  const points = db.getHistory({
    device_id: id.value,
    sensor_name: String(sensorName),
    limit: intParam(req.query.limit, 200, { min: 2, max: config.telemetryHistoryLimit }),
    sinceMs: intParam(req.query.since_ms, 3_600_000, { min: 1000, max: 30 * 86_400_000 }),
  });

  return res.json({
    ok: true,
    device_id: id.value,
    sensor_name: db.normalizeSensorName(sensorName),
    count: points.length,
    points,
  });
});

router.get('/telemetry/recent', (req, res) => {
  const rows = db.recentTelemetry(intParam(req.query.limit, 50, { min: 1, max: 500 }));
  res.json({ ok: true, count: rows.length, data: rows });
});

/* -------------------------------------------------------------------------- */
/* Commands                                                                   */
/* -------------------------------------------------------------------------- */

router.get('/commands', (req, res) => {
  const deviceId = req.query.device_id ? sanitizeDeviceId(req.query.device_id) : null;
  if (deviceId && deviceId.error) return fail(res, 400, deviceId.error);
  const rows = db.listCommands({
    device_id: deviceId ? deviceId.value : undefined,
    limit: intParam(req.query.limit, 50, { min: 1, max: 500 }),
  });
  return res.json({ ok: true, count: rows.length, data: rows });
});

router.post('/commands', (req, res) => {
  const { body, raw } = readBody(req);
  const id = sanitizeDeviceId(body.device_id ?? req.query.device_id);
  if (id.error) return fail(res, 400, id.error);

  const payload = body.payload ?? body.command ?? body.text ?? raw;
  if (payload === undefined || payload === null || payload === '') {
    return fail(res, 400, 'payload (or command) is required');
  }

  const command = db.queueCommand({
    device_id: id.value,
    payload: typeof payload === 'string' ? payload : JSON.stringify(payload),
    source: String(body.source || 'ui').slice(0, 32),
    transport: mqtt.isConnected() ? 'mqtt' : 'queue',
    mqtt_topic: mqtt.commandTopic(id.value),
  });

  return res.status(202).json({ ok: true, data: command });
});

/* -------------------------------------------------------------------------- */
/* Webhooks                                                                   */
/* -------------------------------------------------------------------------- */

/** POST /api/webhook/data — { device_id, sensor_name, value, unit? } */
router.post('/webhook/data', (req, res) => {
  const { body, raw } = readBody(req);
  const rawId = body.device_id ?? body.deviceId ?? req.query.device_id;

  const id = sanitizeDeviceId(rawId);
  if (id.error) return fail(res, 400, id.error);

  const sensorFromQuery = req.query.sensor_name || req.query.sensor;
  // Bare text body (e.g. `POST /api/webhook/data?device_id=X&sensor_name=temp` with "24.5")
  const bareText = raw !== undefined && Object.keys(body).length === 0;
  const input = bareText ? { value: raw } : body;

  const result = ingest.ingestReading(input, {
    source: 'http',
    device_id: id.value,
    sensor_name: sensorFromQuery ? String(sensorFromQuery) : undefined,
    value: bareText ? raw : undefined,
    unit: req.query.unit ? String(req.query.unit) : undefined,
    // Only an explicitly reported IP is trusted; the HTTP source address may
    // be a proxy/NAT address and would overwrite good data.
    ip: body.ip || req.query.ip,
  });

  if (!result.ok) {
    return fail(res, 422, result.error || 'reading rejected', { device_id: id.value });
  }

  for (const reading of result.readings) {
    if (ingest.shouldLogDevice(reading.device_id, reading.sensor_name)) {
      log('info', 'HOOK', `⇐ ${ingest.summarize(reading)}`, ingest.logMeta(reading));
    }
  }

  return res.status(201).json({
    ok: true,
    device_id: id.value,
    stored: result.stored,
    raw_stored: result.raw_stored || 0,
    readings: result.readings,
  });
});

/** POST /api/webhook/command — { device_id, command|payload } */
router.post('/webhook/command', (req, res) => {
  const { body, raw } = readBody(req);
  const id = sanitizeDeviceId(body.device_id ?? body.deviceId ?? req.query.device_id);
  if (id.error) return fail(res, 400, id.error);

  const payload = body.command ?? body.payload ?? body.text ?? raw;
  if (payload === undefined || payload === null || payload === '') {
    return fail(res, 400, 'command (or payload) is required');
  }

  const queued = db.queueCommand({
    device_id: id.value,
    payload: typeof payload === 'string' ? payload : JSON.stringify(payload),
    source: String(body.source || 'webhook').slice(0, 32),
    transport: mqtt.isConnected() ? 'mqtt' : 'queue',
    mqtt_topic: mqtt.commandTopic(id.value),
  });

  log('command', 'HOOK', `⇒ command queued for ${id.value} :: ${queued.payload}`, {
    device_id: id.value,
    command_id: queued.id,
  });

  return res.status(202).json({
    ok: true,
    published: mqtt.isConnected(),
    data: queued,
  });
});

/** GET /api/webhook/command/poll?device_id=ESP32-0001 */
router.get('/webhook/command/poll', (req, res) => {
  const id = sanitizeDeviceId(req.query.device_id);
  if (id.error) return fail(res, 400, id.error);

  // Polling itself is proof of life.
  db.upsertDevice({ device_id: id.value });
  db.setStatus(id.value, 'online');

  const commands = db.claimPendingCommands(id.value, intParam(req.query.limit, 20, { min: 1, max: 100 }));
  return res.json({
    ok: true,
    device_id: id.value,
    count: commands.length,
    commands: commands.map((c) => ({ id: c.id, payload: c.payload, created_at: c.created_at })),
  });
});

/** POST /api/webhook/command/ack — { command_id, status, error? } */
router.post('/webhook/command/ack', (req, res) => {
  const { body } = readBody(req);
  const commandId = Number(body.command_id ?? body.id ?? req.query.command_id);
  if (!Number.isFinite(commandId)) return fail(res, 400, 'command_id is required');

  const command = db.ackCommand({
    id: commandId,
    status: body.status === 'failed' ? 'failed' : 'acked',
    error: body.error ? String(body.error).slice(0, 256) : null,
  });
  if (!command) return fail(res, 404, `unknown command: ${commandId}`);

  return res.json({ ok: true, data: command });
});

/* -------------------------------------------------------------------------- */
/* Device custom configuration (ESP / Arduino)                                 */
/* -------------------------------------------------------------------------- */

/**
 * GET /api/device/:deviceId/config
 *
 * What a microcontroller calls during setup(). Always returns a complete
 * document: `DEFAULT_DEVICE_CONFIG` merged with whatever the dashboard saved.
 */
function getDeviceConfigHandler(req, res) {
  const id = sanitizeDeviceId(req.params.deviceId);
  if (id.error) return fail(res, 400, id.error);

  const data = db.getDeviceConfig(id.value);
  // Devices must always see the current revision, never a cached one.
  res.set('Cache-Control', 'no-store');
  return res.json({ ok: true, ...data, defaults: db.DEFAULT_DEVICE_CONFIG });
}

/**
 * POST /api/device/:deviceId/config
 *
 * Body: `{ config: {...}, sync?: boolean, merge?: boolean }`
 * A flat body (`{ sample_rate_ms: 1000 }`) is accepted too — everything except
 * `sync`/`merge`/`updated_by` is then treated as the configuration itself.
 */
function postDeviceConfigHandler(req, res) {
  const id = sanitizeDeviceId(req.params.deviceId);
  if (id.error) return fail(res, 400, id.error);

  const { body } = readBody(req);
  const reserved = new Set(['config', 'sync', 'merge', 'updated_by', 'device_id']);

  let next = body.config;
  if (!next || typeof next !== 'object' || Array.isArray(next)) {
    next = {};
    for (const [key, value] of Object.entries(body)) {
      if (!reserved.has(key)) next[key] = value;
    }
  }
  if (!Object.keys(next).length) return fail(res, 400, 'config must be a non-empty JSON object');

  let saved;
  try {
    saved = db.saveDeviceConfig(id.value, next, {
      updatedBy: body.updated_by || 'dashboard',
      merge: Boolean(body.merge),
    });
  } catch (error) {
    return fail(res, 400, error.message);
  }

  // "Save & Sync to ESP" — optionally push the new revision to the device so it
  // re-reads its configuration without waiting for a reboot.
  let command = null;
  if (body.sync) {
    command = db.queueCommand({
      device_id: id.value,
      payload: JSON.stringify({
        action: 'CONFIG_SYNC',
        revision: saved.revision,
        config: saved.config,
        issued_at: Date.now(),
      }),
      source: 'config',
      transport: 'queue',
      mqtt_topic: mqtt.commandTopic(id.value),
    });
    log('command', 'CONFIG', `CONFIG_SYNC queued for ${id.value} (revision ${saved.revision})`, {
      device_id: id.value,
      command_id: command.id,
    });
  }

  // A device that has never checked in is still worth registering.
  db.upsertDevice({ device_id: id.value });

  return res.json({ ok: true, data: saved, command });
}

router.get('/device/:deviceId/config', getDeviceConfigHandler);
router.post('/device/:deviceId/config', postDeviceConfigHandler);
// Plural aliases, consistent with the rest of the /api/devices surface.
router.get('/devices/:deviceId/config', getDeviceConfigHandler);
router.post('/devices/:deviceId/config', postDeviceConfigHandler);

router.delete('/device/:deviceId/config', (req, res) => {
  const id = sanitizeDeviceId(req.params.deviceId);
  if (id.error) return fail(res, 400, id.error);
  const removed = db.deleteDeviceConfig(id.value);
  if (!removed) return fail(res, 404, `no saved config for ${id.value}`);
  return res.json({ ok: true });
});

/* -------------------------------------------------------------------------- */
/* System settings + upstream forwarding                                      */
/* -------------------------------------------------------------------------- */

router.get('/settings', (req, res) => {
  const target = forwarder.resolveTarget();
  res.json({
    ok: true,
    data: {
      settings: db.allSettings(),
      effective: {
        url: target.url,
        enabled: target.enabled,
        source: target.source,
        configured: target.configured,
        valid: target.valid,
        active: target.active,
      },
      env: { url: config.forward.url, enabled: config.forward.enabled },
      runtime: forwarder.getStatus(),
      stats_24h: db.forwardStats({ sinceMs: 24 * 60 * 60 * 1000 }),
      keys: db.SETTING_KEYS,
    },
  });
});

function updateSettingsHandler(req, res) {
  const { body } = readBody(req);
  const changed = [];

  if (body.MAIN_WEBSITE_WEBHOOK_URL !== undefined) {
    const url = String(body.MAIN_WEBSITE_WEBHOOK_URL || '').trim();
    if (url && !/^https?:\/\//i.test(url)) {
      return fail(res, 400, 'MAIN_WEBSITE_WEBHOOK_URL must start with http:// or https://');
    }
    db.setSetting('MAIN_WEBSITE_WEBHOOK_URL', url || null);
    changed.push('MAIN_WEBSITE_WEBHOOK_URL');
  }

  if (body.MAIN_WEBSITE_FORWARD_ENABLED !== undefined) {
    const enabled = body.MAIN_WEBSITE_FORWARD_ENABLED === true || String(body.MAIN_WEBSITE_FORWARD_ENABLED) === 'true';
    db.setSetting('MAIN_WEBSITE_FORWARD_ENABLED', String(enabled));
    changed.push('MAIN_WEBSITE_FORWARD_ENABLED');
  }

  if (!changed.length) return fail(res, 400, 'nothing to update');

  const target = forwarder.resolveTarget();
  log('info', 'SET', `system settings updated (${changed.join(', ')}) — forwarding ${target.enabled ? 'enabled' : 'disabled'}${target.url ? ` → ${target.url}` : ''}`);

  return res.json({ ok: true, changed, effective: target, runtime: forwarder.getStatus() });
}

router.patch('/settings', updateSettingsHandler);
router.post('/settings', updateSettingsHandler);

router.delete('/settings/:key', (req, res) => {
  const removed = db.deleteSetting(req.params.key);
  if (!removed) return fail(res, 404, `unknown setting: ${req.params.key}`);
  log('warn', 'SET', `setting ${req.params.key} cleared — falling back to .env`);
  return res.json({ ok: true, effective: forwarder.resolveTarget() });
});

router.get('/forward-logs', (req, res) => {
  const deviceId = req.query.device_id ? sanitizeDeviceId(req.query.device_id) : null;
  if (deviceId && deviceId.error) return fail(res, 400, deviceId.error);
  const rows = db.listForwardLogs({
    device_id: deviceId ? deviceId.value : undefined,
    limit: intParam(req.query.limit, 50, { min: 1, max: 500 }),
  });
  return res.json({
    ok: true,
    count: rows.length,
    data: rows,
    stats: db.forwardStats({ sinceMs: intParam(req.query.since_ms, 24 * 60 * 60 * 1000, { min: 1000, max: 30 * 86_400_000 }) }),
    runtime: forwarder.getStatus(),
  });
});

router.post('/forward/test', async (req, res) => {
  const { body } = readBody(req);
  const result = await forwarder.sendTest(body.payload || null);
  return res.status(result.ok ? 200 : 502).json({ ok: result.ok, ...result });
});

/* -------------------------------------------------------------------------- */
/* Automation rules                                                           */
/* -------------------------------------------------------------------------- */

router.get('/rules', (req, res) => {
  res.json({
    ok: true,
    data: db.listRules(),
    operators: db.OPERATORS,
    events: db.listRuleEvents(10),
  });
});

router.post('/rules', (req, res) => {
  try {
    const rule = db.createRule(req.body || {});
    return res.status(201).json({ ok: true, data: rule });
  } catch (error) {
    return fail(res, 400, error.message);
  }
});

router.patch('/rules/:id', (req, res) => {
  const rule = db.updateRule(req.params.id, req.body || {});
  if (!rule) return fail(res, 404, `unknown rule: ${req.params.id}`);
  return res.json({ ok: true, data: rule });
});

router.post('/rules/:id/toggle', (req, res) => {
  const existing = db.getRule(req.params.id);
  if (!existing) return fail(res, 404, `unknown rule: ${req.params.id}`);
  const next = req.body && req.body.enabled !== undefined ? req.body.enabled : !existing.enabled;
  const rule = db.updateRule(existing.id, { enabled: next });
  return res.json({ ok: true, data: rule });
});

router.delete('/rules/:id', (req, res) => {
  const removed = db.deleteRule(req.params.id);
  if (!removed) return fail(res, 404, `unknown rule: ${req.params.id}`);
  return res.json({ ok: true });
});

router.get('/rule-events', (req, res) => {
  const rows = db.listRuleEvents(intParam(req.query.limit, 25, { min: 1, max: 200 }));
  res.json({ ok: true, count: rows.length, data: rows });
});

module.exports = router;
