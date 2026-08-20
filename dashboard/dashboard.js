import { getSettings, saveSettings, openDB, updateFileDownloadStatus, updatePostExtrasDownloaded, getAllLogs } from "../lib/db.js";
import { getLanguage, setLanguage, t } from "../lib/i18n.js";
import { downloadItems, buildPostFolderName, sanitizeForPath, findExistingVideoFile, planDownloadSteps, MIME_EXT_MAP, buildDescriptionFileText, formatCommentsText } from "../lib/downloader.js";
import { fetchCommentsRaw } from "../lib/tabProxy.js";
import { installConsoleCapture, logMilestone, flush as flushAppLog } from "../lib/appLog.js";

// console.warn/console.error dieses Tabs zusaetzlich ins persistente Log
// schreiben (Konsolenausgabe bleibt unveraendert erhalten).
installConsoleCapture("dashboard");
import { downloadViaYtDlp, pingYtDlpHost, installYtDlpViaHost, installDenoViaHost, pickFolderViaBridge, runBridgeUpdate, buildYtdlpFormat, checkFileExistsViaBridge, getDefaultDownloadDir, getBridgeLogs } from "../lib/nativeHost.js";
import { createVideoProgressTracker } from "../lib/videoProgress.js";
import { checkAndStartOnboarding, startTour, isTourRunning } from "./tour.js";
const state = {
  creators: [],
  activeCreatorId: null,
  posts: [],
  expanded: new Set(),
  selected: new Set(), // keys: `${postId}::${fileUrl}`
  lang: "en",
  settings: null,
  bulkFormat: "files", // "files" | "zip"
  bridgeReady: null, // null=unknown, true/false after ping
  targetOverallPct: 0,
  targetFilePct: 0,
  lastPostTitle: "",
  lastDoneCount: 0,
  lastTotalCount: 0,
  lastTotalWeightBytes: 0,
  lastWeightDoneBytes: 0,
  // Gewicht der bereits ABGESCHLOSSENEN Items (monoton) - Basis, auf die
  // setAggregateBytes() die live laufenden Bytes aller aktiven Zeilen addiert.
  lastSuccessWeightBytes: 0,
  // Gewicht ALLER abgearbeiteten Items (inkl. fehlgeschlagener/uebersprungener) -
  // nur fuer die ETA-Restmenge, nicht fuer die angezeigte GB-Zahl.
  lastProcessedWeightBytes: 0,
  // Rein monoton wachsender Zaehler tatsaechlich uebertragener Bytes. Treibt
  // AUSSCHLIESSLICH die Geschwindigkeitsmessung von calculateSmoothEta() -
  // damit eine nach unten korrigierte Gesamtgroesse (Schaetzung -> echte
  // Groesse) die ETA nicht mehr einfrieren lassen kann.
  transferredBytes: 0,
  // NUR fuer den "Download again"-Button-Text: rein session-lokal (kein DB-
  // Persistieren), damit ein Seiten-Refresh den Button wieder auf "Download"
  // zuruecksetzt. Die dauerhafte downloaded-Markierung (fuer "Hide already
  // downloaded"-Filter etc.) bleibt in der DB/im Post-Objekt unveraendert.
  sessionDownloaded: new Set(),
  // Live-Fortschritt PRO ZEILE (key = fileKey(postId,url,kind)), treibt die
  // Inline-Progressbars im Dashboard selbst (Variante 3 aus dem Umbau) -
  // unabhaengig vom globalen Ecke-Overlay. Werte: { status: 'queued'|'active'|
  // 'done'|'error'|'cancelled', received, total, itemWeight, postId }.
  activeDownloads: new Map(),
  // Pro-Item-Cancel-Signale (key = fileKey(...)) - erlauben es, genau EIN
  // aktives Item abzubrechen, ohne den Rest des Batches zu beruehren.
  itemCancelSignals: new Map(),
  // Waehrend TRUE sind die Batch-Ausloese-Buttons gesperrt (siehe
  // setBulkButtonsDisabled()) - verhindert einen zweiten, ueberlappenden
  // Batch, der sich denselben globalen Overlay-/Cancel-State teilen wuerde.
  isDownloading: false,
  // Verhindert, dass die Checkbox-Pop-Animation bei jedem 4s-Re-Render erneut abgespielt wird.
  animatedKeys: new Set(),
  // Never-decrease-Klammer fuer den Post-Aggregat-Balken (postId -> letzter
  // gezeigter Prozentwert). MUSS in state leben, nicht als Property direkt am
  // DOM-Element (card._lastShownAggPct) - .post-card-Elemente werden bei JEDEM
  // renderPostList()-Aufruf (u.a. der 4s-Periodik-Refresh) komplett neu
  // erzeugt, ein DOM-Property wuerde also bei jedem Re-Render wieder auf
  // undefined zurueckfallen und die Klammer wirkungslos machen - genau das
  // bekannte "State geht beim Re-Render verloren"-Muster aus HANDOFF.md.
  postAggPct: new Map(),
  // Erkannte Rate-Limit-/Missbrauchsschutz-Fehlschlaege (403/429/509 etc. von
  // Cloud-Anbietern) - siehe classifyDownloadError()/pushDownloadWarning().
  // Bleibt bis zum manuellen "Liste leeren" oder Tab-Refresh bestehen (reines
  // In-Memory, kein DB-Persistieren - dieselbe Session-only-Konvention wie
  // state.sessionDownloaded).
  // Quick-Jump Navigation State
  downloadWarnings: [],
  quickJumpIndex: 0,
  activeDownloadKeys: [],
  // postId -> Groesse der comments.txt in Bytes (oder 0, wenn es real keine
  // Kommentare gibt). Wird LAZY beim Aufklappen einer Post-Karte gefuellt, siehe
  // ensureCommentsSize().
  commentsSizes: new Map(),
};

const el = (id) => document.getElementById(id);
const L = (key, ...args) => t(state.lang, key, ...args);

function send(msg) {
  return chrome.runtime.sendMessage(msg);
}

function showToast(text) {
  const tEl = el("toast");
  tEl.textContent = text;
  tEl.classList.add("show");
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => tEl.classList.remove("show"), 3200);
}

