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
                                           │  device_configs · forward_logs         │
                                           │  settings                              │
                                           └────────────────────────────────────────┘

       Browser ── HTTP (static + REST) ──▶ node-server
               └─ WebSocket (Socket.io) ─▶ live telemetry, commands, config, log stream

       node-server ── POST (async, retried) ──▶ MAIN_WEBSITE_WEBHOOK_URL
                     every accepted telemetry batch is mirrored upstream (§6.6)
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
| Upstream sync | `fetch` + in-process queue (`src/forwarder.js`) | mirrors every telemetry batch to the main website, off the ingest path (§6.6) |
| Container | Docker + Docker Compose | two services, one bridge network |

### Internal event flow (why modules stay decoupled)

`src/events.js` exposes a process-wide `EventEmitter` bus. Every transport funnels
through it:

```
HTTP webhook ─┐
              ├─▶ src/ingest.js ─▶ db.recordTelemetry() ─▶ bus "telemetry"
MQTT message ─┘                                             │
                                                            ├─▶ automation engine (rules)
                                                            ├─▶ Socket.io "telemetry_update"
                                                            └─▶ bus "ingest:batch" ─▶ src/forwarder.js
                                                                                       └─▶ POST MAIN_WEBSITE_WEBHOOK_URL

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
│   ├── db.js            schema, migrations, prepared statements, queries
│   ├── ingest.js        payload normalisation + persistence + fan-out
│   ├── forwarder.js     upstream forwarding queue (MAIN_WEBSITE_WEBHOOK_URL)
│   ├── automation.js    rule engine (cooldowns, burst limiter)
│   ├── mqtt.js          MQTT bridge (subscribe telemetry/status/ack, publish commands)
│   ├── events.js        internal event bus + logger
│   ├── middleware.js    rate limiting + request logging
│   └── routes/api.js    all REST endpoints and webhooks
├── public/
│   ├── index.html       dashboard markup (device grid + both modals)
│   ├── css/input.css    Tailwind source + neon theme (EDIT THIS)
│   ├── css/app.css      compiled stylesheet (BUILD ARTEFACT — do not edit)
│   ├── js/app.js        dashboard client (socket wiring, card grid, inspector
│   │                    modal, config editor, settings, terminals)
│   └── vendor/chart.umd.js   vendored Chart.js (offline-capable)
├── scripts/
│   ├── simulator.js     synthetic 200+ device fleet (dev tool — registers
│   │                    devices dynamically, exactly like real hardware)
│   ├── reset-db.js      wipes iot.db back to a schema-only, ZERO-device state
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
| Terminal box | `#05080A` | `.terminal` | log panels: device console (§3.2) and system log (§3.3) |
| Warning | `#FFB020` | `--color-warn` | stale device, broker offline |
| Danger | `#FF3B30` | `--color-danger` | errors, failed commands |
| Info / MQTT | `#22D3EE` | `--color-cyan` | sources in the terminal |

Glow effects are `text-shadow`/`box-shadow` in `public/css/input.css`
(`.glow-text`, `.glow-text-soft`, `.glow-border`, `.neon-title`, `.dot-online`
pulse, `.card-live-flash`, `.term-cursor` blink).

### 3.1 Device cards — the main monitoring surface

The dashboard body is deliberately only three things: header, stat strip and the
device grid. The global telemetry chart, the permanent side control panel and the
global terminal were removed from the main view — everything they did now lives in
modals (§3.2, §3.3), so the grid gets the full width and the operator's attention.

Every registered device renders as a **large card** (`public/js/app.js` →
`cardInner()`): minimum height **260 px**, laid out `1 → 2 → 3` columns
(mobile → md → xl, capped at three on desktop). A card deliberately carries
**only core information** — identity, liveness, address, the live number and when
it was last seen. Everything heavier lives one click away in the inspector (§3.2).

```
┌────────────────────────────────────────────────────┐
│ ESP32-TANK-01                        ◉ ONLINE      │  ← device id + status badge
│ Tank Node                                          │  ← name, only when it differs
│ IP 10.0.0.7                                        │  ← enlarged monospace address
│                                                    │
│ TEMPERATURE                                        │  ← which sensor is shown
│ 24.6 °C                                            │  ← huge glowing reading
│                                                    │
│ ────────────────────────────────────────────────── │
│ Updated 3 seconds ago                   INSPECT ▸  │  ← last ping
└────────────────────────────────────────────────────┘
```

**Headline reading.** `primarySensor()` picks the headline series — `temperature`
when present, otherwise the first sensor alphabetically — rendered by
`.reading-value` at `clamp(2.75rem, 5.6vw, 3.75rem)` (≈44–60 px, i.e. `text-5xl` /
`text-6xl`) in bold `#39FF14` with the unit as a suffix. The block reads
`AWAITING DATA` until the first frame arrives.

**What was removed from the card** (and where it went): MAC address, location,
secondary sensor readings, the custom-config tag summary and the inline
`RELAY ON` / `RELAY OFF` / `LOGS` buttons. All of it is in the inspector modal —
identity and configuration in the header/config tab, secondary readings in the
chart and stat strip, forwarding status in the logs tab. The card was reduced on
purpose: at 200+ nodes the grid is a scanning surface, not a control surface.

**Status badge / heartbeat rule.** A card is `ONLINE` while its last ping is
younger than **30 s** — the glowing neon-green dot pulses and the badge reads
`ONLINE`; past that window it flips to a dim red dot and `OFFLINE`. The rule is
applied in two places so the UI is never stale:

| Where | Constant | Notes |
| --- | --- | --- |
| Browser | `HEARTBEAT_MS = 30_000` (`public/js/app.js`) | re-evaluated every 5 s, so a card drops to OFFLINE without waiting for the server |
| Server | `OFFLINE_AFTER_SECONDS = 30` (`src/config.js`) | sweeper every 15 s emits `device_status` |

Keep the two values in sync when changing either one.

**Click-to-open.** The whole card is the control (`cursor: pointer`,
`role="button"`, `aria-label`, Tab + Enter work too) and opens the device
inspector for that node — see §3.2. No card contains a button any more: the relay
toggles, the command form and the per-device log all live in the modal, so a stray
click can never queue a command onto the fleet.

**Live updates without re-rendering.** When `telemetry_update` / `device_status`
arrives the matching card is patched in place (`updateCard()`): the headline
reading, its label and unit, the IP and the last-ping label. The
card then runs a ~0.9 s neon border flash (`.card-live-flash`) as a visual
"fresh data" cue — this is `box-shadow` only, so it never fights the
`is-selected` / hover border colours. A full grid re-render only happens when the
*composition* changes (a device enters/leaves the current filter or sort order),
which is detected by comparing a device-id signature at most every 500 ms.

**Sticky filter bar.** Search (device id / name / IP / MAC / location — the modal
still shows MAC, so it stays searchable even though it left the card),
`ALL DEVICES` / `ONLINE ONLY` / `OFFLINE ONLY` filters, sort, and the live census
`TOTAL: X | ONLINE: Y | OFFLINE: Z`. The bar is `position: sticky` beneath the
header; `--header-h` is published by a ResizeObserver so it stays aligned when the
top bar wraps on narrow screens. The census always counts the search-scoped set
(independent of the status filter), while the grid note shows
`showing N of M matching`.

Performance guards: `PAGE_SIZE = 12` of these large cards per page ("LOAD MORE"),
per-card patches instead of re-renders, Chart.js instances created only for the
open inspector, and heartbeat repaints every 5 s touching only visible cards.

