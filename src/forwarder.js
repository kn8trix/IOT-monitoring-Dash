'use strict';

/**
 * Upstream forwarding.
 *
 * Every telemetry batch the server accepts — whether it arrived over MQTT or
 * through `POST /api/webhook/data` — is mirrored to `MAIN_WEBSITE_WEBHOOK_URL`
 * so the main website keeps its own copy of the fleet data.
 *
 * Design notes
 *   - Fully asynchronous: ingest never waits for the upstream site. Jobs land on
 *     an in-memory queue drained by a small worker pool.
 *   - Bounded: the queue is capped (`FORWARD_MAX_QUEUE`); beyond that the oldest
 *     jobs are dropped and counted instead of exhausting memory.
 *   - Observable: every attempt is written to `forward_logs` (status, HTTP code,
 *     duration, attempt number, error) and streamed to the dashboard.
 *   - Configurable at runtime: the URL / enabled flag from the `settings` table
 *     (set in the dashboard) take precedence over `.env`.
 */

const config = require('./config');
const db = require('./db');
const { bus, log } = require('./events');

const state = {
  queue: [],
  active: 0,
  enqueued: 0,
  delivered: 0,
  failed: 0,
  dropped: 0,
  skipped: 0,
  lastSuccessAt: null,
  lastError: null,
  lastErrorAt: null,
  running: false,
};

let listener = null;

/* -------------------------------------------------------------------------- */
/* Target resolution                                                          */
/* -------------------------------------------------------------------------- */

/** Effective target: dashboard setting first, then .env, else disabled. */
function resolveTarget() {
  const dbUrl = (db.getSetting('MAIN_WEBSITE_WEBHOOK_URL', '') || '').trim();
  const dbEnabled = db.getSetting('MAIN_WEBSITE_FORWARD_ENABLED', '');
  const url = dbUrl || config.forward.url || '';
  const enabled = dbEnabled === '' || dbEnabled === null ? config.forward.enabled : String(dbEnabled) === 'true';

  const valid = /^https?:\/\//i.test(url);
  return {
    url,
    enabled,
    source: dbUrl ? 'database' : config.forward.url ? 'env' : 'unset',
    valid,
    configured: Boolean(url) && valid,
    // What the worker will actually do right now.
    active: Boolean(url) && valid && enabled,
  };
}

function getStatus() {
  const target = resolveTarget();
  return {
    enabled: target.enabled,
    url: target.url,
    source: target.source,
    configured: Boolean(target.url) && target.valid,
    queue: state.queue.length,
    active: state.active,
    enqueued: state.enqueued,
    delivered: state.delivered,
    failed: state.failed,
    dropped: state.dropped,
    skipped: state.skipped,
    last_success_at: state.lastSuccessAt,
    last_error: state.lastError,
    last_error_at: state.lastErrorAt,
    retries: config.forward.retries,
    timeout_ms: config.forward.timeoutMs,
    concurrency: config.forward.concurrency,
    max_queue: config.forward.maxQueue,
  };
}

/* -------------------------------------------------------------------------- */
/* Payload                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Build the document posted upstream: device metadata + normalised readings +
 * the exact payload the device originally sent.
 */
function buildPayload(batch) {
  const device = batch.device
    ? {
        device_id: batch.device.device_id,
        name: batch.device.name,
        ip: batch.device.ip,
        mac: batch.device.mac,
        location: batch.device.location,
        firmware: batch.device.firmware,
        status: batch.device.status,
      }
    : { device_id: batch.device_id };

  const sensors = {};
  for (const reading of batch.readings || []) sensors[reading.sensor_name] = reading.value;

  let raw = batch.payload;
  try {
    raw = JSON.stringify(raw);
    if (raw && raw.length > config.forward.payloadBytes) raw = `${raw.slice(0, config.forward.payloadBytes)}…[truncated]`;
    raw = raw ? JSON.parse(raw) : null;
  } catch {
    raw = null;
  }

  return {
    source: 'iot-dashboard',
    event: 'telemetry',
    transport: batch.source === 'mqtt' ? 'mqtt' : 'http',
    received_at: batch.received_at || Date.now(),
    device,
    sensors,
    readings: batch.readings || [],
    raw,
  };
}

