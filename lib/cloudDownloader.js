import { logWarn } from "./appLog.js";

/**
 * Cloud Storage Auto-Downloader Helper Module
 * Resolves Dropbox, Google Drive, OneDrive, MediaFire and PixelDrain links
 * to direct download URLs.
 */

// Cloud-Anbieter, die wir ERKENNEN, aber (noch) NICHT automatisch herunterladen
// koennen. Zweck: statt einen sinnlosen Download-Versuch zu starten (der nur die
// HTML-Freigabeseite oder einen nichtssagenden Fehler liefert), bekommt der
// Nutzer eine klare Meldung im Warn-Icon des Dashboards.
//
// SPIEGEL von CLOUD_PROVIDERS (`supported: false`) in content.js - dort passiert
// die eigentliche Klassifizierung beim Scan (`file.unsupportedProvider`).
// content.js ist ein klassisches Content-Script und kann diese Datei nicht
// importieren, deshalb existiert die Liste zwangslaeufig zweimal; diese Kopie
// hier ist das Sicherheitsnetz fuer Posts, die VOR der einundzwanzigsten Runde
// gescannt wurden (deren `post.files` kennt das Feld noch nicht).
// Bei Aenderungen bitte BEIDE Listen anfassen.
const UNSUPPORTED_CLOUD_PROVIDERS = [
  { label: "iCloud", hosts: ["icloud.com"] },
  { label: "Sync.com", hosts: ["sync.com"] },
  { label: "Box", hosts: ["box.com"] },
  { label: "pCloud", hosts: ["pcloud.com", "pcloud.link"] },
  { label: "Proton Drive", hosts: ["drive.proton.me"] },
  { label: "Yandex Disk", hosts: ["disk.yandex.com", "disk.yandex.ru"] },
  { label: "TeraBox", hosts: ["terabox.com", "teraboxapp.com"] },
  { label: "Gofile", hosts: ["gofile.io"] },
  { label: "SwissTransfer", hosts: ["swisstransfer.com"] },
  { label: "Smash", hosts: ["fromsmash.com"] },
  { label: "Filemail", hosts: ["filemail.com"] },
  { label: "KrakenFiles", hosts: ["krakenfiles.com"] },
  { label: "4shared", hosts: ["4shared.com"] },
  { label: "Sendspace", hosts: ["sendspace.com"] },
];

// Liefert den Anzeigenamen des Anbieters, wenn die URL zu einem bekannten, aber
// nicht unterstuetzten Cloud-Dienst gehoert - sonst null.
export function unsupportedCloudProvider(url) {
  if (!url) return null;
  let host = null;
  try { host = new URL(url).hostname.toLowerCase(); }
  catch { /* keine parsebare URL - Substring-Vergleich unten */ }
  const raw = String(url).toLowerCase();
  // Exakter bzw. Subdomain-Vergleich, kein host.includes() - sonst wuerde
  // "www.dropbox.com" auf "box.com" passen (siehe content.js, hostMatches()).
  const hit = UNSUPPORTED_CLOUD_PROVIDERS.find((p) =>
    p.hosts.some((h) => (host ? host === h || host.endsWith(`.${h}`) : raw.includes(h)))
  );
  return hit ? hit.label : null;
}

export function convertDropboxToDirectLink(url) {
  if (!url || !/dropbox\.com/i.test(url)) return url;
  let clean = url.trim();
  if (/dl=1/i.test(clean)) return clean;
  if (/dl=0/i.test(clean)) {
    return clean.replace(/dl=0/gi, "dl=1");
  }
  if (clean.includes("?")) {
    return `${clean}&dl=1`;
  }
  return `${clean}?dl=1`;
}

export function isGoogleDriveFolderUrl(url) {
  if (!url) return false;
  return /\/folders\//i.test(url) || /[?&]id=[^&]*folder/i.test(url);
}