**Empty state.** With nothing registered the grid renders one full-width
`.empty-state` tile instead of cards (`emptyState()` in `public/js/app.js`):

```
┌──────────────────────────────────────────────────────────────────────┐
│                              ● (pulsing neon dot)                     │
│                  NO IOT DEVICES REGISTERED YET                       │
│                     Waiting for incoming telemetry…                   │
│   A card appears here the instant a device reports in — this dashboard│
│   fabricates nothing. Post a reading, or publish to iot/<id>/telemetry│
│   $ curl -X POST /api/webhook/data …                                 │
└──────────────────────────────────────────────────────────────────────┘
```

The headline is `1.75rem` neon with a glow, the copy is `1.0625rem`, and the
snippet sits in a bordered `#05080A` code block. A second flavour
(`NO MATCHING DEVICES`) is shown when devices exist but the current search/filter
matches none, so an over-eager filter never looks like a dead server. The grid
note underneath reads `waiting for the first device to report in` in the first
case and `no devices match the current filter` in the second.

### 3.2 Device inspector modal

Clicking any card opens `#device-modal` — a full-screen Space-Black (`#06090B`)
surface with neon accents, scoped to exactly one device. One DOM tree is reused for
every node (no per-card markup); it is populated from `GET /api/devices/:id` and
then kept live by the socket stream.

**Header.** Device name (title), then `device_id · IP · MAC · location` (subtitle),
the ONLINE/OFFLINE badge, `✕ CLOSE` — and `Esc` closes it too.

Inside the `TELEMETRY` tab a four-block stat strip carries **Last ping**,
**Location**, **Firmware** and **Config revision**, and the `COMMANDS` tab has the
seven quick-command chips: `RELAY_ON`, `RELAY_OFF`, `STATUS`, `CALIBRATE`,
`REBOOT`, `OTA_UPDATE`, `CONFIG_SYNC`.

**Four tabs** (`data-modal-tab`, one panel visible at a time):

| Tab | Contents |
| --- | --- |
| `TELEMETRY` | Chart.js line graph for **this device only** — sensor picker, `5m / 15m / 1h / 6h / 24h` window (default 15m), `● LIVE` pause, min/max/avg/sample readout. History is backfilled over `request:history`; new points arrive on `telemetry_update` while the tab is live. |
| `COMMANDS` | Payload mode `TEXT` / `JSON` with validation, glowing send button, and the 20 most recent commands for this device with status pills. |
| `CONFIG` | The custom device configuration editor (§3.4). |
| `LOGS` | Live console for this device only — `#dm-terminal`, `#05080A`, monospace, blinking cursor, `PAUSE` / `CLEAR`, line counter. Backfilled from REST history, then streamed live. |

**The per-device log is deliberately not the global log.** The server throttles the
system log to 25 lines/s (`TERMINAL_MAX_LINES_PER_SEC`, `src/server.js`) so a
220-node fleet cannot flood a browser; a device console riding that stream would be
full of holes. Telemetry therefore reaches it straight from the client's
`telemetry_update` handler (`onTelemetry()` → `pushDeviceLog()`), which is never
throttled. Command, MQTT, forwarding and rule lines are mirrored from the system log
by `mirrorToDeviceLog()`, filtered on `meta.device_id` — and mirrored **before** the
system log's own `FOCUS`/`PAUSE` filters, because narrowing the global log must not
silently stop the device console. Ingest lines are excluded there
(`entry.meta.sensor_name`) precisely because `onTelemetry` already covers them.

**Unsaved config edits are protected.** The modal refetches the device document
whenever a `forward_log` event lands for the open device. `renderConfigEditor()`
refuses to repaint while `state.device.configDirty` is set, so that background
refresh cannot wipe a half-typed config; the status line then reads
`draft in progress — newer revision not loaded`. The flag clears on save
(`renderConfigEditor(saved, { force: true })`) and when another device is opened.

### 3.3 Settings modal

`#settings-modal` collects the operator surfaces that used to be permanent panels.
Four tabs:

| Tab | Contents |
| --- | --- |
| `FORWARDING` | Upstream webhook URL + enable toggle, `TEST`, `SAVE`, live queue / delivered / failed counters and the recent `forward_logs` table — see §6.6. Saving calls `PATCH /api/settings` and broadcasts `settings_changed`. |
| `AUTOMATION` | Rule list with neon toggles, delete buttons, trigger counts, the "new rule" form and the recent-trigger feed. |
| `QUEUE` | The last 50 commands with status pills (`pending` / `delivered` / `acked` / `failed`). |
| `SYSLOG` | The global terminal — deep-black `#05080A`, blinking cursor, `FOCUS` (webhooks, commands and rules only), `PAUSE`, `CLEAR`, 400-line window. |

### 3.4 Device custom configuration (and the ESP boot loop)

Per-device JSON keyed by device id, revisioned in SQLite (`device_configs`, §4).
The editor presents two views over the same draft:

- **Form** — one row per key (`.cfg-row`) with the input type inferred from the
  JSON value (`number` / `checkbox` / text), plus `+ ADD FIELD` and a per-row `✕`.
  Editing a row rewrites the JSON pane (`syncJsonFromForm()`).
- **Raw JSON** — the source of truth on save. Each keystroke is parsed after a
  220 ms debounce and, when valid, regenerates the form (`syncFormFromJson()`).
  Invalid JSON shows a red `✗ …` message; nothing is saved until it parses.

`SAVE & SYNC TO ESP` → `POST /api/device/:id/config`. The server bumps `revision`,
upserts the row, emits `device_config` so every open dashboard updates, and — when
`NOTIFY DEVICE` is ticked — queues a `CONFIG_SYNC` command so the node re-reads its
settings over MQTT or HTTP polling. `GET /api/device/:id/config` is the read side; a
device that has never saved anything gets the firmware defaults with
`has_custom: false` rather than a 404, which is exactly what the boot sequence in
§6.7 relies on. A realistic starting set:

```json
{
  "sample_rate_ms": 1000,
  "temp_threshold": 33,
  "relay_pin": 2,
  "mqtt_interval_ms": 5000
}
```

### Typography

Monospace everywhere (`--font-mono`: JetBrains Mono → IBM Plex Mono → Fira Code →
system UI monospace). Metrics, telemetry readouts, terminal lines and the grid all
use it, matching the operator-console aesthetic. No web fonts are downloaded, so
the dashboard renders identically on an offline LAN.

**The scale was raised one notch across the board** so the console reads from a
distance (wall display / shop floor). `@theme` overrides Tailwind's defaults and
the `.component` sizes in `public/css/input.css` follow them:

| Element | Class | Size | ≈ px |
| --- | --- | --- | --- |
| Live sensor reading (card) | `.reading-value` | `clamp(2.75rem, 5.6vw, 3.75rem)` | 44 → 60 |
| Header title | `h1.neon-title` | `1.25–1.5rem` | 20 – 24 |
| Summary metric value | `.stat-value` | `2.25rem` | 36 |
| Device id (card) | `.device-id` | `1.25rem` | 20 |
| Modal title | `.modal-title` | `1.625rem` | 26 |
| IP / metadata, modal subtitle, terminal lines | `.device-ip`, `.modal-sub`, `.terminal-body` | `1.0625rem` | 17 |
| Tabs, buttons, badges, labels, config inputs | `.tab`, `.btn`, `.badge`, `.label`, `.cfg-key/.cfg-val` | `0.9375–1.0625rem` | 15 – 17 |
| Small print | `text-sm` | `0.9375rem` | 15 |

