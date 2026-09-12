'use strict';

/**
 * Ingest pipeline — the single funnel for every reading that reaches the
 * server, regardless of transport (HTTP webhook or MQTT).
 *
 * Accepts the loose payload shapes real hardware sends and normalizes them:
 *
 *   { device_id, sensor_name, value, unit }
 *   { device_id, sensors: { temperature: 24.1, humidity: 51 } }
 *   { device_id, metrics: [...] }
 *   { device_id, readings: [{ sensor_name, value }] }
 */

const db = require('./db');
const config = require('./config');
const { bus, log } = require('./events');

/** Only these keys may rename the device id. */
const DEVICE_KEYS = ['device_id', 'deviceId', 'device', 'id', 'node', 'client_id'];
const SENSOR_KEYS = ['sensor_name', 'sensorName', 'sensor', 'metric', 'key', 'name'];
const VALUE_KEYS = ['value', 'reading', 'val', 'data'];
const META_KEYS = ['ip', 'mac', 'name', 'location', 'firmware', 'unit', 'ts', 'timestamp', 'created_at'];

function firstKey(obj, keys) {
  for (const key of keys) {
    if (obj[key] !== undefined && obj[key] !== null && obj[key] !== '') return obj[key];
  }
  return undefined;
}

function pickMeta(source = {}) {
  const meta = {};
  for (const key of META_KEYS) if (source[key] !== undefined) meta[key] = source[key];
  return meta;
}

/**
 * Flatten any accepted payload into a list of `{ sensor_name, value, unit }`.
 * @param {object} body
 * @returns {Array<{sensor_name: string, value: unknown, unit: string|undefined}>}
 */
function normalizePayload(body = {}) {
  const out = [];

  // 1) sensors / metrics / state maps: { temperature: 24, humidity: 51 }
  for (const key of ['sensors', 'metrics', 'state', 'values']) {
    const map = body[key];
    if (map && typeof map === 'object') {
      if (Array.isArray(map)) {
        for (const entry of map) {
          if (!entry || typeof entry !== 'object') continue;
          const name = firstKey(entry, SENSOR_KEYS);
          if (name === undefined) continue;
          out.push({ sensor_name: String(name), value: firstKey(entry, VALUE_KEYS), unit: entry.unit });
        }
      } else {
        for (const [name, value] of Object.entries(map)) {
          const isObj = value && typeof value === 'object' && !Array.isArray(value);
          out.push({
            sensor_name: name,
            value: isObj ? firstKey(value, VALUE_KEYS) : value,
            unit: isObj ? value.unit : undefined,
          });
        }
      }
    }
  }

  // 2) explicit arrays: readings / data
  for (const key of ['readings', 'data']) {
    const list = body[key];
    if (!Array.isArray(list)) continue;
    for (const entry of list) {
      if (entry === null || typeof entry !== 'object') continue;
      const name = firstKey(entry, SENSOR_KEYS);
      if (name === undefined) continue;
      out.push({ sensor_name: String(name), value: firstKey(entry, VALUE_KEYS), unit: entry.unit });
    }
  }

  // 3) flat single reading
  const flatName = firstKey(body, SENSOR_KEYS);
  const flatValue = firstKey(body, VALUE_KEYS);
  if (flatName !== undefined && flatValue !== undefined) {
    out.push({ sensor_name: String(flatName), value: flatValue, unit: body.unit });
  } else if (flatValue !== undefined && typeof flatValue !== 'object') {
    // Bare numeric body, e.g. POST /api/webhook/data?device_id=x&sensor_name=y with body 42
    out.push({ sensor_name: String(body.sensor_name || body.sensor || 'value'), value: flatValue, unit: body.unit });
  } else if (flatValue !== undefined && typeof flatValue === 'object') {
    const inner = normalizePayload(flatValue);
    out.push(...inner);
  }

  // Callers may already have a single { sensor_name, value } from the MQTT topic.
  return out.filter((r) => r.sensor_name && r.sensor_name !== 'undefined');
}

/** Live counters surfaced in the dashboard header. */
const counters = {
  http: 0,
  mqtt: 0,
  rejected: 0,
  startedAt: Date.now(),
};

/**
 * Persist a reading and notify the rest of the system.
 *
 * @param {object} input raw payload (any accepted shape)
 * @param {{ source?: 'http'|'mqtt', device_id?: string, sensor_name?: string, value?: unknown, unit?: string, ip?: string }} [options]
 */
