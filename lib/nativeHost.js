// Kommunikation mit der nativen Bridge (PatreonArchiverBridge.exe), die lokal
// Ordner-Dialoge, Datei-Downloads und yt-dlp für extern eingebettete Videos
// (YouTube/Vimeo/...) bereitstellt. Ist die Bridge nicht installiert, schlägt
// connectNative sofort fehl - das wird abgefangen und dem Nutzer klar erklärt
// (kein Absturz).

const HOST_NAME = "com.patreonarchiver.ytdlp";

/**
 * Startet einen yt-dlp-Download über den nativen Host.
 * onProgress(line) wird für jede Zeile roher yt-dlp-Ausgabe aufgerufen
 * (enthält u.a. Prozent/Geschwindigkeit, wie yt-dlp sie selbst ausgibt).
 * Gibt ein Promise zurück, das bei Erfolg/Fehler auflöst.
 */
export function downloadViaYtDlp({ url, outputDir, filenameTemplate, format, cancelSignal, forceOverwrite }, onProgress) {
  return new Promise((resolve, reject) => {
    let port;
    try {
      port = chrome.runtime.connectNative(HOST_NAME);
    } catch (err) {
      reject(
        new Error(
          "Bridge nicht gefunden. Bitte den Einrichtungs-Assistenten öffnen und die Bridge installieren."
        )
      );
      return;
    }

    let settled = false;
    let cancelInterval = null;

    // Reset deno suggestion flag on start of download
    chrome.storage.local.set({ denoSuggestionNeeded: false });

    const cleanup = () => {
      if (cancelInterval) clearInterval(cancelInterval);
    };

    if (cancelSignal) {
      cancelInterval = setInterval(() => {
        if (cancelSignal.cancelled && !settled) {
          settled = true;
          cleanup();
          reject(new Error("cancelled"));
          try { port.disconnect(); } catch { /* noop */ }
        }
      }, 250);
    }

    port.onMessage.addListener((msg) => {
      if (msg.type === "progress") {
        // Prüfen auf JS-runtime Fehlermeldungen von yt-dlp
        if (msg.line.includes("No supported JavaScript runtime could be found") ||
            msg.line.includes("n challenge solving failed") ||
            msg.line.includes("Some formats have been skipped as they are missing a url")) {
          chrome.storage.local.set({ denoSuggestionNeeded: true });
        }
        onProgress?.(msg.line);
      } else if (msg.type === "keepalive") {
        // Bridge sendet alle 5s ein keepalive um die Chrome-Verbindung aktiv zu halten.
      } else if (msg.type === "done") {
        settled = true;
        cleanup();
        resolve();
        port.disconnect();
      } else if (msg.type === "error") {
        settled = true;
        cleanup();
        reject(new Error(msg.message || "yt-dlp-Fehler"));
        port.disconnect();
      }
    });
    port.onDisconnect.addListener(() => {
      void chrome.runtime.lastError;
      if (!settled) {
        settled = true;
        cleanup();
        const err = chrome.runtime.lastError?.message || "";
        reject(
          new Error(
            err
              ? `Verbindung zum nativen Host verloren: ${err}`
              : "Nativer Host nicht erreichbar. Ist er installiert und yt-dlp im PATH?"
          )
        );
      }
    });

    port.postMessage({ action: "download", url, outputDir, filenameTemplate, options: { format, forceOverwrite } });
  });
}

/**
 * Schreibt einen Blob über den nativen Host in eine echte, vollständige
 * Zielpfad-Datei (z.B. "F:\ASSETS_02\PATREON\Creator\Post\datei.jpg").
 * Wird für "Custom folder" im Modus "Vollständigen Pfad eingeben" verwendet,
 * als Alternative zum Ordner-Auswahldialog (der nie den vollen Pfad offenlegt).
 */
