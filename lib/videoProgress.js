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
  let currentVideoPct = 0;
  let currentAudioPct = 0;
  let mergerStartedAt = null;
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
      // Chunk/Manifest-Schutz: Zeilen mit "100% ... in 00:00" sind Fertigmeldungen
      // von Sub-Tasks (Manifests, Storyboards, Mini-Fragmente). Sie dürfen NICHT
      // die Haupt-Stream-Prozente überschreiben, außer die geladene Größe entspricht
      // der tatsächlichen Spurgröße (> 50MB).
      const isSubChunkDone = line && line.includes(" in ") && (!bytes || bytes < 50 * 1024 * 1024);

      if (!isSubChunkDone) {
        if (isAudioOnly) {
          if (currentPct > currentAudioPct) currentAudioPct = currentPct;
        } else if (downloadPhase === "video") {
          if (currentPct > currentVideoPct) currentVideoPct = currentPct;
        } else if (downloadPhase === "audio") {
          if (currentPct > currentAudioPct) currentAudioPct = currentPct;
        }
      }
    }

    let effPct = 0;
    if (isAudioOnly) {
      effPct = currentAudioPct;
    } else if (downloadPhase === "video") {
      effPct = currentVideoPct * 0.98;
      if (phaseBytes.video > 0 && phaseBytes.audio > 0) {
        const streamTotal = phaseBytes.video + phaseBytes.audio;
        const rec = (currentVideoPct / 100) * phaseBytes.video;
        effPct = (rec / streamTotal) * 100;
      }
    } else if (downloadPhase === "audio") {
      effPct = 98 + (currentAudioPct * 0.015);
      if (phaseBytes.video > 0) {
        const audioEst = phaseBytes.audio || 15 * 1024 * 1024;
        const streamTotal = phaseBytes.video + audioEst;
        const rec = phaseBytes.video + ((currentAudioPct / 100) * audioEst);
        effPct = (rec / streamTotal) * 100;
      }
      effPct = Math.min(99.5, effPct);
    } else if (downloadPhase === "merger") {
      const elapsed = mergerStartedAt ? Date.now() - mergerStartedAt : 0;
      effPct = 99 + Math.min(0.8, elapsed / 3000);
    }

    const isScanning = (downloadPhase === "video" && effPct === 0 && currentPct < 0);
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
      console.log(`[PatreonArchiver:Video] [${effPhase}] ${effPct.toFixed(1)}% | speed: ${effSpeed || '-'} | total: ${totalBytes ? Math.round(totalBytes / 1024 / 1024) + 'MB' : '-'} | raw: ${line.trim()}`);
    }

    return {
      phase: effPhase,
      pct: effPct,
      phaseLabel: effLabel,
      speed: effSpeed,
      totalBytes,
    };
  }

  return feed;
}