// Zeigt der Link auf einen ORDNER (nicht auf eine Einzeldatei)? Wichtig fuer
// den Zielpfad: bei einem Ordner legt die Bridge unter dem uebergebenen Pfad
// ein Verzeichnis an und packt den Inhalt hinein - ein zusaetzlich geratener
// Dateiname wuerde dort zu einem ueberfluessigen Zwischenordner (siehe
// downloadItems() in downloader.js).
export function isCloudFolderUrl(url) {
  if (!url) return false;
  if (/drive\.google\.com/i.test(url) && isGoogleDriveFolderUrl(url)) return true;
  // MEGA: "/folder/<id>#<key>" bzw. das alte "#F!<id>!<key>"-Format
  if (/mega\.(nz|io)/i.test(url) && (/\/folder\//i.test(url) || /#F!/.test(url))) return true;
  // Dropbox-Ordnerfreigaben ("/scl/fo/", altes "/sh/") - liefern von Dropbox
  // selbst ein ZIP, das die Bridge wie eine Datei behandelt, deshalb hier
  // bewusst NICHT als Ordner gemeldet.
  return false;
}

export function extractGoogleDriveFileId(url) {
  if (!url) return null;
  const matchD = url.match(/\/(?:file|folders|open)\/d\/([a-zA-Z0-9_-]+)/i) ||
                 url.match(/\/(?:file|folders)\/([a-zA-Z0-9_-]+)/i);
  if (matchD && matchD[1]) return matchD[1];
  const matchId = url.match(/[?&]id=([a-zA-Z0-9_-]+)/i);
  if (matchId && matchId[1]) return matchId[1];
  return null;
}

export async function resolveGoogleDriveDirectLink(url) {
  const fileId = extractGoogleDriveFileId(url);
  if (!fileId) {
    console.warn("[PatreonArchiver Cloud] Failed to extract Google Drive file ID from:", url);
    return { ok: false, error: "Invalid Google Drive file ID" };
  }

  const initialUrl = `https://drive.google.com/uc?export=download&id=${fileId}`;

  try {
    const bgResult = await new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: "RESOLVE_GOOGLE_DRIVE", fileId }, (res) => resolve(res || {}));
    });
    if (bgResult && bgResult.ok && bgResult.directUrl) {
      return bgResult;
    }
  } catch (err) {
    console.warn("[PatreonArchiver Cloud] Service Worker resolution fallback error:", err);
  }

  return { ok: true, directUrl: initialUrl };
}

export async function resolvePixelDrainDirectLink(url) {
  if (!url || !/pixeldrain\.com/i.test(url)) return { directUrl: url, filename: null };
  const m = /pixeldrain\.com\/u\/([a-zA-Z0-9]+)/i.exec(url);
  if (!m) return { directUrl: url, filename: null };
  const fileId = m[1];
  const directUrl = `https://pixeldrain.com/api/file/${fileId}?download`;
  let filename = null;
  try {
    const res = await fetch(`https://pixeldrain.com/api/file/${fileId}/info`);
    if (res.ok) {
      const data = await res.json();
      if (data && data.name) filename = data.name;
    }
  } catch (err) {
    console.warn("[PatreonArchiver Cloud] Failed to fetch PixelDrain info:", err);
  }
  return { directUrl, filename };
}

// OneDrive wird NICHT hier aufgeloest (kein URL-Resolver mehr) - die
// aufgeloeste Direkt-URL ist cookie-gebunden und funktioniert nur innerhalb
// der Browser-Session, die den anonymen Freigabe-Redeem-Flow durchlaufen hat
// (live verifiziert: 403 ohne Cookies). Die Bridge (ein HttpClient ohne diese
// Session) kann damit nichts anfangen. Stattdessen laesst downloader.js den
// KOMPLETTEN Download durch den echten Browser laufen (siehe
// DOWNLOAD_ONEDRIVE_FILE in background.js) und uebergibt danach nur die
// fertige lokale Datei zum Verschieben an die Bridge - siehe
// downloadOneDriveFile() in downloader.js, NICHT diese generische
// URL-Resolver-Funktion hier.

export async function resolveMediaFireDirectLink(url) {
  try {
    const bgResult = await new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: "RESOLVE_MEDIAFIRE", url }, (res) => resolve(res || {}));
    });
    if (bgResult && bgResult.ok && bgResult.directUrl) return bgResult;
    // War vorher ein stiller Fallback auf die rohe Freigabeseiten-URL - dadurch
    // "gelang" der Download scheinbar (die Bridge laedt dann einfach die HTML-
    // Seite statt der echten Datei), ohne dass in der Dashboard-Konsole
    // irgendein Hinweis auf den Fehlschlag zu sehen war. Jetzt sichtbar geloggt.
    console.warn("[PatreonArchiver Cloud] MediaFire resolution did not find a direct link, falling back to raw share URL:", bgResult?.error || "(unknown reason)");
  } catch (err) {
    console.warn("[PatreonArchiver Cloud] MediaFire resolution failed:", err);
  }
  return { ok: false, directUrl: url };
}