function ingestReading(input = {}, options = {}) {
  const source = options.source === 'mqtt' ? 'mqtt' : 'http';

  const deviceId = String(
    options.device_id ?? firstKey(input, DEVICE_KEYS) ?? input.topic_device_id ?? '',
  ).trim();

  if (!deviceId) {
    counters.rejected += 1;
    return { ok: false, error: 'device_id is required', stored: 0, readings: [] };
  }

  // A single explicit reading passed straight through (MQTT handler path).
  const readings =
    options.sensor_name !== undefined
      ? [{ sensor_name: options.sensor_name, value: options.value, unit: options.unit }]
      : normalizePayload(input);

  if (readings.length === 0) {
    counters.rejected += 1;
    return { ok: false, error: 'no sensor readings found in payload', stored: 0, readings: [], device_id: deviceId };
  }

  const meta = { ...pickMeta(input), ...pickMeta(options) };
  const created = Number(meta.ts ?? meta.timestamp ?? meta.created_at);

  let stored = 0;
  let rawStored = 0;
  let device = null;
  const accepted = []; // numeric readings only: charts, automation, sockets
  const persisted = [];

  for (const reading of readings) {
    if (reading.value === undefined || reading.value === null || reading.value === '') continue;
    const result = db.recordTelemetry({
      device_id: deviceId,
      sensor_name: reading.sensor_name,
      value: reading.value,
      unit: reading.unit ?? meta.unit,
      ip: meta.ip,
      mac: meta.mac,
      name: meta.name,
      location: meta.location,
      firmware: meta.firmware,
      created_at: created,
    });
    if (result.device) device = result.device;
    if (!result.inserted || !result.telemetry) continue;

    persisted.push(result.telemetry);
    if (result.telemetry.value === null) {
      // Non-numeric (e.g. "OPEN"/"n/a"): kept as an audit row, but it cannot
      // drive a chart or a rule.
      rawStored += 1;
    } else {
      stored += 1;
      accepted.push(result.telemetry);
    }
  }

  if (source === 'mqtt') counters.mqtt += stored;
  else counters.http += stored;

  // Fan out to Socket.io + the automation engine. `source` rides along on the
  // socket copy only (it is not a column) so the device inspector can label a
  // line HOOK or MQTT accurately.
  for (const reading of accepted) bus.emit('telemetry', { ...reading, source });

  // Hand the whole batch to the upstream forwarder (async, fire-and-forget).
  if (persisted.length) {
    bus.emit('ingest:batch', {
      device_id: deviceId,
      source,
      payload: input,
      readings: persisted,
      device,
      received_at: Date.now(),
    });
  }

  const ok = stored + rawStored > 0;
  return {
    ok,
    device_id: deviceId,
    device,
    stored,
    raw_stored: rawStored,
    readings: persisted,
    error: ok ? undefined : 'no usable readings in payload',
  };
}

/** Down-sampled terminal line rate so 200+ nodes don't drown the UI. */
const LOG_THROTTLE_MS = 15000;
const lastLogged = new Map();

function shouldLogDevice(deviceId, message) {
  const key = `${deviceId}:${message}`;
  const seen = lastLogged.get(key);
  const ts = Date.now();
  if (seen && ts - seen < LOG_THROTTLE_MS) return false;
  lastLogged.set(key, ts);
  // Bound the map so long-running deployments don't leak.
  if (lastLogged.size > 5000) {
    for (const [k, v] of lastLogged) {
      if (ts - v > LOG_THROTTLE_MS * 4) lastLogged.delete(k);
    }
  }
  return true;
}

/** Human-readable one-liner for the terminal, throttled per device. */
function summarize(reading) {
  const value = reading.value === null ? reading.raw_value : reading.value;
  const suffix = reading.unit ? ` ${reading.unit}` : '';
  return `${reading.device_id} · ${reading.sensor_name}=${value}${suffix}`;
}

/**
 * Log metadata for a reading. The dashboard's per-device console filters on
 * `meta.device_id`, so every telemetry log line carries it.
 */
function logMeta(reading) {
  return {
    device_id: reading.device_id,
    sensor_name: reading.sensor_name,
    value: reading.value === null ? reading.raw_value : reading.value,
    unit: reading.unit || null,
  };
}

module.exports = {
  ingestReading,
  normalizePayload,
  shouldLogDevice,
  summarize,
  logMeta,
  counters,
  LOG_THROTTLE_MS,
  getStatus: () => ({
    ...counters,
    uptime_seconds: Math.floor(process.uptime()),
    offline_after_seconds: config.device.offlineAfterSeconds,
  }),
};
