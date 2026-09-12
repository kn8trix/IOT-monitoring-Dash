# HANDOVER — IOT // DASHBOARD

Real-time monitoring and control platform for **200+ IoT devices**, built with
Node.js, Express, Socket.io, SQLite and MQTT. Space-Black / Neon-Green operator
console, webhook + MQTT ingest, queued command delivery, and a threshold-based
automation engine.

- **Dashboard:** http://localhost:3000
- **Health check:** http://localhost:3000/api/health
- **Version handed over:** 1.0.0 (`package.json`)

---

## 1. System architecture

```
       ┌──────────────────────────┐        ┌───────────────────────────┐
       │ ESP32 / ESP8266 / nodes  │        │ Any HTTP-only device      │
       │ (MQTT clients)           │        │ (webhook or HTTP polling) │
       └────────────┬─────────────┘        └────────────┬──────────────┘
                    │ iot/<id>/telemetry                │ POST /api/webhook/data
                    │ iot/<id>/command                  │ GET  /api/webhook/command/poll
                    ▼                                   ▼
       ┌────────────────────────────┐      ┌────────────────────────────────────────┐
       │  eclipse-mosquitto:2       │      │  node-server  (Express + Socket.io)    │
       │  :1883 MQTT  /  :9001 WS   │◀────▶│  · MQTT bridge (sub + pub)             │
       └────────────────────────────┘      │  · ingest pipeline → automation engine │
                                           │  · REST API + webhooks + rate limiting │
                                           │  · static dashboard (Tailwind/Chart.js)│
                                           └────────────────┬───────────────────────┘
                                                            │ better-sqlite3 (WAL)
                                                            ▼
                                           ┌────────────────────────────────────────┐
                                           │  ./data/iot.db                         │
                                           │  devices · telemetry · latest_telemetry│
                                           │  commands · automation_rules · events  │
                                           └────────────────────────────────────────┘

       Browser ── HTTP (static + REST) ──▶ node-server
               └─ WebSocket (Socket.io) ─▶ live telemetry, commands, terminal stream
```

### Components

| Layer | Technology | Notes |
| --- | --- | --- |
| Runtime | Node.js 22 LTS (Alpine) | see §16 for the Node 18 note |
| HTTP framework | Express 5 | REST + webhooks + static files |
| Realtime | Socket.io 4 | one bidirectional channel for the whole UI |
| Database | SQLite via `better-sqlite3` 13 | synchronous, WAL mode, no external server |
| Message broker | Eclipse Mosquitto 2 | MQTT 3.1.1/5.0 on 1883, WebSockets on 9001 |
| MQTT client | `mqtt` 5 | auto-reconnect, degrade-gracefully design |
| Front-end | Tailwind CSS 4 (compiled) + Chart.js 4 + vanilla JS | no CDN, no runtime build step |
| Container | Docker + Docker Compose | two services, one bridge network |

### Internal event flow (why modules stay decoupled)

`src/events.js` exposes a process-wide `EventEmitter` bus. Every transport funnels
through it:

```
HTTP webhook ─┐
              ├─▶ src/ingest.js ─▶ db.recordTelemetry() ─▶ bus "telemetry"
MQTT message ─┘                                             │
                                                            ├─▶ automation engine (rules)
                                                            └─▶ Socket.io "telemetry_update"

anything ─▶ db.queueCommand() ─▶ bus "command:queued" ─▶ MQTT publish iot/<id>/command
                                                       └─▶ Socket.io "command_sent"
```

Consequence: a command queued by a REST call, the dashboard, or an automation
rule takes exactly the same path — one place to debug, one place to log.

---

## 2. Repository layout

```
.
├── src/
│   ├── server.js        Express + Socket.io bootstrap, background jobs, shutdown
│   ├── config.js        every env var, with defaults
│   ├── db.js            schema, migrations, prepared statements, seeds
│   ├── ingest.js        payload normalisation + persistence + fan-out
│   ├── automation.js    rule engine (cooldowns, burst limiter)
│   ├── mqtt.js          MQTT bridge (subscribe telemetry/status/ack, publish commands)
│   ├── events.js        internal event bus + logger
│   ├── middleware.js    rate limiting + request logging
│   └── routes/api.js    all REST endpoints and webhooks
├── public/
│   ├── index.html       dashboard markup
│   ├── css/input.css    Tailwind source + neon theme (EDIT THIS)
│   ├── css/app.css      compiled stylesheet (BUILD ARTEFACT — do not edit)
│   ├── js/app.js        dashboard client (socket wiring, grid, charts, terminal)
│   └── vendor/chart.umd.js   vendored Chart.js (offline-capable)
├── scripts/
│   ├── simulator.js     synthetic 200+ device fleet
│   ├── seed.js          schema + demo devices + default rules
│   └── vendor.js        copies browser libs from node_modules → public/vendor
├── mosquitto/config/mosquitto.conf
├── data/iot.db          SQLite (git-ignored, created on first boot)
├── Dockerfile
├── docker-compose.yml
├── .env.example
└── HANDOVER.md          ← this file
```

> **Golden rule for front-end changes:** Tailwind classes are compiled ahead of
> time. After editing `index.html`, `js/app.js` **or** `css/input.css`, run
> `npm run build:css` and commit the regenerated `public/css/app.css`, otherwise
> the container (which does not install dev dependencies) will serve stale CSS.

---