export async function writeFileViaBridge(fullPath, blob, onProgress) {
  const CHUNK_SIZE = 1_000_000; // ~1MB roh, vor Base64
  const buffer = await blob.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  const total = bytes.length;

  let port;
  try {
    port = chrome.runtime.connectNative(HOST_NAME);
  } catch {
    throw new Error(
      "Nativer Host nicht gefunden. Für 'Vollständigen Pfad eingeben' muss die Brücke installiert sein (siehe Einrichtungs-Hinweis)."
    );
  }

  await new Promise((resolve, reject) => {
    let offset = 0;
    let settled = false;

    function sendNextChunk() {
      const slice = bytes.subarray(offset, offset + CHUNK_SIZE);
      const isLast = offset + slice.length >= total;
      let binary = "";
      for (let i = 0; i < slice.length; i++) binary += String.fromCharCode(slice[i]);
      const dataBase64 = btoa(binary);
      port.postMessage({
        action: "write_chunk",
        path: fullPath,
        dataBase64,
        append: offset > 0,
        isLast,
      });
      offset += slice.length;
      onProgress?.({ received: offset, total });
    }

    port.onMessage.addListener((msg) => {
      if (msg.type === "chunk_ack") {
        if (msg.done) {
          settled = true;
          resolve();
          port.disconnect();
        } else {
          sendNextChunk();
        }
      } else if (msg.type === "write_error") {
        settled = true;
        reject(new Error(msg.message || "Schreibfehler im nativen Host"));
        port.disconnect();
      }
    });
    port.onDisconnect.addListener(() => {
      void chrome.runtime.lastError;
      if (!settled) reject(new Error(chrome.runtime.lastError?.message || "Verbindung zum nativen Host verloren"));
    });

    sendNextChunk();
  });
}

/**
 * Ermittelt NUR die Gesamtgröße eines Cloud-Links (Datei oder Ordner), ohne
 * etwas herunterzuladen. Wird genutzt, um mehrere Cloud-Links parallel im
 * Hintergrund "vorzuscannen", damit die Größe (für Primary-Bar-Gewichtung +
 * ETA) schon feststeht, bevor der eigentliche Download an der Reihe ist.
 * Gibt bei Fehler/Timeout { totalBytes: 0, fileCount: 0 } zurück statt zu
 * werfen - ein gescheiterter Vorab-Scan darf den eigentlichen Download nicht
 * verhindern, der bekommt seine eigene, unabhängige Größenermittlung.
 */
