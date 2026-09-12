#!/usr/bin/env node
'use strict';

/**
 * Fleet simulator — generates realistic telemetry for 200+ virtual devices so
 * the dashboard, charts and automation rules can be exercised without hardware.
 *
 *   node scripts/simulator.js                # HTTP webhooks (220 devices)
 *   node scripts/simulator.js --devices 50 --interval 2000
 *   node scripts/simulator.js --mqtt         # publish to iot/<id>/telemetry
 *   node scripts/simulator.js --url http://192.168.1.50:3000 --anomaly 0.08
 */

const { randomUUID } = require('crypto');
const { SENSOR_KITS } = require('../src/db');
const { bus } = require('../src/events'); // no-op for the bus, keeps config loading

/* -------------------------------------------------------------------------- */
/* CLI                                                                        */
/* -------------------------------------------------------------------------- */

function parseArgs(argv) {
  const args = {
    url: process.env.SIM_URL || 'http://localhost:3000',
    mqttUrl: process.env.SIM_MQTT_URL || process.env.MQTT_URL || 'mqtt://localhost:1883',
    devices: Number(process.env.SIM_DEVICES || 220),
    interval: Number(process.env.SIM_INTERVAL || 5000),
    concurrency: Number(process.env.SIM_CONCURRENCY || 24),
    prefix: process.env.SIM_PREFIX || 'ESP32-',
    padding: 4,
    anomaly: Number(process.env.SIM_ANOMALY || 0.05),
    duration: Number(process.env.SIM_DURATION || 0),
    mqtt: false,
    quiet: false,
  };

  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => argv[++i];
    switch (arg) {
      case '--url': args.url = next(); break;
      case '--mqtt-url': args.mqttUrl = next(); break;
      case '--devices': args.devices = Number(next()); break;
      case '--interval': args.interval = Number(next()); break;
      case '--concurrency': args.concurrency = Number(next()); break;
      case '--prefix': args.prefix = next(); break;
      case '--anomaly': args.anomaly = Number(next()); break;
      case '--duration': args.duration = Number(next()); break;
      case '--mqtt': args.mqtt = true; break;
      case '--quiet': args.quiet = true; break;
      case '--help':
      case '-h':
        printHelp();
        process.exit(0);
        break;
      default:
        if (arg.startsWith('--')) console.warn(`[sim] ignoring unknown option ${arg}`);
    }
  }
  return args;
}

function printHelp() {
  console.log(`
Fleet simulator — feeds the IOT dashboard with synthetic device data.

  --url <base>          Server base URL for HTTP mode      (default http://localhost:3000)
  --mqtt                Publish over MQTT instead of HTTP
  --mqtt-url <url>      Broker URL                          (default mqtt://localhost:1883)
  --devices <n>         Number of virtual devices           (default 220)
  --interval <ms>       Delay between rounds per device     (default 5000)
  --concurrency <n>     Parallel HTTP requests              (default 24)
  --prefix <str>        Device id prefix                    (default ESP32-)
  --anomaly <0..1>      Chance of an out-of-range reading   (default 0.05)
  --duration <seconds>  Stop after N seconds (0 = forever)  (default 0)
  --quiet               Only print the periodic summary
`);
}

const args = parseArgs(process.argv);

/* -------------------------------------------------------------------------- */
/* Virtual devices                                                            */
/* -------------------------------------------------------------------------- */

const LOCATIONS = ['Plant A', 'Plant B', 'Warehouse', 'Server Room', 'Greenhouse', 'Cold Storage', 'Roof Deck'];

/** Deterministic demo MAC mirroring src/db.js (`seedMac`). */
function deviceMac(index) {
  const hex = (value) => (value & 0xff).toString(16).toUpperCase().padStart(2, '0');
  return `A4:CF:12:${hex(index >> 16)}:${hex(index >> 8)}:${hex(index)}`;
}

function buildFleet(count, prefix) {
  const fleet = [];
  for (let i = 1; i <= count; i += 1) {
    const kit = SENSOR_KITS[(i - 1) % SENSOR_KITS.length];
    fleet.push({
      device_id: `${prefix}${String(i).padStart(4, '0')}`,
      ip: `10.${Math.floor((i - 1) / 254) % 99 + 1}.${((i - 1) % 254) + 1}.10`,
      mac: deviceMac(i),
      name: `Sensor Node ${i}`,
      location: LOCATIONS[(i - 1) % LOCATIONS.length],
      firmware: `v1.${(i - 1) % 5}.${i % 9}`,
      kit,
      phase: Math.random() * Math.PI * 2,
    });
  }
  return fleet;
}

