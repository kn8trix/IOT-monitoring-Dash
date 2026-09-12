'use strict';

/**
 * Central configuration. Every value comes from the environment with a safe
 * default so the server boots with zero configuration.
 */

// `quiet: true` keeps dotenv's startup banner out of the container logs.
require('dotenv').config({ quiet: true });

const path = require('path');

function toInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function toBool(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}

const rootDir = path.resolve(__dirname, '..');

const config = {
  env: process.env.NODE_ENV || 'development',
  port: toInt(process.env.PORT, 3000),
  host: process.env.HOST || '0.0.0.0',
  rootDir,
  publicDir: path.join(rootDir, 'public'),

  db: {
    path: process.env.DB_PATH
      ? path.resolve(process.env.DB_PATH)
      : path.join(rootDir, 'data', 'iot.db'),
  },

  mqtt: {
    enabled: toBool(process.env.MQTT_TELEMETRY_ENABLED, true),
    url: process.env.MQTT_URL || 'mqtt://localhost:1883',
    username: process.env.MQTT_USERNAME || undefined,
    password: process.env.MQTT_PASSWORD || undefined,
    clientId: process.env.MQTT_CLIENT_ID || 'iot-dashboard-server',
    telemetryTopic: process.env.MQTT_TELEMETRY_TOPIC || 'iot/+/telemetry',
    statusTopic: 'iot/+/status',
    ackTopic: 'iot/+/ack',
    commandTopicTemplate:
      process.env.MQTT_COMMAND_TOPIC_TEMPLATE || 'iot/{device_id}/command',
    reconnectPeriodMs: 4000,
  },

  device: {
    // Heartbeat window: a node is ONLINE while its last ping is younger than
    // this. The dashboard applies the same rule client-side (HEARTBEAT_MS).
    offlineAfterSeconds: toInt(process.env.OFFLINE_AFTER_SECONDS, 30),
    sweepIntervalSeconds: toInt(process.env.SWEEP_INTERVAL_SECONDS, 15),
  },

  retention: {
    days: toInt(process.env.TELEMETRY_RETENTION_DAYS, 14),
    maxRows: toInt(process.env.TELEMETRY_MAX_ROWS, 2_000_000),
    maxCommands: 20_000,
    maxRuleEvents: 5_000,
  },

  seed: {
    deviceCount: toInt(process.env.SEED_DEVICE_COUNT, 220),
  },

  rateLimit: {
    windowSeconds: toInt(process.env.RATE_LIMIT_WINDOW_SECONDS, 60),
    max: toInt(process.env.RATE_LIMIT_MAX_REQUESTS, 600),
  },

  telemetryHistoryLimit: 500,
};

module.exports = config;
