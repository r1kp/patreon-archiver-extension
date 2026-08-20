import {
  upsertCreator,
  upsertPosts,
  getAllCreators,
  getPostsForCreator,
  deleteCreator,
  getSettings,
} from "./lib/db.js";
import { installConsoleCapture, logEvent, logMilestone } from "./lib/appLog.js";

// Ab hier landen console.warn/console.error dieses Workers zusaetzlich im
// persistenten Log (IndexedDB-Ringpuffer + Bridge-Tagesdatei). Die Ausgabe in
// den DevTools bleibt unveraendert erhalten.
installConsoleCapture("background");

// Downloads (inkl. ZIP-Erstellung und Dateisystemzugriff) laufen direkt im
// Dashboard-Tab (siehe dashboard/dashboard.js + lib/downloader.js), nicht
// hier im Service Worker - u.a. weil FileSystemDirectoryHandles und die
// JSZip-Bibliothek an den Dashboard-Kontext gebunden sind. Dieser Worker
// kümmert sich nur noch um Speicherung (IndexedDB) und Tab-Verwaltung.

const DASHBOARD_URL = chrome.runtime.getURL("dashboard/dashboard.html");

// OneDrive-Freigabelinks: keine simple HTTP-URL liefert die echte Datei (siehe
// HANDOFF.md, Runde 11/12) - die moderne, aufs SharePoint-Backend migrierte
// OneDrive-Weboberflaeche ist eine JS-SPA, die den echten Downloadlink erst
// client-seitig per JS-Klick aufloest. UND (Runde 13, live verifiziert per
// curl): die dabei aufgeloeste URL ist cookie-gebunden - ein HttpClient ohne
// die Browser-Session (also die C#-Bridge) bekommt dafuer 403. Deshalb laesst
// diese Funktion den kompletten Download durch den ECHTEN Chrome-Browser
// laufen (der hat die gueltige Session) und uebergibt danach nur noch die
// bereits fertige LOKALE Datei an die Bridge zum Verschieben (siehe
// moveLocalFileViaBridge in nativeHost.js / HandleMoveLocalFile in
// CommandHandlers.cs) - kein erneuter Netzwerk-Download über die Bridge.
// `#downloadCommand`/`[data-automation-id="downloadCommand"]` ist ein
// stabiler, sprachunabhaengiger Selektor (deutsches UI zeigt "Herunterladen",
// englisches "Download" - der data-automation-id bleibt gleich).
const ONEDRIVE_DOWNLOAD_BUTTON_SELECTOR = '[data-automation-id="downloadCommand"]';
// Eigener Unterordner in Chromes Standard-Downloads-Verzeichnis fuer die
// temporaeren OneDrive-Dateien, bevor sie an ihren finalen Platz verschoben
// werden - haelt das den Nutzer-Downloads-Ordner sauber und macht Kollisionen
// mit echten Downloads des Nutzers unwahrscheinlich.
const ONEDRIVE_TEMP_SUBFOLDER = "PatreonArchiverTemp";

// Alle OneDrive-Downloads strikt nacheinander (nie parallel) - Grund:
// chrome.downloads-Events liefern keine zuverlaessige Moeglichkeit, einen
// Download eindeutig EINEM bestimmten Hintergrund-Fenster zuzuordnen. Bei
// paralleler Ausfuehrung koennte der Listener eines Fensters faelschlich den
// Download eines ANDEREN gleichzeitig laufenden OneDrive-Vorgangs abfangen.
// Ein globaler Warteschlangen-Mutex macht das unmoeglich, auf Kosten von
// Durchsatz (OneDrive war ohnehin nie fuer hohen Durchsatz ausgelegt - jeder
// Download braucht einen echten Seitenaufruf plus die volle Uebertragungszeit).
let onedriveDownloadChain = Promise.resolve();
function queueOneDriveDownload(shareUrl, onProgress) {
  const result = onedriveDownloadChain.then(() => downloadOneDriveFileViaHiddenWindow(shareUrl, onProgress));
  onedriveDownloadChain = result.catch(() => {});
  return result;
}

