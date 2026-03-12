// popup.js — handles UI interactions, fetches charts from background, exports ZIP

let charts = [];
let selectedIds = new Set();
let reportName = '';

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
// Minimal ZIP implementation using DeflateRaw via CompressionStream API

async function buildZip(files) {
  // files: [{ name, content (string) }]
  // Uses stored (no compression) for simplicity — works in all Chrome versions

  const encoder = new TextEncoder();
  const localHeaders = [];
  const centralDirectory = [];
  let offset = 0;

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

  const parts = [];

  for (const file of files) {
    const nameBytes = encoder.encode(file.name);
    const dataBytes = encoder.encode(file.content);
    const crc = crc32(dataBytes);
    const size = dataBytes.length;

    // Local file header
    const localHeader = new Uint8Array([
      0x50, 0x4B, 0x03, 0x04, // signature
      0x14, 0x00,              // version needed
      0x00, 0x00,              // flags
      0x00, 0x00,              // compression (stored)
      0x00, 0x00,              // mod time
      0x00, 0x00,              // mod date
      ...uint32LE(crc),
      ...uint32LE(size),
      ...uint32LE(size),
      ...uint16LE(nameBytes.length),
      0x00, 0x00,              // extra field length
      ...nameBytes
    ]);

    localHeaders.push({ nameBytes, crc, size, offset });
    parts.push(localHeader);
    parts.push(dataBytes);
    offset += localHeader.length + dataBytes.length;
  }

  // Central directory
  let cdOffset = offset;
  for (let i = 0; i < files.length; i++) {
    const { nameBytes, crc, size, offset: fileOffset } = localHeaders[i];
    const cdEntry = new Uint8Array([
      0x50, 0x4B, 0x01, 0x02, // signature
      0x14, 0x00,              // version made by
      0x14, 0x00,              // version needed
      0x00, 0x00,              // flags
      0x00, 0x00,              // compression
      0x00, 0x00,              // mod time
      0x00, 0x00,              // mod date
      ...uint32LE(crc),
      ...uint32LE(size),
      ...uint32LE(size),
      ...uint16LE(nameBytes.length),
      0x00, 0x00,              // extra length
      0x00, 0x00,              // comment length
      0x00, 0x00,              // disk start
      0x00, 0x00,              // internal attrs
      0x00, 0x00, 0x00, 0x00, // external attrs
      ...uint32LE(fileOffset),
      ...nameBytes
    ]);
    parts.push(cdEntry);
    offset += cdEntry.length;
  }

  const cdSize = offset - cdOffset;

  // End of central directory
  const eocd = new Uint8Array([
    0x50, 0x4B, 0x05, 0x06,
    0x00, 0x00,
    0x00, 0x00,
    ...uint16LE(files.length),
    ...uint16LE(files.length),
    ...uint32LE(cdSize),
    ...uint32LE(cdOffset),
    0x00, 0x00
  ]);
  parts.push(eocd);

  // Combine all parts
  const total = parts.reduce((acc, p) => acc + p.length, 0);
  const result = new Uint8Array(total);
  let pos = 0;
  for (const part of parts) {
    result.set(part, pos);
    pos += part.length;
  }
  return result;
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

  // Bind checkboxes
  list.querySelectorAll('input[type="checkbox"]').forEach((cb, i) => {
    cb.addEventListener('change', () => {
      if (cb.checked) selectedIds.add(i);
      else selectedIds.delete(i);
      exportBtn.disabled = selectedIds.size === 0;
    });
  });

  // Bind fetch-all links
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

  // Extract report name from tab title — strip " - Looker Studio" suffix
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

  const exportBtn = document.getElementById('exportBtn');
  exportBtn.textContent = 'Building...';
  exportBtn.disabled = true;

  try {
    if (toExport.length === 1) {
      // Single file — just download CSV directly
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
      // Multiple files — ZIP
      const files = toExport.map(chart => ({
        name: `${makeFilename(chart.title)}.csv`,
        content: toCSV(chart.columns, chart.rows)
      }));

      // Deduplicate filenames
      const seen = {};
      files.forEach(f => {
        if (seen[f.name]) {
          seen[f.name]++;
          f.name = f.name.replace('.csv', `_${seen[f.name]}.csv`);
        } else {
          seen[f.name] = 1;
        }
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
  // Re-sync checkboxes
  document.querySelectorAll('input[type="checkbox"]').forEach((cb, i) => {
    cb.checked = selectedIds.has(i);
  });
  document.getElementById('exportBtn').disabled = selectedIds.size === 0;
});

// ─── Capture All Pages ────────────────────────────────────────────────

let capturePolling = null;

// Pings the content script. If it doesn't respond (old version or not yet injected),
// re-injects content.js so the CAPTURE_ALL_PAGES handler is available.
function ensureContentScript(tabId, callback) {
  chrome.tabs.sendMessage(tabId, { type: 'PING' }, (response) => {
    if (!chrome.runtime.lastError && response?.pong) {
      callback(true);
      return;
    }
    // Content script is stale or missing — re-inject
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
    if (!ready) {
      showToast('Could not inject script — reload the Looker Studio report');
      btn.disabled = false;
      return;
    }
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
loadCharts();