There is no text smaller than 13 px anywhere in the UI (`--text-xs`), and no
`text-[0.5x rem]` arbitrary sizes remain — every one was replaced with a scale
step. Terminal bodies grew to `1.0625rem` with `1.45` line-height, and their boxes
were raised to 400 px (device inspector) / 520 px (system log) so the same number
of lines still fit.

### Layout

1. **Header** — glowing `IOT // DASHBOARD`, `SYSTEM STATUS: ACTIVE`, MQTT badge,
   socket link, `⚙ SETTINGS` / `▚ SYSTEM LOG` buttons, clock.
2. **Summary metrics** — exactly four tiles: **Total devices**, **Online**,
   **Offline**, **Forwarded webhooks**, each a `2.25rem` neon number under a
   `text-sm` label. Everything else that used to sit here (readings/min, configured
   count, queued commands, uptime) moved into the settings modal or `/api/health`.
3. **Device grid** — the entire body: large clickable cards (§3.1) beneath a
   sticky search / status-filter / census bar, paginated with `LOAD MORE`.
4. **Device inspector modal** — per-device real-time chart, command panel, custom
   configuration editor, device-scoped console and that device's upstream webhook
   status (§3.2).
5. **Settings modal** — upstream data forwarding, automation rules, the command
   queue and the global system log (§3.3).

---

## 4. Data model (`data/iot.db`)

| Table | Purpose | Key columns |
| --- | --- | --- |
| `devices` | registered nodes + liveness | `device_id` PK, `name`, `ip`, `mac`, `location`, `firmware`, `status` (`online`/`offline`), `last_seen`, `last_payload`, `first_seen`, `updated_at` |
| `telemetry` | append-only time series | `id` PK, `device_id`, `sensor_name`, `value` (REAL), `raw_value` (non-numeric), `unit`, `created_at` |
| `latest_telemetry` | one row per device+sensor | PK `(device_id, sensor_name)` — O(1) device-card metric rendering |
| `commands` | command queue + audit | `id` PK, `device_id`, `payload`, `status`, `source`, `transport`, `mqtt_topic`, `created_at`, `delivered_at`, `acked_at`, `error` |
| `automation_rules` | threshold rules | `id` PK, `name`, `device_id` (`*` = fleet-wide), `sensor_name`, `operator`, `threshold`, `action`, `action_payload`, `enabled`, `cooldown_seconds`, `last_triggered`, `trigger_count` |
| `rule_events` | automation audit trail | `rule_id`, `device_id`, `sensor_name`, `value`, `operator`, `threshold`, `action`, `created_at` |
| `device_configs` | per-device custom configuration | `device_id` PK, `config` (JSON text), `revision`, `updated_by`, `updated_at` |
| `forward_logs` | upstream forwarding audit trail | `id` PK, `device_id`, `url`, `status` (`success`/`failed`/`dropped`), `http_status`, `duration_ms`, `error`, `source` (`http`/`mqtt`), `created_at` |
| `settings` | runtime-overridable system settings | `key` PK, `value`, `updated_at`, `updated_by` |

### 4.1 Empty by design — there is no mock data

**A fresh database contains zero devices.** `src/db.js` has no device seeder at
all — the factory-fixture generator that used to create 220 fake offline
"Sensor Node" rows (plus demo configs and a demo MAC scheme) was deleted, together
with the old `scripts/seed.js`.

| What creates rows | When |
| --- | --- |
| `POST /api/webhook/data` | a device posts its first reading → `upsertDevice()` registers it |
| MQTT `iot/<id>/telemetry` | same path, `source: 'mqtt'` |
| `GET/POST /api/webhook/command/poll` | a polling device refreshing its liveness |
| `POST /api/device/:id/config` | an operator saving a config from the dashboard |
| **nothing at boot** | the server only ensures the baseline automation rules |

The one thing written on an empty database is the four baseline automation rules
(`seedDefaultRules()`), because they are operator *configuration* rather than
data, and the Automation tab would otherwise have nothing to show. Disable with
`SEED_DEFAULT_RULES=false` if you want a truly blank install.

Consequences worth knowing:

- The dashboard shows `NO IOT DEVICES REGISTERED YET / Waiting for incoming
telemetry…` until real hardware reports in (§3.1). This is the expected first-run
state, not a fault.
- Device `name`, `ip`, `mac`, `location` and `firmware` are only ever what the
device itself sent — nothing is invented, so a card showing `IP —` simply means
that node has not reported an address yet.
- `scripts/simulator.js` is a **development** tool, not a seeder: it POSTs (or
publishes) telemetry for virtual nodes, so those devices are created by the same
code path as real ones. Nothing it does happens automatically.
- `npm run db:reset` (`scripts/reset-db.js`) wipes `iot.db` back to this state —
schema only, 0 devices, 0 telemetry rows, baseline rules.

Indexes exist on `telemetry(device_id, sensor_name, created_at DESC)`,
`telemetry(created_at DESC)`, `commands(device_id, status, id)`,
`devices(status, last_seen DESC)`, `rule_events(created_at DESC)`.

Schema version is tracked in `PRAGMA user_version`:

| Version | Change |
| --- | --- |
| `1` | initial build |
| `2` | `devices.mac` (rendered on the device cards) |
| `3` | `device_configs`, `forward_logs`, `settings` (device inspector + upstream forwarding) |

Migrations are additive and run on boot in `src/db.js` → `migrate()`:
`CREATE TABLE IF NOT EXISTS` never alters an existing table, so column additions
are applied explicitly (`ALTER TABLE devices ADD COLUMN mac TEXT` when
`PRAGMA table_info(devices)` lacks it) and both steps are logged:

```
[DB] migration applied: devices.mac (schema v2)
[DB] schema version 1 -> 2
[DB] schema version 2 -> 3
```

**Liveness (heartbeat):** a device is `online` while telemetry/status/poll traffic
arrives. A sweeper runs every `SWEEP_INTERVAL_SECONDS` (15 s) and flips devices to
`offline` when `last_seen` is older than `OFFLINE_AFTER_SECONDS` (**30 s**). The
browser applies the same 30 s rule on the cards (see §3.1). On server restart all
devices are re-armed to `offline` and re-appear as they report.

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

### 6.1 Device → server (public webhooks)

| Method | Path | Body / query | Purpose |
| --- | --- | --- | --- |
| `POST` | `/api/webhook/data` | `{device_id, sensor_name, value, unit?, mac?}` — or `sensors{}`, `metrics{}`, `readings[]`; bare `text/plain` number allowed | ingest telemetry, upsert device, run automation |
| `POST` | `/api/webhook/command` | `{device_id, command}` or `{device_id, payload}` (plain text also accepted) | queue a command and publish it to MQTT |
| `GET` | `/api/webhook/command/poll` | `?device_id=ESP32-0001&limit=20` | HTTP-polling devices collect pending commands (marks them `delivered`, refreshes liveness) |
| `POST` | `/api/webhook/command/ack` | `{command_id, status:"acked"\|"failed", error?}` | device confirms execution |
| `GET` | `/api/device/:deviceId/config` | — | **boot-time config pull** for the firmware: the saved JSON plus defaults, `revision` and `has_custom` (§6.7). The plural alias `/api/devices/:deviceId/config` behaves identically |