async function downloadOneDriveFileViaHiddenWindow(shareUrl, onProgress) {
  let windowId = null;
  let tabId = null;
  let filenameListener = null;
  let suggestedRealFilename = null;
  const tempRelPath = `${ONEDRIVE_TEMP_SUBFOLDER}/od_${Date.now()}_${Math.random().toString(36).slice(2)}.tmp`;

  const removeFilenameListener = () => {
    if (filenameListener) {
      chrome.downloads.onDeterminingFilename.removeListener(filenameListener);
      filenameListener = null;
    }
  };
  const cleanup = () => {
    removeFilenameListener();
    if (windowId != null) chrome.windows.remove(windowId).catch(() => {});
  };

  try {
    // Minimiertes, nicht fokussiertes eigenes Fenster statt eines Tabs im
    // Hauptfenster - taucht dadurch NICHT in der normalen Tab-Leiste des
    // Nutzers auf. Ein komplett unsichtbares Laden (echtes Headless-Chrome)
    // ist ueber die normale Extension-API nicht moeglich, dafuer braeuchte es
    // einen separaten Browser-Prozess (Playwright o.ae.) - bewusst nicht
    // gewaehlt (siehe HANDOFF.md, Diskussion Runde 12/13).
    const win = await chrome.windows.create({ url: shareUrl, type: "popup", state: "minimized", focused: false });
    windowId = win.id;
    tabId = win.tabs && win.tabs[0] ? win.tabs[0].id : null;
    if (tabId == null) throw new Error("Could not determine tab id of hidden OneDrive window");

    await new Promise((resolve) => {
      function onUpdated(id, info) {
        if (id === tabId && info.status === "complete") {
          chrome.tabs.onUpdated.removeListener(onUpdated);
          resolve();
        }
      }
      chrome.tabs.onUpdated.addListener(onUpdated);
      // Falls der Tab schon "complete" ist, BEVOR der Listener oben registriert wurde.
      chrome.tabs.get(tabId).then((t) => {
        if (t.status === "complete") {
          chrome.tabs.onUpdated.removeListener(onUpdated);
          resolve();
        }
      }).catch(() => {});
    });

    let capturedDownloadId = null;
    const downloadStartedPromise = new Promise((resolve) => {
      const createdListener = (item) => {
        chrome.downloads.onCreated.removeListener(createdListener);
        capturedDownloadId = item.id;
        resolve(item);
      };
      chrome.downloads.onCreated.addListener(createdListener);
    });

    // onDeterminingFilename liefert (bevor wir ihn ueberschreiben) Chromes
    // eigenen, aus dem Content-Disposition-Header abgeleiteten Dateinamen -
    // das ist der ECHTE Originalname der Datei, den merken wir uns fuer die
    // Rueckgabe. Umgeleitet wird trotzdem auf einen eigenen Temp-Pfad, damit
    // nichts im normalen Downloads-Ordner des Nutzers landet, UND damit gar
    // nicht erst ein natives "Speichern unter"-Dialogfenster erscheint, falls
    // der Nutzer "jedes Mal nach Speicherort fragen" aktiviert hat.
    // WICHTIG: Chrome kann diesen Listener fuer EIN UND DENSELBEN Download
    // mehrfach aufrufen (live beobachtet: Dialog erschien trotzdem, obwohl
    // suggest() beim ersten Aufruf lief - der Listener war zu dem Zeitpunkt
    // schon wieder entfernt). Deshalb bleibt er jetzt bis zum tatsaechlichen
    // Abschluss registriert (Entfernen erst in cleanup()), aber ueber
    // ourDownloadId auf GENAU den einen Download begrenzt, den er beim ersten
    // Aufruf gesehen hat - ein waehrenddessen gestarteter, voellig
    // unabhaengiger Download des Nutzers bleibt dadurch unberuehrt (kein
    // suggest()-Aufruf fuer ihn, Chrome verhaelt sich dafuer normal).
    let ourDownloadId = null;
    filenameListener = (item, suggest) => {
      if (ourDownloadId == null) ourDownloadId = item.id;
      if (item.id !== ourDownloadId) return;
      suggestedRealFilename = item.filename || suggestedRealFilename || null;
      suggest({ filename: tempRelPath, conflictAction: "uniquify" });
    };
    chrome.downloads.onDeterminingFilename.addListener(filenameListener);

    // Der Download-Button existiert erst, nachdem die SPA nach "complete"
    // noch clientseitig nachgerendert hat - deshalb kurzer Retry-Loop statt
    // eines einzelnen Versuchs direkt nach dem Laden.
    let clicked = false;
    for (let i = 0; i < 15 && !clicked; i++) {
      const results = await chrome.scripting.executeScript({
        target: { tabId },
        func: (selector) => {
          const btn = document.querySelector(selector);
          if (btn) {
            btn.click();
            return true;
          }
          return false;
        },
        args: [ONEDRIVE_DOWNLOAD_BUTTON_SELECTOR],
      });
      clicked = !!(results && results[0] && results[0].result);
      if (!clicked) await new Promise((r) => setTimeout(r, 500));
    }

    if (!clicked) {
      console.warn("[PA Background] OneDrive: download button never appeared in window", windowId, "after 15 retries");
      cleanup();
      return { ok: false, error: "OneDrive download button not found (link may require login, be a folder, or downloads may be disabled by the owner)" };
    }

    const startTimeout = new Promise((resolve) => setTimeout(() => resolve(null), 15000));
    const startedItem = await Promise.race([downloadStartedPromise, startTimeout]);

    if (!startedItem) {
      console.warn("[PA Background] OneDrive: no download started within 15s in window", windowId);
      cleanup();
      return { ok: false, error: "OneDrive download did not start within 15s" };
    }

    // WICHTIG: das Fenster HIER noch NICHT schliessen, obwohl der Download
    // schon "gestartet" ist. Live beobachtet: schliesst man es zu diesem
    // fruehen Zeitpunkt (direkt nach onCreated, bevor der Datei-Schreibvorgang
    // wirklich etabliert ist), bricht Chrome den Download selbst ab
    // (state: "interrupted", error: "USER_CANCELED") - ein zu frueh
    // geschlossener initiierender Tab/Fenster wird offenbar als
    // Nutzer-Abbruch gewertet, nicht als "laeuft im Hintergrund weiter". Das
    // Fenster bleibt deshalb bis zum tatsaechlichen Abschluss offen (aber
    // weiterhin minimiert/nicht fokussiert) und wird erst in cleanup() unten
    // geschlossen.

    const completedItem = await new Promise((resolve) => {
      let settled = false;
      let changedListener = null;
      let pollInterval = null;
      const finish = (item) => {
        if (settled) return;
        settled = true;
        if (changedListener) chrome.downloads.onChanged.removeListener(changedListener);
        if (pollInterval) clearInterval(pollInterval);
        resolve(item);
      };
      changedListener = (delta) => {
        if (delta.id !== capturedDownloadId) return;
        if (delta.state && (delta.state.current === "complete" || delta.state.current === "interrupted")) {
          chrome.downloads.search({ id: capturedDownloadId }).then((items) => finish(items[0] || null));
        }
      };
      chrome.downloads.onChanged.addListener(changedListener);
      // Live-Fortschritt: Chromes eigene Download-Infos (bytesReceived/
      // totalBytes) periodisch abfragen und an den Aufrufer weiterreichen -
      // damit zeigt die Extension waehrend des Browser-Downloads einen echten
      // Fortschritt statt nur "laedt..." ohne Prozentangabe.
      if (typeof onProgress === "function") {
        pollInterval = setInterval(() => {
          chrome.downloads.search({ id: capturedDownloadId }).then((items) => {
            const it = items[0];
            if (it && it.state === "in_progress") {
              onProgress({ bytesReceived: it.bytesReceived, totalBytes: it.totalBytes });
            }
          }).catch(() => {});
        }, 700);
      }
      // Race-Schutz: falls der Download zwischen onCreated und dem
      // Registrieren dieses Listeners bereits fertig wurde.
      chrome.downloads.search({ id: capturedDownloadId }).then((items) => {
        if (items[0] && (items[0].state === "complete" || items[0].state === "interrupted")) finish(items[0]);
      });
      // Grosszuegiges Timeout (30 Minuten) als reines Sicherheitsnetz gegen
      // einen haengenden Download, kein normaler Erfolgsfall.
      setTimeout(() => finish(null), 30 * 60 * 1000);
    });

    cleanup();

    if (!completedItem || completedItem.state !== "complete") {
      console.warn("[PA Background] OneDrive: download", capturedDownloadId, "did not complete successfully:", completedItem?.state, completedItem?.error);
      if (capturedDownloadId != null) chrome.downloads.erase({ id: capturedDownloadId }).catch(() => {});
      return { ok: false, error: `OneDrive download did not complete (state: ${completedItem?.state || "unknown"}${completedItem?.error ? ", " + completedItem.error : ""})` };
    }

    return {
      ok: true,
      localPath: completedItem.filename,
      filename: suggestedRealFilename ? suggestedRealFilename.split(/[\\/]/).pop() : null,
      sizeBytes: completedItem.fileSize > 0 ? completedItem.fileSize : (completedItem.totalBytes || null),
      downloadId: capturedDownloadId,
    };
  } catch (err) {
    console.warn("[PA Background] OneDrive: hidden-window download threw:", err.message);
    cleanup();
    return { ok: false, error: err.message };
  }
}

