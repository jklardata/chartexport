# Looker Studio Bulk Data Exporter — Claude Code Handoff

## What This Is

A Chrome extension (Manifest V3) that intercepts Looker Studio's internal API traffic and exports all chart data as CSV files. Built and debugged in Claude.ai chat. Moving to Claude Code for continued development.

**Current status:** Working MVP. All chart types (table, bar, pie, scorecard) export with real column headers. Tested on GA4-connected reports.

---

## File Structure

```
looker-exporter/
  manifest.json          — MV3 extension config
  popup.html             — Extension popup UI (dark theme, 320px wide)
  icons/
    icon16.png
    icon48.png
    icon128.png
  src/
    background.js        — Service worker. Stores chart data per tab.
    content.js           — Content script. Injects injected.js, relays events to background.
    injected.js          — Runs in PAGE context. Intercepts fetch/XHR, resolves field names.
    popup.js             — Popup logic. Renders chart list, handles CSV/ZIP export.
```

---

## Architecture — Critical to Understand

### Why the 3-file content script pattern

MV3 content scripts run in an isolated world — they cannot override `window.fetch` on the page. Solution:

1. `content.js` injects `<script src="injected.js">` into the DOM
2. `injected.js` runs in the **page's JS context** and can override `window.fetch` and `XMLHttpRequest`
3. `injected.js` dispatches `CustomEvent('__lookerExporterData')` with chart data
4. `content.js` listens for that event and relays it to `background.js` via `chrome.runtime.sendMessage`
5. `background.js` stores data in memory (`chartDataStore[tabId][requestId]`)
6. `popup.js` fetches stored data via `GET_CHARTS` message when the popup opens

### How field names are resolved (the key breakthrough)

Looker Studio's `batchedDataV2` response uses obfuscated column names like `qt_gikomdup1d`. We resolve these in a 3-step chain:

**Step 1 — `getSchema` response** (fires when report loads):
```
_eventName_       → "Event name"
_screenPageViews_ → "Views"
_sessions_        → "Sessions"
... (hundreds of GA4 fields)
```
Stored in `schemaMap` inside `injected.js`.

**Step 2 — `batchedDataV2` REQUEST body** (fires before the response):
```
qt_gikomdup1d → _eventName_
qt_81fyoeup1d → _screenPageViews_
```
Stored in `qtFieldMap` inside `injected.js`.

**Step 3 — `batchedDataV2` RESPONSE** column resolution:
```
columnInfo[].name = "qt_gikomdup1d"
→ qtFieldMap["qt_gikomdup1d"] = "_eventName_"
→ schemaMap["_eventName_"] = "Event name"
→ header = "Event name" ✓
```

This works for ALL chart types. No DOM scraping needed.

---

## Known Issues / Next Tasks

### High priority

- **Multi-page reports** — only the currently visible page's charts are captured. Need to either:
  - Add a "capture all pages" button that programmatically navigates pages
  - Or clearly document this limitation in the UI
  
- **Dedup logic in background.js** still has old fallback header check (`/^t\d+_qt_/`) — can be simplified now that injected.js always resolves headers before dispatching

### Medium priority

- **Chart title** — currently uses the first column header as the chart title (e.g. "Event name"). Should ideally use the chart's actual Looker Studio title. The `componentId` in the request (e.g. `cd-2zsomdup1d`) maps to a DOM element with that class — could be used to look up the chart's title from the page.

- **Scorecards** — likely single-column single-row. Need to verify they export correctly.

- **Date range scorecards / comparison mode** — `batchedDataV2` responses include `isCompare` flag. Currently not handled.

### Low priority

- **Export filename** — currently uses first column name. Should use report name + chart title.
- **Pagination** — `batchedDataV2` only returns the rows visible in the chart (default 10 for bar charts). A "fetch all rows" feature would need to re-fire the request with a higher `rowsCount`.
- **Chrome Web Store submission** — need privacy policy, screenshots, description copy.

---

## Key API Endpoints

All on `https://lookerstudio.google.com` (and `datastudio.google.com` for legacy):

| Endpoint | Purpose |
|---|---|
| `batchedDataV2` | Main chart data endpoint. One request per chart render. |
| `getSchema` | Returns full field catalog for a datasource. Fires on report load. |
| Firestore heartbeat | Background keepalive — ignore these, not chart data |

### batchedDataV2 request body structure (relevant fields)
```json
{
  "dataRequest": [{
    "requestContext": {
      "reportContext": {
        "componentId": "cd-2zsomdup1d",
        "displayType": "simple-barchart"
      }
    },
    "datasetSpec": {
      "queryFields": [
        {
          "name": "qt_gikomdup1d",
          "dataTransformation": { "sourceFieldName": "_eventName_" }
        }
      ],
      "dateRanges": [{ "startDate": 20260211, "endDate": 20260310 }]
    }
  }]
}
```

