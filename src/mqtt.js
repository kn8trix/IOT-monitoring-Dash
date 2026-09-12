'use strict';

/**
 * MQTT bridge.
 *
 * Inbound : iot/+/telemetry  -> ingest pipeline
 *           iot/+/status     -> liveness updates (also handles broker LWT)
 *           iot/+/ack        -> command acknowledgements
 * Outbound: iot/{device_id}/command  <- every command queued through the API
 *
 * The service is intentionally resilient: if the broker is down the server
 * still serves the dashboard over HTTP + Socket.io, commands stay `pending`
 * in SQLite and are delivered when the broker reconnects (or via HTTP polling).
 */

const mqtt = require('mqtt');

const config = require('./config');
const db = require('./db');
const ingest = require('./ingest');
const { bus, log } = require('./events');

let client = null;
let connected = false;
let lastError = null;
let reconnects = 0;
let pendingPublishes = 0;
let published = 0;

const state = {
  get connected() {
    return connected;
  },
  get status() {
    return {
      enabled: config.mqtt.enabled,
      connected,
      url: config.mqtt.url,
      reconnects,
      published,
      last_error: lastError,
      subscriptions: [config.mqtt.telemetryTopic, config.mqtt.statusTopic, config.mqtt.ackTopic],
      command_topic_template: config.mqtt.commandTopicTemplate,
    };
  },
};

function commandTopic(deviceId) {
  return config.mqtt.commandTopicTemplate.replace('{device_id}', String(deviceId));
}

/** `iot/<device_id>/telemetry` -> `{ device_id, channel }` */
function parseTopic(topic) {
  const parts = String(topic).split('/').filter(Boolean);
  if (parts.length < 3) return null;
  return { device_id: parts[1], channel: parts[parts.length - 1] };
}

function safeJson(buffer) {
  const text = buffer.toString('utf8').trim();
  if (!text) return {};
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === 'object') return parsed;
    return { value: parsed };
  } catch {
    const numeric = Number(text);
    if (Number.isFinite(numeric)) return { value: numeric, sensor_name: 'value' };
    return { value: text, sensor_name: 'value' };
  }
}

/* -------------------------------------------------------------------------- */
/* Inbound                                                                    */
/* -------------------------------------------------------------------------- */

function onMessage(topic, buffer) {
  const target = parseTopic(topic);
  if (!target) return;

  if (target.channel === 'telemetry') {
    handleTelemetry(target.device_id, safeJson(buffer));
    return;
  }
  if (target.channel === 'status') {
    handleStatus(target.device_id, safeJson(buffer));
    return;
  }
  if (target.channel === 'ack') {
    handleAck(target.device_id, safeJson(buffer));
  }
}

function handleTelemetry(deviceId, payload) {
  const result = ingest.ingestReading(payload, { source: 'mqtt', device_id: deviceId });

  if (!result.ok) {
    if (result.error === 'no valid numeric readings') return;
    log('warn', 'MQTT', `ignored payload on iot/${deviceId}/telemetry: ${result.error}`);
    return;
  }

  for (const reading of result.readings) {
    if (ingest.shouldLogDevice(reading.device_id, reading.sensor_name)) {
      log('mqtt', 'MQTT', `⇐ ${ingest.summarize(reading)}`);
    }
  }
}

function handleStatus(deviceId, payload) {
  const raw = typeof payload.status === 'string' ? payload.status : payload.online === false ? 'offline' : 'online';
  const status = ['online', 'offline'].includes(raw) ? raw : 'online';
  db.upsertDevice({ device_id: deviceId, ip: payload.ip, name: payload.name, firmware: payload.firmware });
  db.setStatus(deviceId, status);
}

function handleAck(deviceId, payload) {
  const id = Number(payload.command_id ?? payload.id ?? payload.commandId);
  if (!Number.isFinite(id)) return;
  const status = payload.status === 'failed' || payload.ok === false ? 'failed' : 'acked';
  db.ackCommand({ id, status, error: payload.error ? String(payload.error).slice(0, 256) : null });
}