/* -------------------------------------------------------------------------- */
/* Delivery                                                                   */
/* -------------------------------------------------------------------------- */

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function postOnce(url, payload) {
  const startedAt = Date.now();
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': 'iot-dashboard/1.0',
      'X-IoT-Source': 'iot-dashboard',
      'X-IoT-Device': payload?.device?.device_id || '',
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(config.forward.timeoutMs),
  });
  return { ok: response.ok, status: response.status, durationMs: Date.now() - startedAt };
}

/** Retry on network errors, 429 and 5xx; give up on other 4xx. */
function isRetryable(status) {
  return status === 429 || status >= 500 || status === 408;
}

async function deliver(job) {
  const attempts = config.forward.retries + 1;
  let lastError = null;
  let lastStatus = null;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const result = await postOnce(job.url, job.payload);
      const id = db.recordForwardLog({
        device_id: job.deviceId,
        url: job.url,
        status: result.ok ? 'success' : 'failed',
        http_status: result.status,
        attempt,
        duration_ms: result.durationMs,
        payload: job.serialized,
        error: result.ok ? null : `HTTP ${result.status}`,
      });

      if (result.ok) {
        state.delivered += 1;
        state.lastSuccessAt = Date.now();
        state.active -= 1;
        bus.emit('forward:log', {
          id,
          device_id: job.deviceId,
          url: job.url,
          status: 'success',
          http_status: result.status,
          attempt,
          duration_ms: result.durationMs,
          created_at: Date.now(),
        });
        if (config.env !== 'production' || state.delivered % 50 === 1) {
          log('success', 'FWD', `⇑ forwarded ${job.deviceId} → ${job.url} (${result.status}, ${result.durationMs}ms)`);
        }
        return true;
      }

      lastStatus = result.status;
      lastError = `HTTP ${result.status}`;
      bus.emit('forward:log', {
        id,
        device_id: job.deviceId,
        url: job.url,
        status: 'failed',
        http_status: result.status,
        attempt,
        duration_ms: result.durationMs,
        error: lastError,
        created_at: Date.now(),
      });

      if (!isRetryable(result.status)) break;
    } catch (error) {
      lastError = error.name === 'TimeoutError' ? `timeout after ${config.forward.timeoutMs}ms` : error.message;
      const id = db.recordForwardLog({
        device_id: job.deviceId,
        url: job.url,
        status: 'failed',
        http_status: null,
        attempt,
        duration_ms: null,
        payload: job.serialized,
        error: lastError,
      });
      bus.emit('forward:log', {
        id,
        device_id: job.deviceId,
        url: job.url,
        status: 'failed',
        http_status: null,
        attempt,
        error: lastError,
        created_at: Date.now(),
      });
    }

    if (attempt < attempts) await sleep(config.forward.retryBackoffMs * attempt);
  }

  state.failed += 1;
  state.active -= 1;
  state.lastError = lastError;
  state.lastErrorAt = Date.now();
  log('warn', 'FWD', `forward failed for ${job.deviceId} after ${attempts} attempt(s): ${lastError}${lastStatus ? ` (${lastStatus})` : ''}`);
  return false;
}

function pump() {
  while (state.active < config.forward.concurrency && state.queue.length) {
    const job = state.queue.shift();
    state.active += 1;
    // Fire and forget: delivery never blocks ingest.
    deliver(job).catch((error) => {
      state.active -= 1;
      log('error', 'FWD', `forward worker crashed: ${error.message}`);
    });
  }
}

/* -------------------------------------------------------------------------- */
/* Queue                                                                      */
/* -------------------------------------------------------------------------- */