### batchedDataV2 response structure (relevant fields)
```json
{
  "dataResponse": [{
    "dataSubset": [{
      "requestId": "b51b70fe-1441823-20260311",
      "dataset": {
        "tableDataset": {
          "columnInfo": [{ "ns": "t0", "name": "qt_gikomdup1d" }],
          "totalCount": 3,
          "column": [{ "stringColumn": { "values": ["page_view","first_visit","session_start"] } }]
        }
      }
    }]
  }]
}
```

---

## Source Files (Full Content)

### manifest.json
```json
{
  "manifest_version": 3,
  "name": "Looker Studio Exporter",
  "version": "0.1.0",
  "description": "Export all charts from Looker Studio reports as CSV files",
  "permissions": ["activeTab", "scripting", "webRequest", "storage"],
  "host_permissions": [
    "https://lookerstudio.google.com/*",
    "https://datastudio.google.com/*"
  ],
  "background": { "service_worker": "src/background.js" },
  "content_scripts": [{
    "matches": ["https://lookerstudio.google.com/*", "https://datastudio.google.com/*"],
    "js": ["src/content.js"],
    "run_at": "document_start"
  }],
  "web_accessible_resources": [{
    "resources": ["src/injected.js"],
    "matches": ["https://lookerstudio.google.com/*", "https://datastudio.google.com/*"]
  }],
  "action": {
    "default_popup": "popup.html",
    "default_title": "Looker Studio Exporter"
  },
  "icons": { "16": "icons/icon16.png", "48": "icons/icon48.png", "128": "icons/icon128.png" }
}
```

### src/background.js
```javascript
// background.js — service worker

const chartDataStore = {}; // tabId -> { requestId -> { columns, rows } }

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const tabId = sender.tab?.id || message.tabId;

  if (message.type === 'CHART_DATA') {
    if (!chartDataStore[tabId]) chartDataStore[tabId] = {};

    const isFallback = message.columns.every(c => /^t\d+_qt_/.test(c));
    const existing = chartDataStore[tabId][message.requestId];
    const existingIsFallback = existing && existing.columns.every(c => /^t\d+_qt_/.test(c));

    if (!existing || !isFallback || existingIsFallback) {
      chartDataStore[tabId][message.requestId] = {
        title: message.title,
        columns: message.columns,
        rows: message.rows,
        timestamp: Date.now()
      };
    }
  }

  if (message.type === 'GET_CHARTS') {
    const data = chartDataStore[message.tabId] || {};
    sendResponse({ charts: Object.values(data) });
    return true;
  }

  if (message.type === 'CLEAR_CHARTS') {
    delete chartDataStore[message.tabId];
    sendResponse({ ok: true });
    return true;
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  delete chartDataStore[tabId];
});
```

### src/content.js
```javascript
// content.js — content script context
(function () {
  'use strict';

  const script = document.createElement('script');
  script.src = chrome.runtime.getURL('src/injected.js');
  script.onload = () => script.remove();
  (document.head || document.documentElement).appendChild(script);

  window.addEventListener('__lookerExporterData', (event) => {
    const data = event.detail;
    if (!data) return;
    chrome.runtime.sendMessage({ type: 'CHART_DATA', ...data }, () => {
      if (chrome.runtime.lastError) {}
    });
  });
})();
```