export function getUrlSize(url, timeoutMs = 45000) {
  const requestId = `pa-size-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return new Promise((resolve) => {
    let port;
    try {
      port = chrome.runtime.connectNative(HOST_NAME);
    } catch {
      resolve({ totalBytes: 0, fileCount: 0 });
      return;
    }
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      try { port.disconnect(); } catch { /* noop */ }
      resolve(result);
    };
    port.onMessage.addListener((msg) => {
      if (msg.requestId !== requestId) return;
      if (msg.type === "url_size_result") {
        finish({ totalBytes: msg.totalBytes || 0, fileCount: msg.fileCount || 0 });
      }
    });
    port.onDisconnect.addListener(() => {
      void chrome.runtime.lastError;
      finish({ totalBytes: 0, fileCount: 0 });
    });
    port.postMessage({ action: "get_url_size", url, requestId });
    setTimeout(() => finish({ totalBytes: 0, fileCount: 0 }), timeoutMs);
  });
}

/**
 * Lässt den nativen Host eine Datei-URL DIREKT herunterladen (kein Umweg
 * mehr über einen versteckten Browser-Tab). Zuverlässiger, da Patreons
 * Download-Links i.d.R. bereits signiert/eigenständig gültig sind.
 */
export function downloadUrlViaBridge(url, path, onProgress, cancelSignal) {
  const requestId = `pa-url-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return new Promise((resolve, reject) => {
    let port;
    try {
      port = chrome.runtime.connectNative(HOST_NAME);
    } catch {
      reject(new Error("Native host not found."));
      return;
    }
    let settled = false;
    let cancelInterval = null;
    let stallTimer = null;

    const cleanup = () => {
      if (cancelInterval) clearInterval(cancelInterval);
      if (stallTimer) clearTimeout(stallTimer);
    };

    if (cancelSignal) {
      cancelInterval = setInterval(() => {
        if (cancelSignal.cancelled && !settled) {
          settled = true;
          cleanup();
          reject(new Error("cancelled"));
          try { port.disconnect(); } catch { /* noop */ }
        }
      }, 250);
    }

    // Stall-Timeout: Wenn innerhalb von 3 Min weder Fortschritt noch Abschluss
    // kommt, brechen wir DIESE Datei ab, statt den ganzen Batch zu blockieren.
    const STALL_MS = 180000;
    const resetStall = () => {
      if (stallTimer) clearTimeout(stallTimer);
      stallTimer = setTimeout(() => {
        if (!settled) {
          settled = true;
          cleanup();
          reject(new Error("Download stalled (no progress for 3 min) - skipped."));
          try { port.disconnect(); } catch { /* noop */ }
        }
      }, STALL_MS);
    };
    resetStall();

    port.onMessage.addListener((msg) => {
      if (msg.requestId !== requestId) return;
      if (msg.type === "url_progress") {
        resetStall();
        onProgress?.({
          received: msg.received,
          total: msg.total,
          filesCompleted: msg.filesCompleted,
          totalFiles: msg.totalFiles,
          // Groesse/Stand NUR der gerade laufenden Einzeldatei innerhalb eines
          // Ordners - Rueckfallebene fuer den Zeilenbalken, wenn die Bridge die
          // Ordner-Gesamtgroesse nicht ermitteln konnte (total === 0). Ohne das
          // steht die Zeile bei 0% und springt am Ende auf 100%.
          fileReceived: msg.fileReceived,
          fileTotal: msg.fileTotal,
          filename: msg.filename,
          phase: msg.phase,
        });
      } else if (msg.type === "url_done") {
        settled = true;
        cleanup();
        resolve(msg.path);
        port.disconnect();
      } else if (msg.type === "url_error") {
        settled = true;
        cleanup();
        reject(new Error(msg.message || "Download via bridge failed"));
        port.disconnect();
      }
    });
    port.onDisconnect.addListener(() => {
      void chrome.runtime.lastError;
      if (!settled) {
        settled = true;
        cleanup();
        reject(new Error(chrome.runtime.lastError?.message || "Connection to native host lost"));
      }
    });
    port.postMessage({ action: "download_url", url, path, requestId });
  });
}

/**
 * Öffnet den ECHTEN Betriebssystem-Ordnerauswahl-Dialog über die Brücke und
 * liefert den vollständigen Pfad zurück (im Gegensatz zum Browser-eigenen
 * Dialog, der aus Sicherheitsgründen nie den vollen Pfad preisgibt).
 * Gibt null zurück, wenn der Nutzer abgebrochen hat.
 */
export function pickFolderViaBridge() {
  return new Promise((resolve, reject) => {
    let port;
    try {
      port = chrome.runtime.connectNative(HOST_NAME);
    } catch {
      reject(new Error("Nativer Host nicht gefunden."));
      return;
    }
    let settled = false;
    port.onMessage.addListener((msg) => {
      if (msg.type === "folder_picked") {
        settled = true;
        resolve(msg.path);
        port.disconnect();
      } else if (msg.type === "folder_pick_cancelled") {
        settled = true;
        resolve(null);
        port.disconnect();
      } else if (msg.type === "folder_pick_error") {
        settled = true;
        reject(new Error(msg.message));
        port.disconnect();
      } else if (msg.type === "error") {
        // The bridge answers unrecognized actions with a generic
        // {type:"error"} message. Before, this arrived instantly but was
        // never matched by any branch above, so the promise just hung
        // forever with zero feedback - exactly the "clicking does nothing"
        // symptom. This most commonly means an older/rebuilt bridge that
        // doesn't support "pick_folder" yet is installed.
        settled = true;
        reject(new Error(msg.message || "Bridge does not support pick_folder (older bridge build?)."));
        port.disconnect();
      }
    });
    port.onDisconnect.addListener(() => {
      void chrome.runtime.lastError;
      if (!settled) reject(new Error(chrome.runtime.lastError?.message || "Verbindung zum nativen Host verloren"));
    });
    port.postMessage({ action: "pick_folder" });

    // Safety net: even the instant {type:"error"} path above should always
    // catch a mismatched bridge, but just in case a build hangs instead of
    // answering at all, don't let the UI wait forever.
    setTimeout(() => {
      if (!settled) {
        settled = true;
        reject(new Error("Bridge did not respond to pick_folder in time."));
        try { port.disconnect(); } catch { /* noop */ }
      }
    }, 15000);
  });
}

