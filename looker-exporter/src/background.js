// background.js — service worker

const chartDataStore = {}; // tabId -> { requestId -> { title, columns, rows, timestamp } }
const captureProgress = {}; // tabId -> { status, currentPage, totalPages, message }

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const tabId = sender.tab?.id || message.tabId;

  if (message.type === 'CHART_DATA') {
    if (!chartDataStore[tabId]) chartDataStore[tabId] = {};
    chartDataStore[tabId][message.requestId] = {
      title: message.title,
      columns: message.columns,
      rows: message.rows,
      componentId: message.componentId || null,
      timestamp: Date.now()
    };
  }

  if (message.type === 'CAPTURE_PROGRESS') {
    captureProgress[tabId] = {
      status: message.status,
      currentPage: message.currentPage,
      totalPages: message.totalPages,
      message: message.message,
    };
  }

  if (message.type === 'GET_CHARTS') {
    const data = chartDataStore[message.tabId] || {};
    sendResponse({ charts: Object.values(data) });
    return true;
  }

  if (message.type === 'GET_CAPTURE_PROGRESS') {
    sendResponse(captureProgress[message.tabId] || null);
    return true;
  }

  if (message.type === 'CLEAR_CHARTS') {
    delete chartDataStore[message.tabId];
    delete captureProgress[message.tabId];
    sendResponse({ ok: true });
    return true;
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  delete chartDataStore[tabId];
  delete captureProgress[tabId];
});
