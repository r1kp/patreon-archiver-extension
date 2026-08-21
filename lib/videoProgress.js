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
    if (line && (line.includes("[Merger] Merging formats") || line.includes("Merging formats") || line.includes("[ffmpeg] Merging"))) {
      if (downloadPhase !== "merger") mergerStartedAt = Date.now();
      downloadPhase = "merger";
    } else if (line && line.includes("[download] Destination:")) {
      if (line.includes(".m4a") || line.includes(".f251") || line.includes(".f250") || line.includes(".f249") || line.includes(".f140") || line.includes(".aac") || line.includes(".mp3") || line.includes(".opus") || line.includes(".fdash-audio-")) {
        downloadPhase = "audio";
      } else if (line.includes(".mp4") || line.includes(".webm") || line.includes(".mkv") || line.includes(".f137") || line.includes(".f248") || line.includes(".f399") || line.includes(".f136") || line.includes(".f247")) {
        downloadPhase = "video";
      }
    }

    const pctMatch = line ? /(\d{1,3}(?:\.\d+)?)%/.exec(line) : null;
    const currentPct = pctMatch ? parseFloat(pctMatch[1]) : -1;

    // Robuste Größenerkennung für yt-dlp
    let bytes = null;
    const sizeMatch = line ? /(?:of\s+~?\s*|\b)([\d.]+)\s*([KMGT]i?B)(?:\s+at|\s+ETA|\s+in\b)/i.exec(line) || /of\s+~?\s*([\d.]+)\s*([KMGT]?i?B)/i.exec(line) : null;
    if (sizeMatch) {
      bytes = parseSizeToBytes(sizeMatch[1], sizeMatch[2]);
      if (bytes && downloadPhase !== "merger") {
        const slot = downloadPhase === "audio" ? "audio" : "video";
        if (bytes > phaseBytes[slot]) phaseBytes[slot] = bytes;
      }
    }

    const totalBytes = (phaseBytes.video + phaseBytes.audio) || phaseBytes.video || null;

    if (currentPct >= 0 && downloadPhase !== "merger") {
      // Chunk/Segment Schutz: Wenn yt-dlp "100% of 1.45MiB in 00:00" meldet,
      // die Videospur aber mehrere hundert MB/GB groß ist, ist dies nur ein
      // Sub-Fragment und darf NICHT den Gesamtprozentwert nach oben reißen.
      const isFinishedChunk = line && (line.includes(" in ") || currentPct >= 99.9);
      const slot = downloadPhase === "audio" ? "audio" : "video";
      const expectedSize = phaseBytes[slot] || 0;
      const isMinorChunk = isFinishedChunk && expectedSize > 50 * 1024 * 1024 && (bytes || 0) < expectedSize * 0.5;

      if (!isMinorChunk) {
        if (isAudioOnly) {
          if (currentPct > maxPct) maxPct = currentPct;
        } else if (downloadPhase === "video") {
          // Proportionale Skalierung nach tatsächlichen Bytes der Videospur
          let calc = currentPct * 0.98;
          if (phaseBytes.video > 0 && phaseBytes.audio > 0) {
            const streamTotal = phaseBytes.video + phaseBytes.audio;
            const rec = (currentPct / 100) * phaseBytes.video;
            calc = (rec / streamTotal) * 100;
          }
          if (calc > maxPct) maxPct = calc;
        } else if (downloadPhase === "audio") {
          // Proportionale Skalierung nach Audiospur
          let calc = 98 + (currentPct * 0.015);
          if (phaseBytes.video > 0) {
            const audioEst = phaseBytes.audio || 15 * 1024 * 1024;
            const streamTotal = phaseBytes.video + audioEst;
            const rec = phaseBytes.video + ((currentPct / 100) * audioEst);
            calc = (rec / streamTotal) * 100;
          }
          calc = Math.min(99.5, calc);
          if (calc > maxPct) maxPct = calc;
        }
      }
    }

    if (downloadPhase === "merger") {
      const elapsed = mergerStartedAt ? Date.now() - mergerStartedAt : 0;
      const trickle = 99 + Math.min(0.8, elapsed / 3000);
      if (trickle > maxPct) maxPct = trickle;
    }

    const isScanning = (downloadPhase === "video" && maxPct === 0 && currentPct < 0);
    const speedMatch = line ? /at\s+([\d.]+\s*[KMGT]?i?B\/s)/.exec(line) : null;

    let effPhase = downloadPhase;
    let effLabel = "Video";
    let effSpeed = speedMatch ? speedMatch[1] : null;

    if (downloadPhase === "merger") {
      effPhase = "merging";
      effLabel = "Finalizing video...";
      effSpeed = null;
    } else if (downloadPhase === "audio") {
      effPhase = "audio";
      effLabel = isAudioOnly ? "Audio" : "Audio track";
    } else if (isScanning) {
      effPhase = "scanning";
      effLabel = "Scanning...";
      effSpeed = null;
    }

    if (line) {
      console.log(`[PatreonArchiver:Video] [${effPhase}] ${maxPct.toFixed(1)}% | speed: ${effSpeed || '-'} | total: ${totalBytes ? Math.round(totalBytes / 1024 / 1024) + 'MB' : '-'} | raw: ${line.trim()}`);
    }

    return {
      phase: effPhase,
      pct: maxPct,
      phaseLabel: effLabel,
      speed: effSpeed,
      totalBytes,
    };
  }

  return feed;
}
