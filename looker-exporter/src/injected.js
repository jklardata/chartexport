// injected.js — runs in PAGE context (not content script context)
// Uses batchedDataV2 REQUEST payloads + getSchema to resolve real column names.
// Flow: getSchema response → schemaMap (_eventName_ → "Event name")
//       batchedDataV2 request body → qtFieldMap (qt_gikomdup1d → _eventName_)
//       batchedDataV2 response → columnInfo[].name (qt_gikomdup1d) → lookup chain → "Event name"

(function () {
  'use strict';

  if (window.__lookerExporterInjected) return;
  window.__lookerExporterInjected = true;

  // ─── Schema store: sourceFieldName → displayName ──────────────────────
  // e.g. "_eventName_" → "Event name", "_screenPageViews_" → "Views"
  const schemaMap = {};

  // ─── Query field map: qt_hash → sourceFieldName ───────────────────────
  // Built from batchedDataV2 REQUEST body payloads
  // e.g. "qt_gikomdup1d" → "_eventName_"
  const qtFieldMap = {};

  // ─── Component maps: qt_hash → componentId / displayType ──────────────
  // Used to resolve chart title from DOM and detect scorecards
  const qtComponentMap = {};   // qt_hash → "cd-2zsomdup1d"
  const qtDisplayTypeMap = {}; // qt_hash → "simple-barchart" | "SCORECARD" | etc.

  // ─── Request store: componentId → { url, init } ───────────────────────
  // Stored so we can re-fire with a higher rowsPerPage to fetch all rows
  const requestBodyStore = {}; // componentId → { url, init }

  // ─── Parse getSchema response ──────────────────────────────────────────
  function parseSchema(json) {
    const schema = json.schema;
    if (!schema) return;
    const allFields = [...(schema.dimensions || []), ...(schema.metrics || [])];
    let count = 0;
    for (const field of allFields) {
      if (field.name && field.displayName) {
        schemaMap[field.name] = field.displayName;
        count++;
      }
    }
    console.log('[Exporter] Schema loaded:', count, 'fields');
  }

  // ─── Parse batchedDataV2 REQUEST body ─────────────────────────────────
  function parseDataRequest(text) {
    let json;
    try { json = JSON.parse(text); } catch (e) { return; }
    const requests = json.dataRequest;
    if (!Array.isArray(requests)) return;

    for (const req of requests) {
      const componentId = req.requestContext?.reportContext?.componentId;  // "cd-2zsomdup1d"
      const displayType = req.requestContext?.reportContext?.displayType;  // "simple-barchart"
      const queryFields = req.datasetSpec?.queryFields || [];
      for (const qf of queryFields) {
        const qtName = qf.name;                                   // "qt_gikomdup1d"
        const srcField = qf.dataTransformation?.sourceFieldName;  // "_eventName_"
        if (qtName && srcField) qtFieldMap[qtName] = srcField;
        if (qtName && componentId) qtComponentMap[qtName] = componentId;
        if (qtName && displayType) qtDisplayTypeMap[qtName] = displayType;
      }
    }
  }

  // ─── Resolve a qt_ column name to display name ────────────────────────
  function resolveHeader(qtName) {
    // qtName from columnInfo is like "qt_gikomdup1d" (no namespace prefix)
    const srcField = qtFieldMap[qtName];
    if (srcField) {
      return schemaMap[srcField] || srcField.replace(/^_|_$/g, '').replace(/_/g, ' ');
    }
    // Fallback: return raw (will show as qt_xxx if schema/request not captured)
    return qtName;
  }

  // ─── Resolve chart title from DOM via componentId ─────────────────────
  // componentId (e.g. "cd-2zsomdup1d") is the CSS class on the chart container element.
  // Falls back to fallback string if element not found or has no readable title.
  function resolveChartTitle(componentId, fallback) {
    if (!componentId) return fallback;
    try {
      const container = document.querySelector(`.${componentId}`);
      if (!container) return fallback;
      const selectors = [
        '[class*="title-text"]',
        '[class*="chart-title"]',
        '[class*="widget-title"]',
        '[class*="lego-title"]',
        '[class*="title"]',
        'h1', 'h2', 'h3',
      ];
      for (const sel of selectors) {
        const el = container.querySelector(sel);
        const text = el?.textContent?.trim();
        if (text && text.length > 0 && text.length < 120) return text;
      }
    } catch (e) {}
    return fallback;
  }

  // ─── Parse batchedDataV2 RESPONSE ─────────────────────────────────────
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

          // Resolve headers and chart metadata via qt_hash lookup chains
          const headers = columnInfo.map(info => resolveHeader(info.name));
          const firstQtName = columnInfo[0]?.name;
          const componentId = firstQtName ? qtComponentMap[firstQtName] : null;
          const displayType = firstQtName ? qtDisplayTypeMap[firstQtName] : null;

          // Detect comparison subset (previous-period data in scorecards/date comparisons)
          const isCompare = subset.isCompare === true || response.isCompare === true;

          const fallbackTitle = headers[0] || 'Chart';
          let title = resolveChartTitle(componentId, fallbackTitle);
          if (isCompare) title += ' (Comparison)';

          // Append _compare to requestId to avoid overwriting the primary subset in storage
          const baseRequestId = subset.requestId || `chart_${Date.now()}_${Math.random()}`;
          const requestId = isCompare ? `${baseRequestId}_compare` : baseRequestId;

          const rows = [];
          for (let i = 0; i < rowCount; i++) {
            rows.push(columnData.map(col => col[i] ?? ''));
          }

          console.log(`[Exporter] "${title}" | type: ${displayType || 'unknown'} | compare: ${isCompare} | cols: ${headers.join(', ')} | rows: ${rowCount}`);
          results.push({ requestId, title, columns: headers, rows, componentId: componentId || null });
        }
      }

      return results;
    } catch (e) {
      console.error('[Exporter] Parse error:', e);
      return null;
    }
  }

  // ─── Handle any response text ──────────────────────────────────────────
  function handleResponseText(text) {
    let json;
    try {
      json = JSON.parse(text.replace(/^\)\]\}'\n?/, ''));
    } catch (e) { return; }

    if (json.schema) {
      parseSchema(json);
      return;
    }

    if (json.dataResponse) {
      // Small delay ensures request body was parsed first (fetch intercept order)
      setTimeout(() => {
        const results = parseDataResponse(json);
        if (!results) return;
        for (const result of results) {
          window.dispatchEvent(new CustomEvent('__lookerExporterData', { detail: result }));
        }
      }, 50);
    }
  }

  // ─── Intercept fetch ───────────────────────────────────────────────────
  const originalFetch = window.fetch;
  window.fetch = async function (...args) {
    const url = typeof args[0] === 'string' ? args[0] : args[0]?.url || '';
    const init = args[1] || {};

    // Parse request body BEFORE awaiting response
    if (url.includes('batchedDataV2') || url.includes('dataResponse')) {
      const body = init.body;
      if (typeof body === 'string') {
        try {
          parseDataRequest(body);
          // Store full request per componentId so we can re-fire for all rows
          const reqJson = JSON.parse(body);
          for (const req of (reqJson?.dataRequest || [])) {
            const cid = req.requestContext?.reportContext?.componentId;
            if (cid) requestBodyStore[cid] = { url, init: { ...init } };
          }
        } catch (e) {}
      }
    }

    const response = await originalFetch.apply(this, args);

    if (url.includes('batchedDataV2') || url.includes('dataResponse') || url.includes('getSchema')) {
      response.clone().text().then(handleResponseText).catch(() => {});
    }

    return response;
  };

  // ─── Fetch all rows for a chart ───────────────────────────────────────
  // Re-fires the original batchedDataV2 request with a high rowsPerPage so the
  // response comes back through the normal interceptor pipeline with all data.
  window.addEventListener('__lookerFetchAllRows', (event) => {
    const componentId = event.detail?.componentId;
    const stored = requestBodyStore[componentId];
    if (!stored) {
      console.warn('[Exporter] No stored request for componentId:', componentId);
      return;
    }
    let reqJson;
    try { reqJson = JSON.parse(stored.init.body); } catch (e) { return; }

    for (const req of (reqJson?.dataRequest || [])) {
      if (req.requestContext?.reportContext?.componentId === componentId) {
        if (req.datasetSpec) {
          // Try both common field locations for row limit
          req.datasetSpec.rowsPerPage = 50000;
          if (req.datasetSpec.sortAndPaginationOptions) {
            req.datasetSpec.sortAndPaginationOptions.rowsPerPage = 50000;
          }
        }
      }
    }

    const newBody = JSON.stringify(reqJson);
    // Use window.fetch (our interceptor) so response is processed normally
    window.fetch(stored.url, { ...stored.init, body: newBody })
      .catch(e => console.warn('[Exporter] Fetch all rows failed:', e));
  });

  // ─── Intercept XHR ────────────────────────────────────────────────────
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
    open(method, url, ...rest) {
      this._url = url;
      super.open(method, url, ...rest);
    }
    send(body) {
      if ((this._url.includes('batchedDataV2') || this._url.includes('dataResponse'))
          && typeof body === 'string') {
        try { parseDataRequest(body); } catch (e) {}
      }
      super.send(body);
    }
  }
  window.XMLHttpRequest = InterceptedXHR;

  console.log('[Looker Studio Exporter] Intercept active — schema-based field resolution ✓');
})();