### src/injected.js
```javascript
// injected.js — runs in PAGE context (not content script context)
// Flow: getSchema response → schemaMap (_eventName_ → "Event name")
//       batchedDataV2 request body → qtFieldMap (qt_gikomdup1d → _eventName_)
//       batchedDataV2 response → columnInfo[].name → lookup chain → "Event name"

(function () {
  'use strict';

  if (window.__lookerExporterInjected) return;
  window.__lookerExporterInjected = true;

  const schemaMap = {};   // sourceFieldName → displayName
  const qtFieldMap = {};  // qt_hash → sourceFieldName

  function parseSchema(json) {
    const schema = json.schema;
    if (!schema) return;
    const allFields = [...(schema.dimensions || []), ...(schema.metrics || [])];
    for (const field of allFields) {
      if (field.name && field.displayName) schemaMap[field.name] = field.displayName;
    }
  }

  function parseDataRequest(text) {
    let json;
    try { json = JSON.parse(text); } catch (e) { return; }
    const requests = json.dataRequest;
    if (!Array.isArray(requests)) return;
    for (const req of requests) {
      for (const qf of (req.datasetSpec?.queryFields || [])) {
        if (qf.name && qf.dataTransformation?.sourceFieldName) {
          qtFieldMap[qf.name] = qf.dataTransformation.sourceFieldName;
        }
      }
    }
  }

  function resolveHeader(qtName) {
    const srcField = qtFieldMap[qtName];
    if (srcField) return schemaMap[srcField] || srcField.replace(/^_|_$/g, '').replace(/_/g, ' ');
    return qtName;
  }

  function parseDataResponse(json) {
    try {
      const responses = json.dataResponse;
      if (!Array.isArray(responses)) return null;
      const results = [];

      for (const response of responses) {
        for (const subset of (response.dataSubset || [])) {
          const table = subset?.dataset?.tableDataset;
          if (!table) continue;

          const columnInfo = table.columnInfo || [];
          const columns = table.column || [];
          const rowCount = table.totalCount || 0;
          if (columns.length === 0) continue;

          const columnData = columns.map(col => {
            if (col.stringColumn) return col.stringColumn.values || [];
            if (col.longColumn)   return col.longColumn.values?.map(String) || [];
            if (col.doubleColumn) return col.doubleColumn.values?.map(String) || [];
            if (col.dateColumn)   return col.dateColumn.values || [];
            return [];
          });

          const headers = columnInfo.map(info => resolveHeader(info.name));
          const title = headers[0] || 'Chart';
          const requestId = subset.requestId || `chart_${Date.now()}_${Math.random()}`;
          const rows = [];
          for (let i = 0; i < rowCount; i++) rows.push(columnData.map(col => col[i] ?? ''));

          results.push({ requestId, title, columns: headers, rows });
        }
      }
      return results;
    } catch (e) { return null; }
  }

  function handleResponseText(text) {
    let json;
    try { json = JSON.parse(text.replace(/^\)\]\}'\n?/, '')); } catch (e) { return; }

    if (json.schema) { parseSchema(json); return; }

    if (json.dataResponse) {
      setTimeout(() => {
        const results = parseDataResponse(json);
        if (!results) return;
        for (const result of results) {
          window.dispatchEvent(new CustomEvent('__lookerExporterData', { detail: result }));
        }
      }, 50);
    }
  }

  const originalFetch = window.fetch;
  window.fetch = async function (...args) {
    const url = typeof args[0] === 'string' ? args[0] : args[0]?.url || '';
    const init = args[1] || {};

    if (url.includes('batchedDataV2') || url.includes('dataResponse')) {
      if (typeof init.body === 'string') try { parseDataRequest(init.body); } catch (e) {}
    }

    const response = await originalFetch.apply(this, args);
    if (url.includes('batchedDataV2') || url.includes('dataResponse') || url.includes('getSchema')) {
      response.clone().text().then(handleResponseText).catch(() => {});
    }
    return response;
  };

  const OrigXHR = window.XMLHttpRequest;
  class InterceptedXHR extends OrigXHR {
    constructor() {
      super();
      this._url = '';
      this.addEventListener('load', () => {
        const url = this._url;
        if (url.includes('batchedDataV2') || url.includes('dataResponse') || url.includes('getSchema')) {
          handleResponseText(this.responseText);
        }
      });
    }
    open(method, url, ...rest) { this._url = url; super.open(method, url, ...rest); }
    send(body) {
      if ((this._url.includes('batchedDataV2') || this._url.includes('dataResponse')) && typeof body === 'string') {
        try { parseDataRequest(body); } catch (e) {}
      }
      super.send(body);
    }
  }
  window.XMLHttpRequest = InterceptedXHR;
})();
```

---

## Things That Were Tried and Didn't Work

- **DOM scraping for column headers** — `cd-XXXXXX` class elements have human-readable text for table charts but are empty for canvas-rendered charts (bar, pie). Abandoned in favor of request payload parsing.
- **`batchedDataV2` response column metadata** — the `qt_` hashes in the response are query-time obfuscations with no readable names. The names only exist in the REQUEST body.
- **`getSchema` alone** — gives you the full field dictionary but not which fields are in which chart. Need the request body for that mapping.
- **XHR intercept as primary** — Looker Studio uses `fetch`, not XHR. XHR intercept kept as fallback only.

---

## How to Load in Chrome (dev mode)

1. Go to `chrome://extensions`
2. Enable "Developer mode" (top right)
3. Click "Load unpacked"
4. Select the `looker-exporter/` folder
5. Open a Looker Studio report (must be owner/editor — view-only reports block auth)
6. Click extension icon → charts appear as data loads

## How to Package

```bash
zip -r looker-studio-exporter.zip looker-exporter/
```