## 3. UI design system

### Palette

| Role | Hex | Tailwind token | Used for |
| --- | --- | --- | --- |
| Main background | `#06090B` | `bg-void` | page background, header |
| Card container | `#0B0F12` | `bg-panel` | panels, `body` cards |
| Raised container | `#141C22` | `bg-panel2` | nested cards, buttons |
| Borders | `#1E2A34` | `border-edge` | every hairline |
| Accent / text | `#39FF14` | `text-neon` | titles, values, buttons, chart line |
| Terminal box | `#05080A` | `.terminal` | bottom live console |
| Warning | `#FFB020` | `--color-warn` | stale device, broker offline |
| Danger | `#FF3B30` | `--color-danger` | errors, failed commands |
| Info / MQTT | `#22D3EE` | `--color-cyan` | sources in the terminal |

Glow effects are `text-shadow`/`box-shadow` in `public/css/input.css`
(`.glow-text`, `.glow-text-soft`, `.glow-border`, `.neon-title`, `.dot-online`
pulse, `.term-cursor` blink).

### Typography

Monospace everywhere (`--font-mono`: JetBrains Mono → IBM Plex Mono → Fira Code →
system UI monospace). Metrics, telemetry readouts, terminal lines and the grid all
use it, matching the operator-console aesthetic. No web fonts are downloaded, so
the dashboard renders identically on an offline LAN.

### Layout

1. **Header** — glowing `IOT // DASHBOARD`, `SYSTEM STATUS: ACTIVE`, MQTT badge,
   node counters, connected-client count, clock.
2. **Stat strip** — devices total/online/offline, readings per minute, telemetry
   rows, queued commands, active rules, uptime.
3. **Real-time telemetry** — Chart.js line graph, neon `#39FF14` border with a
   vertical gradient fill, device/sensor/range selectors, `● LIVE` pause toggle,
   min/max/avg/sample readout.
4. **Device grid** — responsive cards: device id, IP, location, firmware, pulsing
   neon online dot, live metric chips, relative last-seen. Search, filter
   (all/online/offline), sort, paginated "load more" (60 per page).
5. **Control panel** — target device id (with autocomplete), text/JSON payload
   mode with validation, quick-command chips, glowing `▶ SEND COMMAND` button.
6. **Automation** — rule list with neon toggles, delete buttons, trigger counts,
   "new rule" form, recent-trigger feed.
7. **Command queue** — last 50 commands with status pills
   (`pending`/`delivered`/`acked`/`failed`).
8. **Live terminal** — deep-black `#05080A` console streaming every inbound
   webhook, outbound command, MQTT event and automation firing, with a blinking
   square cursor. `FOCUS` hides routine noise, `PAUSE` freezes the scroll,
   `CLEAR` empties the buffer (400-line window, server-side throttled to 25 lines/s
   so a 220-device fleet cannot flood the browser).

---

## 4. Data model (`data/iot.db`)

| Table | Purpose | Key columns |
| --- | --- | --- |
| `devices` | registered nodes + liveness | `device_id` PK, `name`, `ip`, `location`, `firmware`, `status` (`online`/`offline`), `last_seen`, `last_payload`, `first_seen`, `updated_at` |
| `telemetry` | append-only time series | `id` PK, `device_id`, `sensor_name`, `value` (REAL), `raw_value` (non-numeric), `unit`, `created_at` |
| `latest_telemetry` | one row per device+sensor | PK `(device_id, sensor_name)` — O(1) device grid rendering |
| `commands` | command queue + audit | `id` PK, `device_id`, `payload`, `status`, `source`, `transport`, `mqtt_topic`, `created_at`, `delivered_at`, `acked_at`, `error` |
| `automation_rules` | threshold rules | `id` PK, `name`, `device_id` (`*` = fleet-wide), `sensor_name`, `operator`, `threshold`, `action`, `action_payload`, `enabled`, `cooldown_seconds`, `last_triggered`, `trigger_count` |
| `rule_events` | automation audit trail | `rule_id`, `device_id`, `sensor_name`, `value`, `operator`, `threshold`, `action`, `created_at` |

Indexes exist on `telemetry(device_id, sensor_name, created_at DESC)`,
`telemetry(created_at DESC)`, `commands(device_id, status, id)`,
`devices(status, last_seen DESC)`, `rule_events(created_at DESC)`.

Schema version is tracked in `PRAGMA user_version` (currently `1`). Migrations are
additive — `src/db.js` re-runs idempotent `CREATE TABLE IF NOT EXISTS` DDL on boot.

**Liveness:** a device is `online` while telemetry/status/poll traffic arrives.
A sweeper runs every `SWEEP_INTERVAL_SECONDS` (15 s) and flips devices to
`offline` when `last_seen` is older than `OFFLINE_AFTER_SECONDS` (120 s). On
server restart all devices are re-armed to `offline` and re-appear as they report.

---

## 5. MQTT topics

Broker: `mqtt://localhost:1883` (TCP) · `ws://localhost:9001` (WebSockets).

| Direction | Topic | Payload | Notes |
| --- | --- | --- | --- |
| Device → server | `iot/{device_id}/telemetry` | JSON (see §7) | subscribed as `iot/+/telemetry` |
| Device → server | `iot/{device_id}/status` | `{"status":"online"}` or `"online"` | optional; also used for LWT |
| Device → server | `iot/{device_id}/ack` | `{"command_id":12,"status":"acked"}` | marks a command acknowledged |
| Server → device | `iot/{device_id}/command` | JSON command object (see §7) | published QoS 1 for every queued command |