/* -------------------------------------------------------------------------- */
/* Outbound                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Publish one queued command. Called automatically whenever anything (API,
 * dashboard, automation rule) queues a command.
 */
function publishCommand(command) {
  if (!command) return false;
  const topic = commandTopic(command.device_id);

  if (!config.mqtt.enabled || !client || !connected) {
    pendingPublishes += 1;
    log('warn', 'MQTT', `broker offline — command #${command.id} for ${command.device_id} stays queued (HTTP polling available)`);
    return false;
  }

  try {
    client.publish(topic, command.payload, { qos: 1, retain: false });
    published += 1;
    db.markCommandDelivered(command.id, 'mqtt');
    log('command', 'MQTT', `⇒ iot/${command.device_id}/command :: ${command.payload}`);
    return true;
  } catch (error) {
    lastError = error.message;
    log('error', 'MQTT', `publish failed on ${topic}: ${error.message}`);
    return false;
  }
}

/** Publish arbitrary JSON on iot/{device_id}/command (dashboard convenience). */
function publishRaw(deviceId, payload) {
  if (!client || !connected) return false;
  client.publish(commandTopic(deviceId), typeof payload === 'string' ? payload : JSON.stringify(payload), { qos: 1 });
  return true;
}

/** Broadcast one telemetry sample published by the API simulator. */
function publishTelemetry(deviceId, payload) {
  if (!client || !connected) return false;
  client.publish(`iot/${deviceId}/telemetry`, typeof payload === 'string' ? payload : JSON.stringify(payload), { qos: 0 });
  return true;
}

/* -------------------------------------------------------------------------- */
/* Lifecycle                                                                  */
/* -------------------------------------------------------------------------- */

function connect() {
  if (!config.mqtt.enabled) {
    log('warn', 'MQTT', 'MQTT disabled (MQTT_TELEMETRY_ENABLED=false) — HTTP webhooks only');
    return null;
  }

  const options = {
    clientId: `${config.mqtt.clientId}-${Math.random().toString(16).slice(2, 8)}`,
    username: config.mqtt.username,
    password: config.mqtt.password,
    reconnectPeriod: config.mqtt.reconnectPeriodMs,
    connectTimeout: 10_000,
    clean: true,
    keepalive: 30,
  };

  log('info', 'MQTT', `connecting to ${config.mqtt.url} …`);
  client = mqtt.connect(config.mqtt.url, options);

  client.on('connect', () => {
    connected = true;
    lastError = null;
    const topics = [config.mqtt.telemetryTopic, config.mqtt.statusTopic, config.mqtt.ackTopic];
    client.subscribe(topics, { qos: 0 }, (error) => {
      if (error) {
        lastError = error.message;
        log('error', 'MQTT', `subscribe failed: ${error.message}`);
        return;
      }
      log('success', 'MQTT', `connected — subscribed to ${topics.join(', ')}`);
      bus.emit('mqtt:status', state.status);
    });
  });

  client.on('message', onMessage);

  client.on('reconnect', () => {
    reconnects += 1;
    bus.emit('mqtt:status', state.status);
  });

  client.on('close', () => {
    if (connected) log('warn', 'MQTT', 'connection closed — retrying');
    connected = false;
    bus.emit('mqtt:status', state.status);
  });

  client.on('error', (error) => {
    lastError = error.message;
    // Only log the first failure per outage to avoid a noisy terminal.
    if (reconnects < 3) log('error', 'MQTT', `broker error: ${error.message}`);
    connected = false;
  });

  // Any queued command is mirrored to MQTT automatically.
  bus.on('command:queued', (command) => {
    if (command && String(command.source) !== 'http-poll') publishCommand(command);
  });

  return client;
}

function close() {
  return new Promise((resolve) => {
    if (!client) return resolve();
    connected = false;
    client.end(true, () => resolve());
  });
}

module.exports = {
  connect,
  close,
  publishCommand,
  publishRaw,
  publishTelemetry,
  commandTopic,
  parseTopic,
  state,
  getStatus: () => state.status,
  isConnected: () => connected,
};