function enqueue(batch) {
  const target = resolveTarget();

  if (!target.enabled || !target.url) {
    state.skipped += 1;
    return { queued: false, reason: 'forwarding disabled' };
  }
  if (!target.valid) {
    state.skipped += 1;
    return { queued: false, reason: 'MAIN_WEBSITE_WEBHOOK_URL must start with http:// or https://' };
  }

  const payload = buildPayload(batch);
  const serialized = JSON.stringify(payload);

  if (state.queue.length >= config.forward.maxQueue) {
    state.queue.shift(); // drop the oldest, keep the freshest data
    state.dropped += 1;
    if (state.dropped === 1 || state.dropped % 100 === 0) {
      log('warn', 'FWD', `queue full (${config.forward.maxQueue}) — dropping oldest job (${state.dropped} dropped so far)`);
    }
  }

  state.queue.push({
    deviceId: batch.device_id,
    url: target.url,
    payload,
    serialized,
    queuedAt: Date.now(),
  });
  state.enqueued += 1;
  pump();
  return { queued: true, queue: state.queue.length };
}

/** Send an arbitrary document upstream right now (used by the "test" button). */
async function sendTest(payload = null) {
  const target = resolveTarget();
  if (!target.url) return { ok: false, error: 'no MAIN_WEBSITE_WEBHOOK_URL configured' };
  if (!target.valid) return { ok: false, error: 'URL must start with http:// or https://' };

  const document_ = payload || {
    source: 'iot-dashboard',
    event: 'test',
    received_at: Date.now(),
    message: 'Connectivity test from the IOT // DASHBOARD settings panel',
    device: { device_id: 'TEST-DEVICE', name: 'Connectivity test' },
    sensors: { temperature: 21.5 },
    readings: [{ device_id: 'TEST-DEVICE', sensor_name: 'temperature', value: 21.5, unit: '°C', created_at: Date.now() }],
  };

  try {
    const result = await postOnce(target.url, document_);
    const id = db.recordForwardLog({
      device_id: 'TEST-DEVICE',
      url: target.url,
      status: result.ok ? 'success' : 'failed',
      http_status: result.status,
      attempt: 1,
      duration_ms: result.durationMs,
      payload: JSON.stringify(document_),
      error: result.ok ? null : `HTTP ${result.status}`,
    });
    if (result.ok) state.lastSuccessAt = Date.now();
    return { ok: result.ok, http_status: result.status, duration_ms: result.durationMs, log_id: id, url: target.url };
  } catch (error) {
    const message = error.name === 'TimeoutError' ? `timeout after ${config.forward.timeoutMs}ms` : error.message;
    db.recordForwardLog({
      device_id: 'TEST-DEVICE',
      url: target.url,
      status: 'failed',
      http_status: null,
      attempt: 1,
      duration_ms: null,
      payload: JSON.stringify(document_),
      error: message,
    });
    return { ok: false, error: message, url: target.url };
  }
}

/* -------------------------------------------------------------------------- */
/* Lifecycle                                                                  */
/* -------------------------------------------------------------------------- */

function onIngestBatch(batch) {
  if (!batch || !batch.device_id) return;
  enqueue(batch);
}

function start() {
  if (state.running) return;
  listener = onIngestBatch;
  bus.on('ingest:batch', listener);
  state.running = true;
  const target = resolveTarget();
  log(
    'info',
    'FWD',
    target.url
      ? `upstream forwarding ${target.enabled ? 'ENABLED' : 'DISABLED'} → ${target.url} (source: ${target.source})`
      : 'upstream forwarding idle — set MAIN_WEBSITE_WEBHOOK_URL (.env or dashboard settings)',
  );
}

function stop() {
  if (!state.running || !listener) return;
  bus.off('ingest:batch', listener);
  state.running = false;
  listener = null;
}

module.exports = {
  start,
  stop,
  enqueue,
  sendTest,
  resolveTarget,
  buildPayload,
  getStatus,
  getQueueLength: () => state.queue.length,
};
