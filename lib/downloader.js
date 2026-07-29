// JSZip wird klassisch per <script> in dashboard.html geladen (UMD-Build,
// kein ES-Modul) und hängt sich dadurch als globale Variable an.
const JSZip = globalThis.JSZip;
import { updateFileDownloadStatus } from "./db.js";
import { fetchBytesViaPatreonTab, refetchPostRaw, fetchCommentsRaw } from "./tabProxy.js";
import { writeFileViaBridge, downloadUrlViaBridge, downloadViaYtDlp, pingYtDlpHost, checkFileExistsViaBridge, getDefaultDownloadDir, buildYtdlpFormat, getUrlSize, moveLocalFileViaBridge, deleteDirectoryViaBridge, cleanupPartialViaBridge } from "./nativeHost.js";
import { createVideoProgressTracker } from "./videoProgress.js";
import { getFilenameFromCloudUrl, resolveDirectDownloadUrl, resolveDirectDownloadUrlWithName, unsupportedCloudProvider, isCloudFolderUrl } from "./cloudDownloader.js";
import { createPool } from "./concurrencyPool.js";

export function sanitizeForPath(str, fallback) {
  const s = (str || fallback || "unbenannt").toString();
  return s
    .replace(/[\\/:*?"<>|]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
}

export async function findExistingVideoFile({
  creatorName,
  postFolder,
  videoBaseName,
  isAudioOnly,
  settings,
  bridgeConnected,
  bridgeBaseDir,
  useBridgePath,
  useDirHandle
}) {
  const candidates = isAudioOnly
    ? [`${videoBaseName}.m4a`]
    : [`${videoBaseName}.mp4`, `${videoBaseName}.mkv`, `${videoBaseName}.webm`];
  
  for (const name of candidates) {
    if (useBridgePath) {
      const creatorFolder = sanitizeForPath(creatorName, "creator");
      const checkPath = [bridgeBaseDir, creatorFolder, postFolder, name].join("/").replace(/\\/g, "/");
      const exists = await checkFileExistsViaBridge(checkPath);
      if (exists) return name;
    } else if (useDirHandle) {
      try {
        let dir = settings.dirHandle;
        const folder = sanitizeForPath(creatorName, "creator");
        for (const part of [folder, postFolder]) {
          dir = await dir.getDirectoryHandle(part, { create: false });
        }
        await dir.getFileHandle(name, { create: false });
        return name;
      } catch { /* noop */ }
    }
  }
  return null;
}

export function dateStamp(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

export const MIME_EXT_MAP = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "video/mp4": ".mp4",
  "video/quicktime": ".mov",
  "video/webm": ".webm",
  "audio/mpeg": ".mp3",
  "audio/mp4": ".m4a",
  "application/pdf": ".pdf",
  "application/zip": ".zip",
};

function extFor(filename, mimetype, fallbackExt) {
  if (filename && /\.[a-z0-9]{2,4}$/i.test(filename)) return "";
  return MIME_EXT_MAP[mimetype] || fallbackExt || "";
}

function cleanCloudLink(url) {
  let u = url;
  if (/dropbox\.com/i.test(u)) {
    if (u.includes("dl=0")) {
      u = u.replace("dl=0", "dl=1");
    } else if (!u.includes("dl=1")) {
      u += (u.includes("?") ? "&" : "?") + "dl=1";
    }
  }
  return u;
}

// Ordnet eine Cloud-URL einem Anbieter-Namen zu, damit jeder Anbieter seinen
// eigenen, klein gehaltenen Concurrency-Pool bekommt (Google Drive limitiert
// anonyme Zugriffe nachweislich bei zu viel Parallelitaet - siehe HANDOFF.md).
function cloudProviderKey(url) {
  if (!url) return "generic";
  if (/drive\.google\.com/i.test(url)) return "drive";
  if (/dropbox\.com/i.test(url)) return "dropbox";
  if (/mega\.(nz|io)/i.test(url)) return "mega";
  if (/onedrive\.live\.com|1drv\.ms/i.test(url)) return "onedrive";
  if (/mediafire\.com/i.test(url)) return "mediafire";
  if (/pixeldrain\.com/i.test(url)) return "pixeldrain";
  if (/wetransfer\.com|we\.tl/i.test(url)) return "wetransfer";
  return "generic";
}

// Loest eine Cloud-URL fuer den Bridge-Download auf, ABER nur bei Anbietern,
// die die C#-Bruecke nicht selbst abfaengt. Google Drive und MEGA muessen die
// ROHE URL bekommen - CommandHandlers.cs erkennt diese Domains selbst und
// macht eigene Ordner-Rekursion/ZIP-Export, die eine vorab aufgeloeste
// Einzeldatei-URL zerstoeren wuerde.
async function resolveBridgeDownloadUrl(url) {
  if (!url) return url;
  if (/drive\.google\.com/i.test(url) || /mega\.(nz|io)/i.test(url)) return url;
  return resolveDirectDownloadUrl(url);
}

// Namens-bewusste Variante von resolveBridgeDownloadUrl() - fuer den
// eigentlichen Download-Aufruf (nicht nur den Groessen-Scan) gebraucht, weil
// dort zusaetzlich ein aus der aufgeloesten URL gescrapter Dateiname verwendet
// wird. Derselbe Drive/MEGA-Schutz wie oben: ein Ordner-Link
// (.../drive/folders/<ID>) wuerde vom generischen Resolver faelschlich als
// Einzeldatei-Link (uc?export=download&id=<ID>) umgeschrieben - die Ordner-ID
// landet dann als Datei-ID in der URL, die Bridge fragt Google nach einer
// nicht existenten Datei und bekommt HTTP 500. CommandHandlers.cs erkennt
// Drive/MEGA-Domains selbst und braucht dafuer die ROHE Freigabe-URL.
async function resolveBridgeDownloadUrlWithName(url) {
  if (!url) return { url, filename: null };
  if (/drive\.google\.com/i.test(url) || /mega\.(nz|io)/i.test(url)) return { url, filename: null };
  return resolveDirectDownloadUrlWithName(url);
}

// OneDrive: laesst den kompletten Download durch den echten Chrome-Browser
// laufen (background.js oeffnet dafuer ein unsichtbares, minimiertes
// Hintergrund-Fenster) - die von OneDrive aufgeloeste Direkt-URL ist
// cookie-gebunden und funktioniert NICHT fuer die Bridge (HttpClient ohne
// Browser-Session, live verifiziert: 403). Gibt den lokalen Temp-Pfad zurueck,
// den der Aufrufer per moveLocalFileViaBridge() an seinen finalen Platz
// verschieben muss.
// Laeuft ueber eine langlebige Port-Verbindung (nicht sendMessage/onMessage) -
// background.js streamt darueber periodisch Chromes eigene Download-Infos
// (bytesReceived/totalBytes) als "progress"-Nachrichten, bevor die finale
// "result"-Nachricht kommt. onProgress optional, wenn kein Live-Fortschritt
// gebraucht wird.
function downloadOneDriveFile(shareUrl, onProgress) {
  return new Promise((resolve) => {
    let port;
    try {
      port = chrome.runtime.connect({ name: "onedrive-download" });
    } catch (err) {
      resolve({ ok: false, error: err.message });
      return;
    }
    let settled = false;
    port.onMessage.addListener((msg) => {
      if (msg.type === "progress") {
        if (typeof onProgress === "function") onProgress(msg);
      } else if (msg.type === "result") {
        settled = true;
        resolve(msg);
        port.disconnect();
      }
    });
    port.onDisconnect.addListener(() => {
      void chrome.runtime.lastError;
      if (!settled) resolve({ ok: false, error: "Connection to background closed unexpectedly" });
    });
    port.postMessage({ type: "start", url: shareUrl });
  });
}

const CLOUD_PROVIDER_LABELS = {
  drive: "Google Drive",
  dropbox: "Dropbox",
  onedrive: "OneDrive",
  mediafire: "MediaFire",
  pixeldrain: "PixelDrain",
  wetransfer: "WeTransfer",
  mega: "MEGA",
  generic: "Cloud",
};

function getFilenameFromUrl(url, fallback) {
  try {
    const parsed = new URL(url);
    const pathname = parsed.pathname;
    const lastPart = pathname.substring(pathname.lastIndexOf('/') + 1);
    if (lastPart && /\.[a-z0-9]{2,4}$/i.test(lastPart)) {
      return decodeURIComponent(lastPart);
    }
  } catch {}
  return fallback;
}

// Baut den Namen des Post-Unterordners entsprechend der Einstellungen
// (Datum davor/danach/gar nicht, Post-ID ja/nein).
export function buildPostFolderName(post, naming) {
  const title = sanitizeForPath(post.title, `post-${post.id}`);
  const date = dateStamp(post.publishedAt);
  const idPart = naming.includePostId ? ` [${String(post.id).replace(/^post_/, "")}]` : "";
  let name = title;
  if (naming.datePosition === "prefix" && date) name = `${date} - ${title}`;
  else if (naming.datePosition === "suffix" && date) name = `${title} - ${date}`;
  return sanitizeForPath(`${name}${idPart}`, `post-${post.id}`);
}

// ---------- Schritt-/Gewichts-Planung (EINE Quelle fuer Bulk- UND Einzelpfad) ----------
//
// Byte-Gewicht pro Schritt: echte sizeBytes aus Patreons API wo bekannt (kein
// Zusatz-Request noetig), sonst eine grobe Schaetzung nach Art. Cloud-Links
// (Drive/Dropbox/Mega) bekommen das hoechste Schaetz-Gewicht, weil sie in der
// Praxis meistens die groessten Post-Bestandteile sind.
export const SIZE_ESTIMATE = {
  TEXT: 20 * 1024,
  THUMBNAIL: 2 * 1024 * 1024,
  VIDEO: 250 * 1024 * 1024,
  CLOUD: 800 * 1024 * 1024,
  FILE: 15 * 1024 * 1024,
};

function isDescriptionFile(file) {
  return !!(file && (file.role === "description" || file.kind === "description"));
}
function isCommentsFile(file) {
  return !!(file && (file.role === "comments" || file.kind === "comments"));
}
function isThumbnailFile(file) {
  return !!(file && (file.role === "thumbnail" || file.kind === "thumbnail"));
}
function isVideoLikeFile(file) {
  return !!(file && (file.role === "video" || file.kind === "video" || file.kind === "embed"));
}
function isCloudLikeFile(file) {
  return !!(file && (file.isCloudLink || file.isWebsite || file.isExternalLink));
}

// Bekannter, aber nicht unterstuetzter Cloud-Anbieter (iCloud, Sync.com, ...).
// Primaerquelle ist das beim Scan gesetzte Feld (content.js); der URL-Check ist
// das Sicherheitsnetz fuer Posts, die vor dieser Runde gescannt wurden.
export function unsupportedProviderOf(file) {
  if (!file) return null;
  return file.unsupportedProvider || unsupportedCloudProvider(file.url) || null;
}

// "Spezial"-Items laufen NICHT ueber den generischen Datei-Loop, sondern ueber
// die ensureX()-Post-Extras-Funktionen (die ihren Schritt selbst zaehlen).
// WICHTIG: description/comments gehoeren hier dazu - sie fehlten frueher in
// dieser Liste, wodurch sie GLEICHZEITIG ueber den isFullPost-Zweig UND ueber
// realFiles gezaehlt wurden. Genau das war die Ursache fuer den "5/7 statt
// 5/5"-Zaehler (und, ueber die doppelt eingerechneten 15-MB-Schaetzgewichte,
// auch fuer die nie ganz volle Ecke-Bar, die falsche Gesamtgroesse und die
// unbrauchbare Est.-Time).
export function isSpecialRoleFile(file) {
  if (!file) return false;
  return (
    file.role === "extras" ||
    isThumbnailFile(file) ||
    isVideoLikeFile(file) ||
    isDescriptionFile(file) ||
    isCommentsFile(file)
  );
}

// Ermittelt fuer EINEN Post, was von ihm in diesem Batch ueberhaupt angefasst
// werden soll. Wird von der Schritt-Planung UND von getPostContext() innerhalb
// von downloadItems() benutzt - beide muessen zwingend dieselbe Antwort geben,
// sonst zaehlt der Nenner etwas anderes als der Zaehler.
export function postSelectionFlags(items, post, options = {}) {
  const pid = String(post.id);
  const postItems = items.filter((it) => String(it.post.id) === pid);
  const totalSelectable =
    (post.thumbnail ? 1 : 0) +
    (post.video ? 1 : 0) +
    (post.files ? post.files.length : 0);
  // Description/Comments sind SYNTHETISCHE Zeilen - sie haben keine
  // Entsprechung in totalSelectable (das nur Thumbnail/Video/post.files zaehlt).
  // Wuerden sie mitgezaehlt, gilt ein Post schon dann faelschlich als
  // "komplett ausgewaehlt", wenn nur Description + Comments + ein paar Dateien
  // angehakt sind - mit der Folge, dass Thumbnail/Video ungefragt mit
  // heruntergeladen werden und zusaetzliche, nirgends eingeplante Schritte
  // entstehen. Die "extras"-Zeile (reine Text-Posts) zaehlt bewusst weiter mit,
  // sie IST dort die Auswahl des ganzen Posts.
  const countingItems = postItems.filter(
    (it) => !isDescriptionFile(it.file) && !isCommentsFile(it.file)
  );
  const isFullPost =
    !options.singleFile &&
    countingItems.length > 0 &&
    countingItems.length >= totalSelectable;
  const has = (pred) => postItems.some((it) => pred(it.file));
  return {
    postItems,
    isFullPost,
    hasFileDownloads: postItems.some(
      (it) =>
        it.file &&
        it.file.kind !== "thumbnail" &&
        it.file.kind !== "video" &&
        it.file.kind !== "embed" &&
        it.file.role !== "thumbnail" &&
        it.file.role !== "video"
    ),
    wantsThumbnail: has(isThumbnailFile),
    wantsVideo: has(isVideoLikeFile),
    wantsDescription: has(isDescriptionFile),
    wantsComments: has(isCommentsFile),
  };
}

// Gemeinsame Vorab-Planung: wie viele Schritte hat der Batch (Nenner der
// "X von Y"-Anzeige) und wie viel Byte-Gewicht steckt darin (Nenner der
// Prozent-/Groessen-/ETA-Anzeige).
//
// Wird sowohl von downloadItems() als auch von dashboard.js' downloadMany()
// benutzt. Vorher existierte diese Rechnung ZWEIMAL (einmal hier, einmal als
// "estTotal"-Kopie in downloadMany) und lief bei jeder Aenderung auseinander -
// exakt das in CLAUDE.md/HANDOFF.md dokumentierte Duplikat-Fehlermuster.
//
// Nebeneffekt (gewollt): setzt `__appliedWeight` auf jedem beteiligten
// Datei-/Thumbnail-/Video-Objekt - das ist das Gewicht, mit dem dieses Item
// aktuell in totalWeight steckt. Nur so koennen Vorab-Groessenscan und
// laufender Download spaeter dieselbe Zahl korrigieren, statt sich gegenseitig
// zu verrechnen (siehe setItemWeight() in downloadItems()).
export function planDownloadSteps(items, settings = {}, options = {}) {
  const uniquePosts = new Map();
  items.forEach(({ post }) => uniquePosts.set(String(post.id), post));

  let totalSteps = 0;
  let totalWeight = 0;

  uniquePosts.forEach((post) => {
    const flags = postSelectionFlags(items, post, options);
    if (settings.includeDescription !== false && (flags.isFullPost || flags.wantsDescription)) {
      totalSteps++;
      totalWeight += SIZE_ESTIMATE.TEXT;
    }
    if (settings.includeComments !== false && (flags.isFullPost || flags.wantsComments)) {
      totalSteps++;
      totalWeight += SIZE_ESTIMATE.TEXT;
    }
    if (
      settings.includeThumbnails !== false &&
      post.thumbnail?.url &&
      (flags.isFullPost || flags.wantsThumbnail)
    ) {
      totalSteps++;
      const w = post.thumbnail.sizeBytes || SIZE_ESTIMATE.THUMBNAIL;
      post.thumbnail.__appliedWeight = w;
      totalWeight += w;
    }
    if (post.video && (flags.isFullPost || flags.wantsVideo)) {
      totalSteps++;
      const w = post.video.sizeBytes || SIZE_ESTIMATE.VIDEO;
      post.video.__appliedWeight = w;
      totalWeight += w;
    }
  });

  const realFiles = items.filter((it) => !isSpecialRoleFile(it.file));
  totalSteps += realFiles.length;
  realFiles.forEach((it) => {
    const f = it.file;
    // Nicht unterstuetzter Anbieter: es wird gar nichts uebertragen (der Schritt
    // endet sofort mit einer Meldung), also auch keine 800-MB-Cloud-Schaetzung
    // ins Byte-Budget legen - die wuerde Gesamtgroesse, Prozente und ETA
    // verfaelschen.
    const w = unsupportedProviderOf(f)
      ? SIZE_ESTIMATE.TEXT
      :
      (f && f.__realSizeBytes) ||
      (f && f.sizeBytes) ||
      (isCloudLikeFile(f) ? SIZE_ESTIMATE.CLOUD : SIZE_ESTIMATE.FILE);
    if (f) f.__appliedWeight = w;
    totalWeight += w;
  });

  // Spezial-Items (Thumbnail/Video) kommen als KOPIE des post.thumbnail-/
  // post.video-Objekts in items an ({...post.thumbnail, kind:"thumbnail"}),
  // bekommen oben also kein __appliedWeight ab. Hier nachtragen, damit der
  // Aufrufer (dashboard.js) beim Vormarkieren der Zeilen fuer JEDES Item das
  // eingeplante Gewicht mitgeben kann. Ohne das zaehlte eine noch wartende
  // Zeile im Post-Aggregat mit einem 500-KB-Platzhalter - der Balken stand
  // dadurch schon bei ~97%, wenn nur die kleinen Items durch waren, und blieb
  // dort haengen, sobald das grosse Item seine echte Groesse meldete.
  items.forEach((it) => {
    const f = it.file;
    if (!f || f.__appliedWeight) return;
    if (isThumbnailFile(f)) f.__appliedWeight = it.post?.thumbnail?.__appliedWeight || SIZE_ESTIMATE.THUMBNAIL;
    else if (isVideoLikeFile(f)) f.__appliedWeight = it.post?.video?.__appliedWeight || SIZE_ESTIMATE.VIDEO;
    else if (isDescriptionFile(f) || isCommentsFile(f)) f.__appliedWeight = SIZE_ESTIMATE.TEXT;
    else if (f.role === "extras") f.__appliedWeight = SIZE_ESTIMATE.TEXT * 2;
  });

  return { totalSteps, totalWeight, realFiles };
}

// ---------- Modus A: chrome.downloads (relativ zum Chrome-Downloads-Ordner) ----------

function downloadViaChromeApi(url, relativePath, { onProgress, requestId } = {}) {
  return new Promise((resolve) => {
    chrome.downloads.download(
      {
        url,
        filename: relativePath,
        saveAs: false,
        conflictAction: "uniquify",
      },
      (downloadId) => {
        if (chrome.runtime.lastError || !downloadId) {
          resolve({ ok: false, error: chrome.runtime.lastError?.message || "unbekannter Fehler" });
          return;
        }
        let pollTimer = null;
        if (onProgress) {
          let lastBytes = 0;
          let lastTime = Date.now();
          pollTimer = setInterval(() => {
            chrome.downloads.search({ id: downloadId }, (results) => {
              const d = results?.[0];
              if (!d) return;
              const now = Date.now();
              const bytesReceived = d.bytesReceived || 0;
              const totalBytes = d.totalBytes > 0 ? d.totalBytes : 0;
              const deltaBytes = bytesReceived - lastBytes;
              const deltaTime = (now - lastTime) / 1000;
              const speed = deltaTime > 0 ? deltaBytes / deltaTime : 0;
              lastBytes = bytesReceived;
              lastTime = now;
              onProgress({ requestId, received: bytesReceived, total: totalBytes, speedBytesPerSec: speed });
            });
          }, 400);
        }
        const listener = (delta) => {
          if (delta.id !== downloadId) return;
          if (delta.state && delta.state.current === "complete") {
            chrome.downloads.onChanged.removeListener(listener);
            if (pollTimer) clearInterval(pollTimer);
            resolve({ ok: true });
          } else if (delta.state && delta.state.current === "interrupted") {
            chrome.downloads.onChanged.removeListener(listener);
            if (pollTimer) clearInterval(pollTimer);
            resolve({ ok: false, error: `Download unterbrochen (${delta.error?.current || "unbekannt"})` });
          }
        };
        chrome.downloads.onChanged.addListener(listener);
      }
    );
  });
}

// Lightweight variant for blob: URLs (text files) – Chrome refuses custom
// headers on blob: URLs so we must not pass them here.
function downloadTextViaChromeApi(blobUrl, relativePath) {
  return new Promise((resolve) => {
    chrome.downloads.download(
      {
        url: blobUrl,
        filename: relativePath,
        saveAs: false,
        conflictAction: "overwrite",
      },
      (downloadId) => {
        if (chrome.runtime.lastError || !downloadId) {
          resolve({ ok: false, error: chrome.runtime.lastError?.message || "unknown error" });
          return;
        }
        const listener = (delta) => {
          if (delta.id !== downloadId) return;
          if (delta.state?.current === "complete") {
            chrome.downloads.onChanged.removeListener(listener);
            resolve({ ok: true });
          } else if (delta.state?.current === "interrupted") {
            chrome.downloads.onChanged.removeListener(listener);
            resolve({ ok: false, error: delta.error?.current || "interrupted" });
          }
        };
        chrome.downloads.onChanged.addListener(listener);
      }
    );
  });
}

// ---------- Modus B: Brücke - direkter Download auf einen echten Pfad ----------
// Zuverlässiger als der frühere Umweg über einen versteckten Browser-Tab,
// weil der native Host die Datei direkt selbst herunterlädt (kein
// Cookie-/CORS-Zwang, da Patreons Download-URLs i.d.R. bereits signiert und
// eigenständig gültig sind).

async function downloadToPathViaBridge(url, fullPath, { onProgress, requestId, cancelSignal } = {}) {
  try {
    await downloadUrlViaBridge(url, fullPath, (p) => onProgress?.({ requestId, ...p }), cancelSignal);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// ---------- Modus C: File System Access API (nur Ordnername, ohne Brücke) ----------

async function ensureDirPermission(dirHandle) {
  const opts = { mode: "readwrite" };
  if ((await dirHandle.queryPermission(opts)) === "granted") return true;
  return (await dirHandle.requestPermission(opts)) === "granted";
}

async function writeBlobToDirectory(dirHandle, subpathParts, blob) {
  if (!(await ensureDirPermission(dirHandle))) {
    throw new Error(
      "Kein Schreibzugriff auf den gewählten Ordner mehr - bitte in den Einstellungen erneut auswählen."
    );
  }
  let dir = dirHandle;
  for (const part of subpathParts.slice(0, -1)) {
    dir = await dir.getDirectoryHandle(part, { create: true });
  }
  const fileHandle = await dir.getFileHandle(subpathParts[subpathParts.length - 1], { create: true });
  const writable = await fileHandle.createWritable();
  await writable.write(blob);
  await writable.close();
}

// Nur noch für: ZIP-Erstellung (Bytes müssen ohnehin im Speicher zusammengebaut
// werden) und den bridge-losen Ordner-Auswahl-Modus (Fallback ohne Brücke).
async function fetchAsBlob(url, { onProgress, requestId } = {}) {
  const progressListener = onProgress
    ? (msg) => {
        if (msg?.type === "PA_DOWNLOAD_PROGRESS" && msg.requestId === requestId) {
          onProgress({ requestId, received: msg.received, total: msg.total });
        }
      }
    : null;
  if (progressListener) chrome.runtime.onMessage.addListener(progressListener);
  try {
    const buffer = await fetchBytesViaPatreonTab(url, requestId);
    return new Blob([buffer]);
  } catch (tabErr) {
    // Fallback: Fetch Cloud URLs via Background Service Worker to bypass tab CORS
    try {
      const bgRes = await new Promise((resolve) => {
        chrome.runtime.sendMessage({ type: "FETCH_URL_BYTES", url }, (res) => resolve(res || {}));
      });
      if (bgRes && bgRes.ok && bgRes.buffer) {
        return new Blob([new Uint8Array(bgRes.buffer)]);
      }
    } catch {}
    throw tabErr;
  } finally {
    if (progressListener) chrome.runtime.onMessage.removeListener(progressListener);
  }
}

function textBlob(text) {
  return new Blob([text], { type: "text/plain;charset=utf-8" });
}

// Inhalt der description.txt - aus demselben Grund exportiert wie
// formatCommentsText(): das Dashboard zeigt die Groesse damit vorab an, ohne
// die Formatierung ein zweites Mal nachzubauen.
export function buildDescriptionFileText(post, descText) {
  const dateStr = dateStamp(post.publishedAt) || "unknown";
  return [
    `Title: ${post.title}`,
    `Date: ${dateStr}`,
    `URL: ${post.url}`,
    `Type: ${post.postType}`,
    "-".repeat(60),
    descText
  ].join("\n");
}

// Exportiert, damit das Dashboard die GLEICHE Formatierung benutzen kann, um
// die Dateigroesse vorab anzuzeigen - keine zweite, leicht abweichende Kopie
// (sonst weicht die angezeigte Groesse von der tatsaechlich geschriebenen ab).
export function formatCommentsText(post, comments) {
  if (!comments || comments.length === 0) return null;
  const lines = [`Comments for "${post.title}"`, "=".repeat(40), ""];
  comments.forEach((c) => {
    const formatDate = (isoStr) => {
      if (!isoStr) return "";
      const d = new Date(isoStr);
      if (isNaN(d.getTime())) return "";
      return d.toISOString().replace("T", " ").slice(0, 19);
    };
    const date = formatDate(c.date);
    lines.push(`${c.author}${date ? " · " + date : ""}`);
    lines.push(c.body);
    
    // Format replies if any
    if (c.replies && c.replies.length > 0) {
      c.replies.forEach((r) => {
        const rDate = formatDate(r.date);
        lines.push(`  ↳ ${r.author}${rDate ? " · " + rDate : ""}`);
        const indentedBody = r.body.split("\n").map((l) => "    " + l).join("\n");
        lines.push(indentedBody);
      });
    }
    lines.push("");
  });
  return lines.join("\n");
}

function generateDownloadLinksTxt(post) {
  const dateStr = dateStamp(post.publishedAt) || "unknown";
  const files = post.files || [];
  
  // 1. Videos (native or embed)
  const videoItems = [];
  if (post.video && post.video.url) {
    // Eingebettete Videos (YouTube/Vimeo/...) ausdruecklich als "video_embed"
    // kennzeichnen - beim Lesen der Datei soll auf einen Blick klar sein, dass
    // hier ein VIDEO-Embed steht und keine generische Cloud-Datei (die
    // Cloud-Eintraege weiter unten tragen ihren Anbieter im selben "Type:"-Feld,
    // z.B. "Google Drive"). Anbietername bleibt in Klammern erhalten, wenn
    // Patreon einen mitgeliefert hat.
    const provider = post.video.provider && post.video.provider !== "external" ? post.video.provider : null;
    const typeLabel = post.video.type === "embed"
      ? (provider ? `video_embed (${provider})` : "video_embed")
      : (post.video.type === "native" ? "video_native" : (provider || post.video.type || "Video"));
    videoItems.push({
      name: post.video.filename || post.title || "Video",
      url: post.video.url,
      type: typeLabel
    });
  }

  // 2. Cloud downloads (excluding images/thumbnails) - NUR echte externe
  // Cloud-Links (isCloudLink), keine normalen Patreon-Attachments, die ohnehin
  // schon als echte Datei heruntergeladen werden.
  const downloads = files.filter(
    (f) => f.isCloudLink && f.kind !== "image" && f.kind !== "thumbnail" && f.role !== "thumbnail"
  );

  // 3. Websites & external web links (excluding images/thumbnails)
  const websites = files.filter(
    (f) => f.isWebsite && f.kind !== "image" && f.kind !== "thumbnail" && f.role !== "thumbnail"
  );

  const lines = [
    "======================================================================",
    `DOWNLOAD & EXTERNAL LINKS FOR POST:`,
    `Title: ${post.title}`,
    `URL: ${post.url || `https://www.patreon.com/posts/${post.id}`}`,
    `Published Date: ${dateStr}`,
    "======================================================================",
    ""
  ];

  // Video Section
  if (videoItems.length > 0) {
    lines.push("--- VIDEO LINKS ---");
    videoItems.forEach((v) => {
      lines.push(`• ${v.name}`);
      lines.push(`  URL: ${v.url}`);
      lines.push(`  Type: ${v.type}`);
      lines.push("");
    });
  }

  // Cloud Downloads Section
  if (downloads.length > 0) {
    lines.push("--- CLOUD DOWNLOADS & FILES ---");
    downloads.forEach((f) => {
      lines.push(`• ${f.filename || "File"}`);
      lines.push(`  URL: ${f.url}`);
      if (f.tag) lines.push(`  Type: ${f.tag}`);
      lines.push("");
    });
  }

  // Websites Section
  if (websites.length > 0) {
    lines.push("--- WEBSITES & EXTERNAL LINKS ---");
    websites.forEach((f) => {
      lines.push(`• ${f.filename || "Link"}`);
      lines.push(`  URL: ${f.url}`);
      if (f.tag) lines.push(`  Type: ${f.tag}`);
      lines.push("");
    });
  }

  lines.push("-".repeat(70));
  lines.push("Generated automatically by Patreon Archiver");
  lines.push("======================================================================");

  return lines.join("\n");
}

// ---------- Refresh abgelaufener/verlinkter URLs ----------

function buildIncludedMap(included) {
  const map = new Map();
  (included || []).forEach((item) => map.set(`${item.type}:${item.id}`, item));
  return map;
}

async function refreshFileUrl(post, file) {
  const numericId = String(post.id).replace(/^post_/, "");
  const raw = await refetchPostRaw(numericId);
  if (!raw) return null;

  if (file.role === "thumbnail") {
    const a = raw.data?.attributes || {};
    return a.thumbnail_url || a.image?.large_url || a.image?.url || null;
  }

  const a = raw.data?.attributes || {};
  if (file.role === "video" && (a.post_file?.download_url || a.post_file?.url)) {
    return a.post_file.download_url || a.post_file.url;
  }

  const includedMap = buildIncludedMap(raw.included);
  const relNames = ["media", "images", "attachments"];
  for (const relName of relNames) {
    const rel = raw.data?.relationships?.[relName];
    if (!rel?.data) continue;
    const refs = Array.isArray(rel.data) ? rel.data : [rel.data];
    for (const ref of refs) {
      const full = includedMap.get(`${ref.type}:${ref.id}`);
      if (!full) continue;
      const attr = full.attributes || {};
      const candidateName = attr.file_name || attr.name || attr.display?.default?.file_name;
      if (candidateName === file.filename) {
        return attr.download_url || attr.url || null;
      }
    }
  }

  if (a.post_file) {
    const candidateName = a.post_file.name || a.post_file.file_name;
    if (candidateName === file.filename) {
      return a.post_file.download_url || a.post_file.url || null;
    }
  }

  return null;
}

// ---------- Öffentliche API ----------

/**
 * Lädt eine Liste von "Elementen" eines Posts herunter. Jedes Element landet
 * gemeinsam im Post-Unterordner - genau wie auf Patreon zusammengehörig.
 *
 * items: [{ creatorName, post, file }]
 * settings: { downloadMode, subfolderPath, dirHandle, customFullPath, naming }
 *   - Wenn settings.customFullPath gesetzt ist, wird IMMER die Brücke für den
 *     eigentlichen Dateitransfer genutzt (zuverlässigster, direkter Weg).
 *   - Sonst, wenn settings.dirHandle gesetzt ist, wird der bridge-lose
 *     Dateisystem-Zugriff genutzt (nur Ordnername sichtbar, kein voller Pfad).
 *   - Sonst ganz normal chrome.downloads relativ zum Downloads-Ordner.
 * options: { asZip, zipName, onProgress(itemIndex, itemsTotal, {received,total,speed}) }
 */
export async function downloadItems(items, settings, options = {}) {
  const { asZip = false, zipName = "download.zip", onProgress, onStep, cancelSignal, onLargeFile, forceOverwrite = false } = options;
  const results = []; // bleibt 1:1 index-ausgerichtet mit items/pairs - siehe downloadMany()
  const embedResults = []; // { title, ok, error, viaBridge }
  const extraResults = []; // Thumbnail/Description/Comments/natives Video aus den ensureX()-Post-Extras-Funktionen - nur fuer die Zusammenfassung, NICHT index-ausgerichtet
  const naming = settings.naming || { datePosition: "none", includePostId: false };
  const pingResult = !asZip ? await pingYtDlpHost().catch(() => ({ ok: false })) : { ok: false };
  const bridgeConnected = !!pingResult.ok;

  const subfolderName = settings.subfolderPath !== undefined && settings.subfolderPath !== null
    ? settings.subfolderPath.trim()
    : "PatreonArchiver";

  let bridgeBaseDir = null;
  if (bridgeConnected) {
    if (settings.customFullPath) {
      bridgeBaseDir = settings.customFullPath.replace(/[\\/]+$/, "");
    } else {
      try {
        const defDir = await getDefaultDownloadDir();
        if (defDir) {
          bridgeBaseDir = defDir.replace(/[\\/]+$/, "");
        }
      } catch { /* best-effort */ }
      // KEIN hartcodierter Fallback-Pfad hier: getDefaultDownloadDir() liefert
      // im Fehlerfall/Timeout null zurueck. Wuerden wir hier auf einen erfundenen
      // Pfad ausweichen, wuerde die Bridge munter dorthin schreiben (oder mit
      // DriveNotFoundException scheitern), ohne dass der Nutzer die Dateien je
      // findet. Bleibt bridgeBaseDir null, faellt useBridgePath weiter unten
      // sauber auf den naechstbesten Modus (File System Access / chrome.downloads).
    }
  }

  const useBridgePath = !asZip && bridgeConnected && !!bridgeBaseDir;
  const useDirHandle = !asZip && !useBridgePath && settings.downloadMode === "fs" && !!settings.dirHandle;

  const zip = asZip ? new JSZip() : null;

  // Concurrency-Pools: begrenzen, wie viele Downloads JE TYP gleichzeitig
  // laufen duerfen - nicht unbegrenzt, weil Bandbreite/CPU/Bridge-Prozesse
  // endlich sind und Google Drive bei zu hoher Parallelitaet nachweislich
  // rate-limitet (siehe HANDOFF.md). Jeder Cloud-Anbieter bekommt seinen
  // eigenen kleinen Pool (lazy angelegt), damit z.B. zwei Drive-Ordner sich
  // gegenseitig begrenzen, aber nicht mit Dropbox/Mega um Slots konkurrieren.
  const imagePool = createPool(4); // Thumbnails, Galerie-Bilder
  const videoPool = createPool(2); // natives Video + yt-dlp-Embed-Video
  const genericPool = createPool(4); // normale (nicht-Cloud) Anhaenge, Description/Comments
  const cloudPools = new Map(); // providerKey -> Pool
  // Pro-Anbieter-Limit fuer gleichzeitige Cloud-Downloads. Google Drive und MEGA
  // bewusst niedriger: JEDES gleichzeitig laufende Drive-Item startet einen
  // eigenen Bridge-Prozess, der INTERN nochmal bis zu 6 parallele Google-
  // Anfragen macht (SemaphoreSlim(6) in BuildGoogleDriveFolderTreeAsync) - bei
  // Limit 4 waren das bis zu 24 gleichzeitige anonyme Anfragen an Drive. Google
  // drosselt anonyme Zugriffe nachweislich (Server-Logs, siehe HANDOFF), und
  // gedrosselte Antworten kommen als HTML-Interstitial zurueck, was Dateien
  // sowohl beim Groessen-Scan als auch beim Download verschluckt. Mehr
  // Parallelitaet macht Drive hier also nicht schneller, sondern langsamer und
  // unzuverlaessiger. 2 entspricht dem urspruenglichen Konzept.
  // Zurueck auf 4 - den Wert aus der Phase, die der Nutzer als "voll
  // funktionstuechtig" erinnert.
  //
  // Die Absenkung auf 2 (Runde 22) bzw. 3 (Runde 23) beruhte auf der Annahme
  // "mehr Parallelitaet = mehr Rate-Limit". Die Log-Auswertung der 29. Runde
  // widerlegt das als HAUPTursache: entscheidend ist nicht, wie viele Ordner
  // gleichzeitig laufen, sondern WELCHEN WEG sie nehmen. Ueber den ZIP-Export
  // kostet ein Ordner genau EINEN Request (da ist Parallelitaet harmlos), ueber
  // den Datei-fuer-Datei-Fallback dagegen einen pro Datei - und genau dieser
  // Fallback wird seit dieser Runde bridge-seitig systemweit serialisiert
  // (DriveFallbackMutexName in CommandHandlers.cs), also dort begrenzt, wo die
  // Begrenzung tatsaechlich hingehoert. Ein Extension-Limit kann das ohnehin
  // nicht leisten: jede Verbindung ist ein eigener Prozess.
  const CLOUD_POOL_LIMITS = { drive: 4, mega: 4 };
  function getCloudPool(url) {
    const key = cloudProviderKey(url);
    if (!cloudPools.has(key)) cloudPools.set(key, createPool(CLOUD_POOL_LIMITS[key] || 4));
    return cloudPools.get(key);
  }

  // ---------- Ordnername fuer einen Cloud-Link ----------
  //
  // Gewuenscht (und frueher, als es nur Google Drive gab, auch so):
  //   <Post>/Download Files/<Name des Links beim Creator>/<Dateien>
  // Zwischenzeitlich wurde daraus der ANBIETER als Ordnername ("Google Drive",
  // "Dropbox"). Das ist nicht nur weniger sprechend, es wirft bei mehreren
  // Links DESSELBEN Anbieters auch noch alle Dateien in EINEN Topf: der Post
  // mit den Links "Conifer Trees" und "Beech Trees" (beide Google Drive) landete
  // komplett vermischt in einem Ordner "Google Drive".
  // Jetzt: sichtbarer Linktext (content.js -> file.linkLabel), Rueckfall auf den
  // Anbieternamen, wenn der Creator nur die nackte URL gepostet hat.
  // Namensgleichheit innerhalb eines Posts wird durchnummeriert, damit zwei
  // gleich benannte Links nicht wieder im selben Ordner landen.
  const cloudFolderClaims = new Map(); // `${postFolder}::${name}` -> url
  function cloudLinkFolderName(postFolder, file, providerFallback) {
    const fallback = providerFallback || "External Files";
    const raw = (file.linkLabel || "").trim();
    // sanitizeForPath() ist die bestehende Ordner-/Dateinamen-Bereinigung
    // (verbotene Zeichen, Laengenbegrenzung) - bewusst wiederverwendet.
    let base = raw ? sanitizeForPath(raw, fallback) : fallback;
    if (!base) base = fallback;
    const keyOf = (n) => `${postFolder}::${n.toLowerCase()}`;
    const taken = (n) => {
      const owner = cloudFolderClaims.get(keyOf(n));
      return owner !== undefined && owner !== file.url;
    };
    if (taken(base)) {
      let i = 2;
      while (taken(`${base} (${i})`)) i++;
      base = `${base} (${i})`;
    }
    cloudFolderClaims.set(keyOf(base), file.url);
    return base;
  }

  const usedPaths = new Set();
  function getUniquePathParts(postFolder, subfolder, baseName, ext) {
    let suffix = 0;
    let name = `${baseName}${ext}`;
    const subParts = Array.isArray(subfolder) ? subfolder : (subfolder ? [subfolder] : []);
    const buildParts = (n) => [postFolder, ...subParts, n];
    let path = buildParts(name).join("/");
    while (usedPaths.has(path)) {
      suffix++;
      name = `${baseName}_${suffix}${ext}`;
      path = buildParts(name).join("/");
    }
    usedPaths.add(path);
    return { name, pathParts: buildParts(name) };
  }

  // Schritt-Zaehler (Description, Comments, Thumbnail, Video, je Datei) - treibt
  // NUR noch die angezeigte "X von Y Items"-Zahl, NICHT mehr die Prozentzahl der
  // Primary-Bar (siehe weightDone/totalWeight weiter unten). Ein Post mit 9 kleinen
  // Text-/Thumbnail-Schritten und 2 riesigen Videos/Cloud-Ordnern zeigt sonst
  // faelschlich "9/11 fast fertig", obwohl der grosse Rest der Datenmenge noch
  // aussteht.
  const plan = planDownloadSteps(items, settings, options);
  const totalSteps = plan.totalSteps;
  const realFiles = plan.realFiles;
  let totalWeight = plan.totalWeight;

  // EINZIGE Stelle, an der eine Gewichts-SCHAETZUNG durch die echte Groesse
  // ersetzt wird. Vorher stand diese Rechnung in vier leicht unterschiedlichen
  // Kopien verstreut (Cloud-Ordner-Wrapper, OneDrive, yt-dlp-Embed, Vorab-Scan)
  // und fehlte bei Thumbnail/nativem Video komplett - dadurch blieb totalWeight
  // (und damit die "X / Y GB"-Anzeige der Ecke UND die Est.-Time) dauerhaft auf
  // den groben SIZE_ESTIMATE-Werten haengen.
  //
  // Der aktuell in totalWeight steckende Beitrag eines Items lebt am Item selbst
  // (`__appliedWeight`, initial von planDownloadSteps() gesetzt), NICHT in einer
  // lokalen Variable des jeweiligen Download-Zweigs. Nur so koennen der
  // Hintergrund-Groessenscan (cloudSizeProbes) und der laufende Download
  // dieselbe Zahl korrigieren, ohne sich gegenseitig zu verrechnen (vorher
  // konnte beides unabhaengig `totalWeight - schaetzung + echt` rechnen und die
  // Schaetzung damit doppelt abziehen).
  function setItemWeight(itemObj, realBytes, fallbackCurrent) {
    const current =
      itemObj && itemObj.__appliedWeight != null ? itemObj.__appliedWeight : fallbackCurrent;
    if (!(realBytes > 0) || realBytes === current) return current;
    totalWeight = totalWeight - current + realBytes;
    if (itemObj) itemObj.__appliedWeight = realBytes;
    return realBytes;
  }

  // Cloud-Links (Drive/Dropbox/Mega) VORAB parallel groessen-scannen, nicht erst
  // wenn der jeweilige Link sequenziell an der Reihe ist - sonst wartet bei
  // mehreren Cloud-Links im selben Batch (z.B. zwei Drive-Ordner) der zweite
  // erst auf den kompletten Download des ersten, bevor er ueberhaupt mit dem
  // Scannen anfaengt. Laeuft im Hintergrund, blockiert Thumbnails/Description/
  // generische Dateien nicht. Sobald ein Scan fertig ist, wird totalWeight mit
  // der ECHTEN Groesse korrigiert (ersetzt die grobe Schaetzung) - dadurch wird
  // die Primary-Bar frueh genau, statt bis zum eigentlichen Download dieses
  // Items falsch zu bleiben.
  const cloudSizeProbes = new Map(); // file.url -> Promise<{totalBytes, fileCount}>
  if (bridgeConnected) {
    realFiles.forEach((it) => {
      const f = it.file;
      const isCloud = f && (f.isCloudLink || f.isWebsite || f.isExternalLink);
      if (!isCloud || !f.url || cloudSizeProbes.has(f.url)) return;
      // Nicht unterstuetzter Anbieter wird spaeter gar nicht heruntergeladen -
      // dann auch keine (fehlschlagende) Groessenabfrage dafuer starten.
      if (unsupportedProviderOf(f)) return;
      // GOOGLE-DRIVE-ORDNER bewusst NICHT vorab sondieren.
      //
      // Fuer einen Ordner ist "Groesse ermitteln" auf der Bridge-Seite kein
      // billiger HEAD-Request, sondern der KOMPLETTE rekursive Baum-Scan
      // (BuildGoogleDriveFolderTreeAsync: pro Unterordner eine HTML-Listing-
      // Anfrage, pro Datei 1-2 Anfragen nur fuer Content-Length). Genau denselben
      // Scan macht der eigentliche Download gleich darauf noch einmal - und weil
      // jede native-messaging-Verbindung einen EIGENEN Bridge-Prozess startet,
      // laufen beide Scans GLEICHZEITIG gegen dieselbe Ordner-ID. Der 10-Minuten-
      // Dateicache (patreon_archiver_drive_cache) wird erst NACH Abschluss des
      // ersten Scans geschrieben und greift deshalb genau dann nicht, wenn er
      // gebraucht wuerde. Ergebnis: doppelte Anfragezahl gegen einen Anbieter,
      // der anonyme Zugriffe nachweislich drosselt - der Scan wird dadurch nicht
      // schneller, sondern langsamer.
      // Kein Informationsverlust: JEDE url_progress-Meldung eines Ordner-
      // Downloads traegt bereits die endgueltige Gesamtgroesse (state.GrandTotal),
      // die Gewichtskorrektur passiert also ohnehin ueber setItemWeight() im
      // progressWrapper - nur wenige Sekunden spaeter.
      if (/drive\.google\.com/i.test(f.url) && /\/folders\//i.test(f.url)) return;
      // Bei Anbietern, deren rohe URL nur eine HTML-Freigabeseite ist (OneDrive,
      // MediaFire), muss erst die echte Direkt-Download-URL aufgeloest werden -
      // sonst wuerde hier nur die (kleine) Groesse der HTML-Seite gemessen.
      // Google Drive/MEGA bewusst NICHT hier aufloesen, siehe resolveBridgeDownloadUrl.
      const probe = resolveBridgeDownloadUrl(f.url).then((probeUrl) => getUrlSize(probeUrl)).then((result) => {
        if (result.totalBytes > 0) {
          f.__realSizeBytes = result.totalBytes;
          // Ueber setItemWeight(), NICHT mit einer eigenen Rechnung: sonst zieht
          // dieser Scan die Anfangsschaetzung ein zweites Mal ab, wenn der
          // laufende Download inzwischen schon selbst korrigiert hat.
          setItemWeight(f, result.totalBytes, f.sizeBytes || SIZE_ESTIMATE.CLOUD);
        }
        return result;
      });
      cloudSizeProbes.set(f.url, probe);
    });
  }

  let stepsDone = 0;
  let weightDone = 0;    // successful item weights only  → for x/y GB display
  let failedWeight = 0;  // failed item weights only
  function reportStep(label, advance = true, meta = {}) {
    if (advance) {
      stepsDone++;
      const itemWeight = meta.weight || SIZE_ESTIMATE.TEXT;
      if (meta.error) {
        failedWeight += itemWeight;
      } else {
        weightDone += itemWeight;
      }
    }
    // Bar uses ALL processed (success + fail) / rawTotal so it never
    // artificially reaches 100 before all steps complete.
    const processedWeight = weightDone + failedWeight;
    if (onStep) onStep(stepsDone, totalSteps, label, {
      ...meta,
      weightDone: processedWeight,   // for bar %
      successWeightDone: weightDone, // for x/y GB display
      totalWeight,                   // raw, never reduced
    });
  }

  function isCancelled() {
    return cancelSignal && cancelSignal.cancelled;
  }

  function absPath(creatorName, relPathParts) {
    const folder = sanitizeForPath(creatorName, "creator");
    return [bridgeBaseDir, folder, ...relPathParts].join("/").replace(/\\/g, "/");
  }

  async function placeUrl(creatorName, post, relPathParts, url, opts = {}) {
    if (asZip) {
      const blob = await fetchAsBlob(url, opts);
      const folder = sanitizeForPath(creatorName, "creator");
      zip.file([folder, ...relPathParts].join("/"), blob);
      return { ok: true };
    }
    if (useBridgePath) {
      return downloadToPathViaBridge(url, absPath(creatorName, relPathParts), opts);
    }
    if (useDirHandle) {
      const blob = await fetchAsBlob(url, opts);
      const folder = sanitizeForPath(creatorName, "creator");
      await writeBlobToDirectory(settings.dirHandle, [folder, ...relPathParts], blob);
      return { ok: true };
    }
    const folder = sanitizeForPath(creatorName, "creator");
    const relPath = subfolderName
      ? `${subfolderName}/${folder}/${relPathParts.join("/")}`
      : `${folder}/${relPathParts.join("/")}`;
    return downloadViaChromeApi(url, relPath, opts);
  }

  async function placeText(creatorName, post, relPathParts, text) {
    if (asZip) {
      const folder = sanitizeForPath(creatorName, "creator");
      zip.file([folder, ...relPathParts].join("/"), textBlob(text));
      return;
    }
    if (useBridgePath) {
      await writeFileViaBridge(absPath(creatorName, relPathParts), textBlob(text));
      return;
    }
    if (useDirHandle) {
      const folder = sanitizeForPath(creatorName, "creator");
      await writeBlobToDirectory(settings.dirHandle, [folder, ...relPathParts], textBlob(text));
      return;
    }
    const folder = sanitizeForPath(creatorName, "creator");
    const relPath = subfolderName
      ? `${subfolderName}/${folder}/${relPathParts.join("/")}`
      : `${folder}/${relPathParts.join("/")}`;
    const objectUrl = URL.createObjectURL(textBlob(text));
    await downloadTextViaChromeApi(objectUrl, relPath);
    setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
  }

  // Gibt dem Fortschrittsbalken nach einem abgeschlossenen Schritt 200ms Zeit,
  // den 100%-Zustand anzuzeigen, bevor der nächste Schritt die Bar zurücksetzen kann.
  // (Ohne diese Pause: done→next-start passiert synchron im selben JS-Tick,
  // der Animation-Loop bekommt nie eine Chance, 100% zu rendern.)
  function stepPause(ms = 200) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function withRetryUrl(url, post, file, action) {
    try {
      return await action(url);
    } catch (err) {
      const freshUrl = await refreshFileUrl(post, file).catch(() => null);
      if (freshUrl && freshUrl !== url) return await action(freshUrl);
      throw err;
    }
  }

  // Helper zur Existenzprüfung von Dateien vor dem eigentlichen Download
  async function alreadyExists(creatorName, subPathParts, fileObj = null) {
    if (settings.skipExistingFiles === false || forceOverwrite || asZip) return false;
    if (fileObj && fileObj.downloaded) return true;
    if (useBridgePath) {
      return await checkFileExistsViaBridge(absPath(creatorName, subPathParts));
    } else if (useDirHandle) {
      try {
        let dir = settings.dirHandle;
        const folder = sanitizeForPath(creatorName, "creator");
        for (const part of [folder, ...subPathParts.slice(0, -1)]) {
          dir = await dir.getDirectoryHandle(part, { create: false });
        }
        await dir.getFileHandle(subPathParts[subPathParts.length - 1], { create: false });
        return true;
      } catch { return false; }
    }
    return false;
  }

  // ---- Post-Extras (Thumbnail/Description/Comments/Video/_download_links.txt) ----
  // Jeder Teil ist EIGENSTAENDIG pro Post memoisiert (nicht mehr ein einziges
  // "postsAlreadyBundled"-Flag fuer alles zusammen) und laeuft durch seinen
  // eigenen Concurrency-Pool - egal welches Item (Thumbnail-Zeile, Video-Zeile
  // oder eine normale Datei-Zeile) den Post zuerst beruehrt. Dadurch blockiert
  // z.B. ein grosses Video nicht mehr das Thumbnail (oder umgekehrt) desselben
  // Posts, und ein normales Datei-Item muss nicht mehr auf beides warten,
  // bevor sein eigener Download ueberhaupt anfaengt (siehe triggerPostExtras
  // weiter unten - wird bewusst NICHT awaited).
  const linksTxtPromises = new Map();
  const thumbnailPromises = new Map();
  const descriptionPromises = new Map();
  const commentsPromises = new Map();
  const videoPromises = new Map();

  // Nutzt bewusst dieselbe Funktion wie planDownloadSteps() oben - Zaehler und
  // Nenner der Fortschrittsanzeige duerfen NIE aus zwei verschiedenen
  // Auswahl-Definitionen stammen.
  function getPostContext(post) {
    const flags = postSelectionFlags(items, post, options);
    return { postFolder: buildPostFolderName(post, naming), ...flags };
  }

  // _download_links.txt nur erzeugen, wenn es tatsaechlich etwas Externes zu
  // dokumentieren gibt (externes Embed-Video ODER mindestens ein als Cloud-
  // Link/Website/External markiertes File) - vorher reichte "post.files.length > 0"
  // alleine, wodurch auch Posts OHNE jeden externen Link einen "Download Files"-
  // Ordner mit einer (leeren/nutzlosen) _download_links.txt bekamen, sobald
  // irgendein ganz normales, direkt heruntergeladenes Attachment vorhanden war.
  function ensureLinksTxt(creatorName, post) {
    const postId = String(post.id);
    if (linksTxtPromises.has(postId)) return linksTxtPromises.get(postId);
    const ctx = getPostContext(post);
    const hasEmbedVideo = !!(post.video && post.video.type === "embed" && post.video.url);
    // Echte externe DATEI-Links (Cloud/Website) - nur die fuellen den
    // "Download Files"-Ordner ueberhaupt mit Inhalt.
    const hasExternalFiles = (post.files || []).some((f) => f.isCloudLink || f.isWebsite || f.isExternalLink);
    const hasExternalContent = hasEmbedVideo || hasExternalFiles;
    const p = (async () => {
      if (!(hasExternalContent && (ctx.isFullPost || ctx.hasFileDownloads))) return;
      try {
        const linksTxtContent = generateDownloadLinksTxt(post);
        // Ort der Datei haengt davon ab, ob es ueberhaupt externe DATEIEN gibt:
        // Bei einem Post, dessen einzige externe Sache ein eingebettetes Video
        // ist (YouTube/Vimeo), wurde bisher trotzdem ein Unterordner
        // "Download Files" angelegt, in dem dann NUR diese Link-Textdatei lag -
        // ein Ordner ohne jede Download-Datei, genau wie vom Nutzer gemeldet.
        // Das Video selbst landet ueber yt-dlp direkt im Post-Ordner, nicht dort.
        // Deshalb: ohne externe Dateien liegt die Linkliste direkt im Post-Ordner
        // (neben description.txt), mit externen Dateien bleibt sie wie bisher
        // beim Rest der Downloads.
        const linksPath = hasExternalFiles
          ? [ctx.postFolder, "Download Files", "_download_links.txt"]
          : [ctx.postFolder, "_download_links.txt"];
        await placeText(creatorName, post, linksPath, linksTxtContent);
      } catch (err) {
        /* best-effort */
      }
    })();
    linksTxtPromises.set(postId, p);
    return p;
  }

  function ensureThumbnail(creatorName, post, cancelSignal) {
    const postId = String(post.id);
    if (thumbnailPromises.has(postId)) return thumbnailPromises.get(postId);
    const ctx = getPostContext(post);
    const applicable = settings.includeThumbnails !== false && !!post.thumbnail?.url && (ctx.isFullPost || ctx.wantsThumbnail);
    const p = applicable
      ? imagePool.run(() => doThumbnail(creatorName, post, cancelSignal, ctx))
      : Promise.resolve({ skipped: false });
    thumbnailPromises.set(postId, p);
    return p;
  }

  async function doThumbnail(creatorName, post, cancelSignal, ctx) {
    reportStep(`${post.title} · Thumbnail`, false, { postId: post.id, itemKind: "thumbnail", url: post.thumbnail.url }); // Start-Signal: Sub-Bar auf 0%
    const thumbBase = `${sanitizeForPath(post.title, "thumbnail")} - Thumbnail`;
    const { name: thumbFileName, pathParts: thumbPathParts } = getUniquePathParts(ctx.postFolder, null, thumbBase, ".jpg");
    // let statt const: sobald der erste echte Byte-Tick die tatsaechliche
    // Groesse mitbringt, wird die 2-MB-Schaetzung ersetzt (vorher blieb sie bis
    // zum Schluss stehen und verfaelschte Gesamtgroesse/ETA der Ecke-Anzeige).
    let thumbWeight = post.thumbnail.__appliedWeight || post.thumbnail.sizeBytes || SIZE_ESTIMATE.THUMBNAIL;
    // Echte Byte-Fortschrittsanzeige (% + MB zusammen, wie bei generischen
    // Dateien/Cloud-Downloads) statt des bisherigen reinen 0%->100%-Sprungs ohne
    // jede Zwischenanzeige - Thumbnails liefen bisher NIE durch onProgress.
    const thumbProgressWrapper = onProgress
      ? (p) => {
          thumbWeight = setItemWeight(post.thumbnail, p?.total, thumbWeight);
          onProgress(weightDone, totalWeight, { ...p, filename: thumbFileName, itemWeight: thumbWeight, postId: post.id, itemKind: "thumbnail", url: post.thumbnail.url });
        }
      : null;
    if (await alreadyExists(creatorName, thumbPathParts)) {
      extraResults.push({ url: post.thumbnail.url, ok: true, skipped: true });
      reportStep(`${post.title} · Thumbnail (skipped)`, true, { weight: thumbWeight, postId: post.id, itemKind: "thumbnail", url: post.thumbnail.url });
      await stepPause();
      return { skipped: true };
    }
    try {
      // Thumbnails: wrap in a 20s timeout to prevent the entire download from
      // hanging if the CDN URL has expired or the tab fetch stalls.
      const thumbPromise = withRetryUrl(post.thumbnail.url, post, { role: "thumbnail" }, (u) =>
        placeUrl(creatorName, post, thumbPathParts, u, { cancelSignal, onProgress: thumbProgressWrapper })
      );
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error("Thumbnail download timed out after 20s")), 20000)
      );
      await Promise.race([thumbPromise, timeoutPromise]);
      extraResults.push({ url: post.thumbnail.url, ok: true });
    } catch (err) {
      /* not fatal – log and move on */
      extraResults.push({ url: post.thumbnail.url, ok: false, error: err.message });
    }
    reportStep(`${post.title} · Thumbnail (done)`, true, { weight: thumbWeight, postId: post.id, itemKind: "thumbnail", url: post.thumbnail.url });
    await stepPause();
    return { skipped: false };
  }

  function ensureDescription(creatorName, post, cancelSignal) {
    const postId = String(post.id);
    if (descriptionPromises.has(postId)) return descriptionPromises.get(postId);
    const ctx = getPostContext(post);
    const applicable = settings.includeDescription !== false && (ctx.isFullPost || ctx.wantsDescription);
    const p = applicable
      ? genericPool.run(() => doDescription(creatorName, post, cancelSignal, ctx))
      : Promise.resolve({ skipped: false });
    descriptionPromises.set(postId, p);
    return p;
  }

  async function doDescription(creatorName, post, cancelSignal, ctx) {
    const rowUrl = `${post.id}::description`;
    // Wird gesetzt, sobald der tatsaechliche Textinhalt geschrieben wurde -
    // zeigt danach die echte Dateigroesse an derselben Stelle an, an der
    // Thumbnail/Video/Dateien ihre (vorab bekannte) Groesse zeigen.
    let writtenBytes = null;
    // true, sobald feststeht, dass es keinen echten Beschreibungstext gibt -
    // kein description.txt wird dann angelegt (siehe unten). Ausserhalb des
    // try-Blocks deklariert, damit der finale return-Wert darauf zugreifen kann.
    let noDescription = false;
    // phase:"working" statt eines echten Prozentwerts - Description/Comments
    // schreiben nur eine Textdatei (evtl. mit einem kurzen API-Refetch davor),
    // es gibt keine sinnvolle Byte-fuer-Byte-Fortschrittszahl dafuer. Die Zeile
    // zeigt stattdessen denselben "arbeitet, Dauer unbekannt"-Puls wie beim
    // Cloud-Groessen-Scan, statt bei 0% haengen zu bleiben.
    reportStep(`${post.title} · Description`, false, { postId: post.id, itemKind: "description", url: rowUrl, phase: "working" }); // Start-Signal: Sub-Bar auf 0%
    const descBase = `${sanitizeForPath(post.title, "description")} - Description`;
    const { name: descFileName, pathParts: descPathParts } = getUniquePathParts(ctx.postFolder, null, descBase, ".txt");
    if (await alreadyExists(creatorName, descPathParts)) {
      extraResults.push({ url: `${post.id}-description`, ok: true, skipped: true });
      // `empty: true` heisst hier "kein Byte-Wert ermittelbar" (die Datei liegt
      // schon auf Platte, ihre Groesse kennen wir nicht) - die Zeile zeigt dann
      // "-" in der Groessenspalte statt sie leer und damit unerklaerlich zu
      // lassen (siehe updateRowUI() in dashboard.js).
      reportStep(`${post.title} · Description (skipped)`, true, { postId: post.id, itemKind: "description", url: rowUrl, empty: true });
      await stepPause();
      return { skipped: true };
    }
    try {
      // Re-fetch the raw post if the stored text is empty – Patreon sometimes
      // withholds content at scan time but serves it fine at download time.
      let descText = post.text && post.text.trim() ? post.text : "";
      let htmlContent = "";
      if (!descText) {
        try {
          const numericId = String(post.id).replace(/^post_/, "");
          const raw = await refetchPostRaw(numericId);
          htmlContent = raw?.data?.attributes?.content || "";
          const teaserText = raw?.data?.attributes?.teaser_text || "";
          if (htmlContent) {
            // Strip HTML: service worker has no DOM, so use regex fallback
            descText = htmlContent
              .replace(/<br\s*\/?>/gi, "\n")
              .replace(/<\/p>/gi, "\n")
              .replace(/<[^>]+>/g, "")
              .replace(/&amp;/g, "&")
              .replace(/&lt;/g, "<")
              .replace(/&gt;/g, ">")
              .replace(/&quot;/g, '"')
              .replace(/&#39;/g, "'")
              .replace(/&nbsp;/g, " ")
              .trim();
          } else if (teaserText) {
            descText = teaserText.trim();
          }
        } catch { /* best-effort */ }
      }
      if (descText) {
        const descFinalText = buildDescriptionFileText(post, descText);
        writtenBytes = textBlob(descFinalText).size;
        await placeText(creatorName, post, [ctx.postFolder, descFileName], descFinalText);
      }

      // Cloud-Links extrahieren (Google Drive, Dropbox, OneDrive, MediaFire,
      // PixelDrain, MEGA, WeTransfer). Auto-Download wird nur fuer die Anbieter
      // versucht, fuer die resolveDirectDownloadUrl() eine echte Aufloesung kennt
      // (cloudDownloader.js) - bewusst NICHT WeTransfer (Token-basierte API,
      // Links laufen schnell ab, zu unzuverlaessig) und NICHT MEGA im Fliesstext
      // (kein sinnvoller Einzeldatei-Kontext hier, MEGA-Links funktionieren aber
      // regulaer ueber eine ausgewaehlte Datei-Zeile).
      const cloudPattern = /https?:\/\/(?:www\.)?(?:drive\.google\.com|dropbox\.com|mega\.nz|mega\.io|mediafire\.com|we\.tl|wetransfer\.com|pixeldrain\.com|onedrive\.live\.com|1drv\.ms)\/[^\s"''<>\\]+/gi;
      const foundLinks = new Set();
      if (htmlContent) {
        let m;
        while ((m = cloudPattern.exec(htmlContent)) !== null) {
          foundLinks.add(m[0]);
        }
      }
      if (descText) {
        let m;
        while ((m = cloudPattern.exec(descText)) !== null) {
          foundLinks.add(m[0]);
        }
      }

      if (foundLinks.size > 0) {
        for (const origUrl of foundLinks) {
          if (isCancelled()) break;
          const url = cleanCloudLink(origUrl);
          // MEGA bewusst nicht in dieser Liste (kein sinnvoller Einzeldatei-
          // Kontext im Fliesstext-Scan, funktioniert aber regulaer ueber eine
          // ausgewaehlte Datei-Zeile). WeTransfer ueber die reverse-engineered
          // API in background.js abgedeckt. OneDrive NICHT in dieser Liste -
          // der neue Download+Verschieben-Ablauf (downloadOneDriveFile())
          // braucht einen bekannten Ziel-Dateipfad, den es hier im generischen
          // Text-Link-Scan (der nur placeUrl() mit einer URL aufruft) nicht
          // gibt. Funktioniert weiterhin regulaer ueber eine ausgewaehlte
          // Datei-Zeile.
          const isAutoDownloadable = /drive\.google\.com|dropbox\.com|mediafire\.com|pixeldrain\.com|wetransfer\.com|we\.tl/i.test(url);
          if (!isAutoDownloadable) continue;
          const providerKey = cloudProviderKey(url);
          const providerLabel = CLOUD_PROVIDER_LABELS[providerKey] || "Cloud";
          try {
            reportStep(`${post.title} · Resolving Cloud (${providerLabel})`, false);
            // Im Bridge-Modus muss ein Google-Drive-Link ROH bleiben (siehe
            // resolveBridgeDownloadUrlWithName()-Kommentar) - CommandHandlers.cs
            // faengt die Domain selbst ab. Ausserhalb des Bridge-Modus (chrome.downloads/
            // FS-Handle) macht die Bridge das nicht, dort wird die aufgeloeste
            // Direkt-URL tatsaechlich gebraucht.
            const { url: directUrl, filename: resolvedName } = useBridgePath
              ? await resolveBridgeDownloadUrlWithName(url)
              : await resolveDirectDownloadUrlWithName(url);
            const cloudName = resolvedName || getFilenameFromCloudUrl(origUrl, `${providerKey}_download`);
            reportStep(`${post.title} · Cloud (${providerLabel}: ${cloudName.slice(0, 25)})`, false);
            await placeUrl(creatorName, post, [ctx.postFolder, "Cloud Downloads", cloudName], directUrl, { cancelSignal });
          } catch (err) {
            console.warn(`[Cloud-Downloader] Failed ${providerLabel} download ${origUrl}:`, err);
          }
        }
      }
      noDescription = !descText;
      extraResults.push({ url: `${post.id}-description`, ok: true, skipped: noDescription });
    } catch (err) {
      /* not fatal */
      extraResults.push({ url: `${post.id}-description`, ok: false, error: err.message });
    }
    // sizeBytes fehlt genau dann, wenn nichts geschrieben wurde (kein
    // Beschreibungstext vorhanden) - das per `empty` explizit melden, sonst
    // bleibt die Groessenspalte der Zeile ohne erkennbaren Grund leer.
    reportStep(`${post.title} · Description (done)`, true, { postId: post.id, itemKind: "description", url: rowUrl, sizeBytes: writtenBytes, empty: !(writtenBytes > 0) });
    await stepPause();
    return { skipped: noDescription };
  }

  function ensureComments(creatorName, post, cancelSignal) {
    const postId = String(post.id);
    if (commentsPromises.has(postId)) return commentsPromises.get(postId);
    const ctx = getPostContext(post);
    const applicable = settings.includeComments !== false && (ctx.isFullPost || ctx.wantsComments);
    const p = applicable
      ? genericPool.run(() => doComments(creatorName, post, cancelSignal, ctx))
      : Promise.resolve({ skipped: false });
    commentsPromises.set(postId, p);
    return p;
  }

  async function doComments(creatorName, post, cancelSignal, ctx) {
    const rowUrl = `${post.id}::comments`;
    // Wird gesetzt, sobald der tatsaechliche Textinhalt geschrieben wurde -
    // siehe Kommentar bei writtenBytes in doDescription() weiter oben.
    let writtenBytes = null;
    // true, sobald feststeht, dass es keine echten Kommentare gibt - kein
    // comments.txt wird dann angelegt (siehe unten). Ausserhalb des try-Blocks
    // deklariert, damit der finale return-Wert auch bei einem Fehler zugreifbar ist.
    let noComments = false;
    // phase:"working" - siehe Kommentar in doDescription() weiter oben.
    reportStep(`${post.title} · Comments`, false, { postId: post.id, itemKind: "comments", url: rowUrl, phase: "working" }); // Start-Signal: Sub-Bar auf 0%
    const commBase = `${sanitizeForPath(post.title, "comments")} - Comments`;
    const { name: commFileName, pathParts: commPathParts } = getUniquePathParts(ctx.postFolder, null, commBase, ".txt");
    if (await alreadyExists(creatorName, commPathParts)) {
      extraResults.push({ url: `${post.id}-comments`, ok: true, skipped: true });
      // `empty: true` - siehe Kommentar im gleichen Zweig von doDescription().
      reportStep(`${post.title} · Comments (skipped)`, true, { postId: post.id, itemKind: "comments", url: rowUrl, empty: true });
      await stepPause();
      return { skipped: true };
    }
    try {
      const numericId = String(post.id).replace(/^post_/, "");
      const comments = await fetchCommentsRaw(numericId);
      const text = formatCommentsText(post, comments);
      noComments = !text;
      if (text) {
        writtenBytes = textBlob(text).size;
        await placeText(creatorName, post, commPathParts, text);
      }
      extraResults.push({ url: `${post.id}-comments`, ok: true, skipped: noComments });
    } catch (err) {
      /* not fatal - comments endpoint may be unavailable */
      extraResults.push({ url: `${post.id}-comments`, ok: false, error: err.message });
    }
    // sizeBytes fehlt genau dann, wenn nichts geschrieben wurde: keine
    // Kommentare vorhanden ODER der Kommentar-Endpunkt hat nichts geliefert
    // (fetchCommentsRaw() gibt bei jedem Fehler bewusst [] zurueck). Genau
    // dieser Fall trat beim Nutzer auf ("Groesse fehlt, bisher nur bei
    // Comments") - jetzt explizit als "kein Inhalt" gemeldet statt still leer.
    reportStep(`${post.title} · Comments (done)`, true, { postId: post.id, itemKind: "comments", url: rowUrl, sizeBytes: writtenBytes, empty: !(writtenBytes > 0) });
    await stepPause();
    return { skipped: noComments };
  }

  function ensureVideo(creatorName, post, cancelSignal) {
    const postId = String(post.id);
    if (videoPromises.has(postId)) return videoPromises.get(postId);
    const ctx = getPostContext(post);
    const applicable = !!post.video && (ctx.isFullPost || ctx.wantsVideo);
    const p = applicable
      ? videoPool.run(() => doVideo(creatorName, post, cancelSignal, ctx))
      : Promise.resolve({ videoSkipped: false });
    videoPromises.set(postId, p);
    return p;
  }

  // Erlaubt es, ein Video als "bereits erledigt/uebersprungen" zu markieren,
  // OHNE es tatsaechlich auszufuehren - genutzt von der grosse-Datei-
  // Bestaetigung ("skip") in der Hauptschleife weiter unten, damit andere
  // Items desselben Posts (die ebenfalls ensureVideo() aufrufen wuerden) den
  // Video-Download nicht doch noch anstossen.
  function markVideoSkipped(postId) {
    videoPromises.set(String(postId), Promise.resolve({ videoSkipped: true }));
  }

  async function doVideo(creatorName, post, cancelSignal, ctx) {
    const { postFolder } = ctx;
    // let statt const: fuer Embed-Videos wird dieser Wert korrigiert, sobald
    // yt-dlp eine echte Stream-Groesse meldet (siehe applyProgress() unten) -
    // verbessert sowohl die Zeilen-MB/GB-Anzeige als auch die globale Est.-Time.
    let videoWeight = (post.video && (post.video.__appliedWeight || post.video.sizeBytes)) || SIZE_ESTIMATE.VIDEO;
    if (post.video.type === "native" && post.video.url) {
      const ext = extFor(post.video.filename, post.video.mimetype, ".mp4");
      const videoBase = sanitizeForPath(post.title, "video");
      const { name: videoFileName, pathParts: videoPathParts } = getUniquePathParts(postFolder, null, videoBase, ext);
      if (await alreadyExists(creatorName, videoPathParts)) {
        extraResults.push({ url: post.video.url, ok: true, skipped: true });
        reportStep(`${post.title} · Video (skipped)`, true, { weight: videoWeight, postId: post.id, itemKind: "video", url: post.video.url });
        await stepPause();
        return { videoSkipped: true };
      }
      try {
        // Sofort "Scanning..." anzeigen, waehrend HTTP-Header/Verbindung aufgebaut werden
        reportStep(`${post.title} · Video`, false, { postId: post.id, itemKind: "video", url: post.video.url, phase: "working" });
        // Native Videos sind oft die groessten Downloads eines Posts - hatten
        // bisher trotzdem NIE echten Byte-Fortschritt (nur 0%->100%-Sprung).
        const nativeVideoProgressWrapper = onProgress
          ? (p) => {
              // Auch hier die Schaetzung (250 MB) durch die echte Groesse
              // ersetzen, sobald die Bridge sie meldet - fehlte bisher komplett.
              videoWeight = setItemWeight(post.video, p?.total, videoWeight);
              onProgress(weightDone, totalWeight, { ...p, filename: videoFileName, itemWeight: videoWeight, postId: post.id, itemKind: "video", url: post.video.url });
            }
          : null;
        await placeUrl(creatorName, post, videoPathParts, post.video.url, { cancelSignal, onProgress: nativeVideoProgressWrapper });
        extraResults.push({ url: post.video.url, ok: true });
      } catch (err) {
        extraResults.push({ url: post.video.url, ok: false, error: err.message });
      }
      reportStep(`${post.title} · Video (done)`, true, { weight: videoWeight, postId: post.id, itemKind: "video", url: post.video.url });
      await stepPause();
      return { videoSkipped: false };
    } else if (post.video.type === "embed" && post.video.url) {
      let handledByBridge = false;
      let videoSkippedResult = false;
      let wasCancelled = false;
      // Genau EIN advance=true pro Video-Item - egal ueber welchen der drei
      // moeglichen Ausgaenge (schon vorhanden / yt-dlp meldet "already
      // downloaded" / regulaerer Abschluss) es geht. Vorher war der Abschluss
      // hart auf `handledByBridge` verdrahtet: ein FEHLGESCHLAGENER yt-dlp-Lauf
      // setzt handledByBridge ebenfalls true, wurde damit NIE gezaehlt - der
      // Schritt-Zaehler blieb dauerhaft unter totalSteps und das eingeplante
      // Video-Gewicht (250 MB Schaetzung) nie verbucht, wodurch die Ecke-Bar
      // rechnerisch gar nicht 100% erreichen konnte.
      let stepCounted = false;
      // Echter Fehlschlag des yt-dlp-Laufs (kein Abbruch, kein Link-Fallback) -
      // wurde vorher gar nicht nach aussen gemeldet, weshalb ein
      // fehlgeschlagenes Video im Ergebnis als "ok" durchging (gruene Zeile).
      let embedError = null;
      // Nur gesetzt, wenn yt-dlp waehrend des Downloads eine ECHTE Stream-
      // Groesse gemeldet hat (siehe applyProgress() unten) - videoWeight allein
      // reicht nicht als Kriterium, weil es auch die grobe SIZE_ESTIMATE.VIDEO-
      // Schaetzung sein kann. Verhindert, dass nach Abschluss eine falsche
      // Schaetz-Groesse als "das ist die tatsaechliche Dateigroesse" angezeigt wird.
      let knownVideoBytes = null;
      reportStep(`${post.title} · Video`, false, { isVideoPhase: true, currentStepWeight: videoWeight, postId: post.id, itemKind: "embed", url: post.video.url, phase: "working" });
      if (bridgeConnected && pingResult.ytdlpFound) {
        const outputDir = useBridgePath ? absPath(creatorName, [postFolder]) : null;
        const videoBaseName = sanitizeForPath(post.title, "video");
        const filenameTemplate = outputDir
          ? `${videoBaseName}.%(ext)s`
          : `${sanitizeForPath(creatorName, "creator")}/${postFolder}/${videoBaseName}.%(ext)s`;
        const ytdlpFormat = buildYtdlpFormat(settings.videoQuality);
        const isAudioOnly = settings.videoQuality === "audio";
        console.log("[PA ytdlp] calling downloadViaYtDlp", { url: post.video.url, outputDir });

        // Pre-Check ob Datei schon existiert - bei "Download again" (forceOverwrite)
        // bewusst uebersprungen, sonst erkennt der Check die eigene, beim ersten
        // Mal heruntergeladene Datei und ueberspringt den erneuten Download.
        const existingFile = forceOverwrite ? null : await findExistingVideoFile({
          creatorName,
          postFolder,
          videoBaseName,
          isAudioOnly,
          settings,
          bridgeConnected,
          bridgeBaseDir,
          useBridgePath,
          useDirHandle
        });

        if (existingFile) {
          reportStep(`${post.title} · Video (skipped)`, true, { isVideoPhase: false, weight: videoWeight, postId: post.id, itemKind: "embed", url: post.video.url });
          stepCounted = true;
          embedResults.push({ title: post.title, url: post.video.url, ok: true, skipped: true });
          videoSkippedResult = true;
          handledByBridge = true;
        } else { // eslint-disable-next-line no-lone-blocks
          const feedProgress = createVideoProgressTracker(isAudioOnly);
          let mergeTickInterval = null;

          function applyProgress(line) {
            if (line && (line.includes("No supported JavaScript runtime could be found") ||
                line.includes("n challenge solving failed") ||
                line.includes("Some formats have been skipped as they are missing a url") ||
                line.includes("HTTP Error 403") ||
                line.includes("Forbidden"))) {
              chrome.storage.local.set({ denoSuggestionNeeded: true });
            }

            const { pct, phaseLabel, speed, totalBytes } = feedProgress(line);
            if (phaseLabel === "Merging" && !mergeTickInterval) {
              mergeTickInterval = setInterval(() => applyProgress(null), 500);
            }

            // Sobald yt-dlp eine echte Groesse fuer den aktuellen Stream meldet,
            // das grobe SIZE_ESTIMATE.VIDEO-Schaetzgewicht korrigieren - analog
            // zur bestehenden Cloud-Download-Korrektur weiter oben. Verbessert
            // sowohl die Zeilen-MB/GB-Anzeige als auch die globale Est.-Time
            // (die auf totalWeight/weightDone basiert).
            videoWeight = setItemWeight(post.video, totalBytes, videoWeight);
            if (totalBytes > 0) knownVideoBytes = totalBytes;

            if (line && line.includes("has already been downloaded")) {
              // Zusaetzlich per stepCounted abgesichert: yt-dlp gibt diese Zeile
              // bei mehreren Streams (Video + Audio) auch MEHRFACH aus - ohne
              // die Klammer wuerde derselbe Schritt zwei Mal gezaehlt.
              if (!stepCounted) {
                reportStep(`${post.title} · Video (skipped)`, true, { isVideoPhase: false, weight: videoWeight, postId: post.id, itemKind: "embed", url: post.video.url });
                stepCounted = true;
              }
            } else if (onStep) {
              let extra = ` (${Math.round(pct)}%`;
              if (speed) extra += ` · ${speed}`;
              extra += ")";
              // Immer "Video" anzeigen, nicht "Video Track" / "Audio Track" / "Merging" –
              // der Nutzer sieht den Prozess als ein einziges Ganzes.
              reportStep(`${post.title} · Video${extra}`, false, { isVideoPhase: true, currentStepWeight: videoWeight, postId: post.id, itemKind: "embed", url: post.video.url, sizeBytes: totalBytes });
            }
          }

          try {
            // Deno-Empfehlungs-Flag für diesen Download-Versuch zurücksetzen
            await chrome.storage.local.set({ denoSuggestionNeeded: false });

            await downloadViaYtDlp(
              {
                url: post.video.url,
                outputDir,
                filenameTemplate,
                format: ytdlpFormat,
                cancelSignal,
                forceOverwrite: forceOverwrite || !settings.skipExistingFiles
              },
              applyProgress
            );
            embedResults.push({ title: post.title, url: post.video.url, ok: true, viaBridge: true });
            handledByBridge = true;
          } catch (err) {
            handledByBridge = true; // Bridge hat den Versuch gemacht, also kein Fallback-TXT schreiben
            if (err.message === "cancelled") {
              embedResults.push({ title: post.title, url: post.video.url, ok: false, cancelled: true, viaBridge: true });
              wasCancelled = true;
              // Nach einem Abbruch NICHTS zurueckliegen lassen (User-Vorgabe:
              // "dann soll einfach nichts davon in irgendeiner Art vorhanden
              // sein"). yt-dlp wird beim Verbindungsabbruch hart beendet und
              // kommt nicht mehr zu seinem eigenen Aufraeumen - seine
              // ".mp4.part"/".ytdl"/".f137.mp4"-Reste bleiben liegen. Der Host
              // ist zu diesem Zeitpunkt beendet, deshalb ueber eine NEUE
              // Verbindung aufraeumen. Eine bereits FERTIGE Datei wird dabei
              // bewusst nicht angefasst (siehe HandleCleanupPartial).
              if (outputDir) {
                try {
                  const res = await cleanupPartialViaBridge(outputDir, videoBaseName);
                  console.log(`[PA ytdlp] cancel cleanup: removed ${res?.removed ?? 0} leftover file(s) in ${outputDir}`);
                } catch (cleanupErr) {
                  console.warn("[PA ytdlp] cancel cleanup failed:", cleanupErr);
                }
              }
            } else {
              // Empfehlungs-Status prüfen
              const storage = await chrome.storage.local.get(["denoSuggestionNeeded", "denoSuggestionDismissed"]);
              const needsDeno = !!storage.denoSuggestionNeeded && !storage.denoSuggestionDismissed;
              embedError = err.message || "Video download failed";
              embedResults.push({
                title: post.title,
                url: post.video.url,
                ok: false,
                error: err.message,
                viaBridge: true,
                needsDeno: needsDeno
              });
            }
          } finally {
            if (mergeTickInterval) clearInterval(mergeTickInterval);
          }
        }
      }
      if (!handledByBridge) {
        const providerLabel = post.video.provider || "external";
        const text = `This video is externally embedded (${providerLabel}).\n\nWithout the bridge set up (see Settings / setup guide) the extension can't download it automatically. Link only:\n${post.video.url}\n`;
        try {
          const videoLinkFileName = `${sanitizeForPath(post.title, "video")} - Video-Link.txt`;
          await placeText(creatorName, post, [postFolder, videoLinkFileName], text);
        } catch (err) {
          /* not fatal */
        }
        embedResults.push({ title: post.title, url: post.video.url, ok: false, viaBridge: false });
      }
      // Genau EIN advance=true pro Video - gesteuert ueber stepCounted, NICHT
      // mehr ueber handledByBridge (das ist bei einem FEHLGESCHLAGENEN yt-dlp-
      // Lauf ebenfalls true und liess den Schritt komplett unter den Tisch
      // fallen). Das Label bestimmt zusaetzlich die Zeilenfarbe im Dashboard
      // (updateStepProgress erkennt "(cancelled)"/"(error)"/"(100%)").
      const finalLabel = wasCancelled
        ? `${post.title} · Video (cancelled)`
        : embedError
          ? `${post.title} · Video (error)`
          : `${post.title} · Video (100%)`;
      if (!stepCounted) {
        reportStep(finalLabel, true, { isVideoPhase: false, weight: videoWeight, postId: post.id, itemKind: "embed", url: post.video.url, sizeBytes: knownVideoBytes, error: !!embedError || wasCancelled });
        stepCounted = true;
      } else {
        // Schritt war bereits gezählt – nur Label-Update ohne Increment
        reportStep(finalLabel, false, { isVideoPhase: false, currentStepWeight: videoWeight, postId: post.id, itemKind: "embed", url: post.video.url, sizeBytes: knownVideoBytes, error: !!embedError || wasCancelled });
      }
      // Cancellation NICHT werfen (wuerde bei fire-and-forget ueber allTasks/
      // Promise.all sonst die ganze downloadItems()-Funktion zum Absturz
      // bringen) - stattdessen als Ergebnisfeld zurueckgeben, der Video-Item-
      // Handler in der Hauptschleife wertet "cancelled"/"error" selbst aus.
      return { videoSkipped: videoSkippedResult, cancelled: wasCancelled, error: embedError };
    }
    // post.video vorhanden, aber weder nativer noch eingebetteter Link nutzbar:
    // das Item wurde in planDownloadSteps() trotzdem eingeplant, also hier
    // einmal als "uebersprungen" verbuchen, sonst fehlt sein Gewicht dauerhaft
    // im Nenner und die Bar bleibt unter 100%.
    reportStep(`${post.title} · Video (skipped)`, true, { weight: videoWeight, postId: post.id, itemKind: post.video?.type === "embed" ? "embed" : "video", url: post.video?.url || `${post.id}::video` });
    return { videoSkipped: true };
  }

  // Von jedem Item eines Posts aufgerufen (Thumbnail-/Video-Zeile oder ein
  // normales Datei-Item), stoesst alle Teile eines Posts an - ist aber
  // bewusst NICHT async/awaited: ein normales Datei-Item soll nicht mehr
  // darauf warten muessen, dass z.B. das Video desselben Posts fertig ist,
  // bevor sein eigener (unabhaengiger) Download ueberhaupt anfaengt. Jeder
  // angestossene Teil landet in allTasks und wird dort am Ende der
  // Hauptschleife gemeinsam mit allen anderen Items abgewartet.
  const postExtrasTriggered = new Set();
  function triggerPostExtras(creatorName, post, cancelSignal, allTasksRef) {
    const postId = String(post.id);
    if (postExtrasTriggered.has(postId)) return;
    postExtrasTriggered.add(postId);
    allTasksRef.push(ensureLinksTxt(creatorName, post));
    allTasksRef.push(ensureDescription(creatorName, post, cancelSignal));
    allTasksRef.push(ensureComments(creatorName, post, cancelSignal));
    allTasksRef.push(ensureThumbnail(creatorName, post, cancelSignal));
    allTasksRef.push(ensureVideo(creatorName, post, cancelSignal));
  }

  let hasPerformedNetworkAction = false;

  // Kombiniertes Cancel-Signal aus Batch-weitem cancelSignal + (falls vom
  // Aufrufer bereitgestellt) einem PRO-ITEM-Signal - erlaubt es, genau EIN
  // aktives Item abzubrechen (Cancel-Button auf dieser Zeile), ohne die
  // anderen gleichzeitig laufenden Items zu beruehren. downloader.js kennt
  // fileKey()/UI-Zeilen nicht (bleibt UI-agnostisch) - der Aufrufer bekommt
  // stattdessen postId/url/kind und muss den passenden Schluessel selbst
  // errechnen (siehe dashboard.js, fileKey()).
  function itemCombinedSignal(post, file) {
    if (typeof options.getItemSignal !== "function") return cancelSignal;
    const itemSignal = options.getItemSignal({ postId: post.id, url: file?.url, kind: file?.kind || file?.role || "file" });
    if (!itemSignal) return cancelSignal;
    return {
      get cancelled() { return !!cancelSignal?.cancelled || !!itemSignal.cancelled; },
    };
  }

  // Ordnet jedem Item seinen Concurrency-Pool zu (siehe Pools weiter oben).
  //
  // WICHTIG: "Spezial"-Items (Thumbnail/Video/Description/Comments/Extras)
  // rufen INNERHALB von processItem() bereits ihre eigene ensureX()-Funktion
  // auf, die SELBST einen Slot aus imagePool/videoPool/genericPool belegt.
  // Wuerden sie HIER zusaetzlich ein zweites Mal outerseitig durch denselben
  // Pool gepoolt, haelt der aeussere Slot waehrend der GESAMTEN Downloadzeit
  // belegt, WAEHREND er auf einen inneren Slot DESSELBEN Pools wartet - bei
  // >= Pool-Limit gleichzeitigen Spezial-Items derselben Art (z.B. 4+ Posts
  // mit Thumbnail in einem "Download all filtered"-Batch, imagePool-Limit=4)
  // fuehrt das zu einem waschechten DEADLOCK: alle aeusseren Slots warten auf
  // innere Slots, die nie frei werden, weil alle inneren Slots von genau
  // diesen wartenden aeusseren Aufrufen blockiert sind. Deshalb: null = kein
  // aeusseres Pooling fuer diese Items, die Begrenzung passiert ausschliesslich
  // innerhalb der jeweiligen ensureX()-Aufrufe.
  function pickPoolForItem(file) {
    if (!file) return null;
    const isSpecialRole =
      file.role === "extras" ||
      file.role === "thumbnail" || file.kind === "thumbnail" ||
      file.role === "video" || file.kind === "video" || file.kind === "embed" ||
      file.role === "description" || file.kind === "description" ||
      file.role === "comments" || file.kind === "comments";
    if (isSpecialRole) return null;
    if (file.kind === "image") return imagePool;
    if (file.isWebsite || file.isCloudLink || file.isExternalLink) return getCloudPool(file.url);
    return genericPool;
  }

  const allTasks = [];

  async function processItem(i) {
    const { creatorName, post, file } = items[i];
    const requestId = `pa-${Date.now()}-${i}`;
    const itemSignal = itemCombinedSignal(post, file);

    if (itemSignal.cancelled) {
      results[i] = { url: file?.url, ok: false, error: "cancelled", cancelled: true };
      return;
    }

    // Sonderfall: Posts ohne Thumbnail/Video/Dateien (reiner Text-/Kommentar-Post)
    // haben nichts, was man einzeln "downloaden" könnte - hier geht es nur darum,
    // Beschreibung + Kommentare zu bündeln.
    if (file && file.role === "extras") {
      const extrasRowUrl = file.url || `${post.id}::extras`;
      // Start-Signal fuer die Zeile des Text-Posts (seit dieser Runde eine ganz
      // normale Zeile mit eigenem Balken). phase:"working", weil es hier keine
      // sinnvolle Byte-Prozentzahl gibt - dasselbe Muster wie Description/Comments.
      reportStep(`${post.title} · Description & comments`, false, { postId: post.id, itemKind: "extras", url: extrasRowUrl, phase: "working" });
      try {
        triggerPostExtras(creatorName, post, cancelSignal, allTasks);
        await Promise.all([
          ensureLinksTxt(creatorName, post),
          ensureDescription(creatorName, post, cancelSignal),
          ensureComments(creatorName, post, cancelSignal),
          ensureThumbnail(creatorName, post, cancelSignal),
          ensureVideo(creatorName, post, cancelSignal),
        ]);
        results[i] = { url: `${post.id}-extras`, ok: true };
      } catch (err) {
        results[i] = { url: `${post.id}-extras`, ok: false, error: err.message, cancelled: err.message === "cancelled" };
      }
      // advance=false: Description und Comments haben ihren Schritt bereits
      // SELBST gezaehlt (doDescription/doComments). Ein zusaetzliches
      // advance=true hier hat den Zaehler auf 3/2 getrieben und die Bar ueber
      // 100% geschoben - dieselbe Zaehler-Verdopplung wie im HANDOFF.md
      // dokumentierten "5/4"-Fall, nur an einer anderen Stelle.
      const extrasFailed = results[i] && results[i].ok === false;
      reportStep(
        `${post.title} · Description & comments (${extrasFailed ? (results[i].cancelled ? "cancelled" : "error") : "done"})`,
        false,
        { postId: post.id, itemKind: "extras", url: extrasRowUrl, error: extrasFailed && !results[i].cancelled }
      );
      return;
    }

    // Thumbnail/Video/Embed werden bereits von den ensureX-Funktionen in den
    // Post-Ordner gelegt. Wenn ein einzelnes solches Element hier als "file"
    // ankommt (z.B. beim Einzel-Download eines Thumbnails), NICHT nochmal in
    // "Download Files" ablegen - nur diesen einen Teil des Posts anstossen.
    const isSpecialVideo =
      file &&
      (file.role === "video" ||
        file.kind === "video" ||
        file.kind === "embed");
    const isSpecialThumb =
      file &&
      (file.role === "thumbnail" || file.kind === "thumbnail");
    const isSpecialDescription =
      file &&
      (file.role === "description" || file.kind === "description");
    const isSpecialComments =
      file &&
      (file.role === "comments" || file.kind === "comments");
    const isSpecial = isSpecialVideo || isSpecialThumb || isSpecialDescription || isSpecialComments;

    if (isSpecial) {
      // Post-Extras (Description/Comments/etc.) wurden bereits VOR dem
      // Dispatch-Loop fuer jeden Post in items einmalig angestossen (siehe
      // oben) - hier nicht nochmal noetig.
      if (isSpecialVideo && onLargeFile && settings.askBeforeLargeFiles) {
        let videoSizeBytes = file.sizeBytes || post.video?.sizeBytes || 0;
        const isWebOrMedia = (u) => {
          if (!u) return true;
          const l = u.toLowerCase();
          return l.includes("youtube.com") || l.includes("youtu.be") || l.includes("vimeo.com");
        };

        if (!videoSizeBytes && file.url && !isWebOrMedia(file.url)) {
          try {
            const res = await new Promise((resolve) => {
              chrome.runtime.sendMessage({ type: "FETCH_FILE_SIZES", urls: [file.url] }, (r) => resolve(r || {}));
            });
            if (res.ok && res.sizes && res.sizes[file.url]) videoSizeBytes = res.sizes[file.url];
          } catch {}
        }
        const sizeMB = videoSizeBytes ? videoSizeBytes / (1024 * 1024) : 0;
        const thresholdMB = settings.largeFileThresholdMB || 500;
        if ((sizeMB > 0 && sizeMB >= thresholdMB) || (sizeMB === 0 && thresholdMB <= 100)) {
          const decision = await onLargeFile({
            name: `${post.title} (Video)`,
            sizeBytes: videoSizeBytes || 0,
            sizeMB: sizeMB || 50,
            index: i,
            total: items.length,
          });
          if (decision === "cancel-all") {
            if (cancelSignal) cancelSignal.cancelled = true;
            results[i] = { url: file.url, ok: false, error: "cancelled", cancelled: true };
            return;
          }
          if (decision === "skip") {
            markVideoSkipped(post.id);
            results[i] = { url: file.url, ok: false, error: "skipped", skipped: true };
            // Schritt trotzdem zaehlen: das Item war im Nenner (totalSteps/
            // totalWeight) eingeplant. Ohne diesen Aufruf bleibt sein Gewicht
            // dauerhaft unverbucht - die Ecke-Bar kann dann rechnerisch nie
            // 100% erreichen und die "X von Y"-Zahl bleibt zu klein.
            reportStep(`${post.title} · ${file.filename} (skipped)`, true, {
              weight: post.video?.__appliedWeight || SIZE_ESTIMATE.VIDEO,
              postId: post.id,
              itemKind: file.kind || "file",
              url: file.url,
            });
            return;
          }
        }
      }

      // Das eingeplante Gewicht dieses Spezial-Items (nicht pauschal TEXT) -
      // wird nur im catch-Zweig unten gebraucht, wo ensureX() gar nicht erst bis
      // zu seinem eigenen Abschluss-reportStep gekommen ist.
      const specialWeight = isSpecialThumb
        ? (post.thumbnail?.__appliedWeight || SIZE_ESTIMATE.THUMBNAIL)
        : isSpecialVideo
          ? (post.video?.__appliedWeight || SIZE_ESTIMATE.VIDEO)
          : SIZE_ESTIMATE.TEXT;

      try {
        let resObj = null;
        if (isSpecialThumb) resObj = await ensureThumbnail(creatorName, post, itemSignal);
        else if (isSpecialDescription) resObj = await ensureDescription(creatorName, post, itemSignal);
        else if (isSpecialComments) resObj = await ensureComments(creatorName, post, itemSignal);
        else resObj = await ensureVideo(creatorName, post, itemSignal);

        // WICHTIG: advance=false. Jede ensureX()/doX()-Funktion zaehlt ihren
        // Schritt (und verbucht ihr Gewicht) inzwischen GARANTIERT genau einmal
        // selbst - auch bei Fehler/Abbruch. Ein zweites advance=true hier waere
        // exakt die in HANDOFF.md dokumentierte Zaehler-Verdopplung ("5/4").
        // Die Aufrufe bleiben trotzdem stehen: sie tragen Label + meta.error und
        // faerben damit die Zeile im Dashboard korrekt rot/gelb.
        if (resObj?.cancelled || itemSignal?.cancelled) {
          results[i] = { url: file.url, ok: false, error: "cancelled", cancelled: true };
          reportStep(`${post.title} · ${file.filename} (cancelled)`, false, { postId: post.id, itemKind: file.kind || "file", url: file.url });
        } else if (resObj?.error) {
          results[i] = { url: file.url, ok: false, error: resObj.error };
          reportStep(`${post.title} · ${file.filename} (error)`, false, { postId: post.id, itemKind: file.kind || "file", url: file.url, error: true });
        } else {
          results[i] = { url: file.url, ok: true, skipped: !!resObj?.skipped };
        }
      } catch (err) {
        // Hier (und NUR hier) mit advance=true: ensureX() ist geworfen, bevor es
        // seinen eigenen Abschluss-Schritt zaehlen konnte - ohne diesen Aufruf
        // bliebe das eingeplante Gewicht dauerhaft unverbucht.
        const isCancel = err.message === "cancelled" || itemSignal?.cancelled;
        results[i] = { url: file.url, ok: false, error: err.message, cancelled: isCancel };
        reportStep(`${post.title} · ${file.filename} (${isCancel ? "cancelled" : "error"})`, true, { weight: specialWeight, postId: post.id, itemKind: file.kind || "file", url: file.url, error: true });
      }
      return;
    }

    // Default-Gewicht ausserhalb des try-Blocks deklariert (mit let, nicht const),
    // damit der abschliessende reportStep()-Aufruf am Ende der Funktion (nach dem
    // catch) auch dann noch darauf zugreifen kann, wenn der try-Block vorzeitig
    // mit einer Exception abbricht, bevor die echte Groesse bekannt ist.
    let fileWeight = file.__appliedWeight || file.__realSizeBytes || file.sizeBytes || (isCloudLikeFile(file) ? SIZE_ESTIMATE.CLOUD : SIZE_ESTIMATE.FILE);
    let hadError = false;
    try {
      // Post-Extras (Thumbnail/Description/Comments/Video/_download_links.txt)
      // wurden bereits VOR dem Dispatch-Loop fuer jeden Post in items einmalig
      // angestossen (siehe oben) - dieses Datei-Item muss nicht darauf warten.

      // Nachfrage vor großen Dateien (falls aktiviert und Callback vorhanden).
      let fileSizeBytes = file.sizeBytes || 0;
      if (!fileSizeBytes && onLargeFile && settings.askBeforeLargeFiles && file.url && !file.isWebsite && !file.isCloudLink) {
        try {
          const res = await fetch(file.url, { method: "HEAD", credentials: "omit" });
          const len = res.headers.get("Content-Length");
          if (len) fileSizeBytes = parseInt(len, 10) || 0;
        } catch { /* best effort */ }
      }
      const sizeMB = fileSizeBytes ? fileSizeBytes / (1024 * 1024) : 0;
      if (
        onLargeFile &&
        settings.askBeforeLargeFiles &&
        sizeMB >= (settings.largeFileThresholdMB || 500)
      ) {
        const decision = await onLargeFile({
          name: file.filename,
          sizeBytes: file.sizeBytes,
          sizeMB,
          index: i,
          total: items.length,
        });
        if (decision === "cancel-all") {
          if (cancelSignal) cancelSignal.cancelled = true;
          results[i] = { url: file.url, ok: false, error: "cancelled", cancelled: true };
          return;
        }
        if (decision === "skip") {
          results[i] = { url: file.url, ok: false, error: "skipped", skipped: true };
          // Siehe Kommentar im Video-Skip-Zweig weiter oben: eingeplantes
          // Gewicht muss auch dann verbucht werden, wenn der Nutzer das Item
          // per Modal ueberspringt.
          reportStep(`${post.title} · ${file.filename} (skipped)`, true, {
            weight: fileWeight,
            postId: post.id,
            itemKind: file.kind || "file",
            url: file.url,
          });
          return;
        }
      }

      const postFolder = buildPostFolderName(post, naming);
      console.log(`[PatreonArchiver Download] Starting item ${i + 1}/${items.length}: "${file.filename}" (kind: ${file.kind || "file"}, url: ${file.url})`);
      reportStep(`${post.title} · ${file.filename}`, false, { postId: post.id, itemKind: file.kind || "file", url: file.url }); // Start-Signal: Sub-Bar auf 0%
      const subfolder = (file.kind === "image" || file.kind === "thumbnail" || file.role === "thumbnail") ? null : "Download Files";
      // weightDone/totalWeight (Bytes, nicht Schritte!) als Nenner mitgeben - das ist
      // dasselbe Byte-Budget, das reportStep()/updateStepProgress() fuer die
      // Primary-Bar benutzt. Wuerden wir hier stepsDone/totalSteps (Anzahl statt
      // Bytes) durchreichen, schreibt updateProgress() denselben State mit einem
      // ANDEREN Nenner als updateStepProgress() - das war die Ursache fuer die
      // springende "X/Y"-Anzeige bei Cloud-Ordner-Downloads.
      const progressWrapper = onProgress ? (p) => {
        // Sobald die Bridge waehrend des ECHTEN Downloads die reale
        // Ordner-/Dateigroesse meldet (p.total), diese zur Korrektur nutzen -
        // zuverlaessiger als sich nur auf den separaten Hintergrund-Scan zu
        // verlassen (der in einem EIGENEN Bridge-Prozess laeuft und manchmal
        // gar nicht oder zu spaet fertig wird, siehe cloudSizeProbes oben).
        //
        // Frueher stand hier zusaetzlich `p.filesCompleted !== undefined`, die
        // Korrektur lief also NUR bei Cloud-ORDNERN. Fuer alles andere (normale
        // Patreon-Anhaenge, Cloud-EINZELdateien) blieb das grobe Schaetzgewicht
        // (15 MB bzw. 800 MB) bis zum Schluss stehen - Hauptursache dafuer, dass
        // die angezeigte Gesamtgroesse "selten stimmt". CommandHandlers.cs
        // sendet in JEDER url_progress-Nachricht den Gesamt-Nenner des jeweiligen
        // Transfers (bei Ordnern state.GrandTotal, siehe
        // SaveDriveFolderFileCumulativeAsync/DownloadMegaFolderRecursiveAsync),
        // nie eine reine Einzeldatei-Teilgroesse - die Einschraenkung war also
        // ohnehin gegenstandslos.
        fileWeight = setItemWeight(file, p?.total, fileWeight);
        // Cloud-ORDNER ohne bekannte Gesamtgroesse (Bridge ueberspringt bei
        // grossen Ordnern die Vorab-Vermessung): dann darf wenigstens die
        // Schaetzung nicht kleiner bleiben als das, was schon geflossen ist -
        // sonst zeigt die Ecke dauerhaft "6.5 GB / ~800 MB" und der Balken steht
        // rechnerisch bei ueber 100%.
        if (!(p?.total > 0) && p?.received > fileWeight) {
          fileWeight = setItemWeight(file, p.received, fileWeight);
        }
        onProgress(weightDone, totalWeight, { ...p, filename: file.filename, itemWeight: fileWeight, postId: post.id, itemKind: file.kind || "file", url: file.url });
      } : null;

      // Cloud/Webseiten Downloads:
      // Wenn Brücke da ist -> versuche automatischen Download via C#-Bridge / yt-dlp (für Drive-Ordner, Mega, Dropbox).
      // Wenn Brücke NICHT da ist oder Download schlägt fehl -> als .txt-Datei mit Link-Info speichern.
      if (file.isWebsite || file.isCloudLink || file.isExternalLink) {
        // Bekannter, aber (noch) NICHT unterstuetzter Cloud-Anbieter (iCloud,
        // Sync.com, ...): gar nicht erst versuchen. Ein Versuch wuerde je nach
        // Anbieter die HTML-Freigabeseite als "Datei" speichern oder mit einem
        // nichtssagenden HTTP-Fehler enden - beides ist fuer den Nutzer nicht
        // von einem echten Bug zu unterscheiden. Der Link steht weiterhin in
        // _download_links.txt (isCloudLink bleibt true), und die Meldung unten
        // wird von classifyDownloadError() in dashboard.js in eine klare
        // Warnung mit Handlungsempfehlung uebersetzt.
        const unsupportedProvider = unsupportedProviderOf(file);
        if (unsupportedProvider) {
          console.log(`[PatreonArchiver Download] Unsupported cloud provider "${unsupportedProvider}" - skipping automatic download for: ${file.url}`);
          results[i] = {
            url: file.url,
            ok: false,
            unsupportedProvider,
            error: `Unsupported cloud provider: ${unsupportedProvider}`,
          };
          reportStep(`${post.title} · ${file.filename} (error)`, true, { weight: fileWeight, error: true, postId: post.id, itemKind: file.kind || "file", url: file.url });
          await stepPause();
          return;
        }

        // OneDrive: eigener Ablauf (echter Browser-Download + Verschieben
        // statt URL-Aufloesung + Bridge-Fetch), siehe downloadOneDriveFile()
        // weiter oben - muss VOR der generischen resolveDirectDownloadUrlWithName()-
        // Logik unten abgezweigt werden, da OneDrive dort bewusst NICHT
        // aufgeloest wird (die URL waere ohnehin cookie-gebunden unbrauchbar
        // fuer die Bridge).
        // Bekannte Einschraenkung: ein Cancel-Klick waehrend der Browser-
        // Download-Phase bricht den laufenden Hintergrund-Download NICHT
        // sofort ab (es gibt noch keinen Abbruch-Kanal zu background.js) -
        // das Ergebnis wird nur nach Abschluss verworfen. Fuer eine erste
        // Version akzeptiert, da OneDrive-Downloads i.d.R. nicht extrem lange
        // laufen.
        if (cloudProviderKey(file.url) === "onedrive") {
          const odRawName = file.filename || "onedrive_file";
          const odBaseName = sanitizeForPath(odRawName, "onedrive_file");
          const odExt = extFor(odBaseName, file.mimetype, "");
          // Gleiche Benennung wie bei allen anderen Anbietern: Linktext des
          // Creators, Rueckfall auf "OneDrive" (siehe cloudLinkFolderName()).
          const odSubfolderPath = ["Download Files", cloudLinkFolderName(postFolder, file, "OneDrive")];
          const { name: odFinalName, pathParts: odPathParts } = getUniquePathParts(postFolder, odSubfolderPath, odBaseName, odExt);

          if (await alreadyExists(creatorName, odPathParts, file)) {
            console.log(`[PatreonArchiver Download] OneDrive item already exists on disk (skipped): "${odFinalName}"`);
            results[i] = { url: file.url, ok: true, skipped: true };
            await updateFileDownloadStatus(post.id, file.url, { downloaded: true });
            reportStep(`${post.title} · ${file.filename} (skipped)`, true, { weight: fileWeight, postId: post.id, itemKind: file.kind || "file", url: file.url });
            await stepPause();
            return;
          }

          if (!bridgeConnected) {
            console.log(`[PatreonArchiver Download] Bridge NOT connected - link consolidated in _download_links.txt for: "${file.filename}"`);
            results[i] = { url: file.url, ok: true };
            await updateFileDownloadStatus(post.id, file.url, { downloaded: true });
            reportStep(`${post.title} · ${file.filename} (done)`, true, { weight: fileWeight, postId: post.id, itemKind: file.kind || "file", url: file.url });
            return;
          }

          reportStep(`${post.title} · ${file.filename}`, false, { weight: fileWeight, postId: post.id, itemKind: file.kind || "file", url: file.url, phase: "working" });
          console.log(`[PatreonArchiver Download] OneDrive: downloading via hidden browser window for "${file.filename}" (${file.url})`);

          // Live-Fortschritt waehrend der Browser-Download-Phase: background.js
          // streamt periodisch Chromes eigene Download-Infos (bytesReceived/
          // totalBytes). totalWeight/fileWeight werden SOFORT korrigiert,
          // sobald die echte Groesse bekannt ist (nicht erst nach Abschluss wie
          // vorher) - sonst bleibt die globale Ecke-Fortschrittsanzeige auf der
          // groben SIZE_ESTIMATE.CLOUD-Schaetzung haengen und wirkt "schon fast
          // fertig", obwohl der eigentlich grosse OneDrive-Download noch gar
          // nicht angefangen hat. Gleiches Korrektur-Muster wie progressWrapper
          // weiter oben fuer Cloud-Ordner-Downloads.
          const odOnProgress = (progress) => {
            if (!onProgress) return;
            fileWeight = setItemWeight(file, progress.totalBytes, fileWeight);
            onProgress(weightDone, totalWeight, {
              received: progress.bytesReceived,
              total: progress.totalBytes,
              filename: file.filename,
              itemWeight: fileWeight,
              postId: post.id,
              itemKind: file.kind || "file",
              url: file.url,
            });
          };

          const odResult = await downloadOneDriveFile(file.url, odOnProgress);

          if (itemSignal.cancelled) {
            if (odResult && odResult.ok && odResult.downloadId != null) {
              chrome.runtime.sendMessage({ type: "ERASE_DOWNLOAD", downloadId: odResult.downloadId });
            }
            results[i] = { url: file.url, ok: false, error: "cancelled", cancelled: true };
            reportStep(`${post.title} · ${file.filename} (cancelled)`, true, { weight: fileWeight, postId: post.id, itemKind: file.kind || "file", url: file.url, error: true });
            return;
          }

          if (!odResult || !odResult.ok) {
            console.error(`[PatreonArchiver Download] OneDrive download failed for "${file.filename}":`, odResult?.error);
            results[i] = { url: file.url, ok: false, error: odResult?.error || "OneDrive download failed" };
            reportStep(`${post.title} · ${file.filename} (error)`, true, { weight: fileWeight, error: true, postId: post.id, itemKind: file.kind || "file", url: file.url });
            return;
          }

          // Echten Dateinamen aus Chromes eigenem Content-Disposition-
          // basiertem Namen benutzen (statt unseres synthetischen Labels),
          // falls vorhanden - das ist der tatsaechliche Originalname.
          const realOdRawName = odResult.filename || odRawName;
          const realOdBaseName = sanitizeForPath(realOdRawName, "onedrive_file");
          const realOdExt = extFor(realOdBaseName, file.mimetype, "");
          const { pathParts: realOdPathParts } = getUniquePathParts(postFolder, odSubfolderPath, realOdBaseName, realOdExt);
          const odTargetAbsPath = absPath(creatorName, realOdPathParts);

          // Batch-weites totalWeight MIT-korrigieren, nicht nur das lokale
          // fileWeight - sonst bleibt die globale X/Y-GB-Anzeige und die
          // Est.-Time-Berechnung auf der groben SIZE_ESTIMATE.CLOUD-Schaetzung
          // haengen, waehrend dieses einzelne Item bereits mit der echten
          // Groesse abgeschlossen wird (Ursache fuer springende/falsche
          // Gesamt-Anzeige). Gleiches Korrektur-Muster wie beim progressWrapper
          // weiter oben fuer Cloud-Ordner-Downloads.
          fileWeight = setItemWeight(file, odResult.sizeBytes, fileWeight);

          console.log(`[PatreonArchiver Download] OneDrive: moving local file ${odResult.localPath} -> ${odTargetAbsPath}`);
          const moveResult = await moveLocalFileViaBridge(odResult.localPath, odTargetAbsPath);
          if (odResult.downloadId != null) {
            chrome.runtime.sendMessage({ type: "ERASE_DOWNLOAD", downloadId: odResult.downloadId });
          }

          if (!moveResult || !moveResult.ok) {
            console.error(`[PatreonArchiver Download] OneDrive: moving local file failed for "${file.filename}":`, moveResult?.error);
            results[i] = { url: file.url, ok: false, error: moveResult?.error || "Moving downloaded file failed" };
            reportStep(`${post.title} · ${file.filename} (error)`, true, { weight: fileWeight, error: true, postId: post.id, itemKind: file.kind || "file", url: file.url });
            return;
          }

          results[i] = { url: file.url, ok: true };
          await updateFileDownloadStatus(post.id, file.url, { downloaded: true });
          reportStep(`${post.title} · ${file.filename} (done)`, true, { weight: fileWeight, postId: post.id, itemKind: file.kind || "file", url: file.url });

          // PatreonArchiverTemp-Ordner bereinigen: Das Verzeichnis, in das Chrome
          // die OneDrive-Datei voruebergehend heruntergeladen hat, ist nach dem
          // Move komplett leer - jetzt loeschen, damit es nicht im Downloads-Ordner
          // des Nutzers verbleibt. Best-effort (kein throw bei Fehler).
          try {
            const tempDir = odResult.localPath.replace(/[\\/][^\\/]+$/, ""); // Parent-Verzeichnis
            if (tempDir && tempDir.length > 10) { // Sicherheits-Guard gegen Root-Pfade
              deleteDirectoryViaBridge(tempDir).catch(() => {});
            }
          } catch { /* best-effort */ }

          return;
        }

        // Dropbox/MediaFire/PixelDrain/WeTransfer brauchen eine vorab aufgeloeste
        // Direkt-Download-URL, sonst liefert die rohe Freigabeseiten-URL nur HTML.
        // Google Drive/MEGA NICHT ueber diesen Weg aufloesen - CommandHandlers.cs
        // faengt diese Domains selbst ab und macht eigene Ordner-Rekursion/ZIP-
        // Export, die eine vorab aufgeloeste Einzeldatei-URL zerstoeren wuerde
        // (frueher hier faelschlich resolveDirectDownloadUrlWithName() benutzt -
        // bei Drive-ORDNER-Links wurde dadurch die Ordner-ID als Datei-ID in eine
        // "uc?export=download&id=..."-URL geschrieben, die Bridge bekam von
        // Google dafuer ein HTTP 500).
        const { url: bridgeDownloadUrl, filename: resolvedFilename } = await resolveBridgeDownloadUrlWithName(file.url);

        if (!bridgeConnected) {
          console.log(`[PatreonArchiver Download] Bridge NOT connected - link consolidated in _download_links.txt for: "${file.filename}"`);
          results[i] = { url: file.url, ok: true };
          await updateFileDownloadStatus(post.id, file.url, { downloaded: true });
          reportStep(`${post.title} · ${file.filename} (done)`, true, { weight: fileWeight, postId: post.id, itemKind: file.kind || "file", url: file.url });
          return;
        }

        // Pro Cloud-Anbieter einen eigenen Unterordner im Post-Ordner anlegen
        // (z.B. "Dropbox", "MEGA", "MediaFire", "Google Drive", "OneDrive")
        let providerSubfolder = file.tag;
        if (!providerSubfolder || providerSubfolder === "External File") {
          const urlLower = (file.url || "").toLowerCase();
          if (urlLower.includes("drive.google.com")) providerSubfolder = "Google Drive";
          else if (urlLower.includes("mega.nz") || urlLower.includes("mega.io")) providerSubfolder = "MEGA";
          else if (urlLower.includes("dropbox.com")) providerSubfolder = "Dropbox";
          else if (urlLower.includes("mediafire.com")) providerSubfolder = "MediaFire";
          else if (urlLower.includes("onedrive.live.com") || urlLower.includes("1drv.ms")) providerSubfolder = "OneDrive";
          else if (urlLower.includes("pixeldrain.com")) providerSubfolder = "PixelDrain";
          else if (urlLower.includes("wetransfer.com") || urlLower.includes("we.tl")) providerSubfolder = "WeTransfer";
          else providerSubfolder = "External Files";
        }
        // Ordner heisst wie der Link beim Creator ("Conifer Trees"), nicht wie
        // der Anbieter - siehe cloudLinkFolderName().
        const cloudFolderName = cloudLinkFolderName(postFolder, file, providerSubfolder);

        // Sauberen Dateinamen OHNE eckige Klammern [Anbieter] herstellen.
        // Prioritaet: (1) Dateiname MIT Endung aus der AUFGELOESTEN
        // Direkt-URL (bridgeDownloadUrl) - MediaFire/WeTransfer-CDN-Links
        // enthalten den echten Original-Dateinamen inkl. Endung im Pfad,
        // waehrend die rohe Freigabe-URL selbst nie eine hat und der vom
        // Provider gescrapte Name manchmal die Endung verliert (z.B.
        // MediaFires "testfile" statt "testfile.bin"). (2) vom Provider
        // gescrapter Name, falls brauchbar. (3) generischer Fallback.
        // Frueher wurde hier faelschlich `null` als fallbackPrefix an
        // getFilenameFromCloudUrl() uebergeben (statt es wegzulassen) - JS-
        // Default-Parameter greifen nur bei `undefined`, nicht bei explizitem
        // `null`, wodurch der interne Fallback-Name woertlich "null_<timestamp>.bin"
        // wurde statt "cloud_file_<timestamp>.bin".
        const isJunkName = (n) => !n || n === "null" || n.startsWith("null_") || n.startsWith("undefined") ||
          /^(Google Drive|MEGA|Dropbox|OneDrive|MediaFire|PixelDrain|WeTransfer)(\s+(Link|Test File|File))?$/i.test(n);

        let cleanName;
        const fromResolvedUrl = getFilenameFromCloudUrl(bridgeDownloadUrl, "cloud_file");
        if (fromResolvedUrl && !fromResolvedUrl.startsWith("cloud_file")) {
          cleanName = fromResolvedUrl;
        } else {
          const scraped = (resolvedFilename || "").trim()
            .replace(/\s*\[(Google Drive|MEGA|Dropbox|MediaFire|OneDrive|PixelDrain|WeTransfer|External File|GitHub Release|Website)\]$/i, "")
            .trim();
          if (!isJunkName(scraped)) {
            cleanName = scraped;
          } else {
            const fromOriginalUrl = getFilenameFromCloudUrl(file.url, "cloud_file");
            cleanName = (fromOriginalUrl && !fromOriginalUrl.startsWith("cloud_file")) ? fromOriginalUrl : `${providerSubfolder}_file`;
          }
        }

        console.log(`[PatreonArchiver Download] Outsourcing Cloud download to C# Bridge for: "${cleanName}" in folder "${providerSubfolder}" (${file.url})`);

        // Der Hintergrund-Groessenscan (cloudSizeProbes) kann erst jetzt fertig
        // geworden sein - dann hat er totalWeight bereits ueber setItemWeight()
        // korrigiert und `__appliedWeight` traegt die echte Groesse. Hier nur
        // noch die lokale Kopie nachziehen (NICHT nochmal totalWeight anfassen).
        if (file.__appliedWeight) fileWeight = file.__appliedWeight;

        const baseName = sanitizeForPath(cleanName, "cloud_file");
        const ext = extFor(baseName, file.mimetype, "");
        const cloudSubfolderPath = ["Download Files", cloudFolderName];

        // ORDNER-Links bekommen KEINEN zusaetzlichen Namenssegment-Anteil.
        //
        // Fuer eine Einzeldatei ist `pathParts` der Ziel-DATEIPFAD. Bei einem
        // ORDNER-Link (Drive-/MEGA-Ordner) legt die Bridge unter dem
        // uebergebenen Pfad ein VERZEICHNIS an und packt den Ordnerinhalt
        // hinein (`DownloadGoogleDriveFileAsync`: `string targetFolder = path`).
        // Der hier geratene Dateiname wurde damit zu einem zusaetzlichen
        // Zwischenordner - und weil fuer einen Ordner-Link nie ein sinnvoller
        // Dateiname aus der URL zu holen ist, griff regelmaessig der generische
        // Rueckfall `${providerSubfolder}_file`. Ergebnis im Dateisystem:
        //   Download Files/Conifer Trees/Google Drive_file/<Dateien>
        // (im Bridge-Log woertlich als url_done-Pfad zu sehen). Seit der Ordner
        // ohnehin nach dem Linktext heisst, ist dieses Segment reine
        // Verdopplung - der Ordnerinhalt gehoert direkt in "Conifer Trees".
        const isCloudFolderLink = isCloudFolderUrl(file.url);
        const { name: finalName, pathParts } = isCloudFolderLink
          ? { name: cloudFolderName, pathParts: [postFolder, ...cloudSubfolderPath] }
          : getUniquePathParts(postFolder, cloudSubfolderPath, baseName, ext);
        const targetAbsPath = absPath(creatorName, pathParts);

        if (await alreadyExists(creatorName, pathParts, file)) {
          console.log(`[PatreonArchiver Download] Cloud item already exists on disk (skipped): "${finalName}"`);
          results[i] = { url: file.url, ok: true, skipped: true };
          await updateFileDownloadStatus(post.id, file.url, { downloaded: true });
          reportStep(`${post.title} · ${file.filename} (skipped)`, true, { weight: fileWeight, postId: post.id, itemKind: file.kind || "file", url: file.url });
          await stepPause();
          return;
        }

        console.log(`[PatreonArchiver Download] C# Bridge downloading URL: ${bridgeDownloadUrl} -> ${targetAbsPath}`);

        // Sofort "Scanning..."-Status melden (0ms Delay), waehrend C# die Groesse/Dateien analysiert
        reportStep(`${post.title} · ${file.filename}`, false, { weight: fileWeight, postId: post.id, itemKind: file.kind || "file", url: file.url, phase: "working" });

        // Bridge kann bei MEGA/Google-Drive-Einzeldateien einen ANDEREN
        // finalen Pfad verwenden als den von uns vorgeschlagenen - sie
        // ermitteln den echten Dateinamen selbst aus den Anbieter-Metadaten
        // (siehe CommandHandlers.cs DownloadMegaFileAsync: nimmt nur unseren
        // Zielordner, haengt aber `fileInfo.Name` von MEGA an, nicht unseren
        // geratenen Namen) und melden den TATSAECHLICHEN Pfad im "url_done"-
        // Response zurueck. Ohne diese Korrektur pruefte der naechste Schritt
        // Existenz am FALSCHEN (unserem geratenen) Pfad, fand nichts, und
        // loeste einen unnoetigen Fallback-Download per einfachem Browser-
        // Fetch aus (kein echter MEGA-API-Download!), der eine ZWEITE, falsch
        // benannte Datei erzeugte (beobachteter Bug: 2 Dateien im MEGA-Ordner,
        // eine korrekt + eine generisch "MEGA_file").
        let actualBridgePath = targetAbsPath;
        // Merkt sich die ECHTE Fehlermeldung der Bridge (z.B. "...409 (Bandwidth
        // Limit Exceeded)") - wird unten fuer den finalen results[i].error
        // gebraucht. Ohne das ueberschrieb der generische "File not downloaded"-
        // Text am Ende IMMER den eigentlichen Grund, wodurch der Rate-Limit-
        // Warn-Indikator im Dashboard (classifyDownloadError()) nie etwas
        // Klassifizierbares zu sehen bekam.
        let originalBridgeError = null;
        try {
          const r = await downloadUrlViaBridge(bridgeDownloadUrl, targetAbsPath, progressWrapper, itemSignal);
          if (r && r.ok === false) throw new Error(r.error || "C# Bridge download failed");
          if (typeof r === "string" && r) actualBridgePath = r;
        } catch (bridgeErr) {
          if (bridgeErr.message === "cancelled" || itemSignal.cancelled) {
            results[i] = { url: file.url, ok: false, error: "cancelled", cancelled: true };
            reportStep(`${post.title} · ${file.filename} (cancelled)`, true, { weight: fileWeight, postId: post.id, itemKind: file.kind || "file", url: file.url, error: true });
            return;
          }
          originalBridgeError = bridgeErr.message;
          console.warn(`[PatreonArchiver Download] C# Bridge download notice for "${file.filename}":`, bridgeErr.message);
        }

        // Ueberpruefe, ob die Datei tatsaechlich auf der Festplatte angekommen ist
        // (am TATSAECHLICHEN Pfad, siehe Kommentar oben - nicht zwingend targetAbsPath)
        let fileOnDisk = false;
        if (useBridgePath) {
          fileOnDisk = await checkFileExistsViaBridge(actualBridgePath);
        }

        // Bei einem ORDNER-Link bedeutet "Verzeichnis existiert" NICHT "alles da":
        // die Bridge meldet seit der 25. Runde einen Fehler, wenn Google einen Teil
        // der Dateien mit HTML-Sperrseiten beantwortet hat - der Ordner liegt dann
        // trotzdem (unvollstaendig) auf der Platte. Ohne diese Klammer waere so ein
        // Lauf hier wieder als Erfolg durchgegangen und die Rate-Limit-Warnung
        // haette den Nutzer nie erreicht.
        if (isCloudFolderLink && originalBridgeError) {
          fileOnDisk = false;
        }

        // fetchAsBlob-Rueckfall ergibt nur fuer EINZELDATEIEN Sinn: bei einem
        // Ordner-Link wuerde er die rohe Freigabe-HTML-Seite laden und sie als
        // "Datei" an den Ordnerpfad schreiben.
        if (!fileOnDisk && !isCloudFolderLink) {
          console.log(`[PatreonArchiver Download] File not on disk yet for "${file.filename}", trying Extension fetchAsBlob fallback...`);
          try {
            const blob = await fetchAsBlob(bridgeDownloadUrl, { cancelSignal: itemSignal, onProgress: progressWrapper });
            if (useBridgePath) {
              await writeFileViaBridge(targetAbsPath, blob, progressWrapper);
              fileOnDisk = await checkFileExistsViaBridge(targetAbsPath);
            } else if (useDirHandle) {
              const folder = sanitizeForPath(creatorName, "creator");
              await writeBlobToDirectory(settings.dirHandle, [folder, ...cloudSubfolderPath, `${baseName}${ext}`], blob);
              fileOnDisk = true;
            }
          } catch (fallbackErr) {
            if (fallbackErr.message === "cancelled" || itemSignal.cancelled) {
              results[i] = { url: file.url, ok: false, error: "cancelled", cancelled: true };
              reportStep(`${post.title} · ${file.filename} (cancelled)`, true, { weight: fileWeight, postId: post.id, itemKind: file.kind || "file", url: file.url, error: true });
              return;
            }
          }
        }

        if (useBridgePath && !fileOnDisk) {
          console.error(`[PatreonArchiver Download] Cloud download failed - no file created at ${targetAbsPath}`);
          results[i] = { url: file.url, ok: false, error: originalBridgeError || "File not downloaded" };
          reportStep(`${post.title} · ${file.filename} (error)`, true, { weight: fileWeight, error: true, postId: post.id, itemKind: file.kind || "file", url: file.url });
          return;
        }

        results[i] = { url: file.url, ok: true };
        await updateFileDownloadStatus(post.id, file.url, { downloaded: true });
        reportStep(`${post.title} · ${file.filename} (done)`, true, { weight: fileWeight, postId: post.id, itemKind: file.kind || "file", url: file.url });
        return;
      }

      const downloadTargetUrl = file.url;
      let rawBaseName = file.filename;
      const isImageOrThumb = file.kind === "image" || file.kind === "thumbnail" || file.role === "thumbnail";
      if (isImageOrThumb) {
        if (!rawBaseName || rawBaseName === "Thumbnail" || rawBaseName === "image") {
          rawBaseName = `${post.title} - Thumbnail`;
        } else if (!rawBaseName.startsWith("Thumbnail")) {
          const cleanName = rawBaseName.replace(/\.[a-z0-9]{2,4}$/i, "");
          rawBaseName = `Thumbnail [${cleanName}]`;
        }
      }
      const baseName = sanitizeForPath(rawBaseName, "file");
      const ext = extFor(baseName, file.mimetype, "");
      const { name: finalName, pathParts } = getUniquePathParts(postFolder, subfolder, baseName, ext);

      if (await alreadyExists(creatorName, pathParts, file)) {
        console.log(`[PatreonArchiver Download] Item already exists on disk (skipped): "${finalName}"`);
        results[i] = { url: file.url, ok: true, skipped: true };
        await updateFileDownloadStatus(post.id, file.url, { downloaded: true });
        reportStep(`${post.title} · ${file.filename} (skipped)`, true, { weight: fileWeight, postId: post.id, itemKind: file.kind || "file", url: file.url });
        await stepPause();
        return;
      }

      // Bei Bildern/Thumbnails auf schnellem Patreon CDN keine künstliche Anti-Rate-Limit Pause machen!
      if (hasPerformedNetworkAction && !isImageOrThumb) {
        const jitterMs = Math.floor(Math.random() * (3500 - 1500 + 1)) + 1500;
        await new Promise((resolve) => setTimeout(resolve, jitterMs));
        if (itemSignal.cancelled) {
          results[i] = { url: file.url, ok: false, error: "cancelled", cancelled: true };
          return;
        }
      }

      console.log(`[PatreonArchiver Download] Downloading file: "${finalName}" -> path:`, pathParts);
      if (isImageOrThumb) {
        // Diagnose fuer "andere Thumbnails fuellen sich nicht" - siehe passendes
        // "[PA Thumb Debug]"-Log in dashboard.js, um zu pruefen, ob ueberhaupt
        // Byte-Ticks fuer dieses Galerie-Bild ankommen.
        console.log(`[PA Thumb Debug] Starting gallery image "${finalName}", weight=${fileWeight}, useBridgePath=${useBridgePath}, useDirHandle=${useDirHandle}, asZip=${asZip}`);
      }
      const r = await withRetryUrl(downloadTargetUrl, post, file, (u) =>
        placeUrl(creatorName, post, pathParts, u, {
          onProgress: progressWrapper,
          requestId,
          cancelSignal: itemSignal,
        })
      );
      hasPerformedNetworkAction = true;
      if (r && r.ok === false) throw new Error(r.error || "Download failed");
      console.log(`[PatreonArchiver Download] Item completed: "${finalName}"`);
      results[i] = { url: file.url, ok: true };
      await updateFileDownloadStatus(post.id, file.url, { downloaded: true });
    } catch (err) {
      console.error(`[PatreonArchiver Download] Failed item ${i + 1}/${items.length}: "${file.filename}":`, err);
      results[i] = { url: file.url, ok: false, error: err.message, cancelled: err.message === "cancelled" };
      hadError = true;
    }
    reportStep(`${post.title} · ${file.filename} (done)`, true, { weight: fileWeight, error: hadError, postId: post.id, itemKind: file.kind || "file", url: file.url });
    // Kleine, rein kosmetische Pause (NICHT die Anti-Rate-Limit-Jitter oben) -
    // gibt dem Auge Zeit, den "fertig"-Zustand der Sekundaer-Bar ueberhaupt
    // wahrzunehmen. Ohne das laufen sehr schnelle Downloads (kleine Bilder auf
    // Patreons CDN, oft <300ms - schneller als der 150ms-Bridge-Meldeintervall,
    // dadurch NIE ein echter Byte-Tick) komplett durch, ohne dass die Bar
    // sichtbar auf 100% steht, bevor das naechste Item sie auf 0% zuruecksetzt.
    if (file.kind === "image" || file.kind === "thumbnail" || file.role === "thumbnail") await stepPause(180);
  }

  // WICHTIG: Post-Extras (Thumbnail/Description/Comments/Video/_download_links.txt)
  // MUESSEN bereits VOR dem Promise.all() weiter unten in allTasks liegen.
  // Promise.all() liest sein Argument nur EINMAL beim Aufruf ein - Eintraege,
  // die ERST WAEHREND der Ausfuehrung (z.B. aus processItem() heraus) noch
  // ins selbe Array gepusht werden, werden NICHT mehr mitbeachtet. Frueher
  // riefen die einzelnen Items triggerPostExtras() aus processItem() heraus
  // auf, wodurch downloadItems() manchmal zurueckkehrte, BEVOR Description/
  // Comments tatsaechlich geschrieben waren (Race Condition - die Dateien
  // fehlten dadurch teils komplett). Deshalb hier einmal pro eindeutigem Post
  // vorab anstossen, synchron, bevor der Dispatch-Loop unten allTasks an
  // Promise.all() uebergibt.
  const extrasTriggeredPostIds = new Set();
  for (const it of items) {
    const pid = String(it.post.id);
    if (extrasTriggeredPostIds.has(pid)) continue;
    extrasTriggeredPostIds.add(pid);
    triggerPostExtras(it.creatorName, it.post, cancelSignal, allTasks);
  }

  // Jedes Item ueber seinen typgerechten Pool dispatchen, statt es sequenziell
  // abzuwarten - das ist der Kern der echten Parallelitaet: Bilder/Videos/
  // Cloud-Links (je Anbieter)/normale Dateien laufen jetzt bis zu ihrem
  // jeweiligen Limit gleichzeitig, statt strikt nacheinander.
  for (let i = 0; i < items.length; i++) {
    const pool = pickPoolForItem(items[i].file);
    allTasks.push(pool ? pool.run(() => processItem(i)) : processItem(i));
  }

  // Auf ALLE Items warten - normale Datei-Downloads genauso wie Cloud-Ordner
  // UND die Post-Extras (Thumbnail/Description/Comments/Video), die von
  // triggerPostExtras() oben in allTasks abgelegt wurden. Vorher wurde hier
  // nur auf separat behandelte Cloud-Hintergrund-Tasks gewartet - das war der
  // erste Schritt in genau diese Richtung, jetzt der Normalfall fuer ALLE Items.
  if (allTasks.length > 0) {
    await Promise.all(allTasks);
  }

  if (asZip) {
    const zipBlob = await zip.generateAsync({ type: "blob" });
    if (settings.dirHandle) {
      await writeBlobToDirectory(settings.dirHandle, [zipName], zipBlob);
    } else {
      const objectUrl = URL.createObjectURL(zipBlob);
      const relPath = `${settings.subfolderPath || "PatreonArchiver"}/${zipName}`;
      await downloadViaChromeApi(objectUrl, relPath);
      setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
    }
  }

  return { results, embedResults, extraResults, totalSteps };
}
