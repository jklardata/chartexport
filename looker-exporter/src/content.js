// content.js — content script context
// Injects injected.js into the page context, then relays captured data to background

(function () {
  'use strict';

  // ─── Inject page-context script ──────────────────────────────────────
  // Content scripts can't override window.fetch directly in MV3.
  // We inject a <script> tag pointing to injected.js which runs in the page's context.
  const script = document.createElement('script');
  script.src = chrome.runtime.getURL('src/injected.js');
  script.onload = () => script.remove();
  (document.head || document.documentElement).appendChild(script);

  // ─── Relay data from page context to background ───────────────────────
  // injected.js dispatches CustomEvents; we listen and forward via chrome.runtime
  let lastDataActivity = 0;

  window.addEventListener('__lookerExporterData', (event) => {
    lastDataActivity = Date.now();
    const data = event.detail;
    if (!data) return;
    chrome.runtime.sendMessage({ type: 'CHART_DATA', ...data }, () => {
      if (chrome.runtime.lastError) {}
    });
  });

  // ─── Multi-page capture ──────────────────────────────────────────────

  function findPageTabs() {
    // Primary: anchor tags with /page/ in href (reliable for SPA routing)
    const seen = new Set();
    const anchors = [];
    for (const a of document.querySelectorAll('a[href*="/page/"]')) {
      if (a.offsetParent === null) continue;
      if (!seen.has(a.href)) { seen.add(a.href); anchors.push(a); }
    }
    if (anchors.length > 1) return anchors;

    // Fallback: role/class-based selectors
    const selectors = [
      '[role="tablist"] [role="tab"]',
      '[class*="page-tab"]',
      '[class*="pageTab"]',
      '[data-page-id]',
      '[aria-label^="Page"]',
    ];
    for (const sel of selectors) {
      const els = [...document.querySelectorAll(sel)].filter(el => el.offsetParent !== null);
      if (els.length > 1) return els;
    }
    return [];
  }

  // Resolves when data has been quiet for quietMs, or maxWaitMs elapses.
  // If no data arrives within 5s (page already captured), resolves early.
  function waitForSettle(quietMs = 2500, maxWaitMs = 15000) {
    return new Promise(resolve => {
      const start = Date.now();
      lastDataActivity = 0;

      const noDataTimer = setTimeout(resolve, 5000);

      const check = setInterval(() => {
        if (lastDataActivity > 0) {
          clearTimeout(noDataTimer);
          if (Date.now() - lastDataActivity >= quietMs || Date.now() - start >= maxWaitMs) {
            clearInterval(check);
            resolve();
          }
        }
      }, 300);

      setTimeout(() => { clearInterval(check); clearTimeout(noDataTimer); resolve(); }, maxWaitMs);
    });
  }

  async function captureAllPages() {
    const tabs = findPageTabs();

    if (tabs.length === 0) {
      chrome.runtime.sendMessage({
        type: 'CAPTURE_PROGRESS',
        status: 'error',
        message: 'No page navigation found. This report may only have one page.',
      });
      return;
    }

    for (let i = 0; i < tabs.length; i++) {
      chrome.runtime.sendMessage({
        type: 'CAPTURE_PROGRESS',
        status: 'capturing',
        currentPage: i + 1,
        totalPages: tabs.length,
      });
      tabs[i].click();
      await new Promise(r => setTimeout(r, 400));
      await waitForSettle(2500, 12000);
    }

    chrome.runtime.sendMessage({ type: 'CAPTURE_PROGRESS', status: 'done', totalPages: tabs.length });
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'PING') {
      sendResponse({ pong: true });
    }
    if (message.type === 'CAPTURE_ALL_PAGES') {
      captureAllPages();
      sendResponse({ started: true });
    }
    if (message.type === 'FETCH_ALL_ROWS') {
      window.dispatchEvent(new CustomEvent('__lookerFetchAllRows', { detail: { componentId: message.componentId } }));
      sendResponse({ ok: true });
    }
  });

  console.log('[Looker Studio Exporter] Content script loaded ✓');
})();
