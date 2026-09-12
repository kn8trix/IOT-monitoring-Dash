/* ==========================================================================
   IOT // DASHBOARD — client application
   Vanilla ES2020, no build step. Talks to the server over REST + Socket.io.

   Layout contract
     · the dashboard body shows ONLY the stats strip and the device card grid
     · clicking a card opens the DEVICE INSPECTOR modal (chart, commands,
       custom config, per-device terminal)
     · fleet-wide admin (upstream forwarding, automation, command queue,
       system log) lives in the SETTINGS modal, opened from the header
   ========================================================================== */

(() => {
  'use strict';

  const NEON = '#39FF14';
  const MAX_CHART_POINTS = 180;
  const PAGE_SIZE = 12; // large cards (min-height 260px) — 2/3 columns on desktop
  const MAX_TERMINAL_LINES = 400;
  const MAX_DEVICE_LOG_LINES = 400;
  const HEARTBEAT_MS = 30_000; // last ping younger than this ⇒ ONLINE

  const $ = (id) => document.getElementById(id);

  const state = {
    socket: null,
    connected: false,
    devices: new Map(), // device_id -> device
    cards: new Map(), // device_id -> card element
    gridSignature: '',
    pageCount: 1,
    filter: 'all',
    search: '',
    sort: 'status',
    stats: null,
    mqtt: null,
    settings: null,
    rules: [],
    ruleEvents: [],
    commands: [],
    forwardLogs: [],
    forwardStats: null,
    termPaused: false,
    termFocus: false,
    termLines: 0,
    // device inspector
    device: {
      id: null,
      tab: 'telemetry',
      sensor: null,
      points: [],
      live: true,
      chart: null,
      config: null,
      configDraft: {},
      configDirty: false,
      payloadMode: 'json',
      logPaused: false,
      logLines: [],
    },
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

  const clockTime = (ts) =>
    new Date(ts).toLocaleTimeString('en-GB', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });

  function relTime(ts) {
    if (!ts) return 'never';
    const delta = Math.max(0, Date.now() - ts);
    if (delta < 1000) return 'just now';
    const s = Math.floor(delta / 1000);
    if (s < 60) return `${s}s ago`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m ago`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h ago`;
    return `${Math.floor(h / 24)}d ago`;
  }

  function deviceAge(device) {
    return device && device.last_seen ? Math.max(0, Date.now() - device.last_seen) : Infinity;
  }

  /** Heartbeat rule for the cards: ONLINE while the last ping is < 30 s old. */
  function isOnline(device) {
    return deviceAge(device) < HEARTBEAT_MS;
  }

  function updatedLabel(device) {
    if (!device.last_seen) return 'No ping received';
    return `Updated ${relTime(device.last_seen)}`;
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
    if (!response.ok || payload.ok === false) throw new Error(payload.error || `HTTP ${response.status}`);
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
    el.className = `panel fade-in px-3.5 py-2.5 text-base ${TOAST_STYLES[level] || TOAST_STYLES.info}`;
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
    $('socket-dot').className = `dot ${connected ? 'dot-online' : 'dot-offline'}`;
    $('status-label').textContent = connected ? 'ACTIVE' : 'DEGRADED';
    $('status-label').className = connected ? 'text-neon glow-text-soft' : 'text-[#ffb020]';
    $('status-dot').className = `dot ${connected ? 'dot-online' : 'dot-stale'}`;
    $('socket-label').textContent = connected ? 'LINK: LIVE' : 'LINK: LOST';
    $('socket-badge').classList.toggle('glow-border', connected);
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

  /**
   * The four summary numbers in the header strip: total, online, offline and
   * forwarded webhooks. Everything else lives in the settings modal.
   */
  function renderStats(stats) {
    if (!stats) return;
    state.stats = stats;
    const forwarded = stats.forward_stats ? stats.forward_stats.success : (stats.forward?.delivered ?? 0);

    $('stat-total').textContent = stats.devices.total;
    $('stat-online').textContent = stats.devices.online;
    $('stat-offline').textContent = stats.devices.offline;
    $('stat-forwarded').textContent = forwarded;

    if (stats.forward) renderForwardStatus(stats.forward, stats.forward_stats);
  }

  /* ---------------------------------------------------------------------- */
  /* Device grid                                                            */
  /* ---------------------------------------------------------------------- */

  function upsertDevice(device) {
    if (!device || !device.device_id) return null;
    const previous = state.devices.get(device.device_id);
    const merged = previous ? { ...previous, ...device } : device;
    if (previous && previous.metrics) merged.metrics = { ...previous.metrics, ...(device.metrics || {}) };
    // device_status frames never carry the saved config — keep what we have.
    if (previous && previous.config && !device.config) {
      merged.config = previous.config;
      merged.config_revision = previous.config_revision;
      merged.config_updated_at = previous.config_updated_at;
    }
    state.devices.set(device.device_id, merged);
    return merged;
  }

  /** Sensor shown as the single large reading on a card / in the modal. */
  function primarySensor(device) {
    const sensors = Object.keys(device.metrics || {});
    if (!sensors.length) return null;
    return sensors.includes('temperature') ? 'temperature' : sensors.sort()[0];
  }

  function metricLabel(name) {
    return String(name).replace(/_/g, ' ').toUpperCase();
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

  function renderedDevices(matching) {
    const byStatus =
      state.filter === 'online'
        ? matching.filter(isOnline)
        : state.filter === 'offline'
          ? matching.filter((device) => !isOnline(device))
          : matching;
    return byStatus.slice(0, state.pageCount * PAGE_SIZE);
  }

  /** "TOTAL: X | ONLINE: Y | OFFLINE: Z" census in the sticky filter bar. */
  function renderCensus(matching) {
    const online = matching.filter(isOnline).length;
    const offline = matching.length - online;
    $('device-count').innerHTML =
      `<span class="text-[#6d8b84]">TOTAL:</span> <b class="text-[#d9ffcf]">${matching.length}</b>` +
      `<span class="text-[#2d4a44]"> | </span><span class="text-[#6d8b84]">ONLINE:</span> <b class="text-neon glow-text-soft">${online}</b>` +
      `<span class="text-[#2d4a44]"> | </span><span class="text-[#6d8b84]">OFFLINE:</span> <b class="${offline ? 'text-[#ff7b72]' : 'text-[#6d8b84]'}">${offline}</b>`;
  }

  /**
   * A card carries only its core identity: device id, status, IP, the live
   * reading and when it was last heard from. Everything else (chart, commands,
   * configuration, console, forwarding) belongs to the inspector modal.
   */
  function cardInner(device) {
    const online = isOnline(device);
    const sensor = primarySensor(device);
    const primary = sensor ? (device.metrics || {})[sensor] : null;
    const name = device.name && device.name !== device.device_id ? device.name : null;

    return `
      <header class="flex items-start gap-3">
        <div class="min-w-0 flex-1">
          <h3 class="device-id" title="${esc(device.device_id)}" data-role="device-id">${esc(device.device_id)}</h3>
          ${name ? `<p class="reading-secondary" title="${esc(name)}">${esc(name)}</p>` : ''}
        </div>
        <span class="status-badge ${online ? 'status-online' : 'status-offline'}" data-role="badge">
          <span class="dot ${online ? 'dot-online' : 'dot-offline'}" data-role="dot"></span>
          <span data-role="status">${online ? 'ONLINE' : 'OFFLINE'}</span>
        </span>
      </header>

      <p class="device-ip">IP <b data-role="ip">${esc(device.ip || '—')}</b></p>

      <div class="my-auto">
        <p class="metric-label" data-role="reading-label">${esc(sensor ? metricLabel(sensor) : 'AWAITING DATA')}</p>
        <p class="reading-value"><span data-role="reading">${esc(primary ? fmtNumber(primary.value) : '--')}</span>${
          primary && primary.unit ? `<span class="reading-unit" data-role="reading-unit">${esc(primary.unit)}</span>` : ''
        }</p>
      </div>

      <footer class="flex items-center gap-2 border-t border-edge pt-2.5">
        <span class="card-meta" data-role="seen">${esc(updatedLabel(device))}</span>
        <span class="ml-auto text-base text-neon glow-text-soft">INSPECT ▸</span>
      </footer>`;
  }

  function createCard(device) {
    const card = document.createElement('article');
    card.className = 'device-card';
    card.dataset.device = device.device_id;
    card.tabIndex = 0;
    card.setAttribute('role', 'button');
    card.setAttribute('aria-label', `Open inspector for ${device.device_id}`);
    card.innerHTML = cardInner(device);
    applyCardState(card, device);
    return card;
  }

  function applyCardState(card, device) {
    const online = isOnline(device);
    card.classList.toggle('is-online', online);
    card.classList.toggle('is-offline', !online);

    const dot = card.querySelector('[data-role="dot"]');
    if (dot) dot.className = `dot ${online ? 'dot-online' : 'dot-offline'}`;
    const badge = card.querySelector('[data-role="badge"]');
    if (badge) badge.className = `status-badge ${online ? 'status-online' : 'status-offline'}`;
    const status = card.querySelector('[data-role="status"]');
    if (status) status.textContent = online ? 'ONLINE' : 'OFFLINE';
  }

  /** ~0.9 s neon border pulse marking a card that just received data. */
  function flashCard(card) {
    card.classList.remove('card-live-flash');
    void card.offsetWidth;
    card.classList.add('card-live-flash');
    clearTimeout(card._flashTimer);
    card._flashTimer = setTimeout(() => card.classList.remove('card-live-flash'), 950);
  }

  function renderGrid({ keepPage = false } = {}) {
    if (!keepPage) state.pageCount = 1;

    const matching = matchingDevices();
    const list = renderedDevices(matching);
    const grid = $('device-grid');

    grid.textContent = '';
    state.cards.clear();

    // Empty fleet (nothing has ever reported in) or an over-eager filter.
    if (state.devices.size === 0) grid.appendChild(emptyState('waiting'));
    else if (!matching.length) grid.appendChild(emptyState('filtered'));

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
      ? `showing ${list.length} of ${matching.length} matching · ${state.devices.size} registered · heartbeat < ${HEARTBEAT_MS / 1000}s · click a card to inspect`
      : state.devices.size === 0
        ? 'waiting for the first device to report in'
        : 'no devices match the current filter';
    $('device-more').classList.toggle('hidden', list.length >= matching.length);
  }

  /**
   * Placeholder for an empty grid, in two flavours: no devices at all (the
   * normal state of a fresh install) and "nothing matches the filter".
   */
  function emptyState(kind) {
    const el = document.createElement('div');
    el.className = 'empty-state fade-in';

    if (kind === 'filtered') {
      el.innerHTML =
        '<p class="empty-state-title text-[#9fd8b4]">NO MATCHING DEVICES</p>' +
        '<p class="empty-state-text">Nothing matches the current search or status filter.</p>' +
        '<p class="empty-state-hint">Clear the search box, or switch back to ALL DEVICES.</p>';
      return el;
    }

    el.innerHTML =
      '<span class="dot dot-online"></span>' +
      '<p class="empty-state-title">NO IOT DEVICES REGISTERED YET</p>' +
      '<p class="empty-state-text">Waiting for incoming telemetry…</p>' +
      '<p class="empty-state-hint">A card appears here the instant a device reports in — this dashboard fabricates nothing.<br />' +
      'Post a reading, or publish to <code>iot/&lt;device_id&gt;/telemetry</code>:</p>' +
      '<code>curl -X POST /api/webhook/data -H \'Content-Type: application/json\' \\<br />&nbsp;&nbsp;-d \'{"device_id":"ESP32-101","sensor_name":"temperature","value":24.6,"unit":"C"}\'</code>' +
      '<p class="empty-state-hint">No hardware yet? <code>npm run simulate</code> registers a virtual fleet the same way real nodes do.</p>';
    return el;
  }

  /** In-place patch of one card — no page re-render for a telemetry frame. */
  function updateCard(deviceId, { flash = true } = {}) {
    const card = state.cards.get(deviceId);
    const device = state.devices.get(deviceId);
    if (!device || !card) return;

    applyCardState(card, device);

    const seen = card.querySelector('[data-role="seen"]');
    if (seen) seen.textContent = updatedLabel(device);
    const ip = card.querySelector('[data-role="ip"]');
    if (ip) ip.textContent = device.ip || '—';

    const sensor = primarySensor(device);
    const primary = sensor ? (device.metrics || {})[sensor] : null;

    const label = card.querySelector('[data-role="reading-label"]');
    const reading = card.querySelector('[data-role="reading"]');
    const unit = card.querySelector('[data-role="reading-unit"]');
    if (label) label.textContent = sensor ? metricLabel(sensor) : 'AWAITING DATA';
    if (reading) {
      const next = primary ? fmtNumber(primary.value) : '--';
      if (reading.textContent !== next) {
        reading.textContent = next;
        reading.classList.remove('flash-value');
        void reading.offsetWidth;
        reading.classList.add('flash-value');
      }
    }
    if (unit && primary && primary.unit) unit.textContent = primary.unit;

    if (flash) flashCard(card);
  }

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
      for (const device of list) updateCard(device.device_id, { flash: false });
    }, 500);
  }

  function refreshHeartbeats() {
    for (const [deviceId, card] of state.cards) {
      const device = state.devices.get(deviceId);
      if (!device) continue;
      applyCardState(card, device);
      const seen = card.querySelector('[data-role="seen"]');
      if (seen) seen.textContent = updatedLabel(device);
    }
    if (state.cards.size) renderCensus(matchingDevices());
    if (state.device.id) renderDeviceHead();
  }

  /* ---------------------------------------------------------------------- */
  /* Modal plumbing                                                         */
  /* ---------------------------------------------------------------------- */

  function openModal(id) {
    const modal = $(id);
    modal.classList.remove('hidden');
    modal.classList.add('fade-in');
    document.body.style.overflow = 'hidden';
  }

  function closeModal(id) {
    $(id).classList.add('hidden');
    if ($('device-modal').classList.contains('hidden') && $('settings-modal').classList.contains('hidden')) {
      document.body.style.overflow = '';
    }
  }

  function closeAllModals() {
    closeModal('device-modal');
    closeModal('settings-modal');
  }

  /* ---------------------------------------------------------------------- */
  /* DEVICE INSPECTOR                                                       */
  /* ---------------------------------------------------------------------- */

  function openDevice(deviceId) {
    const device = state.devices.get(deviceId);
    if (!device) {
      toast(`unknown device: ${deviceId}`, 'warn');
      return;
    }

    const d = state.device;
    d.id = deviceId;
    d.points = [];
    d.logLines = [];
    d.logPaused = false;
    d.payloadMode = 'json';
    // fresh inspector for a fresh device — no unsaved draft carries over
    d.configDirty = false;
    d.configDraft = {};
    $('dm-config-result').textContent = '';

    destroyDeviceChart();
    renderDeviceHead();
    document.querySelectorAll('[data-modal-tab]').forEach((tab) => tab.classList.toggle('is-active', tab.dataset.modalTab === 'telemetry'));
    showDeviceTab('telemetry');

    $('dm-log-device').textContent = deviceId;
    $('dm-terminal').querySelectorAll('.term-line').forEach((line) => line.remove());
    $('dm-log-count').textContent = '0 LINES';
    $('dm-result').textContent = '';
    $('dm-config-result').textContent = '';
    $('dm-payload').value = '';
    $('dm-payload-hint').textContent = 'JSON payloads are validated before sending.';

    renderSensorOptions();
    initDeviceChart();
    loadDeviceSeries();
    loadDeviceDetail();
    renderDeviceCommands([]);

    // Backfill the device console from the REST history before the live stream
    // takes over (telemetry + command rows are both useful in the log).
    backfillDeviceLog(deviceId);

    openModal('device-modal');
  }

  function closeDevice() {
    destroyDeviceChart();
    state.device.id = null;
    closeModal('device-modal');
  }

  function renderDeviceHead() {
    const device = state.devices.get(state.device.id);
    if (!device) return;
    const online = isOnline(device);

    $('dm-title').textContent = device.name || device.device_id;
    $('dm-subtitle').textContent = [
      device.device_id,
      device.ip ? `IP ${device.ip}` : null,
      device.mac ? `MAC ${device.mac}` : null,
      device.location,
    ]
      .filter(Boolean)
      .join(' · ');

    $('dm-dot').className = `dot ${online ? 'dot-online' : 'dot-offline'}`;
    $('dm-badge').className = `status-badge ${online ? 'status-online' : 'status-offline'}`;
    $('dm-status').textContent = online ? 'ONLINE' : 'OFFLINE';

    $('dm-last-ping').textContent = device.last_seen ? relTime(device.last_seen) : 'never';
    $('dm-location').textContent = device.location || '—';
    $('dm-firmware').textContent = device.firmware || '—';
    $('dm-config-rev').textContent = device.config_revision ? `rev ${device.config_revision}` : 'none';
  }

  function showDeviceTab(name) {
    state.device.tab = name;
    document.querySelectorAll('[data-modal-tab]').forEach((tab) => tab.classList.toggle('is-active', tab.dataset.modalTab === name));
    document.querySelectorAll('[data-tab-panel]').forEach((panel) => panel.classList.toggle('hidden', panel.dataset.tabPanel !== name));
    if (name === 'telemetry') {
      // The canvas has just been (re)displayed: let Chart.js measure it again.
      requestAnimationFrame(() => state.device.chart && state.device.chart.resize());
    }
  }

  function renderSensorOptions() {
    const device = state.devices.get(state.device.id);
    const sensors = Object.keys((device && device.metrics) || {});
    const list = sensors.length ? sensors : ['temperature'];
    const select = $('dm-sensor');
    select.innerHTML = list.map((sensor) => `<option value="${esc(sensor)}">${esc(sensor)}</option>`).join('');
    $('sensor-options').innerHTML = list.map((sensor) => `<option value="${esc(sensor)}"></option>`).join('');

    const wanted = state.device.sensor && list.includes(state.device.sensor) ? state.device.sensor : (sensors.includes('temperature') ? 'temperature' : list[0]);
    state.device.sensor = wanted;
    select.value = wanted;
  }

  function initDeviceChart() {
    const canvas = $('device-chart');
    if (!canvas || typeof Chart === 'undefined') return;

    state.device.chart = new Chart(canvas.getContext('2d'), {
      type: 'line',
      data: {
        labels: [],
        datasets: [
          {
            label: 'value',
            data: [],
            borderColor: NEON,
            borderWidth: 2,
            pointRadius: 0,
            pointHoverRadius: 4,
            tension: 0.32,
            spanGaps: true,
            fill: true,
            backgroundColor: (context) => {
              const { ctx, chartArea } = context.chart;
              if (!chartArea) return 'rgba(57,255,20,0.12)';
              const gradient = ctx.createLinearGradient(0, chartArea.top, 0, chartArea.bottom);
              gradient.addColorStop(0, 'rgba(57,255,20,0.34)');
              gradient.addColorStop(0.5, 'rgba(57,255,20,0.12)');
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
        interaction: { mode: 'index', intersect: false },
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
            borderColor: NEON,
            borderWidth: 1,
            titleColor: NEON,
            bodyColor: '#d9ffcf',
            displayColors: false,
            titleFont: { family: 'monospace', size: 11 },
            bodyFont: { family: 'monospace', size: 12 },
          },
        },
      },
    });
  }

  function destroyDeviceChart() {
    if (state.device.chart) {
      try {
        state.device.chart.destroy();
      } catch {
        /* already gone */
      }
      state.device.chart = null;
    }
  }

  function setDeviceSeries(points) {
    const chart = state.device.chart;
    if (!chart) return;
    state.device.points = points.slice(-MAX_CHART_POINTS);
    chart.data.labels = state.device.points.map((point) => clockTime(point.ts));
    chart.data.datasets[0].data = state.device.points.map((point) => point.value);
    chart.update('none');
    updateDeviceSummary();
  }

  function updateDeviceSummary() {
    const values = state.device.points.map((p) => Number(p.value)).filter((v) => Number.isFinite(v));
    const device = state.devices.get(state.device.id);
    const sensor = state.device.sensor;
    if (!values.length) {
      $('dm-current').textContent = '--';
      $('dm-min').textContent = '--';
      $('dm-max').textContent = '--';
      $('dm-avg').textContent = '--';
      $('dm-samples').textContent = '0';
      return;
    }
    const unit = (device && device.metrics && device.metrics[sensor] ? device.metrics[sensor].unit : '') || '';
    $('dm-current').textContent = `${sensor} ${fmtNumber(values[values.length - 1])}${unit ? ` ${unit}` : ''}`;
    $('dm-min').textContent = fmtNumber(Math.min(...values));
    $('dm-max').textContent = fmtNumber(Math.max(...values));
    $('dm-avg').textContent = fmtNumber(values.reduce((a, b) => a + b, 0) / values.length);
    $('dm-samples').textContent = String(values.length);
  }

  function loadDeviceSeries() {
    if (!state.device.id || !state.device.sensor || !state.socket) return;
    state.socket.emit(
      'request:history',
      {
        device_id: state.device.id,
        sensor_name: state.device.sensor,
        limit: MAX_CHART_POINTS,
        since_ms: Number($('dm-range').value) || 900000,
      },
      (response) => {
        if (!response || !response.ok) return;
        if (response.device_id !== state.device.id || response.sensor_name !== state.device.sensor) return;
        setDeviceSeries(response.points || []);
        $('dm-range-label').textContent = `${$('dm-range').selectedOptions[0].textContent} · ${response.points.length} samples`;
      },
    );
  }

  /** Full device document (config, recent commands, forward history). */
  async function loadDeviceDetail() {
    const deviceId = state.device.id;
    if (!deviceId) return;
    try {
      const response = await api(`/api/devices/${encodeURIComponent(deviceId)}`);
      if (state.device.id !== deviceId) return;
      const detail = response.data;

      upsertDevice({ ...detail, metrics: detail.metrics });
      const config = detail.config || { config: {}, saved: {}, revision: 0 };
      state.device.config = config;
      renderConfigEditor(config);
      renderDeviceCommands(detail.commands || []);
      renderDeviceForward(detail.forward_logs || []);
      renderDeviceHead();
    } catch (error) {
      $('dm-config-result').innerHTML = `<span class="text-[#ffb3ad]">could not load device detail: ${esc(error.message)}</span>`;
    }
  }

  function renderDeviceForward(logs) {
    const el = $('dm-forward');
    if (!logs.length) {
      el.innerHTML = state.settings?.effective?.configured
        ? '<span class="text-[#ffcc66]">no forwarding attempts yet for this device</span>'
        : '<span class="text-[#ffcc66]">not configured — set MAIN_WEBSITE_WEBHOOK_URL in Settings</span>';
      return;
    }
    const last = logs[0];
    const ok = last.status === 'success';
    const failures = logs.filter((log) => log.status !== 'success').length;
    el.innerHTML =
      `<span class="${ok ? 'text-neon' : 'text-[#ffb3ad]'}">${ok ? '✓' : '✗'} ${esc(last.status)}${last.http_status ? ` (HTTP ${last.http_status})` : ''} ${esc(relTime(last.created_at))}</span>` +
      `<span class="text-[#47605a]"> · ${logs.length} recent attempt(s), ${failures} failed</span>`;
  }

  /* ---- device commands --------------------------------------------------- */

  function renderDeviceCommands(commands) {
    const body = $('dm-commands');
    if (!commands.length) {
      body.innerHTML = '<tr><td colspan="3" class="px-2 py-2 text-center text-[#47605a]">no commands sent yet</td></tr>';
      return;
    }
    body.innerHTML = commands
      .map(
        (command) => `<tr data-command="${command.id}">
          <td class="px-2 py-1 text-[#47605a]">${command.id}</td>
          <td class="max-w-[14rem] truncate px-2 py-1 text-[#9fd8b4]" title="${esc(command.payload)}">${esc(String(command.payload).slice(0, 60))}</td>
          <td class="px-2 py-1"><span class="badge px-1.5 py-0 text-sm ${STATUS_STYLES[command.status] || ''}">${esc(command.status)}</span></td>
        </tr>`,
      )
      .join('');
  }

  const STATUS_STYLES = {
    pending: 'text-[#eaff6b] border-[rgba(234,255,107,0.4)]',
    delivered: 'text-[#7dd3fc] border-[rgba(125,211,252,0.4)]',
    acked: 'text-neon border-[rgba(57,255,20,0.45)]',
    failed: 'text-[#ffb3ad] border-[rgba(255,59,48,0.5)]',
  };

  async function sendDeviceCommand(payload, label) {
    const deviceId = state.device.id;
    if (!deviceId) return;
    $('dm-result').innerHTML = '<span class="spinner inline-block align-middle"></span> sending…';
    try {
      const response = await api('/api/webhook/command', {
        method: 'POST',
        body: JSON.stringify({ device_id: deviceId, command: payload, source: 'inspector' }),
      });
      const command = response.data;
      $('dm-result').innerHTML = response.published
        ? `<span class="text-neon">✓ ${esc(label || 'command')} published to iot/${esc(deviceId)}/command (#${command.id})</span>`
        : `<span class="text-[#ffcc66]">⧗ #${command.id} queued — broker offline, the device will pick it up when it polls</span>`;
      pushDeviceLog({
        level: 'command',
        source: 'UI',
        message: `⇒ ${label || 'command'} sent (#${command.id}) :: ${command.payload}`,
        ts: Date.now(),
      });
      if (state.commands.length) state.commands = [command, ...state.commands].slice(0, 50);
      refreshDeviceCommands();
    } catch (error) {
      $('dm-result').innerHTML = `<span class="text-[#ffb3ad]">✗ ${esc(error.message)}</span>`;
      toast(`Command failed: ${error.message}`, 'error');
    }
  }

  async function refreshDeviceCommands() {
    if (!state.device.id) return;
    try {
      const response = await api(`/api/commands?device_id=${encodeURIComponent(state.device.id)}&limit=20`);
      if (state.device.id) renderDeviceCommands(response.data || []);
    } catch {
      /* non-fatal */
    }
  }

  /* ---- custom configuration editor -------------------------------------- */

  /**
   * Paint the config editor from a server document.
   *
   * Background refreshes (forward_log events re-fetch the device detail) must
   * never clobber unsaved edits, so an incoming revision is only applied when
   * the editor is clean — unless the caller forces it (e.g. right after a save).
   */
  function renderConfigEditor(configDoc, options = {}) {
    const deviceId = state.device.id;
    if (!deviceId) return;
    if (state.device.configDirty && !options.force) {
      $('dm-config-status').innerHTML =
        '<span class="text-[#ffcc66]">draft in progress — newer revision not loaded</span>';
      return;
    }
    const merged = configDoc && configDoc.config ? configDoc.config : {};
    state.device.configDraft = { ...merged };
    state.device.configDirty = false;
    $('dm-config-json').value = JSON.stringify(merged, null, 2);
    $('dm-config-error').textContent = '';
    renderConfigForm(merged);
    $('dm-config-status').innerHTML =
      configDoc && configDoc.updated_at ? '' : '';
    $('dm-config-status').textContent = configDoc && configDoc.has_custom
      ? `saved · revision ${configDoc.revision} · ${relTime(configDoc.updated_at)}`
      : 'defaults only — not saved yet';
    $('dm-config-status').className = `badge ml-auto ${configDoc && configDoc.has_custom ? 'border-[rgba(57,255,20,0.45)] text-neon' : 'text-[#8fb39b]'}`;
    // `dm-config-result` deliberately survives repaints: background refreshes
    // fire within milliseconds of a save and must not wipe the confirmation.
    $('dm-config-rev').textContent = configDoc && configDoc.revision ? `rev ${configDoc.revision}` : 'none';
    if (deviceId) {
      const device = state.devices.get(deviceId);
      if (device && configDoc) {
        device.config = configDoc.saved || {};
        device.config_revision = configDoc.revision || 0;
        device.config_updated_at = configDoc.updated_at || null;
        updateCard(deviceId, { flash: false });
      }
    }
  }

  function configInputType(value) {
    if (typeof value === 'number') return 'number';
    if (typeof value === 'boolean') return 'checkbox';
    return 'text';
  }

  function renderConfigForm(config) {
    const container = $('dm-config-form');
    const entries = Object.entries(config || {});
    container.innerHTML = entries
      .map(([key, value]) => {
        const type = configInputType(value);
        if (type === 'checkbox') {
          return `<div class="cfg-row" data-key="${esc(key)}">
            <input class="cfg-key" value="${esc(key)}" spellcheck="false" />
            <label class="flex items-center gap-2 text-base text-[#9fd8b4]">
              <input type="checkbox" class="cfg-val accent-[#39FF14]" data-type="boolean" ${value ? 'checked' : ''} />
              <span>${value ? 'true' : 'false'}</span>
            </label>
            <button class="cfg-del" data-cfg-del type="button" title="Remove">✕</button>
          </div>`;
        }
        return `<div class="cfg-row" data-key="${esc(key)}">
          <input class="cfg-key" value="${esc(key)}" spellcheck="false" />
          <input class="cfg-val" type="${type === 'number' ? 'number' : 'text'}" step="any"
                 data-type="${type}" value="${esc(type === 'number' ? value : String(value))}" spellcheck="false" />
          <button class="cfg-del" data-cfg-del type="button" title="Remove">✕</button>
        </div>`;
      })
      .join('') || '<p class="text-sm text-[#47605a]">no fields — use + ADD FIELD or edit the raw JSON.</p>';
  }

  /** Form rows are the source of truth when they change. */
  function configFromForm() {
    const out = {};
    for (const row of $('dm-config-form').querySelectorAll('.cfg-row')) {
      const key = row.querySelector('.cfg-key').value.trim();
      if (!key) continue;
      const field = row.querySelector('.cfg-val');
      const type = field.dataset.type;
      let value;
      if (type === 'boolean') value = field.checked;
      else if (type === 'number') value = Number(field.value);
      else if (field.value === 'true' || field.value === 'false') value = field.value === 'true';
      else value = field.value;
      out[key] = value;
    }
    return out;
  }

  function syncJsonFromForm() {
    const config = configFromForm();
    state.device.configDraft = config;
    $('dm-config-json').value = JSON.stringify(config, null, 2);
    $('dm-config-error').innerHTML = '<span class="text-neon">✓ form → JSON</span>';
  }

  function syncFormFromJson() {
    const text = $('dm-config-json').value.trim();
    if (!text) return;
    try {
      const parsed = JSON.parse(text);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('config must be a JSON object');
      state.device.configDraft = parsed;
      renderConfigForm(parsed);
      $('dm-config-error').innerHTML = '<span class="text-neon">✓ valid JSON</span>';
    } catch (error) {
      $('dm-config-error').innerHTML = `<span class="text-[#ffb3ad]">✗ ${esc(error.message)}</span>`;
    }
  }

  async function saveDeviceConfig() {
    const deviceId = state.device.id;
    if (!deviceId) return;

    let config;
    const text = $('dm-config-json').value.trim();
    try {
      config = JSON.parse(text);
      if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('config must be a JSON object');
    } catch (error) {
      $('dm-config-result').innerHTML = `<span class="text-[#ffb3ad]">✗ ${esc(error.message)}</span>`;
      return;
    }
    if (!Object.keys(config).length) {
      $('dm-config-result').innerHTML = '<span class="text-[#ffb3ad]">✗ config is empty</span>';
      return;
    }

    const button = $('dm-config-save');
    button.disabled = true;
    $('dm-config-result').innerHTML = '<span class="spinner inline-block align-middle"></span> saving…';

    try {
      const response = await api(`/api/device/${encodeURIComponent(deviceId)}/config`, {
        method: 'POST',
        body: JSON.stringify({ config, sync: $('dm-config-notify').checked, updated_by: 'dashboard' }),
      });
      const saved = response.data;
      renderConfigEditor(saved, { force: true });
      $('dm-config-result').innerHTML =
        `<span class="text-neon">✓ saved revision ${saved.revision} to SQLite</span>` +
        (response.command
          ? `<span class="text-[#9fd8b4]"> · CONFIG_SYNC queued as command #${response.command.id}</span>`
          : '<span class="text-[#47605a]"> · device not notified</span>');
      pushDeviceLog({
        level: 'success',
        source: 'CFG',
        message: `config revision ${saved.revision} saved${response.command ? ` · CONFIG_SYNC #${response.command.id}` : ''}`,
        ts: Date.now(),
      });
      toast(`Config saved for ${deviceId} (rev ${saved.revision})`, 'success');
    } catch (error) {
      $('dm-config-result').innerHTML = `<span class="text-[#ffb3ad]">✗ ${esc(error.message)}</span>`;
      toast(`Config save failed: ${error.message}`, 'error');
    } finally {
      button.disabled = false;
    }
  }

  /* ---- per-device terminal --------------------------------------------- */

  function pushDeviceLog(entry) {
    const box = $('dm-terminal');
    if (!box) return;
    if (state.device.logPaused) {
      sayDeviceLog(`… ${entry.source || 'SYS'} line suppressed (paused)`);
      return;
    }

    const node = document.createElement('div');
    node.className = `term-line term-${entry.level || 'info'}`;
    node.innerHTML = `<span class="term-time">${esc(clockTime(entry.ts || Date.now()))}</span> <span class="term-source">[${esc(
      entry.source || 'SYS',
    )}]</span> <span>${esc(entry.message)}</span>`;

    const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 48;
    box.insertBefore(node, $('dm-cursor-line'));
    while (box.querySelectorAll('.term-line').length > MAX_DEVICE_LOG_LINES) box.querySelector('.term-line').remove();
    state.device.logLines.push(entry);
    $('dm-log-count').textContent = `${state.device.logLines.length} LINES`;
    if (nearBottom) box.scrollTop = box.scrollHeight;
  }

  function sayDeviceLog(message) {
    const box = $('dm-terminal');
    if (!box) return;
    const node = document.createElement('div');
    node.className = 'term-line term-info';
    node.innerHTML = `<span class="term-time">${esc(clockTime(Date.now()))}</span> <span>${esc(message)}</span>`;
    box.insertBefore(node, $('dm-cursor-line'));
  }

  function clearDeviceLog() {
    $('dm-terminal').querySelectorAll('.term-line').forEach((line) => line.remove());
    state.device.logLines = [];
    $('dm-log-count').textContent = '0 LINES';
  }

  /** Seed the device console with what the server already knows. */
  async function backfillDeviceLog(deviceId) {
    try {
      const [telemetry, commands] = await Promise.all([
        api('/api/telemetry/recent?limit=400'),
        api(`/api/commands?device_id=${encodeURIComponent(deviceId)}&limit=15`),
      ]);
      if (state.device.id !== deviceId) return;

      const rows = (telemetry.data || []).filter((row) => row.device_id === deviceId).slice(0, 60).reverse();
      for (const row of rows) {
        pushDeviceLog({
          level: 'info',
          source: 'HOOK',
          message: `⇐ ${row.device_id} · ${row.sensor_name}=${row.value}${row.unit ? ` ${row.unit}` : ''}`,
          ts: row.created_at,
        });
      }
      for (const command of (commands.data || []).slice().reverse()) {
        pushDeviceLog({
          level: 'command',
          source: 'CMD',
          message: `⇒ #${command.id} ${command.status} (${command.source}) :: ${String(command.payload).slice(0, 90)}`,
          ts: command.created_at,
        });
      }
      sayDeviceLog(`— live stream attached to ${deviceId} —`);
      $('dm-terminal').scrollTop = $('dm-terminal').scrollHeight;
    } catch {
      sayDeviceLog('— could not load history, streaming live only —');
    }
  }

  /* ---------------------------------------------------------------------- */
  /* SETTINGS MODAL                                                         */
  /* ---------------------------------------------------------------------- */

  function openSettings(tab = 'forwarding') {
    showSettingsTab(tab);
    refreshSettings();
    openModal('settings-modal');
  }

  function showSettingsTab(name) {
    document.querySelectorAll('[data-set-tab]').forEach((tab) => tab.classList.toggle('is-active', tab.dataset.setTab === name));
    document.querySelectorAll('[data-set-panel]').forEach((panel) => panel.classList.toggle('hidden', panel.dataset.setPanel !== name));
    if (name === 'syslog') {
      const box = $('terminal');
      box.scrollTop = box.scrollHeight;
    }
  }

  /* ---- upstream forwarding ---------------------------------------------- */

  function renderForwardStatus(runtime, stats) {
    if (!runtime) return;
    state.forwardStats = stats || state.forwardStats;

    const cards = [
      { label: 'Effective URL', value: runtime.url || 'not set', small: true },
      { label: 'Source', value: runtime.source || 'unset' },
      { label: 'Queue', value: `${runtime.queue} / ${runtime.max_queue}` },
      { label: 'Delivered', value: stats ? stats.success : runtime.delivered },
      { label: 'Failed', value: stats ? stats.failed : runtime.failed },
      { label: 'Dropped', value: runtime.dropped },
      { label: 'Avg latency', value: stats && stats.avg_duration_ms !== null ? `${stats.avg_duration_ms} ms` : '—' },
      { label: 'Last success', value: stats && stats.last_success_at ? relTime(stats.last_success_at) : '—' },
    ];

    $('fwd-stats').innerHTML = cards
      .map(
        (card) => `<div class="stat-card">
          <p class="label mb-0">${esc(card.label)}</p>
          <p class="${card.small ? 'truncate text-base' : 'text-lg'} font-bold ${
            card.label === 'Failed' && Number(card.value) > 0 ? 'text-[#ffb3ad]' : 'text-neon'
          }" title="${esc(String(card.value))}">${esc(String(card.value))}</p>
        </div>`,
      )
      .join('');
  }

  function renderForwardLogs(logs) {
    state.forwardLogs = logs || [];
    const body = $('fwd-logs');
    if (!state.forwardLogs.length) {
      body.innerHTML = '<tr><td colspan="6" class="px-2 py-2 text-center text-[#47605a]">no delivery attempts recorded yet</td></tr>';
      return;
    }
    body.innerHTML = state.forwardLogs
      .map(
        (log) => `<tr class="border-t border-edge">
          <td class="px-2 py-1 text-[#47605a]">${esc(clockTime(log.created_at))}</td>
          <td class="px-2 py-1 text-[#9fd8b4]"><button type="button" class="hover:text-neon" data-open-device="${esc(log.device_id || '')}">${esc(
            log.device_id || '—',
          )}</button></td>
          <td class="px-2 py-1"><span class="badge px-1.5 py-0 text-sm ${
            log.status === 'success' ? 'text-neon border-[rgba(57,255,20,0.45)]' : 'text-[#ffb3ad] border-[rgba(255,59,48,0.5)]'
          }">${esc(log.status)}</span></td>
          <td class="px-2 py-1 text-[#6d8b84]">${log.http_status ?? '—'}</td>
          <td class="px-2 py-1 text-[#6d8b84]">${log.duration_ms ?? '—'}</td>
          <td class="max-w-[16rem] truncate px-2 py-1 text-[#ffb3ad]" title="${esc(log.error || '')}">${esc(log.error || '')}</td>
        </tr>`,
      )
      .join('');
  }

  async function refreshSettings() {
    try {
      const [settings, logs] = await Promise.all([api('/api/settings'), api('/api/forward-logs?limit=25')]);
      state.settings = settings.data;

      const { effective, settings: stored, runtime } = settings.data;
      $('fwd-url').value = stored.MAIN_WEBSITE_WEBHOOK_URL || '';
      $('fwd-enabled').setAttribute('aria-checked', String(effective.enabled));

      const envNote = settings.data.env.url && !stored.MAIN_WEBSITE_WEBHOOK_URL
        ? ` (using .env value)`
        : '';
      $('fwd-result').innerHTML = effective.configured
        ? `<span class="${effective.active ? 'text-neon' : 'text-[#ffcc66]'}">${
            effective.active ? '✓ forwarding active' : '⚠ configured but disabled'
          }</span><span class="text-[#47605a]"> · source: ${esc(effective.source)}${esc(envNote)}</span>`
        : '<span class="text-[#ffcc66]">no upstream URL configured — telemetry stays local</span>';

      renderForwardStatus(runtime, settings.data.stats_24h);
      renderForwardLogs(logs.data || []);
    } catch (error) {
      $('fwd-result').innerHTML = `<span class="text-[#ffb3ad]">✗ could not load settings: ${esc(error.message)}</span>`;
    }
  }

  async function saveForwardSettings({ clear = false } = {}) {
    const url = $('fwd-url').value.trim();
    const enabled = $('fwd-enabled').getAttribute('aria-checked') === 'true';
    const button = $('fwd-save');

    button.disabled = true;
    try {
      if (clear) {
        await api('/api/settings/MAIN_WEBSITE_WEBHOOK_URL', { method: 'DELETE' });
        toast('Stored URL cleared — falling back to .env', 'warn');
      }
      await api('/api/settings', {
        method: 'PATCH',
        body: JSON.stringify({
          MAIN_WEBSITE_WEBHOOK_URL: url,
          MAIN_WEBSITE_FORWARD_ENABLED: enabled,
        }),
      });
      if (!clear) toast(enabled ? 'Forwarding enabled' : 'Forwarding disabled', enabled ? 'success' : 'warn');
      await refreshSettings();
    } catch (error) {
      $('fwd-result').innerHTML = `<span class="text-[#ffb3ad]">✗ ${esc(error.message)}</span>`;
      toast(`Could not save forwarding settings: ${error.message}`, 'error');
    } finally {
      button.disabled = false;
    }
  }

  async function testForwarding() {
    const button = $('fwd-test');
    button.disabled = true;
    $('fwd-result').innerHTML = '<span class="spinner inline-block align-middle"></span> sending test document…';
    try {
      const result = await api('/api/forward/test', { method: 'POST', body: JSON.stringify({}) });
      $('fwd-result').innerHTML = `<span class="text-neon">✓ test delivered to ${esc(result.url)} (HTTP ${result.http_status}, ${result.duration_ms}ms)</span>`;
      toast('Test document delivered upstream', 'success');
      await refreshSettings();
    } catch (error) {
      $('fwd-result').innerHTML = `<span class="text-[#ffb3ad]">✗ test failed: ${esc(error.message)}</span>`;
      toast(`Forwarding test failed: ${error.message}`, 'error');
    } finally {
      button.disabled = false;
    }
  }

  /* ---- automation rules -------------------------------------------------- */

  function renderRules(rules) {
    state.rules = rules || [];
    const enabled = state.rules.filter((rule) => rule.enabled).length;
    $('rules-count').textContent = `${enabled}/${state.rules.length} RULES`;

    const list = $('rules-list');
    if (!state.rules.length) {
      list.innerHTML = '<p class="text-base text-[#47605a]">No rules yet — add one below.</p>';
      return;
    }
    list.innerHTML = state.rules
      .map(
        (rule) => `<div class="rule-row ${rule.enabled ? '' : 'is-disabled'} p-2.5" data-rule="${rule.id}">
        <div class="flex items-start gap-2">
          <button class="switch mt-0.5" role="switch" aria-checked="${rule.enabled ? 'true' : 'false'}"
                  data-rule-toggle="${rule.id}" aria-label="Toggle rule ${esc(rule.name)}"></button>
          <div class="min-w-0 flex-1">
            <p class="truncate text-base text-[#d9ffcf]" title="${esc(rule.name)}">${esc(rule.name)}</p>
            <p class="mt-0.5 text-sm text-[#6d8b84]">
              IF <span class="text-neon">${esc(rule.sensor_name)}</span> ${esc(rule.operator)}
              <span class="text-neon">${esc(fmtNumber(rule.threshold))}</span>
              → <span class="text-[#eaff6b]">${esc(rule.action)}</span>
            </p>
            <p class="mt-0.5 text-sm text-[#47605a]">
              ${esc(rule.device_id === '*' ? 'all devices' : rule.device_id)} · cooldown ${rule.cooldown_seconds}s ·
              fired ${rule.trigger_count}× ${rule.last_triggered ? `· last ${esc(relTime(rule.last_triggered))}` : ''}
            </p>
          </div>
          <button class="btn btn-danger px-1.5 py-0.5 text-sm" data-rule-delete="${rule.id}" type="button">DEL</button>
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
      .slice(0, 12)
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

  /* ---- command queue ----------------------------------------------------- */

  function commandRow(command) {
    return `<tr data-command="${command.id}" class="border-t border-edge">
      <td class="px-2 py-1 text-[#47605a]">${command.id}</td>
      <td class="px-2 py-1 text-[#9fd8b4]"><button type="button" class="hover:text-neon" data-open-device="${esc(
        command.device_id,
      )}">${esc(command.device_id)}</button></td>
      <td class="max-w-[16rem] truncate px-2 py-1 text-[#6d8b84]" title="${esc(command.payload)}">${esc(String(command.payload).slice(0, 72))}</td>
      <td class="px-2 py-1 text-[#7dd3fc]">${esc(command.source)}</td>
      <td class="px-2 py-1"><span class="badge px-1.5 py-0 text-sm ${STATUS_STYLES[command.status] || ''}">${esc(
        command.status,
      )}</span></td>
    </tr>`;
  }

  function renderCommands(commands) {
    state.commands = commands || [];
    $('commands-count').textContent = `${state.commands.length}`;
    $('commands-list').innerHTML = state.commands.length
      ? state.commands.map(commandRow).join('')
      : '<tr><td colspan="5" class="px-2 py-2 text-center text-[#47605a]">no commands yet</td></tr>';
  }

  function onCommandEvent(command, { prepend = false } = {}) {
    if (!command) return;
    const existing = state.commands.find((c) => c.id === command.id);
    if (existing) Object.assign(existing, command);
    else if (prepend) state.commands = [command, ...state.commands].slice(0, 50);

    renderCommands(state.commands);
    if (state.device.id && state.device.id === command.device_id) refreshDeviceCommands();
  }

  /* ---- system log -------------------------------------------------------- */

  /**
   * Mirror a system-log line into the open device inspector.
   *
   * Telemetry ingest lines are skipped on purpose: the server throttles the
   * global stream to 25 lines/s, so a busy fleet would starve the inspector.
   * Those lines are written directly from `onTelemetry` instead — see below.
   *
   * Mirrored before the terminal's own focus/pause filters so that narrowing
   * the system log never silently stops the per-device console.
   */
  function mirrorToDeviceLog(entry) {
    const deviceId = state.device.id;
    if (!deviceId) return;
    const meta = entry.meta || {};
    if (meta.sensor_name) return; // telemetry — handled by onTelemetry
    if (meta.device_id === deviceId) {
      pushDeviceLog(entry);
      return;
    }
    const mentioned = String(entry.message || '').includes(deviceId);
    if (mentioned && ['HOOK', 'MQTT', 'UI', 'CMD'].includes(entry.source)) pushDeviceLog(entry);
  }

  function terminalLine(entry) {
    mirrorToDeviceLog(entry);

    if (state.termFocus && ['info', 'mqtt'].includes(entry.level)) return;

    if (state.termPaused) {
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
    while (box.querySelectorAll('.term-line').length > MAX_TERMINAL_LINES) box.querySelector('.term-line').remove();
    state.termLines += 1;
    $('term-count').textContent = `${state.termLines} LINES`;
    if (nearBottom) box.scrollTop = box.scrollHeight;
  }

  function clearTerminal() {
    $('terminal').querySelectorAll('.term-line').forEach((line) => line.remove());
    state.termLines = 0;
    $('term-count').textContent = '0 LINES';
  }

  /* ---------------------------------------------------------------------- */
  /* Socket wiring                                                          */
  /* ---------------------------------------------------------------------- */

  function onTelemetry(reading) {
    const device = state.devices.get(reading.device_id);
    if (device) {
      device.metrics = device.metrics || {};
      device.metrics[reading.sensor_name] = { value: reading.value, unit: reading.unit || null, ts: reading.created_at };
      device.last_seen = reading.created_at;
      device.status = 'online';
      upsertDevice(device);
      updateCard(reading.device_id);
    } else {
      scheduleGridRefresh();
    }

    // Live chart + readouts + console for the open inspector. The device log is
    // written here rather than from the throttled system log so the stream is
    // always complete for the selected device.
    const d = state.device;
    if (d.id === reading.device_id) {
      const value = reading.value === null || reading.value === undefined ? reading.raw_value : reading.value;
      pushDeviceLog({
        level: 'info',
        source: reading.source === 'mqtt' ? 'MQTT' : 'HOOK',
        message: `⇐ ${reading.device_id} · ${reading.sensor_name}=${value}${reading.unit ? ` ${reading.unit}` : ''}`,
        ts: reading.created_at || Date.now(),
      });
      renderDeviceHead();
      if (d.sensor && reading.sensor_name === d.sensor && d.live) {
        d.points.push({ ts: reading.created_at, value: reading.value });
        if (d.points.length > MAX_CHART_POINTS) d.points.shift();
        const chart = d.chart;
        if (chart) {
          chart.data.labels.push(clockTime(reading.created_at));
          chart.data.datasets[0].data.push(reading.value);
          if (chart.data.labels.length > MAX_CHART_POINTS) {
            chart.data.labels.splice(0, chart.data.labels.length - MAX_CHART_POINTS);
            chart.data.datasets[0].data.splice(0, chart.data.datasets[0].data.length - MAX_CHART_POINTS);
          }
          chart.update('none');
        }
        updateDeviceSummary();
      }
    }
  }

  function bindSocket() {
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
      state.settings = state.settings || {};
      renderForwardStatus(payload.forward, payload.forward_stats);
      renderForwardLogs(payload.forward_logs || []);
      for (const entry of payload.terminal || []) terminalLine(entry);
      toast(`Synced · ${payload.total_devices} devices`, 'success', 2400);
    });

    socket.on('telemetry_update', onTelemetry);

    const onDeviceEvent = (device) => {
      upsertDevice(device);
      updateCard(device.device_id, { flash: false });
      scheduleGridRefresh();
      if (state.device.id === device.device_id) renderDeviceHead();
    };
    socket.on('device_status', onDeviceEvent);
    socket.on('device_update', onDeviceEvent);

    socket.on('command_sent', (command) => onCommandEvent(command, { prepend: true }));
    socket.on('command_delivered', (command) => onCommandEvent(command));
    socket.on('command_acked', (command) => onCommandEvent(command));
    socket.on('stats', renderStats);
    socket.on('mqtt_status', renderMqtt);
    socket.on('terminal', terminalLine);
    socket.on('rules_changed', renderRules);

    socket.on('device_config', (config) => {
      const device = state.devices.get(config.device_id);
      if (device) {
        device.config = config.saved || {};
        device.config_revision = config.revision || 0;
        device.config_updated_at = config.updated_at || null;
        updateCard(config.device_id, { flash: false });
      }
      if (state.device.id === config.device_id) renderConfigEditor(config);
      // (renderConfigEditor itself refuses to clobber an unsaved draft)
    });

    socket.on('forward_log', (entry) => {
      state.forwardLogs = [entry, ...state.forwardLogs].slice(0, 50);
      renderForwardLogs(state.forwardLogs);
      if (state.device.id && entry.device_id === state.device.id) {
        pushDeviceLog({
          level: entry.status === 'success' ? 'success' : 'error',
          source: 'FWD',
          message: `⇑ upstream ${entry.status}${entry.http_status ? ` (HTTP ${entry.http_status})` : ''}${
            entry.error ? ` — ${entry.error}` : ''
          }`,
          ts: entry.created_at || Date.now(),
        });
        loadDeviceDetail();
      }
    });

    socket.on('rule_triggered', ({ rule, reading, command }) => {
      toast(`RULE #${rule.id} fired on ${reading.device_id}: ${rule.action}`, 'warn', 6000);
      renderRuleEvents([
        {
          id: Date.now(),
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
      renderRules(
        state.rules.map((r) =>
          String(r.id) === String(rule.id) ? { ...r, trigger_count: (r.trigger_count || 0) + 1, last_triggered: Date.now() } : r,
        ),
      );
      if (command) onCommandEvent(command, { prepend: true });
    });

    socket.on('settings_changed', () => refreshSettings());
  }

  /* ---------------------------------------------------------------------- */
  /* Event wiring                                                           */
  /* ---------------------------------------------------------------------- */

  function bindEvents() {
    // ---- device grid
    $('device-grid').addEventListener('click', (event) => {
      const card = event.target.closest('.device-card');
      if (!card) return;
      openDevice(card.dataset.device);
    });

    $('device-grid').addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      const card = event.target.closest('.device-card');
      if (!card) return;
      event.preventDefault();
      openDevice(card.dataset.device);
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

    // Open a device from a click inside either modal (forward log / queue rows).
    document.addEventListener('click', (event) => {
      const trigger = event.target.closest('[data-open-device]');
      if (!trigger) return;
      const deviceId = trigger.dataset.openDevice;
      if (!deviceId) return;
      closeModal('settings-modal');
      openDevice(deviceId);
    });

    // ---- device modal
    $('dm-close').addEventListener('click', closeDevice);
    document.querySelectorAll('[data-modal-close]').forEach((el) => el.addEventListener('click', closeDevice));
    document.querySelectorAll('[data-modal-tab]').forEach((tab) =>
      tab.addEventListener('click', () => showDeviceTab(tab.dataset.modalTab)),
    );

    $('dm-sensor').addEventListener('change', (event) => {
      state.device.sensor = event.target.value;
      loadDeviceSeries();
    });
    $('dm-range').addEventListener('change', loadDeviceSeries);
    $('dm-live').addEventListener('click', () => {
      state.device.live = !state.device.live;
      $('dm-live').classList.toggle('btn-active', state.device.live);
      $('dm-live').textContent = state.device.live ? '● LIVE' : '○ PAUSED';
    });

    for (const button of document.querySelectorAll('[data-dm-quick]')) {
      button.addEventListener('click', () => {
        const action = button.dataset.dmQuick;
        if (action === 'CONFIG_SYNC') {
          sendDeviceCommand(JSON.stringify({ action, reason: 'manual-sync', issued_at: Date.now() }), 'CONFIG_SYNC');
          return;
        }
        const payload =
          state.device.payloadMode === 'json' ? JSON.stringify({ action }) : action;
        sendDeviceCommand(payload, action);
      });
    }

    for (const button of document.querySelectorAll('[data-dm-mode]')) {
      button.addEventListener('click', () => {
        state.device.payloadMode = button.dataset.dmMode;
        for (const other of document.querySelectorAll('[data-dm-mode]')) other.classList.toggle('btn-active', other === button);
        $('dm-payload-hint').textContent =
          state.device.payloadMode === 'json'
            ? 'JSON payloads are validated before sending.'
            : 'Text mode sends the payload verbatim.';
      });
    }

    $('dm-payload').addEventListener('input', () => {
      if (state.device.payloadMode !== 'json') return;
      const value = $('dm-payload').value.trim();
      if (!value) return;
      try {
        JSON.parse(value);
        $('dm-payload-hint').innerHTML = '<span class="text-neon">✓ valid JSON</span>';
      } catch (error) {
        $('dm-payload-hint').innerHTML = `<span class="text-[#ffb3ad]">✗ ${esc(error.message)}</span>`;
      }
    });

    $('dm-send').addEventListener('click', () => {
      const raw = $('dm-payload').value.trim();
      if (!raw) return toast('Payload is required', 'warn');
      let payload = raw;
      if (state.device.payloadMode === 'json') {
        try {
          payload = JSON.stringify(JSON.parse(raw));
        } catch (error) {
          return toast(`Invalid JSON: ${error.message}`, 'error');
        }
      }
      return sendDeviceCommand(payload, 'custom');
    });

    // ---- config editor
    const markConfigDirty = () => {
      state.device.configDirty = true;
    };

    $('dm-config-json').addEventListener('input', () => {
      markConfigDirty();
      clearTimeout(window._cfgTimer);
      window._cfgTimer = setTimeout(syncFormFromJson, 220);
    });

    $('dm-config-form').addEventListener('input', () => {
      markConfigDirty();
      syncJsonFromForm();
    });
    $('dm-config-form').addEventListener('click', (event) => {
      if (!event.target.closest('[data-cfg-del]')) return;
      const row = event.target.closest('.cfg-row');
      if (row) {
        row.remove();
        markConfigDirty();
        syncJsonFromForm();
      }
    });

    $('dm-config-add').addEventListener('click', () => {
      markConfigDirty();
      const config = configFromForm();
      let index = 1;
      let key = 'new_key';
      while (Object.prototype.hasOwnProperty.call(config, key)) key = `new_key_${index++}`;
      config[key] = '';
      state.device.configDraft = config;
      $('dm-config-json').value = JSON.stringify(config, null, 2);
      renderConfigForm(config);
      const rows = $('dm-config-form').querySelectorAll('.cfg-row');
      if (rows.length) rows[rows.length - 1].querySelector('.cfg-key').select();
    });

    $('dm-config-save').addEventListener('click', saveDeviceConfig);

    // ---- device log controls
    $('dm-log-clear').addEventListener('click', clearDeviceLog);
    $('dm-log-pause').addEventListener('click', () => {
      state.device.logPaused = !state.device.logPaused;
      $('dm-log-pause').classList.toggle('btn-active', state.device.logPaused);
      $('dm-log-pause').textContent = state.device.logPaused ? 'RESUME' : 'PAUSE';
    });

    // ---- settings modal
    $('open-settings').addEventListener('click', () => openSettings('forwarding'));
    $('open-logs').addEventListener('click', () => openSettings('syslog'));
    $('set-close').addEventListener('click', () => closeModal('settings-modal'));
    document.querySelectorAll('[data-settings-close]').forEach((el) => el.addEventListener('click', () => closeModal('settings-modal')));
    document.querySelectorAll('[data-set-tab]').forEach((tab) =>
      tab.addEventListener('click', () => showSettingsTab(tab.dataset.setTab)),
    );

    $('fwd-save').addEventListener('click', () => saveForwardSettings());
    $('fwd-test').addEventListener('click', testForwarding);
    $('fwd-reset').addEventListener('click', () => saveForwardSettings({ clear: true }));
    $('fwd-enabled').addEventListener('click', () => {
      const next = $('fwd-enabled').getAttribute('aria-checked') !== 'true';
      $('fwd-enabled').setAttribute('aria-checked', String(next));
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
          const response = await api(`/api/rules/${id}/toggle`, { method: 'POST', body: JSON.stringify({ enabled: next }) });
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

    // ---- system log controls
    $('term-clear').addEventListener('click', clearTerminal);
    $('term-pause').addEventListener('click', () => {
      state.termPaused = !state.termPaused;
      $('term-pause').classList.toggle('btn-active', state.termPaused);
      $('term-pause').textContent = state.termPaused ? 'RESUME' : 'PAUSE';
      if (!state.termPaused) {
        $('term-count').textContent = `${state.termLines} LINES`;
        $('terminal').scrollTop = $('terminal').scrollHeight;
      }
    });
    $('term-filter-toggle').addEventListener('click', () => {
      state.termFocus = !state.termFocus;
      $('term-filter-toggle').classList.toggle('btn-active', state.termFocus);
      toast(state.termFocus ? 'Log focus: webhooks, commands, rules only' : 'Log focus: everything', 'info', 2200);
    });

    // ---- global keys
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        if (!$('device-modal').classList.contains('hidden')) closeDevice();
        else if (!$('settings-modal').classList.contains('hidden')) closeModal('settings-modal');
      }
      if ((event.ctrlKey || event.metaKey) && event.key === 'Enter' && state.device.id) {
        event.preventDefault();
        $('dm-send').click();
      }
    });

    window.addEventListener('resize', () => {
      if (state.device.chart) state.device.chart.resize();
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
    renderGrid();
    startClock();
    bindEvents();
    bindSocket();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

  // Small debug handle for the browser console / handover notes.
  window.iotDashboard = { state, api, openDevice, toast, refreshSettings };
})();
