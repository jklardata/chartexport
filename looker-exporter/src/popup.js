// popup.js — handles UI interactions, fetches charts from background, exports ZIP

const API_BASE = 'https://looker-exporter-checkout.vercel.app'; // update after deploy
const FREE_LIMIT = 3;

let charts = [];
let selectedIds = new Set();
let reportName = '';
let isPro = false;

// ─── License & Usage ──────────────────────────────────────────────────

async function getLicense() {
  return new Promise(resolve => chrome.storage.local.get(['license'], r => resolve(r.license || null)));
}

async function getUsage() {
  return new Promise(resolve => chrome.storage.local.get(['usage'], r => resolve(r.usage || { count: 0, month: '' })));
}

async function setUsage(usage) {
  return new Promise(resolve => chrome.storage.local.set({ usage }, resolve));
}

function currentMonth() {
  return new Date().toISOString().slice(0, 7); // 'YYYY-MM'
}

async function checkPro() {
  const license = await getLicense();
  if (!license?.key) return false;

  // Re-validate at most once per 24h
  const now = Date.now();
  if (license.validatedAt && now - license.validatedAt < 24 * 60 * 60 * 1000) {
    return license.active === true;
  }

  try {
    const res = await fetch(`${API_BASE}/api/validate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: license.key })
    });
    const data = await res.json();
    await new Promise(resolve => chrome.storage.local.set({
      license: { ...license, active: data.valid, validatedAt: now }
    }, resolve));
    return data.valid === true;
  } catch {
    // Offline: trust cached active status
    return license.active === true;
  }
}

async function canExport() {
  if (isPro) return { allowed: true };

  let usage = await getUsage();
  const month = currentMonth();
  if (usage.month !== month) {
    usage = { count: 0, month };
    await setUsage(usage);
  }

  if (usage.count >= FREE_LIMIT) {
    return { allowed: false, count: usage.count };
  }
  return { allowed: true, count: usage.count };
}

async function recordExport() {
  if (isPro) return;
  let usage = await getUsage();
  const month = currentMonth();
  if (usage.month !== month) usage = { count: 0, month };
  usage.count += 1;
  await setUsage(usage);
  updateUsageBadge(usage.count);
}

// ─── Utilities ────────────────────────────────────────────────────────

function showToast(msg, duration = 2000) {
  const toast = document.getElementById('toast');
  toast.textContent = msg;
  toast.classList.add('show');
  setTimeout(() => toast.classList.remove('show'), duration);
}

function escapeHtml(str) {
  return String(str ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function sanitizeFilename(name) {
  return String(name ?? '').replace(/[^a-z0-9_\-\s]/gi, '_').trim().replace(/\s+/g, '_');
}

function makeFilename(chartTitle) {
  const r = sanitizeFilename(reportName).substring(0, 30);
  const c = sanitizeFilename(chartTitle).substring(0, 40);
  if (r && c) return `${r}_${c}`;
  return c || r || 'chart';
}

function makeZipName() {
  const r = sanitizeFilename(reportName).substring(0, 30);
  const d = new Date().toISOString().slice(0, 10);
  return r ? `${r}_export_${d}` : `looker_export_${d}`;
}

function toCSV(columns, rows) {
  const escape = val => {
    const s = String(val ?? '');
    if (s.includes(',') || s.includes('"') || s.includes('\n')) {
      return `"${s.replace(/"/g, '""')}"`;
    }
    return s;
  };
  const lines = [
    columns.map(escape).join(','),
    ...rows.map(row => row.map(escape).join(','))
  ];
  return lines.join('\n');
}

// ─── ZIP builder (no external deps) ──────────────────────────────────