/**
 * Fragt die Brücke nach einem sinnvollen Standard-Zielordner (ein
 * "Patreon Archiver"-Unterordner im echten Windows-Downloads-Ordner des
 * Nutzers, wird bei Bedarf automatisch angelegt). Damit muss niemand vor
 * dem ersten Download manuell einen Ordner wählen. Gibt null zurück, wenn
 * die Brücke nicht erreichbar ist oder eine ältere Version ohne diese
 * Aktion läuft.
 */
export function getDefaultDownloadDir() {
  return new Promise((resolve) => {
    let port;
    try {
      port = chrome.runtime.connectNative(HOST_NAME);
    } catch {
      resolve(null);
      return;
    }
    let answered = false;
    port.onMessage.addListener((msg) => {
      if (msg.type === "default_dir") {
        answered = true;
        resolve(msg.path || null);
        port.disconnect();
      } else if (msg.type === "error") {
        answered = true;
        resolve(null);
        port.disconnect();
      }
    });
    port.onDisconnect.addListener(() => {
      void chrome.runtime.lastError;
      if (!answered) resolve(null);
    });
    port.postMessage({ action: "get_default_dir" });
    setTimeout(() => {
      if (!answered) {
        resolve(null);
        try {
          port.disconnect();
        } catch {
          /* noop */
        }
      }
    }, 2500);
  });
}

export function pingYtDlpHost(forceVersionCheck = false) {
  return new Promise((resolve) => {
    let port;
    try {
      port = chrome.runtime.connectNative(HOST_NAME);
    } catch {
      resolve({ ok: false });
      return;
    }
    let answered = false;
    port.onMessage.addListener((msg) => {
      if (msg.type === "pong") {
        answered = true;
        resolve({ ok: true, ytdlpFound: msg.ytdlpFound, version: msg.version || "1.0.0", denoFound: !!msg.denoFound });
        port.disconnect();
      }
    });
    port.onDisconnect.addListener(() => {
      // lastError explizit abrufen -> markiert die (erwartete) "host not found"-
      // Meldung als behandelt, damit Chrome sie nicht als Warnung protokolliert.
      void chrome.runtime.lastError;
      if (!answered) resolve({ ok: false });
    });
    port.postMessage({ action: "ping", forceVersionCheck });
    setTimeout(() => {
      if (!answered) {
        resolve({ ok: false });
        try {
          port.disconnect();
        } catch {
          /* noop */
        }
      }
    }, 6000);
  });
}

/**
 * Lässt den nativen Host yt-dlp selbst von der offiziellen GitHub-Release-Seite
 * herunterladen (nur wenn der Nutzer das ausdrücklich anstößt). Funktioniert
 * nur, wenn der native Host selbst schon installiert ist (siehe README) -
 * das einmalige Einrichten der Brücke kann aus Sicherheitsgründen nicht von
 * der Extension selbst übernommen werden.
 */