Wildcard subscription is configured by `MQTT_TELEMETRY_TOPIC` (default
`iot/+/telemetry`). The publish topic template is `MQTT_COMMAND_TOPIC_TEMPLATE`
(default `iot/{device_id}/command`).

Useful broker commands:

```bash
# publish a fake reading
docker compose exec mqtt-broker mosquitto_pub \
  -h 127.0.0.1 -t iot/ESP32-0001/telemetry -m '{"sensors":{"temperature":31.4,"humidity":44}}'

# watch everything the server sends out
docker compose exec mqtt-broker mosquitto_sub -h 127.0.0.1 -t 'iot/+/command' -v

# watch inbound telemetry from the fleet
docker compose exec mqtt-broker mosquitto_sub -h 127.0.0.1 -t 'iot/+/telemetry' -v
```

---

## 6. REST API and webhooks

All responses are JSON. Errors look like `{"ok": false, "error": "..."}`.
`device_id` must match `^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$`.
Rate limit: `RATE_LIMIT_MAX_REQUESTS` per `RATE_LIMIT_WINDOW_SECONDS` per IP
(default 600/min), reported through `X-RateLimit-*` headers.

### Device → server (public webhooks)

| Method | Path | Body / query | Purpose |
| --- | --- | --- | --- |
| `POST` | `/api/webhook/data` | `{device_id, sensor_name, value, unit?}` — or `sensors{}`, `metrics{}`, `readings[]`; bare `text/plain` number allowed | ingest telemetry, upsert device, run automation |
| `POST` | `/api/webhook/command` | `{device_id, command}` or `{device_id, payload}` (plain text also accepted) | queue a command and publish it to MQTT |
| `GET` | `/api/webhook/command/poll` | `?device_id=ESP32-0001&limit=20` | HTTP-polling devices collect pending commands (marks them `delivered`, refreshes liveness) |
| `POST` | `/api/webhook/command/ack` | `{command_id, status:"acked"\|"failed", error?}` | device confirms execution |

### Dashboard / integration API

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/api/health` | service, version, uptime, MQTT state, ingest counters, automation stats |
| `GET` | `/api/stats` | device/telemetry/command/rule counters + clients |
| `GET` | `/api/mqtt/status` | broker connection detail, reconnects, last error |
| `GET` | `/api/devices` | `?search=&limit=&offset=` — every device with latest metrics |
| `GET` | `/api/devices/:deviceId` | one device + metrics + sensors + recent commands |
| `GET` | `/api/devices/:deviceId/telemetry` | `?sensor_name=temperature&limit=200&since_ms=3600000` — chart series |
| `GET` | `/api/telemetry/recent` | `?limit=50` — newest rows across the fleet |
| `GET` | `/api/commands` | `?device_id=&limit=50` |
| `POST` | `/api/commands` | `{device_id, payload, source?}` — same effect as the command webhook |
| `GET` | `/api/rules` | all automation rules + last 10 trigger events |
| `POST` | `/api/rules` | create a rule |
| `PATCH` | `/api/rules/:id` | partial update |
| `POST` | `/api/rules/:id/toggle` | `{enabled: true\|false}` (or omit to invert) |
| `DELETE` | `/api/rules/:id` | remove a rule |
| `GET` | `/api/rule-events` | `?limit=25` — automation audit trail |

### Examples

```bash
# single reading
curl -X POST http://localhost:3000/api/webhook/data \
  -H 'Content-Type: application/json' \
  -d '{"device_id":"ESP32-0001","sensor_name":"temperature","value":31.4,"unit":"C"}'

# multi-sensor frame (unit per sensor)
curl -X POST http://localhost:3000/api/webhook/data \
  -H 'Content-Type: application/json' \
  -d '{"device_id":"ESP32-0002","ip":"10.1.2.10","sensors":{"temperature":{"value":22.5,"unit":"C"},"humidity":48}}'

# cheapest possible ESP8266 payload: bare number + query params
curl -X POST 'http://localhost:3000/api/webhook/data?device_id=ESP8266-01&sensor_name=co2&unit=ppm' \
  -H 'Content-Type: text/plain' -d '812'

# send a command (goes to MQTT and stays available over HTTP polling)
curl -X POST http://localhost:3000/api/webhook/command \
  -H 'Content-Type: application/json' \
  -d '{"device_id":"ESP32-0001","command":"RELAY_ON"}'

# device polls for work
curl 'http://localhost:3000/api/webhook/command/poll?device_id=ESP32-0001'

# acknowledge
curl -X POST http://localhost:3000/api/webhook/command/ack \
  -H 'Content-Type: application/json' -d '{"command_id":1,"status":"acked"}'

# "if temperature > 30 then RELAY_OFF" for every device
curl -X POST http://localhost:3000/api/rules \
  -H 'Content-Type: application/json' \
  -d '{"name":"If temp > 30 trigger RELAY_OFF","sensor_name":"temperature","operator":">","threshold":30,"action":"RELAY_OFF","device_id":"*","cooldown_seconds":60}'