### 6.2 Dashboard / integration API

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/api/health` | service, version, uptime, MQTT state, ingest counters, automation stats |
| `GET` | `/api/stats` | device/telemetry/command/rule counters + clients |
| `GET` | `/api/mqtt/status` | broker connection detail, reconnects, last error |
| `GET` | `/api/devices` | `?search=&limit=&offset=&sparkline=&sparkline_points=` — every device with latest metrics; `search` also matches `mac`; `sparkline=true` adds the last N samples per sensor (off by default: ~45 ms / ~380 KB for a 1000-device fleet) |
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
| `GET` | `/api/device/:deviceId/config` | saved config + defaults for one device (`has_custom`, `revision`, `updated_at`). Also mounted as `/api/devices/:deviceId/config` |
| `POST` | `/api/device/:deviceId/config` | `{config, sync?, updated_by?}` — save a revision; `sync:true` also queues `CONFIG_SYNC`. Broadcasts `device_config` |
| `DELETE` | `/api/device/:deviceId/config` | drop the saved config, reverting the node to firmware defaults |
| `GET` | `/api/settings` | `{settings, effective, env, runtime}` — forwarding status incl. queue/delivered/failed counters |
| `PATCH` · `POST` | `/api/settings` | `{main_website_webhook_url, forwarding_enabled}` — runtime override, persisted in SQLite and broadcast as `settings_changed` |
| `DELETE` | `/api/settings/:key` | remove a runtime override, falling back to `.env`/default |
| `GET` | `/api/forward-logs` | `?device_id=&limit=50` — delivery audit trail + aggregate stats |
| `POST` | `/api/forward/test` | `{url?}` — send one probe payload upstream now; `502` when the remote rejects it |

### 6.3 Examples

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

### 6.4 Accepted ingest payload shapes

The ingest pipeline normalises whatever a firmware can realistically send:

```jsonc
{ "device_id": "ESP32-0001", "sensor_name": "temperature", "value": 24.1 }
{ "device_id": "ESP32-0001", "sensors": { "temperature": 24.1, "humidity": 51 } }
{ "device_id": "ESP32-0001", "sensors": { "temperature": { "value": 24.1, "unit": "C" } } }
{ "device_id": "ESP32-0001", "readings": [ { "sensor_name": "temperature", "value": 24.1 } ] }
{ "device": "ESP32-0001", "metric": "co2", "val": 780 }        // aliases accepted
```

Optional metadata alongside any shape: `ip`, `mac`, `name`, `location`,
`firmware`, `unit`, `ts`/`timestamp` (epoch ms). `ip` and `mac` are only taken
from the payload — never from the HTTP source address, which may be a proxy or
NAT address and would overwrite good data. Non-numeric values (`"OPEN"`, `"n/a"`) are
stored in `raw_value` for audit but are not charted and cannot trigger rules.
Sensor names are normalised: lower-cased, spaces/odd characters → `_`, max 64 chars.

### 6.5 Command payloads reaching a device

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

### 6.6 Upstream forwarding to the main website

Every accepted telemetry batch — MQTT or `POST /api/webhook/data` — is mirrored to
`MAIN_WEBSITE_WEBHOOK_URL` so the main website keeps its own copy of the fleet.
Implementation: `src/forwarder.js`.

**Turning it on** (either way; the dashboard wins when both are set):

1. **From the UI (preferred).** Settings modal → `FORWARDING` tab → paste the URL,
tick *enabled*, `SAVE`. This writes the `settings` rows
`MAIN_WEBSITE_WEBHOOK_URL` / `MAIN_WEBSITE_FORWARD_ENABLED` in SQLite
(`source: database`), so it survives restarts and needs no container change. Use
`TEST` to fire a probe payload immediately.
2. **From `.env` / compose** — `MAIN_WEBSITE_WEBHOOK_URL=https://main.example.com/api/iot`
and `MAIN_WEBSITE_FORWARD_ENABLED=true`, then restart (`source: env`).

`GET /api/settings` reports both layers so you can always tell which one is in
effect (`effective.source` = `database` | `env` | `unset`).

**What is posted** (`POST`, `Content-Type: application/json`):

```json
{
  "source": "iot-dashboard",
  "event": "telemetry",
  "transport": "mqtt",
  "received_at": 1789195778000,
  "device": { "device_id": "ESP32-0001", "name": "Tank Node 1", "ip": "10.1.1.10", "mac": "A4:CF:12:00:01", "location": "Greenhouse", "firmware": "1.4.2", "status": "online" },
  "sensors": { "temperature": 31.4, "humidity": 48 },
  "readings": [ { "sensor_name": "temperature", "value": 31.4, "unit": "C", "created_at": 1789195778000 } ],
  "raw": { "device_id": "ESP32-0001", "sensors": { "temperature": 31.4 } }
}
```

Headers carry `X-IoT-Source: iot-dashboard` and `X-IoT-Device: <device_id>` so the
receiving site can route or filter without parsing the body. `raw` is the exact
payload the device sent (truncated to `FORWARD_MAX_PAYLOAD_BYTES`).

**Delivery guarantees.** Asynchronous by construction: ingest never waits for the
upstream site, the batch goes on an in-memory queue drained by
`FORWARD_CONCURRENCY` workers. `FORWARD_RETRIES` retries with linear backoff on
network errors, `408`, `429` and `5xx`; other `4xx` fail immediately (a bad URL
will not be hammered). Beyond `FORWARD_MAX_QUEUE` jobs the oldest are **dropped and
counted**, never silently lost — `dropped` is on `/api/settings`.

Every attempt lands in `forward_logs` and is broadcast as the `forward_log` socket
event, which is what the FORWARDING tab renders: `status`, `http_status`,
`duration_ms`, `attempt`, `error`, `created_at`. The device inspector also shows
`✓ success (HTTP 200)` or `✗ failed …` for the device you have open.

> Measured on this build: with an unreachable upstream URL, `POST /api/webhook/data`
> still returns in **2–3 ms** — forwarding is provably off the ingest path.

**Relevant env vars** (see §11): `MAIN_WEBSITE_WEBHOOK_URL`,
`MAIN_WEBSITE_FORWARD_ENABLED`, `FORWARD_TIMEOUT_MS` (8000),
`FORWARD_RETRIES` (2), `FORWARD_CONCURRENCY` (4), `FORWARD_MAX_QUEUE` (5000),
`FORWARD_RETRY_BACKOFF_MS` (1500), `FORWARD_MAX_PAYLOAD_BYTES` (16384).

**Receiving end — minimal Express example:**

```js
app.post('/api/iot', (req, res) => {
  const { device, sensors, received_at } = req.body;
  console.log(`[${device.device_id}] ${JSON.stringify(sensors)} @ ${received_at}`);
  res.json({ ok: true }); // anything 2xx counts as delivered
});
```

### 6.7 ESP / Arduino boot-time configuration

A device can configure itself from the server on every boot, so re-provisioning a
node never means re-flashing it:

```cpp
// 1. ask for the config first
HTTPClient http;
http.begin(String(BASE_URL) + "/api/device/" + DEVICE_ID + "/config");
int code = http.GET();
if (code == 200) {
  DynamicJsonDocument doc(2048);
  deserializeJson(doc, http.getString());
  // `config` already contains firmware defaults for keys never saved,
  // and `saved` contains only what the operator set.
  int   sampleRate  = doc["config"]["sample_rate_ms"]  | 5000;
  float tempLimit   = doc["config"]["temp_threshold"] | 30.0;
  int   relayPin    = doc["config"]["relay_pin"]      | 2;
  long  mqttEvery   = doc["config"]["mqtt_interval_ms"] | 5000;
  if (doc["has_custom"].as<bool>()) Serial.println("using saved config");
}
http.end();

// 2. then start reporting telemetry with those values
```

Notes for firmware authors:

