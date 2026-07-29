/**
 * Persistentes Anwendungs-Log der Extension.
 *
 * Zweck: Wenn ein Nutzer "es hat nicht funktioniert" meldet, soll man
 * nachvollziehen koennen, was passiert ist - auch wenn die DevTools-Konsole
 * laengst geschlossen ist und die Bridge gar nicht lief.
 *
 * Aufbau:
 *  - Ringpuffer in IndexedDB (Store "logs", siehe lib/db.js). Laeuft IMMER,
 *    voellig unabhaengig von der Bridge.
 *  - Zusaetzlich werden die Eintraege - falls die Bridge erreichbar ist -
 *    gebuendelt an sie weitergereicht, wo sie in einer Tagesdatei landen
 *    (%TEMP%\PatreonArchiverLogs\extension_YYYY-MM-DD.log).
 *  - console.warn/console.error werden mitgeschnitten, bleiben aber
 *    UNVERAENDERT in der Konsole sichtbar (ausdrueckliche Nutzer-Vorgabe:
 *    zusaetzlich, nicht stattdessen).
 *
 * Bewusst NICHT eingebunden: content.js. Das ist ein klassisches Content-Script
 * ohne Modul-Unterstuetzung (siehe manifest.json) und kann diese Datei nicht
 * importieren. Seine wichtigen Ereignisse laufen ohnehin ueber Nachrichten an
 * background.js, das hier mitschreibt.
 */

import { appendLogEntries, trimLogs } from "./db.js";
import { sendLogEntriesToBridge } from "./nativeHost.js";

/** Mehr braucht man zur Fehlersuche praktisch nie, und die DB bleibt klein. */
const MAX_ENTRIES = 2000;
/** Sammelfenster, bevor geschrieben/gesendet wird. */
const FLUSH_DELAY_MS = 1500;

let queue = [];
let flushTimer = null;
let installed = false;
let contextName = "extension";

function nowIso() {
  return new Date().toISOString();
}

// Argumente einer console-Ausgabe in eine Zeile verwandeln. Fehlerobjekte
// bekommen ihren Stack mit, sonst steht spaeter nur "[object Object]" im Log.
function stringifyArgs(args) {
  return args
    .map((a) => {
      if (a instanceof Error) return `${a.name}: ${a.message}\n${a.stack || ""}`;
      if (typeof a === "string") return a;
      try {
        return JSON.stringify(a);
      } catch {
        return String(a);
      }
    })
    .join(" ")
    .slice(0, 4000); // Sicherheitsnetz gegen versehentlich riesige Objekte
}

function scheduleFlush() {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    flush().catch(() => {});
  }, FLUSH_DELAY_MS);
}

/**
 * Schreibt die gesammelten Eintraege weg. Fehler werden hier bewusst
 * verschluckt: ein kaputtes Log darf niemals den eigentlichen Ablauf stoeren
 * (und ein console.error an dieser Stelle wuerde sich selbst wieder ins Log
 * schreiben - Endlosschleife).
 */
export async function flush() {
  if (queue.length === 0) return;
  const batch = queue;
  queue = [];
  try {
    await appendLogEntries(batch);
    await trimLogs(MAX_ENTRIES);
  } catch {
    /* IndexedDB nicht verfuegbar - dann eben nur die Bridge-Kopie */
  }
  // Fuer die Bridge wird SEPARAT und deutlich seltener gebuendelt: jede
  // Verbindung startet drueben einen eigenen Host-Prozess. Alle 1.5s einen
  // Prozess zu starten waere absurd, alle 15s ist voellig ausreichend.
  bridgeQueue.push(...batch.map((e) => ({ level: e.level, message: e.message, source: e.source })));
  scheduleBridgeFlush();
}

let bridgeQueue = [];
let bridgeTimer = null;
const BRIDGE_FLUSH_DELAY_MS = 15000;

function scheduleBridgeFlush() {
  if (bridgeTimer || bridgeQueue.length === 0) return;
  bridgeTimer = setTimeout(() => {
    bridgeTimer = null;
    const batch = bridgeQueue.slice(0, 200); // eine Nachricht pro Eintrag, Deckel gegen Ausreisser
    bridgeQueue = bridgeQueue.slice(batch.length);
    sendLogEntriesToBridge(batch).catch(() => {});
    if (bridgeQueue.length > 0) scheduleBridgeFlush();
  }, BRIDGE_FLUSH_DELAY_MS);
}

/** Einen Eintrag aufnehmen. Nie awaiten noetig - das Wegschreiben passiert gebuendelt. */
export function logEvent(level, message, source = contextName) {
  queue.push({ ts: nowIso(), level, message: String(message).slice(0, 4000), source });
  // Sofort schreiben, wenn sich viel angesammelt hat (z.B. Fehlerlawine), sonst
  // gesammelt nach kurzer Zeit.
  if (queue.length >= 50) {
    flush().catch(() => {});
  } else {
    scheduleFlush();
  }
}

/** Meilenstein: Scan/Download/Bridge-Zustand - das Grundgeruest jeder Fehlersuche. */
export function logMilestone(message, source = contextName) {
  logEvent("info", message, source);
}

export function logWarn(message, source = contextName) {
  logEvent("warn", message, source);
}

export function logError(message, source = contextName) {
  logEvent("error", message, source);
}

/**
 * Haengt sich an console.warn/console.error, OHNE deren Verhalten zu aendern:
 * die Ausgabe erscheint weiterhin ganz normal in den DevTools, wird zusaetzlich
 * aber mitgeschrieben. console.log wird bewusst NICHT mitgeschnitten - die
 * verbliebenen Aufrufe sind reine Entwicklerausgaben und wuerden das Log nur
 * verwaessern.
 */
export function installConsoleCapture(name) {
  if (name) contextName = name;
  if (installed) return;
  installed = true;

  const origWarn = console.warn.bind(console);
  const origError = console.error.bind(console);

  console.warn = (...args) => {
    origWarn(...args);
    try { logEvent("warn", stringifyArgs(args)); } catch { /* niemals stoeren */ }
  };
  console.error = (...args) => {
    origError(...args);
    try { logEvent("error", stringifyArgs(args)); } catch { /* niemals stoeren */ }
  };

  // Auch das, was gar nicht erst abgefangen wurde.
  if (typeof self !== "undefined" && typeof self.addEventListener === "function") {
    self.addEventListener("error", (e) => {
      try { logEvent("error", `Uncaught: ${e?.message || "unknown"} (${e?.filename || "?"}:${e?.lineno || 0})`); } catch {}
    });
    self.addEventListener("unhandledrejection", (e) => {
      try { logEvent("error", `Unhandled promise rejection: ${stringifyArgs([e?.reason])}`); } catch {}
    });
  }
}