```

### Accepted ingest payload shapes

The ingest pipeline normalises whatever a firmware can realistically send:

```jsonc
{ "device_id": "ESP32-0001", "sensor_name": "temperature", "value": 24.1 }
{ "device_id": "ESP32-0001", "sensors": { "temperature": 24.1, "humidity": 51 } }
{ "device_id": "ESP32-0001", "sensors": { "temperature": { "value": 24.1, "unit": "C" } } }
{ "device_id": "ESP32-0001", "readings": [ { "sensor_name": "temperature", "value": 24.1 } ] }
{ "device": "ESP32-0001", "metric": "co2", "val": 780 }        // aliases accepted
```

Optional metadata alongside any shape: `ip`, `name`, `location`, `firmware`,
`unit`, `ts`/`timestamp` (epoch ms). Non-numeric values (`"OPEN"`, `"n/a"`) are
stored in `raw_value` for audit but are not charted and cannot trigger rules.
Sensor names are normalised: lower-cased, spaces/odd characters → `_`, max 64 chars.

### Command payloads reaching a device

Manual commands are delivered verbatim, exactly as the operator typed them.
Automation commands are structured:

```json
{
  "action": "RELAY_OFF",
  "rule_id": 1,
  "rule_name": "If temp > 30 trigger RELAY_OFF",
  "device_id": "ESP32-0001",
  "trigger": { "sensor_name": "temperature", "value": 41.5, "unit": "C", "operator": ">", "threshold": 30 },
  "issued_at": 1789195778000
}
```

---

## 7. Socket.io events

Client connects to the same origin (Socket.io client is served by the server at
`/socket.io/socket.io.js`).

| Direction | Event | Payload |
| --- | --- | --- |
| S→C | `bootstrap` | full snapshot: stats, devices, rules, rule events, commands, recent telemetry, terminal backlog, MQTT state |
| S→C | `telemetry_update` | `{device_id, sensor_name, value, unit, created_at}` |
| S→C | `device_update` | device row (registration / online / offline transition) |
| S→C | `command_sent` / `command_delivered` / `command_acked` | command row |
| S→C | `rule_triggered` | `{rule, reading, command}` |
| S→C | `rules_changed` | full rule list |
| S→C | `stats` | counters + `clients`, every 5 s |
| S→C | `mqtt_status` | broker state on change |
| S→C | `terminal` | `{level, source, message, ts}` — the bottom console |
| C→S | `request:snapshot` | ack callback receives a fresh snapshot |
| C→S | `request:history` | `{device_id, sensor_name, limit, since_ms}` → ack with `points[]` |
| C→S | `request:devices` | `{search}` → ack with the device list |

---

## 8. Automation engine

Rules are evaluated for every numeric reading (`src/automation.js`):

- Match on `sensor_name` and either the exact `device_id` or `*` (fleet-wide).
- Operators: `>`, `>=`, `<`, `<=`, `==`, `!=`.
- On a match the engine queues `action` (with optional `action_payload`) as a
  normal command, records a `rule_events` row, increments `trigger_count`, and
  emits `rule_triggered` to every dashboard.
- **Cooldown** (`cooldown_seconds`, default 60) is enforced per rule *and* per
  device, so a fleet-wide rule cannot re-fire every second on every node.
- **Burst limiter:** at most 25 automation commands per 5 s; excess is suppressed
  and logged (`burst limit reached`). Raise `MAX_BURST` in `src/automation.js`
  for a large fleet with aggressive rules.

Default rules created on an empty database:

| Rule | Condition | Action |
| --- | --- | --- |
| Cool down when hot | `temperature > 30` | `RELAY_OFF` |
| Heat when cold | `temperature < 16` | `RELAY_ON` |
| Ventilate on CO2 spike | `co2 > 1000` | `FAN_ON` |
| Low battery warning | `battery < 20` | `SEND_ALERT` (`battery_low`) |

---

## 9. Device integration — ESP32 / ESP8266

### 9.1 One-time toolchain setup (Arduino IDE)

1. **Arduino IDE 2.x** → *File ▸ Preferences ▸ Additional Board Manager URLs*:
   ```
   https://raw.githubusercontent.com/espressif/arduino-esp32/gh-pages/package_esp32_index.json
   https://arduino.esp8266.com/stable/package_esp8266com_index.json
   ```
2. *Tools ▸ Board ▸ Boards Manager* → install **esp32** (Espressif) and/or
   **esp8266** (ESP8266 Community).
3. *Tools ▸ Manage Libraries* → install:
   - **PubSubClient** (Nick O'Leary) — MQTT
   - **ArduinoJson** (Benoit Blanchon) — payload building (v7 or v6)
   - *(HTTP-only path)* no extra library needed.
4. Board selection and flashing settings:

   | Board | Tools ▸ Board | Upload speed | Notes |
   | --- | --- | --- | --- |
   | ESP32 DevKit v1 | `ESP32 Dev Module` | 921600 | hold **BOOT**, tap **EN** if upload stalls |
   | ESP32-WROOM / S3 | matching `ESP32-*` entry | 921600 | USB-C boards usually auto-reset |
   | NodeMCU v2 (ESP8266) | `NodeMCU 1.0 (ESP-12E Module)` | 115200 | 4 MB flash, DIO |
   | Wemos D1 mini | `LOLIN(WEMOS) D1 R2 & mini` | 115200 | 4 MB flash, DIO |

   Select the port under *Tools ▸ Port* (`/dev/ttyUSB0`, `/dev/ttyACM0`, `COM3`, …).
   On Linux add yourself to `dialout`: `sudo usermod -aG dialout $USER` (re-login).

5. **Select a unique `DEVICE_ID` per board** — it is the primary key the dashboard
   uses. Convention: `ESP32-0001` … `ESP32-0NNN`.

### 9.2 Firmware A — MQTT + HTTP fallback (recommended, ESP32)

Sends telemetry over MQTT and, if the broker is unreachable, falls back to the
HTTP webhook. Collects commands from `iot/<id>/command` and acknowledges each one.

```cpp
#include <WiFi.h>          // ESP8266: #include <ESP8266WiFi.h>
#include <PubSubClient.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>