- **Never 404s.** An unknown or never-configured device gets the defaults with
  `has_custom: false` (see the `GET` example in §6). That is deliberate: a factory-fresh
  board must be able to boot without an operator pre-registering it.
- `revision` increments on every save, so a device can cache its config and only
  re-fetch when the number changes. `updated_at` is epoch ms.
- When the dashboard saves with **NOTIFY DEVICE** ticked, the server also queues a
  `CONFIG_SYNC` command (`POST /api/webhook/command` path, so MQTT *and* HTTP
  polling both work) — a running device can pick up its settings without a reboot.
  That command payload already carries the new values, so firmware may apply it
  inline…
  ```json
  { "action": "CONFIG_SYNC", "revision": 4, "config": { "sample_rate_ms": 2000, "temp_threshold": 33 }, "issued_at": 1789207170199 }
  ```
  …or simply re-fetch `GET /api/device/<id>/config`, which is what both sketches in
  §9.2 and §9.3 do (one extra HTTP round-trip, and it guarantees defaults are merged
  in and the `revision` is not stale).
- A sensible set of keys (`sample_rate_ms`, `temp_threshold`, `relay_pin`,
  `mqtt_interval_ms`) is returned as defaults, so a first-boot parse always finds
  something to fall back on. Extra keys are preserved verbatim.
- `DELETE /api/device/:id/config` wipes the saved row and returns the node to
  defaults — handy when a bad config bricks a test rig.

Both complete firmware sketches in §9.2 (MQTT + HTTP fallback) and §9.3 (HTTP
polling) implement this call, including live re-read on `CONFIG_SYNC`, so start
from those rather than writing the bootstrap from scratch.

---

## 7. Socket.io events

Client connects to the same origin (Socket.io client is served by the server at
`/socket.io/socket.io.js`). Everything the device grid needs arrives over this
channel — the grid never polls REST.

| Direction | Event | Payload |
| --- | --- | --- |
| S→C | `bootstrap` | full snapshot on connect: `{stats, devices[], total_devices, rules[], rule_events[], commands[], recent_telemetry[], mqtt, ingest, terminal[], server_time, version}` |
| S→C | `telemetry_update` | `{device_id, sensor_name, value, unit, created_at}` |
| S→C | `device_status` | device row — registration / online / offline transition |
| S→C | `device_update` | identical payload to `device_status` (backwards-compatible alias, both are emitted) |
| S→C | `command_sent` / `command_delivered` / `command_acked` | command row |
| S→C | `rule_triggered` | `{rule, reading, command}` |
| S→C | `rules_changed` | full rule list |
| S→C | `stats` | counters + `clients`, every 5 s |
| S→C | `mqtt_status` | broker state on change |
| S→C | `terminal` | `{level, source, message, ts, meta?}` — the system log in the settings modal; `meta.device_id` is what the device inspector filters on |
| S→C | `device_config` | `{device_id, config, saved, revision, updated_at, has_custom}` — emitted on every save, so all dashboards and the device card's config tags stay in sync |
| S→C | `forward_log` | `{id, device_id, url, status, http_status, attempt, duration_ms, error?, created_at}` — one per upstream delivery attempt |
| S→C | `settings_changed` | the raw `settings` map after any write (the client then refetches `GET /api/settings` for the `effective` view) |
| C→S | `request:snapshot` | ack callback receives a fresh snapshot |
| C→S | `request:history` | `{device_id, sensor_name, limit, since_ms}` → ack with `points[]` |
| C→S | `request:devices` | `{search}` → ack with the device list (includes `sparkline`) |

### 7.1 Payload structures the device grid consumes

`bootstrap` → `devices[]` (each entry is a `devices` row plus live state):

```json
{
  "device_id": "ESP32-0006",
  "name": "Tank Node 6",
  "ip": "10.1.6.10",
  "mac": "A4:CF:12:00:00:06",
  "location": "Greenhouse",
  "firmware": "v1.3.0",
  "status": "online",
  "last_seen": 1789196568081,
  "metrics": {
    "temperature": { "value": 24.63, "unit": "°C", "ts": 1789196568081 },
    "humidity": { "value": 51.2, "unit": "%", "ts": 1789196568081 }
  },
  "config": { "sample_rate_ms": 1000, "temp_threshold": 33, "relay_pin": 2 },
  "config_revision": 3,
  "config_updated_at": 1789196500000
}
```

`config` / `config_revision` / `config_updated_at` drive the inspector's CONFIG
tab (`revision N`, `saved · …`); a device with nothing saved has `{}` and revision
`0`. They are no longer rendered on the card itself (§3.1).

`sparkline` is a separate field on the same object (last 10 points per sensor,
built by the `bootstrap` snapshot). Cards no longer draw sparklines, but it is
still served because `bootstrap` also feeds the inspector's chart history and
because `GET /api/devices?sparkline=true` is useful to other clients.

`telemetry_update` — one frame per sensor reading (also emitted for MQTT ingest).
`source` is added to the socket copy only (it is not a column) so the device
inspector can label the line `HOOK` or `MQTT`:

```json
{ "device_id": "ESP32-0006", "sensor_name": "temperature", "value": 24.63, "unit": "°C",
  "created_at": 1789196568081, "source": "http" }
```

`device_status` / `device_update` — sent only when a row is new or the liveness
state flips (so a 220-node fleet does not flood the socket):

```json
{ "device_id": "ESP32-0006", "name": "Tank Node 6", "ip": "10.1.6.10", "mac": "A4:CF:12:00:00:06",
  "location": "Greenhouse", "firmware": "v1.3.0", "status": "online", "last_seen": 1789196568081,
  "last_payload": "{\"sensor\":\"temperature\",\"value\":24.63,\"unit\":\"°C\"}",
  "first_seen": 1789196000000, "updated_at": 1789196568081 }
```

`command_sent` / `command_delivered` / `command_acked`:

```json
{ "id": 5, "device_id": "ESP32-0006", "payload": "{\"action\":\"RELAY_ON\",\"source\":\"quick-action\"}",
  "status": "pending", "source": "ui", "transport": "mqtt", "mqtt_topic": "iot/ESP32-0006/command",
  "created_at": 1789196568081, "delivered_at": null, "acked_at": null, "error": null }
```

`rule_triggered`:

```json
{ "rule": { "id": 1, "name": "Cool down when hot", "sensor_name": "temperature", "operator": ">",
            "threshold": 30, "action": "RELAY_OFF", "device_id": "*", "trigger_count": 4 },
  "reading": { "device_id": "ESP32-0008", "sensor_name": "temperature", "value": 51.97, "unit": "°C", "created_at": 1789196568272 },
  "command": { "id": 6, "device_id": "ESP32-0008", "status": "pending", "source": "automation" } }
```

### 7.2 What each event updates on a card

| Event | Where it lands |
| --- | --- |
| `telemetry_update` | card: headline reading (`[data-role="reading"]`), its sensor label + unit, `Updated …` label, heartbeat badge, then the card flash — **and** if that device is open, the inspector chart point plus a line in its console |
| `device_status` / `device_update` | card: status dot + badge + IP, reorder/insertion (throttled grid reconciliation, ≤1 re-render / 500 ms); the open inspector's header refreshes too |
| `device_config` | the open inspector's CONFIG tab and `rev N` chip (unless it holds an unsaved draft, §3.2) |
| `forward_log` | FORWARDING tab table + counters; a `FWD` line in the device console when it belongs to the open device; other dashboards' cards are untouched |
| `command_sent` / `…delivered` / `…acked` | inspector command history, the QUEUE tab table, and a `CMD` line in the open device's console |
| `rule_triggered` | toast, recent-trigger list, `trigger_count`, and the queued command |
| `terminal` | system log (settings modal) — mirrored into the device console only for non-telemetry lines (§3.2) |
| `settings_changed` | FORWARDING tab inputs/status |

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