export function installYtDlpViaHost(onProgress) {
  return new Promise((resolve, reject) => {
    let port;
    try {
      port = chrome.runtime.connectNative(HOST_NAME);
    } catch {
      reject(
        new Error(
          "Nativer Host nicht gefunden. Bitte zuerst die Brücke einmalig installieren (siehe Einrichtungs-Hinweis)."
        )
      );
      return;
    }
    let settled = false;
    port.onMessage.addListener((msg) => {
      if (msg.type === "install_progress") onProgress?.(msg.message);
      else if (msg.type === "install_done") {
        settled = true;
        resolve(msg.path);
        port.disconnect();
      } else if (msg.type === "install_error") {
        settled = true;
        reject(new Error(msg.message || "yt-dlp-Installation fehlgeschlagen"));
        port.disconnect();
      }
    });
    port.onDisconnect.addListener(() => {
      void chrome.runtime.lastError;
      if (!settled) {
        reject(new Error(chrome.runtime.lastError?.message || "Verbindung zum nativen Host verloren"));
      }
    });
    port.postMessage({ action: "install_ytdlp" });
  });
}

/**
 * Startet die Installation von Deno über den nativen Host.
 */
export function installDenoViaHost(onProgress) {
  return new Promise((resolve, reject) => {
    let port;
    try {
      port = chrome.runtime.connectNative(HOST_NAME);
    } catch {
      reject(
        new Error(
          "Nativer Host nicht gefunden. Bitte zuerst die Brücke einmalig installieren (siehe Einrichtungs-Hinweis)."
        )
      );
      return;
    }
    let settled = false;
    port.onMessage.addListener((msg) => {
      if (msg.type === "install_progress") onProgress?.(msg.message);
      else if (msg.type === "install_done") {
        settled = true;
        resolve(msg.path);
        port.disconnect();
      } else if (msg.type === "install_error") {
        settled = true;
        reject(new Error(msg.message || "Deno-Installation fehlgeschlagen"));
        port.disconnect();
      }
    });
    port.onDisconnect.addListener(() => {
      void chrome.runtime.lastError;
      if (!settled) {
        reject(new Error(chrome.runtime.lastError?.message || "Verbindung zum nativen Host verloren"));
      }
    });
    port.postMessage({ action: "install_deno" });
  });
}

export function runBridgeUpdate() {
  return new Promise((resolve, reject) => {
    let port;
    try {
      port = chrome.runtime.connectNative(HOST_NAME);
    } catch (err) {
      reject(new Error("Bridge nicht gefunden."));
      return;
    }
    let settled = false;
    port.onMessage.addListener((msg) => {
      if (msg.type === "update_launched") {
        settled = true;
        resolve({ ok: true });
        port.disconnect();
      } else if (msg.type === "error") {
        settled = true;
        reject(new Error(msg.message || "Fehler beim Starten des Updates"));
        port.disconnect();
      }
    });
    port.onDisconnect.addListener(() => {
      void chrome.runtime.lastError;
      if (!settled) {
        reject(new Error("Verbindung verloren."));
      }
    });
    port.postMessage({ action: "run_update" });
  });
}

export function checkFileExistsViaBridge(path) {
  return new Promise((resolve) => {
    let port;
    try {
      port = chrome.runtime.connectNative(HOST_NAME);
    } catch {
      resolve(false);
      return;
    }
    let answered = false;
    port.onMessage.addListener((msg) => {
      if (msg.type === "file_exists_result") {
        answered = true;
        resolve(!!msg.exists);
        port.disconnect();
      } else if (msg.type === "error") {
        answered = true;
        resolve(false);
        port.disconnect();
      }
    });
    port.onDisconnect.addListener(() => {
      void chrome.runtime.lastError;
      if (!answered) resolve(false);
    });
    port.postMessage({ action: "check_file_exists", path });
    setTimeout(() => {
      if (!answered) {
        resolve(false);
        try { port.disconnect(); } catch { /* noop */ }
      }
    }, 2000);
  });
}