// ------------------------------------------------------------------ settings
const char* WIFI_SSID   = "YOUR_WIFI";
const char* WIFI_PASS   = "YOUR_PASSWORD";
const char* MQTT_HOST   = "192.168.1.50";   // host running docker compose
const int   MQTT_PORT   = 1883;
const char* API_BASE    = "http://192.168.1.50:3000";
const char* DEVICE_ID   = "ESP32-0001";     // must be unique per board
const char* LOCATION    = "Plant A";
const int   RELAY_PIN   = 2;                // onboard LED is fine for testing
const unsigned long SEND_INTERVAL_MS = 5000;

WiFiClient   net;
PubSubClient mqtt(net);
unsigned long lastSend = 0;

char topicTelemetry[64];
char topicCommand[64];
char topicAck[64];

// ------------------------------------------------------------------ helpers
void publishAck(long commandId, const char* status) {
  StaticJsonDocument<128> doc;
  doc["command_id"] = commandId;
  doc["status"] = status;
  char buffer[128];
  size_t n = serializeJson(doc, buffer);
  mqtt.publish(topicAck, (const uint8_t*)buffer, n);
}

void onCommand(char* topic, byte* payload, unsigned int length) {
  StaticJsonDocument<512> doc;
  if (deserializeJson(doc, payload, length)) return;

  const long commandId = doc["id"] | doc["command_id"] | 0;
  const char* action = doc["action"];                 // automation commands
  String raw = "";                                    // manual commands
  if (action == nullptr) {
    serializeJson(doc, raw);
  }

  if (action != nullptr && strcmp(action, "RELAY_ON") == 0)       digitalWrite(RELAY_PIN, HIGH);
  else if (action != nullptr && strcmp(action, "RELAY_OFF") == 0) digitalWrite(RELAY_PIN, LOW);
  else if (action != nullptr && strcmp(action, "STATUS") == 0) { /* report immediately */ }
  else if (raw.indexOf("RELAY_ON") >= 0)  digitalWrite(RELAY_PIN, HIGH);
  else if (raw.indexOf("RELAY_OFF") >= 0) digitalWrite(RELAY_PIN, LOW);

  if (commandId > 0) publishAck(commandId, "acked");
}

void connectWifi() {
  if (WiFi.status() == WL_CONNECTED) return;
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  while (WiFi.status() != WL_CONNECTED) { delay(400); Serial.print("."); }
  Serial.printf("\nWiFi ok, ip=%s\n", WiFi.localIP().toString().c_str());
}

void connectMqtt() {
  if (mqtt.connected()) return;
  // Last-will marks the node offline on the dashboard if it dies.
  mqtt.connect(DEVICE_ID, nullptr, nullptr, topicTelemetry, 1, false, "{\"status\":\"offline\"}");
  mqtt.subscribe(topicCommand, 1);
  mqtt.publish(topicTelemetry, "{\"status\":\"online\"}", false);
}

// Telemetry over HTTP when MQTT is down (device never goes dark).
void sendOverHttp(float t, float h) {
  if (WiFi.status() != WL_CONNECTED) return;
  HTTPClient http;
  http.begin(String(API_BASE) + "/api/webhook/data");
  http.addHeader("Content-Type", "application/json");
  StaticJsonDocument<256> doc;
  doc["device_id"] = DEVICE_ID;
  doc["location"]  = LOCATION;
  doc["ip"]        = WiFi.localIP().toString();
  doc["sensors"]["temperature"] = serialized(String(t, 2));
  doc["sensors"]["humidity"]    = serialized(String(h, 2));
  String body;
  serializeJson(doc, body);
  http.POST(body);
  http.end();
}

void setup() {
  Serial.begin(115200);
  pinMode(RELAY_PIN, OUTPUT);
  digitalWrite(RELAY_PIN, LOW);

  snprintf(topicTelemetry, sizeof(topicTelemetry), "iot/%s/telemetry", DEVICE_ID);
  snprintf(topicCommand,   sizeof(topicCommand),   "iot/%s/command",   DEVICE_ID);
  snprintf(topicAck,       sizeof(topicAck),       "iot/%s/ack",       DEVICE_ID);

  connectWifi();
  mqtt.setServer(MQTT_HOST, MQTT_PORT);
  mqtt.setCallback(onCommand);
  connectMqtt();
}

