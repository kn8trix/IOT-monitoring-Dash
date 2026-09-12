'use strict';

/**
 * Internal event bus. Keeps the transport (HTTP, MQTT, automation) decoupled
 * from the presentation layer (Socket.io, logs).
 *
 * Events emitted:
 *   telemetry        { device_id, sensor_name, value, unit, created_at }
 *   device           device row (insert / status change)
 *   command:queued   { id, device_id, payload, source }
 *   command:delivered{ id, device_id, payload }
 *   rule:triggered   { rule, telemetry, command_id }
 *   log              { level, source, message, ts }
 */

const { EventEmitter } = require('events');

const bus = new EventEmitter();
// 200+ devices stream telemetry constantly; keep the listener count generous.
bus.setMaxListeners(64);

const LEVELS = ['info', 'success', 'warn', 'error', 'command', 'mqtt'];

/**
 * Push a line to the dashboard terminal.
 * @param {'info'|'success'|'warn'|'error'|'command'|'mqtt'} level
 * @param {string} source short tag, e.g. "HTTP" | "MQTT" | "AUTO"
 * @param {string} message human readable line
 * @param {object} [meta] optional structured payload
 */
function log(level, source, message, meta) {
  const entry = {
    level: LEVELS.includes(level) ? level : 'info',
    source,
    message,
    ts: Date.now(),
    ...(meta ? { meta } : {}),
  };
  bus.emit('log', entry);
  // Mirror to stdout so `docker compose logs -f node-server` is useful too.
  const stamp = new Date(entry.ts).toISOString();
  const line = `[${stamp}] [${entry.source}] ${entry.message}`;
  if (entry.level === 'error') console.error(line);
  else if (entry.level === 'warn') console.warn(line);
  else console.log(line);
  return entry;
}

module.exports = { bus, log };
