# Privacy Policy — Looker Studio Exporter

*Last updated: March 2026*

## Summary

Looker Studio Exporter does not collect, transmit, or store any personal data. Everything stays in your browser.

---

## Data collection

This extension does **not** collect any data. It does not:
- Send data to any external server
- Track usage or analytics
- Store data beyond your current browser session
- Access any Google account information

## How it works

The extension intercepts network requests made by your browser to the Looker Studio API while you view a report. This data is held temporarily in memory (Chrome's extension service worker) for the duration of your browser session. When you export, the data is written directly to files on your computer. When you close the tab or click "Clear", the data is deleted from memory.

The extension only activates on `lookerstudio.google.com` and `datastudio.google.com`.

## Permissions used

- **activeTab** — to read the current tab's URL and title for export filenames
- **scripting** — to inject the data-capture script into Looker Studio pages
- **webRequest** — declared but not actively used for data collection
- **storage** — declared but not used in this version

## Third parties

No data is shared with any third party. The extension has no analytics, crash reporting, or remote configuration.

## Changes

If this policy changes materially, the version number in the extension will be updated.

## Contact

[your contact email or GitHub URL]