void loop() {
  connectWifi();
  if (!mqtt.connected()) connectMqtt();
  mqtt.loop();

  if (millis() - lastSend >= SEND_INTERVAL_MS) {
    lastSend = millis();
    float temperature = 20.0 + random(0, 1500) / 100.0;   // replace with real sensor
    float humidity    = 40.0 + random(0, 3000) / 100.0;

    StaticJsonDocument<256> doc;
    doc["sensors"]["temperature"] = serialized(String(temperature, 2));
    doc["sensors"]["humidity"]    = serialized(String(humidity, 2));
    char buffer[256];
    size_t n = serializeJson(doc, buffer);

    if (mqtt.connected()) {
      mqtt.publish(topicTelemetry, (const uint8_t*)buffer, n);
    } else {
      sendOverHttp(temperature, humidity);
    }
  }
  delay(20);
}
```

### 9.3 Firmware B — HTTP polling only (ESP8266, no broker access)

```cpp
#include <ESP8266WiFi.h>
#include <ESP8266HTTPClient.h>
#include <ArduinoJson.h>

const char* WIFI_SSID = "YOUR_WIFI";
const char* WIFI_PASS = "YOUR_PASSWORD";
const char* API_BASE  = "http://192.168.1.50:3000";
const char* DEVICE_ID = "ESP8266-01";

unsigned long lastSend = 0, lastPoll = 0;

void postReading(const char* sensor, float value, const char* unit) {
  HTTPClient http;
  http.begin(String(API_BASE) + "/api/webhook/data");
  http.addHeader("Content-Type", "application/json");
  StaticJsonDocument<192> doc;
  doc["device_id"]   = DEVICE_ID;
  doc["sensor_name"] = sensor;
  doc["value"]       = serialized(String(value, 2));
  doc["unit"]        = unit;
  String body; serializeJson(doc, body);
  Serial.printf("POST %s -> %d\n", sensor, http.POST(body));
  http.end();
}

void pollCommands() {
  HTTPClient http;
  http.begin(String(API_BASE) + "/api/webhook/command/poll?device_id=" + DEVICE_ID);
  if (http.GET() != 200) { http.end(); return; }

  DynamicJsonDocument doc(1024);
  if (deserializeJson(doc, http.getString())) { http.end(); return; }

  for (JsonObject cmd : doc["commands"].as<JsonArray>()) {
    const long id = cmd["id"];
    String payload = cmd["payload"].as<String>();
    if (payload.indexOf("RELAY_ON")  >= 0) digitalWrite(LED_BUILTIN, LOW);
    if (payload.indexOf("RELAY_OFF") >= 0) digitalWrite(LED_BUILTIN, HIGH);

    HTTPClient ack;                       // acknowledge execution
    ack.begin(String(API_BASE) + "/api/webhook/command/ack");
    ack.addHeader("Content-Type", "application/json");
    ack.POST("{\"command_id\":" + String(id) + ",\"status\":\"acked\"}");
    ack.end();
  }
  http.end();
}

void setup() {
  Serial.begin(115200);
  pinMode(LED_BUILTIN, OUTPUT);
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  while (WiFi.status() != WL_CONNECTED) delay(400);
  Serial.println(WiFi.localIP());
}

void loop() {
  if (millis() - lastSend > 5000) { lastSend = millis(); postReading("temperature", 22.0 + random(0, 900) / 100.0, "C"); }
  if (millis() - lastPoll > 3000) { lastPoll = millis(); pollCommands(); }
  delay(10);
}
```

### 9.4 Command-line flashing (esptool)

```bash
# ESP32 (esptool ships with the Arduino ESP32 core)
esptool.py --chip esp32 --port /dev/ttyUSB0 --baud 921600 \
  write_flash -z 0x1000 firmware.bin

# ESP8266
esptool.py --chip esp8266 --port /dev/ttyUSB0 --baud 115200 \
  write_flash -z 0x0 firmware.bin

# Optional: export a compiled Arduino sketch, or build with PlatformIO
#   pio run -t upload        (platformio.ini: platform = espressif32)
```

Notes for reliable flashing: use a **data-capable** USB cable (not charge-only),
keep the board powered from USB or a stable 3.3 V rail (never 5 V logic into
ESP pins), and if the port disappears during upload hold **BOOT/FLASH** and tap
**RST**. Verify a board is alive afterwards:

```bash
mosquitto_sub -h 192.168.1.50 -t 'iot/+/telemetry' -v     # should print sensor frames
```

---

## 10. Docker deployment

### 10.1 Services

| Service | Image | Ports | Volume |
| --- | --- | --- | --- |
| `node-server` | built from `Dockerfile` (`iot-monitoring-dashboard:latest`) | `3000:3000` | `./data:/app/data` |
| `mqtt-broker` | `eclipse-mosquitto:2` | `1883:1883`, `9001:9001` | config bind + named volumes for data/log |

### 10.2 Start on the external drive (typical workstation workflow)

```bash
# 0) the project lives on the external HDD, e.g. /media/<user>/<DISK>/Projects/iot-monitoring-dashboard
cd "/media/kn8/D_Drive/Projects/iot monitoring dash"

# 1) make sure the Docker daemon is running (custom helper on this machine)
docker-on

# 2) build + start both containers in the background
docker compose up -d --build

# 3) verify
docker compose ps                       # both services "Up" / "healthy"
curl -s localhost:3000/api/health       # {"ok":true,...}
open http://localhost:3000              # dashboard
```

### 10.3 Day-two operations

```bash
docker compose logs -f node-server     # application log (same lines as the terminal panel)
docker compose logs -f mqtt-broker     # broker log
docker compose restart node-server     # restart after .env / code changes
docker compose up -d --build           # rebuild after code changes
docker compose down                    # stop (data in ./data is preserved)
docker compose down -v                 # stop and delete broker volumes
docker compose exec node-server node scripts/simulator.js --devices 220 --interval 5000
docker compose exec mqtt-broker mosquitto_sub -t 'iot/+/telemetry' -v
```

The `node-server` health check polls `/api/health` every 30 s; the broker health
check subscribes to `$SYS/#`. `restart: unless-stopped` makes the stack survive
reboots as long as the drive is mounted and the daemon starts.