// Fuer OneDrive: der eigentliche Download laeuft schon durch den echten
// Chrome-Browser (siehe background.js), diese Funktion sagt der Bridge nur
// noch, die bereits fertige lokale Datei von einem Temp-Pfad an ihren
// endgueltigen Platz in der Patreon-Archiver-Ordnerstruktur zu verschieben -
// kein erneuter Netzwerk-Download.
export function moveLocalFileViaBridge(sourcePath, targetPath) {
  return new Promise((resolve) => {
    let port;
    try {
      port = chrome.runtime.connectNative(HOST_NAME);
    } catch (err) {
      resolve({ ok: false, error: err.message });
      return;
    }
    let answered = false;
    port.onMessage.addListener((msg) => {
      if (msg.type === "move_local_file_result") {
        answered = true;
        resolve(msg.ok ? { ok: true, path: msg.path } : { ok: false, error: msg.error });
        port.disconnect();
      } else if (msg.type === "error") {
        answered = true;
        resolve({ ok: false, error: msg.message });
        port.disconnect();
      }
    });
    port.onDisconnect.addListener(() => {
      void chrome.runtime.lastError;
      if (!answered) resolve({ ok: false, error: "Bridge connection closed unexpectedly" });
    });
    port.postMessage({ action: "move_local_file", sourcePath, targetPath });
    setTimeout(() => {
      if (!answered) {
        resolve({ ok: false, error: "move_local_file timed out" });
        try { port.disconnect(); } catch { /* noop */ }
      }
    }, 30000);
  });
}

export function buildYtdlpFormat(quality) {
  const q = quality || "best";
  if (q === "720") {
    return "bestvideo[height<=720][ext=mp4]+bestaudio[ext=m4a]/best[height<=720][ext=mp4]/best";
  }
  if (q === "480") {
    return "bestvideo[height<=480][ext=mp4]+bestaudio[ext=m4a]/best[height<=480][ext=mp4]/best";
  }
  if (q === "audio") {
    return "bestaudio[ext=m4a]/bestaudio";
  }
  // "best" (1080p+ bevorzugt)
  return "bestvideo[height>=1080][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height>=720][ext=mp4]+bestaudio[ext=m4a]/best[height<=1080][ext=mp4]/best[ext=mp4]/best";
}

// Loescht ein Verzeichnis (und alle Unterverzeichnisse/Dateien darin) ueber
// die native Bridge. Wird nach OneDrive-Downloads benutzt, um den
// PatreonArchiverTemp-Ordner zu bereinigen. Gibt { ok, error? } zurueck.
/**
 * Raeumt die Fragmente eines ABGEBROCHENEN Downloads weg: yt-dlps ".part"/
 * ".ytdl"-Dateien, die Zwischendateien getrennter Video-/Audio-Streams
 * ("Titel.f137.mp4") und eine evtl. angelegte 0-Byte-Zieldatei. Eine FERTIGE
 * Datei bleibt unangetastet (falls der Cancel-Klick erst nach dem Abschluss
 * ankam). Muss ueber eine NEUE Verbindung laufen - die des abgebrochenen
 * Downloads ist zu diesem Zeitpunkt bereits getrennt.
 */
