# Patreon Archiver v1.0.0 (First Official Release)

Welcome to the first official release of Patreon Archiver (v1.0.0).

Patreon Archiver is a fast, modern, and privacy-friendly Chrome extension that scans your pledged Patreon creators and archives their complete content (post text, images, videos, audio tracks, attachments, and cloud storage links) into clean, structured folders on your computer.

## Installation & Getting Started

You can install Patreon Archiver either directly from the Chrome Web Store or manually via the standalone release archive:

### Method 1: Chrome Web Store (Recommended & Easiest)

> [Get Patreon Archiver on Chrome Web Store](https://chromewebstore.google.com/detail/YOUR_CHROME_WEB_STORE_LINK_HERE) (Link placeholder)

1. Click the link above to open the extension page in the Chrome Web Store.
2. Click "Add to Chrome", then "Add extension".
3. Open any creator page on Patreon you have access to; the scan panel will appear automatically in the bottom-right corner.

### Method 2: Manual Installation (ZIP / Developer Mode)

> [Download patreon-archiver-v1.0.0.zip](https://github.com/r1kp/patreon-archiver-extension/releases/download/v1.0.0/patreon-archiver-v1.0.0.zip)

1. Download patreon-archiver-v1.0.0.zip and extract it to a folder of your choice.
2. Open your browser and navigate to `chrome://extensions`.
3. Toggle on "Developer mode" in the top-right corner.
4. Click "Load unpacked" (top-left) and select the extracted patreon-archiver folder.
5. Navigate to your creator's Patreon page to start archiving.

## Features & Highlights

* Full Profile & Feed Scanning: Scans creator feeds, tiers, posts, markdown content, published dates, audio files, image galleries, and downloadable attachments.
* Organized Post Folder Structure: Automatically generates a dedicated, sanitized subfolder per post containing all media, thumbnail art, post descriptions (.txt/.html), and comments.
* Automated Cloud Link Resolvers: Automatically detects, resolves, and downloads external cloud links from Google Drive, Dropbox, MEGA, OneDrive, MediaFire, PixelDrain, and WeTransfer.
* Advanced Video & Stream Archiving: Full support for embedded videos (YouTube, Vimeo, and Patreon Video) including complex multi-fragment HLS/DASH streams with live speeds and byte-accurate progress.
* High-Speed Concurrent Downloads: Parallel downloads with real byte-accurate progress bars, live ETA, dynamic phase badges (Scanning, Waiting, Downloading), and individual item cancellation.
* Modern Interactive Dashboard: Full-text instant search, media type filters, sorting, bulk actions, creator switcher, and an interactive onboarding tour.
* Diagnostic Engine & Privacy: Local ring-buffer event logging with a one-click "Export Diagnostics" button. Zero tracking, zero telemetry, and 100% free and open-source.

## Companion App (Optional)

For downloading external video streams (YouTube/Vimeo) and unrestricted direct disk saving, download the companion desktop tool:
[Patreon Archiver Bridge](https://github.com/r1kp/patreon-archiver-bridge) (Native Windows Companion)

## Compatibility & Requirements

* Browser: Google Chrome, Brave, Microsoft Edge, Opera, or any Chromium-based browser supporting Manifest V3.
* Operating System: Windows, macOS, Linux.
