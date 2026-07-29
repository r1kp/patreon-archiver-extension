<div align="center">

<img src="icons/icon128.png" alt="Patreon Archiver Logo" width="128" height="128" />

# Patreon Archiver

[![License: PolyForm Noncommercial 1.0.0](https://img.shields.io/badge/license-PolyForm%20Noncommercial--1.0.0-ff5a3c.svg)](LICENSE)
[![Platform](https://img.shields.io/badge/platform-Chrome-4285F4.svg)](#installation)
[![Manifest](https://img.shields.io/badge/Manifest-V3-ff5a3c.svg)](#architecture)
[![Version](https://img.shields.io/badge/version-1.0.0-ff5a3c.svg)](https://github.com/r1kp/patreon-archiver-extension/releases/latest)

**A Chrome extension that scans your desired Patreon creator's posts and downloads them (text, images, videos, and attachments) into a clean, organized folder structure on your disk.**

[Download](#installation) · [Features](#features) · [How It Works](#how-it-works) · [Cloud Providers](#cloud-provider-support) · [Related Projects](#related-projects)

</div>

---

## Table of Contents

- [About](#about)
- [Features](#features)
- [Installation](#installation)
- [How It Works](#how-it-works)
- [Cloud Provider Support](#cloud-provider-support)
- [Architecture](#architecture)
- [Development](#development)
- [Known Limitations](#known-limitations)
- [Related Projects](#related-projects)
- [Roadmap & Feedback](#roadmap--feedback)
- [Built with AI & Open Philosophy (Transparency)](#built-with-ai--open-philosophy-transparency)
- [Contributing](#contributing)
- [License](#license)

---

## About

⚠️ **For content you already have legitimate access to only** (your own page, or a paid membership). The extension only downloads what your logged-in browser session can already see; it does not bypass paywalls of any kind.

Patreon gives creators and supporters no built-in way to back up what they've posted or paid for. **Patreon Archiver** fixes that: point it at a creator's posts page, scan, and it builds a complete, organized local archive, with one folder per post containing the thumbnail, video, description, comments, and every attachment or linked file neatly named and sorted.

---

## Features

- **Scan panel on patreon.com:** appears automatically on any creator's posts page. One click scans the full profile through Patreon's own internal data API, picking up titles, full text, publish dates, post type, embedded images/videos/audio, attachments, and external cloud links. Locked posts (no active membership) are clearly flagged instead of silently skipped.
- **Dashboard** (its own tab): overview of every scanned creator, post list with text preview, filtering by file type / download status, full-text search, sorting, header-level checkboxes for bulk selection, and per-file selection when a post is expanded.
- **Real, byte-accurate progress:** per file, per post (aggregated), and globally (corner overlay), including live speed and ETA. No guessed percentages.
- **Post-accurate folder structure:** every post gets its own subfolder containing its thumbnail, video (native file or a link file for external embeds), description, comments (best-effort), and a `Download Files/` folder for attachments and cloud links.
- **Automated cloud-link downloads:** files and folders behind external share links are detected and downloaded automatically (via the [Bridge](#related-projects), see below), each into a subfolder named after the link text the creator themselves used.
- **Settings:** language (English/German), storage location (Downloads subfolder or a freely chosen folder), file naming (date prefix/suffix/none, post ID on/off), and which extras (thumbnail/description/comments) get downloaded.
- **Interactive tour:** a guided walkthrough of the dashboard, replayable anytime from Help & About.

### A note on videos

- **Natively uploaded Patreon videos** download directly as real files, since Patreon's API provides an actual download URL for these.
- **Externally embedded videos** (YouTube, Vimeo, and similar): Patreon's API only ever provides a link for these, never a file. The link is always saved as a text file; optionally, the video itself can be downloaded via the Bridge using [yt-dlp](https://github.com/yt-dlp/yt-dlp).

---

## Installation

1. Download the latest **`patreon-archiver-vX.X.X.zip`** from the [Releases page](https://github.com/r1kp/patreon-archiver-extension/releases/latest) and unzip it.
2. Open `chrome://extensions` and enable **Developer mode** (top right).
3. Click **"Load unpacked"** and select the unzipped `patreon-archiver` folder.
4. Open a creator's posts page you have access to (e.g. `patreon.com/c/<name>/posts`); the scan panel appears in the bottom-right corner.

### Requirements

- Google Chrome (or any Chromium-based browser supporting Manifest V3)
- Optional: [Patreon Archiver Bridge](#related-projects), a small Windows companion app needed for external video downloads and free folder selection (see [How It Works](#how-it-works))

---

## How It Works

```
patreon.com  <── content script (scan) ──>  Extension  <── native messaging ──>  Bridge  <──>  File System
```

`content.js` runs on patreon.com and reads posts through Patreon's own internal JSON API; nothing is scraped from rendered HTML. Scanned data is stored locally (IndexedDB) and shown in the Dashboard, where downloads are triggered.

A Chrome extension cannot launch external programs (like `yt-dlp`) or write to arbitrary absolute file paths; that's a hard browser sandbox limit, not a limitation of this extension. For native Patreon files, downloads go through Chrome's own `chrome.downloads` API or the File System Access picker. For external videos, cloud-provider links, and truly free folder selection, the extension talks to the companion **[Patreon Archiver Bridge](#related-projects)** over Chrome's Native Messaging protocol.

---

## Cloud Provider Support

External file/folder links posted alongside a creator's content are detected automatically. Where supported, the file is downloaded directly (via the Bridge) into a subfolder named after the creator's own link text.

| Status | Providers |
|---|---|
| ✅ **Supported** | Google Drive (files & folders), Dropbox, MEGA, OneDrive, MediaFire, PixelDrain, WeTransfer |
| 🔍 **Detected, not yet automated** | iCloud, Sync.com, Box, pCloud, Proton Drive, Yandex Disk, TeraBox, Gofile, SwissTransfer, Smash, Filemail, KrakenFiles, 4shared, Sendspace |

Providers in the second group are recognized and clearly flagged as unsupported instead of silently producing a broken download. Support can be added on request (see [Roadmap & Feedback](#roadmap--feedback)).

---

## Architecture

| Component | Responsibility |
|---|---|
| `content.js` | Runs on patreon.com, scans posts via Patreon's internal API |
| `background.js` | Service worker: IndexedDB persistence, dashboard tab lifecycle, update checks |
| `dashboard/` | Main UI (own tab): filtering, search, sorting, settings, download orchestration |
| `lib/downloader.js` | Bulk download engine, per-post folder naming, write-path selection |
| `lib/nativeHost.js` | All Native Messaging calls to the Bridge (yt-dlp, folder picker, chunked writes) |
| `lib/cloudDownloader.js` | Detection/resolution of third-party cloud links embedded in posts |
| `lib/db.js` | Minimal IndexedDB wrapper (creators, posts, settings) |
| `popup/`, `setup/` | Toolbar popup and first-run setup page |

---

## Development

No build step; plain JS, loaded unpacked directly.

```powershell
git clone https://github.com/r1kp/patreon-archiver-extension.git
```

Then load the folder via `chrome://extensions` → **Load unpacked**, as described in [Installation](#installation). After editing a file, reload the extension (service worker) and refresh the affected tab (patreon.com for `content.js`, the dashboard tab for `dashboard.js`/`downloader.js`).

There is no automated test suite; verification is manual: run a scan and a download against a real patreon.com profile.

---

## Known Limitations

Patreon occasionally changes its internal API. If a scan errors out or returns 0 results:

1. Open DevTools (F12) → Console, and read the error logged by `[Patreon Archiver]`.
2. In `content.js`, the most likely spots to adjust are tagged `// ANPASSEN:` (mainly `extractMedia`, `fetchMembership`, and the total-count fallback).
3. Opening an [issue](https://github.com/r1kp/patreon-archiver-extension/issues) with the error message or the raw JSON response from the Network tab is the fastest way to get it fixed.

---

## Related Projects

| Project | Description | Status |
|---|---|---|
| **patreon-archiver-extension** *(this repo)* | The Chrome (Manifest V3) extension | ✅ Active |
| **[patreon-archiver-bridge](https://github.com/r1kp/patreon-archiver-bridge)** | Native Windows companion app for external videos, cloud downloads & free folder selection | ✅ Active |

---

## Roadmap & Feedback

- I'm fully open to feedback and feature requests!
- Want support for another cloud provider, file type, or option? Open a feature request in the issues tab.
- Feel free to suggest changes or ideas to improve the download or UI flow.

---

## 🤖 Built with AI & Open Philosophy (Transparency)

I believe in full transparency: this project was created entirely using AI models (vibe coding), with me acting as the project director rather than writing the code by hand.

While I don't identify as a traditional developer, I've guided the AI to shape the architecture, design, and user experience of this extension to be as premium and clean as possible. This project shows what's achievable today with modern AI assistance, and I'm glad to share it with the community as open source.

**My philosophy:** I use AI assistance to build high-quality applications and browser extensions that are, and will always remain, **completely free for everyone**. My goal is to push back against paywalls and locked premium features that plague modern tools, and to deliver top-tier utilities to the community at no cost.

---

## Contributing

Issues and pull requests are welcome. If you hit a bug, please open an issue with your Chrome version and, if possible, the console error from the affected tab (F12 → Console).

---

## License

This project is licensed under the **PolyForm Noncommercial License 1.0.0**.

You're free to view, copy, modify, and distribute this software for personal and educational purposes. **Commercial use, distribution, or sale of this software (or any modified version of it) is strictly prohibited.**

See the [LICENSE](LICENSE) file for details.