/** Random-walk a sensor around its base value, occasionally spiking. */
function sample(device, sensor) {
  device.phase += 0.09;
  const wave = Math.sin(device.phase) * sensor.spread * 0.6;
  const noise = (Math.random() - 0.5) * sensor.spread;
  let value = sensor.base + wave + noise;

  const anomaly = Math.random() < args.anomaly;
  if (anomaly) {
    // Push clearly past the seeded automation thresholds (temp/co2/battery).
    value = sensor.base + sensor.spread * (sensor.base > 100 ? 6 : 3.4) + Math.random() * sensor.spread;
    value = Math.round(value * 100) / 100;
    return { value, anomaly: true };
  }

  if (sensor.sensor_name === 'battery') value = Math.max(3, Math.min(100, value));
  if (sensor.sensor_name === 'humidity') value = Math.max(5, Math.min(99, value));
  if (sensor.sensor_name === 'co2') value = Math.max(320, value);

  return { value: Math.round(value * 100) / 100, anomaly: false };
}

/* -------------------------------------------------------------------------- */
/* Transport                                                                  */
/* -------------------------------------------------------------------------- */

let sent = 0;
let failed = 0;
let anomalies = 0;

async function pool(items, limit, worker) {
  let cursor = 0;
  const runners = new Array(Math.min(limit, items.length || 1)).fill(0).map(async () => {
    while (cursor < items.length) {
      const index = cursor++;
      await worker(items[index]);
    }
  });
  await Promise.all(runners);
}

async function sendHttp(device, readings) {
  const response = await fetch(`${args.url.replace(/\/$/, '')}/api/webhook/data`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Device-Id': device.device_id },
    body: JSON.stringify({
      device_id: device.device_id,
      ip: device.ip,
      mac: device.mac,
      name: device.name,
      location: device.location,
      firmware: device.firmware,
      sensors: readings,
    }),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`HTTP ${response.status}: ${text.slice(0, 120)}`);
  }
  return response;
}

/* -------------------------------------------------------------------------- */
/* Main                                                                       */
/* -------------------------------------------------------------------------- */

async function main() {
  const fleet = buildFleet(args.devices, args.prefix);
  console.log(`[sim] ${fleet.length} virtual device(s) · mode=${args.mqtt ? 'mqtt' : 'http'} · interval=${args.interval}ms`);

  let mqttClient = null;
  if (args.mqtt) {
    // Lazily required so HTTP mode needs no MQTT dependency at runtime.
    const mqtt = require('mqtt');
    mqttClient = mqtt.connect(args.mqttUrl, {
      clientId: `iot-simulator-${randomUUID().slice(0, 8)}`,
      reconnectPeriod: 3000,
    });
    await new Promise((resolve, reject) => {
      mqttClient.once('connect', resolve);
      mqttClient.once('error', reject);
    });
    console.log(`[sim] connected to broker ${args.mqttUrl}`);
  } else {
    // Fail fast if the dashboard is unreachable.
    try {
      const health = await fetch(`${args.url.replace(/\/$/, '')}/api/health`).then((r) => r.json());
      console.log(`[sim] server ok · version ${health.version} · mqtt connected=${health.mqtt.connected}`);
    } catch (error) {
      console.error(`[sim] cannot reach ${args.url}: ${error.message}`);
      console.error('[sim] start the server first (npm start) or pass --url');
      process.exit(1);
    }
  }

  const startedAt = Date.now();
  let round = 0;

  const summary = setInterval(() => {
    const seconds = Math.max(1, (Date.now() - startedAt) / 1000);
    console.log(
      `[sim] round ${round} · sent ${sent} · failed ${failed} · anomalies ${anomalies} · avg ${(sent / seconds).toFixed(1)} req/s`,
    );
  }, 10000);
  summary.unref?.();

  const shutdown = () => {
    clearInterval(summary);
    console.log(`\n[sim] stopping — sent ${sent}, failed ${failed}, anomalies ${anomalies}`);
    if (mqttClient) mqttClient.end(true, () => process.exit(0));
    else process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // Main loop
  while (true) {
    round += 1;
    const startedRound = Date.now();

    // Shuffle so the request pattern is not strictly ordered.
    const order = [...fleet].sort(() => Math.random() - 0.5);

    await pool(order, args.concurrency, async (device) => {
      const readings = {};
      for (const sensor of device.kit) {
        const { value, anomaly } = sample(device, sensor);
        if (anomaly) anomalies += 1;
        readings[sensor.sensor_name] = { value, unit: sensor.unit };
      }

      try {
        if (args.mqtt) {
          mqttClient.publish(
            `iot/${device.device_id}/telemetry`,
            JSON.stringify({ device_id: device.device_id, sensors: readings }),
            { qos: 0 },
          );
        } else {
          await sendHttp(device, readings);
        }
        sent += 1;
      } catch (error) {
        failed += 1;
        if (failed < 6) console.error(`[sim] ${device.device_id} failed: ${error.message}`);
      }
    });

    if (args.duration > 0 && (Date.now() - startedAt) / 1000 >= args.duration) break;

    const elapsed = Date.now() - startedRound;
    const wait = Math.max(args.interval - elapsed, 50);
    await new Promise((resolve) => setTimeout(resolve, wait));
  }

  shutdown();
}

main().catch((error) => {
  console.error(`[sim] fatal: ${error.stack || error.message}`);
  process.exit(1);
});