// Zentrale Stelle: liefert zu einer beliebigen (moeglicherweise Freigabe-Seiten-)
// Cloud-URL die tatsaechliche Direkt-Download-URL. Wird sowohl fuer den
// automatischen Cloud-Link-Scan im Posttext als auch fuer manuell ausgewaehlte
// Datei-Zeilen genutzt - NIE an zwei Stellen unterschiedlich implementieren
// (gleiches Prinzip wie bei lib/videoProgress.js).
// Variante mit Dateiname: MediaFire/Google Drive liefern den echten Dateinamen
// beim Aufloesen gleich mit (aus der HTML-Seite gescraped) - der geht sonst
// verloren, weil die Freigabe-URL selbst meist keinen brauchbaren Dateinamen
// im Pfad enthaelt (z.B. MediaFire endet auf ".../file", nicht auf den echten
// Namen).
export async function resolveWeTransferDirectLink(url) {
  try {
    const bgResult = await new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: "RESOLVE_WETRANSFER", url }, (res) => resolve(res || {}));
    });
    if (bgResult && bgResult.ok && bgResult.directUrl) return bgResult;
    console.warn("[PatreonArchiver Cloud] WeTransfer resolution did not find a direct link:", bgResult?.error || "(unknown reason)");
  } catch (err) {
    console.warn("[PatreonArchiver Cloud] WeTransfer resolution failed:", err);
  }
  return { ok: false, directUrl: url };
}

export async function resolveDirectDownloadUrlWithName(url) {
  if (!url) return { url, filename: null };
  let provider = "generic (no resolver)";
  let result;
  if (/dropbox\.com/i.test(url)) {
    provider = "dropbox";
    result = { url: convertDropboxToDirectLink(url), filename: null };
  } else if (/pixeldrain\.com/i.test(url)) {
    provider = "pixeldrain";
    const r = await resolvePixelDrainDirectLink(url);
    result = { url: r.directUrl || url, filename: r.filename || null };
  } else if (/wetransfer\.com|we\.tl/i.test(url)) {
    provider = "wetransfer";
    const r = await resolveWeTransferDirectLink(url);
    result = { url: r.directUrl || url, filename: r.filename || null };
  } else if (/onedrive\.live\.com|1drv\.ms/i.test(url)) {
    // OneDrive wird hier bewusst NICHT aufgeloest, siehe Kommentar weiter
    // oben - laeuft ueber downloader.js's downloadOneDriveFile() stattdessen.
    provider = "onedrive (handled separately, see downloader.js)";
    result = { url, filename: null };
  } else if (/mediafire\.com/i.test(url)) {
    provider = "mediafire";
    const r = await resolveMediaFireDirectLink(url);
    result = { url: r.directUrl || url, filename: r.filename || null };
  } else if (/drive\.google\.com/i.test(url)) {
    provider = "drive";
    const r = await resolveGoogleDriveDirectLink(url);
    result = { url: r.ok && r.directUrl ? r.directUrl : url, filename: r.filename || null };
  } else {
    result = { url, filename: null };
  }
  if (result.url === url) {
    // Unveraendert zurueck = die Aufloesung hat nichts gefunden. Frueher nur ein
    // console.log, das beim Aufraeumen weggefallen waere - genau diese Zeile
    // erklaert aber spaeter, warum die Bridge nur eine HTML-Seite bekommen hat.
    logWarn(`Cloud link NOT resolved (provider="${provider}"): ${url}`);
  }
  return result;
}

export async function resolveDirectDownloadUrl(url) {
  const r = await resolveDirectDownloadUrlWithName(url);
  return r.url;
}

export function getFilenameFromCloudUrl(url, fallbackPrefix = "cloud_file") {
  if (!url) return `${fallbackPrefix}.bin`;
  try {
    const cleanUrl = url.split("?")[0].split("#")[0];
    const segments = cleanUrl.split("/").filter(Boolean);
    const last = segments.pop();
    if (last && last.includes(".")) {
      return decodeURIComponent(last).replace(/[\\/:*?"<>|]/g, "_");
    }
  } catch {}
  return `${fallbackPrefix}_${Date.now()}.bin`;
}