async function resolveMediafireViaHiddenTab(shareUrl) {
  let tabId = null;
  try {
    const tab = await chrome.tabs.create({ url: shareUrl, active: false });
    tabId = tab.id;
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 400));
      const results = await chrome.scripting.executeScript({
        target: { tabId },
        func: () => {
          // Aktuelles MediaFire-Markup (verifiziert 2026-07-27) hat KEIN
          // id="downloadButton" und keine "mediafire.com/download"-Pfadform
          // mehr - der echte Link ist ein einfacher <a href="https://
          // downloadNNNN.mediafire.com/..."> ohne stabile ID/Klasse. Deshalb
          // ueber ALLE Links nach dem Hostname-Muster suchen statt nach einem
          // bestimmten Selektor.
          const links = Array.from(document.querySelectorAll("a[href]"));
          const btn = links.find((a) => {
            try {
              return /^download[a-z0-9]*\.mediafire\.com$/i.test(new URL(a.href).hostname);
            } catch {
              return false;
            }
          }) || document.querySelector('#downloadButton, a[href*="mediafire.com/download"]');
          const filenameEl = document.querySelector('.dl-btn-label, .filename');
          return btn && btn.href ? { directUrl: btn.href, filename: filenameEl ? filenameEl.innerText.trim() : null } : null;
        },
      });
      if (results && results[0] && results[0].result && results[0].result.directUrl) {
        chrome.tabs.remove(tabId).catch(() => {});
        return { ok: true, directUrl: results[0].result.directUrl, filename: results[0].result.filename };
      }
    }
    console.warn("[PA Background] MediaFire: hidden tab", tabId, "found no download link after 20 retries");
    if (tabId != null) chrome.tabs.remove(tabId).catch(() => {});
    return { ok: false, error: "MediaFire link not found via hidden tab" };
  } catch (err) {
    console.warn("[PA Background] MediaFire: hidden-tab resolution threw:", err.message);
    if (tabId != null) chrome.tabs.remove(tabId).catch(() => {});
    return { ok: false, error: err.message };
  }
}

