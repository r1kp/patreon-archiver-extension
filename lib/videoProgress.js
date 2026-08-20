// Gemeinsame yt-dlp-Fortschritts-Skalierung, genutzt von downloader.js (Bulk)
// UND dashboard.js (Einzel-Video-Button). NIE an zwei Stellen duplizieren -
// das war schon zweimal die Ursache für inkonsistente Progressbars.
// Wandelt yt-dlps Groessenangaben ("123.45MiB", "1.2GiB", "512KB", "800B")
// in Bytes um. yt-dlp nutzt standardmaessig binaere Einheiten (KiB/MiB/GiB =
// 1024er-Basis), unterstuetzt hier aber auch dezimale Varianten (KB/MB/GB).
function parseSizeToBytes(numStr, unitStr) {
  const n = parseFloat(numStr);
  if (isNaN(n)) return null;
  const m = /^([KMGT]?)(i)?B$/i.exec(unitStr || "B");
  if (!m) return Math.round(n);
  const prefix = m[1].toUpperCase();
  const binary = !!m[2];
  const base = binary ? 1024 : 1000;
  const exponent = { "": 0, K: 1, M: 2, G: 3, T: 4 }[prefix] ?? 0;
  return Math.round(n * Math.pow(base, exponent));
}

export function createVideoProgressTracker(isAudioOnly) {
  let downloadPhase = isAudioOnly ? "audio" : "video";
  let maxPct = 0;
  let mergerStartedAt = null;
  // Groesse PRO STREAM, nicht global. yt-dlps Fortschrittszeile nennt immer nur
  // den GERADE ladenden Stream - bei getrennten Spuren also erst das Video
  // (z.B. 3.9 GB), danach das Audio (z.B. 172 MB). Frueher stand hier eine
  // einzige `lastTotalBytes`-Variable, die vom jeweils letzten Wert
  // ueberschrieben wurde: die zuletzt gemeldete Zahl war damit die AUDIO-Groesse,
  // und genau die landete als vermeintliche Gesamtgroesse in der fertigen
  // Zeile ("172.8 MB" statt 4.09 GB) UND in der Gewichtskorrektur
  // (setItemWeight in downloader.js), wodurch totalWeight am Ende eines Videos
  // massiv nach unten sprang.
  // Innerhalb einer Phase wird das Maximum genommen: yt-dlp meldet bei
  // geschaetzten Groessen ("of ~123MiB", DASH/HLS-Fragmente) leicht schwankende
  // Werte. Das macht die Summe zusaetzlich robust, falls die Phasenerkennung
  // unten einen Audio-Stream mal nicht erkennt - dann gewinnt schlicht der
  // groessere Wert, statt dass der kleinere den groesseren ueberschreibt.
  const phaseBytes = { video: 0, audio: 0 };

  function feed(line) {
    if (line && line.includes("[download] Destination:") && (line.includes(".m4a") || line.includes(".f251") || line.includes(".audio") || line.includes(".f140") || line.includes(".aac") || line.includes(".mp3") || line.includes(".fdash-audio-"))) {
      downloadPhase = "audio";
    } else if (line && (line.includes("[Merger] Merging formats") || line.includes("Merging formats"))) {
      if (downloadPhase !== "merger") mergerStartedAt = Date.now();
      downloadPhase = "merger";
    }

    const pctMatch = line ? /(\d{1,3}(?:\.\d+)?)%/.exec(line) : null;
    const currentPct = pctMatch ? parseFloat(pctMatch[1]) : -1;

    if (currentPct >= 0 && downloadPhase !== "merger") {
      if (isAudioOnly) {
        if (currentPct > maxPct) maxPct = currentPct;
      } else if (downloadPhase === "video") {
        // Video-Spur macht ca. 95% des Gesamtdownloads aus
        const calc = currentPct * 0.95;
        if (calc > maxPct) maxPct = calc;
      } else if (downloadPhase === "audio") {
        // Audio-Spur macht die restlichen ~5% aus
        const calc = 95 + currentPct * 0.04;
        if (calc > maxPct) maxPct = calc;
      }
    }

    if (downloadPhase === "merger") {
      const elapsed = mergerStartedAt ? Date.now() - mergerStartedAt : 0;
      const trickle = 98 + Math.min(1.5, elapsed / 1000);
      if (trickle > maxPct) maxPct = trickle;
    }

    const isScanning = (downloadPhase === "video" && maxPct === 0 && currentPct < 0);
    const speedMatch = line ? /at\s+([\d.]+\s*[KMGT]?i?B\/s)/.exec(line) : null;

    // yt-dlps Standard-Fortschrittszeile enthaelt die Groesse des AKTUELL
    // ladenden Streams, z.B. "45.2% of  123.45MiB at  2.34MiB/s ETA 00:32"
    // (oder "of ~123.45MiB" bei nur geschaetzter Groesse, z.B. bei HLS/DASH-
    // Fragmenten). Vorher gab es fuer extern eingebettete Videos (yt-dlp)
    // ueberhaupt keine Groessenangabe, nur Prozent - das machte sowohl die
    // Gesamt-MB/GB-Anzeige als auch die Est.-Time-Berechnung ungenau.
    const sizeMatch = line ? /of\s+~?([\d.]+)\s*([KMGT]?i?B)/i.exec(line) : null;
    if (sizeMatch) {
      const bytes = parseSizeToBytes(sizeMatch[1], sizeMatch[2]);
      // Waehrend des Mergens meldet ffmpeg keine Groessen mehr - falls doch
      // etwas Prozent-/Groessenaehnliches durchrutscht, nicht der letzten
      // Download-Phase zuschlagen.
      if (bytes && downloadPhase !== "merger") {
        const slot = downloadPhase === "audio" ? "audio" : "video";
        if (bytes > phaseBytes[slot]) phaseBytes[slot] = bytes;
      }
    }
    // Summe ueber alle bisher gesehenen Streams = beste verfuegbare Naeherung
    // der finalen Dateigroesse (Container-Overhead beim Muxen ist minimal).
    const totalBytes = phaseBytes.video + phaseBytes.audio || null;

    return {
      phase: isScanning ? "scanning" : "active",
      pct: maxPct,
      phaseLabel: isScanning ? "Scanning..." : "Video",
      speed: speedMatch ? speedMatch[1] : null,
      totalBytes,
    };
  }

  return feed;
}
