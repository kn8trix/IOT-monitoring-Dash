'use strict';

/**
 * Automation engine.
 *
 * Subscribes to every ingested reading, evaluates the enabled rules for that
 * sensor, and queues a command when a threshold is crossed. Commands are queued
 * through the normal path, so they are logged, persisted, mirrored to MQTT and
 * broadcast to the dashboard exactly like a manual command.
 *
 * Safety rails for 200+ device fleets:
 *   - per (rule, device) cooldown, so a wildcard rule cannot storm a fleet
 *   - a global burst limiter (MAX_BURST commands / BURST_WINDOW ms)
 *   - rule evaluation wrapped in try/catch: a bad rule can never kill ingest
 */

const db = require('./db');
const config = require('./config');
const { bus, log } = require('./events');

const BURST_WINDOW_MS = 5000;
const MAX_BURST = 25;

const OPERATORS = {
  '>': (value, threshold) => value > threshold,
  '>=': (value, threshold) => value >= threshold,
  '<': (value, threshold) => value < threshold,
  '<=': (value, threshold) => value <= threshold,
  '==': (value, threshold) => value === threshold,
  '!=': (value, threshold) => value !== threshold,
};

const cooldowns = new Map(); // `${rule.id}:${device_id}` -> ts
let burstWindow = { startedAt: 0, count: 0 };
let running = false;
let listener = null;

const stats = { evaluated: 0, triggered: 0, suppressedCooldown: 0, suppressedBurst: 0, errors: 0 };

function parseActionPayload(raw) {
  if (raw === null || raw === undefined) return undefined;
  const text = String(raw).trim();
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function withinBurst() {
  const ts = Date.now();
  if (ts - burstWindow.startedAt > BURST_WINDOW_MS) {
    burstWindow = { startedAt: ts, count: 0 };
  }
  burstWindow.count += 1;
  return burstWindow.count <= MAX_BURST;
}

/**
 * Evaluate one reading against every matching rule.
 * @param {object} reading { device_id, sensor_name, value, unit, created_at }
 * @returns {Array<object>} the commands that were queued
 */
function evaluate(reading) {
  if (!reading || reading.value === null || reading.value === undefined) return [];
  if (!Number.isFinite(Number(reading.value))) return [];

  let rules = [];
  try {
    rules = db.rulesForSensor(reading.sensor_name, reading.device_id);
  } catch (error) {
    stats.errors += 1;
    log('error', 'AUTO', `rule lookup failed: ${error.message}`);
    return [];
  }

  const queued = [];

  for (const rule of rules) {
    stats.evaluated += 1;

    const compare = OPERATORS[rule.operator];
    if (!compare) continue;

    let matched = false;
    try {
      matched = compare(Number(reading.value), Number(rule.threshold));
    } catch {
      continue;
    }
    if (!matched) continue;

    const cooldownKey = `${rule.id}:${reading.device_id}:${rule.sensor_name}`;
    const last = cooldowns.get(cooldownKey) || 0;
    const cooldownMs = Math.max(Number(rule.cooldown_seconds) || 0, 0) * 1000;
    const ts = Date.now();

    if (cooldownMs > 0 && ts - last < cooldownMs) {
      stats.suppressedCooldown += 1;
      continue;
    }

    if (!withinBurst()) {
      stats.suppressedBurst += 1;
      log('warn', 'AUTO', `burst limit reached (${MAX_BURST}/${BURST_WINDOW_MS}ms) — rule #${rule.id} suppressed`);
      continue;
    }

    cooldowns.set(cooldownKey, ts);
    // Bound the cooldown map (rule×device pairs can grow with a large fleet).
    if (cooldowns.size > 20000) {
      for (const [key, value] of cooldowns) {
        if (ts - value > 3_600_000) cooldowns.delete(key);
      }
    }

    const payload = {
      action: rule.action,
      rule_id: rule.id,
      rule_name: rule.name,
      device_id: reading.device_id,
      trigger: {
        sensor_name: reading.sensor_name,
        value: reading.value,
        unit: reading.unit || null,
        operator: rule.operator,
        threshold: rule.threshold,
      },
      issued_at: ts,
    };

    const extra = parseActionPayload(rule.action_payload);
    if (extra !== undefined) payload.payload = extra;

    try {
      db.markRuleTriggered(rule);
      db.recordRuleEvent({
        rule_id: rule.id,
        rule_name: rule.name,
        device_id: reading.device_id,
        sensor_name: reading.sensor_name,
        value: reading.value,
        operator: rule.operator,
        threshold: rule.threshold,
        action: rule.action,
        payload: rule.action_payload,
      });

      const command = db.queueCommand({
        device_id: reading.device_id,
        payload: JSON.stringify(payload),
        source: 'automation',
        transport: 'queue',
      });

      stats.triggered += 1;
      queued.push(command);

      log(
        'warn',
        'AUTO',
        `RULE FIRED #${rule.id} "${rule.name}" on ${reading.device_id}: ${reading.sensor_name}=${reading.value}` +
          ` ${rule.operator} ${rule.threshold} → ${rule.action}`,
      );
      bus.emit('rule:triggered', { rule, reading, command });
    } catch (error) {
      stats.errors += 1;
      log('error', 'AUTO', `rule #${rule.id} failed: ${error.message}`);
    }
  }

  return queued;
}

function onTelemetry(reading) {
  evaluate(reading);
}

function start() {
  if (running) return;
  listener = onTelemetry;
  bus.on('telemetry', listener);
  running = true;
  const rules = db.listRules();
  log('info', 'AUTO', `automation engine online — ${rules.filter((r) => r.enabled).length}/${rules.length} rule(s) enabled`);
}

function stop() {
  if (!running || !listener) return;
  bus.off('telemetry', listener);
  running = false;
  listener = null;
}

module.exports = {
  start,
  stop,
  evaluate,
  OPERATORS,
  MAX_BURST,
  BURST_WINDOW_MS,
  getStats: () => ({ ...stats, running, config: { max_burst: MAX_BURST, burst_window_ms: BURST_WINDOW_MS } }),
  resetCooldowns: () => cooldowns.clear(),
  getConfig: () => config,
};