async function resolveWetransferViaHiddenTab(shareUrl) {
  let tabId = null;
  let filenameListener = null;
  try {
    const tab = await chrome.tabs.create({ url: shareUrl, active: false });
    tabId = tab.id;
    let downloadUrl = null;
    const listener = (item) => {
      if (tabId != null && item.tabId != null && item.tabId !== tabId) return;
      downloadUrl = item.finalUrl || item.url;
      chrome.downloads.cancel(item.id, () => chrome.downloads.erase({ id: item.id }));
    };
    chrome.downloads.onCreated.addListener(listener);
    // Gleicher Grund wie bei OneDrive: verhindert ein natives "Speichern
    // unter"-Dialogfenster, falls der Nutzer "jedes Mal nach Speicherort
    // fragen" aktiviert hat.
    filenameListener = (item, suggest) => {
      suggest({ filename: item.filename || "wetransfer_download.bin", conflictAction: "uniquify" });
    };
    chrome.downloads.onDeterminingFilename.addListener(filenameListener);

    for (let i = 0; i < 25; i++) {
      await new Promise((r) => setTimeout(r, 400));
      if (downloadUrl) break;
      await chrome.scripting.executeScript({
        target: { tabId },
        func: () => {
          const btn = document.querySelector('button[class*="download"], [data-testid*="download"], button');
          if (btn && btn.innerText && btn.innerText.toLowerCase().includes("download")) {
            btn.click();
          }
        },
      }).catch(() => {});
    }
    chrome.downloads.onCreated.removeListener(listener);
    if (filenameListener) chrome.downloads.onDeterminingFilename.removeListener(filenameListener);
    if (tabId != null) chrome.tabs.remove(tabId).catch(() => {});
    if (downloadUrl) {
      return { ok: true, directUrl: downloadUrl };
    }
    console.warn("[PA Background] WeTransfer: hidden tab", tabId, "found no download after 25 retries");
    return { ok: false, error: "WeTransfer download did not start via hidden tab" };
  } catch (err) {
    console.warn("[PA Background] WeTransfer: hidden-tab resolution threw:", err.message);
    if (filenameListener) chrome.downloads.onDeterminingFilename.removeListener(filenameListener);
    if (tabId != null) chrome.tabs.remove(tabId).catch(() => {});
    return { ok: false, error: err.message };
  }
}

