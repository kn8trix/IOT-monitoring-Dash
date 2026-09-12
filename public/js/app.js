/* ==========================================================================
   IOT // DASHBOARD — client application
   Vanilla ES2020, no build step. Talks to the server over REST + Socket.io.
   ========================================================================== */

(() => {
  'use strict';

  const NEON = '#39FF14';
  const MAX_CHART_POINTS = 180;
  const PAGE_SIZE = 24; // rich cards: keep the DOM (and Chart.js instances) light
  const MINI_POINTS = 10; // sparkline window — "last 10 historical readings"
  const MAX_TERMINAL_LINES = 400;
  const HEARTBEAT_MS = 30_000; // last ping younger than this ⇒ ONLINE
  const SPARKLINE_BUDGET = 32; // only on-screen cards own a Chart.js instance

  const $ = (id) => document.getElementById(id);

  const state = {
    socket: null,
    connected: false,
    devices: new Map(), // device_id -> device
    cards: new Map(), // device_id -> card element
    sparklines: new Map(), // device_id -> { chart, sensor } (on-screen cards only)
    sparklineObserver: null,
    relayStates: new Map(), // device_id -> 'ON' | 'OFF' (from card quick actions)
    gridSignature: '',
    termDevice: null, // terminal focused on one device (card "LOGS" button)
    selected: null, // device id driving the chart + control panel
    pageCount: 1,
    filter: 'all',
    search: '',
    sort: 'status',
    rules: [],
    ruleEvents: [],
    commands: [],
    chart: {
      device: null,
      sensor: null,
      points: [],
      live: true,
      instance: null,
    },
    stats: null,
    mqtt: null,
    paused: false,
    focus: false,
    termLines: 0,
    cmdMode: 'json',
  };

  /* ---------------------------------------------------------------------- */
  /* Helpers                                                                */
  /* ---------------------------------------------------------------------- */

  const esc = (value) =>
    String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function fmtNumber(value) {
    if (value === null || value === undefined) return '--';
    const n = Number(value);
    if (!Number.isFinite(n)) return String(value);
    const abs = Math.abs(n);
    if (abs >= 1000) return n.toLocaleString('en-US', { maximumFractionDigits: 2 });
    if (abs >= 100) return n.toFixed(1);
    return n.toFixed(2).replace(/\.?0+$/, '') || '0';
  }

  function fmtMetric(metric) {
    if (!metric || metric.value === null || metric.value === undefined) return '--';
    return `${fmtNumber(metric.value)}${metric.unit ? ` ${metric.unit}` : ''}`;
  }

  const clockTime = (ts) =>
    new Date(ts).toLocaleTimeString('en-GB', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });

  function relTime(ts) {
    if (!ts) return 'never';
    const delta = Math.max(0, Date.now() - ts);
    if (delta < 1000) return 'now';
    const s = Math.floor(delta / 1000);
    if (s < 60) return `${s}s ago`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m ago`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h ago`;
    return `${Math.floor(h / 24)}d ago`;
  }

  function fmtUptime(seconds) {
    const s = Math.max(0, Math.floor(seconds || 0));
    const d = Math.floor(s / 86400);
    const h = Math.floor((s % 86400) / 3600);
    const m = Math.floor((s % 3600) / 60);
    if (d) return `${d}d ${h}h`;
    if (h) return `${h}h ${m}m`;
    if (m) return `${m}m ${s % 60}s`;
    return `${s}s`;
  }

  /** Milliseconds since the last heartbeat; Infinity when never seen. */
  function deviceAge(device) {
    return device && device.last_seen ? Math.max(0, Date.now() - device.last_seen) : Infinity;
  }

  /**
   * Heartbeat rule for the device cards: a node is ONLINE while its last ping
   * is younger than HEARTBEAT_MS (30 s). Kept in sync with the server's
   * OFFLINE_AFTER_SECONDS so the badge flips even between sweeps.
   */
  function isOnline(device) {
    return deviceAge(device) < HEARTBEAT_MS;
  }

  function relayState(deviceId) {
    return state.relayStates.get(deviceId) || null;
  }

  async function api(path, options = {}) {
    const response = await fetch(path, {
      headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
      ...options,
    });
    let payload = null;
    try {
      payload = await response.json();
    } catch {
      payload = { ok: false, error: `HTTP ${response.status}` };
    }
    if (!response.ok || payload.ok === false) {
      throw new Error(payload.error || `HTTP ${response.status}`);
    }
    return payload;
  }

  const TOAST_STYLES = {
    info: 'border-edge text-[#9fd8b4]',
    success: 'border-[rgba(57,255,20,0.55)] text-neon',
    warn: 'border-[rgba(255,176,32,0.6)] text-[#ffcc66]',
    error: 'border-[rgba(255,59,48,0.6)] text-[#ffb3ad]',
  };

  function toast(message, level = 'info', ttl = 4200) {
    const el = document.createElement('div');
    el.className = `panel fade-in px-3 py-2 text-[0.7rem] ${TOAST_STYLES[level] || TOAST_STYLES.info}`;
    el.textContent = message;
    $('toasts').appendChild(el);
    setTimeout(() => {
      el.style.opacity = '0';
      el.style.transition = 'opacity .3s';
      setTimeout(() => el.remove(), 320);
    }, ttl);
  }

  /* ---------------------------------------------------------------------- */
  /* Connection state                                                       */
  /* ---------------------------------------------------------------------- */

  function setConnected(connected) {
    state.connected = connected;
    const dot = $('socket-dot');
    const label = $('status-label');
    const badge = $('socket-badge');

    dot.className = `dot ${connected ? 'dot-online' : 'dot-offline'}`;
    label.textContent = connected ? 'ACTIVE' : 'DEGRADED';
    label.className = connected ? 'text-neon glow-text-soft' : 'text-[#ffb020]';
    $('status-dot').className = `dot ${connected ? 'dot-online' : 'dot-stale'}`;
    $('socket-label').textContent = connected ? 'LINK: LIVE' : 'LINK: LOST';
    badge.classList.toggle('glow-border', connected);
  }

  function renderMqtt(status) {
    if (!status) return;
    state.mqtt = status;
    const dot = $('mqtt-dot');
    const label = $('mqtt-label');
    if (!status.enabled) {
      dot.className = 'dot dot-offline';
      label.textContent = 'DISABLED';
      label.className = 'text-[#6d8b84]';
      return;
    }
    dot.className = `dot ${status.connected ? 'dot-online' : 'dot-stale'}`;
    label.textContent = status.connected ? 'CONNECTED' : 'OFFLINE';
    label.className = status.connected ? 'text-neon glow-text-soft' : 'text-[#ffb020]';
    label.title = status.last_error ? `last error: ${status.last_error}` : status.url;
  }

  /* ---------------------------------------------------------------------- */
  /* Stats                                                                  */
  /* ---------------------------------------------------------------------- */

  function renderStats(stats) {
    if (!stats) return;
    state.stats = stats;
    $('stat-total').textContent = stats.devices.total;
    $('stat-online').textContent = stats.devices.online;
    $('stat-offline').textContent = stats.devices.offline;
    $('stat-rate').textContent = stats.telemetry.last_minute;
    $('stat-rows').textContent = stats.telemetry.total.toLocaleString('en-US');
    $('stat-pending').textContent = stats.commands.pending;
    $('stat-rules').textContent = `${stats.rules.enabled}/${stats.rules.total}`;
    $('stat-uptime').textContent = fmtUptime(stats.uptime_seconds);

    $('header-online').textContent = stats.devices.online;
    $('header-total').textContent = stats.devices.total;
    $('header-rate').textContent = stats.telemetry.last_minute;
    $('header-clients').textContent = stats.clients ?? 0;
  }

  /* ---------------------------------------------------------------------- */
  /* Devices                                                                */
  /* ---------------------------------------------------------------------- */

  function upsertDevice(device) {
    if (!device || !device.device_id) return;
    const previous = state.devices.get(device.device_id);
    const merged = previous ? { ...previous, ...device } : device;
    if (previous && previous.metrics) merged.metrics = { ...previous.metrics, ...(device.metrics || {}) };
    state.devices.set(device.device_id, merged);
    return merged;
  }

  function sortDevices(list) {
    const sorters = {
      status: (a, b) => Number(isOnline(b)) - Number(isOnline(a)) || (b.last_seen || 0) - (a.last_seen || 0),
      id: (a, b) => String(a.device_id).localeCompare(String(b.device_id), undefined, { numeric: true }),
      location: (a, b) =>
        String(a.location || '').localeCompare(String(b.location || '')) ||
        String(a.device_id).localeCompare(String(b.device_id)),
      seen: (a, b) => (b.last_seen || 0) - (a.last_seen || 0),
    };
    return list.sort(sorters[state.sort] || sorters.status);
  }

  /**
   * Search-scoped device list (status filter NOT applied). This is the census
   * scope for the "Total | Online | Offline" counter in the filter bar.
   */
  function matchingDevices() {
    const term = state.search.trim().toLowerCase();
    const list = [...state.devices.values()];
    const filtered = term
      ? list.filter((d) =>
          [d.device_id, d.name, d.ip, d.mac, d.location]
            .filter(Boolean)
            .some((field) => String(field).toLowerCase().includes(term)),
        )
      : list;
    return sortDevices(filtered);
  }

  /** Search + status filter, truncated to the current page (LOAD MORE). */
  function renderedDevices(matching) {
    const byStatus =
      state.filter === 'online'
        ? matching.filter(isOnline)
        : state.filter === 'offline'
          ? matching.filter((device) => !isOnline(device))
          : matching;
    return byStatus.slice(0, state.pageCount * PAGE_SIZE);
  }

  /** Live counter: "TOTAL: X | ONLINE: Y | OFFLINE: Z". */
  function renderCensus(matching) {
    const online = matching.filter(isOnline).length;
    const offline = matching.length - online;
    $('device-count').innerHTML =
      `<span class="text-[#6d8b84]">TOTAL:</span> <b class="text-[#d9ffcf]">${matching.length}</b>` +
      `<span class="text-[#2d4a44]"> | </span><span class="text-[#6d8b84]">ONLINE:</span> <b class="text-neon glow-text-soft">${online}</b>` +
      `<span class="text-[#2d4a44]"> | </span><span class="text-[#6d8b84]">OFFLINE:</span> <b class="${offline ? 'text-[#ff7b72]' : 'text-[#6d8b84]'}">${offline}</b>`;
  }

  function metricEntries(device) {
    return Object.entries(device.metrics || {})
      .sort((a, b) => a[0].localeCompare(b[0]))
      .slice(0, 3);
  }

  /** Sensor whose history drives the card sparkline (temperature when present). */
  function primarySensor(device) {
    const sensors = Object.keys(device.metrics || {});
    if (!sensors.length) return null;
    return sensors.includes('temperature') ? 'temperature' : sensors.sort()[0];
  }

  function updatedLabel(device) {
    if (!device.last_seen) return 'No ping received';
    return `Updated ${relTime(device.last_seen)}`;
  }

  function timestampTitle(device) {
    return device.last_seen ? new Date(device.last_seen).toLocaleString() : 'never reported';
  }

  /** The high-contrast stat blocks shown on every card. */
  function metricBlocks(device) {
    const metrics = metricEntries(device);
    if (!metrics.length) {
      return '<div class="metric-block"><p class="metric-label">awaiting data</p><p class="metric-value">--</p></div>';
    }
    return metrics
      .map(
        ([name, metric]) => `
      <div class="metric-block">
        <p class="metric-label" title="${esc(name)}">${esc(name.replace(/_/g, ' '))}</p>
        <p class="metric-value"><span data-metric="${esc(name)}">${esc(fmtNumber(metric.value))}</span>${
          metric.unit ? `<span class="metric-unit">${esc(metric.unit)}</span>` : ''
        }</p>
      </div>`,
      )
      .join('');
  }

  function cardInner(device) {
    const online = isOnline(device);
    const relay = relayState(device.device_id);
    const sensor = primarySensor(device);

    return `
      <header class="flex items-start gap-2">
        <div class="min-w-0 flex-1">
          <p class="device-name" title="${esc(device.name || device.device_id)}">${esc(device.name || device.device_id)}</p>
          <p class="device-id" title="device id">${esc(device.device_id)}</p>
        </div>
        <span class="status-badge ${online ? 'status-online' : 'status-offline'}" data-role="badge">
          <span class="dot ${online ? 'dot-online' : 'dot-offline'}" data-role="dot"></span>
          <span data-role="status">${online ? 'ONLINE' : 'OFFLINE'}</span>
        </span>
      </header>

      <dl class="mt-1.5 space-y-0.5 text-[0.6rem] text-[#5d7b75]">
        <div class="flex gap-1.5">
          <dt class="w-[2.1rem] flex-none text-[#3f5b55]">IP</dt>
          <dd class="truncate" data-role="ip">${esc(device.ip || '—')}</dd>
        </div>
        <div class="flex gap-1.5">
          <dt class="w-[2.1rem] flex-none text-[#3f5b55]">MAC</dt>
          <dd class="truncate" data-role="mac">${esc(device.mac || '—')}</dd>
        </div>
      </dl>

      <div class="mt-2 grid grid-cols-3 gap-1.5" data-role="metrics">${metricBlocks(device)}</div>

      <div class="sparkline-box mt-2">
        <canvas data-role="sparkline" aria-label="Sparkline for ${esc(device.device_id)}"></canvas>
        <span class="sparkline-label" data-role="sparkline-label">${esc(sensor || 'no series')}</span>
      </div>

      <div class="mt-1.5 flex items-center gap-2 text-[0.6rem] text-[#47605a]">
        <span data-role="seen" title="${esc(timestampTitle(device))}">${esc(updatedLabel(device))}</span>
        <span class="relay-pill ${relay === 'ON' ? 'is-on' : ''}" data-role="relay">RELAY ${esc(relay || '—')}</span>
        <span class="ml-auto truncate" data-role="fw">${esc(device.firmware || 'fw ?')}</span>
      </div>

      <div class="mt-2 flex items-center gap-1.5">
        <button class="btn btn-relay ${relay === 'ON' ? 'is-active' : ''} flex-1" data-relay="RELAY_ON" type="button"
                title="Send RELAY_ON to ${esc(device.device_id)}">RELAY ON</button>
        <button class="btn btn-relay ${relay === 'OFF' ? 'is-active' : ''} flex-1" data-relay="RELAY_OFF" type="button"
                title="Send RELAY_OFF to ${esc(device.device_id)}">RELAY OFF</button>
        <button class="btn btn-relay px-2" data-logs="1" type="button"
                title="Show only this device in the terminal">LOGS</button>
      </div>`;
  }

  function createCard(device) {
    const card = document.createElement('div');
    card.className = 'device-card';
    card.dataset.device = device.device_id;
    card.innerHTML = cardInner(device);
    applyCardState(card, device);
    return card;
  }

  function applyCardState(card, device) {
    const online = isOnline(device);
    const relay = relayState(device.device_id);

    card.classList.toggle('is-online', online);
    card.classList.toggle('is-offline', !online);
    card.classList.toggle('is-selected', state.selected === device.device_id);

    const dot = card.querySelector('[data-role="dot"]');
    if (dot) dot.className = `dot ${online ? 'dot-online' : 'dot-offline'}`;

    const badge = card.querySelector('[data-role="badge"]');
    if (badge) badge.className = `status-badge ${online ? 'status-online' : 'status-offline'}`;

    const status = card.querySelector('[data-role="status"]');
    if (status) status.textContent = online ? 'ONLINE' : 'OFFLINE';

    const pill = card.querySelector('[data-role="relay"]');
    if (pill) {
      pill.textContent = `RELAY ${relay || '—'}`;
      pill.classList.toggle('is-on', relay === 'ON');
    }

    for (const button of card.querySelectorAll('[data-relay]')) {
      button.classList.toggle('is-active', relay === button.dataset.relay.replace('RELAY_', ''));
    }
  }

  /** Brief neon border pulse marking a card that just received data. */
  function flashCard(card) {
    card.classList.remove('card-live-flash');
    void card.offsetWidth; // force a reflow so the animation restarts
    card.classList.add('card-live-flash');
    clearTimeout(card._flashTimer);
    card._flashTimer = setTimeout(() => card.classList.remove('card-live-flash'), 950);
  }

  /* ---- card sparklines --------------------------------------------------- */
  /*
   * One Chart.js line chart per card would be far too heavy for a 200+ node
   * fleet, so charts are created lazily: only cards inside (or near) the
   * viewport own an instance, capped at SPARKLINE_BUDGET. Scrolling a card out
   * of view destroys its chart.
   */

  function sparklineSeries(device) {
    const sensor = primarySensor(device);
    const series = (sensor && device.sparkline && device.sparkline[sensor]) || [];
    return { sensor, points: series.map((point) => point.value) };
  }

  function initSparklineObserver() {
    if (typeof IntersectionObserver === 'undefined') return;
    state.sparklineObserver = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const deviceId = entry.target.dataset.device;
          if (!deviceId) continue;
          if (entry.isIntersecting) {
            if (state.sparklines.has(deviceId) || state.sparklines.size >= SPARKLINE_BUDGET) continue;
            createSparkline(deviceId, entry.target);
          } else {
            destroySparkline(deviceId);
          }
        }
      },
      { rootMargin: '120px 0px' },
    );
  }

  function createSparkline(deviceId, card) {
    if (state.sparklines.has(deviceId) || typeof Chart === 'undefined') return;
    const device = state.devices.get(deviceId);
    const canvas = card.querySelector('[data-role="sparkline"]');
    if (!device || !canvas) return;

    const { sensor, points } = sparklineSeries(device);
    const chart = new Chart(canvas.getContext('2d'), {
      type: 'line',
      data: {
        labels: points.map(() => ''),
        datasets: [
          {
            data: points.slice(),
            borderColor: NEON,
            borderWidth: 1.6,
            pointRadius: 0,
            pointHoverRadius: 0,
            tension: 0.35,
            spanGaps: true,
            fill: true,
            backgroundColor: (context) => {
              const { ctx, chartArea } = context.chart;
              if (!chartArea) return 'rgba(57,255,20,0.10)';
              const gradient = ctx.createLinearGradient(0, chartArea.top, 0, chartArea.bottom);
              gradient.addColorStop(0, 'rgba(57,255,20,0.34)');
              gradient.addColorStop(1, 'rgba(57,255,20,0)');
              return gradient;
            },
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        layout: { padding: 1 },
        scales: { x: { display: false }, y: { display: false, grace: '18%' } },
        plugins: { legend: { display: false }, tooltip: { enabled: false } },
      },
    });

    state.sparklines.set(deviceId, { chart, sensor });
  }

  function destroySparkline(deviceId) {
    const entry = state.sparklines.get(deviceId);
    if (!entry) return;
    try {
      entry.chart.destroy();
    } catch {
      /* already disposed */
    }
    state.sparklines.delete(deviceId);
  }

  function destroyAllSparklines() {
    for (const deviceId of [...state.sparklines.keys()]) destroySparkline(deviceId);
  }

  function observeSparklines() {
    if (!state.sparklineObserver) return;
    state.sparklineObserver.disconnect();
    for (const [, card] of state.cards) state.sparklineObserver.observe(card);
  }

  /** Immediately charts the cards that are already in view (first paint). */
  function createVisibleSparklines() {
    for (const [deviceId, card] of state.cards) {
      if (state.sparklines.size >= SPARKLINE_BUDGET) break;
      const rect = card.getBoundingClientRect();
      if (rect.bottom > -120 && rect.top < window.innerHeight + 120) createSparkline(deviceId, card);
    }
  }

  /** Append the newest sample to a card's sparkline (keeps only MINI_POINTS). */
  function pushSparkline(deviceId, card, device, sensor) {
    const entry = state.sparklines.get(deviceId);
    if (!entry || !sensor) return;

    if (entry.sensor !== sensor) {
      // The card's primary series changed (e.g. temperature just arrived).
      destroySparkline(deviceId);
      createSparkline(deviceId, card);
      return;
    }

    const metric = (device.metrics || {})[sensor];
    if (!metric || !Number.isFinite(Number(metric.value))) return;

    const data = entry.chart.data.datasets[0].data;
    const labels = entry.chart.data.labels;
    data.push(Number(metric.value));
    labels.push('');
    if (data.length > MINI_POINTS) data.splice(0, data.length - MINI_POINTS);
    if (labels.length > MINI_POINTS) labels.splice(0, labels.length - MINI_POINTS);
    entry.chart.update('none');
  }

  /** Full re-render of the grid (filters, sort, search, first paint). */
  function renderGrid({ keepPage = false } = {}) {
    if (!keepPage) state.pageCount = 1;

    const matching = matchingDevices();
    const list = renderedDevices(matching);
    const grid = $('device-grid');

    destroyAllSparklines();
    grid.textContent = '';
    state.cards.clear();

    const fragment = document.createDocumentFragment();
    for (const device of list) {
      const card = createCard(device);
      state.cards.set(device.device_id, card);
      fragment.appendChild(card);
    }
    grid.appendChild(fragment);
    state.gridSignature = list.map((device) => device.device_id).join('|');

    renderCensus(matching);
    $('device-grid-note').textContent = matching.length
      ? `showing ${list.length} of ${matching.length} matching · ${state.devices.size} registered · heartbeat < ${HEARTBEAT_MS / 1000}s`
      : 'no devices match the current filter';
    $('device-more').classList.toggle('hidden', list.length >= matching.length);

    // Keep the device dropdown in sync (top 300 is plenty for a picker).
    const options = matching.slice(0, 300).map((d) => `<option value="${esc(d.device_id)}"></option>`).join('');
    $('device-options').innerHTML = options;
    syncChartDeviceSelect(list);

    observeSparklines();
    createVisibleSparklines();
  }

  /**
   * In-place update of a single card — metric values, sparkline, last-ping
   * label, status badge and the neon flash. The grid is never re-rendered for
   * a plain telemetry frame.
   */
  function updateCard(deviceId, changedMetric, { flash = true } = {}) {
    const card = state.cards.get(deviceId);
    const device = state.devices.get(deviceId);
    if (!device || !card) return;

    applyCardState(card, device);

    const seen = card.querySelector('[data-role="seen"]');
    if (seen) {
      seen.textContent = updatedLabel(device);
      seen.title = timestampTitle(device);
    }
    const ip = card.querySelector('[data-role="ip"]');
    if (ip && device.ip) ip.textContent = device.ip;
    const mac = card.querySelector('[data-role="mac"]');
    if (mac && device.mac) mac.textContent = device.mac;
    const fw = card.querySelector('[data-role="fw"]');
    if (fw && device.firmware) fw.textContent = device.firmware;

    // Metric blocks: only re-render the row when the sensor set itself changed.
    const container = card.querySelector('[data-role="metrics"]');
    const metrics = metricEntries(device);
    if (container) {
      const rendered = [...container.querySelectorAll('[data-metric]')].map((node) => node.dataset.metric).join('|');
      const wanted = metrics.map(([name]) => name).join('|');
      if (rendered !== wanted) {
        container.innerHTML = metricBlocks(device);
      } else {
        for (const [name, metric] of metrics) {
          const node = container.querySelector(`[data-metric="${CSS.escape(name)}"]`);
          if (!node) continue;
          const next = fmtNumber(metric.value);
          if (node.textContent !== next) {
            node.textContent = next;
            if (name === changedMetric) {
              node.classList.remove('flash-value');
              void node.offsetWidth;
              node.classList.add('flash-value');
            }
          }
        }
      }
    }

    const sensor = primarySensor(device);
    const label = card.querySelector('[data-role="sparkline-label"]');
    if (label) label.textContent = sensor || 'no series';
    if (sensor && changedMetric === sensor) pushSparkline(deviceId, card, device, sensor);

    if (flash) flashCard(card);
  }

  /**
   * Throttled reconciliation, used when an event arrives for a device that is
   * not currently on screen. If the visible set changed (a node came online,
   * a filter now matches it) the grid is re-rendered; otherwise the existing
   * cards are refreshed in place.
   */
  let gridRefreshTimer = null;
  function scheduleGridRefresh() {
    if (gridRefreshTimer) return;
    gridRefreshTimer = setTimeout(() => {
      gridRefreshTimer = null;
      const matching = matchingDevices();
      const list = renderedDevices(matching);
      if (list.map((device) => device.device_id).join('|') !== state.gridSignature) {
        renderGrid({ keepPage: true });
        return;
      }
      renderCensus(matching);
      for (const device of list) updateCard(device.device_id, null, { flash: false });
    }, 500);
  }

  /**
   * Re-evaluates the <30 s heartbeat rule and the "Updated …" labels. This is
   * what flips a badge to OFFLINE without waiting for a server sweep.
   */
  function refreshHeartbeats() {
    for (const [deviceId, card] of state.cards) {
      const device = state.devices.get(deviceId);
      if (!device) continue;
      applyCardState(card, device);
      const seen = card.querySelector('[data-role="seen"]');
      if (seen) seen.textContent = updatedLabel(device);
    }
    if (state.cards.size) renderCensus(matchingDevices());
  }

  /* ---------------------------------------------------------------------- */
  /* Selecting a device                                                     */
  /* ---------------------------------------------------------------------- */

  function selectDevice(deviceId, { sensorName } = {}) {
    const device = state.devices.get(deviceId);
    if (!device) {
      toast(`unknown device: ${deviceId}`, 'warn');
      return;
    }
    state.selected = deviceId;
    state.chart.device = deviceId;

    const previous = state.cards.get(deviceId);
    if (previous) applyCardState(previous, device);
    for (const [id, card] of state.cards) {
      if (id !== deviceId) card.classList.remove('is-selected');
    }

    $('cmd-device').value = deviceId;
    $('cmd-target-hint').innerHTML = `<span class="text-neon">target:</span> ${esc(deviceId)} · ${esc(device.location || 'unassigned')} · <span class="${
      device.status === 'online' ? 'text-neon' : 'text-[#6d8b84]'
    }">${device.status || 'offline'}</span>`;

    const sensors = Object.keys(device.metrics || {});
    $('chart-device').value = deviceId;
    renderSensorOptions(sensors, sensorName || state.chart.sensor);
    loadChartSeries();
  }

  /* ---------------------------------------------------------------------- */
  /* Chart                                                                  */
  /* ---------------------------------------------------------------------- */

  function syncChartDeviceSelect(list) {
    const select = $('chart-device');
    if (document.activeElement === select) return;
    const current = state.chart.device;
    const options = list
      .filter((d) => d.status === 'online' || Object.keys(d.metrics || {}).length)
      .slice(0, 300)
      .map((d) => `<option value="${esc(d.device_id)}">${esc(d.device_id)}</option>`)
      .join('');
    if (select.dataset.signature !== options) {
      select.dataset.signature = options;
      select.innerHTML = options || '<option value="">no devices online</option>';
    }
    if (current) select.value = current;
  }

  function renderSensorOptions(sensors, preferred) {
    const select = $('chart-sensor');
    const list = sensors && sensors.length ? sensors : ['temperature'];
    const signature = list.join('|') + `#${preferred || ''}`;
    if (select.dataset.signature !== signature) {
      select.dataset.signature = signature;
      select.innerHTML = list.map((s) => `<option value="${esc(s)}">${esc(s)}</option>`).join('');
      $('sensor-options').innerHTML = list.map((s) => `<option value="${esc(s)}"></option>`).join('');
    }
    const next = list.includes(preferred) ? preferred : list[0];
    state.chart.sensor = next;
    select.value = next;
  }

  function chartOptions() {
    return {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      interaction: { mode: 'index', intersect: false },
      layout: { padding: { top: 8, right: 8, bottom: 0, left: 0 } },
      scales: {
        x: {
          grid: { color: 'rgba(30,42,52,0.55)', drawTicks: false },
          border: { color: '#1E2A34' },
          ticks: { color: '#4d6a63', font: { family: 'monospace', size: 10 }, maxRotation: 0, autoSkipPadding: 24 },
        },
        y: {
          grid: { color: 'rgba(30,42,52,0.55)', drawTicks: false },
          border: { color: '#1E2A34' },
          ticks: { color: '#4d6a63', font: { family: 'monospace', size: 10 } },
        },
      },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: '#0B0F12',
          borderColor: '#39FF14',
          borderWidth: 1,
          titleColor: '#39FF14',
          bodyColor: '#d9ffcf',
          displayColors: false,
          titleFont: { family: 'monospace', size: 11 },
          bodyFont: { family: 'monospace', size: 12 },
        },
      },
      elements: {
        line: { tension: 0.32, borderWidth: 2 },
        point: { radius: 0, hitRadius: 12, hoverRadius: 3 },
      },
    };
  }

  function initChart() {
    const canvas = $('telemetry-chart');
    if (!canvas || typeof Chart === 'undefined') return;

    state.chart.instance = new Chart(canvas.getContext('2d'), {
      type: 'line',
      data: {
        labels: [],
        datasets: [
          {
            label: 'value',
            data: [],
            borderColor: NEON,
            borderWidth: 2,
            pointBackgroundColor: NEON,
            fill: true,
            backgroundColor: (context) => {
              const { ctx, chartArea } = context.chart;
              if (!chartArea) return 'rgba(57,255,20,0.12)';
              const gradient = ctx.createLinearGradient(0, chartArea.top, 0, chartArea.bottom);
              gradient.addColorStop(0, 'rgba(57,255,20,0.34)');
              gradient.addColorStop(0.45, 'rgba(57,255,20,0.12)');
              gradient.addColorStop(1, 'rgba(57,255,20,0)');
              return gradient;
            },
          },
        ],
      },
      options: chartOptions(),
    });
  }

  function chartPush(point) {
    const chart = state.chart.instance;
    if (!chart) return;
    chart.data.labels.push(clockTime(point.ts));
    chart.data.datasets[0].data.push(point.value);
    if (chart.data.labels.length > MAX_CHART_POINTS) {
      chart.data.labels.splice(0, chart.data.labels.length - MAX_CHART_POINTS);
      chart.data.datasets[0].data.splice(0, chart.data.datasets[0].data.length - MAX_CHART_POINTS);
    }
    chart.update('none');
    updateChartSummary();
  }

  function setChartSeries(points) {
    const chart = state.chart.instance;
    if (!chart) return;
    state.chart.points = points.slice(-MAX_CHART_POINTS);
    chart.data.labels = state.chart.points.map((p) => clockTime(p.ts));
    chart.data.datasets[0].data = state.chart.points.map((p) => p.value);
    chart.update('none');
    updateChartSummary();
  }

  function updateChartSummary() {
    const points = state.chart.points;
    const values = points.map((p) => Number(p.value)).filter((v) => Number.isFinite(v));
    const sensor = state.chart.sensor || '';
    if (!values.length) {
      $('chart-current').textContent = '--';
      $('chart-min').textContent = '--';
      $('chart-max').textContent = '--';
      $('chart-avg').textContent = '--';
      $('chart-count').textContent = '0';
      return;
    }
    const last = values[values.length - 1];
    const unit = (state.devices.get(state.chart.device)?.metrics?.[sensor] || {}).unit || '';
    $('chart-current').textContent = `${sensor} ${fmtNumber(last)}${unit ? ` ${unit}` : ''}`;
    $('chart-min').textContent = fmtNumber(Math.min(...values));
    $('chart-max').textContent = fmtNumber(Math.max(...values));
    $('chart-avg').textContent = fmtNumber(values.reduce((a, b) => a + b, 0) / values.length);
    $('chart-count').textContent = String(values.length);
  }

  function loadChartSeries() {
    const deviceId = state.chart.device;
    const sensor = state.chart.sensor;
    if (!deviceId || !sensor || !state.socket) return;

    state.socket.emit(
      'request:history',
      {
        device_id: deviceId,
        sensor_name: sensor,
        limit: MAX_CHART_POINTS,
        since_ms: Number($('chart-range').value) || 900000,
      },
      (response) => {
        if (!response || !response.ok) return;
        if (response.device_id !== state.chart.device || response.sensor_name !== state.chart.sensor) return;
        setChartSeries(response.points || []);
        $('chart-range-label').textContent = `range ${$('chart-range').selectedOptions[0].textContent} · ${response.points.length} samples`;
      },
    );
  }

  /* ---------------------------------------------------------------------- */
  /* Telemetry stream                                                       */
  /* ---------------------------------------------------------------------- */

  function onTelemetry(reading) {
    const device = state.devices.get(reading.device_id);
    if (device) {
      device.metrics = device.metrics || {};
      device.metrics[reading.sensor_name] = {
        value: reading.value,
        unit: reading.unit || null,
        ts: reading.created_at,
      };
      device.last_seen = reading.created_at;
      device.status = 'online';
      upsertDevice(device);
      updateCard(reading.device_id, reading.sensor_name);
    } else {
      scheduleGridRefresh();
    }

    // Nothing chosen yet: follow the newest stream automatically.
    if (!state.chart.device) {
      const newest = [...state.devices.values()]
        .filter((d) => Object.keys(d.metrics || {}).length)
        .sort((a, b) => (b.last_seen || 0) - (a.last_seen || 0))[0];
      if (newest) selectDevice(newest.device_id, { sensorName: reading.sensor_name });
      return;
    }

    if (reading.device_id !== state.chart.device) return;
    if (reading.sensor_name !== state.chart.sensor) {
      // A new sensor appeared for the selected device: offer it.
      const sensors = Object.keys(state.devices.get(reading.device_id)?.metrics || {});
      if (sensors.length) renderSensorOptions(sensors, state.chart.sensor);
      return;
    }

    // Chart paused with the LIVE toggle: keep the series frozen.
    if (!state.chart.live) return;

    state.chart.points.push({ ts: reading.created_at, value: reading.value });
    if (state.chart.points.length > MAX_CHART_POINTS) state.chart.points.shift();
    chartPush({ ts: reading.created_at, value: reading.value });
  }

  /* ---------------------------------------------------------------------- */
  /* Terminal                                                               */
  /* ---------------------------------------------------------------------- */

  function terminalLine(entry) {
    // Device-scoped focus (the "LOGS" button on a device card).
    if (state.termDevice) {
      const tagged = entry.meta && entry.meta.device_id === state.termDevice;
      if (!tagged && !String(entry.message || '').includes(state.termDevice)) return;
    }
    if (state.focus && ['info', 'mqtt'].includes(entry.level)) return;
    if (state.paused) {
      state.termLines += 1;
      $('term-count').textContent = `${state.termLines} LINES (PAUSED)`;
      return;
    }

    const box = $('terminal');
    const node = document.createElement('div');
    node.className = `term-line term-${esc(entry.level || 'info')}`;
    node.innerHTML = `<span class="term-time">${esc(clockTime(entry.ts || Date.now()))}</span> <span class="term-source">[${esc(
      entry.source || 'SYS',
    )}]</span> <span>${esc(entry.message)}</span>`;

    const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 48;
    box.insertBefore(node, $('term-cursor-line'));

    while (box.querySelectorAll('.term-line').length > MAX_TERMINAL_LINES) {
      box.querySelector('.term-line').remove();
    }
    state.termLines += 1;
    $('term-count').textContent = `${state.termLines} LINES`;
    if (nearBottom) box.scrollTop = box.scrollHeight;
  }

  function clearTerminal() {
    const box = $('terminal');
    for (const line of box.querySelectorAll('.term-line')) line.remove();
    state.termLines = 0;
    $('term-count').textContent = '0 LINES';
    box.scrollTop = 0;
  }

  /* ---------------------------------------------------------------------- */
  /* Commands                                                               */
  /* ---------------------------------------------------------------------- */

  const STATUS_STYLES = {
    pending: 'text-[#eaff6b] border-[rgba(234,255,107,0.4)]',
    delivered: 'text-[#7dd3fc] border-[rgba(125,211,252,0.4)]',
    acked: 'text-neon border-[rgba(57,255,20,0.45)]',
    failed: 'text-[#ffb3ad] border-[rgba(255,59,48,0.5)]',
  };

  function commandRow(command) {
    return `<tr data-command="${command.id}">
      <td class="py-1 pr-1 text-[#47605a]">${command.id}</td>
      <td class="py-1 pr-1 text-[#9fd8b4]">${esc(command.device_id)}</td>
      <td class="py-1 pr-1 max-w-[9rem] truncate text-[#6d8b84]" title="${esc(command.payload)}">${esc(
        String(command.payload).slice(0, 48),
      )}</td>
      <td class="py-1"><span class="badge px-1.5 py-0 text-[0.55rem] ${STATUS_STYLES[command.status] || ''}">${esc(
        command.status,
      )}</span></td>
    </tr>`;
  }

  function renderCommands(commands) {
    state.commands = commands;
    const body = $('commands-list');
    $('commands-count').textContent = `${commands.length}`;
    body.innerHTML = commands.length
      ? commands.map(commandRow).join('')
      : '<tr><td colspan="4" class="py-2 text-center text-[#47605a]">no commands yet</td></tr>';
  }

  function onCommandEvent(command, { prepend = false } = {}) {
    if (!command) return;
    const existing = state.commands.find((c) => c.id === command.id);
    if (existing) Object.assign(existing, command);
    else state.commands = [command, ...state.commands].slice(0, 50);

    renderCommands(state.commands);
    if (prepend) refreshStatsSoon();
  }

  let statsSoonTimer = null;
  function refreshStatsSoon() {
    if (statsSoonTimer) return;
    statsSoonTimer = setTimeout(() => {
      statsSoonTimer = null;
      api('/api/stats')
        .then((res) => renderStats(res.data))
        .catch(() => {});
    }, 1200);
  }

  async function sendCommand(deviceId, payload) {
    return api('/api/webhook/command', {
      method: 'POST',
      body: JSON.stringify({ device_id: deviceId, command: payload, source: 'ui' }),
    });
  }

  /** Card quick action — queue RELAY_ON / RELAY_OFF for one device. */
  async function sendRelayCommand(deviceId, action, button) {
    const original = button.textContent;
    button.disabled = true;
    button.textContent = '…';
    try {
      const response = await sendCommand(
        deviceId,
        JSON.stringify({ action, source: 'quick-action', issued_at: Date.now() }),
      );
      state.relayStates.set(deviceId, action === 'RELAY_OFF' ? 'OFF' : 'ON');

      const card = state.cards.get(deviceId);
      const device = state.devices.get(deviceId);
      if (card && device) applyCardState(card, device);

      toast(
        `#${response.data.id} ${action} → ${deviceId}${response.published ? '' : ' (queued for device polling)'}`,
        response.published ? 'success' : 'warn',
      );
    } catch (error) {
      toast(`${action} failed: ${error.message}`, 'error');
    } finally {
      button.disabled = false;
      button.textContent = original;
    }
  }

  /** Card "LOGS" action — scope the terminal to a single device. */
  function setTerminalDeviceFilter(deviceId) {
    state.termDevice = deviceId || null;
    const chip = $('term-device-filter');
    if (!chip) return;
    chip.classList.toggle('hidden', !state.termDevice);
    $('term-device-filter-label').textContent = state.termDevice || '';
    if (state.termDevice && $('terminal-section')) {
      $('terminal-section').scrollIntoView({ behavior: 'smooth', block: 'end' });
      toast(`Terminal filtered to ${state.termDevice}`, 'info', 2400);
    }
  }

  /** Publishes the top-bar height so the sticky grid filter bar sits below it. */
  function syncHeaderHeight() {
    const header = document.querySelector('header');
    if (!header) return;
    const apply = () =>
      document.documentElement.style.setProperty('--header-h', `${Math.round(header.getBoundingClientRect().height)}px`);
    apply();
    if (typeof ResizeObserver !== 'undefined' && !syncHeaderHeight.observer) {
      syncHeaderHeight.observer = new ResizeObserver(apply);
      syncHeaderHeight.observer.observe(header);
    }
  }

  /* ---------------------------------------------------------------------- */
  /* Automation                                                             */
  /* ---------------------------------------------------------------------- */

  function renderRules(rules) {
    state.rules = rules || [];
    const enabled = state.rules.filter((r) => r.enabled).length;
    $('rules-count').textContent = `${enabled}/${state.rules.length} RULES`;

    const list = $('rules-list');
    if (!state.rules.length) {
      list.innerHTML = '<p class="text-[0.68rem] text-[#47605a]">No rules yet — add one below.</p>';
      return;
    }

    list.innerHTML = state.rules
      .map(
        (rule) => `
      <div class="rule-row ${rule.enabled ? '' : 'is-disabled'} p-2.5" data-rule="${rule.id}">
        <div class="flex items-start gap-2">
          <button class="switch mt-0.5" role="switch" aria-checked="${rule.enabled ? 'true' : 'false'}"
                  data-rule-toggle="${rule.id}" aria-label="Toggle rule ${esc(rule.name)}"></button>
          <div class="min-w-0 flex-1">
            <p class="truncate text-[0.7rem] text-[#d9ffcf]" title="${esc(rule.name)}">${esc(rule.name)}</p>
            <p class="mt-0.5 text-[0.62rem] text-[#6d8b84]">
              IF <span class="text-neon">${esc(rule.sensor_name)}</span> ${esc(rule.operator)}
              <span class="text-neon">${esc(fmtNumber(rule.threshold))}</span>
              → <span class="text-[#eaff6b]">${esc(rule.action)}</span>
            </p>
            <p class="mt-0.5 text-[0.58rem] text-[#47605a]">
              ${esc(rule.device_id === '*' ? 'all devices' : rule.device_id)} · cooldown ${rule.cooldown_seconds}s ·
              fired ${rule.trigger_count}× ${rule.last_triggered ? `· last ${esc(relTime(rule.last_triggered))}` : ''}
            </p>
          </div>
          <button class="btn btn-danger px-1.5 py-0.5 text-[0.55rem]" data-rule-delete="${rule.id}" type="button">DEL</button>
        </div>
      </div>`,
      )
      .join('');
  }

  function renderRuleEvents(events) {
    state.ruleEvents = events || [];
    const list = $('rule-events');
    if (!state.ruleEvents.length) {
      list.innerHTML = '<li class="text-[#47605a]">no triggers recorded</li>';
      return;
    }
    list.innerHTML = state.ruleEvents
      .slice(0, 10)
      .map(
        (event) => `<li class="truncate" title="${esc(event.rule_name)} on ${esc(event.device_id)}">
          <span class="text-[#47605a]">${esc(clockTime(event.created_at))}</span>
          <span class="text-neon">${esc(event.device_id)}</span>
          ${esc(event.sensor_name)}=${esc(fmtNumber(event.value))}${esc(event.operator)}${esc(fmtNumber(event.threshold))}
          → <span class="text-[#eaff6b]">${esc(event.action)}</span>
        </li>`,
      )
      .join('');
  }

  /* ---------------------------------------------------------------------- */
  /* Wiring                                                                 */
  /* ---------------------------------------------------------------------- */

  function bindEvents() {
    // ---- socket
    const socket = (state.socket = io({ transports: ['websocket', 'polling'] }));

    socket.on('connect', () => setConnected(true));
    socket.on('disconnect', () => setConnected(false));
    socket.on('connect_error', () => setConnected(false));

    socket.on('bootstrap', (payload) => {
      state.devices.clear();
      for (const device of payload.devices || []) upsertDevice(device);
      renderGrid();
      renderRules(payload.rules);
      renderRuleEvents(payload.rule_events);
      renderCommands(payload.commands || []);
      renderStats(payload.stats);
      renderMqtt(payload.mqtt);
      for (const entry of payload.terminal || []) terminalLine(entry);

      if (state.chart.live && !state.selected) {
        const candidate = [...state.devices.values()]
          .filter((d) => d.status === 'online' && Object.keys(d.metrics || {}).length)
          .sort((a, b) => (b.last_seen || 0) - (a.last_seen || 0))[0];
        if (candidate) selectDevice(candidate.device_id);
        else {
          const anyDevice = [...state.devices.values()][0];
          if (anyDevice) {
            state.chart.device = anyDevice.device_id;
            $('chart-device').value = anyDevice.device_id;
            renderSensorOptions(Object.keys(anyDevice.metrics || {}));
          }
        }
      }
      toast(`Dashboard synced · ${payload.total_devices} devices`, 'success', 2600);
    });

    socket.on('telemetry_update', onTelemetry);
    const onDeviceEvent = (device) => {
      upsertDevice(device);
      updateCard(device.device_id, null, { flash: false });
      // Device may need to appear/disappear/reorder in the grid.
      scheduleGridRefresh();
    };
    socket.on('device_status', onDeviceEvent); // documented device-grid event
    socket.on('device_update', onDeviceEvent); // backwards-compatible alias
    socket.on('command_sent', (command) => onCommandEvent(command, { prepend: true }));
    socket.on('command_delivered', (command) => onCommandEvent(command));
    socket.on('command_acked', (command) => onCommandEvent(command));
    socket.on('stats', renderStats);
    socket.on('mqtt_status', renderMqtt);
    socket.on('terminal', terminalLine);
    socket.on('rules_changed', renderRules);
    socket.on('rule_triggered', ({ rule, reading, command }) => {
      toast(`RULE #${rule.id} fired on ${reading.device_id}: ${rule.action}`, 'warn', 6000);
      prependRuleEvent(rule, reading);
      renderRules(
        state.rules.map((r) => (String(r.id) === String(rule.id) ? { ...r, trigger_count: (r.trigger_count || 0) + 1, last_triggered: Date.now() } : r)),
      );
      if (command) onCommandEvent(command, { prepend: true });
    });

    function prependRuleEvent(rule, reading) {
      renderRuleEvents([
        {
          id: Date.now(),
          rule_id: rule.id,
          rule_name: rule.name,
          device_id: reading.device_id,
          sensor_name: reading.sensor_name,
          value: reading.value,
          operator: rule.operator,
          threshold: rule.threshold,
          action: rule.action,
          created_at: Date.now(),
        },
        ...state.ruleEvents,
      ]);
    }

    // ---- device grid
    // Select a card, or run one of its quick actions.
    $('device-grid').addEventListener('click', async (event) => {
      const card = event.target.closest('.device-card');
      if (!card) return;
      const deviceId = card.dataset.device;

      const relayButton = event.target.closest('[data-relay]');
      if (relayButton) {
        await sendRelayCommand(deviceId, relayButton.dataset.relay, relayButton);
        return;
      }

      if (event.target.closest('[data-logs]')) {
        setTerminalDeviceFilter(deviceId);
        return;
      }

      selectDevice(deviceId);
    });

    $('device-more').addEventListener('click', () => {
      state.pageCount += 1;
      renderGrid({ keepPage: true });
    });

    let searchTimer = null;
    $('device-search').addEventListener('input', (event) => {
      const value = event.target.value;
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => {
        state.search = value;
        renderGrid();
      }, 180);
    });

    $('device-sort').addEventListener('change', (event) => {
      state.sort = event.target.value;
      renderGrid();
    });

    for (const button of document.querySelectorAll('[data-status-filter]')) {
      button.addEventListener('click', () => {
        state.filter = button.dataset.statusFilter;
        for (const other of document.querySelectorAll('[data-status-filter]')) {
          other.classList.toggle('btn-active', other === button);
        }
        renderGrid();
      });
    }

    // ---- chart controls
    $('chart-device').addEventListener('change', (event) => selectDevice(event.target.value));
    $('chart-sensor').addEventListener('change', (event) => {
      state.chart.sensor = event.target.value;
      loadChartSeries();
    });
    $('chart-range').addEventListener('change', loadChartSeries);
    $('chart-live').addEventListener('click', () => {
      state.chart.live = !state.chart.live;
      $('chart-live').classList.toggle('btn-active', state.chart.live);
      $('chart-live').textContent = state.chart.live ? '● LIVE' : '○ PAUSED';
      if (state.chart.live) loadChartSeries(); // catch up on the frozen window
      toast(state.chart.live ? 'Live stream resumed' : 'Chart paused (history kept)', 'info', 2400);
    });

    // ---- command form
    $('cmd-use-selected').addEventListener('click', () => {
      if (!state.selected) return toast('No device selected — click a device card first', 'warn');
      $('cmd-device').value = state.selected;
    });

    for (const button of document.querySelectorAll('[data-cmd-mode]')) {
      button.addEventListener('click', () => {
        state.cmdMode = button.dataset.cmdMode;
        for (const other of document.querySelectorAll('[data-cmd-mode]')) {
          other.classList.toggle('btn-active', other === button);
        }
        $('cmd-payload-hint').textContent =
          state.cmdMode === 'json'
            ? 'JSON mode validates the payload and sends a compact object.'
            : 'Text mode sends the payload verbatim.';
      });
    }

    for (const button of document.querySelectorAll('[data-quick-command]')) {
      button.addEventListener('click', () => {
        const cmd = button.dataset.quickCommand;
        $('cmd-payload').value = state.cmdMode === 'json' ? JSON.stringify({ action: cmd }, null, 2) : cmd;
      });
    }

    $('cmd-payload').addEventListener('input', () => {
      if (state.cmdMode !== 'json') return;
      const value = $('cmd-payload').value.trim();
      if (!value) return;
      try {
        JSON.parse(value);
        $('cmd-payload-hint').innerHTML = '<span class="text-neon">✓ valid JSON</span>';
      } catch (error) {
        $('cmd-payload-hint').innerHTML = `<span class="text-[#ffb3ad]">✗ ${esc(error.message)}</span>`;
      }
    });

    $('command-form').addEventListener('submit', async (event) => {
      event.preventDefault();
      const deviceId = $('cmd-device').value.trim();
      const raw = $('cmd-payload').value.trim();
      if (!deviceId) return toast('Target device id is required', 'warn');
      if (!raw) return toast('Command payload is required', 'warn');

      let payload = raw;
      if (state.cmdMode === 'json') {
        try {
          payload = JSON.stringify(JSON.parse(raw));
        } catch (error) {
          return toast(`Invalid JSON: ${error.message}`, 'error');
        }
      }

      const button = $('cmd-send');
      button.disabled = true;
      $('cmd-result').innerHTML = '<span class="spinner inline-block align-middle"></span> sending…';
      try {
        const response = await sendCommand(deviceId, payload);
        const queued = response.data;
        $('cmd-result').innerHTML = response.published
          ? `<span class="text-neon">✓ published to iot/${esc(deviceId)}/command (cmd #${queued.id})</span>`
          : `<span class="text-[#ffcc66]">⧗ queued #${queued.id} — MQTT broker offline, device can poll /api/webhook/command/poll</span>`;
        onCommandEvent(queued, { prepend: true });
      } catch (error) {
        $('cmd-result').innerHTML = `<span class="text-[#ffb3ad]">✗ ${esc(error.message)}</span>`;
        toast(`Command failed: ${error.message}`, 'error');
      } finally {
        button.disabled = false;
      }
    });

    document.addEventListener('keydown', (event) => {
      if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
        event.preventDefault();
        $('command-form').requestSubmit();
      }
    });

    // ---- automation
    $('rules-list').addEventListener('click', async (event) => {
      const toggle = event.target.closest('[data-rule-toggle]');
      if (toggle) {
        const id = toggle.dataset.ruleToggle;
        const rule = state.rules.find((r) => String(r.id) === String(id));
        const next = rule ? !rule.enabled : true;
        toggle.setAttribute('aria-checked', next ? 'true' : 'false');
        try {
          const response = await api(`/api/rules/${id}/toggle`, {
            method: 'POST',
            body: JSON.stringify({ enabled: next }),
          });
          renderRules(state.rules.map((r) => (String(r.id) === String(id) ? response.data : r)));
          toast(`Rule #${id} ${response.data.enabled ? 'enabled' : 'disabled'}`, response.data.enabled ? 'success' : 'warn');
        } catch (error) {
          toast(`Toggle failed: ${error.message}`, 'error');
          renderRules(state.rules);
        }
        return;
      }

      const remove = event.target.closest('[data-rule-delete]');
      if (remove) {
        const id = remove.dataset.ruleDelete;
        if (!window.confirm(`Delete automation rule #${id}?`)) return;
        try {
          await api(`/api/rules/${id}`, { method: 'DELETE' });
          renderRules(state.rules.filter((r) => String(r.id) !== String(id)));
          toast(`Rule #${id} deleted`, 'warn');
        } catch (error) {
          toast(`Delete failed: ${error.message}`, 'error');
        }
      }
    });

    $('rule-form').addEventListener('submit', async (event) => {
      event.preventDefault();
      const body = {
        name: $('rule-name').value.trim(),
        sensor_name: $('rule-sensor').value.trim(),
        operator: $('rule-operator').value,
        threshold: Number($('rule-threshold').value),
        action: $('rule-action').value.trim(),
        cooldown_seconds: Number($('rule-cooldown').value),
        device_id: $('rule-device').value.trim() || '*',
      };
      if (!body.sensor_name || !body.action) return toast('Sensor and action are required', 'warn');
      if (!Number.isFinite(body.threshold)) return toast('Threshold must be a number', 'warn');

      try {
        const response = await api('/api/rules', { method: 'POST', body: JSON.stringify(body) });
        renderRules([response.data, ...state.rules]);
        $('rule-form').reset();
        $('rule-threshold').value = '30';
        $('rule-cooldown').value = '60';
        $('rule-action').value = 'RELAY_OFF';
        $('rule-device').value = '*';
        toast(`Rule created: ${response.data.name}`, 'success');
      } catch (error) {
        toast(`Could not create rule: ${error.message}`, 'error');
      }
    });

    $('rules-refresh').addEventListener('click', async () => {
      try {
        const response = await api('/api/rules');
        renderRules(response.data);
        renderRuleEvents(response.events);
        toast('Rules reloaded', 'info', 1800);
      } catch (error) {
        toast(`Reload failed: ${error.message}`, 'error');
      }
    });

    // ---- terminal controls
    $('term-clear').addEventListener('click', clearTerminal);
    $('term-pause').addEventListener('click', () => {
      state.paused = !state.paused;
      $('term-pause').classList.toggle('btn-active', state.paused);
      $('term-pause').textContent = state.paused ? 'RESUME' : 'PAUSE';
      if (!state.paused) {
        $('term-count').textContent = `${state.termLines} LINES`;
        $('terminal').scrollTop = $('terminal').scrollHeight;
      }
    });
    $('term-filter-toggle').addEventListener('click', () => {
      state.focus = !state.focus;
      $('term-filter-toggle').classList.toggle('btn-active', state.focus);
      toast(state.focus ? 'Terminal focus: webhooks, commands, rules only' : 'Terminal focus: everything', 'info', 2200);
    });
    $('term-device-filter-clear').addEventListener('click', () => setTerminalDeviceFilter(null));

    // Keep the sticky bar aligned and re-chart cards revealed by a resize.
    window.addEventListener('resize', () => {
      syncHeaderHeight();
      clearTimeout(window._sparklineResizeTimer);
      window._sparklineResizeTimer = setTimeout(createVisibleSparklines, 220);
    });
  }

  /* ---------------------------------------------------------------------- */
  /* Boot                                                                   */
  /* ---------------------------------------------------------------------- */

  function startClock() {
    const tick = () => {
      $('clock').textContent = new Date().toLocaleTimeString('en-GB', { hour12: false });
    };
    tick();
    setInterval(tick, 1000);
    setInterval(refreshHeartbeats, 5000);
  }

  function boot() {
    if (typeof io === 'undefined') {
      setConnected(false);
      toast('Socket.io client failed to load', 'error', 8000);
      return;
    }
    initChart();
    initSparklineObserver();
    syncHeaderHeight();
    renderSensorOptions(['temperature']);
    renderGrid();
    startClock();
    bindEvents();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

  // Expose a tiny debug handle (handy in the browser console / handover docs).
  window.iotDashboard = { state, api, selectDevice, toast };
})();
