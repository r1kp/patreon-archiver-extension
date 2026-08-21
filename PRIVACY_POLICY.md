# Privacy Policy for Patreon Archiver

Last updated: August 21, 2026

## Overview

Patreon Archiver ("the Extension") is an open-source browser extension designed to help users archive and download posts, media, and attachments from Patreon creators to whom they have access.

Your privacy is paramount. Patreon Archiver is built with a local-first architecture: all operations, data processing, and downloads happen entirely on your local machine.

## Data Collection and Transmission

1. **No Personal Data Collected:** The Extension does not collect, track, store, or sell any personal data, browsing history, or user credentials.
2. **No External Servers or Analytics:** The Extension does not send any telemetry, analytics, tracking metrics, or user activity to third-party servers.
3. **Local Storage Only:** Any preferences, search filters, and session logs are stored exclusively in your browser's local storage (`chrome.storage.local` and IndexedDB).
4. **Patreon Communication:** The Extension interacts solely with the official Patreon API (`https://*.patreon.com/*`) using your existing, authenticated browser session to fetch post data you already have permission to view.
5. **Native Companion Bridge:** If you choose to use the optional desktop companion application (Patreon Archiver Bridge), communication between the Extension and the application takes place strictly on your local machine via standard input/output streams (`chrome.runtime.connectNative`). No open network ports or external server connections are used.

## Permissions Usage

The Extension requests the following browser permissions solely to provide its core archiving functionality:

* **`storage` & `unlimitedStorage`:** To cache creator post metadata and settings locally in your browser.
* **`downloads`:** To save downloaded images, attachments, and audio files directly to your Downloads directory.
* **`scripting` & `activeTab`:** To render the interactive download and scan dashboard on Patreon pages.
* **`nativeMessaging`:** To communicate with the local companion tool (Patreon Archiver Bridge) for direct disk storage and external video processing.
* **`host_permissions`:** Restricted to official Patreon endpoints and supported cloud storage download sources (e.g., Google Drive, Dropbox, MEGA, OneDrive, MediaFire, PixelDrain, WeTransfer) strictly to fetch and download post attachments requested by the user.

## Third-Party Services

The Extension does not use any third-party tracking, advertising, or data brokering services.

## Contact

If you have questions about this Privacy Policy, you can open an issue on the official GitHub repository:
https://github.com/r1kp/patreon-archiver-extension
