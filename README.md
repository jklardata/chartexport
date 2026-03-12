# ChartExport

A Chrome extension that exports every chart from any Looker Studio report as CSV files.

Looker Studio doesn't have a bulk data export. ChartExport intercepts the report's API traffic and captures chart data as it loads — no scraping, no copy-paste, no manual work.

**[Install from Chrome Web Store](#)** · [Privacy Policy](https://jklardata.github.io/chartexport/privacy.html)

---

## Features

- Exports tables, bar charts, pie charts, and scorecards with real column headers
- Multi-page reports — "All Pages" button navigates every page and captures all data automatically
- Fetch all rows — bypasses chart display limits (e.g. bar charts that only show top 10)
- Exports as individual CSV or a ZIP of all selected charts
- Filenames include the report name: `MyReport_Top_Events.csv`
- 100% local — no data leaves your browser

## How to use

1. Open a Looker Studio report you have editor or owner access to
2. Click the ChartExport icon in your toolbar — charts appear in the list as data loads
3. Select the charts you want and click **Export CSV**

For multi-page reports, click **All Pages** to capture all pages automatically.

To get all rows for a chart (not just the display limit), click **↓ all** next to that chart.

## Install for development

1. Clone this repo
2. Go to `chrome://extensions`
3. Enable **Developer mode** (top right)
4. Click **Load unpacked** and select the `looker-exporter/` folder
5. Open any Looker Studio report

## How it works

Looker Studio fetches chart data via a `batchedDataV2` API endpoint. ChartExport intercepts these requests and responses using a three-layer content script pattern required by Chrome's Manifest V3:

- `content.js` — injects `injected.js` into the page context and relays data to the background
- `injected.js` — runs in the page's JS context, overrides `window.fetch` and `XMLHttpRequest`, resolves obfuscated column names to human-readable headers using the `getSchema` + request body lookup chain
- `background.js` — stores captured chart data per tab
- `popup.js` — renders the chart list and handles CSV/ZIP export

For a full technical breakdown, see [ARCHITECTURE.md](ARCHITECTURE.md).

## Package for distribution

```bash
zip -r chartexport.zip looker-exporter/
```

Then upload `chartexport.zip` to the [Chrome Web Store Developer Dashboard](https://chrome.google.com/webstore/devconsole).

## Known limitations

- Chart titles fall back to the first column header if the DOM element can't be found
- Only captures data from charts that load while the extension is active — charts already rendered before install require a page refresh
- Pagination re-fires the original request with `rowsPerPage: 50000`; very large datasets may time out