export function cleanupPartialViaBridge(dir, baseName) {
  const requestId = `pa-clean-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return new Promise((resolve) => {
    let port;
    try {
      port = chrome.runtime.connectNative(HOST_NAME);
    } catch (err) {
      resolve({ ok: false, error: err.message });
      return;
    }
    let answered = false;
    port.onMessage.addListener((msg) => {
      if (msg.type === "cleanup_partial_result") {
        answered = true;
        resolve({ ok: !!msg.ok, removed: msg.removed || 0, error: msg.error });
        port.disconnect();
      } else if (msg.type === "error") {
        answered = true;
        resolve({ ok: false, error: msg.message });
        port.disconnect();
      }
    });
    port.onDisconnect.addListener(() => {
      void chrome.runtime.lastError;
      if (!answered) resolve({ ok: false, error: "Bridge connection closed unexpectedly" });
    });
    port.postMessage({ action: "cleanup_partial", dir, baseName, requestId });
    setTimeout(() => {
      if (!answered) {
        answered = true;
        resolve({ ok: false, error: "cleanup_partial timed out" });
        try { port.disconnect(); } catch { /* noop */ }
      }
    }, 15000);
  });
}

/**
 * Reicht gesammelte Log-Zeilen an die Bridge weiter (dort landen sie in
 * %TEMP%\PatreonArchiverLogs\extension_YYYY-MM-DD.log).
 *
 * BEWUSST "fire and forget": keine Antwort, kein Timeout, kein Fehler nach
 * aussen. Alle Zeilen gehen ueber EINE Verbindung raus - pro Zeile eine eigene
 * Verbindung waere pro Log-Eintrag ein eigener Bridge-Prozess.
 * Ist keine Bridge installiert, schlaegt connectNative() fehl und wir tun
 * einfach nichts - der IndexedDB-Ringpuffer der Extension bleibt davon
 * unberuehrt und ist die eigentliche Quelle.
 */
export function sendLogEntriesToBridge(entries) {
  return new Promise((resolve) => {
    if (!entries || entries.length === 0) { resolve(false); return; }
    let port;
    try {
      port = chrome.runtime.connectNative(HOST_NAME);
    } catch {
      resolve(false);
      return;
    }
    try {
      port.onDisconnect.addListener(() => { void chrome.runtime.lastError; });
      for (const e of entries) {
        port.postMessage({ action: "log_entry", level: e.level, message: e.message, source: e.source });
      }
      // Kurz offen lassen, damit die Nachrichten sicher rausgehen, dann zu.
      setTimeout(() => { try { port.disconnect(); } catch { /* noop */ } resolve(true); }, 250);
    } catch {
      try { port.disconnect(); } catch { /* noop */ }
      resolve(false);
    }
  });
}

/** Holt die Log-Dateien der Bridge fuer den Diagnose-Export. */
export function getBridgeLogs() {
  const requestId = `pa-logs-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return new Promise((resolve) => {
    let port;
    try {
      port = chrome.runtime.connectNative(HOST_NAME);
    } catch {
      resolve({ ok: false, files: [] });
      return;
    }
    let answered = false;
    port.onMessage.addListener((msg) => {
      if (msg.type === "logs_result") {
        answered = true;
        resolve({ ok: !!msg.ok, directory: msg.directory, files: msg.files || [] });
        try { port.disconnect(); } catch { /* noop */ }
      }
    });
    port.onDisconnect.addListener(() => {
      void chrome.runtime.lastError;
      if (!answered) resolve({ ok: false, files: [] });
    });
    port.postMessage({ action: "get_logs", requestId });
    setTimeout(() => {
      if (!answered) {
        answered = true;
        resolve({ ok: false, files: [] });
        try { port.disconnect(); } catch { /* noop */ }
      }
    }, 10000);
  });
}

export function deleteDirectoryViaBridge(path) {
  return new Promise((resolve) => {
    let port;
    try {
      port = chrome.runtime.connectNative(HOST_NAME);
    } catch (err) {
      resolve({ ok: false, error: err.message });
      return;
    }
    let answered = false;
    port.onMessage.addListener((msg) => {
      if (msg.type === "delete_dir_result") {
        answered = true;
        resolve(msg.ok ? { ok: true } : { ok: false, error: msg.error });
        port.disconnect();
      } else if (msg.type === "error") {
        answered = true;
        resolve({ ok: false, error: msg.message });
        port.disconnect();
      }
    });
    port.onDisconnect.addListener(() => {
      void chrome.runtime.lastError;
      if (!answered) resolve({ ok: false, error: "Bridge connection closed unexpectedly" });
    });
    port.postMessage({ action: "delete_directory", path });
    setTimeout(() => {
      if (!answered) {
        resolve({ ok: false, error: "delete_directory timed out" });
        try { port.disconnect(); } catch { /* noop */ }
      }
    }, 10000);
  });
}
