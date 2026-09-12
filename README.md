# IOT // DASHBOARD

Space-Black / Neon-Green operator console for monitoring and controlling **200+
IoT devices** in real time.

- **Device grid:** one card per node — heartbeat status badge, IP/MAC metadata,
  live neon metric blocks, a Chart.js sparkline of the last 10 readings and
  `RELAY ON` / `RELAY OFF` quick actions
- **Ingest:** HTTP webhooks **and** MQTT (`iot/+/telemetry`)
- **Control:** command queue with MQTT publish **and** HTTP polling for devices
- **Storage:** SQLite (`data/iot.db`) — devices, telemetry, commands, automation rules
- **Realtime:** Socket.io fan-out (telemetry, commands, live terminal)
- **Automation:** threshold rules, e.g. *if temperature > 30 then `RELAY_OFF`*

Full documentation — architecture, APIs, flashing ESP32/ESP8266 firmware, deployment
and troubleshooting — lives in **[HANDOVER.md](HANDOVER.md)**.

---

## Quick start (Docker)

```bash
docker-on                      # start the Docker daemon (this machine's helper)
docker compose up -d --build   # build + start node-server and mqtt-broker
```

Dashboard → **http://localhost:3000** · Health → **http://localhost:3000/api/health**

```bash
docker compose exec node-server node scripts/simulator.js --devices 220   # fake fleet
docker compose logs -f node-server                                       # tail logs
docker compose down                                                      # stop
```

## Quick start (local Node)

```bash
npm install
npm start          # http://localhost:3000 (MQTT optional — the server degrades gracefully)
npm run simulate   # optional: 220 synthetic devices
```

## Send your first reading

```bash
curl -X POST http://localhost:3000/api/webhook/data \
  -H 'Content-Type: application/json' \
  -d '{"device_id":"ESP32-0001","sensor_name":"temperature","value":31.4,"unit":"C"}'
```

## Send your first command

```bash
curl -X POST http://localhost:3000/api/webhook/command \
  -H 'Content-Type: application/json' \
  -d '{"device_id":"ESP32-0001","command":"RELAY_ON"}'
```

## Palette

| Role | Hex |
| --- | --- |
| Background | `#06090B` |
| Cards | `#0B0F12` / `#141C22` |
| Borders | `#1E2A34` |
| Accent, text, chart | `#39FF14` |
| Terminal | `#05080A` |

## Scripts

| Command | Purpose |
| --- | --- |
| `npm start` | run the server |
| `npm run dev` | run with auto-restart |
| `npm run build` | vendor browser libs + compile Tailwind (`public/css/app.css`) |
| `npm run simulate` | 220 virtual devices over HTTP |
| `npm run simulate:mqtt` | 220 virtual devices over MQTT |
| `npm run db:reset` | wipe and reseed `data/iot.db` |
| `npm run check` | syntax check the entry points |

> After changing `public/index.html`, `public/js/app.js` or `public/css/input.css`,
> run `npm run build:css` and commit the regenerated `public/css/app.css`.