async function openDashboard(creatorId) {
  const targetUrl = creatorId ? `${DASHBOARD_URL}?creator=${encodeURIComponent(creatorId)}` : DASHBOARD_URL;
  const tabs = await chrome.tabs.query({ url: DASHBOARD_URL + "*" });
  if (tabs.length > 0) {
    // Dashboard ist schon offen - falls ein Profil ausgewählt werden soll,
    // navigieren wir den Tab neu (statt nur zu fokussieren), damit das
    // richtige Profil auch tatsächlich aktiv wird.
    if (creatorId) {
      chrome.tabs.update(tabs[0].id, { active: true, url: targetUrl });
    } else {
      chrome.tabs.update(tabs[0].id, { active: true });
    }
    chrome.windows.update(tabs[0].windowId, { focused: true });
  } else {
    chrome.tabs.create({ url: targetUrl });
  }
}

const BRIDGE_REPO = "r1kp/patreon-archiver-bridge";
const CHECK_BRIDGE_UPDATE_ALARM = "check-bridge-update-alarm";

chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === "install") {
    openDashboard();
  } else if (details.reason === "update") {
    const newVersion = chrome.runtime.getManifest().version;
    if (details.previousVersion && details.previousVersion !== newVersion) {
      chrome.storage.local.set({
        showExtensionUpdate: true,
        extensionUpdateVersion: newVersion,
        extensionUpdatePrevVersion: details.previousVersion
      });
    }
  }
  applyActionIcon();
  setupAlarms();
  checkBridgeUpdate();
  checkYtdlpUpdate();
});

chrome.runtime.onStartup.addListener(() => {
  setupAlarms();
  checkBridgeUpdate();
  checkYtdlpUpdate();
});

function setupAlarms() {
  chrome.alarms.create(CHECK_BRIDGE_UPDATE_ALARM, {
    periodInMinutes: 720, // 12 hours
  });
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === CHECK_BRIDGE_UPDATE_ALARM) {
    checkBridgeUpdate();
    checkYtdlpUpdate();
  }
});

// Icon ausgrauen, wenn die Extension deaktiviert ist. Wir nutzen dafür die
// Graustufen-Darstellung über setIcon (separate ausgegraute PNGs wären auch
// möglich; hier reicht das eingebaute "disabled"-Gefühl über einen Badge +
// reduzierten Titel, plus optional graue Icons falls vorhanden).
async function applyActionIcon() {
  const { paEnabled } = await chrome.storage.local.get("paEnabled");
  const enabled = paEnabled !== false;
  try {
    if (enabled) {
      await chrome.action.setIcon({
        path: { 16: "icons/icon16.png", 32: "icons/icon32.png", 48: "icons/icon48.png", 128: "icons/icon128.png" },
      });
      updateBadge();
    } else {
      await chrome.action.setIcon({
        path: { 16: "icons/icon16_off.png", 32: "icons/icon32_off.png", 48: "icons/icon48_off.png", 128: "icons/icon128_off.png" },
      });
      await chrome.action.setBadgeBackgroundColor({ color: "#666" });
      await chrome.action.setBadgeText({ text: "off" });
    }
  } catch (e) {
    // Falls die ausgegrauten Icons fehlen, wenigstens den Badge setzen.
    if (enabled) updateBadge();
    else await chrome.action.setBadgeText({ text: "off" });
  }
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local") {
    if (changes.paEnabled) applyActionIcon();
    if (changes.installedBridgeVersion || changes.dismissedBridgeVersion || changes.latestBridgeVersion) {
      updateBadge();
    }
  }
});