### 10.4 External-drive cautions

- **The daemon must be running before the stack mounts paths on the drive.** If the
  HDD is unmounted, `docker compose up` silently creates an *empty local* `./data`
  directory and you lose sight of your real database. Always check
  `mount | grep <DISK>` (or `ls ./data/iot.db`) before starting.
- **SQLite needs a Linux-native filesystem.** ext4/XFS/Btrfs are ideal. On
  **exFAT/NTFS/SMB** the WAL shared-memory file can fail and SQLite raises
  `disk I/O error`. Fix: keep the project on ext4, or move the database into a
  named volume:
  ```yaml
  # docker-compose.yml → node-server
  volumes:
    - iot-data:/app/data
  # and add under `volumes:`  →  iot-data:
  ```
- The drive must be mounted with `exec`/`rw` (no `noexec`), otherwise the container
  cannot start.
- Unclean shutdowns of a USB drive can corrupt the DB; `data/*.db-wal` and
  `*.db-shm` are part of the database — always back up all three files together.

### 10.5 Backups

```bash
# consistent snapshot while the server is running
docker compose exec node-server node -e "
  const D=require('better-sqlite3');const db=new D('/app/data/iot.db',{readonly:true});
  db.backup('/app/data/backup-'+Date.now()+'.db').then(()=>console.log('backup written'));"
cp -a ./data ./data-backup-$(date +%F)     # stop the stack first for a file-level copy
```

---

## 11. Configuration

Copy `.env.example` → `.env` for local (non-Docker) runs. Compose passes the same
values through `environment:` in `docker-compose.yml`.

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` / `HOST` | `3000` / `0.0.0.0` | HTTP + Socket.io bind |
| `DB_PATH` | `./data/iot.db` | SQLite file (created with parent dirs) |
| `MQTT_URL` | `mqtt://localhost:1883` | broker URL (**`mqtt://mqtt-broker:1883` inside compose**) |
| `MQTT_USERNAME` / `MQTT_PASSWORD` | – | set when `allow_anonymous false` |
| `MQTT_CLIENT_ID` | `iot-dashboard-server` | a random suffix is appended per boot |
| `MQTT_TELEMETRY_TOPIC` | `iot/+/telemetry` | subscription |
| `MQTT_COMMAND_TOPIC_TEMPLATE` | `iot/{device_id}/command` | publish topic |
| `MQTT_TELEMETRY_ENABLED` | `true` | set `false` for webhook-only deployments |
| `OFFLINE_AFTER_SECONDS` | `120` | silence before a node is marked offline |
| `SWEEP_INTERVAL_SECONDS` | `15` | liveness sweep cadence |
| `TELEMETRY_RETENTION_DAYS` | `14` | hourly prune (`0` disables) |
| `TELEMETRY_MAX_ROWS` | `2000000` | hard row cap, oldest trimmed first |
| `SEED_DEVICE_COUNT` | `220` | demo devices registered on an empty DB (`0` = none) |
| `RATE_LIMIT_WINDOW_SECONDS` / `RATE_LIMIT_MAX_REQUESTS` | `60` / `600` | per-IP throttle on `/api` |

---

## 12. Local development (without Docker)

```bash
npm install            # also vendors Chart.js into public/vendor (postinstall)
npm run build:css      # recompile Tailwind after touching markup/JS
npm start              # http://localhost:3000
npm run dev            # same, with --watch auto-restart
npm run watch:css      # Tailwind in watch mode (second terminal)
npm run simulate       # 220 virtual devices over HTTP webhooks
npm run simulate:mqtt  # 220 virtual devices over MQTT
npm run seed           # schema + demo devices + default rules
npm run db:reset       # delete data/iot.db and seed it again
npm run check          # node --check on the main entry points
```

The server boots with **no broker running** — MQTT connection failures are
retried every 4 s, the dashboard keeps working over HTTP, and commands stay
`pending` in SQLite until either the broker reconnects or the device polls.

---

## 13. Simulator

```bash
node scripts/simulator.js --devices 220 --interval 5000 --anomaly 0.05
```

| Flag | Default | Meaning |
| --- | --- | --- |
| `--url` | `http://localhost:3000` | server base URL (HTTP mode) |
| `--mqtt` | off | publish to `iot/<id>/telemetry` instead of HTTP |
| `--mqtt-url` | `mqtt://localhost:1883` | broker URL |
| `--devices` | `220` | virtual fleet size (ids `ESP32-0001`…) |
| `--interval` | `5000` | ms between rounds |
| `--concurrency` | `24` | parallel HTTP requests |
| `--anomaly` | `0.05` | chance of an out-of-range reading (exercises rules) |
| `--duration` | `0` | stop after N seconds (`0` = run until Ctrl-C) |

Each virtual node gets a stable sensor kit (temperature; +humidity; +pressure/
battery; CO₂; current) and random-walks around a realistic baseline.

---

## 14. Verification performed on this handover