async function buildZip(files) {
  const encoder = new TextEncoder();
  const localHeaders = [];
  let offset = 0;
  const parts = [];

  const uint32LE = n => new Uint8Array([n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff]);
  const uint16LE = n => new Uint8Array([n & 0xff, (n >> 8) & 0xff]);

  function crc32(data) {
    let crc = 0xFFFFFFFF;
    const table = crc32.table || (crc32.table = (() => {
      const t = new Uint32Array(256);
      for (let i = 0; i < 256; i++) {
        let c = i;
        for (let j = 0; j < 8; j++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
        t[i] = c;
      }
      return t;
    })());
    for (let i = 0; i < data.length; i++) crc = table[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
    return (crc ^ 0xFFFFFFFF) >>> 0;
  }

  for (const file of files) {
    const nameBytes = encoder.encode(file.name);
    const dataBytes = encoder.encode(file.content);
    const crc = crc32(dataBytes);
    const size = dataBytes.length;

    const localHeader = new Uint8Array([
      0x50, 0x4B, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
      ...uint32LE(crc), ...uint32LE(size), ...uint32LE(size),
      ...uint16LE(nameBytes.length), 0x00, 0x00, ...nameBytes
    ]);

    localHeaders.push({ nameBytes, crc, size, offset });
    parts.push(localHeader);
    parts.push(dataBytes);
    offset += localHeader.length + dataBytes.length;
  }

  let cdOffset = offset;
  for (let i = 0; i < files.length; i++) {
    const { nameBytes, crc, size, offset: fileOffset } = localHeaders[i];
    const cdEntry = new Uint8Array([
      0x50, 0x4B, 0x01, 0x02, 0x14, 0x00, 0x14, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
      ...uint32LE(crc), ...uint32LE(size), ...uint32LE(size),
      ...uint16LE(nameBytes.length), 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
      ...uint32LE(fileOffset), ...nameBytes
    ]);
    parts.push(cdEntry);
    offset += cdEntry.length;
  }

  const cdSize = offset - cdOffset;
  const eocd = new Uint8Array([
    0x50, 0x4B, 0x05, 0x06, 0x00, 0x00, 0x00, 0x00,
    ...uint16LE(files.length), ...uint16LE(files.length),
    ...uint32LE(cdSize), ...uint32LE(cdOffset), 0x00, 0x00
  ]);
  parts.push(eocd);

  const total = parts.reduce((acc, p) => acc + p.length, 0);
  const result = new Uint8Array(total);
  let pos = 0;
  for (const part of parts) { result.set(part, pos); pos += part.length; }
  return result;
}

// ─── Usage Badge ──────────────────────────────────────────────────────

function updateUsageBadge(count) {
  const badge = document.getElementById('usageBadge');
  if (!badge) return;
  if (isPro) {
    badge.textContent = 'Pro — unlimited exports';
    badge.className = 'usage-badge pro';
  } else {
    const remaining = Math.max(0, FREE_LIMIT - count);
    badge.textContent = `${remaining} free export${remaining !== 1 ? 's' : ''} left this month`;
    badge.className = `usage-badge ${remaining === 0 ? 'empty' : ''}`;
  }
}

// ─── Paywall ──────────────────────────────────────────────────────────

function showPaywall() {
  document.getElementById('paywallOverlay').style.display = 'flex';
}

function hidePaywall() {
  document.getElementById('paywallOverlay').style.display = 'none';
}

function showLicenseEntry() {
  document.getElementById('paywallOverlay').style.display = 'none';
  document.getElementById('licenseOverlay').style.display = 'flex';
}

function hideLicenseEntry() {
  document.getElementById('licenseOverlay').style.display = 'none';
}

async function activateLicense() {
  const input = document.getElementById('licenseInput');
  const key = input.value.trim();
  const btn = document.getElementById('activateBtn');
  const err = document.getElementById('licenseError');

  if (!key) return;

  btn.disabled = true;
  btn.textContent = 'Checking...';
  err.style.display = 'none';

  try {
    const res = await fetch(`${API_BASE}/api/validate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key })
    });
    const data = await res.json();

    if (data.valid) {
      await new Promise(resolve => chrome.storage.local.set({
        license: { key, active: true, plan: data.plan, email: data.email, validatedAt: Date.now() }
      }, resolve));
      isPro = true;
      hideLicenseEntry();
      updateUsageBadge(0);
      showToast('✓ Pro activated!');
    } else {
      err.textContent = 'Invalid or expired license key.';
      err.style.display = 'block';
    }
  } catch {
    err.textContent = 'Could not connect. Check your internet and try again.';
    err.style.display = 'block';
  }

  btn.disabled = false;
  btn.textContent = 'Activate';
}

// ─── UI ───────────────────────────────────────────────────────────────

function renderCharts() {
  const list = document.getElementById('chartList');
  const selectAllBar = document.getElementById('selectAllBar');
  const exportBtn = document.getElementById('exportBtn');
  const statusDot = document.getElementById('statusDot');
  const statusText = document.getElementById('statusText');
  const chartCount = document.getElementById('chartCount');

  if (charts.length === 0) {
    list.innerHTML = `
      <div class="empty-state">
        <div class="icon">🔍</div>
        <p>No chart data captured yet.</p>
        <p class="hint">Open a Looker Studio report you own,<br>then interact with the page to load data.</p>
      </div>`;
    selectAllBar.style.display = 'none';
    exportBtn.disabled = true;
    statusDot.classList.add('inactive');
    statusText.textContent = 'Waiting for report data...';
    return;
  }

  statusDot.classList.remove('inactive');
  statusText.textContent = `${charts.length} chart${charts.length !== 1 ? 's' : ''} captured`;
  selectAllBar.style.display = 'flex';
  chartCount.textContent = `${charts.length} chart${charts.length !== 1 ? 's' : ''}`;

  list.innerHTML = charts.map((chart, i) => `
    <div class="chart-item" data-index="${i}">
      <input type="checkbox" id="cb_${i}" ${selectedIds.has(i) ? 'checked' : ''}>
      <div class="chart-info">
        <div class="chart-name">${escapeHtml(chart.title || 'Untitled Chart')}</div>
        <div class="chart-meta">
          ${chart.rows.length} rows · ${chart.columns.length} cols
          ${chart.componentId ? `<span class="fetch-all-link" data-index="${i}">↓ all</span>` : ''}
        </div>
      </div>
    </div>
  `).join('');

  list.querySelectorAll('input[type="checkbox"]').forEach((cb, i) => {
    cb.addEventListener('change', () => {
      if (cb.checked) selectedIds.add(i);
      else selectedIds.delete(i);
      exportBtn.disabled = selectedIds.size === 0;
    });
  });

  list.querySelectorAll('.fetch-all-link').forEach(el => {
    el.addEventListener('click', async (e) => {
      e.stopPropagation();
      const chart = charts[parseInt(el.dataset.index)];
      if (!chart?.componentId) return;
      el.textContent = '⟳';
      el.style.pointerEvents = 'none';
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      ensureContentScript(tab.id, (ready) => {
        if (!ready) { el.textContent = '↓ all'; el.style.pointerEvents = ''; return; }
        chrome.tabs.sendMessage(tab.id, { type: 'FETCH_ALL_ROWS', componentId: chart.componentId }, () => {
          if (chrome.runtime.lastError) { el.textContent = '↓ all'; el.style.pointerEvents = ''; return; }
          setTimeout(loadCharts, 3500);
        });
      });
    });
  });

  exportBtn.disabled = selectedIds.size === 0;
}

async function loadCharts() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;

  reportName = (tab.title || '')
    .replace(/\s*[-–]\s*(Looker Studio|Google Data Studio|Data Studio)\s*$/i, '')
    .trim();

  chrome.runtime.sendMessage({ type: 'GET_CHARTS', tabId: tab.id }, (response) => {
    charts = response?.charts || [];
    selectedIds = new Set(charts.map((_, i) => i));
    renderCharts();
  });
}

// ─── Export ───────────────────────────────────────────────────────────

document.getElementById('exportBtn').addEventListener('click', async () => {
  const toExport = charts.filter((_, i) => selectedIds.has(i));
  if (toExport.length === 0) return;

  const check = await canExport();
  if (!check.allowed) {
    showPaywall();
    return;
  }

  const exportBtn = document.getElementById('exportBtn');
  exportBtn.textContent = 'Building...';
  exportBtn.disabled = true;

  try {
    if (toExport.length === 1) {
      const chart = toExport[0];
      const csv = toCSV(chart.columns, chart.rows);
      const blob = new Blob([csv], { type: 'text/csv' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${makeFilename(chart.title)}.csv`;
      a.click();
      URL.revokeObjectURL(url);
      showToast('✓ CSV downloaded');
    } else {
      const files = toExport.map(chart => ({
        name: `${makeFilename(chart.title)}.csv`,
        content: toCSV(chart.columns, chart.rows)
      }));
      const seen = {};
      files.forEach(f => {
        if (seen[f.name]) { seen[f.name]++; f.name = f.name.replace('.csv', `_${seen[f.name]}.csv`); }
        else seen[f.name] = 1;
      });
      const zipBytes = await buildZip(files);
      const blob = new Blob([zipBytes], { type: 'application/zip' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${makeZipName()}.zip`;
      a.click();
      URL.revokeObjectURL(url);
      showToast(`✓ ${files.length} CSVs exported as ZIP`);
    }

    await recordExport();
  } catch (e) {
    showToast('Export failed — check console');
    console.error(e);
  }

  exportBtn.textContent = 'Export CSV';
  exportBtn.disabled = selectedIds.size === 0;
});

// ─── Refresh / Clear ──────────────────────────────────────────────────

document.getElementById('refreshBtn').addEventListener('click', loadCharts);

document.getElementById('clearBtn').addEventListener('click', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  chrome.runtime.sendMessage({ type: 'CLEAR_CHARTS', tabId: tab.id }, () => {
    charts = [];
    selectedIds = new Set();
    renderCharts();
    showToast('Cleared');
  });
});

// ─── Select All ───────────────────────────────────────────────────────

document.getElementById('selectAllBtn').addEventListener('click', () => {
  const allSelected = selectedIds.size === charts.length;
  if (allSelected) {
    selectedIds.clear();
    document.getElementById('selectAllBtn').textContent = 'Select all';
  } else {
    selectedIds = new Set(charts.map((_, i) => i));
    document.getElementById('selectAllBtn').textContent = 'Deselect all';
  }
  renderCharts();
  document.querySelectorAll('input[type="checkbox"]').forEach((cb, i) => {
    cb.checked = selectedIds.has(i);
  });
  document.getElementById('exportBtn').disabled = selectedIds.size === 0;
});

// ─── Capture All Pages ────────────────────────────────────────────────

let capturePolling = null;

function ensureContentScript(tabId, callback) {
  chrome.tabs.sendMessage(tabId, { type: 'PING' }, (response) => {
    if (!chrome.runtime.lastError && response?.pong) { callback(true); return; }
    chrome.scripting.executeScript({ target: { tabId }, files: ['src/content.js'] }, () => {
      if (chrome.runtime.lastError) { callback(false); return; }
      setTimeout(() => callback(true), 150);
    });
  });
}

document.getElementById('captureAllBtn').addEventListener('click', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;
  const btn = document.getElementById('captureAllBtn');
  btn.disabled = true;
  ensureContentScript(tab.id, (ready) => {
    if (!ready) { showToast('Could not inject script — reload the Looker Studio report'); btn.disabled = false; return; }
    chrome.tabs.sendMessage(tab.id, { type: 'CAPTURE_ALL_PAGES' }, (response) => {
      if (chrome.runtime.lastError || !response?.started) {
        showToast('Could not start capture — reload the Looker Studio report');
        btn.disabled = false;
        return;
      }
      startCapturePolling(tab.id);
    });
  });
});

function startCapturePolling(tabId) {
  const captureBar = document.getElementById('captureBar');
  const captureBarFill = document.getElementById('captureBarFill');
  const statusText = document.getElementById('statusText');
  const statusDot = document.getElementById('statusDot');
  const btn = document.getElementById('captureAllBtn');

  captureBar.style.display = 'block';
  statusDot.classList.remove('inactive');
  if (capturePolling) clearInterval(capturePolling);

  capturePolling = setInterval(() => {
    chrome.runtime.sendMessage({ type: 'GET_CAPTURE_PROGRESS', tabId }, (progress) => {
      if (!progress) return;
      if (progress.status === 'capturing') {
        const pct = Math.round((progress.currentPage / progress.totalPages) * 100);
        captureBarFill.style.width = pct + '%';
        statusText.textContent = `Capturing page ${progress.currentPage} of ${progress.totalPages}...`;
      }
      if (progress.status === 'done') {
        clearInterval(capturePolling);
        capturePolling = null;
        captureBarFill.style.width = '100%';
        setTimeout(() => {
          captureBar.style.display = 'none';
          captureBarFill.style.width = '0%';
          btn.disabled = false;
          loadCharts();
          showToast(`✓ All ${progress.totalPages} pages captured`);
        }, 500);
      }
      if (progress.status === 'error') {
        clearInterval(capturePolling);
        capturePolling = null;
        captureBar.style.display = 'none';
        btn.disabled = false;
        showToast(progress.message || 'Could not find page navigation');
      }
    });
  }, 500);
}

// ─── Init ─────────────────────────────────────────────────────────────

async function init() {
  isPro = await checkPro();
  const usage = await getUsage();
  const month = currentMonth();
  const count = usage.month === month ? usage.count : 0;
  updateUsageBadge(count);
  loadCharts();
}

init();