These four rules are the **only** thing written to a fresh database — no devices,
no telemetry (§4.1). They are created by `db.seedDefaultRules()` when the rules
table is empty, and skipped entirely with `SEED_DEFAULT_RULES=false`:

| Rule | Condition | Action |
| --- | --- | --- |
| Cool down when hot | `temperature > 30` | `RELAY_OFF` |
| Heat when cold | `temperature < 16` | `RELAY_ON` |
| Ventilate on CO2 spike | `co2 > 1000` | `FAN_ON` |
| Low battery warning | `battery < 20` | `SEND_ALERT` (`battery_low`) |

Because the fleet is empty on first boot, none of them can fire until a device
reports a matching sensor — they sit in the Automation tab waiting.

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

// Firmware defaults — overwritten by GET /api/device/<id>/config at boot.
int           relayPin       = 2;          // onboard LED is fine for testing
unsigned long sendIntervalMs = 5000;
float         tempThreshold  = 30.0;
long          configRevision = 0;

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

  if (action != nullptr && strcmp(action, "RELAY_ON") == 0)       digitalWrite(relayPin, HIGH);
  else if (action != nullptr && strcmp(action, "RELAY_OFF") == 0) digitalWrite(relayPin, LOW);
  else if (action != nullptr && strcmp(action, "STATUS") == 0) { /* report immediately */ }
  else if (action != nullptr && strcmp(action, "CONFIG_SYNC") == 0) loadConfig();
  else if (raw.indexOf("RELAY_ON") >= 0)  digitalWrite(relayPin, HIGH);
  else if (raw.indexOf("RELAY_OFF") >= 0) digitalWrite(relayPin, LOW);

  if (commandId > 0) publishAck(commandId, "acked");
}

// Boot-time provisioning: pull this device's saved configuration (§6.7). The
// endpoint merges firmware defaults in and never 404s, so a factory-fresh board
// is safe to call it before it has ever reported. `SAVE & SYNC TO ESP` in the
// dashboard queues CONFIG_SYNC, which calls this again without a reboot.
void loadConfig() {
  if (WiFi.status() != WL_CONNECTED) return;
  HTTPClient http;
  http.begin(String(API_BASE) + "/api/device/" + DEVICE_ID + "/config");
  if (http.GET() == 200) {
    StaticJsonDocument<512> doc;
    if (!deserializeJson(doc, http.getString())) {
      sendIntervalMs = doc["config"]["sample_rate_ms"] | sendIntervalMs;
      tempThreshold  = doc["config"]["temp_threshold"] | tempThreshold;
      relayPin       = doc["config"]["relay_pin"]      | relayPin;
      configRevision = doc["revision"] | 0;
      Serial.printf("config rev %ld: %lu ms, threshold %.1f C, pin %d\n",
                    configRevision, sendIntervalMs, tempThreshold, relayPin);
    }
  }
  http.end();
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
  pinMode(relayPin, OUTPUT);
  digitalWrite(relayPin, LOW);

  snprintf(topicTelemetry, sizeof(topicTelemetry), "iot/%s/telemetry", DEVICE_ID);
  snprintf(topicCommand,   sizeof(topicCommand),   "iot/%s/command",   DEVICE_ID);
  snprintf(topicAck,       sizeof(topicAck),       "iot/%s/ack",       DEVICE_ID);

  connectWifi();
  loadConfig();                 // provisioning before the first reading
  mqtt.setServer(MQTT_HOST, MQTT_PORT);
  mqtt.setCallback(onCommand);
  connectMqtt();
}