| Check | Result |
| --- | --- |
| `npm install` (native `better-sqlite3` binding loads) | ✅ |
| Server boot: schema create, 220 demo devices seeded, 4 default rules | ✅ |
| Boot with **no** MQTT broker (degrades, keeps serving, retries) | ✅ |
| `POST /api/webhook/data` JSON / `sensors{}` / bare `text/plain` | ✅ 201, rows + device upsert |
| Device auto-registration from first reading; second reading → `online` | ✅ |
| `GET /api/devices` with latest metrics, search, filters | ✅ |
| `GET /api/devices/:id/telemetry` series for the chart | ✅ |
| Command webhook → SQLite queue → HTTP polling delivery | ✅ |
| Automation: `temperature=41.5 > 30` → `RELAY_OFF` queued, rule event logged | ✅ |
| Rule CRUD + toggle + delete + `/api/rule-events` | ✅ |
| Validation: missing `device_id`, illegal characters, unknown device, unknown route | ✅ 400/404 JSON |
| Rate limiter / 404 handler / SPA fallback (no path traversal) | ✅ |
| Simulator: 30 devices → 240 telemetry rows, 19 automation commands, 0 failures | ✅ |
| `npm run build:css` → 24 kB minified stylesheet with all dynamic classes | ✅ |
| `docker compose config` validation | ✅ |
| `docker compose build` / container smoke test | ⏳ pending Docker daemon (`docker-on`) |

---

## 15. Security notes

- **Webhook routes are unauthenticated** by design (devices cannot negotiate
  tokens easily). They are rate limited and validated, but on an untrusted network
  you should add a shared secret: set `WEBHOOK_TOKEN` and require
  `?token=`/`X-Device-Id` in `src/routes/api.js`, or put the stack behind a
  reverse proxy with TLS + auth.
- **Mosquitto allows anonymous connections** in the shipped config (LAN default).
  See the header of `mosquitto/config/mosquitto.conf` for the exact steps to
  enable passwords, and then set `MQTT_USERNAME`/`MQTT_PASSWORD` on `node-server`.
- The HTTP server sets no `helmet`-style security headers; add `helmet` +
  a CSP if the dashboard is exposed beyond the LAN.
- CORS is currently `*` for both REST and Socket.io to keep browser-based tooling
  simple. Restrict `origin` in `src/server.js` before any public deployment.
- Keep `data/` and `.env` out of version control (already in `.gitignore`).

---

## 16. Known deviations from the original brief

1. **Base image is `node:22-alpine`, not `node:18-alpine`.**
   `better-sqlite3@^13` declares `"engines": {"node": ">=22"}`, and Node 18 is
   end-of-life. The base is parameterised, so a legacy build is one flag away:
   ```bash
   npm install better-sqlite3@^11        # last line supporting Node 18
   docker build --build-arg NODE_VERSION=18 .
   ```
2. **Tailwind and Chart.js are compiled/vendored locally** instead of loaded from
   a CDN, so the dashboard works on an isolated network with no internet access.
   Rebuild with `npm run build` (requires dev dependencies for Tailwind only).
3. **`public/css/app.css` is committed** because the production image installs
   production dependencies only (no Tailwind). Re-run `npm run build:css` and
   commit the result whenever markup or class names change.
4. **Extra endpoints** beyond the brief (`/api/stats`, `/api/rules*`,
   `/api/rule-events`, `/api/devices/:id/telemetry`, `/api/mqtt/status`,
   `/api/webhook/command/ack`) exist to support the UI and device
   acknowledgement.

---

## 17. Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| Dashboard loads unstyled | `public/css/app.css` missing → `npm run build:css` |
| Header badge `MQTT: OFFLINE` | broker not running or wrong `MQTT_URL`. Inside compose it must be `mqtt://mqtt-broker:1883` |
| Commands stay `pending` | broker down **and** the device is not polling. Check `/api/mqtt/status`, then `docker compose logs mqtt-broker` |
| All devices show offline after a restart | expected — nodes re-register on their next message; polling devices recover on `/api/webhook/command/poll` |
| `SQLITE_IOERR` / "disk I/O error" | database on exFAT/NTFS/SMB → move to ext4 or a named volume (§10.4) |
| `EACCES` writing `/app/data` | `sudo chown -R 1000:1000 ./data` (container runs as `node`) |
| Ports already in use | `sudo lsof -i :3000` / `docker compose down` another stack |
| Terminal panel floods / UI sluggish | reduce ingest rate, use `FOCUS`, or raise `LOG_THROTTLE_MS` in `src/ingest.js` |
| Rule fires constantly | increase `cooldown_seconds`; the burst limiter caps 25 triggers / 5 s |
| Charts empty but devices online | only numeric values are charted; non-numeric payloads land in `raw_value` |
| `docker compose up` created an empty `./data` | external drive was not mounted (§10.4) |

---

## 18. Suggested next steps

1. Add webhook authentication (`WEBHOOK_TOKEN`) and Mosquitto password auth.
2. Ship a Grafana or CSV exporter consuming `GET /api/devices/:id/telemetry`.
3. Add per-device dashboards / historical roll-ups (hourly averages) to keep the
   `telemetry` table small on long-running deployments.
4. Implement OTA-update fan-out as a first-class command type with progress
   reporting through `iot/<id>/ack`.
5. Move rate limiting and stats caching to Redis if the server is ever scaled to
   more than one replica.
