/* ==========================================================================
   IOT // DASHBOARD — client application
   Vanilla ES2020, no build step. Talks to the server over REST + Socket.io.
   ========================================================================== */

(() => {
  'use strict';

  const NEON = '#39FF14';
  const MAX_CHART_POINTS = 180;
  const PAGE_SIZE = 60;
  const MAX_TERMINAL_LINES = 400;

  const $ = (id) => document.getElementById(id);

  const state = {
    socket: null,
    connected: false,
    devices: new Map(), // device_id -> device
    cards: new Map(), // device_id -> card element
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

  function visibleDevices() {
    const term = state.search.trim().toLowerCase();
    let list = [...state.devices.values()];

    if (term) {
      list = list.filter((d) =>
        [d.device_id, d.name, d.ip, d.location]
          .filter(Boolean)
          .some((field) => String(field).toLowerCase().includes(term)),
      );
    }

    if (state.filter === 'online') list = list.filter((d) => d.status === 'online');
    if (state.filter === 'offline') list = list.filter((d) => d.status !== 'online');

    const sorters = {
      status: (a, b) =>
        (b.status === 'online') - (a.status === 'online') || (b.last_seen || 0) - (a.last_seen || 0),
      id: (a, b) => String(a.device_id).localeCompare(String(b.device_id), undefined, { numeric: true }),
      location: (a, b) => String(a.location || '').localeCompare(String(b.location || '')) || String(a.device_id).localeCompare(String(b.device_id)),
      seen: (a, b) => (b.last_seen || 0) - (a.last_seen || 0),
    };
    return list.sort(sorters[state.sort] || sorters.status);
  }

  function metricEntries(device) {
    return Object.entries(device.metrics || {})
      .sort((a, b) => a[0].localeCompare(b[0]))
      .slice(0, 3);
  }

  function cardInner(device) {
    const online = device.status === 'online';
    const metrics = metricEntries(device);

    const chips = metrics.length
      ? metrics
          .map(
            ([name, metric]) => `
        <span class="metric-chip text-[#6d8b84]">${esc(name.slice(0, 12))}
          <b class="text-neon" data-metric="${esc(name)}">${esc(fmtMetric(metric))}</b>
        </span>`,
          )
          .join('')
      : '<span class="metric-chip text-[#47605a]">no data yet</span>';

    return `
      <div class="flex items-center gap-2">
        <span class="dot ${online ? 'dot-online' : 'dot-offline'}" data-role="dot"></span>
        <span class="truncate text-[0.78rem] font-bold text-neon" title="${esc(device.device_id)}">${esc(device.device_id)}</span>
        <span class="ml-auto text-[0.6rem] text-[#47605a]" data-role="seen">${esc(relTime(device.last_seen))}</span>
      </div>
      <div class="mt-1 truncate text-[0.62rem] text-[#6d8b84]" title="${esc(device.name || '')}">
        ${esc(device.ip || 'no ip')} <span class="text-[#33504a]">·</span> ${esc(device.location || 'unassigned')}
      </div>
      <div class="mt-2 flex flex-wrap gap-1">${chips}</div>
      <div class="mt-1.5 flex items-center gap-1 text-[0.6rem] text-[#47605a]">
        <span data-role="fw">${esc(device.firmware || 'fw ?')}</span>
        <span class="ml-auto" data-role="status">${online ? 'ONLINE' : 'OFFLINE'}</span>
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
    const online = device.status === 'online';
    card.classList.toggle('is-online', online);
    card.classList.toggle('is-selected', state.selected === device.device_id);
    card.classList.toggle('is-stale', !online && device.last_seen);
    const status = card.querySelector('[data-role="status"]');
    if (status) status.textContent = online ? 'ONLINE' : 'OFFLINE';
  }

  /** Full re-render of the grid (filters, sort, search, first paint). */
  function renderGrid({ keepPage = false } = {}) {
    if (!keepPage) state.pageCount = 1;

    const list = visibleDevices();
    const limit = Math.min(state.pageCount * PAGE_SIZE, list.length);
    const grid = $('device-grid');
    grid.textContent = '';
    state.cards.clear();

    const fragment = document.createDocumentFragment();
    for (let i = 0; i < limit; i += 1) {
      const device = list[i];
      const card = createCard(device);
      state.cards.set(device.device_id, card);
      fragment.appendChild(card);
    }
    grid.appendChild(fragment);

    $('device-count').textContent = `${limit} SHOWN`;
    $('device-grid-note').textContent = list.length
      ? `showing ${limit} of ${list.length} matching device(s) · ${state.devices.size} registered`
      : 'no devices match the current filter';

    $('device-more').classList.toggle('hidden', limit >= list.length);

    // Keep the device dropdown in sync (top 300 is plenty for a picker).
    const options = list.slice(0, 300).map((d) => `<option value="${esc(d.device_id)}"></option>`).join('');
    $('device-options').innerHTML = options;
    syncChartDeviceSelect(list);
  }

  /** Cheap in-place update of a single card when telemetry arrives. */
  function updateCard(deviceId, changedMetric) {
    const card = state.cards.get(deviceId);
    const device = state.devices.get(deviceId);
    if (!device) return;

    if (!card) {
      // Not visible: refresh the grid at most once a second.
      scheduleGridRefresh();
      return;
    }

    applyCardState(card, device);
    const seen = card.querySelector('[data-role="seen"]');
    if (seen) {
      seen.textContent = relTime(device.last_seen);
      seen.title = device.last_seen ? new Date(device.last_seen).toLocaleString() : 'never';
    }

    const chips = card.querySelector('.flex-wrap');
    const metrics = metricEntries(device);
    if (chips && metrics.length) {
      const rendered = [...chips.querySelectorAll('[data-metric]')].map((n) => n.dataset.metric).join('|');
      const wanted = metrics.map(([name]) => name).join('|');
      if (rendered !== wanted) {
        chips.innerHTML = metrics
          .map(
            ([name, metric]) => `
          <span class="metric-chip text-[#6d8b84]">${esc(name.slice(0, 12))}
            <b class="text-neon" data-metric="${esc(name)}">${esc(fmtMetric(metric))}</b>
          </span>`,
          )
          .join('');
      } else {
        for (const [name, metric] of metrics) {
          const node = chips.querySelector(`[data-metric="${CSS.escape(name)}"]`);
          if (!node) continue;
          const next = fmtMetric(metric);
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
  }

  let gridRefreshTimer = null;
  function scheduleGridRefresh() {
    if (gridRefreshTimer) return;
    gridRefreshTimer = setTimeout(() => {
      gridRefreshTimer = null;
      renderGrid({ keepPage: true });
    }, 1000);
  }

  function refreshRelativeTimes() {
    for (const [deviceId, card] of state.cards) {
      const device = state.devices.get(deviceId);
      const seen = card.querySelector('[data-role="seen"]');
      if (device && seen) seen.textContent = relTime(device.last_seen);
    }
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
    socket.on('device_update', (device) => {
      upsertDevice(device);
      updateCard(device.device_id);
    });
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
    $('device-grid').addEventListener('click', (event) => {
      const card = event.target.closest('.device-card');
      if (!card) return;
      selectDevice(card.dataset.device);
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
    setInterval(refreshRelativeTimes, 5000);
  }

  function boot() {
    if (typeof io === 'undefined') {
      setConnected(false);
      toast('Socket.io client failed to load', 'error', 8000);
      return;
    }
    initChart();
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
