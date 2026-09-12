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
 */

const express = require('express');

const config = require('../config');
const db = require('../db');
const mqtt = require('../mqtt');
const ingest = require('../ingest');
const automation = require('../automation');
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
  res.json({ ok: true, data: { ...db.stats(), ingest: ingest.getStatus(), mqtt: mqtt.getStatus() } });
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
      log('info', 'HOOK', `⇐ ${ingest.summarize(reading)}`);
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

  log('command', 'HOOK', `⇒ command queued for ${id.value} :: ${queued.payload}`);

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