applyActionIcon();

// OneDrive-Download laeuft ueber eine langlebige Port-Verbindung statt
// chrome.runtime.sendMessage()/onMessage - der einfache Request/Response-Kanal
// kann nur EINE Antwort liefern, wir wollen aber waehrend des potenziell
// mehrminuetigen Browser-Downloads periodisch Live-Fortschritt (bytesReceived/
// totalBytes) an downloader.js zurueckstreamen, nicht nur das Endergebnis.
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "onedrive-download") return;
  port.onMessage.addListener((msg) => {
    if (msg.type !== "start") return;
    queueOneDriveDownload(msg.url, (progress) => {
      try {
        port.postMessage({ type: "progress", ...progress });
      } catch {
        /* Port evtl. schon getrennt - egal, der finale result-Versuch unten faengt das ab */
      }
    }).then((result) => {
      try {
        port.postMessage({ type: "result", ...result });
      } catch {
        /* Aufrufer hat sich schon getrennt (z.B. Dashboard-Tab geschlossen) */
      }
    });
  });
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    switch (msg.type) {
      case "OPEN_DASHBOARD":
        await openDashboard(msg.creatorId);
        sendResponse({ ok: true });
        break;

      // Log-Kanal fuer content.js: das ist ein klassisches Content-Script und
      // kann lib/appLog.js nicht importieren (kein Modul). Seine wichtigen
      // Ereignisse kommen deshalb hier an und werden von diesem Worker
      // mitgeschrieben.
      case "APP_LOG": {
        logEvent(msg.level || "info", msg.message || "", msg.source || "content");
        sendResponse({ ok: true });
        break;
      }

      case "UPSERT_CREATOR": {
        const creator = await upsertCreator(msg.creator);
        sendResponse({ ok: true, creator });
        break;
      }

      case "UPSERT_POSTS": {
        await upsertPosts(msg.posts);
        logMilestone(`Scan: ${(msg.posts || []).length} post(s) stored`, "background");
        sendResponse({ ok: true });
        break;
      }

      case "GET_CREATORS": {
        const creators = await getAllCreators();
        sendResponse({ ok: true, creators });
        break;
      }

      case "GET_POSTS": {
        const posts = await getPostsForCreator(msg.creatorId);
        sendResponse({ ok: true, posts });
        break;
      }

      case "GET_SETTINGS": {
        const settings = await getSettings();
        sendResponse({ ok: true, settings });
        break;
      }

      case "DELETE_CREATOR": {
        await deleteCreator(msg.creatorId);
        sendResponse({ ok: true });
        break;
      }

      case "FETCH_URL_BYTES": {
        try {
          const res = await fetch(msg.url);
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const buf = await res.arrayBuffer();
          const bytes = Array.from(new Uint8Array(buf));
          sendResponse({ ok: true, buffer: bytes });
        } catch (err) {
          sendResponse({ ok: false, error: err.message });
        }
        break;
      }

      case "RESOLVE_GOOGLE_DRIVE": {
        try {
          const fileId = msg.fileId;
          const initialUrl = `https://drive.google.com/uc?export=download&id=${fileId}`;
          const res = await fetch(initialUrl, { method: "GET", credentials: "omit" });
          const contentType = res.headers.get("content-type") || "";
          const disposition = res.headers.get("content-disposition") || "";
          const filenameMatch = disposition.match(/filename\*?=(?:UTF-8'')?["']?([^"';\n]+)["']?/i);
          const filename = filenameMatch ? decodeURIComponent(filenameMatch[1]) : null;

          if (!contentType.includes("text/html")) {
            sendResponse({ ok: true, directUrl: initialUrl, filename });
            break;
          }

          const htmlText = await res.text();
          const hrefMatch = htmlText.match(/id=["']uc-download-link["'][^>]*href=["']([^"']+)["']/i);
          if (hrefMatch && hrefMatch[1]) {
            const rawHref = hrefMatch[1].replace(/&amp;/g, "&");
            const fullLink = rawHref.startsWith("http") ? rawHref : `https://drive.google.com${rawHref}`;
            sendResponse({ ok: true, directUrl: fullLink, filename });
            break;
          }

          const confirmMatch = htmlText.match(/confirm=([a-zA-Z0-9_-]+)/i) ||
                               htmlText.match(/name=["']confirm["']\s+value=["']([a-zA-Z0-9_-]+)["']/i);
          if (confirmMatch && confirmMatch[1]) {
            const confirmToken = confirmMatch[1];
            const confirmedUrl = `https://drive.google.com/uc?export=download&id=${fileId}&confirm=${confirmToken}`;
            sendResponse({ ok: true, directUrl: confirmedUrl, filename });
            break;
          }

          sendResponse({ ok: true, directUrl: initialUrl, filename });
        } catch (err) {
          sendResponse({ ok: false, error: err.message });
        }
        break;
      }


      case "ERASE_DOWNLOAD": {
        try {
          if (msg.downloadId != null) await chrome.downloads.erase({ id: msg.downloadId });
          sendResponse({ ok: true });
        } catch (err) {
          sendResponse({ ok: false, error: err.message });
        }
        break;
      }

      case "RESOLVE_MEDIAFIRE": {
        try {
          // Hinweis: "User-Agent" ist ein von fetch()/XHR verbotener Header und
          // wird vom Browser stillschweigend ignoriert, egal was hier steht -
          // wird trotzdem gesetzt, falls sich das in einer zukuenftigen
          // Chrome-Version aendert, macht aber aktuell keinen Unterschied.
          const res = await fetch(msg.url, {
            method: "GET",
            credentials: "omit",
            headers: {
              "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
              "Accept-Language": "en-US,en;q=0.9",
            }
          });
          const html = await res.text();
          const hrefMatch = html.match(/href=["'](https?:\/\/(?:download[a-z0-9]*|[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3})\.mediafire\.com\/[^"']+)["']/i) ||
                             html.match(/href=["'](https?:\/\/[^\s"'<>]*mediafire\.com\/[^\s"'<>]*download[^\s"'<>.]*\.[a-z0-9]{2,5})["']/i) ||
                             html.match(/id=["']downloadButton["'][^>]*href=["']([^"']+)["']/i) ||
                             html.match(/(https?:\/\/download[a-z0-9]*\.mediafire\.com\/[^\s"'<>]+)/i);
          if (hrefMatch && hrefMatch[1]) {
            const nameMatch = html.match(/class=["']dl-btn-label["'][^>]*>([^<]+)</i) ||
                               html.match(/<div class=["']filename["'][^>]*>([^<]+)</i) ||
                               html.match(/aria-label=["']Download file\s*([^"']+)["']/i);
            const result = {
              ok: true,
              directUrl: hrefMatch[1].replace(/&amp;/g, "&"),
              filename: nameMatch ? nameMatch[1].trim() : null,
            };
            sendResponse(result);
            break;
          }
          console.warn("[PA Background] RESOLVE_MEDIAFIRE regex found no match (HTML length:", html.length, ") - falling back to hidden tab.");
          const tabRes = await resolveMediafireViaHiddenTab(msg.url);
          sendResponse(tabRes);
        } catch (err) {
          console.warn("[PA Background] RESOLVE_MEDIAFIRE fetch/regex path threw, falling back to hidden tab:", err.message);
          const tabRes = await resolveMediafireViaHiddenTab(msg.url);
          sendResponse(tabRes);
        }
        break;
      }

      case "RESOLVE_WETRANSFER": {
        try {
          const headRes = await fetch(msg.url, { method: "GET", redirect: "follow" });
          const finalUrl = headRes.url;
          const parts = new URL(finalUrl).pathname.split("/").filter(Boolean);
          let transferId = null;
          let secHash = null;
          let recipientId = null;
          if (parts.length >= 3 && parts[0] === "downloads") {
            transferId = parts[1];
            if (parts.length === 4) {
              recipientId = parts[2];
              secHash = parts[3];
            } else {
              secHash = parts[parts.length - 1];
            }
          }
          if (transferId && secHash) {
            const apiEndpoint = recipientId
              ? `https://wetransfer.com/api/v4/transfers/${transferId}/recipients/${recipientId}/download`
              : `https://wetransfer.com/api/v4/transfers/${transferId}/download`;
            const apiRes = await fetch(apiEndpoint, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "X-Requested-With": "XMLHttpRequest",
              },
              body: JSON.stringify({ security_hash: secHash, intent: "entire_transfer" }),
            });
            const data = await apiRes.json();
            if (data && data.direct_link) {
              const result = { ok: true, directUrl: data.direct_link, filename: data.display_name || data.filename || null };
              sendResponse(result);
              break;
            }
            console.warn("[PA Background] RESOLVE_WETRANSFER API response had no direct_link:", data);
          }
          console.warn("[PA Background] RESOLVE_WETRANSFER API path failed - falling back to hidden tab.");
          const tabRes = await resolveWetransferViaHiddenTab(msg.url);
          sendResponse(tabRes);
        } catch (err) {
          console.warn("[PA Background] RESOLVE_WETRANSFER API path threw, falling back to hidden tab:", err.message);
          const tabRes = await resolveWetransferViaHiddenTab(msg.url);
          sendResponse(tabRes);
        }
        break;
      }

      case "FETCH_FILE_SIZES": {
        const sizes = {};
        const urls = msg.urls || [];
        await Promise.all(
          urls.slice(0, 15).map(async (url) => {
            try {
              const res = await fetch(url, { method: "HEAD", credentials: "omit" });
              const len = res.headers.get("content-length");
              if (len) sizes[url] = parseInt(len, 10);
            } catch {}
          })
        );
        sendResponse({ ok: true, sizes });
        break;
      }

      default:
        sendResponse({ ok: false, error: "Unbekannter Nachrichtentyp" });
    }
  })();
  return true; // async response
});

function isVersionOlder(current, latest) {
  if (!current || !latest) return false;
  const clean = (v) => v.replace(/^v/, "").split(".").map(Number);
  const currParts = clean(current);
  const lateParts = clean(latest);
  for (let i = 0; i < Math.max(currParts.length, lateParts.length); i++) {
    const c = currParts[i] || 0;
    const l = lateParts[i] || 0;
    if (l > c) return true;
    if (c > l) return false;
  }
  return false;
}

async function checkBridgeUpdate() {
  try {
    const res = await fetch(`https://api.github.com/repos/${BRIDGE_REPO}/releases/latest`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const latestVersion = data.tag_name;
    const changelog = data.body || "";
    const htmlUrl = data.html_url || "";

    await chrome.storage.local.set({
      latestBridgeVersion: latestVersion,
      bridgeChangelog: changelog,
      bridgeReleaseUrl: htmlUrl,
      lastBridgeUpdateCheck: Date.now(),
    });

    updateBadge();
  } catch (err) {
    console.warn("Failed to check for bridge update:", err);
  }
}

async function checkYtdlpUpdate() {
  try {
    const res = await fetch("https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const latestVersion = (data.tag_name || "").replace(/^v/, "");
    await chrome.storage.local.set({
      latestYtdlpVersion: latestVersion,
      lastYtdlpUpdateCheck: Date.now(),
    });
  } catch (err) {
    console.warn("Failed to check for yt-dlp update:", err);
  }
}

async function updateBadge() {
  const { latestBridgeVersion, dismissedBridgeVersion, installedBridgeVersion } = await chrome.storage.local.get([
    "latestBridgeVersion",
    "dismissedBridgeVersion",
    "installedBridgeVersion",
  ]);

  if (
    latestBridgeVersion &&
    installedBridgeVersion &&
    latestBridgeVersion !== dismissedBridgeVersion &&
    isVersionOlder(installedBridgeVersion, latestBridgeVersion)
  ) {
    chrome.action.setBadgeText({ text: "!" });
    chrome.action.setBadgeBackgroundColor({ color: "#ff5a3c" });
  } else {
    const { paEnabled } = await chrome.storage.local.get("paEnabled");
    const enabled = paEnabled !== false;
    chrome.action.setBadgeText({ text: enabled ? "" : "off" });
  }
}