function formatBytes(n) {
  if (!n) return "";
  const units = ["B", "KB", "MB", "GB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(1)} ${units[i]}`;
}

function formatDate(iso) {
  if (!iso) return "unknown date";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "unknown date";
  const day = String(d.getDate()).padStart(2, "0");
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const year = d.getFullYear();
  return `${day}/${month}/${year}`;
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str ?? "";
  return div.innerHTML;
}

function cleanTextForDisplay(text) {
  if (!text) return "";
  return text
    .replace(/https?:\/\/[^\s"''<>\\]+/gi, "")
    .replace(/\b[A-Z0-9\s._\-–—()]{2,40}:\s*(?=\n|$|\s)/g, "")
    .replace(/\(\s*\)/g, "")
    .replace(/\n\s*\n\s*\n/g, "\n\n")
    .trim();
}

function fileKey(postId, fileUrl, kindOrRole = "") {
  return `${postId}::${kindOrRole}::${fileUrl}`;
}

// Schlichte 2D-Vektor-Icons (kein Emoji) fuer Badges - nutzen currentColor,
// uebernehmen also automatisch die Farbe der jeweiligen Badge-Variante
// (.badge.locked / .badge.external-files in dashboard.css).
const ICON_LOCK = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="11" width="16" height="10" rx="2"></rect><path d="M8 11V7a4 4 0 0 1 8 0v4"></path></svg>`;
const ICON_LINK = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"></path><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"></path></svg>`;

// ---------- Inline-Progress pro Zeile/Post-Karte (Variante 3 des Umbaus) ----------
// Ersetzt das alte Modell "ein Item nach dem anderen, ein globaler Balken" -
// downloadItems() (lib/downloader.js) verarbeitet Items jetzt parallel
// (typbegrenzt ueber Concurrency-Pools), jede Zeile bekommt daher ihren
// EIGENEN Live-Fortschritt statt sich einen globalen Balken zu teilen.

// CSS.escape() ist fuer CSS-IDENTIFIER gedacht (Klassennamen/IDs), NICHT fuer
// den Inhalt eines Attribut-Selektor-STRINGS - bei URL-artigen Keys (Doppel-
// punkte, Slashes, Punkte, hex-aehnliche Zeichenfolgen wie z.B. "c10" aus
// Patreons CDN-Domains) kann das zu falsch interpretierten Escape-Sequenzen
// fuehren (z.B. \c10 als Unicode-Codepoint-Escape gelesen), wodurch der
// Selektor NIE matcht und jedes Zeilen-Update stillschweigend verworfen wird.
// Deshalb hier bewusst kein CSS-Selektor, sondern ein direkter, escapefreier
// Attribut-Vergleich in JS.
function findRowEl(key) {
  const rows = document.querySelectorAll(".file-row[data-key]");
  for (const row of rows) {
    if (row.getAttribute("data-key") === key) return row;
  }
  return null;
}

// downloader.js kennt fileKey()/UI-Zeilen bewusst nicht (bleibt UI-agnostisch,
// siehe CLAUDE.md-Architektur) - es uebergibt nur postId/url/kind, hier wird
// daraus der passende Zeilen-Key + ein Cancel-Signal-Objekt gebaut/wiederverwendet.
function getItemSignal({ postId, url, kind }) {
  const key = fileKey(postId, url, kind || "file");
  // Immer FRISCH anlegen (nicht ein evtl. bereits abgebrochenes altes Signal
  // wiederverwenden) - downloader.js ruft das genau einmal pro echtem neuen
  // Download-Versuch auf, daher ist "ueberschreiben" hier sicher und noetig:
  // sonst wuerde ein Retry desselben Items sofort als "cancelled" gelten, weil
  // der User es beim vorherigen Versuch abgebrochen hatte.
  const signal = { cancelled: false };
  state.itemCancelSignals.set(key, signal);
  return signal;
}

// Setzt/aktualisiert den Live-Zustand einer Zeile und patcht das DOM DIREKT
// (kein volles renderPostList() pro Byte-Tick - bei mehreren gleichzeitig
// laufenden Items waere das spuerbar ruckelig).
function setRowProgress(key, patch) {
  const prev = state.activeDownloads.get(key) || {};
  // REIHENFOLGE IST KRITISCH: alreadyFinal MUSS vor dem `delete prev.status`
  // weiter unten ermittelt werden. Vorher stand das delete zuerst - `prev` ist
  // dieselbe Objektreferenz wie der Eintrag in state.activeDownloads, das delete
  // mutiert also den gespeicherten Zustand. alreadyFinal war dadurch bei einem
  // "scanning"-Patch IMMER false und der Schutz gegen verspaetete Ticks lief
  // ins Leere: ein spaeter eintreffendes phase:"working" konnte eine laengst
  // abgeschlossene Zeile wieder auf "scanning" zuruecksetzen. Solche
  // wiederbelebten Zeilen gelten in updatePostAggregateUI() als "laeuft noch" -
  // der Post-Aggregatbalken bleibt dann dauerhaft im Akzent-Orange stehen,
  // statt sich in gruen/rot aufzuteilen.
  const alreadyFinal = prev.status === "done" || prev.status === "error" || prev.status === "cancelled";
  const sig = state.itemCancelSignals.get(key);
  if ((patch.status === "active" || patch.status === "scanning") && (alreadyFinal || sig?.cancelled)) return;
  if (patch.status === "queued" || patch.status === "scanning") {
    delete prev.status;
    delete prev.received;
    delete prev.total;
    delete prev.pct;
    prev._lastShownPct = 0;
    if (patch.postId != null) {
      state.postAggPct.delete(patch.postId);
    }
  }
  const info = { ...prev, ...patch };
  state.activeDownloads.set(key, info);
  updateRowUI(key, info);
  if (info.postId != null) updatePostAggregateUI(info.postId);
}

function updateRowUI(key, info, targetRow = null) {
  const row = targetRow || findRowEl(key);
  if (!row) return; // Zeile aktuell nicht gerendert (Filter/eingeklappt-aber-existent) - state bleibt Quelle der Wahrheit, wird beim naechsten renderPostList() nachgeholt
  const progressEl = row.querySelector(".row-progress");
  const fillEl = row.querySelector(".row-progress-fill");
  const textEl = row.querySelector(".row-progress-text");
  const btn = row.querySelector(".fdl-btn");
  if (!progressEl || !fillEl || !textEl || !btn) return;

  // Erst-Anstrich-Schutz wie beim Post-Aggregatbalken: `.row-progress-fill` hat
  // dieselbe `transition: width .2s ease, background .2s ease` und startet nach
  // einem Re-Render ebenfalls bei `width:0%` / `background: var(--accent)`
  // (= #ff5a3c, orangerot). Ohne das blitzt JEDE bereits fertige Zeile beim
  // 4-Sekunden-Refresh nach dem Download kurz rot auf, bevor sie wieder gruen
  // wird (in Runde 20 als bekannt notiert, damals bewusst nicht angefasst).
  primeAggFill(fillEl);

  // Groessenspalte (.fsize, links vom Button) SOFORT mitschreiben, sobald die
  // echte Groesse bekannt ist - nicht erst beim naechsten renderPostList().
  //
  // Vorher wurde `.fsize` AUSSCHLIESSLICH in renderPostList() gefuellt (aus
  // `r.size` bzw., fuer Zeilen ohne vorab bekannte Groesse, aus
  // `liveInfo.total`). Waehrend eines Batches rendert die Liste aber bewusst
  // nicht neu (showProgress() stoppt den 4s-Refresh, siehe HANDOFF Runde 7) -
  // die Groesse einer fertigen Datei erschien deshalb erst, wenn der GESAMTE
  // Batch durch war und der Refresh wieder ansprang. Genau das war die
  // Nutzer-Meldung "Groesse soll direkt nach dieser einen Datei stehenbleiben".
  const sizeEl = row.querySelector(".fsize");
  if (sizeEl && info) {
    if (info.total > 0) {
      sizeEl.textContent = formatBytes(info.total);
      sizeEl.style.display = "inline";
    } else if (info.empty && !sizeEl.textContent) {
      // Schritt ist fertig, es gibt aber keinen Byte-Wert (Description/Comments
      // ohne Inhalt bzw. bereits vorhandene Datei) - "-" statt einer
      // unerklaerlich leeren Spalte.
      sizeEl.textContent = "–";
      sizeEl.style.display = "inline";
    }
  }

  if (!info || info.status === "queued") {
    row.classList.remove("done-session");
    row.classList.remove("downloaded");
    progressEl.style.display = info ? "flex" : "none";
    // "queued" heisst: eingeplant, aber noch nicht gestartet - typischerweise,
    // weil der Concurrency-Pool des Anbieters gerade voll ist (Google Drive
    // z.B. 3 gleichzeitig, siehe CLOUD_POOL_LIMITS in downloader.js). Vorher
    // war das ein LEERER Balken bei 0% mit dem Text "Waiting..." - optisch nicht
    // von "haengt bei 0%" zu unterscheiden, und genau so wurde es auch gemeldet.
    // Jetzt ein eigener, bewusst dezenter Wartezustand (langsamer Puls, dunkler
    // als der hellere "Scanning"-Shimmer, den ein tatsaechlich arbeitender
    // Anbieter-Scan zeigt).
    fillEl.style.width = info ? "100%" : "0%";
    fillEl.className = info ? "row-progress-fill row-progress-waiting" : "row-progress-fill";
    textEl.textContent = info ? L("waiting") : "";
    if (info) {
      btn.textContent = L("cancel");
      btn.classList.add("row-cancel-btn");
    }
    return;
  }
  if (info.status === "scanning") {
    row.classList.remove("done-session");
    row.classList.remove("downloaded");
    progressEl.style.display = "flex";
    fillEl.style.width = "100%";
    fillEl.className = "row-progress-fill row-progress-scanning";
    textEl.textContent = L("scanning");
    btn.textContent = L("cancel");
    btn.classList.add("row-cancel-btn");
    return;
  }
  if (info.status === "active") {
    row.classList.remove("done-session");
    row.classList.remove("downloaded");
    progressEl.style.display = "flex";
    let pct = 0;
    let byteInfo = "";
    if (info.total > 0) {
      pct = Math.min(100, Math.round((info.received / info.total) * 100));
      byteInfo = ` · ${formatBytes(info.received)} / ${formatBytes(info.total)}`;
    } else if (info.pct != null) {
      // Kein Byte-Wert bekannt (z.B. yt-dlp-Embed-Video meldet nur Prozent) -
      // trotzdem eine sinnvolle Bar zeigen statt "0%/leer".
      pct = Math.min(100, Math.round(info.pct));
      // Bei grossen Cloud-Ordnern ist zwar die Gesamtgroesse unbekannt, die
      // bereits uebertragene Menge aber sehr wohl - dann wenigstens DIE zeigen
      // ("42% · 1.2 GB") statt einer nackten Prozentzahl.
      if (info.received > 0) byteInfo = ` · ${formatBytes(info.received)}`;
    }
    // Balken darf nie rueckwaerts springen - kleine Schwankungen in den
    // Rohdaten (Datei-Wechsel in einem Cloud-Ordner, nachtraeglich
    // korrigierte Gesamtgroesse mittendrin) sollen nicht wie ein Ruckler
    // wirken. info ist dieselbe Objektreferenz wie in state.activeDownloads,
    // die Mutation hier bleibt also fuer den naechsten Tick erhalten. Der
    // geclampte Wert wird auch in der Prozent-Textanzeige verwendet, damit
    // Balkenbreite und Text nie auseinanderlaufen.
    pct = Math.max(pct, info._lastShownPct || 0);
    info._lastShownPct = pct;
    fillEl.style.width = `${pct}%`;
    fillEl.className = "row-progress-fill";
    textEl.textContent = `${pct}%${byteInfo}`;
    btn.textContent = L("cancel");
    btn.classList.add("row-cancel-btn");
    return;
  }
  if (info.status === "done") {
    row.classList.add("done-session");
    row.classList.add("downloaded");
    if (!state.animatedKeys.has(key)) {
      state.animatedKeys.add(key);
      row.classList.add("pop-animate");
      setTimeout(() => row.classList.remove("pop-animate"), 400);
    }
    progressEl.style.display = "flex";
    fillEl.style.width = "100%";
    fillEl.className = "row-progress-fill row-progress-done";
    textEl.textContent = L("doneShort");
    btn.textContent = L("reload");
    btn.classList.remove("row-cancel-btn");
    return;
  }
  if (info.status === "error") {
    progressEl.style.display = "flex";
    fillEl.style.width = "100%";
    fillEl.className = "row-progress-fill row-progress-error";
    textEl.textContent = L("errorShort");
    btn.textContent = L("reload");
    btn.classList.remove("row-cancel-btn");
    return;
  }
  if (info.status === "cancelled") {
    progressEl.style.display = "flex";
    fillEl.style.width = "100%";
    fillEl.className = "row-progress-fill row-progress-cancelled";
    textEl.textContent = L("cancelledShort");
    btn.textContent = L("load");
    btn.classList.remove("row-cancel-btn");
    return;
  }
}

// Aggregat-Balken oben in der Post-Karte: Durchschnitt der Prozentwerte aller
// gerade AKTIV ladenden Zeilen dieses Posts. Bewusst kein byte-genaues
// Aggregat (das liefert schon die globale Ecke-Zusammenfassung) - hier reicht
// ein grober visueller Hinweis "hier laedt gerade etwas".
function findPostCardEl(postId) {
  const idStr = String(postId);
  const cards = document.querySelectorAll(".post-card[data-post-id]");
  for (const card of cards) {
    if (card.getAttribute("data-post-id") === idStr) return card;
  }
  return null;
}

// Gewicht EINER Zeile fuer alle Aggregat-Rechnungen. Reihenfolge bewusst:
// echte Gesamtgroesse (v.total) > das von downloader.js mitgelieferte
// Item-Gewicht (echte sizeBytes bzw. SIZE_ESTIMATE.*) > kleiner Default.
// Vorher wurde ausschliesslich `v.total || 500 KB` benutzt - ein Cloud-Item,
// dessen Groesse noch gescannt wird, zaehlte damit wie eine 500-KB-Textdatei,
// wodurch der Post-Balken waehrend der (oft 1-3 Minuten dauernden) Scan-Phase
// schon fast voll aussah, obwohl der eigentlich groesste Teil noch gar nicht
// angefangen hatte.
function rowWeight(v) {
  if (v?.total > 0) return v.total;
  const est = v?.itemWeight > 0 ? v.itemWeight : 500 * 1024;
  // Gesamtgroesse unbekannt (grosser Cloud-Ordner ohne Vorab-Vermessung): dann
  // ist die Schaetzung nur so lange brauchbar, wie sie ueber dem liegt, was
  // tatsaechlich schon geflossen ist. Ohne dieses Anwachsen deckelt die
  // 800-MB-Schaetzung einen real 6,5 GB grossen Ordner - der Post-Balken steht
  // dann bei 100%, obwohl noch Minuten laufen, und die Summen stimmen nicht.
  if (v?.received > est) return v.received;
  return est;
}

// Wie viele Bytes dieser Zeile sind bereits geflossen (0 wenn unbekannt)?
function rowReceived(v) {
  if (v?.received > 0) return v.received;
  if (v?.pct > 0 && v?.itemWeight > 0) return (v.pct / 100) * v.itemWeight;
  return 0;
}

function isRowLive(v) {
  return v?.status === "active" || v?.status === "queued" || v?.status === "scanning";
}

// ---------- Monotoner Fortschritt bei WACHSENDEM Nenner ----------
//
// Beide Aggregat-Anzeigen (Ecke + Post-Karte) rechnen "verarbeitete Bytes /
// Gesamt-Bytes". Der Nenner ist am Anfang aber nur eine Schaetzung
// (SIZE_ESTIMATE.*) und wird korrigiert, sobald echte Groessen bekannt werden.
// Wird eine 15-MB-Schaetzung zu einer echten 5-GB-Datei, faellt das Verhaeltnis
// schlagartig - und eine rein monotone Klammer (Math.max auf den zuletzt
// gezeigten Wert, so war es bisher an BEIDEN Stellen) laesst die Bar dann
// einfrieren, bis die neue Rechnung den alten Wert wieder eingeholt hat. Bei
// einer grossen Datei am Ende eines Batches heisst das: Bar steht bei ~40% und
// bewegt sich minutenlang gar nicht mehr, um am Schluss auf 100% zu springen.
//
// Loesung: bei so einer Nenner-Vergroesserung wird NEU VERANKERT - der aktuell
// gezeigte Prozentwert wird zum Nullpunkt, das verbleibende Byte-Budget bildet
// die restlichen Prozent ab:
//     pct = anchorPct + (100 - anchorPct) * (processed - anchorBytes) / (total - anchorBytes)
// Damit ist die Anzeige weiterhin streng monoton (kein Rueckwaertsspringen),
// laeuft aber ab sofort wieder mit, und erreicht garantiert exakt 100%, sobald
// processed == total.
//
// `st` ist ein einfaches Objekt { shown, anchorPct, anchorBytes } - fuer die
// Ecke eine Modulvariable, fuer die Post-Karten je ein Eintrag in
// state.postAggPct. Bewusst EINE Implementierung fuer beide (siehe
// CLAUDE.md/HANDOFF.md zum Duplikat-Fehlermuster).
function newProgressAnchor() {
  return { shown: 0, anchorPct: 0, anchorBytes: 0 };
}

function advanceAnchoredProgress(st, processedBytes, totalBytes) {
  if (!(totalBytes > 0)) return st.shown || 0;
  const processed = Math.max(0, Math.min(processedBytes || 0, totalBytes));
  if (st.anchorBytes > processed) st.anchorBytes = processed; // Sicherheitsnetz
  const span = totalBytes - st.anchorBytes;
  const raw = span > 0
    ? st.anchorPct + (100 - st.anchorPct) * ((processed - st.anchorBytes) / span)
    : 100;
  if (raw < st.shown) {
    // Nenner ist gewachsen -> hier neu verankern statt einzufrieren.
    st.anchorPct = st.shown;
    st.anchorBytes = processed;
    return st.shown;
  }
  st.shown = Math.min(100, raw);
  return st.shown;
}

// Ab dieser eingeplanten Groesse ist eine "arbeitet, Groesse noch unbekannt"-
// Phase lang genug, um sie in den Aggregat-Anzeigen zu melden. Description/
// Comments melden ebenfalls phase:"working" (Status "scanning"), sind aber in
// Sekundenbruchteilen durch - dafuer soll die Ecke nicht jedes Mal auf
// "calculating…" umspringen.
const SIZING_MIN_WEIGHT = 1024 * 1024;

function isSizingRow(v) {
  return v?.status === "scanning" && (v.itemWeight || 0) >= SIZING_MIN_WEIGHT;
}

// Irgendeine Zeile wartet gerade darauf, dass ein Anbieter die echte Groesse
// liefert (Google-Drive-Baumscan, MEGA-Ordnerliste, yt-dlp-Aufloesung - in der
// Praxis 1-3 Minuten)? Genau dasselbe Signal, das die Zeile selbst grau pulsen
// laesst - wird jetzt AUCH von den beiden Aggregat-Anzeigen ausgewertet, statt
// nur auf Zeilenebene konsumiert zu werden.
function anyRowScanning() {
  for (const v of state.activeDownloads.values()) {
    if (isSizingRow(v)) return true;
  }
  return false;
}

// Laeuft gerade ein Item, dessen echte Gesamtgroesse gar nicht bekannt ist
// (grosser Cloud-Ordner ohne Vorab-Vermessung)? Dann ist die angezeigte
// Gesamtsumme nur eine Schaetzung und wird mit "~" markiert.
function anyRowUnknownTotal() {
  for (const v of state.activeDownloads.values()) {
    if (v?.status === "active" && v.unknownTotal) return true;
  }
  return false;
}

// Setzt die Breite des Post-Aggregatbalkens. Beim ERSTEN Setzen nach einem
// Re-Render wird die CSS-Transition kurz abgeschaltet.
//
// Hintergrund: renderPostList() baut saemtliche .post-card-Knoten neu auf, das
// frische .post-agg-fill startet dadurch bei der CSS-Vorgabe `width: 0%`. Die
// Regel `.post-agg-fill { transition: width .25s ease }` animiert die direkt
// danach gesetzte echte Breite also von 0 hoch - der Balken "laeuft sichtbar
// von vorne los", obwohl fachlich nichts zurueckgesetzt wurde. Passiert bei
// jedem Re-Render waehrend eines Downloads (Karte auf-/zuklappen, Checkbox,
// Filter, Abschluss eines Einzel-Downloads) und war damit genau das gemeldete
// "manchmal faengt die Postprogressbar von vorne an".
// Schaltet die CSS-Transition eines frisch gerenderten .post-agg-fill fuer den
// gesamten ERSTEN Anstrich ab - Breite UND Farbe.
//
// Die Breite allein zu behandeln hat nicht gereicht: `.post-agg-fill` startet
// laut CSS nicht nur bei `width: 0%`, sondern auch bei
// `background: var(--accent)` - und --accent ist #ff5a3c, also ein kraeftiges
// Orangerot. Die Regel `transition: width .25s ease, background .25s ease`
// (dashboard.css:411) animiert deshalb bei JEDEM Re-Render den Uebergang
// Rot -> Gruen sichtbar mit, sobald updatePostAggregateUI() die echte Farbe
// setzt. Der erzwungene Reflow (`void offsetWidth`) der frueheren Fassung hat
// das sogar garantiert, weil er den roten Ausgangszustand als "before-change
// style" der Transition festschreibt.
//
// Nach einem Download laeuft der 4-Sekunden-Refresh (hideProgress() startet
// creatorRefreshInterval -> refreshActivePosts() -> renderPostList()) wieder -
// deshalb war das gemeldete Symptom ein Balken, der nach Abschluss regelmaessig
// kurz rot aufblitzt, obwohl alles erfolgreich war.
//
// requestAnimationFrame stellt die Transition erst wieder her, NACHDEM der
// erste Anstrich (Breite + Farbe) uebernommen wurde - spaetere Aenderungen
// derselben, im DOM verbleibenden Zeile animieren also weiterhin normal.
function primeAggFill(fillEl) {
  if (!fillEl || fillEl.dataset.paPainted === "1") return;
  fillEl.dataset.paPainted = "1";
  const prevTransition = fillEl.style.transition;
  fillEl.style.transition = "none";
  requestAnimationFrame(() => {
    fillEl.style.transition = prevTransition;
  });
}

function setAggFillWidth(fillEl, pct) {
  const value = `${pct}%`;
  if (fillEl.style.width === value) return;
  primeAggFill(fillEl);
  fillEl.style.width = value;
}

function updatePostAggregateUI(postId) {
  const card = findPostCardEl(postId);
  if (!card) return;
  const aggEl = card.querySelector(".post-agg-progress");
  const fillEl = card.querySelector(".post-agg-fill");
  const textEl = card.querySelector(".post-agg-text");
  if (!aggEl || !fillEl) return;
  // MUSS vor jedem Setzen von Breite ODER Farbe passieren (nicht erst in
  // setAggFillWidth()): sonst animiert der erste Anstrich einer frisch
  // gerenderten Karte sichtbar vom roten CSS-Ausgangswert var(--accent) auf
  // die tatsaechliche Farbe - siehe primeAggFill().
  primeAggFill(fillEl);
  const entries = [...state.activeDownloads.values()].filter((v) => String(v.postId) === String(postId));
  if (entries.length === 0) {
    aggEl.style.display = "none";
    if (textEl) textEl.textContent = "";
    fillEl.classList.remove("post-agg-scanning");
    state.postAggPct.delete(postId);
    return;
  }

  // Laeuft ueberhaupt noch ein Download? Wenn NICHT (state.isDownloading ist
  // false, sobald hideProgress() gelaufen ist), duerfen uebriggebliebene
  // "queued"/"active"/"scanning"-Eintraege den Aggregatbalken nicht laenger
  // blockieren - sie koennen nur noch Karteileichen sein (z.B. eine
  // Thumbnail-Zeile, die als Post-Extra automatisch mitlief und deshalb von
  // downloadMany()s finalizeRow-Schleife gar nicht erfasst wird). Ohne diese
  // Klammer bleibt EIN solcher Eintrag ausreichend, damit der Balken fuer
  // immer im Akzent-Orange haengt statt sich gruen/rot aufzuteilen.
  const stillGoing = state.isDownloading ? entries.filter(isRowLive) : [];
  const settled = entries.filter((v) => !stillGoing.includes(v));

  const bucket = (name) => settled.filter((v) => v.status === name);
  const doneRows = bucket("done");
  const errorRows = bucket("error");
  const cancelledRows = bucket("cancelled");
  // Nicht terminierte Karteileichen (siehe oben) zaehlen als "unbekannt" und
  // werden wie Fehler behandelt - besser sichtbar rot als stillschweigend gruen.
  const unknownRows = settled.filter(
    (v) => v.status !== "done" && v.status !== "error" && v.status !== "cancelled"
  );

  if (stillGoing.length === 0) {
    aggEl.style.display = "flex";
    setAggFillWidth(fillEl, 100);
    fillEl.classList.remove("post-agg-scanning");
    // `finished` markiert: dieser Post war komplett durch. Startet spaeter ein
    // NEUER (Teil-)Download desselben Posts, faengt der Balken mit einem
    // frischen Anker an, statt bei 100% kleben zu bleiben (siehe unten).
    state.postAggPct.set(postId, { shown: 100, anchorPct: 100, anchorBytes: 0, finished: true });

    const totalCount = settled.length;
    const countDone = doneRows.length;
    const countWarn = cancelledRows.length;
    const countErr = errorRows.length + unknownRows.length;

    const setSolid = (color) => {
      fillEl.style.backgroundImage = "none";
      fillEl.style.backgroundColor = color;
    };

    if (totalCount <= 0 || (countWarn === 0 && countErr === 0)) {
      setSolid("var(--green)");
      if (textEl) textEl.textContent = L("doneShort");
      const postSelect = card.querySelector(".post-select");
      if (postSelect) {
        postSelect.classList.add("done-session");
        const animKey = `post-select-${postId}`;
        if (!state.animatedKeys.has(animKey)) {
          state.animatedKeys.add(animKey);
          postSelect.classList.add("pop-animate");
          setTimeout(() => postSelect.classList.remove("pop-animate"), 400);
        }
      }
    } else if (countDone === 0 && countErr === 0) {
      setSolid("var(--warn)");
      if (textEl) textEl.textContent = L("cancelledShort");
    } else if (countDone === 0 && countWarn === 0) {
      setSolid("#e74c3c");
      if (textEl) textEl.textContent = L("errorShort");
    } else {
      // Gemischter Zustand -> proportionaler Gruen/Gelb/Rot-Verlauf nach ANZAHL DER DATEIEN
      const pGreen = (countDone / totalCount) * 100;
      const pWarn = (countWarn / totalCount) * 100;
      const pErr = (countErr / totalCount) * 100;
      const stops = [];
      let curr = 0;
      if (pGreen > 0) { stops.push(`#38c172 ${curr}%`, `#38c172 ${curr + pGreen}%`); curr += pGreen; }
      if (pWarn > 0) { stops.push(`#f5a623 ${curr}%`, `#f5a623 ${curr + pWarn}%`); curr += pWarn; }
      if (pErr > 0) { stops.push(`#e74c3c ${curr}%`, `#e74c3c ${curr + pErr}%`); curr += pErr; }
      fillEl.style.backgroundColor = "transparent";
      fillEl.style.backgroundImage = `linear-gradient(90deg, ${stops.join(", ")})`;
      const textParts = [];
      if (countDone > 0) textParts.push(`${countDone} ✓`);
      if (countWarn > 0) textParts.push(`${countWarn} ✕`);
      if (countErr > 0) textParts.push(`${countErr} !`);
      if (textEl) textEl.textContent = textParts.join(" · ");
    }
    return;
  }

  // Solange noch irgendein Item dieses Posts laeuft, bleibt der Balken
  // schlicht im Akzentton
  aggEl.style.display = "flex";
  fillEl.style.backgroundColor = "var(--accent)";

  // Hybrider Fortschritt: Anzahl fertiger/abgeschlossener Items + Live-Stream-Fortschritt aktiver Items
  const totalEntries = entries.length;
  let finishedCount = 0;
  let activeProgressSum = 0;
  let scanningCount = 0;

  entries.forEach((v) => {
    if (v.status === "done" || v.status === "error" || v.status === "cancelled") {
      finishedCount += 1;
    } else if (v.status === "active") {
      const rec = rowReceived(v);
      const tot = rowTotal(v) || rowWeight(v);
      if (tot > 0 && rec > 0) {
        activeProgressSum += Math.min(1, rec / tot);
      }
    } else if (v.status === "scanning") {
      if (isSizingRow(v)) scanningCount++;
    }
  });

  const liveRatio = totalEntries > 0 ? (finishedCount + activeProgressSum) / totalEntries : 0;
  const rawPct = Math.min(100, liveRatio * 100);

  let anchor = state.postAggPct.get(postId);
  if (!anchor || typeof anchor !== "object" || anchor.finished) anchor = newProgressAnchor();
  const smoothedPct = advanceAnchoredProgress(anchor, rawPct, 100);
  state.postAggPct.set(postId, anchor);

  const pct = Math.min(99, Math.round(smoothedPct));
  setAggFillWidth(fillEl, pct);

  if (scanningCount > 0) {
    fillEl.classList.add("post-agg-scanning");
    fillEl.style.backgroundImage =
      "linear-gradient(90deg, rgba(255,255,255,0) 0%, rgba(255,255,255,.45) 50%, rgba(255,255,255,0) 100%)";
  } else {
    fillEl.classList.remove("post-agg-scanning");
    fillEl.style.backgroundImage = "none";
  }
  if (textEl) {
    const settledCount = entries.length - stillGoing.length;
    const parts = [`${settledCount}/${entries.length}`, `${pct}%`];
    if (sumBytesTotal > 0) {
      // "~" markiert eine noch geschaetzte Gesamtgroesse - ehrlicher als eine
      // exakt aussehende Zahl, die sich gleich noch um Groessenordnungen aendert.
      const approx = scanningCount > 0 || entries.some((v) => isRowLive(v) && !(v.total > 0));
      parts.push(`${formatBytes(sumBytesReceived)} / ${approx ? "~" : ""}${formatBytes(sumBytesTotal)}`);
    }
    if (scanningCount > 0) parts.push(L("scanning"));
    textEl.textContent = parts.join(" · ");
  }
}

// Kurzer Abschluss-Flash (gruen/rot/orange), dann verschwindet die Inline-Bar
// wieder - die Zeile zeigt danach wieder ihren normalen Button-Zustand,
// getrieben von state.sessionDownloaded (siehe renderPostList()).
// Terminaler Zustand (done/error/cancelled) bleibt ABSICHTLICH dauerhaft
// sichtbar (gruen/rot/gelb, gefuellt) - kein Auto-Hide mehr. Reset passiert
// nur beim Neuladen/Refresh des Tabs (state ist reines In-Memory-JS, wie das
// bestehende state.sessionDownloaded-Muster) oder wenn erneut heruntergeladen
// wird (der naechste setRowProgress(key, {status:"queued"}) beim naechsten
// Download-Versuch ueberschreibt den Zustand ganz natuerlich wieder).
function finalizeRow(key, status) {
  const prev = state.activeDownloads.get(key) || {};
  setRowProgress(key, { ...prev, status });
  state.itemCancelSignals.delete(key); // Signal-Objekt wird nicht mehr gebraucht, der Balken selbst bleibt aber stehen
}

// Erkennt bekannte Rate-Limit-/Missbrauchsschutz-Muster in einer Bridge-
// Fehlermeldung (z.B. "Response status code does not indicate success: 509
// (Bandwidth Limit Exceeded)."). Liefert null, wenn es kein bekanntes Muster
// ist (dann bleibt der normale rote Fehler-Zustand der Zeile die einzige
// Rueckmeldung, kein zusaetzlicher Eintrag im Warn-Indikator).
function classifyDownloadError(errorMsg, providerTag) {
  const msg = errorMsg || "";
  const provider = providerTag || "Provider";
  // Bekannter, aber (noch) nicht unterstuetzter Cloud-Anbieter - kein Fehler im
  // eigentlichen Sinn, sondern eine Funktionsluecke. Wird von downloader.js
  // gesetzt (siehe unsupportedProviderOf()), BEVOR ueberhaupt ein Download-
  // Versuch startet.
  const unsupported = /^unsupported cloud provider:\s*(.+)$/i.exec(msg);
  if (unsupported) {
    const prov = unsupported[1].trim() || provider;
    return {
      title: `${prov}: not supported for automatic download`,
      detail:
        `This post links to a file on ${prov}, which isn't a supported cloud provider for automatic download yet. ` +
        `The link itself is saved in "_download_links.txt" inside the post folder - please download it manually from there. ` +
        `If you'd like support for ${prov} added, let us know at https://github.com/r1kp/patreon-archiver-extension/issues`,
    };
  }
  if (/\b509\b/.test(msg) || /bandwidth limit/i.test(msg)) {
    return {
      title: `${provider}: Bandwidth Limit Exceeded (509)`,
      detail: `${provider} has temporarily throttled anonymous download bandwidth for this link (this is not an issue in the extension). Waiting a few hours, signing in with an account on ${provider}, or opening the link from "_download_links.txt" in the post folder will resolve this.`,
    };
  }
  if (/\b403\b/.test(msg) || /forbidden/i.test(msg) || /captcha/i.test(msg) || /hotlink/i.test(msg)) {
    return {
      title: `${provider}: Access Restricted (403)`,
      detail: `${provider} has temporarily restricted this link due to high download volume or requires human captcha verification. Please wait a bit or open the direct link from "_download_links.txt".`,
    };
  }
  if (/\b429\b/.test(msg) || /too many requests/i.test(msg)) {
    return {
      title: `${provider}: Too Many Requests (429)`,
      detail: `${provider} received too many requests in a short period. Please wait a moment and try downloading again.`,
    };
  }
  // Catch-all statt null: jeder nicht abgebrochene Fehlschlag soll im
  // Warn-Icon auftauchen, nicht nur die drei oben explizit erkannten Muster
  // (z.B. HTTP 500 von Google Drive wurde vorher komplett verworfen - siehe
  // HANDOFF.md).
  return {
    title: `${provider}: Download Failed`,
    detail: msg
      ? `${provider} reported: "${msg}"`
      : `${provider} download failed for an unknown reason. Check the console (F12) for details or try again.`,
  };
}

function pushDownloadWarning({ title, detail, postTitle, filename }) {
  state.downloadWarnings.push({ title, detail, postTitle, filename, timestamp: Date.now() });
  updateDownloadWarningsUI();
}

function updateDownloadWarningsUI() {
  const btn = el("downloadWarningsBtn");
  const countEl = el("downloadWarningsCount");
  if (!btn || !countEl) return;
  const n = state.downloadWarnings.length;
  btn.style.display = n > 0 ? "flex" : "none";
  countEl.textContent = String(n);
}

function renderDownloadWarningsModal() {
  const listEl = el("downloadWarningsList");
  if (!listEl) return;
  if (state.downloadWarnings.length === 0) {
    listEl.innerHTML = `<p style="color: var(--text-dim); font-size: 13px; text-align: center; padding: 24px 0;">No issues recorded.</p>`;
    return;
  }
  listEl.innerHTML = [...state.downloadWarnings].reverse().map((w) => {
    const timeStr = w.timestamp ? new Date(w.timestamp).toLocaleString() : "";
    const meta = [w.postTitle, w.filename, timeStr].filter(Boolean).join(" · ");
    return `<div class="download-warning-item">
      <span class="dw-badge">Notice</span>
      <span class="dw-title">${escapeHtml(w.title)}</span>
      ${meta ? `<div class="dw-meta">${escapeHtml(meta)}</div>` : ""}
      <div class="dw-detail">${escapeHtml(w.detail)}</div>
    </div>`;
  }).join("");
}

// Zentrale Quelle aller auswählbaren/herunterladbaren Elemente eines Posts,
// damit Thumbnail, Video und reguläre Dateien überall gleich behandelt werden
// (Auswahl, "Alle auswählen", Sammel-Download). "filesOnlyForFilter" enthält
// die bereits gefilterten regulären Dateien (aus getFilteredPosts).
function selectableItems(post, filteredFiles) {
  const items = [];
  const files = filteredFiles !== undefined ? filteredFiles : post.files || [];
  const hasOtherContent = !!post.thumbnail || !!post.video || files.length > 0;

  // Reihenfolge (vom User festgelegt): Description, Comments, dann Thumbnail,
  // dann der Rest (Video/Dateien) - NUR wenn der Post auch sonst Inhalt hat;
  // reine Text-Posts (siehe unten, "extras") behalten den bisherigen
  // kombinierten Weg, sonst gaebe es fuer sie doppelte/redundante Zeilen.
  if (hasOtherContent && !post.locked) {
    items.push({
      key: fileKey(post.id, `${post.id}::description`, "description"),
      kind: "description",
      download: () => downloadDescription(post),
    });
    if ((post.commentCount || 0) > 0) {
      items.push({
        key: fileKey(post.id, `${post.id}::comments`, "comments"),
        kind: "comments",
        download: () => downloadComments(post),
      });
    }
  }
  if (post.thumbnail) {
    items.push({
      key: fileKey(post.id, post.thumbnail.url || `${post.id}::thumb`, "thumbnail"),
      kind: "thumbnail",
      download: () => downloadThumbnail(post),
    });
  }
  if (post.video?.type === "native") {
    items.push({
      key: fileKey(post.id, post.video.url || `${post.id}::video`, "video"),
      kind: "video",
      download: () => downloadNativeVideo(post),
    });
  } else if (post.video?.type === "embed") {
    items.push({
      key: fileKey(post.id, post.video.url || `${post.id}::embed`, "embed"),
      kind: "embed",
      download: () => downloadEmbedViaYtDlp(post),
    });
  }
  files.forEach((file) => {
    items.push({ key: fileKey(post.id, file.url, file.kind || "file"), kind: file.kind, file, download: () => downloadOne(post, file) });
  });
  // Text-only posts (no thumbnail/video/files) can still have description + comments downloaded
  const hasTextContent = !!(post.text && post.text.trim()) || (post.commentCount || 0) > 0;
  if (items.length === 0 && hasTextContent && !post.locked) {
    // Key jetzt im normalen fileKey()-Format (vorher `${post.id}::extras` roh).
    // Grund: der Bulk-Pfad (downloadMany) berechnet seine Zeilen-/Session-Keys
    // IMMER als fileKey(postId, file.url, file.kind) - mit dem rohen Format
    // liefen Auswahl-Key und Download-Key auseinander, "Download again" und der
    // gruene Zeilenzustand haetten fuer Text-Posts nie gegriffen.
    items.push({
      key: fileKey(post.id, `${post.id}::extras`, "extras"),
      kind: "extras",
      download: () => downloadPostExtras(post),
    });
  }
  return items;
}

// ---------- i18n: statische Texte anwenden ----------
function applyStaticTranslations() {
  document.title = L("appName") + " · Dashboard";
  el("appTitle").textContent = L("appName");
  el("sidebarSub").textContent = L("sidebarSub");
  el("settingsBtnLabel").textContent = L("settingsTitle");
  el("emptyTitle").textContent = L("emptyTitle");
  el("emptyText").textContent = L("emptyText");
  el("deleteCreatorBtn").textContent = L("remove");
  el("searchInput").placeholder = L("searchPlaceholder");

  el("typeFilter").innerHTML = `
    <option value="all">${L("typeAll")}</option>
    <option value="video">Video</option>
    <option value="thumbnail">Thumbnail</option>
    <option value="files">Download files</option>
  `;
  el("lockFilter").innerHTML = `
    <option value="all">All posts</option>
    <option value="unlocked">Unlocked only</option>
    <option value="locked">Locked only</option>
  `;
  el("sortOrder").innerHTML = `
    <option value="desc">${L("sortDesc")}</option>
    <option value="asc">${L("sortAsc")}</option>
  `;

  el("datePositionSelect").innerHTML = `
    <option value="prefix">${L("dateOptionPrefix")}</option>
    <option value="suffix">${L("dateOptionSuffix")}</option>
    <option value="none">${L("dateOptionNone")}</option>
  `;

  el("selectAllLabel").textContent = L("selectAllVisible");
  el("formatFilesBtn").textContent = L("downloadAsFiles");
  el("formatZipBtn").textContent = L("downloadAsZip");
  el("downloadSelectedBtn").textContent = L("downloadSelected");
  el("downloadAllBtn").textContent = L("downloadAllFiltered");

  const setText = (id, val) => { const e = el(id); if (e) e.textContent = val; };
  setText("settingsTitle", L("settingsTitle"));
  setText("settingsStorageLabel", L("settingsStorage"));
  setText("storageModeDownloadsLabel", L("storageModeDownloads"));
  setText("storageModeCustomLabel", L("storageModeCustom"));
  setText("chooseFolderBtn", L("chooseFolderBtn"));
  setText("saveSettingsBtn", L("saveSettings"));
  setText("namingLabel", L("namingLabel"));
  setText("includePostIdLabel", L("includePostIdLabel"));
  setText("ytdlpSectionLabel", L("ytdlpSectionLabel"));
  setText("ytdlpHint", L("ytdlpHint"));
  setText("downloadInstallerBtn", L("downloadInstallerBtn"));
  setText("skipExistingLabel", L("settingsSkipExisting"));
  setText("fetchSizesDuringScanLabel", L("fetchSizesDuringScanLabel"));
  setText("fetchSizesDuringScanHint", L("fetchSizesDuringScanHint"));
}

const KIND_LABELS = () => ({
  image: L("typeImage").replace(/n?$/, "").trim(),
  media: L("typeMedia"),
  audio: L("typeAudio"),
  attachment: L("typeAttachment"),
  post_file: L("typePostFile"),
});

// ---------- Creators ----------

async function loadCreators() {
  if (isTourRunning()) return;
  const { creators } = await send({ type: "GET_CREATORS" });
  state.creators = creators || [];
  renderCreatorList();
  if (state.creators.length === 0) {
    el("emptyState").style.display = "block";
    el("creatorView").style.display = "none";
    return;
  }
  if (!state.activeCreatorId) {
    let target = null;
    try {
      const sessionCreator = sessionStorage.getItem("pa_active_creator_id");
      if (sessionCreator && state.creators.some((c) => String(c.id) === String(sessionCreator))) {
        target = state.creators.find((c) => String(c.id) === String(sessionCreator)) || null;
      }
    } catch {}
    if (!target) {
      try {
        const saved = await getSettings();
        if (saved?.lastCreatorId) {
          target = state.creators.find((c) => String(c.id) === String(saved.lastCreatorId)) || null;
        }
      } catch { /* Settings nicht lesbar */ }
    }
    if (!target) {
      target = state.creators.slice().sort((a, b) => (b.lastScanned || 0) - (a.lastScanned || 0))[0] || null;
    }
    if (target) {
      await selectCreator(target.id);
    }
  }
}

function renderCreatorList() {
  const list = el("creatorList");
  if (state.creators.length === 0) {
    list.innerHTML = `<div class="creator-list-empty">${L("noCreatorsYet")}</div>`;
    return;
  }
  list.innerHTML = "";
  let activeCard = null;
  state.creators
    .slice()
    .sort((a, b) => (b.lastScanned || 0) - (a.lastScanned || 0))
    .forEach((c) => {
      const card = document.createElement("div");
      const isActive = String(c.id) === String(state.activeCreatorId);
      card.className = "creator-card" + (isActive ? " active" : "");
      if (isActive) activeCard = card;
      card.innerHTML = `
        <img src="${c.avatarUrl || "../icons/icon48.png"}" alt="" />
        <div style="min-width:0;">
          <div class="cname">${escapeHtml(c.name)}</div>
          <div class="cmeta">${c.lastScanned ? L("scannedLabel") + " " + formatDate(new Date(c.lastScanned).toISOString()) : ""}</div>
        </div>
      `;
      card.onclick = () => selectCreator(c.id);
      list.appendChild(card);
    });

  if (activeCard) {
    try {
      activeCard.scrollIntoView({ block: "nearest", behavior: "instant" });
    } catch {}
  }
}

function formatMembershipLine(m) {
  if (!m || !m.isMember) return "";
  const label = state.lang === "en" ? "Member" : "Mitglied";
  const parts = [];
  if (m.tierName) parts.push(escapeHtml(m.tierName));
  if (m.tierPosition && m.tiersTotal) parts.push(`Tier ${m.tierPosition}/${m.tiersTotal}`);
  const detail = parts.length ? parts.join(" · ") : (state.lang === "en" ? "active" : "aktiv");

  let stale = "";
  if (m.nextChargeDate) {
    const due = new Date(m.nextChargeDate).getTime();
    if (!isNaN(due) && due < Date.now()) {
      stale = state.lang === "en" ? " · re-scan to refresh" : " · neu scannen";
    }
  }
  return `${label}: ${detail}${stale}`;
}

async function selectCreator(creatorId) {
  const isDifferent = String(state.activeCreatorId) !== String(creatorId);
  state.activeCreatorId = creatorId;
  state.expanded.clear();
  state.selected.clear();
  try {
    sessionStorage.setItem("pa_active_creator_id", String(creatorId));
  } catch {}
  saveSettings({ lastCreatorId: creatorId }).catch(() => {});
  
  const scrollContainer = el("postList")?.closest(".content") || el("postList");
  if (scrollContainer && isDifferent) {
    scrollContainer.scrollTop = 0;
  }

  renderCreatorList();
  await refreshActivePosts(true);
  el("emptyState").style.display = "none";
  el("creatorView").style.display = "block";
}

async function refreshActivePosts(resetStatus = false) {
  if (isTourRunning()) return;
  if (!state.activeCreatorId) return;
  const creator = state.creators.find((c) => String(c.id) === String(state.activeCreatorId));
  if (!creator) return;
  const { posts } = await send({ type: "GET_POSTS", creatorId: state.activeCreatorId });
  
  let loadedPosts = posts || [];
  if (resetStatus) {
    loadedPosts = loadedPosts.map((p) => ({
      ...p,
      thumbnail: p.thumbnail ? { ...p.thumbnail, downloaded: false } : null,
      video: p.video ? { ...p.video, downloaded: false } : null,
      files: (p.files || []).map((f) => ({ ...f, downloaded: false }))
    }));
  }

  state.posts = loadedPosts;

  el("creatorAvatar").src = creator.avatarUrl || "../icons/icon128.png";
  el("creatorName").textContent = creator.name;
  
  const creatorLinkEl = el("creatorPatreonLink");
  if (creatorLinkEl) {
    const creatorUrl = creator.url || (creator.vanity ? `https://www.patreon.com/${creator.vanity}` : `https://www.patreon.com/user?u=${creator.id}`);
    creatorLinkEl.href = creatorUrl;
  }

  updateMembershipBadge(creator);

  const fileTotal = state.posts.reduce((sum, p) => sum + (p.files?.length || 0), 0);
  el("creatorMeta").textContent = L("postsAndFiles", state.posts.length, fileTotal);

  renderPostList();
}

const ICON_DIAMOND_OUTLINE = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0;"><path d="M6 3h12l4 6-10 12L2 9z"/><path d="M11 3 8 9l4 12 4-12-3-6"/><path d="M2 9h20"/></svg>`;
const ICON_LOCK_OUTLINE = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0;"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>`;
const ICON_USER_OUTLINE = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0;"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>`;

function updateMembershipBadge(creator) {
  const badgeBtn = el("membershipBadgeBtn");
  const overlayEl = el("creatorExpiredOverlay");
  const creatorViewEl = el("creatorView");
  const contentEl = document.querySelector(".content");
  const expiredPatreonBtn = el("expiredOverlayPatreonBtn");
  const expiredDetailsBtn = el("expiredDetailsBtn");
  if (!badgeBtn) return;
  const m = creator?.membership;
  if (!m) {
    badgeBtn.style.display = "inline-flex";
    badgeBtn.className = "membership-badge-btn unknown";
    badgeBtn.innerHTML = `${ICON_USER_OUTLINE}<span>Membership · Rescan needed</span>`;
    badgeBtn.title = "Click for info · Rescan on Patreon to detect tier";
    badgeBtn.onclick = (e) => {
      e.stopPropagation();
      showMembershipModal(creator);
    };
    if (overlayEl) overlayEl.style.display = "none";
    if (creatorViewEl) creatorViewEl.classList.remove("membership-expired");
    if (contentEl) contentEl.classList.remove("membership-expired-lock");
    return;
  }

  badgeBtn.style.display = "inline-flex";
  const now = Date.now();
  const nextCharge = m.nextChargeDate ? new Date(m.nextChargeDate).getTime() : null;
  const isFormerPatron = m.patronStatus === "former_patron" || m.patronStatus === "declined_patron";
  const hadPastSubscription = !!m.lastChargeDate || (!!m.nextChargeDate && nextCharge && nextCharge < now);
  const isExpired = isFormerPatron || (hadPastSubscription && !m.isMember && m.patronStatus !== "active_patron");

  badgeBtn.className = "membership-badge-btn " + (isExpired ? "expired" : (m.isMember ? "active" : "free"));
  
  if (isExpired) {
    badgeBtn.innerHTML = `${ICON_LOCK_OUTLINE}<span>${escapeHtml(m.tierName || "Membership")} (Expired)</span>`;
    if (overlayEl) overlayEl.style.display = "flex";
    if (creatorViewEl) creatorViewEl.classList.add("membership-expired");
    if (contentEl) {
      contentEl.scrollTop = 0;
      contentEl.classList.add("membership-expired-lock");
    }
    if (expiredPatreonBtn) {
      const creatorUrl = creator.url || (creator.vanity ? `https://www.patreon.com/${creator.vanity}` : `https://www.patreon.com/user?u=${creator.id}`);
      const rescanUrl = creatorUrl + (creatorUrl.includes("?") ? "&" : "?") + "pa_auto_scan=1";
      expiredPatreonBtn.href = rescanUrl;
      expiredPatreonBtn.onclick = (e) => {
        e.preventDefault();
        chrome.storage.local.set({
          autoScanTime: Date.now(),
          autoScanTargetUrl: creatorUrl,
          autoScanCreatorId: creator.id
        }).finally(() => {
          window.open(rescanUrl, "_blank");
        });
      };
    }
    if (expiredDetailsBtn) {
      expiredDetailsBtn.onclick = () => showMembershipModal(creator);
    }
  } else {
    if (overlayEl) overlayEl.style.display = "none";
    if (creatorViewEl) creatorViewEl.classList.remove("membership-expired");
    if (contentEl) contentEl.classList.remove("membership-expired-lock");
    if (m.isMember) {
      const renewStr = m.nextChargeDate ? ` · Renews ${new Date(m.nextChargeDate).toLocaleDateString()}` : "";
      badgeBtn.innerHTML = `${ICON_DIAMOND_OUTLINE}<span>${escapeHtml(m.tierName || "Active Supporter")}${renewStr}</span>`;
    } else {
      badgeBtn.innerHTML = `${ICON_USER_OUTLINE}<span>Free Follower</span>`;
    }
  }

  badgeBtn.onclick = (e) => {
    e.stopPropagation();
    showMembershipModal(creator);
  };
}

function showMembershipModal(creator) {
  const modal = el("membershipModal");
  const content = el("membershipModalContent");
  const patreonLink = el("membershipPatreonLink");
  if (!modal || !content) return;

  const m = creator?.membership;
  if (!m) {
    content.innerHTML = `
      <div class="membership-info-row">
        <span class="membership-info-label">Status</span>
        <span class="membership-info-val" style="color: var(--text-dim); display: inline-flex; align-items: center; gap: 5px;">
          ${ICON_USER_OUTLINE} Not yet scanned
        </span>
      </div>
      <div class="membership-warning-box" style="background: rgba(255, 255, 255, 0.05); border-left-color: var(--text-dim); color: var(--text);">
        <strong>Info:</strong> This creator was scanned before membership tracking was introduced. Please perform a fresh scan on Patreon to detect your active tier and renewal date.
      </div>
    `;
    if (patreonLink) {
      const creatorUrl = creator.url || (creator.vanity ? `https://www.patreon.com/${creator.vanity}` : `https://www.patreon.com/user?u=${creator.id}`);
      patreonLink.href = creatorUrl + (creatorUrl.includes("?") ? "&" : "?") + "pa_auto_scan=1";
    }
    modal.style.display = "flex";
    return;
  }

  const now = Date.now();
  const nextCharge = m.nextChargeDate ? new Date(m.nextChargeDate).getTime() : null;
  const isFormerPatron = m.patronStatus === "former_patron" || m.patronStatus === "declined_patron";
  const hadPastSubscription = !!m.lastChargeDate || (!!m.nextChargeDate && nextCharge && nextCharge < now);
  const isExpired = isFormerPatron || (hadPastSubscription && !m.isMember && m.patronStatus !== "active_patron");
  
  const cur = (m.currency || "USD").toUpperCase();
  const numVal = (m.entitledCents || 0) / 100;
  const formattedPrice = numVal.toLocaleString("en-US", {
    minimumFractionDigits: numVal % 1 === 0 ? 0 : 2,
    maximumFractionDigits: 2
  });
  let amountStr = "Free";
  if (m.entitledCents > 0) {
    if (cur === "EUR") amountStr = `${formattedPrice} €/mo`;
    else if (cur === "GBP") amountStr = `£${formattedPrice}/mo`;
    else if (cur === "USD") amountStr = `$${formattedPrice}/mo`;
    else amountStr = `${cur} ${formattedPrice}/mo`;
  }

  const rows = [];
  rows.push(`
    <div class="membership-info-row">
      <span class="membership-info-label">Status</span>
      <span class="membership-info-val" style="color: ${isExpired ? '#e74c3c' : (m.isMember ? '#38c172' : 'var(--text)')}; display: inline-flex; align-items: center; gap: 5px;">
        ${isExpired ? ICON_LOCK_OUTLINE + ' Expired / Inactive' : (m.isMember ? ICON_DIAMOND_OUTLINE + ' Active Member' : ICON_USER_OUTLINE + ' Free Follower')}
      </span>
    </div>
  `);

  if (m.tierName) {
    rows.push(`
      <div class="membership-info-row">
        <span class="membership-info-label">Tier / Level</span>
        <span class="membership-info-val">${escapeHtml(m.tierName)} (${amountStr})</span>
      </div>
    `);
  }

  if (m.nextChargeDate) {
    rows.push(`
      <div class="membership-info-row">
        <span class="membership-info-label">${isExpired ? 'Access Ended' : 'Next Billing / Renews'}</span>
        <span class="membership-info-val">${new Date(m.nextChargeDate).toLocaleDateString()}</span>
      </div>
    `);
  }

  if (m.checkedAt) {
    rows.push(`
      <div class="membership-info-row">
        <span class="membership-info-label">Last Synced</span>
        <span class="membership-info-val">${new Date(m.checkedAt).toLocaleDateString()} ${new Date(m.checkedAt).toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'})}</span>
      </div>
    `);
  }

  if (isExpired) {
    rows.push(`
      <div class="membership-warning-box">
        <strong>Membership Expired:</strong> Your access to patron-only posts has ended. To view updated tiers and download newly unlocked content, please renew on Patreon and perform a fresh scan.
      </div>
    `);
  }

  content.innerHTML = rows.join("");
  if (patreonLink) {
    patreonLink.href = creator.url || (creator.vanity ? `https://www.patreon.com/${creator.vanity}` : `https://www.patreon.com/user?u=${creator.id}`);
  }

  modal.style.display = "flex";
}

// ---------- Filter/Sortierung ----------

function getFilteredPosts() {
  const search = el("searchInput").value.trim().toLowerCase();
  const typeFilter = el("typeFilter").value;
  // hideDownloaded does NOT require bridgeReady — it's a pure UI filter based on stored data
  const hideDownloaded = el("hideDownloadedCheck")?.checked || false;
  const sortOrder = el("sortOrder").value;
  const lockFilter = el("lockFilter")?.value || "all";

  let posts = state.posts.map((p) => {
    let files = p.files || [];
    // Whether this post had any downloadable items at all (thumbnail / video / files).
    const hadDownloadableItems = files.length > 0 || !!p.thumbnail || !!p.video;
    // Text-only posts are "downloaded" when their extras (description/comments) have been saved
    const isTextOnlyDownloaded = !hadDownloadableItems && !!p.extrasDownloaded;

    // Filter file list for type filter first
    if (typeFilter === "files") files = files.filter((f) => f.kind === "attachment" || f.kind === "audio");
    // Only filter downloaded files if this post actually had downloadable items
    if (hideDownloaded && hadDownloadableItems) files = files.filter((f) => !f.downloaded);

    // Thumbnail/Video are not in files — handle them separately
    let thumbnail = p.thumbnail;
    let video = p.video;
    if (hideDownloaded && hadDownloadableItems) {
      if (thumbnail && thumbnail.downloaded) thumbnail = null;
      if (video && video.downloaded) video = null;
    }

    return { ...p, files, thumbnail, video, _hadDownloadableItems: hadDownloadableItems, _isTextOnlyDownloaded: isTextOnlyDownloaded };
  });

  // Lock filter
  if (lockFilter === "unlocked") {
    posts = posts.filter((p) => !p.locked);
  } else if (lockFilter === "locked") {
    posts = posts.filter((p) => !!p.locked);
  }

  if (search) {
    posts = posts.filter(
      (p) => p.title?.toLowerCase().includes(search) || p.text?.toLowerCase().includes(search)
    );
  }

  // Type filter for video/thumbnail/files
  if (typeFilter === "video") {
    posts = posts.filter((p) => !!p.video);
  } else if (typeFilter === "thumbnail") {
    posts = posts.filter((p) => !!p.thumbnail);
  } else if (typeFilter === "files") {
    posts = posts.filter((p) => p.files.length > 0);
  }

  // When hiding downloaded:
  // - Posts that HAD downloadable items: hide if nothing left undownloaded
  // - Text-only posts: hide if extrasDownloaded is true
  if (hideDownloaded && typeFilter !== "video" && typeFilter !== "thumbnail") {
    posts = posts.filter((p) => {
      if (p._isTextOnlyDownloaded) return false; // text-only post already downloaded
      if (!p._hadDownloadableItems) return true;  // text-only post not yet downloaded — keep
      return p.files.length > 0 || p.thumbnail || p.video; // has remaining undownloaded items
    });
  }

  posts.sort((a, b) => {
    const da = new Date(a.publishedAt || 0).getTime();
    const db = new Date(b.publishedAt || 0).getTime();
    return sortOrder === "asc" ? da - db : db - da;
  });

  return posts;
}

// ---------- Rendern ----------

// ---------- Groessen der beiden Textdateien (description.txt / comments.txt) ----------
//
// Beide entstehen erst beim Download, ihre Groesse ist also nicht Teil der
// gescannten Post-Daten. Unterschied:
//   description - der Text liegt bereits im Post (post.text), die Groesse laesst
//                 sich also OHNE jede Netzwerkanfrage exakt ausrechnen.
//   comments    - muessen ueber Patreons Kommentar-Endpunkt geladen werden.
// Beide benutzen bewusst dieselben Formatierungsfunktionen wie der echte
// Download (buildDescriptionFileText/formatCommentsText aus downloader.js),
// damit die angezeigte Zahl exakt der spaeter geschriebenen Datei entspricht.
function descriptionSize(post) {
  const text = post?.text && post.text.trim() ? post.text : "";
  if (!text) return 0;
  try {
    return new Blob([buildDescriptionFileText(post, text)]).size;
  } catch {
    return 0;
  }
}

// Laedt die Kommentare EINMAL pro Post nach - bewusst nur beim AUFKLAPPEN einer
// Karte, nicht beim Scan: ein Bulk-Scan mit hunderten Posts wuerde sonst
// hunderte zusaetzliche API-Anfragen ausloesen (spuerbar langsamer + unnoetiges
// Rate-Limit-Risiko bei Patreon). Beim Aufklappen schaut sich der Nutzer genau
// diesen einen Post an, eine Anfrage ist dort vertretbar.
const commentsSizeInFlight = new Set();
async function ensureCommentsSize(post) {
  const pid = String(post.id);
  if (!post || (post.commentCount || 0) <= 0) return;
  if (state.commentsSizes.has(pid) || commentsSizeInFlight.has(pid)) return;
  // NUR wenn ohnehin schon ein Patreon-Tab offen ist: fetchCommentsRaw() laesst
  // sich sonst von tabProxy.js einen Hintergrund-Tab OEFFNEN (und nach ~6s
  // wieder schliessen). Fuer einen echten Download ist das in Ordnung, fuer die
  // blosse Groessenanzeige beim Aufklappen einer Karte waere es ein
  // unerwarteter Nebeneffekt (Tab-Leiste flackert). Ohne offenen Patreon-Tab
  // bleibt die Spalte einfach leer, bis der Download die echte Groesse liefert.
  try {
    const patreonTabs = await chrome.tabs.query({ url: "https://*.patreon.com/*" });
    if (!patreonTabs || patreonTabs.length === 0) return;
  } catch {
    return;
  }
  commentsSizeInFlight.add(pid);
  try {
    const numericId = pid.replace(/^post_/, "");
    const comments = await fetchCommentsRaw(numericId);
    const text = formatCommentsText(post, comments);
    let size = 0;
    if (text) {
      try { size = new Blob([text]).size; } catch { size = 0; }
    }
    state.commentsSizes.set(pid, size);
    // Nur die eine Zeile nachtragen statt die ganze Liste neu zu bauen - ein
    // renderPostList() hier wuerde laufende Downloads unnoetig neu rendern.
    const key = fileKey(post.id, `${post.id}::comments`, "comments");
    const row = findRowEl(key);
    const sizeEl = row?.querySelector(".fsize");
    if (sizeEl && !state.activeDownloads.get(key)?.total) {
      sizeEl.textContent = size > 0 ? formatBytes(size) : "–";
      sizeEl.style.display = "inline";
    }
  } catch (err) {
    console.warn("[PatreonArchiver] Could not determine comments size:", err);
  } finally {
    commentsSizeInFlight.delete(pid);
  }
}

function renderPostList() {
  // Während eines laufenden Downloads NIEMALS die gesamte Post-Karten-Liste neu
  // aufbauen: renderPostList() leert container.innerHTML komplett und baut alle
  // Karten neu, wodurch aktive Download-Zeilen ihr DOM-Element verlieren.
  // Alle Updates (Fortschritts-Balken, Status-Icons) laufen während eines
  // Downloads ohnehin über setRowProgress()/updatePostAggregateUI() und
  // findRowEl() direkt auf den bestehenden DOM-Elementen - kein Rebuild nötig.
  if (state.isDownloading) return;

  const container = el("postList");
  const scrollContainer = container?.closest(".content") || container;
  const posts = getFilteredPosts();
  const kindLabels = KIND_LABELS();
  const scrollY = scrollContainer ? scrollContainer.scrollTop : 0;
  container.innerHTML = "";

  posts.forEach((post) => {
    const card = document.createElement("div");
    card.className = "post-card" + (state.expanded.has(post.id) ? " expanded" : "");
    card.setAttribute("data-post-id", String(post.id));

    const badges = [];
    if (post.locked) badges.push(`<span class="badge locked">${ICON_LOCK}${L("locked")}</span>`);

    const hasExternal = (post.files || []).some((f) => f.isCloudLink || f.isExternalLink);

    // Patreons rohe post_type-Kennung als Badge - aber nur, wo sie ueberhaupt
    // etwas beitraegt:
    // - "image_file": redundant zur ohnehin vorhandenen Thumbnail-Zeile und je
    //   nach Bildanzahl inkonsistent gesetzt (seit dem UI-Umbau ausgeblendet).
    // - "link": Patreons Typ fuer Posts, deren Hauptinhalt ein externer Link ist.
    //   Sobald darunter die "External Files"-Badge steht (und die Zeile selbst
    //   den konkreten Anbieter zeigt, z.B. "Google Drive"), sagt ein zusaetzliches
    //   kleingeschriebenes "link" nichts Neues - es wirkte wie ein Doppel-Badge
    //   fuer denselben Sachverhalt. Ohne erkannten externen Link bleibt es
    //   sichtbar, dort ist es die EINZIGE Information ueber die Post-Art.
    //   (Sichtbar wurde das Paar erst, seit ein Cloud-Link-Embed korrekt in
    //   post.files landet statt als vermeintliches Video - siehe Runde 21:
    //   vorher war hasExternal fuer solche Posts false, also gab es die
    //   "External Files"-Badge gar nicht.)
    const postTypeIsRedundant =
      post.postType === "image_file" || (post.postType === "link" && hasExternal);
    if (post.postType && !postTypeIsRedundant) {
      badges.push(`<span class="badge">${escapeHtml(post.postType)}</span>`);
    }

    if (hasExternal) {
      badges.push(`<span class="badge external-files" title="Enthält externe Downloads / Links">${ICON_LINK}External Files</span>`);
    }

    const items = selectableItems(post, post.files);
    const totalItems = items.length;
    badges.push(`<span class="badge">${L("filesCount", totalItems)}</span>`);
    badges.push(`<span class="badge post-size-badge" style="display: none;"></span>`);

    const selectedInPost = items.filter((it) => state.selected.has(it.key)).length;
    const allItemsDone = totalItems > 0 && items.every((it) => state.sessionDownloaded.has(it.key));

    let postSelectClass = "post-select";
    if (totalItems === 0) postSelectClass += " no-files";
    else if (allItemsDone) postSelectClass += " done-session";
    else if (selectedInPost === totalItems) postSelectClass += " checked";
    else if (selectedInPost > 0) postSelectClass += " indeterminate";

    card.innerHTML = `
      <div class="post-card-top">
        <div class="${postSelectClass}" data-role="post-select" title="${L("selectAllVisible")}"></div>
        <span class="toggle">${state.expanded.has(post.id) ? "▾" : "▸"}</span>
        <div style="flex:1; min-width: 0;">
          <p class="post-card-title">
            ${escapeHtml(post.title)}
            <a href="${escapeHtml(post.url || `https://www.patreon.com/posts/${post.id}`)}" target="_blank" rel="noopener noreferrer" class="patreon-link-btn" title="Auf Patreon öffnen" onclick="event.stopPropagation();">↗</a>
          </p>
          <p class="post-card-date">${formatDate(post.publishedAt)}</p>
        </div>
        <div class="post-card-badges">${badges.join("")}</div>
      </div>
      <div class="post-agg-progress" style="display:none;">
        <div class="post-agg-track"><div class="post-agg-fill"></div></div>
        <span class="post-agg-text"></span>
      </div>
      <div class="post-card-text">${escapeHtml(cleanTextForDisplay(post.text)).slice(0, 4000)}</div>
      <div class="file-list"></div>
    `;

    card.querySelector('[data-role="post-select"]').addEventListener("click", (e) => {
      e.stopPropagation();
      if (totalItems === 0) return;
      const allSelected = selectedInPost === totalItems;
      items.forEach((it) => {
        if (allSelected) state.selected.delete(it.key);
        else state.selected.add(it.key);
      });
      renderPostList();
    });

    card.querySelector(".post-card-top").addEventListener("click", (e) => {
      if (e.target.closest('[data-role="post-select"]')) return;
      const isExpanded = state.expanded.has(post.id);
      if (isExpanded) {
        state.expanded.delete(post.id);
        card.classList.remove("expanded");
        const toggle = card.querySelector(".toggle");
        if (toggle) toggle.textContent = "▸";
      } else {
        state.expanded.add(post.id);
        card.classList.add("expanded");
        const toggle = card.querySelector(".toggle");
        if (toggle) toggle.textContent = "▾";
        ensureCommentsSize(post);
      }
    });

    const fileListEl = card.querySelector(".file-list");
    // Alle herunterladbaren Elemente eines Posts in EINE einheitliche Liste
    // bringen (Thumbnail, Video, reguläre Dateien) - damit jede Zeile dieselbe
    // Checkbox und dasselbe Aussehen hat.
    const rows = [];
    const hasOtherContent = !!post.thumbnail || !!post.video || post.files.length > 0;
    // Reihenfolge (vom User festgelegt): Description, Comments, dann Thumbnail,
    // dann der Rest (Video/Dateien) - NUR wenn der Post auch sonst Inhalt hat;
    // reine Text-Posts behalten den bisherigen kombinierten "extras"-Weg weiter
    // unten. Post-Titel bewusst NICHT im Zeilennamen (steht schon ueber der
    // Karte) - nur die tatsaechliche Datei beim Download traegt den Post-Titel.
    if (hasOtherContent && !post.locked) {
      const descKey = fileKey(post.id, `${post.id}::description`, "description");
      rows.push({
        key: descKey,
        kindLabel: "Description",
        name: "Description",
        // Exakte Groesse der spaeteren description.txt - ohne Netzwerkanfrage
        // ausrechenbar, weil der Text schon im gescannten Post steckt.
        size: descriptionSize(post) || null,
        downloaded: state.sessionDownloaded.has(descKey),
        onDownload: () => downloadDescription(post),
        special: "description",
        url: `${post.id}::description`,
      });
      if ((post.commentCount || 0) > 0) {
        const commKey = fileKey(post.id, `${post.id}::comments`, "comments");
        const cachedCommentsSize = state.commentsSizes.get(String(post.id)) || state.activeDownloads.get(commKey)?.total || null;
        rows.push({
          key: commKey,
          kindLabel: "Comments",
          name: "Comments",
          // Wird beim Aufklappen der Karte einmalig nachgeladen (ensureCommentsSize()).
          // Solange sie unbekannt ist, bleibt die Spalte leer statt eine Zahl zu raten.
          size: cachedCommentsSize > 0 ? cachedCommentsSize : null,
          downloaded: state.sessionDownloaded.has(commKey),
          onDownload: () => downloadComments(post),
          special: "comments",
          url: `${post.id}::comments`,
        });
      }
    }
    if (post.thumbnail) {
      let thumbName = "Thumbnail";
      try {
        const u = new URL(post.thumbnail.url);
        const lastPart = u.pathname.substring(u.pathname.lastIndexOf("/") + 1);
        if (lastPart && /\.[a-z0-9]{2,4}$/i.test(lastPart)) {
          thumbName = `Thumbnail [${decodeURIComponent(lastPart)}]`;
        } else {
          thumbName = `Thumbnail [${post.title}]`;
        }
      } catch {
        thumbName = `Thumbnail [${post.title}]`;
      }

      const thumbKey = fileKey(post.id, post.thumbnail.url || `${post.id}::thumb`, "thumbnail");
      rows.push({
        key: thumbKey,
        kindLabel: "Thumbnail",
        name: thumbName,
        size: post.thumbnail.sizeBytes || null,
        // Session-only (wie ueberall) statt der persistierten DB-Markierung -
        // sonst zeigte der Button nach einem Refresh "Download" (Session
        // zurueckgesetzt), der gruene Rahmen blieb aber haengen (DB-Flag
        // persistiert weiter) - inkonsistent, Label und Farbe liefen auseinander.
        downloaded: state.sessionDownloaded.has(thumbKey),
        onDownload: () => downloadThumbnail(post),
        special: "thumbnail",
        url: post.thumbnail.url,
      });
    }
    if (post.video?.type === "native") {
      const videoKey = fileKey(post.id, post.video.url || `${post.id}::video`, "video");
      rows.push({
        key: videoKey,
        kindLabel: "Video",
        name: post.video.filename || "Video",
        size: post.video.sizeBytes || null,
        downloaded: state.sessionDownloaded.has(videoKey),
        onDownload: () => downloadNativeVideo(post),
        special: "video",
        url: post.video.url,
      });
    } else if (post.video?.type === "embed") {
      const ready = state.bridgeReady === true;
      const embedKey = fileKey(post.id, post.video.url || `${post.id}::embed`, "embed");
      rows.push({
        key: embedKey,
        kindLabel: "Video",
        name: ready ? "External video" : "External video (needs setup)",
        size: post.video.sizeBytes || null,
        downloaded: state.sessionDownloaded.has(embedKey),
        onDownload: () => downloadEmbedViaYtDlp(post),
        special: "embed",
        url: post.video.url,
      });
    }
    post.files.forEach((file) => {
      // Patreon liefert das Titelbild manchmal doppelt: einmal als Thumbnail,
      // einmal zusätzlich über die "images"-Relationship. Ohne diesen Check
      // taucht dieselbe Datei ein zweites Mal auf, fälschlich als "Download file"
      // beschriftet, obwohl auf der eigentlichen Patreon-Seite kein Anhang existiert.
      let kindLabel = "Download file";
      let displayName = file.filename;
      if (file.kind === "image") {
        kindLabel = "Thumbnail";
        displayName = (file.filename && file.filename.startsWith("Thumbnail")) ? file.filename : `Thumbnail [${file.filename}]`;
      } else if (file.kind === "audio") {
        kindLabel = "Audio";
      } else if (file.tag) {
        // Klassifizierter externer/Cloud-Link (content.js's classifyAndFormatLink)
        // - zeigt den spezifischen Anbieter (Dropbox/OneDrive/MediaFire/...) im
        // Kind-Badge statt einer generischen "Cloud File"-Bezeichnung, dadurch
        // wird die vorher redundante "[Tag]"-Klammer im angezeigten Namen
        // ueberfluessig (Name sieht dann so aus wie auf Patreon). Die echte
        // Datei beim Speichern bekommt unabhaengig davon ihren tatsaechlichen
        // Namen/Endung (siehe downloader.js) - das hier betrifft nur die Anzeige.
        kindLabel = file.tag;
        if (displayName) {
          const stripped = displayName.replace(/\s*\[[^\]]+\]$/i, "").trim();
          if (stripped) displayName = stripped;
        }
      } else if (file.isWebsite) kindLabel = "Website";
      else if (file.isCloudLink) kindLabel = "Cloud File";
      else if (file.isExternalLink) kindLabel = "External File";
      const fkey = fileKey(post.id, file.url, file.kind || "file");
      rows.push({
        key: fkey,
        kindLabel,
        name: displayName,
        size: file.sizeBytes,
        downloaded: state.sessionDownloaded.has(fkey),
        onDownload: () => downloadOne(post, file),
        url: file.url,
        file: file,
      });
    });

    const hasTextContent = !!(post.text && post.text.trim()) || (post.commentCount || 0) > 0;
    // Reine Text-Posts bekommen jetzt eine GANZ NORMALE Zeile (mit Checkbox,
    // data-key und Inline-Progressbar) statt des fruehereren handgeschriebenen
    // Sonder-Markups ohne .file-row-main/.row-progress. Damit laeuft der
    // Text-Post durch exakt dieselben Render-, Auswahl- und Fortschrittspfade
    // wie jede andere Zeile - inkl. Bulk-Download (siehe runBulkDownload()) und
    // sichtbarem Zeilen-/Post-Balken. Der Sonderfall war ausserdem die Ursache
    // fuer den falsch ausgerichteten Button (HANDOFF, achtzehnte Runde).
    if (rows.length === 0 && !post.locked && hasTextContent) {
      const extrasKey = fileKey(post.id, `${post.id}::extras`, "extras");
      rows.push({
        key: extrasKey,
        kindLabel: "TEXT",
        name: "Description & comments",
        size: null,
        downloaded: state.sessionDownloaded.has(extrasKey),
        onDownload: () => downloadPostExtras(post),
        special: "extras",
        url: `${post.id}::extras`,
      });
    }
    if (rows.length === 0) {
      fileListEl.innerHTML = `<div class="no-files">${L("noFiles")}</div>`;
    } else {
      rows.forEach((r) => {
        const liveInfo = state.activeDownloads.get(r.key);
        const isDoneSession = state.sessionDownloaded.has(r.key) || liveInfo?.status === "done";
        const row = document.createElement("div");
        row.className = "file-row" + (r.downloaded ? " downloaded" : "") + (isDoneSession ? " done-session" : "");
        row.setAttribute("data-key", r.key);
        // Live-Status (aktiv/wartend) uebersteht einen Re-Render (z.B. Filter
        // waehrenddessen geaendert) - state.activeDownloads ist die Quelle der
        // Wahrheit, nicht der DOM-Zustand einer vorherigen Render-Runde.
        const isBusy = liveInfo && (liveInfo.status === "active" || liveInfo.status === "queued");
        const btnLabel = isBusy ? L("cancel") : (state.sessionDownloaded.has(r.key) ? L("reload") : L("load"));
        // r.size ist bei Thumbnail/Video/Dateien vorab aus Patreons Scan bekannt.
        // Description/Comments haben das nicht (Textdatei, Groesse erst NACH
        // dem Schreiben bekannt) - dafuer als Fallback die tatsaechlich
        // geschriebene Groesse aus state.activeDownloads nehmen (dort von
        // updateStepProgress() bei Abschluss abgelegt, siehe meta.sizeBytes).
        // Reihenfolge bewusst: eine GEMESSENE Groesse aus dem laufenden/
        // abgeschlossenen Download schlaegt die (evtl. veraltete) Scan-Groesse
        // aus der DB. Frueher stand `r.size` zuerst und der Live-Wert wurde nur
        // im Zustand "done" ueberhaupt betrachtet - dadurch verlor eine Zeile
        // beim naechsten Re-Render wieder, was updateRowUI() gerade erst
        // eingetragen hatte. "-" markiert "fertig, aber ohne Byte-Wert"
        // (Description/Comments ohne Inhalt, bereits vorhandene Datei).
        const sizeStr = liveInfo?.total > 0
          ? formatBytes(liveInfo.total)
          : (r.size ? formatBytes(r.size) : (liveInfo?.empty ? "–" : ""));
        row.innerHTML = `
          <div class="file-row-main">
            <label class="fcheck-wrap"><input type="checkbox" class="fcheck" ${state.selected.has(r.key) ? "checked" : ""} /><span class="fcheck-box"></span></label>
            <span class="fkind">${escapeHtml(r.kindLabel)}</span>
            <span class="fname" title="${escapeHtml(r.name)}">${escapeHtml(r.name)}</span>
            <span class="fsize" style="${sizeStr ? "display: inline;" : "display: none;"}">${escapeHtml(sizeStr)}</span>
            <button class="fdl-btn${isBusy ? " row-cancel-btn" : ""}">${btnLabel}</button>
          </div>
          <div class="row-progress" style="display:${liveInfo ? "flex" : "none"};">
            <div class="row-progress-track"><div class="row-progress-fill"></div></div>
            <span class="row-progress-text"></span>
          </div>
        `;
        row.querySelector(".fcheck").addEventListener("change", (e) => {
          if (e.target.checked) state.selected.add(r.key);
          else state.selected.delete(r.key);
          updateSelectionUI();
          renderPostCheckboxOnly(post, card);
        });
        row.querySelector(".fdl-btn").addEventListener("click", () => {
          const info = state.activeDownloads.get(r.key);
          if (info && (info.status === "active" || info.status === "queued")) {
            const sig = state.itemCancelSignals.get(r.key);
            if (sig) sig.cancelled = true;
            return;
          }
          r.onDownload();
        });
        // WICHTIG: erst ins DOM haengen, DANN updateRowUI() aufrufen - das
        // sucht die Zeile per document.querySelectorAll (findRowEl()), was
        // ins Leere laeuft, solange die Zeile noch nicht angehaengt ist. War
        // die Ursache dafuer, dass Fuellung/Farbe/Text nach jedem Neu-Rendern
        // (z.B. direkt nach Abschluss) nie angewendet wurden - nur die reine
        // Sichtbarkeit aus dem Template selbst kam an.
        fileListEl.appendChild(row);
        if (liveInfo) updateRowUI(r.key, liveInfo, row);
      });
    }

    container.appendChild(card);
    updatePostAggregateUI(post.id);
  });

  if (scrollContainer) scrollContainer.scrollTop = scrollY;
  updateSelectionUI();
}

// Aktualisiert nur den Checkbox-Zustand des Post-Headers, ohne die ganze
// Liste (inkl. aufgeklappter Zustände) neu zu rendern - vermeidet Ruckeln.
function renderPostCheckboxOnly(post, cardEl) {
  const filtered = getFilteredPosts().find((p) => p.id === post.id);
  if (!filtered) return;
  const items = selectableItems(filtered, filtered.files);
  const selectedInPost = items.filter((it) => state.selected.has(it.key)).length;
  const box = cardEl.querySelector('[data-role="post-select"]');
  box.classList.remove("checked", "indeterminate", "no-files");
  if (items.length === 0) box.classList.add("no-files");
  else if (selectedInPost === items.length) box.classList.add("checked");
  else if (selectedInPost > 0) box.classList.add("indeterminate");
}

function updateSelectionUI() {
  el("selectionCount").textContent = L("selectedCount", state.selected.size);
  el("downloadSelectedBtn").disabled = state.selected.size === 0;

  const posts = getFilteredPosts();
  const allKeys = posts.flatMap((p) => selectableItems(p, p.files).map((it) => it.key));
  const selectedVisible = allKeys.filter((k) => state.selected.has(k)).length;
  const btn = el("selectAllToggle");
  btn.classList.remove("checked", "indeterminate");
  if (allKeys.length > 0 && selectedVisible === allKeys.length) btn.classList.add("checked");
  else if (selectedVisible > 0) btn.classList.add("indeterminate");
  updateQuickJumpUI();
}

// ---------- Quick-Jump Navigation ----------
// Springt auf POST-Karten-Ebene (statt jede einzelne Unterdatei abzuklappern).
function getQuickJumpPostTargets() {
  const targets = [];
  const isDownloading = state.isDownloading && state.activeDownloadKeys && state.activeDownloadKeys.length > 0;
  const cards = Array.from(document.querySelectorAll(".post-card[data-post-id]"));

  if (isDownloading) {
    const activeKeySet = new Set(state.activeDownloadKeys);
    cards.forEach((card) => {
      const postId = card.getAttribute("data-post-id");
      const rows = card.querySelectorAll(".file-row[data-key]");
      let hasActive = false;
      rows.forEach((r) => {
        if (activeKeySet.has(r.getAttribute("data-key"))) hasActive = true;
      });
      if (!hasActive && postId) {
        for (const k of activeKeySet) {
          if (k.startsWith(`${postId}::`)) {
            hasActive = true;
            break;
          }
        }
      }
      if (hasActive) {
        targets.push(card);
      }
    });
  } else {
    cards.forEach((card) => {
      const postId = card.getAttribute("data-post-id");
      const post = state.posts ? state.posts.find((p) => String(p.id) === String(postId)) : null;
      if (post) {
        const items = selectableItems(post, post.files);
        const hasSelected = items.some((it) => state.selected && state.selected.has(it.key));
        if (hasSelected) {
          targets.push(card);
        }
      }
    });
  }

  // Fallback: die Pfeile unten rechts verschwanden IMMER, sobald ein Download
  // fertig war. Ursache ist eine Kette aus drei Aufraeum-Schritten, die alle
  // Ziele auf einmal wegnehmen: downloadMany()/runBulkDownload() leeren
  // `state.selected`, hideProgress() leert `state.activeDownloadKeys` und setzt
  // `state.isDownloading = false` - danach findet weder der "laeuft gerade"-Zweig
  // noch der Auswahl-Zweig oben noch irgendetwas, updateQuickJumpUI() blendet
  // das Widget aus. Genau in dem Moment will man aber durch die eben
  // bearbeiteten Posts blaettern, um die Ergebnisse zu pruefen.
  // state.activeDownloads behaelt die Zeilen der Session (inkl. ihres
  // terminalen gruen/rot/gelb-Zustands) bis zum Neuladen des Tabs - genau die
  // richtige Zielmenge.
  if (targets.length === 0 && state.activeDownloads && state.activeDownloads.size > 0) {
    cards.forEach((card) => {
      const rows = card.querySelectorAll(".file-row[data-key]");
      for (const r of rows) {
        if (state.activeDownloads.has(r.getAttribute("data-key"))) {
          targets.push(card);
          return;
        }
      }
    });
  }
  return targets;
}

// Erkennt dynamisch, wo der Nutzer sich aktuell im Scrollbereich befindet.
// Berechnet den nächsten Ziel-Post nach unten bzw. oben relativ zur aktuellen Sicht.
function getCurrentJumpState() {
  const targets = getQuickJumpPostTargets();
  if (targets.length === 0) return { targets, currentIdx: -1, prevIdx: -1, nextIdx: -1 };

  const contentEl = document.querySelector(".content");
  const contentRect = contentEl ? contentEl.getBoundingClientRect() : { top: 0, height: window.innerHeight };
  const viewportCenter = contentRect.top + contentRect.height / 2;

  let closestIdx = 0;
  let minDiff = Infinity;
  let firstBelowIdx = -1;
  let lastAboveIdx = -1;

  targets.forEach((card, idx) => {
    const rect = card.getBoundingClientRect();
    const cardCenter = rect.top + rect.height / 2;
    const diff = Math.abs(cardCenter - viewportCenter);

    if (diff < minDiff) {
      minDiff = diff;
      closestIdx = idx;
    }

    // Post liegt unterhalb der aktuellen Sichtmitte
    if (rect.top > viewportCenter + 40 && firstBelowIdx === -1) {
      firstBelowIdx = idx;
    }
    // Post liegt oberhalb der aktuellen Sichtmitte
    if (rect.bottom < viewportCenter - 40) {
      lastAboveIdx = idx;
    }
  });

  const nextIdx = firstBelowIdx !== -1 ? firstBelowIdx : (closestIdx < targets.length - 1 ? closestIdx + 1 : -1);
  const prevIdx = lastAboveIdx !== -1 ? lastAboveIdx : (closestIdx > 0 ? closestIdx - 1 : -1);

  return {
    targets,
    currentIdx: closestIdx,
    nextIdx,
    prevIdx,
  };
}

function updateQuickJumpUI() {
  const widget = el("quickJumpWidget");
  const prevBtn = el("qjPrevBtn");
  const nextBtn = el("qjNextBtn");
  if (!widget) return;

  const { targets, prevIdx, nextIdx } = getCurrentJumpState();

  if (targets.length === 0) {
    widget.style.display = "none";
    return;
  }

  widget.style.display = "flex";

  if (prevBtn) prevBtn.disabled = prevIdx === -1;
  if (nextBtn) nextBtn.disabled = nextIdx === -1;

  const progressOverlay = el("progressOverlay");
  const isProgressVisible = progressOverlay && progressOverlay.style.display !== "none";
  const isMinimized = progressOverlay && progressOverlay.classList.contains("minimized");

  widget.classList.toggle("has-progress-panel", isProgressVisible);
  widget.classList.toggle("minimized", isMinimized);
}

function jumpDirection(direction) {
  const { targets, prevIdx, nextIdx, currentIdx } = getCurrentJumpState();
  if (targets.length === 0) return;

  let targetIdx = -1;
  if (direction === "up") {
    targetIdx = prevIdx !== -1 ? prevIdx : (currentIdx > 0 ? currentIdx - 1 : 0);
  } else if (direction === "down") {
    targetIdx = nextIdx !== -1 ? nextIdx : (currentIdx < targets.length - 1 ? currentIdx + 1 : targets.length - 1);
  }

  if (targetIdx < 0 || targetIdx >= targets.length) return;

  const targetCard = targets[targetIdx];
  if (!targetCard) return;

  // Post-Karte aufklappen, falls eingeklappt
  const postId = targetCard.getAttribute("data-post-id");
  if (postId && !state.expanded.has(postId)) {
    state.expanded.add(postId);
    targetCard.classList.add("expanded");
    const toggle = targetCard.querySelector(".toggle");
    if (toggle) toggle.textContent = "▾";
    // Gleiche Nachladelogik wie beim Klick-Aufklappen (siehe ensureCommentsSize()).
    const jumpPost = state.posts?.find((p) => String(p.id) === String(postId));
    if (jumpPost) ensureCommentsSize(jumpPost);
  }

  // Smooth Scroll in die Bildschirm-Mitte
  targetCard.scrollIntoView({ behavior: "smooth", block: "center" });

  // Visueller Glow-Highlight-Effekt auf der Post-Karte
  targetCard.classList.remove("jump-card-highlight");
  void targetCard.offsetWidth; // Reflow ausloesen
  targetCard.classList.add("jump-card-highlight");
  setTimeout(() => targetCard.classList.remove("jump-card-highlight"), 1600);

  updateQuickJumpUI();
}

// ---------- Downloads ----------

async function currentDownloadSettings() {
  return state.settings || (await getSettings());
}

// Stellt sicher, dass ein Downloadziel bereit ist. Bevorzugt der Brücken-Pfad.
// Gibt true zurück, wenn losgelegt werden kann, sonst false (und führt den
// Nutzer zur Einrichtung).
async function ensureReadyToDownload() {
  // Downloads always have a working destination: either a custom folder the
  // user picked (needs the desktop app), or - by default - a subfolder
  // inside the browser's own Downloads folder via chrome.downloads, which
  // needs no setup at all (see lib/downloader.js "Modus A"). The desktop
  // app is therefore fully optional now, only needed for an arbitrary
  // custom folder location, so downloads are never blocked here.
  return true;
}

let downloadStartTime = null;
let activeCancelSignal = null;
let byteHistory = []; // { t: timestamp, bytes: weightDoneBytes } - rollierendes Fenster

// ETA aus ECHT GEMESSENER Geschwindigkeit ueber ein rollierendes ~20s-Fenster
// der tatsaechlichen Byte-Werte (state.lastWeightDoneBytes/lastTotalWeightBytes,
// siehe updateStepProgress()/updateProgress()) - so wie es Chrome & Co machen
// (verbleibende Bytes / aktuelle Geschwindigkeit), NICHT mehr per Hochrechnung
// aus "% fertig ÷ Gesamtzeit seit Start". Die alte Methode wurde durch schnelle
// Text-Schritte am Anfang (Description/Comments, 0 echte Bytes, aber % steigt)
// und durch nachtraegliche Korrekturen der Gesamtgroesse (siehe totalWeight-
// Korrektur in downloader.js) systematisch verzerrt. Ohne bekannte Byte-Werte
// (z.B. reiner Schritte-Betrieb ohne Cloud-Links) bleibt die Anzeige leer,
// statt eine unzuverlaessige Schaetzung zu zeigen.
let smoothedEtaSec = null;
let lastEtaUpdateMs = 0;
let cachedEtaStr = "";
// Oberhalb dieser Restzeit wird keine konkrete Zahl mehr behauptet (siehe
// calculateSmoothEta()). 45 Minuten sind fuer einen Patreon-Post-Batch schon
// sehr lang; alles darueber ist in der Praxis Extrapolationsrauschen.
const ETA_MAX_PLAUSIBLE_SEC = 45 * 60;

function calculateSmoothEta() {
  if (!downloadStartTime || !(state.lastTotalWeightBytes > 0)) {
    smoothedEtaSec = null;
    cachedEtaStr = "";
    return "";
  }

  const now = Date.now();
  if (now - lastEtaUpdateMs < 800) return cachedEtaStr;
  lastEtaUpdateMs = now;

  // Geschwindigkeit ueber state.transferredBytes (rein monoton wachsender
  // Zaehler tatsaechlich uebertragener Bytes), NICHT ueber lastWeightDoneBytes.
  // Letzterer darf jetzt bewusst auch SINKEN, sobald eine Groessen-Schaetzung
  // durch die echte (kleinere) Groesse ersetzt wird - genau das hat die alte
  // Rechnung zerlegt: `remainingBytes <= 0` (weil doneBytes vorher per Math.max
  // festgeklemmt worden war) fuehrte zu einem fruehzeitigen `return cachedEtaStr`
  // und die Anzeige fror auf ihrem letzten, laengst falschen Wert ein.
  const transferred = state.transferredBytes || 0;
  byteHistory.push({ t: now, bytes: transferred });
  while (byteHistory.length > 1 && now - byteHistory[0].t > 15000) {
    byteHistory.shift();
  }
  if (byteHistory.length < 2) return cachedEtaStr;

  const oldest = byteHistory[0];
  const windowSec = (now - oldest.t) / 1000;
  if (windowSec < 1.5) return cachedEtaStr;

  const bytesPerSec = (transferred - oldest.bytes) / windowSec;
  // Fuer die RESTZEIT zaehlt alles bereits Abgearbeitete - auch fehlgeschlagene
  // und uebersprungene Items. Deren Bytes kommen nie, duerfen die Restmenge also
  // nicht dauerhaft aufblaehen (sonst laeuft die ETA nach dem ersten Fehlschlag
  // systematisch zu hoch). Die "X / Y GB"-Anzeige bleibt davon unberuehrt, die
  // zeigt bewusst weiterhin nur tatsaechlich heruntergeladene Bytes.
  const processed = Math.max(
    state.lastWeightDoneBytes || 0,
    (state.lastProcessedWeightBytes || 0) + (state.lastInFlightBytes || 0)
  );
  const remainingBytes = Math.max(0, state.lastTotalWeightBytes - processed);

  // WAEHREND EINER SCAN-/SIZING-PHASE WIRD GAR NICHT HOCHGERECHNET.
  //
  // Ein Google-Drive-Ordner meldet in dieser Phase (Struktur auflisten,
  // ZIP-Export vorbereiten) minutenlang keine oder nur winzige Byte-Mengen -
  // gleichzeitig steht im Nenner die grobe Vorab-Schaetzung des Cloud-Items
  // (SIZE_ESTIMATE.CLOUD = 800 MB). "800 MB geteilt durch ein paar KB/s, die
  // gerade zufaellig von einer nebenher geschriebenen description.txt stammen"
  // ergibt genau die gemeldeten Fantasiewerte (365 min). Der bisherige Schutz
  // griff nur bei EXAKT 0 B/s - ein Tropfen Durchsatz reichte, um ihn zu
  // umgehen. Jetzt zaehlt der Scan-Zustand selbst, nicht die Zufallsrate.
  if (anyRowScanning()) {
    smoothedEtaSec = null;
    cachedEtaStr = "Est. time: calculating…";
    return cachedEtaStr;
  }

  if (bytesPerSec <= 0) {
    // Es fliessen gerade keine Bytes und es scannt auch nichts - dann lieber den
    // letzten Wert stehen lassen als zu raten.
    return cachedEtaStr;
  }
  if (remainingBytes <= 0) return cachedEtaStr;

  const rawRemainingSec = remainingBytes / bytesPerSec;
  if (rawRemainingSec <= 1) return cachedEtaStr;
  // Absurd hohe Werte gar nicht erst anzeigen. Frueher wurde bis 24h alles
  // woertlich ausgegeben - eine "~365 min"-Anzeige wirkt praezise, obwohl sie
  // reine Extrapolation aus einer nicht belastbaren Momentanrate ist. Ueber
  // dieser Grenze sagen wir ehrlich, dass es lange dauert, statt eine Zahl zu
  // erfinden.
  if (rawRemainingSec > ETA_MAX_PLAUSIBLE_SEC) {
    smoothedEtaSec = null;
    cachedEtaStr = `Est. time: > ${formatEta(ETA_MAX_PLAUSIBLE_SEC)}`;
    return cachedEtaStr;
  }

  if (smoothedEtaSec === null) {
    smoothedEtaSec = rawRemainingSec;
  } else {
    smoothedEtaSec = smoothedEtaSec * 0.7 + rawRemainingSec * 0.3;
  }

  const roundedSec = Math.round(smoothedEtaSec);
  cachedEtaStr = `Est. time: ~${formatEta(roundedSec)}`;
  return cachedEtaStr;
}

// Setzt die beiden Zahlen hinter der "X / Y GB"-Anzeige und der ETA.
// EINE Stelle fuer beide Callbacks (updateProgress-Byte-Ticks UND
// updateStepProgress-Schrittmeldungen) - vorher rechneten beide leicht
// unterschiedlich und ueberschrieben sich gegenseitig.
//
// Wichtigster Unterschied zu frueher: die live laufenden Bytes werden ueber
// ALLE gerade aktiven Zeilen summiert. Seit dem Parallel-Umbau laufen mehrere
// Items gleichzeitig; die alte Formel "abgeschlossenes Gewicht + Bytes der
// EINEN gerade tickenden Datei" hat den Rest systematisch verschluckt und
// (zusammen mit dem monotonen Math.max-Klemmen) die Est.-Time unbrauchbar
// gemacht.
function setAggregateBytes(successWeightBytes, totalWeightBytes, { updateTarget = true } = {}) {
  if (!(totalWeightBytes > 0)) return;
  state.lastTotalWeightBytes = totalWeightBytes;
  if (successWeightBytes > 0) {
    state.lastSuccessWeightBytes = Math.max(state.lastSuccessWeightBytes || 0, successWeightBytes);
  }
  let inFlight = 0;
  state.activeDownloads.forEach((v) => {
    if (v?.status !== "active") return;
    inFlight += Math.min(rowWeight(v), rowReceived(v));
  });
  state.lastInFlightBytes = inFlight;
  const done = Math.min(totalWeightBytes, (state.lastSuccessWeightBytes || 0) + inFlight);
  const prev = state.lastWeightDoneBytes || 0;
  if (done > prev) state.transferredBytes = (state.transferredBytes || 0) + (done - prev);
  state.lastWeightDoneBytes = done;
  if (updateTarget) recomputeOverallTarget();
}

// EINZIGE Stelle, die state.targetOverallPct aus dem Byte-Budget bestimmt.
//
// Frueher setzte NUR updateStepProgress() den Zielwert - `updateProgress()`
// (die Byte-Ticks) fasste ihn bewusst nicht an. Konsequenz: waehrend eines
// einzelnen langen Transfers (grosse Datei, Cloud-Ordner) kam ueberhaupt kein
// reportStep() mehr, die Ecke-Bar stand also die ganze Zeit still und ruckte
// erst beim Abschluss des Items weiter. Zusammen mit dem alten harten Deckel
// `stepCap = done/total` (der die Bar zusaetzlich auf den Anteil bereits
// ABGESCHLOSSENER Items begrenzte) ergab das genau das gemeldete Bild: Bar
// bleibt bei etwa einem Drittel bis der Haelfte stehen und bewegt sich bis zum
// Schluss nicht mehr. Beides ist jetzt ersetzt durch echte Byte-Verfolgung
// (laufende Bytes ALLER aktiven Zeilen inklusive) mit Anker-Neuberechnung.
function recomputeOverallTarget() {
  // Waehrend der Abschluss-Animation haelt finishProgressSuccessfully()/
  // finishProgressCancelled() den Zielwert bei 100 - verspaetete Ticks duerfen
  // ihn dann nicht mehr nach unten ziehen.
  if (progressFinishing) return;
  const total = state.lastTotalWeightBytes;
  if (!(total > 0)) return;
  const processed = (state.lastProcessedWeightBytes || 0) + (state.lastInFlightBytes || 0);
  state.targetOverallPct = advanceAnchoredProgress(overallAnchor, processed, total);
}

let progressAnimInterval = null;
// Anker-Zustand der Ecke-Bar (siehe advanceAnchoredProgress()).
let overallAnchor = newProgressAnchor();
// True waehrend finishProgressSuccessfully()/finishProgressCancelled() laufen -
// haelt state.targetOverallPct bei 100, damit ein verspaeteter Progress-Tick
// die Abschluss-Animation nicht wieder zurueckzieht.
let progressFinishing = false;
let visualOverallPct = 0;
let visualFilePct = 0;
let visualBytesDone = 0;
let lastRenderedProgressLabel = null;

// ---------- Titelzeile der Ecke-Anzeige (welcher Post/welche Datei laeuft?) ----------
//
// Problem: `state.lastPostTitle` wird von JEDEM reportStep() ueberschrieben -
// egal von welchem Post. Seit dem Parallel-Umbau laufen mehrere Items
// gleichzeitig (Pools), es feuern also staendig Schritte verschiedener Posts,
// und der 30ms-Ticker hat den Text bisher bei jeder Aenderung SOFORT und HART
// ersetzt. Ergebnis war ein nervoeses Hin-und-Her-Springen zwischen Namen.
//
// Drei Massnahmen:
// 1. Mindest-Standzeit: ein Name bleibt mindestens TITLE_MIN_DWELL_MS stehen.
//    Wechselt der "aktuelle" Post in der Zwischenzeit mehrfach, gewinnt einfach
//    der zuletzt gemeldete - es wird nur nicht mehr jeder Zwischenschritt gezeigt.
// 2. Leere Titel werden ignoriert (manche Schritt-Labels haben keinen
//    "Post · Datei"-Teil) - vorher blitzte dazwischen eine leere Zeile auf.
// 3. Weicher Crossfade statt hartem Textwechsel, plus ein stabiler Zusatz
//    "+N more", der erklaert, warum ueberhaupt gewechselt wird (mehrere Downloads
//    gleichzeitig) - ohne selbst zu flackern, weil es nur eine Zahl ist.
const TITLE_MIN_DWELL_MS = 1800;
const TITLE_FADE_MS = 160;
let lastTitleSwapMs = 0;
let titleSwapPending = false;

function activeRowCount() {
  let n = 0;
  state.activeDownloads.forEach((v) => {
    if (v?.status === "active" || v?.status === "scanning") n++;
  });
  return n;
}

function paintProgressTitle(text) {
  const titleEl = el("progressPostTitle");
  if (!titleEl) return;
  titleEl.textContent = "";
  const span = document.createElement("span");
  span.textContent = text;
  span.style.opacity = "0";
  titleEl.appendChild(span);
  // Marquee wie bisher an der tatsaechlichen Ueberlaenge ausrichten. Die
  // Messung ist von der Opazitaet unabhaengig (Layout aendert sich nicht).
  const overflowPx = titleEl.scrollWidth - titleEl.clientWidth;
  if (overflowPx > 2) {
    titleEl.style.setProperty("--marquee-distance", `-${overflowPx}px`);
    titleEl.style.setProperty("--marquee-duration", `${Math.min(14, Math.max(3, overflowPx / 40))}s`);
    titleEl.classList.add("marquee");
  } else {
    titleEl.classList.remove("marquee");
  }
  requestAnimationFrame(() => { span.style.opacity = "1"; });
}

function updateProgressTitle() {
  const base = state.lastPostTitle;
  if (!base) return; // leere Zwischenmeldung - vorherigen Namen stehen lassen
  const others = Math.max(0, activeRowCount() - 1);
  const desired = others > 0 ? `${base}  ·  +${others} more` : base;
  if (desired === lastRenderedProgressLabel || titleSwapPending) return;

  const titleEl = el("progressPostTitle");
  if (!titleEl) return;
  const current = titleEl.querySelector("span");

  // Erster Anstrich (noch gar kein Name da): sofort, ohne Wartezeit.
  if (!current || !current.textContent) {
    lastRenderedProgressLabel = desired;
    lastTitleSwapMs = Date.now();
    paintProgressTitle(desired);
    return;
  }
  if (Date.now() - lastTitleSwapMs < TITLE_MIN_DWELL_MS) return;

  lastRenderedProgressLabel = desired;
  lastTitleSwapMs = Date.now();
  titleSwapPending = true;
  current.style.opacity = "0";
  setTimeout(() => {
    titleSwapPending = false;
    paintProgressTitle(desired);
  }, TITLE_FADE_MS);
}

function startProgressAnimation() {
  if (progressAnimInterval) return;
  progressAnimInterval = setInterval(() => {
    if (!downloadStartTime) {
      clearInterval(progressAnimInterval);
      progressAnimInterval = null;
      return;
    }

    updateProgressTitle();

    const overallDiff = state.targetOverallPct - visualOverallPct;
    if (overallDiff > 0.05) {
      visualOverallPct += overallDiff * 0.08;
    } else if (overallDiff > 0) {
      visualOverallPct = state.targetOverallPct;
    }

    const fileDiff = state.targetFilePct - visualFilePct;
    if (fileDiff < 0) {
      visualFilePct = state.targetFilePct;
    } else if (fileDiff > 0.05) {
      visualFilePct += fileDiff * 0.08;
    } else {
      if (state.targetFilePct >= 99 && visualFilePct < 100) {
        visualFilePct += 0.4;
        if (visualFilePct > 100) visualFilePct = 100;
      } else {
        visualFilePct = state.targetFilePct;
        if (visualFilePct < 99.5 && state.targetFilePct > 0) {
          visualFilePct += 0.025;
        }
      }
    }

    const targetBytes = state.lastWeightDoneBytes || 0;
    const bytesDiff = targetBytes - visualBytesDone;
    if (bytesDiff > 5) {
      visualBytesDone += bytesDiff * 0.12;
    } else {
      visualBytesDone = targetBytes;
    }

    const isFinishing = progressFinishing || state.targetOverallPct >= 100;
    const clampedOverall = isFinishing ? Math.min(100, visualOverallPct) : Math.min(99, visualOverallPct);
    const fillEl = el("progressFill");
    fillEl.style.width = `${clampedOverall}%`;
    if (isFinishing && clampedOverall >= 100) {
      fillEl.classList.add("done");
    } else {
      fillEl.classList.remove("done");
    }

    el("progressFileFill").style.width = `${Math.min(100, visualFilePct)}%`;

    const overallTextPct = Math.min(isFinishing ? 100 : 99, Math.round(visualOverallPct));
    if (state.lastTotalCount > 0) {
      const overallCountClamped = Math.min(state.lastDoneCount + (clampedOverall >= 100 ? 0 : 1), state.lastTotalCount);
      el("progressMeta").textContent = `${overallCountClamped}/${state.lastTotalCount} (${overallTextPct}%)`;
    } else {
      el("progressMeta").textContent = anyRowScanning() ? "Scanning..." : "Preparing...";
    }
    el("progressEta").textContent = calculateSmoothEta();
    // "~" solange mindestens eine Zeile noch auf die echte Groesse wartet
    // (Cloud-Scan) - die Gesamtsumme enthaelt dann noch SIZE_ESTIMATE-
    // Schaetzwerte und darf nicht wie eine exakte Zahl aussehen.
    const sizeApprox = anyRowScanning() || anyRowUnknownTotal();
    el("progressSize").textContent = state.lastTotalWeightBytes > 0
      ? `${formatBytes(Math.min(visualBytesDone, state.lastTotalWeightBytes))} / ${sizeApprox ? "~" : ""}${formatBytes(state.lastTotalWeightBytes)}`
      : "";
    // Gleiches Signal auch auf der Hauptbar: waehrend eines reinen Groessen-
    // Scans (keine Bytes unterwegs) pulst sie grau, statt scheinbar eingefroren
    // auf einem Prozentwert zu stehen, der sich minutenlang nicht bewegt.
    fillEl.classList.toggle("sizing", sizeApprox && clampedOverall < 100);
  }, 30);
}

function setBulkButtonsDisabled(disabled) {
  ["downloadSelectedBtn", "downloadAllBtn", "formatFilesBtn", "formatZipBtn"].forEach((id) => {
    const btn = document.getElementById(id);
    if (btn) btn.disabled = disabled;
  });
  if (!disabled) updateSelectionUI();
}

function showProgress(label) {
  state.isDownloading = true;
  setBulkButtonsDisabled(true);
  downloadStartTime = Date.now();
  byteHistory = [];
  visualOverallPct = 0;
  visualFilePct = 0;
  visualBytesDone = 0;
  state.targetOverallPct = 0;
  state.targetFilePct = 0;
  state.lastPostTitle = "";
  state.lastDoneCount = 0;
  state.lastTotalCount = 0;
  state.lastTotalWeightBytes = 0;
  state.lastWeightDoneBytes = 0;
  state.lastSuccessWeightBytes = 0;
  state.lastProcessedWeightBytes = 0;
  state.lastInFlightBytes = 0;
  state.transferredBytes = 0;
  overallAnchor = newProgressAnchor();
  progressFinishing = false;
  smoothedEtaSec = null;
  cachedEtaStr = "";
  lastEtaUpdateMs = 0;
  lastRenderedProgressLabel = null;
  // Titel-Entprellung fuer den neuen Batch zuruecksetzen, sonst muesste der
  // erste Name bis zu TITLE_MIN_DWELL_MS auf den Rest der letzten Runde warten.
  lastTitleSwapMs = 0;
  titleSwapPending = false;

  // Stoppe periodische Pings während eines aktiven Downloads
  if (bridgeReadyInterval) {
    clearInterval(bridgeReadyInterval);
    bridgeReadyInterval = null;
  }
  // WICHTIG: auch den periodischen Creator/Post-Refresh stoppen (lief alle 4s
  // via startPeriodicTasks() -> refreshActivePosts() -> renderPostList()) -
  // das hat waehrend eines laufenden Downloads ALLE Zeilen-DOM-Knoten neu
  // aufgebaut (inkl. evtl. frisch aus der DB gelesener, leicht anderer Post-
  // Daten), wodurch aktive Downloads ihre Zeile "verloren" haben (siehe
  // HANDOFF.md). Wird in hideProgress() wieder gestartet.
  if (creatorRefreshInterval) {
    clearInterval(creatorRefreshInterval);
    creatorRefreshInterval = null;
  }

  if (label && label.endsWith("...")) {
    const baseText = label.slice(0, -3);
    el("progressLabel").innerHTML = `${escapeHtml(baseText)}<span class="animated-dots"></span>`;
  } else {
    el("progressLabel").textContent = label || "Downloading";
  }
  el("progressFill").style.width = "0%";
  el("progressFill").classList.remove("done-flash", "error", "cancelling");
  el("progressMeta").textContent = "0%";
  el("progressEta").textContent = "";
  el("progressSize").textContent = "";
  el("progressPostTitle").textContent = "";
  el("progressFileLabel").textContent = "Preparing...";
  el("progressFileFill").style.width = "0%";
  el("progressFileFill").classList.remove("scanning");
  el("progressFilePct").textContent = "0%";
  el("progressFileRow").style.display = ""; // Standardmäßig anzeigen
  el("progressOverlay").classList.remove("minimized");
  el("progressOverlay").style.display = "block";

  updateQuickJumpUI();
  startProgressAnimation();
}

// Gemeinsamer Abschluss fuer alle Download-Funktionen: Primary-Bar auf 100%,
// kurzer gruener Puls + "Download Done"-Text, Panel bleibt dafuer sichtbar
// offen, statt sofort zu verschwinden - erst danach hideProgress().
// Wartet, bis die Easing-Animation (startProgressAnimation()) visualOverallPct
// nahe 100 gebracht hat. Von finishProgressSuccessfully() UND
// finishProgressCancelled() genutzt - bewusst EINE Implementierung, damit
// Erfolgs- und Abbruch-Abschluss nicht wieder auseinanderlaufen.
//
// Sicherheitsnetz 2.5s: die Easing-Animation (8% des Restwegs pro 30ms-Tick)
// braucht selbst aus dem Extremfall "Bar steht noch bei 0%" nur ~1.9s bis
// 99.5%. Wenn sie es in 2.5s nicht schafft, wird `state.targetOverallPct` von
// aussen gegen 100 gehalten - dann lieber sauber auf 100 springen als weiter zu
// warten. Frueher standen hier 3s UND ein Ziel, das durch den Merge-Ticker
// staendig wieder unter 99.5 gedrueckt wurde: das Timeout war damit der
// Normalfall statt der Ausnahme.
function waitForVisualOverallPct(threshold = 99.5, timeoutMs = 2500) {
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs;
    const check = () => {
      if (visualOverallPct >= threshold || Date.now() >= deadline || !progressAnimInterval) {
        resolve();
        return;
      }
      setTimeout(check, 30);
    };
    check();
  });
}

async function finishProgressSuccessfully(label = "Download Done") {
  progressFinishing = true;
  state.targetOverallPct = 100;
  state.targetFilePct = 100;
  // NICHT visualOverallPct direkt auf 100 setzen - das liess die Ecke-
  // Fortschrittsanzeige sichtbar "springen" statt smooth aufzufuellen (User-
  // Beobachtung: "springt ploetzlich wenn es fertig ist"). Die normale
  // Easing-Animation in startProgressAnimation() (8% des Restwegs pro 30ms-
  // Tick) erledigt das von selbst - i.d.R. deutlich unter einer Sekunde, da
  // targetOverallPct bei einem tatsaechlich abgeschlossenen Batch ohnehin
  // schon nahe 100 liegt. Kurz warten, bis sie wirklich (fast) angekommen
  // ist, bevor der gruene "Done"-Flash + Text erscheint, statt beides parallel
  // und unabhaengig voneinander springen zu lassen.
  await waitForVisualOverallPct();
  visualOverallPct = 100;
  const fillEl = el("progressFill");
  fillEl.classList.remove("error", "cancelling");
  fillEl.classList.add("done-flash");
  el("progressLabel").textContent = label;
  await new Promise((resolve) => setTimeout(resolve, 2200));
  fillEl.classList.remove("done-flash");
  hideProgress();
}

// Wie finishProgressSuccessfully(), aber Amber statt Gruen - fuer Batches, die
// (ganz oder teilweise) abgebrochen wurden. Vorher wurde hier IMMER gruen
// "Download Done" gezeigt, selbst wenn der User zwischendrin auf Cancel
// gedrueckt hatte.
async function finishProgressCancelled(label = "Cancelled") {
  // Wie beim Erfolgsfall auf 100% laufen lassen - nur in Amber statt Gruen.
  // Vorher blieb der Balken auf `Math.max(target, visualOverallPct)` stehen,
  // also irgendwo mittendrin, und verschwand dann einfach. Die ZEILEN zeigen im
  // Abbruchfall laengst einen komplett gefuellten amberfarbenen Balken
  // (updateRowUI(), status "cancelled" -> width 100%) - die Ecke war damit als
  // einzige Anzeige inkonsistent ("erreicht nie 100%").
  progressFinishing = true;
  state.targetOverallPct = 100;
  state.targetFilePct = 100;
  const fillEl = el("progressFill");
  fillEl.classList.remove("error", "done-flash");
  fillEl.classList.add("cancelling");
  el("progressLabel").textContent = label;
  await waitForVisualOverallPct();
  visualOverallPct = 100;
  await new Promise((resolve) => setTimeout(resolve, 2200));
  fillEl.classList.remove("cancelling");
  hideProgress();
}

// Kurzer roter Puls auf der PRIMARY-Bar bei einem Fehler bei einem Einzel-Item
// (Farben gelten bewusst nur fuer die Primary-Bar, nicht die Sekundaer-Bar).
// Blendet NICHT das Panel aus - der Batch laeuft ggf. mit weiteren Items weiter.
function pulsePrimaryError() {
  const fillEl = el("progressFill");
  fillEl.classList.remove("done-flash");
  fillEl.classList.add("error");
  clearTimeout(pulsePrimaryError._t);
  pulsePrimaryError._t = setTimeout(() => fillEl.classList.remove("error"), 1400);
}

// Fuer Einzel-Downloads, die bei einem Fehler komplett abbrechen: kurz rot
// pulsen lassen, dann das Panel schliessen.
async function flashPrimaryError() {
  pulsePrimaryError();
  await new Promise((resolve) => setTimeout(resolve, 1400));
  hideProgress();
}

function hideProgress() {
  state.isDownloading = false;
  progressFinishing = false;
  setBulkButtonsDisabled(false);
  if (progressAnimInterval) {
    clearInterval(progressAnimInterval);
    progressAnimInterval = null;
  }
  el("progressOverlay").style.display = "none";
  activeCancelSignal = null;
  downloadStartTime = null;
  byteHistory = [];
  state.activeDownloadKeys = [];
  updateQuickJumpUI();

  // Pings nach dem Download wieder starten (sofern nicht im Hintergrund)
  if (!bridgeReadyInterval && !document.hidden) {
    bridgeReadyInterval = setInterval(() => refreshBridgeReady(false), 60_000);
  }
  // Periodischen Creator/Post-Refresh (siehe showProgress()) ebenfalls wieder
  // starten, mit denselben Parametern wie in startPeriodicTasks().
  if (!creatorRefreshInterval) {
    creatorRefreshInterval = setInterval(async () => {
      await loadCreators();
      await refreshActivePosts();
    }, 4000);
  }
}

function formatEta(seconds) {
  if (seconds < 60) return `${seconds}s`;
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins}m ${secs}s`;
}

// weightDoneAtStart/totalWeight sind das BYTE-Budget aus downloadItems()
// (weightDone/totalWeight - Summe aus echten sizeBytes + Schaetzungen fuer
// unbekannte Groessen), nicht mehr Schritt-Anzahlen. state.lastDoneCount/
// lastTotalCount (die angezeigte "X/Y"-Zahl der Primary-Bar) werden
// AUSSCHLIESSLICH von updateStepProgress() gesetzt - hier NIE anfassen, sonst
// schreiben beide Callbacks denselben State mit unterschiedlichen Nennern
// gegeneinander.
function updateProgress(weightDoneAtStart, totalWeight, p) {
  // Diagnose fuer "andere Thumbnails fuellen sich nicht" - im Konsolen-Log
  // (F12) nach "[PA Thumb Debug]" filtern, um zu sehen, ob/wie oft hier
  // ueberhaupt Byte-Ticks fuer Galerie-Bilder ankommen (kind:"image").
  if (p?.filename && /thumbnail/i.test(p.filename)) {
  }
  // Bridge musste von Tier 1 (ZIP-Export) auf Tier 2 (Datei-fuer-Datei)
  // zurueckfallen - dem Nutzer sichtbar machen statt nur im Bridge-Log.
  if (p?.phase === "fallback_notice") {
    showToast(p.filename || "Falling back to a slower download method...");
    return;
  }
  const fileFillEl = el("progressFileFill");
  // phase "sizing" kommt direkt von der Bridge (CommandHandlers.cs), waehrend sie
  // selbst noch die Ordnergroesse ermittelt (Drive-Baum-Scan bzw. ZIP-Export-
  // Vorbereitung) - das ist der EINZIGE Scan, der den Download tatsaechlich
  // verzoegert, daher hier (und nicht an einem separaten, nicht-blockierenden
  // Hintergrund-Scan) der richtige Ort fuer den grauen "Scanning"-Puls.
  if (p?.phase === "sizing") {
    fileFillEl.classList.remove("done-flash", "error");
    fileFillEl.classList.add("scanning");
    el("progressFileLabel").textContent = p.filename || "Scanning...";
    el("progressFilePct").textContent = "Scanning…";
    if (p?.postId != null && p?.url) {
      setRowProgress(fileKey(p.postId, p.url, p.itemKind || "file"), { status: "scanning", postId: p.postId, itemWeight: p.itemWeight });
    }
    return;
  }
  fileFillEl.classList.remove("scanning"); // echte Bytes fliessen - kein Scan-Puls mehr noetig

  // Inline-Zeilen-Fortschritt (Variante 3): p.postId/p.url/p.itemKind kommen
  // strukturiert aus downloader.js (siehe reportStep()/onProgress-Wrapper
  // dort) - kein Label-String-Parsing noetig, um die richtige Zeile zu finden.
  if (p?.postId != null && p?.url) {
    const rowKey = fileKey(p.postId, p.url, p.itemKind || "file");
    if (p?.total > 0) {
      // received/total sind IMMER die Gesamtwerte des jeweiligen Transfers -
      // auch bei Cloud-ORDNERN. CommandHandlers.cs summiert dort selbst
      // kumulativ (state.ReceivedSoFar + aktuelle Datei gegen state.GrandTotal,
      // siehe SaveDriveFolderFileCumulativeAsync/DownloadMegaFolderRecursiveAsync),
      // der Nenner aendert sich waehrend eines Ordner-Downloads nie.
      // Die frueher hier gerechnete Ersatzformel
      // ((filesCompleted + received/total) / totalFiles) stammt noch aus der
      // Zeit, als die Bridge PRO DATEI zaehlte - sie verrechnet den bereits
      // kumulierten Anteil jetzt ein zweites Mal gegen die Dateianzahl und
      // liefert dadurch systematisch falsche Prozentwerte.
      setRowProgress(rowKey, {
        status: "active",
        received: p.received || 0,
        total: p.total,
        postId: p.postId,
        itemWeight: p.itemWeight,
      });
    } else if (p?.filesCompleted !== undefined && p?.totalFiles > 0) {
      // Rueckfallebene, wenn die Bridge die Ordner-Gesamtgroesse nicht kennt
      // (passiert bei Google Drive, wenn beim Vorab-Sizing ueberall HTML-
      // Zwischenseiten statt Dateien kamen - dann ist GrandTotal 0).
      //
      // Frueher wurde hier NUR die Dateianzahl gerechnet: der Balken stand
      // waehrend einer laufenden Datei komplett still und sprang erst beim
      // Dateiwechsel weiter - bei einem Ordner mit wenigen grossen Dateien also
      // "haengt bei 0% und springt nach Minuten auf 100%" (genau die
      // Nutzer-Beobachtung). Jetzt wird der Anteil der GERADE laufenden Datei
      // (fileReceived/fileTotal, neu von der Bridge mitgeliefert)
      // mit eingerechnet, sodass sich der Balken kontinuierlich bewegt.
      const fileFraction = p.fileTotal > 0 ? Math.min(1, (p.fileReceived || 0) / p.fileTotal) : 0;
      setRowProgress(rowKey, {
        status: "active",
        pct: Math.min(100, ((p.filesCompleted + fileFraction) / p.totalFiles) * 100),
        postId: p.postId,
        itemWeight: p.itemWeight,
        // Die BEREITS uebertragenen Bytes sind sehr wohl bekannt (die Bridge
        // summiert sie in state.ReceivedSoFar) - nur der Nenner fehlt. Sie
        // trotzdem mitzuschicken war bisher vergessen worden: die Zeile zeigte
        // dadurch nur noch "37%" ohne jede MB-Angabe, und weil rowReceived()
        // sich genau aus diesem Feld speist, fehlten die Bytes auch im
        // Post-Balken und in der Ecke-Summe.
        received: p.received || 0,
        // Die echte Gesamtgroesse dieses Ordners ist unbekannt (die Bridge
        // ueberspringt bei grossen Ordnern bewusst die Vorab-Vermessung, siehe
        // DriveSizingMaxFiles). In den Aggregaten steckt dafuer nur die grobe
        // SIZE_ESTIMATE.CLOUD-Schaetzung von 800 MB - die darf dann NICHT wie
        // eine gemessene Zahl aussehen. Genau daher kam die Beobachtung "eine
        // 800-MB-Datei laedt ewig", waehrend real ein Vielfaches davon lief.
        unknownTotal: true,
      });
    } else {
      setRowProgress(rowKey, {
        status: "active",
        received: p.received || 0,
        total: 0,
        postId: p.postId,
        itemWeight: p.itemWeight,
      });
    }
  }

  if (totalWeight > 0) {
    // weightDoneAtStart = Gewicht der bereits ABGESCHLOSSENEN Items. Die
    // laufenden Bytes holt setAggregateBytes() sich aus state.activeDownloads
    // (also ueber ALLE parallel laufenden Zeilen), nicht nur aus diesem einen
    // Tick - siehe Kommentar dort. setAggregateBytes() ruft anschliessend
    // recomputeOverallTarget() auf: die Ecke-Bar bewegt sich damit AUCH
    // waehrend eines einzelnen langen Transfers, in dem gar kein reportStep()
    // mehr feuert (das war die Ursache fuer "bleibt ab ca. einem Drittel
    // stehen"). Doppelte, widerspruechliche Zielwerte kann es nicht mehr
    // geben, weil updateStepProgress() den Zielwert nicht mehr selbst setzt.
    setAggregateBytes(weightDoneAtStart, totalWeight);
  }

  const speedStr = p?.speedBytesPerSec ? `${formatBytes(p.speedBytesPerSec)}/s` : "";
  const sizeInfo = p?.total ? `${formatBytes(p.received)} / ${formatBytes(p.total)}` : (p?.received ? formatBytes(p.received) : "");

  if (p?.filesCompleted !== undefined && p?.totalFiles !== undefined) {
    // p.received/p.total beschreiben IMMER die aktuell aktive Einzeldatei (nie den
    // ganzen Cloud-Ordner). Beim Datei-Wechsel schickt die Bridge bewusst total=0,
    // damit hier sauber auf 0% zurueckgesetzt wird statt kurzzeitig den
    // Ordner-Fortschritt (filesCompleted/totalFiles) als falsche Datei-Prozentzahl zu zeigen.
    const filePct = p.total && p.total > 0 ? Math.min(100, (p.received / p.total) * 100) : 0;
    state.targetFilePct = filePct;
    el("progressFileLabel").textContent = `[File ${p.filesCompleted + 1}/${p.totalFiles}] ${p.filename || "Downloading..."}`;
    el("progressFilePct").textContent = `${Math.round(filePct)}%${sizeInfo ? " (" + sizeInfo + ")" : ""}${speedStr ? " · " + speedStr : ""}`;
  } else {
    if (p?.filename) {
      el("progressFileLabel").textContent = p.filename;
    } else {
      el("progressFileLabel").textContent = "Downloading...";
    }

    if (p?.total && p.total > 0) {
      state.targetFilePct = Math.min(100, (p.received / p.total) * 100);
      el("progressFilePct").textContent = `${Math.round(state.targetFilePct)}%${sizeInfo ? " (" + sizeInfo + ")" : ""}${speedStr ? " · " + speedStr : ""}`;
    } else {
      state.targetFilePct = 0;
      el("progressFilePct").textContent = sizeInfo ? `${sizeInfo}${speedStr ? " · " + speedStr : ""}` : (speedStr || "0%");
    }
  }
}

function updateStepProgress(done, total, label, meta = {}) {
  // Filter out the anti-rate-limiting message if it is passed in as label
  let displayLabel = label;
  if (label && label.includes("anti-rate-limiting")) {
    displayLabel = "";
  }

  // Label in "Post-Titel" und "Datei-Detail" aufteilen (Format ist immer
  // "{Post-Titel} · {Datei-Info}")
  let postTitlePart = "";
  let fileDetailPart = displayLabel;
  if (displayLabel && displayLabel.includes(" · ")) {
    const idx = displayLabel.indexOf(" · ");
    postTitlePart = displayLabel.slice(0, idx);
    fileDetailPart = displayLabel.slice(idx + 3);
  }

  // Prüfen, ob die aktuelle Einzeldatei eine echte Prozentzahl meldet (z.B. von yt-dlp)
  let filePct = 0;
  const pctMatch = fileDetailPart && /\((\d{1,3}(?:\.\d+)?)\%/.exec(fileDetailPart);
  if (pctMatch) {
    filePct = parseFloat(pctMatch[1]);
  }

  // Die Prozentzahl der Ecke-Bar wird hier NICHT mehr berechnet. Sie kommt
  // ausschliesslich aus recomputeOverallTarget() (siehe setAggregateBytes()
  // weiter oben) - eine Stelle, gefuettert von BEIDEN Callbacks. Vorher war das
  // hier die einzige Quelle, wodurch die Bar waehrend eines langen Einzel-
  // transfers (keine reportStep-Aufrufe) komplett stillstand, zusaetzlich hart
  // gedeckelt auf den Anteil bereits abgeschlossener Items. Ohne bekannte
  // Byte-Gewichte (Aufrufer ohne meta.totalWeight) bleibt die Schritt-Anzahl
  // die einzige Naeherung.
  if (!(meta.totalWeight > 0) && total > 0) {
    state.targetOverallPct = Math.max(state.targetOverallPct || 0, Math.min(100, (done / total) * 100));
  }

  // Inline-Zeilen-Fortschritt (Variante 3): meta.postId/meta.url/meta.itemKind
  // kommen aus downloader.js' reportStep()-Aufrufen. pctMatch deckt hier vor
  // allem das yt-dlp-Embed-Video ab (liefert nur Prozent, keine rohen Bytes).
  if (meta.postId != null && meta.url) {
    let rowStatus = "active";
    if (fileDetailPart && fileDetailPart.includes("(cancelled)")) {
      rowStatus = "cancelled";
    } else if (meta.error || (fileDetailPart && fileDetailPart.includes("(error)"))) {
      rowStatus = "error";
    } else if (fileDetailPart && (fileDetailPart.includes("(done)") || fileDetailPart.includes("(skipped)") || fileDetailPart.includes("(100%)"))) {
      // "(100%)" deckt das Embed-Video-Ende ab (dessen finaler reportStep()-
      // Aufruf in downloader.js immer "Video (100%)" heisst, nie "(done)") -
      // ohne das blieb die Zeile bei Bulk-Batches bis zum Ende des GESAMTEN
      // Batches auf "active" haengen, statt sofort nach diesem einen Item.
      rowStatus = "done";
    } else if (meta.phase === "working") {
      rowStatus = "scanning";
    }

    const rowPatch = { status: rowStatus, postId: meta.postId };
    // Eingeplantes Gewicht dieses Items mitfuehren (echte sizeBytes bzw.
    // SIZE_ESTIMATE.* aus downloader.js) - die Aggregat-Anzeigen brauchen es,
    // solange die echte Groesse noch nicht bekannt ist (siehe rowWeight()).
    const plannedWeight = meta.weight || meta.currentStepWeight;
    if (plannedWeight > 0) rowPatch.itemWeight = plannedWeight;
    // meta.sizeBytes kommt vom yt-dlp-Groessen-Parser (siehe videoProgress.js) -
    // wenn bekannt, echte Byte-Werte statt reiner Prozentzahl nutzen (MB/GB-
    // Anzeige + Grundlage fuer die Groessen-Anzeige nach Abschluss, siehe
    // renderPostList()'s sizeStr-Fallback).
    if (rowStatus === "done") {
      rowPatch.pct = 100;
      if (meta.sizeBytes > 0) {
        rowPatch.total = meta.sizeBytes;
        rowPatch.received = meta.sizeBytes;
        if (meta.postId != null && (meta.itemKind === "comments" || meta.itemKind === "extras")) {
          state.commentsSizes.set(String(meta.postId), meta.sizeBytes);
        }
      } else if (meta.empty) {
        rowPatch.empty = true;
      }
    } else if (meta.sizeBytes > 0 && pctMatch) {
      rowPatch.total = meta.sizeBytes;
      rowPatch.received = Math.round((filePct / 100) * meta.sizeBytes);
    } else if (pctMatch) {
      rowPatch.pct = filePct;
    }
    setRowProgress(fileKey(meta.postId, meta.url, meta.itemKind || "file"), rowPatch);
  }
  state.lastDoneCount = done;
  state.lastTotalCount = total;
  state.lastPostTitle = postTitlePart;
  // GB/MB-Anzeige: meta.successWeightDone = nur erfolgreich heruntergeladene
  // Bytes (keine Fehler-Items), meta.totalWeight = unveraendertes Gesamtgewicht.
  if (meta.totalWeight > 0) {
    const successDone = meta.successWeightDone !== undefined ? meta.successWeightDone : meta.weightDone;
    // meta.weightDone = ALLES Abgearbeitete (Erfolg + Fehler + Skips) - nur fuer
    // die ETA-Restmenge, siehe calculateSmoothEta().
    if (meta.weightDone > 0) {
      state.lastProcessedWeightBytes = Math.max(state.lastProcessedWeightBytes || 0, meta.weightDone);
    }
    setAggregateBytes(successDone, meta.totalWeight);
  }

  if (fileDetailPart) {
    el("progressFileLabel").textContent = fileDetailPart;
  }
  el("progressFileFill").classList.remove("scanning");

  // Update die per-file bar unten (immer sichtbar)
  if (meta.isVideoPhase) {
    if (pctMatch) {
      state.targetFilePct = filePct;
    } else {
      // Wenn der Video-Download frisch startet, setzen wir den Balken auf 0% zurück
      state.targetFilePct = 0;
      visualFilePct = 0; // sofort snappen (kein Einlauf)
    }
  } else {
    if (pctMatch) {
      state.targetFilePct = filePct;
    } else if (fileDetailPart && (fileDetailPart.includes("(done)") || fileDetailPart.includes("(skipped)"))) {
      // Normaler Schritt abgeschlossen: sofort auf 100% springen
      state.targetFilePct = 100;
      visualFilePct = 100;
      el("progressFilePct").textContent = "100%";
      // Farben (gruen/rot) gelten bewusst nur fuer die Primary-Bar, nicht hier -
      // ein Fehler bei einem Einzel-Item pulst die Primary-Bar kurz rot, ohne
      // den laufenden Batch zu unterbrechen.
      if (meta.error) {
        pulsePrimaryError();
      }
    } else {
      // Normaler Schritt frisch gestartet
      state.targetFilePct = 0;
      visualFilePct = 0;
      el("progressFilePct").textContent = "0%";
    }
  }
}

// Minimieren-Button: klappt den Fortschritts-Body ein, Header bleibt sichtbar.
el("progressMinimize").addEventListener("click", () => {
  const panel = el("progressOverlay");
  const minimized = panel.classList.toggle("minimized");
  el("progressMinimize").textContent = minimized ? "▢" : "–";
  el("progressMinimize").title = minimized ? "Expand" : "Minimize";
  updateQuickJumpUI();
});

// Abbrechen-Button: zeigt das elegante in-Panel Modal
el("progressCancel").addEventListener("click", () => {
  showDashboardCancelModal();
});

function showDashboardCancelModal() {
  const panel = el("progressOverlay");
  if (!panel) return;
  let modal = el("progressConfirmModal");
  if (modal) modal.remove();

  modal = document.createElement("div");
  modal.id = "progressConfirmModal";
  modal.innerHTML = `
    <p>Are you sure you want to cancel the download?</p>
    <div class="pa-modal-btns">
      <button class="pa-btn-yes" id="dashModalYes">Yes, cancel</button>
      <button class="pa-btn-no" id="dashModalNo">No, continue</button>
    </div>
  `;
  panel.appendChild(modal);

  modal.querySelector("#dashModalYes").onclick = () => {
    modal.remove();
    if (activeCancelSignal) activeCancelSignal.cancelled = true;
    state.itemCancelSignals.forEach((sig) => {
      if (sig) sig.cancelled = true;
    });
    el("progressLabel").textContent = "Cancelling...";
    el("progressCancel").disabled = true;
    el("progressFill").classList.remove("done-flash", "error");
    el("progressFill").classList.add("cancelling");
  };
  modal.querySelector("#dashModalNo").onclick = () => {
    modal.remove();
  };
}

// Große-Datei-Nachfrage: zeigt das Modal und liefert "download" | "skip" | "cancel-all".
function askLargeFile(info) {
  return new Promise((resolve) => {
    const mb = info.sizeMB ? info.sizeMB.toFixed(0) : "?";
    const sizeFormatted = info.sizeBytes ? formatBytes(info.sizeBytes) : `approx. ${mb} MB`;
    
    el("largeFileTitle").textContent = "Large File Detected";
    el("largeFileText").innerHTML = `<b>"${escapeHtml(info.name)}"</b> is quite large (${sizeFormatted}).<br>Do you want to download this file?`;
    el("largeFileModal").style.display = "flex";
    const cleanup = () => {
      el("largeFileModal").style.display = "none";
      el("largeFileDownload").onclick = null;
      el("largeFileSkip").onclick = null;
      el("largeFileCancelAll").onclick = null;
    };
    el("largeFileDownload").onclick = () => { cleanup(); resolve("download"); };
    el("largeFileSkip").onclick = () => { cleanup(); resolve("skip"); };
    el("largeFileCancelAll").onclick = () => { cleanup(); resolve("cancel-all"); };
  });
}

async function checkAndShowDenoModal(errorMsg) {
  const storage = await chrome.storage.local.get(["denoSuggestionNeeded", "denoSuggestionDismissed"]);
  if (storage.denoSuggestionNeeded && !storage.denoSuggestionDismissed) {
    el("denoModal").style.display = "flex";
    return new Promise((resolve) => {
      const close = () => {
        el("denoModal").style.display = "none";
        el("denoModalSkip").onclick = null;
        el("denoModalCancel").onclick = null;
        el("denoModalInstall").onclick = null;
      };
      
      el("denoModalSkip").onclick = async () => {
        await chrome.storage.local.set({ denoSuggestionDismissed: true });
        close();
        if (errorMsg && errorMsg !== "cancelled") showToast(errorMsg);
        resolve(false);
      };
      
      el("denoModalCancel").onclick = () => {
        close();
        if (errorMsg && errorMsg !== "cancelled") showToast(errorMsg);
        resolve(false);
      };
      
      el("denoModalInstall").onclick = async () => {
        close();
        showProgress("Installing Deno JS engine...");
        try {
          await installDenoViaHost((status) => {
            showProgress(status);
          });
          hideProgress();
          showToast("Deno installed successfully!");
          resolve(true); // Signalisiert dem Aufrufer, den Download zu wiederholen!
        } catch (err) {
          hideProgress();
          showToast(`Installation failed: ${err.message}`);
          resolve(false);
        }
      };
    });
  } else {
    if (errorMsg && errorMsg !== "cancelled") {
      showToast(errorMsg);
    }
    return false;
  }
}

function getActiveCreator() {
  if (!state.activeCreatorId) return null;
  return state.creators.find((c) => String(c.id) === String(state.activeCreatorId)) || null;
}

async function downloadOne(post, file) {
  if (!(await ensureReadyToDownload())) return;
  const creator = getActiveCreator();
  const settings = await currentDownloadSettings();
  showProgress(L("toastDownloading", file.filename));
  const key = fileKey(post.id, file.url, file.kind || "file");
  setRowProgress(key, { status: "queued", postId: post.id });
  const { results } = await downloadItems(
    [{ creatorName: creator.name, post, file }],
    settings,
    { asZip: false, onProgress: updateProgress, onStep: updateStepProgress, singleFile: true, onLargeFile: askLargeFile, forceOverwrite: state.sessionDownloaded.has(key), getItemSignal }
  );
  const r = results[0];
  if (r.ok) {
    await finishProgressSuccessfully();
    file.downloaded = true;
    state.sessionDownloaded.add(key);
    showToast(r.skipped ? L("toastSkipped", file.filename) : L("toastDone", file.filename));
    finalizeRow(key, "done");
  } else if (r.cancelled) {
    await finishProgressCancelled();
    showToast(L("toastError", file.filename, r.error));
    finalizeRow(key, "cancelled");
  } else {
    await flashPrimaryError();
    showToast(L("toastError", file.filename, r.error));
    finalizeRow(key, "error");
    if (r?.unsupportedProvider) {
      pushDownloadWarning({
        ...classifyDownloadError(r.error, file.tag),
        postTitle: post.title,
        filename: file.filename,
      });
    }
  }
  renderPostList();
}

async function downloadPostExtras(post) {
  if (!(await ensureReadyToDownload())) return;
  const creator = getActiveCreator();
  const settings = await currentDownloadSettings();
  showProgress(`${post.title} · Description & comments...`);
  const extrasKey = fileKey(post.id, `${post.id}::extras`, "extras");
  setRowProgress(extrasKey, { status: "queued", postId: post.id });
  const { results } = await downloadItems(
    [{ creatorName: creator.name, post, file: { role: "extras", kind: "extras", url: `${post.id}::extras` } }],
    settings,
    { asZip: false, onProgress: updateProgress, onStep: updateStepProgress, onLargeFile: askLargeFile, getItemSignal }
  );
  const r = results[0];
  if (r?.ok) {
    await finishProgressSuccessfully();
    await updatePostExtrasDownloaded(post.id, true);
    const localPost = state.posts.find((p) => p.id === post.id);
    if (localPost) localPost.extrasDownloaded = true;
    state.sessionDownloaded.add(extrasKey);
    finalizeRow(extrasKey, "done");
    renderPostList();
    showToast(r.skipped ? L("toastSkipped", post.title) : L("toastDone", post.title));
  } else if (r?.cancelled) {
    await finishProgressCancelled();
    finalizeRow(extrasKey, "cancelled");
  } else {
    await flashPrimaryError();
    finalizeRow(extrasKey, "error");
    showToast(L("toastError", post.title, r?.error));
  }
}

async function downloadThumbnail(post) {
  if (!(await ensureReadyToDownload())) return;
  const creator = getActiveCreator();
  const settings = await currentDownloadSettings();
  showProgress("Downloading thumbnail...");
  const thumbKey = fileKey(post.id, post.thumbnail.url || `${post.id}::thumb`, "thumbnail");
  setRowProgress(thumbKey, { status: "queued", postId: post.id });
  const { results } = await downloadItems(
    [{ creatorName: creator.name, post, file: { ...post.thumbnail, kind: "thumbnail", role: "thumbnail" } }],
    settings,
    { asZip: false, onProgress: updateProgress, onStep: updateStepProgress, singleFile: true, onLargeFile: askLargeFile, forceOverwrite: state.sessionDownloaded.has(thumbKey), getItemSignal }
  );
  const r = results[0];
  if (r?.ok) {
    await finishProgressSuccessfully();
    if (post.thumbnail) post.thumbnail.downloaded = true;
    state.sessionDownloaded.add(thumbKey);
    await updateFileDownloadStatus(post.id, post.thumbnail.url, { downloaded: true }).catch(() => {});
    showToast(r.skipped ? L("toastSkipped", "Thumbnail") : L("toastDone", "Thumbnail"));
    finalizeRow(thumbKey, "done");
    renderPostList();
  } else if (r?.cancelled) {
    await finishProgressCancelled();
    finalizeRow(thumbKey, "cancelled");
  } else {
    await flashPrimaryError();
    showToast(L("toastError", "Thumbnail", r?.error));
    finalizeRow(thumbKey, "error");
  }
}

async function downloadNativeVideo(post) {
  if (!(await ensureReadyToDownload())) return;
  const creator = getActiveCreator();
  const settings = await currentDownloadSettings();
  showProgress("Downloading video...");
  const videoKey = fileKey(post.id, post.video.url || `${post.id}::video`, "video");
  setRowProgress(videoKey, { status: "queued", postId: post.id });
  const { results } = await downloadItems(
    [{ creatorName: creator.name, post, file: { ...post.video, kind: "video", role: "video" } }],
    settings,
    { asZip: false, onProgress: updateProgress, onStep: updateStepProgress, singleFile: true, onLargeFile: askLargeFile, forceOverwrite: state.sessionDownloaded.has(videoKey), getItemSignal }
  );
  const r = results[0];
  if (r?.ok) {
    await finishProgressSuccessfully();
    if (post.video) post.video.downloaded = true;
    state.sessionDownloaded.add(videoKey);
    await updateFileDownloadStatus(post.id, post.video.url, { downloaded: true }).catch(() => {});
    showToast(r.skipped ? L("toastSkipped", "Video") : L("toastDone", "Video"));
    finalizeRow(videoKey, "done");
    renderPostList();
  } else if (r?.cancelled) {
    await finishProgressCancelled();
    finalizeRow(videoKey, "cancelled");
  } else {
    await flashPrimaryError();
    showToast(L("toastError", "Video", r?.error));
    finalizeRow(videoKey, "error");
  }
}

async function downloadDescription(post) {
  if (!(await ensureReadyToDownload())) return;
  const creator = getActiveCreator();
  const settings = await currentDownloadSettings();
  showProgress("Downloading description...");
  const descKey = fileKey(post.id, `${post.id}::description`, "description");
  setRowProgress(descKey, { status: "queued", postId: post.id });
  const { results } = await downloadItems(
    [{ creatorName: creator.name, post, file: { role: "description", kind: "description", url: `${post.id}::description` } }],
    settings,
    { asZip: false, onProgress: updateProgress, onStep: updateStepProgress, singleFile: true, onLargeFile: askLargeFile, getItemSignal }
  );
  const r = results[0];
  if (r?.ok) {
    await finishProgressSuccessfully();
    state.sessionDownloaded.add(descKey);
    showToast(r.skipped ? L("toastSkipped", "Description") : L("toastDone", "Description"));
    finalizeRow(descKey, "done");
    renderPostList();
  } else if (r?.cancelled) {
    await finishProgressCancelled();
    finalizeRow(descKey, "cancelled");
  } else {
    await flashPrimaryError();
    showToast(L("toastError", "Description", r?.error));
    finalizeRow(descKey, "error");
  }
}

async function downloadComments(post) {
  if (!(await ensureReadyToDownload())) return;
  const creator = getActiveCreator();
  const settings = await currentDownloadSettings();
  showProgress("Downloading comments...");
  const commKey = fileKey(post.id, `${post.id}::comments`, "comments");
  setRowProgress(commKey, { status: "queued", postId: post.id });
  const { results } = await downloadItems(
    [{ creatorName: creator.name, post, file: { role: "comments", kind: "comments", url: `${post.id}::comments` } }],
    settings,
    { asZip: false, onProgress: updateProgress, onStep: updateStepProgress, singleFile: true, onLargeFile: askLargeFile, getItemSignal }
  );
  const r = results[0];
  if (r?.ok) {
    await finishProgressSuccessfully();
    state.sessionDownloaded.add(commKey);
    showToast(r.skipped ? L("toastSkipped", "Comments") : L("toastDone", "Comments"));
    finalizeRow(commKey, "done");
    renderPostList();
  } else if (r?.cancelled) {
    await finishProgressCancelled();
    finalizeRow(commKey, "cancelled");
  } else {
    await flashPrimaryError();
    showToast(L("toastError", "Comments", r?.error));
    finalizeRow(commKey, "error");
  }
}

async function downloadEmbedViaYtDlp(post, isRetry = false) {
  const settings = await currentDownloadSettings();
  const ping = await pingYtDlpHost().catch(() => ({ ok: false }));

  if (!ping.ok) {
    showToast("The bridge isn't set up yet - opening the setup guide.");
    chrome.tabs.create({ url: chrome.runtime.getURL("setup/setup.html") });
    return;
  }
  if (!ping.ytdlpFound) {
    showToast("Bridge is connected, but video downloads aren't set up yet - enable them in Settings.");
    openSettingsModal();
    return;
  }

  const creator = getActiveCreator();
  const creatorFolder = (creator ? creator.name : "creator").replace(/[\\/:*?"<>|]/g, "_");
  const folderName = buildPostFolderName(post, settings.naming);

  if (settings.askBeforeLargeFiles) {
    const sizeBytes = post.video?.sizeBytes || 0;
    const sizeMB = sizeBytes ? sizeBytes / (1024 * 1024) : 0;
    const thresholdMB = settings.largeFileThresholdMB || 500;
    if ((sizeMB > 0 && sizeMB >= thresholdMB) || (sizeMB === 0 && thresholdMB <= 100)) {
      const decision = await askLargeFile({
        name: `${post.title} (Video)`,
        sizeBytes: sizeBytes || 0,
        sizeMB: sizeMB || 50,
        index: 0,
        total: 1
      });
      if (decision === "cancel-all" || decision === "skip") return;
    }
  }

  const outputDir = settings.customFullPath
    ? `${settings.customFullPath.replace(/[\\/]+$/, "")}/${creatorFolder}/${folderName}`
    : null;
  const videoBaseName = sanitizeForPath(post.title, "video");
  const filenameTemplate = outputDir
    ? `${videoBaseName} - Video.%(ext)s`
    : `${creatorFolder}/${folderName}/${videoBaseName} - Video.%(ext)s`;

  const ytdlpFormat = buildYtdlpFormat(settings.videoQuality);
  const isAudioOnly = settings.videoQuality === "audio";

  // Pre-Check ob Datei schon existiert
  const defDir = await getDefaultDownloadDir().catch(() => null);
  const subfolder = (settings.subfolderPath || "PatreonArchiver").trim();
  const bridgeBaseDir = settings.customFullPath
    ? settings.customFullPath.replace(/[\\/]+$/, "")
    : (defDir ? `${defDir.replace(/[\\/]+$/, "")}${subfolder ? "/" + subfolder : ""}` : null);
  const useBridgePath = !!bridgeBaseDir;
  const useDirHandle = !useBridgePath && settings.downloadMode === "fs" && !!settings.dirHandle;

  const existingFile = await findExistingVideoFile({
    creatorName: creator.name,
    postFolder: folderName,
    videoBaseName,
    isAudioOnly,
    settings,
    bridgeConnected: true,
    bridgeBaseDir,
    useBridgePath,
    useDirHandle
  });

  const embedKey = fileKey(post.id, post.video.url || `${post.id}::embed`, "embed");

  const shouldSkipExisting = settings.skipExistingFiles !== false && !isRetry;
  if (shouldSkipExisting && existingFile) {
    if (!isRetry) {
      showProgress("Downloading video...");
    }
    state.lastDoneCount = 1;
    state.lastTotalCount = 1;
    el("progressFileLabel").textContent = `${post.title} · Video (skipped)`;
    state.targetFilePct = 100;
    state.targetOverallPct = 100;
    await finishProgressSuccessfully();
    if (post.video) post.video.downloaded = true;
    updateFileDownloadStatus(post.id, post.video.url, { downloaded: true }).catch((err) =>
      console.warn("[PatreonArchiver Debug] Failed to persist embed video downloaded status:", err)
    );
    showToast("Video already downloaded (skipped).");
    finalizeRow(embedKey, "done");
    renderPostList();
    return;
  }

  if (!isRetry) {
    showProgress("Downloading video...");
    state.lastDoneCount = 0;
    state.lastTotalCount = 1;
    setRowProgress(embedKey, { status: "queued", postId: post.id });
  } else {
    state.targetOverallPct = 0;
    visualOverallPct = 0;
    el("progressLabel").textContent = "Retrying with a different engine...";
  }
  // Dasselbe Signal treibt sowohl den globalen Cancel-Button (Ecke-Overlay)
  // als auch den Cancel-Button dieser einen Zeile - beide sollen denselben
  // laufenden yt-dlp-Prozess abbrechen.
  activeCancelSignal = getItemSignal({ postId: post.id, url: post.video.url, kind: "embed" });
  activeCancelSignal.cancelled = false;

  state.lastDoneCount = 1;
  state.lastTotalCount = 1;
  state.lastPostTitle = "Downloading video...";

  const feedProgress = createVideoProgressTracker(isAudioOnly);
  let mergeTickInterval = null;

  function applyProgress(line) {
    const { pct, phaseLabel, speed, totalBytes } = feedProgress(line);
    if (phaseLabel === "Merging" && !mergeTickInterval) {
      mergeTickInterval = setInterval(() => applyProgress(null), 500);
    }

    if (line && line.includes("has already been downloaded")) {
      el("progressFileLabel").textContent = `${post.title} · Video (skipped)`;
      state.targetFilePct = 100;
      state.targetOverallPct = 100;
      setRowProgress(embedKey, { status: "active", postId: post.id, pct: 100 });
    } else {
      el("progressFileLabel").textContent = speed ? `${phaseLabel} · ${speed}` : phaseLabel;
      state.targetFilePct = pct;
      // Math.max statt harter Zuweisung: waehrend der Merge-Phase tickt ein
      // 500ms-Intervall weiter, das auch NACH dem eigentlichen Abschluss noch
      // feuern kann. Eine direkte Zuweisung hat targetOverallPct dann von 100
      // wieder auf ~97 zurueckgesetzt - finishProgressSuccessfully() wartete
      // anschliessend vergeblich darauf, dass visualOverallPct 99.5 erreicht,
      // und lief jedes Mal in sein Sicherheitsnetz-Timeout. Genau das Symptom
      // "Balken erreicht am Ende nie 100%".
      state.targetOverallPct = Math.max(state.targetOverallPct || 0, pct);
      // Wenn yt-dlp eine Groesse fuer den aktuellen Stream meldet, echte
      // Byte-Werte statt reiner Prozentzahl zeigen (MB/GB-Anzeige + bessere
      // Est.-Time-Berechnung, da calculateSmoothEta() auf Byte-Werten basiert).
      const rowPatch = { status: "active", postId: post.id };
      if (totalBytes > 0) {
        rowPatch.received = Math.round((pct / 100) * totalBytes);
        rowPatch.total = totalBytes;
        rowPatch.itemWeight = totalBytes;
      } else {
        rowPatch.pct = pct;
      }
      setRowProgress(embedKey, rowPatch);
      // Groesse/ETA der Ecke auch fuer den Einzel-Video-Button fuellen - genau
      // ueber denselben Weg wie der Bulk-Pfad (setAggregateBytes), nicht ueber
      // eine zweite eigene Rechnung. updateTarget:false, weil die Prozentzahl
      // hier bewusst aus yt-dlps phasenskaliertem pct kommt (0-80 Video, 80-95
      // Audio, 95-99 Merge, siehe videoProgress.js) - die reine Byte-Rechnung
      // kennt die Merge-Phase nicht und wuerde am Ende gegen die zwei
      // Zielwerte arbeiten.
      if (totalBytes > 0) setAggregateBytes(0, totalBytes, { updateTarget: false });
    }
  }

  try {
    await downloadViaYtDlp(
      {
        url: post.video.url,
        outputDir,
        filenameTemplate,
        format: ytdlpFormat,
        cancelSignal: activeCancelSignal,
        forceOverwrite: !settings.skipExistingFiles
      },
      applyProgress
    );
    // Merge-Ticker SOFORT stoppen (nicht erst im finally): er laeuft sonst
    // waehrend der gesamten Abschluss-Animation weiter und schreibt dabei
    // laufend an state.targetOverallPct/targetFilePct herum.
    if (mergeTickInterval) { clearInterval(mergeTickInterval); mergeTickInterval = null; }
    await finishProgressSuccessfully();
    if (post.video) post.video.downloaded = true;
    updateFileDownloadStatus(post.id, post.video.url, { downloaded: true }).catch((err) =>
      console.warn("[PatreonArchiver Debug] Failed to persist embed video downloaded status:", err)
    );
    showToast(L("toastDone", "Video"));
    finalizeRow(embedKey, "done");
    renderPostList();
  } catch (err) {
    if (mergeTickInterval) { clearInterval(mergeTickInterval); mergeTickInterval = null; }
    console.warn("[PA] yt-dlp error (attempt 1):", err.message);
    const retried = await checkAndShowDenoModal(err.message);
    if (retried) {
      await downloadEmbedViaYtDlp(post, true);
      return;
    }
    // Abbruch ist kein Fehler: amberfarbener Abschluss (jetzt ebenfalls bis
    // 100% gefuellt) statt rotem Fehler-Blitz - gleiche Unterscheidung wie in
    // allen anderen Download-Funktionen.
    if (err.message === "cancelled") {
      await finishProgressCancelled();
      showToast("Video download cancelled.");
      finalizeRow(embedKey, "cancelled");
    } else {
      await flashPrimaryError();
      showToast("Video download failed.");
      finalizeRow(embedKey, "error");
    }
  } finally {
    if (mergeTickInterval) clearInterval(mergeTickInterval);
  }
}

async function downloadMany(pairs) {
  if (pairs.length === 0) return;
  const creator = getActiveCreator();
  const settings = await currentDownloadSettings();
  const items = pairs.map(({ post, file }) => ({ creatorName: creator.name, post, file }));

  activeCancelSignal = { cancelled: false };
  el("progressCancel").disabled = false;

  state.activeDownloadKeys = pairs.map(({ post, file }) => fileKey(post.id, file.url, file.kind || "file"));

  // MUSS vor dem Seeding stehen: updatePostAggregateUI() wertet
  // state.isDownloading aus, um zwischen "laeuft noch" und "uebriggebliebene
  // Karteileiche" zu unterscheiden. Waeren die frisch als "queued" gesetzten
  // Zeilen bei false, wuerden sie fuer einen Wimpernschlag als unbekannt/rot
  // eingefaerbt, bevor showProgress() weiter unten das Flag setzt.
  state.isDownloading = true;

  // Schritt-/Gewichtsplanung VOR dem Seeding: planDownloadSteps() stempelt
  // dabei `__appliedWeight` auf jedes beteiligte Item. Nur dadurch kennt die
  // Zeile ihr eingeplantes Gewicht schon im "queued"-Zustand - der Post-
  // Aggregatbalken rechnet sonst mit einem 500-KB-Platzhalter pro wartender
  // Zeile und zeigt viel zu frueh viel zu viel an (und friert danach ein,
  // sobald das grosse Item seine echte Groesse meldet).
  const plan = planDownloadSteps(items, settings, {});

  // Alle Zeilen sofort als "wartend" markieren - downloadItems() verarbeitet
  // sie jetzt parallel (typbegrenzt ueber Concurrency-Pools in downloader.js),
  // nicht mehr strikt nacheinander, daher sollen alle betroffenen Zeilen sofort
  // sichtbar reagieren statt erst wenn sie tatsaechlich an der Reihe sind.
  pairs.forEach(({ post, file }) => {
    setRowProgress(fileKey(post.id, file.url, file.kind || "file"), {
      status: "queued",
      postId: post.id,
      itemWeight: file?.__appliedWeight || 0,
    });
  });

  logMilestone(`Download batch started: ${pairs.length} item(s), ${plan.totalSteps} step(s), format=${state.bulkFormat}`);

  let results, embedResults, extraResults;
  if (state.bulkFormat === "zip") {
    showProgress("Preparing ZIP...");
    const zipName = `${creator.name.replace(/[\\/:*?"<>|]/g, "_")}.zip`;
    ({ results, embedResults, extraResults } = await downloadItems(items, settings, {
      asZip: true,
      zipName,
      onProgress: updateProgress,
      onStep: updateStepProgress,
      cancelSignal: activeCancelSignal,
      onLargeFile: askLargeFile,
      getItemSignal,
    }));
  } else {
    // Label aus derselben Planung wie oben (und wie downloadItems() sie intern
    // macht) - vorher stand hier eine handkopierte Zweitfassung der Rechnung,
    // die Description und Comments doppelt gezaehlt hat ("5/7 statt 5/5").
    showProgress(`Downloading ${plan.totalSteps} item(s)...`);
    ({ results, embedResults, extraResults } = await downloadItems(items, settings, {
      asZip: false,
      onProgress: updateProgress,
      onStep: updateStepProgress,
      cancelSignal: activeCancelSignal,
      onLargeFile: askLargeFile,
      getItemSignal,
    }));
  }
  // War der Batch (ganz oder teilweise) abgebrochen? Vorher wurde hier IMMER
  // gruen "Download Done" gezeigt, selbst wenn per Cancel abgebrochen wurde.
  const wasCancelled = activeCancelSignal?.cancelled || results.some((r) => r?.cancelled);
  if (wasCancelled) {
    await finishProgressCancelled();
  } else {
    await finishProgressSuccessfully();
  }
  pairs.forEach(({ post, file }, i) => {
    const key = fileKey(post.id, file.url, file.kind || "file");
    if (results[i]?.ok) {
      file.downloaded = true;
      state.sessionDownloaded.add(key);
      if (file.kind === "thumbnail" || file.role === "thumbnail") {
        if (post.thumbnail) post.thumbnail.downloaded = true;
        if (post.thumbnail?.url) updateFileDownloadStatus(post.id, post.thumbnail.url, { downloaded: true }).catch(() => {});
      } else if (file.kind === "video" || file.kind === "embed" || file.role === "video") {
        if (post.video) post.video.downloaded = true;
        if (post.video?.url) updateFileDownloadStatus(post.id, post.video.url, { downloaded: true }).catch(() => {});
      } else if (file.role === "extras") {
        // Gleiche Buchhaltung wie im Einzel-Button-Pfad (downloadPostExtras):
        // das Post-Flag setzen, damit "Hide already downloaded" greift. NICHT
        // updateFileDownloadStatus() mit der synthetischen `${id}::extras`-URL.
        updatePostExtrasDownloaded(post.id, true).catch(() => {});
        const localPost = state.posts.find((pp) => pp.id === post.id);
        if (localPost) localPost.extrasDownloaded = true;
      } else if (file.kind === "description" || file.role === "description" || file.kind === "comments" || file.role === "comments") {
        // Description/Comments haben keine echte URL/Datei-DB-Zeile (synthetischer
        // Key) - nur session-lokal ueber state.sessionDownloaded tracken, siehe oben.
      } else {
        if (file.url) updateFileDownloadStatus(post.id, file.url, { downloaded: true }).catch(() => {});
      }
      finalizeRow(key, "done");
    } else {
      const cancelled = !!results[i]?.cancelled;
      finalizeRow(key, cancelled ? "cancelled" : "error");
      if (!cancelled) {
        const classified = classifyDownloadError(results[i]?.error, file.tag);
        if (classified) {
          pushDownloadWarning({ ...classified, postTitle: post.title, filename: file.filename });
        }
      }
    }
  });

  // ABSCHLUSS-TOAST ZAEHLT JETZT DIESELBEN DINGE WIE DIE ECKE-ANZEIGE.
  //
  // Vorher wurden hier `results` (index-gleich mit den vom Nutzer ausgewaehlten
  // Zeilen) mit `extraResults` und `embedResults` zu einer Liste verschmolzen und
  // nur ueber die URL dedupliziert. Description/Comments benutzen aber
  // SYNTHETISCHE URLs (`<postId>-description`, `<postId>-comments`), die mit
  // keiner Zeilen-URL kollidieren - sie kamen also zusaetzlich obendrauf. Ergebnis
  // beim Nutzer: 8 ausgewaehlte Dateien, Ecke zeigt korrekt 8/8, der Toast aber
  // "8/12 downloaded, 4 skipped" - und zwar systematisch +2 pro Post, weil
  // description und comments meistens als `skipped: true` zurueckkommen (Datei
  // existiert schon bzw. kein Inhalt vorhanden). Das ist exakt die
  // Doppelzaehlung, die `planDownloadSteps()` in Runde 19 als EINE Quelle
  // beenden sollte - hier lebte die zweite, alte Rechnung noch weiter.
  //
  // Jetzt: Nenner und Zaehler kommen aus derselben Menge, die auch die Zeilen und
  // die Ecke abbilden (die ausgewaehlten Items). Automatisch mitgelaufene
  // Post-Extras zaehlen NICHT mehr in die Summe - sie tauchen nur noch auf, wenn
  // sie tatsaechlich fehlgeschlagen sind (sonst waere ihr Fehler unsichtbar).
  const total = pairs.length;
  const downloaded = results.filter((r) => r?.ok && !r.skipped).length;
  const skipped = results.filter((r) => r?.skipped).length;
  const failed = results.filter((r) => r && !r.ok && !r.skipped && !r.cancelled).length;
  const cancelled = results.some((r) => r?.cancelled) || !!activeCancelSignal?.cancelled;
  const extrasFailed = [...(embedResults || []), ...(extraResults || [])]
    .filter((r) => r && !r.ok && !r.skipped && !r.cancelled).length;

  let summary;
  if (downloaded === 0 && skipped === total && total > 0) {
    summary = "Everything already downloaded (skipped)";
  } else if (skipped > 0) {
    summary = `${downloaded}/${total} downloaded, ${skipped} skipped`;
  } else {
    summary = `${downloaded}/${total} downloaded`;
  }
  if (failed > 0) {
    summary += `, ${failed} failed`;
  }
  if (extrasFailed > 0) {
    summary += `, ${extrasFailed} extra file(s) failed`;
  }
  if (cancelled) {
    summary += " (cancelled)";
  }
  logMilestone(`Download batch finished: ${summary}`);
  // Sofort wegschreiben statt auf das Sammelfenster zu warten - direkt nach
  // einem Batch schliesst der Nutzer den Tab am ehesten.
  flushAppLog().catch(() => {});
  showToast(summary);

  // Summary for externally embedded videos handled via the bridge (or link-only).
  if (embedResults && embedResults.length > 0) {
    const viaBridgeOk = embedResults.filter((r) => r.viaBridge && r.ok).length;
    const viaBridgeFailed = embedResults.filter((r) => r.viaBridge && !r.ok).length;
    const linkOnly = embedResults.filter((r) => !r.viaBridge).length;
    setTimeout(async () => {
      // Prüfen, ob für eines der fehlgeschlagenen Videos Deno empfohlen wird
      const needsDeno = embedResults.some((r) => r.needsDeno);
      if (needsDeno) {
        const retried = await checkAndShowDenoModal();
        if (retried) {
          showToast("Deno installed! Try downloading the failed videos again.");
        }
      }
    }, 3200);
  }

  state.selected.clear();
  renderPostList();
}

// ---------- Settings-Modal ----------

function updateStorageModeVisibility() {
  const isCustom = el("storageModeCustomRadio").checked;
  el("downloadsModeBody").style.display = isCustom ? "none" : "block";
  el("customModeBody").style.display = isCustom ? "block" : "none";
  
  if (isCustom) {
    el("optionCustom").classList.add("active");
    el("optionDownloads").classList.remove("active");
  } else {
    el("optionDownloads").classList.add("active");
    el("optionCustom").classList.remove("active");
  }
}

function updateDownloadsPathHint() {
  const name = (el("subfolderInput").value || "PatreonArchiver").trim() || "PatreonArchiver";
  el("downloadsPathHint").textContent = `Saved inside your Downloads folder, in a subfolder named "${name}".`;
}

async function openSettingsModal() {
  state.settings = await getSettings();
  el("datePositionSelect").value = state.settings.naming?.datePosition || "none";
  el("includePostIdCheck").checked = !!state.settings.naming?.includePostId;
  el("customFullPathInput").value = state.settings.customFullPath || "";
  el("includeThumbnailsCheck").checked = state.settings.includeThumbnails !== false;
  el("includeDescriptionCheck").checked = state.settings.includeDescription !== false;
  el("includeCommentsCheck").checked = state.settings.includeComments !== false;
  el("skipExistingCheck").checked = state.settings.skipExistingFiles !== false;
  el("fetchSizesDuringScanCheck").checked = !!state.settings.fetchSizesDuringScan;
  el("askLargeFilesCheck").checked = state.settings.askBeforeLargeFiles !== false;
  el("largeThresholdInput").value = state.settings.largeFileThresholdMB || 500;
  el("largeThresholdRow").style.display = el("askLargeFilesCheck").checked ? "block" : "none";

  // Welcher Modus ist gerade aktiv? "custom" nur, wenn wirklich ein voller
  // Pfad gespeichert ist - sonst immer der Default (Downloads-Unterordner),
  // der ganz ohne Zusatzsoftware funktioniert.
  const isCustomMode = !!state.settings.customFullPath;
  el("storageModeDownloads").checked = !isCustomMode;
  el("storageModeCustomRadio").checked = isCustomMode;
  el("subfolderInput").value = state.settings.subfolderPath || "PatreonArchiver";
  updateDownloadsPathHint();
  updateChosenFolderText();
  updateStorageModeVisibility();

  el("videoQualitySelect").value = state.settings.videoQuality || "best";
  el("videoQualitySelect").dispatchEvent(new Event("change"));

  // Ein echter, freier Ordnerdialog (beliebiges Laufwerk, voller Pfad) braucht
  // die Desktop-App - ohne sie bleibt "Custom folder" ausgegraut und der
  // Default (Downloads-Unterordner) ist die einzig nutzbare Option.
  const btn = el("chooseFolderBtn");
  const note = el("bridgeNeededHint");
  btn.disabled = true;
  btn.style.opacity = "0.5";
  btn.style.cursor = "default";
  note.style.display = "block";
  note.textContent = "Checking...";
  pingYtDlpHost()
    .then((ping) => {
      if (ping.ok) {
        btn.disabled = false;
        btn.style.opacity = "1";
        btn.style.cursor = "pointer";
        note.style.display = "none";
        el("optionCustom").classList.remove("disabled");
      } else {
        note.textContent = "Install the desktop app to enable a custom folder location.";
        el("optionCustom").classList.add("disabled");
        if (el("storageModeCustomRadio").checked) {
          el("storageModeDownloads").click();
        }
      }
    })
    .catch(() => {
      note.textContent = "Install the desktop app to enable a custom folder location.";
      el("optionCustom").classList.add("disabled");
      if (el("storageModeCustomRadio").checked) {
        el("storageModeDownloads").click();
      }
    });

  el("settingsModal").style.display = "flex";
  refreshYtDlpStatus();

  state.settingsSnapshot = {
    datePosition: el("datePositionSelect").value,
    includePostId: el("includePostIdCheck").checked,
    customFullPath: el("customFullPathInput").value || "",
    includeThumbnails: el("includeThumbnailsCheck").checked,
    includeDescription: el("includeDescriptionCheck").checked,
    includeComments: el("includeCommentsCheck").checked,
    skipExistingFiles: el("skipExistingCheck").checked,
    fetchSizesDuringScan: el("fetchSizesDuringScanCheck").checked,
    askBeforeLargeFiles: el("askLargeFilesCheck").checked,
    largeFileThresholdMB: parseInt(el("largeThresholdInput").value, 10) || 500,
    videoQuality: el("videoQualitySelect").value,
    storageModeCustomRadio: el("storageModeCustomRadio").checked,
    subfolderPath: el("subfolderInput").value || "PatreonArchiver"
  };
  el("fetchSizesScanWarning").style.display = el("fetchSizesDuringScanCheck").checked ? "block" : "none";
  el("settingsUnsavedBanner").style.display = "none";
}

el("storageModeDownloads").addEventListener("change", async () => {
  el("optionCustom").classList.remove("invalid");
  el("customPathError").style.display = "none";
  updateStorageModeVisibility();
  await saveSettings({ customFullPath: "", dirHandle: null, dirHandleName: null });
  state.settings = { ...state.settings, customFullPath: "", dirHandle: null, dirHandleName: null };
});

el("storageModeCustomRadio").addEventListener("change", () => {
  // Nicht sofort speichern - solange noch kein Ordner gewählt wurde, bleibt
  // der bisherige Speicherort aktiv, damit nichts kaputt geht.
  updateStorageModeVisibility();
});

el("optionDownloads").addEventListener("click", () => {
  el("storageModeDownloads").click();
});

el("optionCustom").addEventListener("click", () => {
  if (!el("optionCustom").classList.contains("disabled")) {
    el("storageModeCustomRadio").click();
  }
});

el("subfolderInput").addEventListener("change", async () => {
  const name = (el("subfolderInput").value || "PatreonArchiver").trim() || "PatreonArchiver";
  el("subfolderInput").value = name;
  updateDownloadsPathHint();
  await saveSettings({ subfolderPath: name });
  state.settings = { ...state.settings, subfolderPath: name };
});

// Threshold-Feld nur zeigen, wenn "Ask before large files" an ist.
el("askLargeFilesCheck").addEventListener("change", () => {
  el("largeThresholdRow").style.display = el("askLargeFilesCheck").checked ? "block" : "none";
});

function updateScanSizesSettingEnabled(enabled) {
  const check = el("fetchSizesDuringScanCheck");
  const section = check ? check.closest(".switch-row") : null;
  if (!section) return;

  if (enabled) {
    check.disabled = false;
    section.style.opacity = "1";
    section.style.pointerEvents = "auto";
    const note = el("scanSizesBridgeNote");
    if (note) note.remove();
  } else {
    check.disabled = true;
    section.style.opacity = "0.5";
    section.style.pointerEvents = "none";
    let note = el("scanSizesBridgeNote");
    if (!note) {
      note = document.createElement("p");
      note.id = "scanSizesBridgeNote";
      note.className = "hint";
      note.style.color = "#ff4d4d";
      note.style.marginTop = "5px";
      note.style.fontWeight = "bold";
      const labelDiv = section.querySelector("div");
      if (labelDiv) labelDiv.appendChild(note);
      else section.appendChild(note);
    }
    note.innerHTML = `
      <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="#ff4d4d" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="vertical-align: middle; margin-right: 4px; display: inline-block;">
        <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path>
        <line x1="12" y1="9" x2="12" y2="13"></line>
        <line x1="12" y1="17" x2="12.01" y2="17"></line>
      </svg>
      Desktop Bridge is required to retrieve video sizes.
    `;
  }
}

let ytdlpStatusChecked = false;
async function refreshYtDlpStatus() {
  const box = el("ytdlpStatus");
  if (!ytdlpStatusChecked) box.innerHTML = "Checking...";
  const result = await pingYtDlpHost();
  ytdlpStatusChecked = true;

  if (!result.ok) {
    box.innerHTML = `
      <div><b>${L("bridgeStatusLabel")}:</b> <span class="yt-bad">${L("statusNotConnected")}</span></div>
      <div style="margin-top:4px;"><b>${L("videoEngineStatusLabel")}:</b> <span class="yt-warn">${L("statusUnknownNoBridge")}</span></div>
      <p style="margin:10px 0 0; font-size:11.5px; color:var(--text-dim); line-height:1.6;">
        ${L("ytdlpHint")}
      </p>
    `;
    updateScanSizesSettingEnabled(false);
    return;
  }

  updateScanSizesSettingEnabled(true);

  if (!result.ytdlpFound) {
    box.innerHTML = `
      <div><b>${L("bridgeStatusLabel")}:</b> <span class="yt-ok">${L("statusConnected")}</span></div>
      <div style="margin-top:4px;"><b>${L("videoEngineStatusLabel")}:</b> <span class="yt-warn">${L("statusNotSetUp")}</span></div>
    `;
    const btn = document.createElement("button");
    btn.textContent = L("enableVideoDownloadsBtn");
    btn.onclick = async () => {
      btn.disabled = true;
      showProgress(L("settingUpVideoDownloads"));
      try {
        await installYtDlpViaHost((line) => {
          el("progressMeta").textContent = line;
        });
        hideProgress();
        showToast(L("videoDownloadsEnabled"));
        refreshYtDlpStatus();
      } catch (err) {
        hideProgress();
        showToast(err.message);
        btn.disabled = false;
      }
    };
    box.appendChild(btn);
    return;
  }

  box.innerHTML = `
    <div><b>${L("bridgeStatusLabel")}:</b> <span class="yt-ok">${L("statusConnected")}</span></div>
    <div style="margin-top:4px;"><b>${L("videoEngineStatusLabel")}:</b> <span class="yt-ok">${L("statusReady")}</span></div>
  `;
}

function closeSettingsModal() {
  el("settingsModal").style.display = "none";
  const banner = el("settingsUnsavedBanner");
  if (banner) banner.style.display = "none";
}

function updateChosenFolderText() {
  const fullPath = state.settings?.customFullPath;
  if (fullPath) {
    el("chosenFolderText").textContent = `✓ ${fullPath}`;
    el("chosenFolderText").style.color = "var(--green)";
  } else {
    el("chosenFolderText").textContent = L("chosenFolderNone");
    el("chosenFolderText").style.color = "";
  }
}

el("chooseFolderBtn").addEventListener("click", async () => {
  // Opens a REAL OS folder dialog via the desktop app (returns the full
  // path). Saved immediately on success - previously this only lived in
  // memory until the separate "Save" button was clicked, so closing the
  // modal any other way (the ✕, or clicking outside it) silently discarded
  // the choice.
  const ping = await pingYtDlpHost().catch(() => ({ ok: false }));
  if (ping.ok) {
    try {
      const path = await pickFolderViaBridge();
      if (path) {
        await saveSettings({ customFullPath: path, dirHandle: null, dirHandleName: null });
        state.settings = { ...state.settings, customFullPath: path, dirHandle: null, dirHandleName: null };
        el("customFullPathInput").value = path;
        updateChosenFolderText();
        el("optionCustom").classList.remove("invalid");
        el("customPathError").style.display = "none";
      }
      return;
    } catch (err) {
      showToast(err.message);
    }
  } else {
    // No full-path folder dialog available without the desktop app. Rather
    // than the old fallback that only ever revealed a bare folder name (and
    // confused people, since it looked like a real path but wasn't), just
    // point at the Default location, which needs no extra setup at all.
    showToast("Custom folder needs the desktop app. Using the default Downloads location instead.");
    el("storageModeDownloads").checked = true;
    updateStorageModeVisibility();
    await saveSettings({ customFullPath: "", dirHandle: null, dirHandleName: null });
    state.settings = { ...state.settings, customFullPath: "", dirHandle: null, dirHandleName: null };
  }
});

el("saveSettingsBtn").addEventListener("click", async () => {
  // Validate: if custom storage mode is checked but no path is selected, prevent saving
  if (el("storageModeCustomRadio").checked && !state.settings?.customFullPath) {
    el("optionCustom").classList.add("invalid");
    const errorEl = el("customPathError");
    errorEl.textContent = "Please choose a path or choose default";
    errorEl.style.display = "block";
    showToast("Please choose a custom path first.");
    return;
  }

  // Clear validation styling if successful
  el("optionCustom").classList.remove("invalid");
  el("customPathError").style.display = "none";

  await saveSettings({
    customFullPath: state.settings?.customFullPath || "",
    dirHandle: state.settings?.dirHandle || null,
    dirHandleName: state.settings?.dirHandleName || null,
    naming: {
      datePosition: el("datePositionSelect").value,
      includePostId: el("includePostIdCheck").checked,
    },
    includeThumbnails: el("includeThumbnailsCheck").checked,
    includeDescription: el("includeDescriptionCheck").checked,
    includeComments: el("includeCommentsCheck").checked,
    skipExistingFiles: el("skipExistingCheck").checked,
    fetchSizesDuringScan: el("fetchSizesDuringScanCheck").checked,
    askBeforeLargeFiles: el("askLargeFilesCheck").checked,
    largeFileThresholdMB: Math.max(1, parseInt(el("largeThresholdInput").value, 10) || 500),
    videoQuality: el("videoQualitySelect").value,
  });
  state.settings = await getSettings();
  if (state.activeCreatorId) {
    renderPostList();
  }
  showToast("Settings saved");
  closeSettingsModal();
});

el("downloadInstallerBtn").addEventListener("click", () => {
  closeSettingsModal();
  chrome.tabs.create({ url: chrome.runtime.getURL("setup/setup.html") });
});

el("settingsBtn").addEventListener("click", openSettingsModal);
el("settingsClose").addEventListener("click", closeSettingsModal);

// Rate-Limit-/Missbrauchsschutz-Warn-Indikator (siehe classifyDownloadError()
// weiter oben) - Button ist per default versteckt, erscheint nur, wenn
// state.downloadWarnings Eintraege hat.
el("downloadWarningsBtn").addEventListener("click", () => {
  renderDownloadWarningsModal();
  el("downloadWarningsModal").style.display = "flex";
});
el("downloadWarningsClose").addEventListener("click", () => {
  el("downloadWarningsModal").style.display = "none";
});
el("downloadWarningsClear").addEventListener("click", () => {
  state.downloadWarnings = [];
  updateDownloadWarningsUI();
  renderDownloadWarningsModal();
});
updateDownloadWarningsUI();

// Help & about modal
el("helpBtn").addEventListener("click", () => {
  try {
    const v = chrome.runtime.getManifest().version;
    el("helpVersion").textContent = `v${v}`;
  } catch {
    /* ignore */
  }
  el("helpModal").style.display = "flex";
});
el("helpClose").addEventListener("click", () => {
  el("helpModal").style.display = "none";
});
el("helpModal").addEventListener("click", (e) => {
  if (e.target.id === "helpModal") el("helpModal").style.display = "none";
});
const replayBtn = el("replayTourBtn");
if (replayBtn) {
  replayBtn.addEventListener("click", () => {
    el("helpModal").style.display = "none";
    startTour(state, renderCreatorList, refreshActivePosts, loadCreators, renderPostList);
  });
}

// ---------- Export Diagnostics ----------
//
// Packt alles zusammen, was man zur Ferndiagnose braucht: den persistenten
// Log-Ringpuffer der Extension, die Log-Dateien der Bridge (falls installiert)
// und eine Versionsuebersicht. Laeuft bewusst AUCH OHNE Bridge - dann fehlen
// eben deren Dateien, der Rest ist trotzdem da.
async function exportDiagnostics() {
  const btn = el("exportDiagnosticsBtn");
  const originalHtml = btn ? btn.innerHTML : null;
  try {
    if (btn) { btn.disabled = true; btn.textContent = "Collecting…"; }
    // Erst alles Gepufferte wegschreiben, damit auch die letzten Sekunden drin sind.
    await flushAppLog().catch(() => {});

    const zip = new JSZip();
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);

    const manifest = chrome.runtime.getManifest();
    const stored = await chrome.storage.local.get("installedBridgeVersion");
    const info = {
      generatedAt: new Date().toISOString(),
      extensionName: manifest.name,
      extensionVersion: manifest.version,
      bridgeVersion: stored.installedBridgeVersion || "(not installed / not detected)",
      bridgeReady: state.bridgeReady,
      userAgent: navigator.userAgent,
      language: state.lang,
      creators: (state.creators || []).length,
      postsInView: (state.posts || []).length,
    };
    zip.file("info.json", JSON.stringify(info, null, 2));

    // Extension-Log als lesbare Textdatei (nicht als JSON-Wuest).
    const entries = await getAllLogs().catch(() => []);
    const asText = entries
      .map((e) => `[${e.ts}] [${(e.level || "info").toUpperCase()}] (${e.source || "?"}) ${e.message}`)
      .join("\n");
    zip.file("extension-log.txt", asText || "(no entries)");

    // Bridge-Logs - nur wenn die Bridge erreichbar ist.
    let bridgeFiles = 0;
    try {
      const res = await getBridgeLogs();
      (res.files || []).forEach((f) => {
        zip.file(`bridge/${f.name}`, f.content || "");
        bridgeFiles++;
      });
      if (res.directory) zip.file("bridge/_directory.txt", res.directory);
    } catch { /* keine Bridge - kein Problem */ }

    const blob = await zip.generateAsync({ type: "blob" });
    const url = URL.createObjectURL(blob);
    await chrome.downloads.download({
      url,
      filename: `PatreonArchiver-diagnostics-${stamp}.zip`,
      saveAs: true,
    });
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
    showToast(`Diagnostics exported (${entries.length} log entries, ${bridgeFiles} bridge file(s))`);
  } catch (err) {
    console.error("[PatreonArchiver] Export diagnostics failed:", err);
    showToast("Could not export diagnostics - see console for details.");
  } finally {
    if (btn) { btn.disabled = false; if (originalHtml !== null) btn.innerHTML = originalHtml; }
  }
}

const exportDiagBtn = el("exportDiagnosticsBtn");
if (exportDiagBtn) exportDiagBtn.addEventListener("click", exportDiagnostics);


el("settingsModal").addEventListener("click", (e) => {
  if (e.target.id === "settingsModal") closeSettingsModal();
});

// ---------- Format-Toggle (ZIP vs. einzelne Dateien) ----------

el("formatFilesBtn").addEventListener("click", () => {
  state.bulkFormat = "files";
  el("formatFilesBtn").classList.add("active");
  el("formatZipBtn").classList.remove("active");
});
el("formatZipBtn").addEventListener("click", () => {
  state.bulkFormat = "zip";
  el("formatZipBtn").classList.add("active");
  el("formatFilesBtn").classList.remove("active");
});

// ---------- Sonstige Event-Listener ----------

["searchInput", "typeFilter", "hideDownloadedCheck", "sortOrder", "lockFilter"].forEach((id) => {
  el(id).addEventListener("input", renderPostList);
  el(id).addEventListener("change", renderPostList);
});

el("selectAllToggle").addEventListener("click", () => {
  const posts = getFilteredPosts();
  const allKeys = posts.flatMap((p) => selectableItems(p, p.files).map((it) => it.key));
  const allSelected = allKeys.length > 0 && allKeys.every((k) => state.selected.has(k));
  posts.forEach((p) =>
    selectableItems(p, p.files).forEach((it) => {
      if (allSelected) state.selected.delete(it.key);
      else state.selected.add(it.key);
    })
  );
  renderPostList();
});

// Sammelt die tatsächlich ausgewählten Elemente (inkl. Thumbnail/Video/Embed) und
// lädt sie herunter. Alle Elemente laufen gebündelt über downloadMany für einen
// globalen Fortschrittsbalken und sauberen Abbruch.
async function runBulkDownload(onlySelected) {
  if (!(await ensureReadyToDownload())) return;
  const posts = getFilteredPosts();
  const filePairs = [];
  posts.forEach((p) =>
    selectableItems(p, p.files).forEach((it) => {
      if (onlySelected && !state.selected.has(it.key)) return;
      if (it.file) {
        filePairs.push({ post: p, file: it.file });
      } else {
        if (it.kind === "thumbnail" && p.thumbnail) {
          filePairs.push({ post: p, file: { ...p.thumbnail, kind: "thumbnail", role: "thumbnail", filename: `${p.title} - Thumbnail` } });
        } else if (it.kind === "video" && p.video) {
          filePairs.push({ post: p, file: { ...p.video, kind: "video", role: "video", filename: `${p.title} - Video` } });
        } else if (it.kind === "embed" && p.video) {
          filePairs.push({ post: p, file: { ...p.video, kind: "embed", role: "video", filename: `${p.title} - Video` } });
        } else if (it.kind === "description") {
          filePairs.push({ post: p, file: { role: "description", kind: "description", url: `${p.id}::description`, filename: `${p.title} - Description` } });
        } else if (it.kind === "comments") {
          filePairs.push({ post: p, file: { role: "comments", kind: "comments", url: `${p.id}::comments`, filename: `${p.title} - Comments` } });
        } else if (it.kind === "extras") {
          // Reiner Text-Post (keine Datei/kein Thumbnail/kein Video): fehlte
          // hier komplett - so ein Post liess sich zwar anhaken, "Download
          // Selected" hat ihn dann aber stillschweigend uebersprungen. Das
          // `role: "extras"`-Item ist exakt dasselbe, das downloadPostExtras()
          // fuer den Zeilen-Button an downloadItems() uebergibt (processItem()
          // hat dafuer schon einen eigenen Zweig, der Description, Comments,
          // Thumbnail, Video und _download_links.txt buendelt) - also KEINE
          // zweite Kopie der Download-Logik, nur derselbe Einstiegspunkt.
          filePairs.push({ post: p, file: { role: "extras", kind: "extras", url: `${p.id}::extras`, filename: `${p.title} - Description & comments` } });
        }
      }
    })
  );
  if (filePairs.length === 0) {
    showToast(onlySelected ? "No selected items to download." : "No downloadable items found for current filter.");
    return;
  }
  await downloadMany(filePairs);
  if (onlySelected) state.selected.clear();
  renderPostList();
}

el("downloadSelectedBtn").addEventListener("click", () => runBulkDownload(true));
el("downloadAllBtn").addEventListener("click", () => runBulkDownload(false));

function showConfirmDialog({ title, text, confirmText = "Confirm", cancelText = "Cancel", danger = true }) {
  return new Promise((resolve) => {
    const modal = el("confirmModal");
    el("confirmModalTitle").textContent = title || "Confirm Action";
    el("confirmModalText").textContent = text;
    
    const confirmBtn = el("confirmModalConfirm");
    const cancelBtn = el("confirmModalCancel");
    
    confirmBtn.textContent = confirmText;
    cancelBtn.textContent = cancelText;
    
    if (danger) {
      confirmBtn.style.background = "#ff5a3c";
      confirmBtn.style.borderColor = "#ff5a3c";
      confirmBtn.style.color = "#ffffff";
    } else {
      confirmBtn.style.background = "";
      confirmBtn.style.borderColor = "";
      confirmBtn.style.color = "";
    }

    const cleanup = () => {
      modal.style.display = "none";
      confirmBtn.onclick = null;
      cancelBtn.onclick = null;
      modal.onclick = null;
    };

    confirmBtn.onclick = () => {
      cleanup();
      resolve(true);
    };

    cancelBtn.onclick = () => {
      cleanup();
      resolve(false);
    };

    modal.onclick = (e) => {
      if (e.target === modal) {
        cleanup();
        resolve(false);
      }
    };

    modal.style.display = "flex";
  });
}

el("deleteCreatorBtn").addEventListener("click", async () => {
  if (!state.activeCreatorId) return;
  
  const isEn = state.lang === "en";
  const confirmed = await showConfirmDialog({
    title: isEn ? "Remove Creator Profile" : "Profil entfernen",
    text: isEn
      ? "Really remove this profile and all scanned posts from the archive? (Already downloaded files stay on disk.)"
      : "Dieses Profil und alle gescannten Beiträge wirklich aus dem Archiv entfernen? (Bereits heruntergeladene Dateien bleiben auf der Festplatte erhalten.)",
    confirmText: isEn ? "Remove profile" : "Profil entfernen",
    cancelText: isEn ? "Cancel" : "Abbrechen",
    danger: true
  });

  if (!confirmed) return;

  await send({ type: "DELETE_CREATOR", creatorId: state.activeCreatorId });
  state.activeCreatorId = null;
  // Gemerkte Auswahl mit loeschen, sonst versucht loadCreators() nach dem
  // naechsten Reload weiterhin einen Creator zu oeffnen, den es nicht mehr gibt
  // (faellt zwar sauber zurueck, waere aber unnoetiger Ballast).
  saveSettings({ lastCreatorId: null }).catch(() => {});
  el("creatorView").style.display = "none";
  el("emptyState").style.display = "block";
  loadCreators();
});

async function maybeShowOnboarding() {
  const welcomeModal = el("welcomeModal");
  if (welcomeModal && welcomeModal.style.display !== "none") return;
  if (isTourRunning()) return;

  const { onboardingSeen } = await chrome.storage.local.get("onboardingSeen");
  if (onboardingSeen) return;

  const isEn = state.lang === "en";

  // Check connection status
  const ping = await pingYtDlpHost().catch(() => ({ ok: false }));
  if (ping.ok) {
    // Bridge is installed! Check if outdated
    const { latestBridgeVersion } = await chrome.storage.local.get("latestBridgeVersion");
    const currentVer = ping.version || "1.0.0";
    if (latestBridgeVersion && isVersionOlder(currentVer, latestBridgeVersion)) {
      // Outdated bridge onboarding
      el("onboardingTitle").textContent = isEn ? "Update available" : "Update verfügbar";
      el("onboardingText").textContent = isEn 
        ? "The Patreon Archiver Bridge is already installed, but not up to date. Please update it to the latest version."
        : "Die Patreon-Archiv-Brücke ist bereits installiert, aber nicht auf dem neuesten Stand. Bitte aktualisiere sie auf die neueste Version.";
      el("onboardingLaterBtn").textContent = isEn ? "Dismiss" : "Ignorieren";
      el("onboardingSetupBtn").textContent = isEn ? "Update now" : "Jetzt aktualisieren";
      el("onboardingOverlay").style.display = "flex";

      const dismiss = async () => {
        el("onboardingOverlay").style.display = "none";
        await chrome.storage.local.set({ onboardingSeen: true });
      };
      el("onboardingClose").onclick = dismiss;
      el("onboardingLaterBtn").onclick = dismiss;
      el("onboardingSetupBtn").onclick = async () => {
        await dismiss();
        showToast(isEn ? "Starting updater..." : "Starte Updater...");
        try {
          await runBridgeUpdate();
        } catch (err) {
          showToast(isEn ? "Failed to start update: " + err.message : "Update-Start fehlgeschlagen: " + err.message);
        }
      };
    } else {
      // Bridge is installed and up to date! Mark onboarding as seen and don't show overlay
      await chrome.storage.local.set({ onboardingSeen: true });
    }
  } else {
    // Bridge is not installed
    el("onboardingTitle").textContent = L("onboardingTitle");
    el("onboardingText").textContent = L("onboardingText");
    el("onboardingLaterBtn").textContent = L("onboardingLater");
    el("onboardingSetupBtn").textContent = L("onboardingSetup");
    el("onboardingOverlay").style.display = "flex";

    const dismiss = async () => {
      el("onboardingOverlay").style.display = "none";
      await chrome.storage.local.set({ onboardingSeen: true });
    };
    el("onboardingClose").onclick = dismiss;
    el("onboardingLaterBtn").onclick = dismiss;
    el("onboardingSetupBtn").onclick = async () => {
      await dismiss();
      chrome.tabs.create({ url: chrome.runtime.getURL("setup/setup.html") });
    };
  }
}

// ---------- Start ----------

// Setzt den vermuteten Bridge-Status sofort anhand des zuletzt bekannten
// Werts aus chrome.storage.local (ein reiner Storage-Read, quasi ohne
// Latenz) - im Gegensatz zum echten Ping, der jedes Mal einen neuen
// Bridge-Host-Prozess startet und dadurch 1-2s braucht. So poppt der
// "Hide already downloaded"-Toggle nicht mehr sichtbar erst später auf;
// der echte Ping in refreshBridgeReady() korrigiert das im Hintergrund
// still, falls sich der Bridge-Status seit dem letzten Öffnen geändert hat.
async function applyOptimisticBridgeState() {
  try {
    const { installedBridgeVersion } = await chrome.storage.local.get("installedBridgeVersion");
    state.bridgeReady = !!installedBridgeVersion;
  } catch {
    state.bridgeReady = false;
  }
  const toggle = el("hideDownloadedToggle");
  if (toggle) toggle.style.display = "none"; // state.bridgeReady ? "flex" : "none";
}

async function refreshBridgeReady(forceVersionCheck = false) {
  const ping = await pingYtDlpHost(forceVersionCheck).catch(() => ({ ok: false }));
  const nowReady = !!(ping.ok && ping.ytdlpFound);
  if (nowReady) {
    await chrome.storage.local.set({ installedBridgeVersion: ping.version || "1.0.0" });
  } else {
    await chrome.storage.local.remove("installedBridgeVersion");
  }
  if (nowReady !== state.bridgeReady) {
    // Nur den WECHSEL protokollieren, nicht jeden 60s-Ping - sonst besteht das
    // Log irgendwann nur noch aus "Bridge ist noch da".
    logMilestone(nowReady
      ? `Bridge connected (version ${ping.version || "unknown"}, yt-dlp ${ping.ytdlpVersion || "found"})`
      : "Bridge disconnected or yt-dlp missing");
    state.bridgeReady = nowReady;
    if (state.activeCreatorId) renderPostList();
  } else {
    state.bridgeReady = nowReady;
  }
  const toggle = el("hideDownloadedToggle");
  if (toggle) toggle.style.display = "none"; // nowReady ? "flex" : "none";
  checkAndRenderUpdateBanners().catch(console.error);
}

function initCustomSelect(selectEl) {
  if (selectEl.nextElementSibling && selectEl.nextElementSibling.classList.contains('custom-select-ui')) {
    return;
  }

  selectEl.style.display = 'none';

  const wrapper = document.createElement('div');
  wrapper.className = 'custom-select-ui';
  wrapper.id = 'custom-select-' + selectEl.id;

  const trigger = document.createElement('div');
  trigger.className = 'custom-select-trigger';

  const label = document.createElement('span');
  label.className = 'custom-select-label';

  const chevron = document.createElement('span');
  chevron.className = 'custom-select-chevron';
  chevron.innerHTML = `<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>`;

  trigger.appendChild(label);
  trigger.appendChild(chevron);
  wrapper.appendChild(trigger);

  const optionsContainer = document.createElement('div');
  optionsContainer.className = 'custom-select-options';
  wrapper.appendChild(optionsContainer);

  selectEl.parentNode.insertBefore(wrapper, selectEl.nextSibling);

  trigger.addEventListener('click', (e) => {
    e.stopPropagation();
    document.querySelectorAll('.custom-select-ui').forEach(other => {
      if (other !== wrapper) other.classList.remove('open');
    });
    wrapper.classList.toggle('open');
  });

  document.addEventListener('click', () => {
    wrapper.classList.remove('open');
  });

  function syncUI() {
    const selectedOpt = selectEl.options[selectEl.selectedIndex];
    label.textContent = selectedOpt ? selectedOpt.textContent : '';

    optionsContainer.innerHTML = '';
    Array.from(selectEl.options).forEach((opt, idx) => {
      const item = document.createElement('div');
      item.className = 'custom-select-option';
      if (idx === selectEl.selectedIndex) item.classList.add('selected');
      item.textContent = opt.textContent;
      item.addEventListener('click', (e) => {
        e.stopPropagation();
        selectEl.selectedIndex = idx;
        selectEl.dispatchEvent(new Event('change'));
        syncUI();
        wrapper.classList.remove('open');
      });
      optionsContainer.appendChild(item);
    });
  }

  syncUI();

  selectEl.addEventListener('change', syncUI);

  const observer = new MutationObserver(syncUI);
  observer.observe(selectEl, { childList: true });
}
let creatorRefreshInterval = null;
let bridgeReadyInterval = null;

function startPeriodicTasks() {
  if (!creatorRefreshInterval) {
    creatorRefreshInterval = setInterval(async () => {
      await loadCreators();
      await refreshActivePosts();
    }, 4000);
  }
  if (!bridgeReadyInterval) {
    bridgeReadyInterval = setInterval(() => refreshBridgeReady(false), 60_000);
  }
}

function stopPeriodicTasks() {
  if (creatorRefreshInterval) {
    clearInterval(creatorRefreshInterval);
    creatorRefreshInterval = null;
  }
  if (bridgeReadyInterval) {
    clearInterval(bridgeReadyInterval);
    bridgeReadyInterval = null;
  }
}

document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    if (!downloadStartTime) {
      stopPeriodicTasks();
    }
  } else {
    startPeriodicTasks();
    loadCreators();
    refreshActivePosts();
    refreshBridgeReady(false);
  }
});

function checkUnsavedChanges() {
  if (!state.settingsSnapshot) return;
  const current = {
    datePosition: el("datePositionSelect").value,
    includePostId: el("includePostIdCheck").checked,
    customFullPath: el("customFullPathInput").value || "",
    includeThumbnails: el("includeThumbnailsCheck").checked,
    includeDescription: el("includeDescriptionCheck").checked,
    includeComments: el("includeCommentsCheck").checked,
    skipExistingFiles: el("skipExistingCheck").checked,
    fetchSizesDuringScan: el("fetchSizesDuringScanCheck").checked,
    askBeforeLargeFiles: el("askLargeFilesCheck").checked,
    largeFileThresholdMB: parseInt(el("largeThresholdInput").value, 10) || 500,
    videoQuality: el("videoQualitySelect").value,
    storageModeCustomRadio: el("storageModeCustomRadio").checked,
    subfolderPath: el("subfolderInput").value || "PatreonArchiver"
  };

  let changed = false;
  for (const k in state.settingsSnapshot) {
    if (state.settingsSnapshot[k] !== current[k]) {
      changed = true;
      break;
    }
  }

  const banner = el("settingsUnsavedBanner");
  if (banner) {
    banner.style.display = changed ? "flex" : "none";
    el("unsavedChangesText").textContent = "You have unsaved changes. Click Save below to apply.";
  }
}

function initUnsavedChangesTracker() {
  const inputs = [
    "datePositionSelect", "includePostIdCheck", "includeThumbnailsCheck",
    "includeDescriptionCheck", "includeCommentsCheck", "skipExistingCheck",
    "fetchSizesDuringScanCheck", "askLargeFilesCheck", "largeThresholdInput",
    "videoQualitySelect", "storageModeDownloads", "storageModeCustomRadio",
    "subfolderInput"
  ];
  inputs.forEach(id => {
    const element = el(id);
    if (element) {
      const eventName = (element.tagName === "INPUT" && (element.type === "text" || element.type === "number")) ? "input" : "change";
      element.addEventListener(eventName, checkUnsavedChanges);
    }
  });

  el("fetchSizesDuringScanCheck").addEventListener("change", (e) => {
    el("fetchSizesScanWarning").style.display = e.target.checked ? "block" : "none";
  });
}

async function init() {
  await applyOptimisticBridgeState();
  state.lang = await getLanguage();
  state.settings = await getSettings();
  applyStaticTranslations();
  initUnsavedChangesTracker();
  
  // Initialize custom dropdowns
  document.querySelectorAll("select").forEach(initCustomSelect);

  window.__pa_state = state;
  window.__pa_selectCreator = selectCreator;
  window.__pa_loadCreators = loadCreators;
  window.__pa_maybeShowOnboarding = maybeShowOnboarding;
  await loadCreators();
  checkAndStartOnboarding(state, renderCreatorList, refreshActivePosts, loadCreators, renderPostList);

  // Falls über einen "Dashboard öffnen"-Link mit einer bestimmten Creator-ID
  // aufgerufen (z.B. direkt nach einem Scan), dieses Profil automatisch
  // auswählen, statt dass der Nutzer es manuell nochmal anklicken muss.
  const params = new URLSearchParams(window.location.search);
  const creatorFromUrl = params.get("creator");
  if (creatorFromUrl && state.creators.some((c) => c.id === creatorFromUrl)) {
    await selectCreator(creatorFromUrl);
  }

  await maybeShowOnboarding();
  // false statt true: nutzt die gecachte yt-dlp-Version statt bei JEDEM
  // Dashboard-Öffnen zusätzlich noch "yt-dlp --version" auszuführen - das
  // hat spürbar zur Verzögerung beigetragen. Ein voller Versions-Recheck
  // passiert weiterhin regelmäßig über den 60s-Intervall-Timer.
  // Membership modal listeners
  el("membershipModalClose")?.addEventListener("click", () => {
    el("membershipModal").style.display = "none";
  });
  el("membershipModalDone")?.addEventListener("click", () => {
    el("membershipModal").style.display = "none";
  });
  el("membershipModal")?.addEventListener("click", (e) => {
    if (e.target === el("membershipModal")) el("membershipModal").style.display = "none";
  });

  startPeriodicTasks();
}

init();

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

function parseMarkdownToHtmlList(markdown) {
  if (!markdown) return "";
  const lines = markdown.split("\n");
  let html = "";
  for (let line of lines) {
    line = line.trim();
    if (line.startsWith("-") || line.startsWith("*")) {
      const content = line.substring(1).trim();
      html += `<li style="margin-bottom: 8px;">${escapeHtml(content)}</li>`;
    } else if (line.length > 0) {
      html += `<li style="margin-bottom: 8px;">${escapeHtml(line)}</li>`;
    }
  }
  return html || "<li>No details available.</li>";
}

let isRenderingBanners = false;

async function checkAndRenderUpdateBanners() {
  if (isRenderingBanners) return;
  isRenderingBanners = true;

  try {
    const isEn = state.lang === "en";

    // Single await to read all local storage keys to prevent async DOM yielding race conditions
    const data = await chrome.storage.local.get([
      "showExtensionUpdate",
      "extensionUpdateVersion",
      "extensionUpdatePrevVersion",
      "latestBridgeVersion",
      "dismissedBridgeVersion",
      "installedBridgeVersion",
      "bridgeChangelog",
      "bridgeReleaseUrl"
    ]);

    const container = document.getElementById("updateBannerContainer");
    if (!container) return;
    container.innerHTML = "";
    let showAny = false;

    // 1. Extension Update Modal Overlay
    if (data.showExtensionUpdate && data.extensionUpdateVersion) {
      const overlay = document.getElementById("whatsNewOverlay");
      if (overlay) {
        document.getElementById("whatsNewPrevVersion").textContent = `v${data.extensionUpdatePrevVersion || "1.0.0"}`;
        document.getElementById("whatsNewNewVersion").textContent = `v${data.extensionUpdateVersion}`;
        const changelogUl = document.getElementById("changelogListUl");
        if (changelogUl) {
          changelogUl.innerHTML = `<li>${isEn ? "Loading release details..." : "Lade Details..."}</li>`;
        }

        const githubLink = document.getElementById("whatsNewGithubLink");
        if (githubLink) {
          githubLink.href = `https://github.com/r1kp/patreon-archiver-extension/releases/tag/v${data.extensionUpdateVersion}`;
        }

        fetch(`https://api.github.com/repos/r1kp/patreon-archiver-extension/releases/tags/v${data.extensionUpdateVersion}`)
          .then(res => res.json())
          .then(resData => {
            const body = resData.body || (isEn ? "No release notes available." : "Keine Release-Notes vorhanden.");
            if (changelogUl) {
              changelogUl.innerHTML = parseMarkdownToHtmlList(body);
            }
          })
          .catch(() => {
            if (changelogUl) {
              changelogUl.innerHTML = `<li>${isEn ? "Successfully updated to the latest version." : "Erfolgreich auf die neueste Version aktualisiert."}</li>`;
            }
          });

        overlay.style.display = "flex";

        const dismissExt = async () => {
          overlay.style.display = "none";
          await chrome.storage.local.remove(["showExtensionUpdate", "extensionUpdateVersion", "extensionUpdatePrevVersion"]);
          checkAndRenderUpdateBanners();
        };

        document.getElementById("whatsNewClose").onclick = dismissExt;
        document.getElementById("whatsNewDismissBtn").onclick = dismissExt;
      }
    }

    // 2. Bridge Update Banner
    if (
      data.latestBridgeVersion &&
      data.installedBridgeVersion &&
      data.latestBridgeVersion !== data.dismissedBridgeVersion &&
      isVersionOlder(data.installedBridgeVersion, data.latestBridgeVersion)
    ) {
      showAny = true;
      const banner = document.createElement("div");
      banner.className = "update-banner bridge-update";
      const shortChangelog = data.bridgeChangelog ? (data.bridgeChangelog.length > 200 ? data.bridgeChangelog.substring(0, 200) + "..." : data.bridgeChangelog) : (isEn ? "A new update is available for the desktop bridge." : "Ein neues Update für die Desktop-Brücke ist verfügbar.");
      banner.innerHTML = `
        <svg class="update-banner-icon rotating-gear" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="12" cy="12" r="3"></circle>
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"></path>
        </svg>
        <div class="update-banner-content">
          <h4 class="update-banner-title">${isEn ? `Bridge update available (${data.latestBridgeVersion})` : `Update für Desktop-Brücke verfügbar (${data.latestBridgeVersion})`}</h4>
          <p class="update-banner-desc">${escapeHtml(shortChangelog)}</p>
        </div>
        <div class="update-banner-buttons">
          <button class="update-banner-btn action-btn" id="runBridgeUpdateBtn">${isEn ? "Download update" : "Update herunterladen"}</button>
          <button class="update-banner-btn" id="dismissBridgeUpdateBtn">${isEn ? "Got it" : "Verstanden"}</button>
        </div>
      `;
      container.appendChild(banner);

      banner.querySelector("#runBridgeUpdateBtn").addEventListener("click", () => {
        const url = data.bridgeReleaseUrl || "https://github.com/r1kp/patreon-archiver-bridge/releases/latest";
        chrome.tabs.create({ url });
      });

      banner.querySelector("#dismissBridgeUpdateBtn").addEventListener("click", async () => {
        await chrome.storage.local.set({ dismissedBridgeVersion: data.latestBridgeVersion });
        checkAndRenderUpdateBanners();
      });
    }

    container.style.display = showAny ? "flex" : "none";
  } finally {
    isRenderingBanners = false;
  }
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local") {
    if (changes.latestBridgeVersion || changes.dismissedBridgeVersion || changes.installedBridgeVersion || changes.showExtensionUpdate) {
      checkAndRenderUpdateBanners().catch(console.error);
    }
  }
});

window.addEventListener("beforeunload", (e) => {
  if (activeCancelSignal !== null) {
    e.preventDefault();
    e.returnValue = "A download is currently active. If you leave or reload this page, the download progress will be lost. Do you want to proceed?";
  }
});

// Quick-Jump Button & Keyboard & Scroll Listeners
el("qjPrevBtn")?.addEventListener("click", () => jumpDirection("up"));
el("qjNextBtn")?.addEventListener("click", () => jumpDirection("down"));

window.addEventListener("keydown", (e) => {
  if (e.altKey && e.key === "ArrowUp") {
    e.preventDefault();
    jumpDirection("up");
  } else if (e.altKey && e.key === "ArrowDown") {
    e.preventDefault();
    jumpDirection("down");
  }
});

// Live Scroll-Erkennung: Button-Status & Zaehler beim manuellen Scrollen anpassen
const contentContainer = document.querySelector(".content");
if (contentContainer) {
  contentContainer.addEventListener("scroll", updateQuickJumpUI, { passive: true });
}

// Floating Tooltip fuer Cloud Host Badges (entgeht modal overflow:hidden)
const cloudTip = document.createElement("div");
cloudTip.id = "cloudTooltip";
document.body.appendChild(cloudTip);

document.addEventListener("mouseover", (e) => {
  const badge = e.target.closest(".cloud-host-badge");
  if (badge && badge.dataset.tooltip) {
    cloudTip.textContent = badge.dataset.tooltip;
    cloudTip.style.opacity = "1";
  }
});

document.addEventListener("mouseout", (e) => {
  if (e.target.closest(".cloud-host-badge")) {
    cloudTip.style.opacity = "0";
  }
});

document.addEventListener("mousemove", (e) => {
  if (cloudTip.style.opacity === "1") {
    cloudTip.style.left = (e.clientX + 12) + "px";
    cloudTip.style.top = (e.clientY + 16) + "px";
  }
});