void loop() {
  connectWifi();
  if (!mqtt.connected()) connectMqtt();
  mqtt.loop();

  if (millis() - lastSend >= sendIntervalMs) {
    lastSend = millis();
    float temperature = 20.0 + random(0, 1500) / 100.0;   // replace with real sensor
    float humidity    = 40.0 + random(0, 3000) / 100.0;

    // Local safety net using the threshold from the config above. The server's
    // automation rules also act on this reading — belt and braces, so the node
    // still protects itself if the link drops.
    digitalWrite(relayPin, temperature > tempThreshold ? LOW : HIGH);

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

Useful when the board cannot reach the broker at all: it posts readings and polls
for commands over HTTP. It also provisions itself from
`GET /api/device/<id>/config` at boot.

```cpp
#include <ESP8266WiFi.h>
#include <ESP8266HTTPClient.h>
#include <ArduinoJson.h>

const char* WIFI_SSID = "YOUR_WIFI";
const char* WIFI_PASS = "YOUR_PASSWORD";
const char* API_BASE  = "http://192.168.1.50:3000";
const char* DEVICE_ID = "ESP8266-01";

// Firmware defaults — overwritten by loadConfig().
float         tempThreshold = 30.0;
unsigned long sampleMs      = 5000;

unsigned long lastSend = 0, lastPoll = 0;

// Pull this node's saved settings. The endpoint merges defaults in and never
// 404s, so a brand-new board can call it before it has ever reported (§6.7).
void loadConfig() {
  HTTPClient http;
  http.begin(String(API_BASE) + "/api/device/" + DEVICE_ID + "/config");
  if (http.GET() == 200) {
    StaticJsonDocument<512> doc;
    if (!deserializeJson(doc, http.getString())) {
      tempThreshold = doc["config"]["temp_threshold"] | tempThreshold;
      sampleMs      = doc["config"]["sample_rate_ms"]  | sampleMs;
      Serial.printf("config rev %d: %lu ms interval, threshold %.1f C\n",
                    doc["revision"].as<int>(), sampleMs, tempThreshold);
    }
  }
  http.end();
}

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
    if (payload.indexOf("RELAY_ON")     >= 0) digitalWrite(LED_BUILTIN, LOW);
    if (payload.indexOf("RELAY_OFF")    >= 0) digitalWrite(LED_BUILTIN, HIGH);
    if (payload.indexOf("CONFIG_SYNC")  >= 0) loadConfig();   // re-read settings live

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
  loadConfig();                       // provisioning before the first reading
}

void loop() {
  if (millis() - lastSend > sampleMs) { lastSend = millis(); postReading("temperature", 22.0 + random(0, 900) / 100.0, "C"); }
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
| `NODE_ENV` | `development` | reported by `/api/health`; `production` also silences the per-forward success log (1 in 50 still prints) |
| `PORT` / `HOST` | `3000` / `0.0.0.0` | HTTP + Socket.io bind |
| `DB_PATH` | `./data/iot.db` | SQLite file (created with parent dirs) |
| `MQTT_URL` | `mqtt://localhost:1883` | broker URL (**`mqtt://mqtt-broker:1883` inside compose**) |
| `MQTT_USERNAME` / `MQTT_PASSWORD` | – | set when `allow_anonymous false` |
| `MQTT_CLIENT_ID` | `iot-dashboard-server` | a random suffix is appended per boot |
| `MQTT_TELEMETRY_TOPIC` | `iot/+/telemetry` | subscription |
| `MQTT_COMMAND_TOPIC_TEMPLATE` | `iot/{device_id}/command` | publish topic |
| `MQTT_TELEMETRY_ENABLED` | `true` | set `false` for webhook-only deployments |
| `OFFLINE_AFTER_SECONDS` | `30` | heartbeat: silence before a node is marked offline. Keep in sync with `HEARTBEAT_MS` in `public/js/app.js` |
| `SWEEP_INTERVAL_SECONDS` | `15` | liveness sweep cadence |
| `TELEMETRY_RETENTION_DAYS` | `14` | hourly prune (`0` disables) |
| `TELEMETRY_MAX_ROWS` | `2000000` | hard row cap, oldest trimmed first |
| `SEED_DEFAULT_RULES` | `true` | create the 4 baseline automation rules on an empty rules table. A fresh DB has **0 devices** either way — there is no device seeder |
| `RATE_LIMIT_WINDOW_SECONDS` / `RATE_LIMIT_MAX_REQUESTS` | `60` / `600` | per-IP throttle on `/api` |
| `MAIN_WEBSITE_WEBHOOK_URL` | *(empty)* | upstream site that receives a copy of every telemetry batch (§6.6). Overridable at runtime from the Settings modal |
| `MAIN_WEBSITE_FORWARD_ENABLED` | `false` | master switch for forwarding (defaults to `true` when a URL is set) |
| `FORWARD_TIMEOUT_MS` | `8000` | per-attempt upstream timeout |
| `FORWARD_RETRIES` | `2` | retries after a retryable failure (backoff ×`FORWARD_RETRY_BACKOFF_MS`) |
| `FORWARD_CONCURRENCY` | `4` | parallel upstream workers |
| `FORWARD_MAX_QUEUE` | `5000` | queue cap; beyond this the oldest jobs are dropped and counted |
| `FORWARD_RETRY_BACKOFF_MS` | `1500` | linear backoff step between retries |
| `FORWARD_MAX_PAYLOAD_BYTES` | `16384` | `raw` payload truncation limit sent upstream |

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
npm run db:reset       # wipe data/iot.db → schema only, 0 devices, 4 baseline rules
npm run check          # node --check on the main entry points
```

The server boots with **no broker running** — MQTT connection failures are
retried every 4 s, the dashboard keeps working over HTTP, and commands stay
`pending` in SQLite until either the broker reconnects or the device polls.

---

## 13. Simulator (optional development tool)

```bash
node scripts/simulator.js --devices 220 --interval 5000 --anomaly 0.05
```

This is **not** a seeder. Nothing here runs automatically and nothing is written
unless the virtual node's telemetry actually reaches the server, at which point
the device is registered by exactly the same code path as real hardware
(`upsertDevice` via the ingest pipeline). Stop the simulator and those devices
simply age into `OFFLINE`; run `npm run db:reset` to clear them out.

Every flag has an environment equivalent — `SIM_URL`, `SIM_MQTT_URL`,
`SIM_DEVICES`, `SIM_INTERVAL`, `SIM_CONCURRENCY`, `SIM_PREFIX`, `SIM_ANOMALY`,
`SIM_DURATION` — handy for compose or a scheduled run.

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

Three passes: the platform (backend, ingest, automation, MQTT, schema), the
post-refactor UI (modal design, custom config, upstream forwarding), and the
most recent "seedless + simplified + enlarged type" pass.

**Platform**

| Check | Result |
| --- | --- |
| `npm install` (native `better-sqlite3` binding loads) | ✅ |
| Server boot: schema create + migration to v3, **0 devices**, 4 baseline rules | ✅ |
| `npm run db:reset` → schema only, `devices: 0`, `telemetry rows: 0` | ✅ |
| Boot log contains no seed/demo line (grepped for `seed|demo`) | ✅ |
| First real webhook → exactly 1 device registered, ONLINE, with only the fields the device sent | ✅ |
| Boot with **no** MQTT broker (degrades, keeps serving, retries every 4 s) | ✅ |
| `POST /api/webhook/data` JSON / `sensors{}` / bare `text/plain` | ✅ 201, rows + device upsert |
| Device auto-registration from first reading; second reading → `online` | ✅ |
| `GET /api/devices` with latest metrics, search (id / name / ip / mac), filters | ✅ |
| `GET /api/devices/:id/telemetry` series for the inspector chart | ✅ |
| Command webhook → SQLite queue → HTTP polling delivery | ✅ |
| Automation: `temperature=41.5 > 30` → `RELAY_OFF` queued, rule event logged | ✅ |
| Rule CRUD + toggle + delete + `/api/rule-events` | ✅ |
| Validation: missing `device_id`, illegal characters, unknown device, unknown route | ✅ 400/404 JSON |
| Rate limiter / 404 handler / SPA fallback (no path traversal) | ✅ |
| Simulator: 30 devices → 240 telemetry rows, 19 automation commands, 0 failures | ✅ |
| Migration on a pre-existing **v1** database (`user_version` 1 → 2 → 3, `devices.mac` added, three new tables created) | ✅ |
| `mac` accepted from payloads, stored, searchable via `?search=` and shown in the inspector header (it is no longer on the card) | ✅ |
| Sparkline series: per (device, sensor), capped at 10 points, 5-minute window | ✅ |
| Sparkline cost at scale: 39,600-row window → 44.5 ms / 384 KB for 1000 devices (0.2 ms without) | ✅ |
| Heartbeat 30 s served by `/api/health` (`offline_after_seconds`) and applied in the browser | ✅ |
| Settings CRUD + override precedence (`database` > `env` > `unset`) + `DELETE /api/settings/:key` fallback | ✅ |
| Device config round-trip: `POST` → revision 1 → `GET` returns it; unknown device returns defaults with `has_custom:false` (**not** 404 — the boot path); `DELETE` restores defaults | ✅ |
| Upstream forwarding: 3/3 batches delivered to a local sink as full documents, `forward_logs` rows written, failures audited with their HTTP status | ✅ |
| `POST /api/forward/test` → `502` when the remote rejects the probe | ✅ |
| Ingest latency with a **dead** upstream URL: `POST /api/webhook/data` still 2–3 ms (forwarding is provably off the ingest path) | ✅ |
| `npm run build:css` → minified stylesheet containing every dynamically used class | ✅ |
| `docker compose config` validation | ✅ |
| `docker compose build` / container smoke test | ⏳ pending Docker daemon (`docker-on`) |

**Modal UI pass** — driven in headless Chrome over the DevTools protocol (real
DOM, real Chart.js, real socket, live simulated fleet), `59/59` checks passed, run
twice against a fresh database:

| Check | Result |
| --- | --- |
| Main view simplified: global terminal, global chart and command form all absent from the body; both modals start hidden | ✅ |
| Card click → inspector scoped to that device (header shows its id, IP, MAC, ONLINE) | ✅ |
| Telemetry tab: four tabs present, only the active panel visible, sensor picker populated, 7+ points plotted for **that** device, canvas painted, min/max/avg readout filled | ✅ |
| Commands tab: `RELAY_ON` send → `⧗ queued`, row added to history, line written to the device console | ✅ |
| Config tab: form rows match the saved keys, `SAVE & SYNC TO ESP` reports a revision, revision bumps 1 → 2, value persisted in SQLite | ✅ |
| Logs tab: stamped with the open device, backfilled history, blinking cursor, PAUSE/CLEAR present, other devices' lines absent, live webhook appended while open | ✅ |
| Settings modal: four tabs, forwarding panel renders URL + enable + test + save + logs, save reports `✓ forwarding active · source: database`, value persisted server-side | ✅ |
| Live patching: card DOM node identity preserved, reading updated in place, neon flash fired, badge → ONLINE on heartbeat, `Updated …` refreshed | ✅ |
| Runtime health: socket connected, **0 uncaught JS errors** | ✅ |

**Seedless + typography pass** — the same headless-Chrome rig, started against a
database wiped by `npm run db:reset` so the empty state is exercised first and a
device is registered by a real webhook mid-run. **56/56 checks passed:**

| Check | Result |
| --- | --- |
| Empty database → 0 cards, `.empty-state` rendered full-width with a pulsing neon dot | ✅ |
| Exact copy: `NO IOT DEVICES REGISTERED YET` / `Waiting for incoming telemetry…` | ✅ |
| Grid note `waiting for the first device to report in`, census `TOTAL: 0 \| ONLINE: 0 \| OFFLINE: 0`, LOAD MORE hidden | ✅ |
| Summary strip is exactly 4 tiles (Total / Online / Offline / Forwarded) and the old 8-tile strip is gone from the DOM | ✅ |
| A single real webhook → card appears **without a reload**, empty state removed, exactly 1 card | ✅ |
| Card content: device id, ONLINE badge + pulsing dot, IP, reading `24.6 C`, sensor label, `Updated …` | ✅ |
| Card exclusions: no MAC, no config tags, no secondary readings | ✅ |
| Card geometry: 260 px min-height, pointer cursor, `INSPECT` affordance | ✅ |
| Measured type: reading **60 px**, device id **20 px**, IP **17 px**, badge **15 px** | ✅ |
| Measured type: header title **24 px**, stat labels **15 px**, stat values **36 px**, filter buttons **15 px**, search input **17 px** | ✅ |
| Modal type: title **26 px**, subtitle / tabs / terminal lines / inputs / send button all **17 px** | ✅ |
| Inspector still scoped correctly, chart created, 4 tabs, per-device console stamped, upstream webhook status shown | ✅ |
| Live patching after the empty state: reading → `41.25`, neon flash, `Updated …` refreshed, census still 1 | ✅ |
| Socket connected, **0 uncaught JS errors** | ✅ |
| Automation still fires on real data (`temperature=41.25 > 30 → RELAY_OFF`) | ✅ |

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
   `/api/webhook/command/ack`, `/api/settings`, `/api/forward-logs`,
   `/api/forward/test`) exist to support the UI, the runtime settings layer and
   device acknowledgement.
5. **The global telemetry chart, side control panel and global terminal moved into
   modals.** The brief for this revision asked for a simplified main view, so the
   body is now only header + stat strip + device cards (§3.1) and those three
   surfaces live in the device inspector (§3.2) and settings (§3.3) modals. No
   functionality was dropped — the old anchors were replaced by modal ids
   (`#device-modal`, `#settings-modal`), which is the one thing to know if you
   have bookmarked a deep link into the old layout.
6. **`/api/device/:id/config` never 404s for an unknown device.** It returns the
   firmware defaults with `has_custom: false`, because a factory-fresh board must
   be able to provision itself at boot (§6.7). An explicit `DELETE` is how you
   remove a saved config.
7. **All device fixtures were deleted; a fresh database is empty** (§4.1). The
   220-device generator, its demo configs and the demo MAC scheme are gone, along
   with `scripts/seed.js` — `npm run db:reset` now wipes rather than seeds. Expect
   `NO IOT DEVICES REGISTERED YET` on first boot; that is the designed state, and
   the dashboard fills up as hardware reports in. Only the four baseline
   automation rules are still written on an empty rules table
   (`SEED_DEFAULT_RULES=false` disables that too).
8. **Card content was cut back to core fields** (id, status, IP, live reading,
   last ping). MAC, location, secondary readings, config tags and the inline relay
   buttons moved into the inspector modal — the modal remains the full control
   surface, so nothing is unreachable.
9. **Typography runs larger than a default Tailwind build** (§Typography): a
   `@theme` type scale plus enlarged component sizes, with no text below 13 px and
   a `text-5xl`/`text-6xl` live reading. Terminal panels were made taller (400 px /
   520 px) so the bigger line height keeps the same number of visible lines.

---

## 17. Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| `NO IOT DEVICES REGISTERED YET` after a fresh install | expected — the database starts empty by design (§4.1). Point a device at `POST /api/webhook/data` (or `npm run simulate` for a virtual fleet) and cards appear immediately |
| Want demo data back temporarily | `node scripts/simulator.js --devices 220` registers a virtual fleet through the real ingest path; `npm run db:reset` clears it again |
| Old fake "Sensor Node" rows still in the dashboard | they were created by a build from before this revision (the seeder was removed in `51c9298`). `npm run db:reset` (server stopped) wipes and recreates the DB with 0 devices |
| Dashboard loads unstyled | `public/css/app.css` missing → `npm run build:css` |
| Header badge `MQTT: OFFLINE` | broker not running or wrong `MQTT_URL`. Inside compose it must be `mqtt://mqtt-broker:1883` |
| Commands stay `pending` | broker down **and** the device is not polling. Check `/api/mqtt/status`, then `docker compose logs mqtt-broker` |
| All devices show offline after a restart | expected — nodes re-register on their next message; polling devices recover on `/api/webhook/command/poll` |
| `SQLITE_IOERR` / "disk I/O error" | database on exFAT/NTFS/SMB → move to ext4 or a named volume (§10.4) |
| `EACCES` writing `/app/data` | `sudo chown -R 1000:1000 ./data` (container runs as `node`) |
| Ports already in use | `sudo lsof -i :3000` / `docker compose down` another stack |
| Terminal panel floods / UI sluggish | reduce ingest rate, use `FOCUS`, or raise the `LOG_THROTTLE_MS` constant (15 s, per device+sensor) in `src/ingest.js` — it is a code constant, not an env var |
| Rule fires constantly | increase `cooldown_seconds`; the burst limiter caps 25 triggers / 5 s |
| Inspector chart empty but the card shows a reading | only numeric values are charted; non-numeric payloads land in `raw_value`. Also check the sensor picker — the chart follows one series at a time |
| Chart missing entirely | the vendored library failed to load: check `/vendor/chart.umd.js` (`npm run vendor`) and the browser console |
| Device console misses lines that the system log shows | expected for non-telemetry lines while `FOCUS` is on elsewhere — but a *gap* in telemetry lines would be a bug: they are pushed from `telemetry_update`, independent of the 25 lines/s system-log throttle (§3.2) |
| `SAVE & SYNC TO ESP` reports saved but the form reverts | you edited while a background refresh was in flight; the draft guard keeps the newer revision out on purpose (§3.2). Save or reload the device to pick it up |
| Forwards not arriving upstream | `GET /api/settings` → check `effective.active` and `effective.source`; a runtime row (**database**) overrides `.env`. Use `POST /api/forward/test` to see the remote's HTTP status, and `GET /api/forward-logs` for the per-attempt audit |
| Forward queue growing / `dropped` increasing | upstream is slow or down: check `failed` and `last_error`, raise `FORWARD_MAX_QUEUE`, or disable forwarding — ingest is never blocked either way |
| Forwarding goes to the wrong URL | a `settings` row wins over `.env`. `DELETE /api/settings/MAIN_WEBSITE_WEBHOOK_URL` (or clear the field and save) to fall back |
| Every card reads OFFLINE although data is arriving | heartbeat mismatch: the browser uses `HEARTBEAT_MS` (30 s), the server `OFFLINE_AFTER_SECONDS`. Also check payload `ts`/`timestamp` — a stale or far-future epoch from a device with a wrong clock skews the window |
| Card metric shows `--` | the sensor only ever sent non-numeric values, so nothing reached `latest_telemetry` |
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
