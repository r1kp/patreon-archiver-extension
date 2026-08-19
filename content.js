/**
 * content.js
 * Läuft auf patreon.com. Erkennt das aktuelle Creator-Profil, holt sich per
 * Patreons eigener JSON-API alle Posts inkl. Text, Thumbnail, Video
 * (nativ hochgeladen ODER externer Embed wie YouTube/Vimeo), Audio und
 * Datei-Anhänge und schickt sie in Batches an den Background-Service-Worker.
 *
 * WICHTIG zu Videos: Patreon liefert für nativ hochgeladene Videos eine
 * echte Download-URL über die API. Für eingebettete YouTube-/Vimeo-Videos
 * gibt es dagegen KEINE Datei über Patreons API - nur einen Link zum Embed.
 * Diese Extension versucht bewusst NICHT, YouTube/Vimeo-Videos selbst zu
 * extrahieren (das wäre im Grunde ein eigener YouTube-Downloader) - stattdessen
 * wird der Embed-Link als Textdatei gespeichert, damit nichts verloren geht.
 *
 * WICHTIG: Patreon kann Feldnamen/Endpunkte jederzeit ändern. Stellen, an
 * denen man am ehesten nachjustieren muss, sind mit "// ANPASSEN:" markiert.
 */

(() => {
  if (window.__patreonArchiverInjected) return;
  window.__patreonArchiverInjected = true;

  const API_BASE = "https://www.patreon.com/api";
  let i18n = null; // { t, getLanguage } - per dynamic import geladen
  let lang = "de";

  async function loadI18n() {
    try {
      const mod = await import(chrome.runtime.getURL("lib/i18n.js"));
      i18n = mod;
      lang = await mod.getLanguage();
    } catch (err) {
      console.warn("[Patreon Archiv-Manager] i18n konnte nicht geladen werden", err);
    }
  }
  function L(key, ...args) {
    if (!i18n) return key;
    return i18n.t(lang, key, ...args);
  }


  // ---------- UI: schwebendes Panel unten rechts (offen / minimiert / geschlossen) ----------
  let panelState = "closed"; // "full" | "minimized" | "closed"
  let closeCount = 0;
  let container;
  let scanning = false;

  function ensureContainer() {
    if (container) return container;
    container = document.createElement("div");
    container.id = "pa-container";
    container.innerHTML = `
      <style>
        #pa-container { position: fixed; bottom: 20px; right: 20px; z-index: 999999;
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
        #pa-panel { background: #1b1b1f; color: #f2f2f2; border-radius: 14px; padding: 14px 16px;
          box-shadow: 0 8px 28px rgba(0,0,0,.35); width: 270px; position: relative; }
        #pa-panel h4 { margin: 0 0 8px; font-size: 13px; font-weight: 600; display:flex; align-items:center; gap:6px; padding-right: 16px;}
        #pa-panel .pa-dot { width:8px;height:8px;border-radius:50%; background:#ff5a3c; display:inline-block;}
        #pa-panel button.pa-scan { background: #ff5a3c; color: #fff; border: none; border-radius: 8px;
          padding: 8px 12px; font-size: 12.5px; font-weight: 600; cursor: pointer; width: 100%; }
        #pa-panel button.pa-scan:disabled { background: #555; cursor: default; }
        #pa-panel button.pa-scan.pa-cancel { background: transparent; color: #ff5a3c; border: 1.5px solid #ff5a3c; }
        #pa-panel button.pa-scan.pa-cancel:hover { background: rgba(255, 90, 60, 0.15); color: #ff5a3c; }

        #pa-confirm-modal {
          position: absolute;
          inset: 0;
          background: rgba(23, 23, 28, 0.96);
          border-radius: 14px;
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          padding: 16px;
          text-align: center;
          z-index: 10;
          backdrop-filter: blur(6px);
        }
        #pa-confirm-modal p {
          font-size: 12.5px;
          font-weight: 600;
          color: #f2f2f2;
          margin: 0 0 14px 0;
          line-height: 1.45;
        }
        #pa-confirm-modal .pa-modal-btns {
          display: flex;
          gap: 10px;
          width: 100%;
        }
        #pa-confirm-modal button {
          flex: 1;
          padding: 8px 10px;
          border-radius: 8px;
          font-size: 12px;
          font-weight: 600;
          cursor: pointer;
          border: none;
        }
        #pa-confirm-modal .pa-btn-yes {
          background: #ff5a3c;
          color: #fff;
        }
        #pa-confirm-modal .pa-btn-yes:hover {
          background: #e0482b;
        }
        #pa-confirm-modal .pa-btn-no {
          background: #333;
          color: #ccc;
        }
        #pa-confirm-modal .pa-btn-no:hover {
          background: #444;
          color: #fff;
        }
        #pa-panel .pa-status { font-size: 12px; color: #b8b8bd; margin: 8px 0; line-height:1.4; }
        
        #pa-panel .pa-bar { height: 6px; border-radius: 4px; background: #333; overflow: hidden; margin-bottom: 8px; position: relative;}
        #pa-panel .pa-bar-fill {
          height: 100%;
          background: #ff5a3c;
          width: 0%;
          transition: width 0.4s ease-out;
          position: relative;
          border-radius: 4px;
          overflow: hidden;
        }
        
        /* Single wide soft wave flowing continuously from right to left (frequent repeat interval) */
        #pa-panel .pa-bar-fill.scanning::after {
          content: '';
          position: absolute;
          top: 0; bottom: 0;
          width: 200px;
          background: linear-gradient(
            90deg,
            rgba(255, 255, 255, 0) 0%,
            rgba(255, 255, 255, 0.03) 20%,
            rgba(255, 255, 255, 0.35) 50%,
            rgba(255, 255, 255, 0.03) 80%,
            rgba(255, 255, 255, 0) 100%
          );
          animation: pa-wave-right-to-left 1.9s infinite linear;
        }

        @keyframes pa-wave-right-to-left {
          0% { right: -200px; left: auto; opacity: 0; }
          15% { opacity: 1; }
          85% { opacity: 1; }
          100% { right: 100%; left: auto; opacity: 0; }
        }

        #pa-panel a.pa-link { color: #8ab4ff; text-decoration:none; font-size:12px; }
        #pa-panel .pa-close { position:absolute; top:10px; right:12px; cursor:pointer; color:#888; font-size:14px; line-height:1;}
        #pa-panel .pa-close:hover { color:#fff; }
        #pa-bubble { width: 48px; height: 48px; border-radius: 14px; display:flex;
          align-items:center; justify-content:center; cursor: pointer; padding: 0; overflow: hidden;
          box-shadow: 0 6px 18px rgba(0,0,0,.35); border: none; background: transparent; }
        #pa-bubble img { width: 100%; height: 100%; object-fit: cover; }
        #pa-panel .pa-logo { width:18px; height:18px; border-radius:5px; vertical-align:middle; }
      </style>
      <div id="pa-panel" style="display:none;"></div>
      <button id="pa-bubble" style="display:none;" title="Patreon Archiv-Manager"><img src="${chrome.runtime.getURL("icons/icon128.png")}" alt="" /></button>
    `;
    document.documentElement.appendChild(container);
    container.querySelector("#pa-bubble").addEventListener("click", () => setPanelState("full"));
    return container;
  }

  function renderPanelContents() {
    const panel = container.querySelector("#pa-panel");
    const onCreator = isCreatorPage();

    if (!onCreator) {
      // Not on a creator profile page – show a helpful info message.
      panel.innerHTML = `
        <span class="pa-close" id="pa-close-btn">✕</span>
        <h4><img class="pa-logo" src="${chrome.runtime.getURL("icons/icon128.png")}" alt="" /> ${L("panelTitle")}</h4>
        <div class="pa-status" id="pa-status" style="font-size:12px;line-height:1.6;text-align:left;padding:4px 0;">
          👋 Navigate to a creator's <b>posts page</b> on Patreon first, then click <b>Scan</b> to archive their content.
        </div>
        <div style="margin-top:10px;text-align:center;"><a class="pa-link" id="pa-open-dash" href="#">${L("panelOpenDashboard")}</a></div>
      `;
      panel.querySelector("#pa-close-btn").onclick = onCloseClick;
      panel.querySelector("#pa-open-dash").onclick = (e) => {
        e.preventDefault();
        chrome.runtime.sendMessage({ type: "OPEN_DASHBOARD" });
      };
      return;
    }

    panel.innerHTML = `
      <span class="pa-close" id="pa-close-btn">✕</span>
      <h4><img class="pa-logo" src="${chrome.runtime.getURL("icons/icon128.png")}" alt="" /> ${L("panelTitle")}</h4>
      <div class="pa-bar" id="pa-bar"><div class="pa-bar-fill"></div></div>
      <div class="pa-status" id="pa-status">${L("panelReady")}</div>
      <button class="pa-scan" id="pa-scan-btn">${L("panelScanBtn")}</button>
      <div style="margin-top:8px;text-align:center;"><a class="pa-link" id="pa-open-dash" href="#">${L("panelOpenDashboard")}</a></div>
    `;
    panel.querySelector("#pa-close-btn").onclick = onCloseClick;
    panel.querySelector("#pa-scan-btn").onclick = () => {
      if (scanning) {
        cancelScan();
      } else {
        startScan();
      }
    };
    panel.querySelector("#pa-open-dash").onclick = (e) => {
      e.preventDefault();
      chrome.runtime.sendMessage({ type: "OPEN_DASHBOARD" });
    };
    updateScanAvailability();
  }

  // Scannen ist nur auf der Hauptseite/Beiträge-Übersicht eines Profils
  // sinnvoll - auf einer einzelnen Post-Detailseite wird der Button deaktiviert.
  function updateScanAvailability() {
    if (!container || panelState !== "full" || scanning) return;
    const btn = container.querySelector("#pa-scan-btn");
    if (!btn) return;
    if (isSinglePostPage()) {
      btn.disabled = true;
      setStatus(L("panelOnlyOnMainPage"), { progress: 0 });
    } else {
      btn.disabled = false;
      const statusEl = container.querySelector("#pa-status");
      if (statusEl && statusEl.textContent === L("panelOnlyOnMainPage")) {
        setStatus(L("panelReady"), { progress: 0 });
      }
    }
  }

  function onCloseClick() {
    closeCount += 1;
    if (closeCount === 1) {
      setPanelState("minimized");
    } else {
      setPanelState("closed");
    }
  }

  function setPanelState(next) {
    ensureContainer();
    panelState = next;
    const panel = container.querySelector("#pa-panel");
    const bubble = container.querySelector("#pa-bubble");
    if (next === "full") {
      if (!panel.dataset.rendered) {
        renderPanelContents();
        panel.dataset.rendered = "1";
      }
      panel.style.display = "block";
      bubble.style.display = "none";
    } else if (next === "minimized") {
      panel.style.display = "none";
      bubble.style.display = "flex";
    } else {
      panel.style.display = "none";
      bubble.style.display = "none";
    }
  }

  let pseudoProgressTicks = 0;
  let currentMaxProgress = 0;
  let scanCancelRequested = false;

  function resetPseudoProgress() {
    pseudoProgressTicks = 0;
    currentMaxProgress = 0;
  }
  function nextPseudoProgress() {
    pseudoProgressTicks += 1;
    // Sanfter Anstieg bis max 15% während der Profilsuche
    return 15 * (1 - 1 / (1 + pseudoProgressTicks / 3));
  }

  function cancelScan() {
    if (!scanning || scanCancelRequested) return;
    showConfirmModal("Are you sure you want to cancel the scan?", () => {
      scanCancelRequested = true;
      setStatus("Cancelling scan...", { progress: 0 });
    });
  }

  function showConfirmModal(questionText, onYes) {
    if (!container) return;
    const panel = container.querySelector("#pa-panel");
    if (!panel) return;
    let modal = panel.querySelector("#pa-confirm-modal");
    if (modal) modal.remove();

    modal = document.createElement("div");
    modal.id = "pa-confirm-modal";
    modal.innerHTML = `
      <p>${questionText}</p>
      <div class="pa-modal-btns">
        <button class="pa-btn-yes" id="pa-modal-yes">Yes, cancel</button>
        <button class="pa-btn-no" id="pa-modal-no">No, continue</button>
      </div>
    `;
    panel.appendChild(modal);

    modal.querySelector("#pa-modal-yes").onclick = () => {
      modal.remove();
      onYes();
    };
    modal.querySelector("#pa-modal-no").onclick = () => {
      modal.remove();
    };
  }

  function setStatus(text, opts = {}) {
    if (panelState !== "full" || !container) return;
    const statusEl = container.querySelector("#pa-status");
    const barEl = container.querySelector("#pa-bar");
    if (statusEl) statusEl.innerHTML = text;
    if (!barEl) return;
    const fillEl = barEl.querySelector(".pa-bar-fill");
    
    let rawPct = opts.indeterminate ? nextPseudoProgress() : opts.progress ?? 0;
    // Monotone Steigerung: Der Fortschritt springt NIEMALS rückwärts!
    if (rawPct > currentMaxProgress) {
      currentMaxProgress = rawPct;
    }
    const finalPct = Math.max(0, Math.min(100, currentMaxProgress));
    fillEl.style.width = `${finalPct}%`;

    if (scanning && finalPct > 0 && finalPct < 100) {
      fillEl.classList.add("scanning");
    } else {
      fillEl.classList.remove("scanning");
    }
  }

  // ---------- Hilfsfunktionen ----------

  // Eine "Post-Detailseite" (z.B. /posts/mein-titel-123456) - hier soll NICHT
  // gescannt werden können, nur auf der Hauptseite/Beiträge-Übersicht des Profils.
  function isSinglePostPage() {
    return /\/posts\/[\w-]*-\d+(?:$|[/?#])/.test(location.pathname);
  }

  // Erkennt, ob man auf einer Creator-Profilseite ist (z.B. /c/name, /user/name,
  // /name oder /name/posts). Auf Discover-, Home- und anderen Seiten soll nur
  // das Dashboard-Link angezeigt werden.
  function isCreatorPage() {
    const p = location.pathname;
    // Explizit KEINE Creator-Seiten:
    if (/^\/(explore|discover|home|search|login|signup|settings|checkout|payment|join|about|press|careers|privacy|terms|sitemap)(\/?$|\/)/.test(p)) return false;
    // Typische Creator-URLs
    if (/^\/(c|user)\/[^/]+(\/posts)?(\/?$|[/?#])/.test(p)) return true;
    // /creatorname oder /creatorname/posts
    if (/^\/[^/]+(\/posts)?(\/?$|[/?#])/.test(p)) return true;
    return false;
  }

  function queryShadow(selector, root = document) {
    const el = root.querySelector(selector);
    if (el) return el;
    const all = root.querySelectorAll("*");
    for (const node of all) {
      if (node.shadowRoot) {
        const found = queryShadow(selector, node.shadowRoot);
        if (found) return found;
      }
    }
    return null;
  }

  function findAnyPostId() {
    const m = location.pathname.match(/\/posts\/(?:[\w-]+-)?(\d+)(?:$|\/)/);
    if (m) return m[1];
    const link = queryShadow('a[href*="/posts/"]');
    if (link) {
      const m2 = link.getAttribute("href").match(/\/posts\/(?:[\w-]+-)?(\d+)(?:$|\/|\?)/);
      if (m2) return m2[1];
    }
    return null;
  }

  // Schreibt eine Zeile ins persistente Log der Extension. content.js ist ein
  // KLASSISCHES Content-Script (kein Modul, siehe manifest.json) und kann
  // lib/appLog.js nicht importieren - deshalb der Umweg ueber background.js,
  // das den Eintrag in den IndexedDB-Ringpuffer legt und ggf. an die Bridge
  // weiterreicht. Bewusst ohne await/Antwort: Logging darf den Scan nie bremsen.
  function paLog(level, message) {
    try {
      chrome.runtime.sendMessage({ type: "APP_LOG", level, message: String(message), source: "content" }, () => {
        void chrome.runtime.lastError;
      });
    } catch { /* Kontext bereits entladen - dann eben nicht */ }
  }

  async function fetchJson(url) {
    const res = await fetch(url, { credentials: "include", headers: { accept: "application/vnd.api+json" } });
    if (!res.ok) throw new Error(`HTTP ${res.status} bei ${url}`);
    return res.json();
  }

  function buildIncludedMap(included) {
    const map = new Map();
    (included || []).forEach((item) => map.set(`${item.type}:${item.id}`, item));
    return map;
  }

  function stripHtml(html) {
    if (!html) return "";
    const div = document.createElement("div");
    div.innerHTML = html;
    return div.textContent || div.innerText || "";
  }

  function extractTextFromJsonDoc(jsonString) {
    if (!jsonString) return "";
    try {
      const doc = JSON.parse(jsonString);
      const textParts = [];
      
      function traverse(node) {
        if (!node) return;
        if (node.type === "text" && node.text) {
          textParts.push(node.text);
        }
        if (node.content && Array.isArray(node.content)) {
          node.content.forEach(traverse);
        }
      }
      
      traverse(doc);
      return textParts.join(" ").replace(/\s+/g, " ").trim();
    } catch (e) {
      console.warn("[PatreonArchiver Debug] Failed to parse content_json_string:", e);
      return "";
    }
  }

  // ---------- Zentrale Link-Klassifizierung (Video vs. Cloud vs. Website) ----------
  //
  // EINE Quelle innerhalb von content.js: vorher stand dieselbe Anbieterliste
  // dreimal untereinander (isDownloadOrCloudUrl(), der cloudPattern-Regex und
  // classifyAndFormatLink()) - genau das in CLAUDE.md dokumentierte Duplikat-
  // Fehlermuster, nur auf Daten statt auf Logik.
  //
  // WICHTIG: content.js ist ein KLASSISCHES Content-Script (kein
  // `"type": "module"` im Manifest) und kann deshalb nichts aus lib/
  // importieren. Das Gegenstueck fuer die Download-Seite ist
  // UNSUPPORTED_CLOUD_PROVIDERS in lib/cloudDownloader.js (dient dort nur noch
  // als Sicherheitsnetz fuer Posts, die VOR dieser Runde gescannt wurden) -
  // bei Aenderungen bitte beide Listen anfassen.
  const CLOUD_PROVIDERS = [
    // supported: die Bridge/Extension kann daraus tatsaechlich herunterladen
    { key: "drive", label: "Google Drive", supported: true, hosts: ["drive.google.com", "docs.google.com"] },
    { key: "dropbox", label: "Dropbox", supported: true, hosts: ["dropbox.com"] },
    { key: "mega", label: "MEGA", supported: true, hosts: ["mega.nz", "mega.io"] },
    { key: "onedrive", label: "OneDrive", supported: true, hosts: ["onedrive.live.com", "1drv.ms"] },
    { key: "mediafire", label: "MediaFire", supported: true, hosts: ["mediafire.com"] },
    { key: "pixeldrain", label: "PixelDrain", supported: true, hosts: ["pixeldrain.com"] },
    { key: "wetransfer", label: "WeTransfer", supported: true, hosts: ["wetransfer.com", "we.tl"] },
    // supported: false - bewusst TROTZDEM erkannt, damit der Nutzer eine klare
    // "Anbieter wird nicht unterstuetzt"-Meldung bekommt (siehe
    // classifyDownloadError() in dashboard.js) statt eines stillen Fehlversuchs,
    // bei dem die Bridge nur die HTML-Freigabeseite herunterlaedt.
    { key: "icloud", label: "iCloud", supported: false, hosts: ["icloud.com"] },
    { key: "sync", label: "Sync.com", supported: false, hosts: ["sync.com"] },
    { key: "box", label: "Box", supported: false, hosts: ["box.com"] },
    { key: "pcloud", label: "pCloud", supported: false, hosts: ["pcloud.com", "pcloud.link"] },
    { key: "protondrive", label: "Proton Drive", supported: false, hosts: ["drive.proton.me"] },
    { key: "yandex", label: "Yandex Disk", supported: false, hosts: ["disk.yandex.com", "disk.yandex.ru"] },
    { key: "terabox", label: "TeraBox", supported: false, hosts: ["terabox.com", "teraboxapp.com"] },
    { key: "gofile", label: "Gofile", supported: false, hosts: ["gofile.io"] },
    { key: "swisstransfer", label: "SwissTransfer", supported: false, hosts: ["swisstransfer.com"] },
    { key: "smash", label: "Smash", supported: false, hosts: ["fromsmash.com"] },
    { key: "filemail", label: "Filemail", supported: false, hosts: ["filemail.com"] },
    { key: "krakenfiles", label: "KrakenFiles", supported: false, hosts: ["krakenfiles.com"] },
    { key: "4shared", label: "4shared", supported: false, hosts: ["4shared.com"] },
    { key: "sendspace", label: "Sendspace", supported: false, hosts: ["sendspace.com"] },
  ];

  // Video-Hosts, aus denen yt-dlp tatsaechlich ein Video ziehen kann. Bewusst
  // laenger als nur YouTube/Vimeo: bis zu dieser Runde galt JEDES `attrs.embed`
  // als Video, ein zu kurzer Liste wuerde also echte Video-Embeds
  // (SoundCloud/Twitch/...) zu blossen Links degradieren.
  const VIDEO_EMBED_HOSTS = [
    "youtube.com", "youtu.be", "youtube-nocookie.com",
    "vimeo.com", "dailymotion.com", "dai.ly", "twitch.tv", "streamable.com",
    "soundcloud.com", "bandcamp.com", "mixcloud.com", "spotify.com",
    "tiktok.com", "twitter.com", "x.com", "facebook.com", "instagram.com",
    "bilibili.com", "odysee.com", "rumble.com",
  ];
  // Patreon liefert im Embed-Objekt zusaetzlich einen Anbieternamen
  // (attrs.embed.provider, z.B. "YouTube"/"Vimeo"/"SoundCloud") - als zweiter
  // Weg, falls die URL selbst ueber einen Kurz-/Weiterleitungs-Host laeuft.
  const VIDEO_EMBED_PROVIDERS = [
    "youtube", "vimeo", "dailymotion", "twitch", "streamable", "soundcloud",
    "bandcamp", "mixcloud", "spotify", "tiktok", "twitter", "x", "facebook",
    "instagram", "bilibili", "odysee", "rumble",
  ];

  // null, wenn die Zeichenkette keine parsebare URL ist - der Aufrufer faellt
  // dann auf einen Substring-Vergleich zurueck.
  function hostOf(url) {
    try { return new URL(url).hostname.toLowerCase(); }
    catch { return null; }
  }

  // Vergleich bewusst exakt bzw. auf Subdomain-Ebene, KEIN blosses
  // host.includes(h): "www.dropbox.com".includes("box.com") ist true - Dropbox
  // wuerde sonst je nach Reihenfolge der Tabelle als "Box" durchgehen.
  function hostMatches(host, rawUrl, h) {
    if (host) return host === h || host.endsWith(`.${h}`);
    return rawUrl.includes(h);
  }

  function cloudProviderFor(url) {
    if (!url) return null;
    const host = hostOf(url);
    const raw = String(url).toLowerCase();
    return CLOUD_PROVIDERS.find((p) => p.hosts.some((h) => hostMatches(host, raw, h))) || null;
  }

  function isVideoEmbedUrl(url, providerHint) {
    const host = hostOf(url);
    const raw = String(url || "").toLowerCase();
    if (VIDEO_EMBED_HOSTS.some((h) => hostMatches(host, raw, h))) return true;
    const hint = String(providerHint || "").toLowerCase().replace(/[^a-z]/g, "");
    return !!hint && VIDEO_EMBED_PROVIDERS.includes(hint);
  }

  // Klassifizierungs-Regel fuer `attrs.embed` (Patreons Link-Vorschau-/
  // Einbettungs-Objekt). Bis zur einundzwanzigsten Runde galt JEDES embed mit
  // einer URL als "externes Video" - ein Google-Drive-Download-Link (fuer den
  // Patreon ebenfalls eine Vorschaukarte samt Drive-Logo als Bild rendert)
  // landete dadurch als Video im Post und scheiterte zwangslaeufig an yt-dlp.
  //   "cloud"   -> Cloud-Speicher-Domain: NIE ein Video, egal welches
  //                Vorschaubild Patreon dazu zeigt (Regel 3/4)
  //   "video"   -> bekannter Video-Host bzw. Anbietername (Regel 1)
  //   "unknown" -> alles andere: bleibt beim bisherigen Verhalten (Video/yt-dlp),
  //                weil yt-dlp tausende Seiten unterstuetzt und ein pauschales
  //                "kein Video" hier echte Video-Embeds kaputtmachen wuerde.
  // Native Patreon-Videos (Regel 2) kommen gar nicht hier an - die stammen aus
  // der media-Relationship/post_file und liegen auf Patreons eigener CDN-Domain,
  // die in keiner der Listen oben vorkommt.
  function classifyEmbedUrl(url, providerHint) {
    if (!url) return "none";
    if (cloudProviderFor(url)) return "cloud";
    if (isVideoEmbedUrl(url, providerHint)) return "video";
    return "unknown";
  }

  const DOWNLOAD_FILE_EXT_PATTERN = /\.(zip|rar|7z|tar|gz|blend|terrain|sbsar|fbx|obj|gltf|glb|exr|png|jpg|jpeg|tga|tif|tiff|mp4|mov|pdf|exe|msi|apk)(\?.*)?$/i;

  // Vergleichsschluessel fuer "ist das derselbe Link?" - bewusst unschaerfer als
  // ein Stringvergleich: Freigabe-Links tauchen mit unterschiedlichen Zusaetzen
  // auf (`?usp=sharing`, `/view`, `/edit`, Tracking-Parameter, http vs https,
  // mit/ohne `www.`). Bei Cloud-Anbietern zaehlt praktisch nur die Datei-/
  // Ordner-ID, deshalb wird die - wo erkennbar - als Schluessel genommen.
  function normalizedLinkKey(url) {
    if (!url) return "";
    const raw = String(url).trim();
    const driveId = /(?:\/file\/d\/|\/folders\/|[?&]id=)([a-zA-Z0-9_-]{15,})/.exec(raw);
    if (driveId && /drive\.google\.com|docs\.google\.com/i.test(raw)) return `drive:${driveId[1]}`;
    try {
      const u = new URL(raw);
      const host = u.hostname.toLowerCase().replace(/^www\./, "");
      const path = u.pathname.replace(/\/(view|edit|preview)$/i, "").replace(/\/+$/, "");
      return `${host}${path}${u.hash || ""}`.toLowerCase();
    } catch {
      return raw.toLowerCase();
    }
  }

  function extractStructuredLinks(jsonString, htmlContent) {
    const linksMap = new Map(); // url -> label

    function isDownloadOrCloudUrl(url) {
      if (!url) return false;
      const urlLower = url.toLowerCase();
      if (isVideoEmbedUrl(url, "")) return false;
      const isGithubRelease = urlLower.includes("github.com") && urlLower.includes("/releases/");
      return !!cloudProviderFor(url) || isGithubRelease || DOWNLOAD_FILE_EXT_PATTERN.test(urlLower);
    }

    if (jsonString) {
      try {
        const doc = JSON.parse(jsonString);
        function traverse(node) {
          if (!node) return;
          // CTA Buttons are ALWAYS included (even if website/github)
          if (node.type === "cta" && node.attrs?.button_link) {
            const rawUrl = (node.attrs.button_link || "").trim();
            const label = (node.attrs.button_text || "").trim();
            if (rawUrl) linksMap.set(rawUrl, label);
          }
          // Inline text mark links are included IF they are cloud/download URLs
          if (node.type === "text" && node.text && node.marks && Array.isArray(node.marks)) {
            for (const mark of node.marks) {
              if (mark.type === "link" && mark.attrs?.href) {
                const rawUrl = (mark.attrs.href || "").trim();
                const label = (node.text || "").trim();
                if (rawUrl && isDownloadOrCloudUrl(rawUrl) && !linksMap.has(rawUrl)) {
                  linksMap.set(rawUrl, label);
                }
              }
            }
          }
          if (node.content && Array.isArray(node.content)) {
            node.content.forEach(traverse);
          }
        }
        traverse(doc);
      } catch (e) {
        // ignore
      }
    }

    if (htmlContent) {
      try {
        const div = document.createElement("div");
        div.innerHTML = htmlContent;
        const anchors = div.querySelectorAll("a[href]");
        anchors.forEach((a) => {
          const rawUrl = (a.getAttribute("href") || "").trim();
          const label = (a.textContent || "").trim();
          if (rawUrl && isDownloadOrCloudUrl(rawUrl) && !linksMap.has(rawUrl)) {
            linksMap.set(rawUrl, label);
          }
        });
      } catch (e) {
        // ignore
      }
    }

    const fullText = (jsonString || "") + " " + (htmlContent || "");
    // Regex aus derselben Anbietertabelle erzeugen statt einer vierten
    // handgepflegten Kopie derselben Domainliste (siehe CLOUD_PROVIDERS oben).
    const cloudHostAlternation = CLOUD_PROVIDERS
      .flatMap((p) => p.hosts)
      .map((h) => h.replace(/\./g, "\\."))
      .join("|");
    const cloudPattern = new RegExp(`https?:\\/\\/(?:www\\.)?(?:${cloudHostAlternation})\\/[^\\s"'<>\\\\]+`, "gi");
    let m;
    while ((m = cloudPattern.exec(fullText)) !== null) {
      let cleanUrl = m[0].replace(/[).,;]+$/, "");
      if (cleanUrl && !linksMap.has(cleanUrl)) {
        linksMap.set(cleanUrl, "");
      }
    }

    return Array.from(linksMap.entries()).map(([url, label]) => ({ url, label }));
  }

  function classifyAndFormatLink(linkUrl, label) {
    const urlLower = linkUrl.toLowerCase();

    // Anbieter kommt aus der EINEN Tabelle oben (vorher hier eine zweite,
    // handgepflegte if-Kette, die die "supported: false"-Anbieter gar nicht kannte).
    const provider = cloudProviderFor(linkUrl);
    const isGithubDownload = urlLower.includes("github.com") && urlLower.includes("/releases/download/");
    const isGithubGeneral = urlLower.includes("github.com");

    const hasFileExt = DOWNLOAD_FILE_EXT_PATTERN.test(urlLower);

    const isCloudOrDownload = !!provider || isGithubDownload || hasFileExt;

    let tag = "External File";
    if (provider) tag = provider.label;
    else if (isGithubDownload) tag = "GitHub Release";
    else if (isGithubGeneral) tag = "Website";
    else if (!isCloudOrDownload) tag = "Website";

    // Der vom Creator vergebene, sichtbare Linktext (Ankertext bzw.
    // CTA-Button-Beschriftung, z.B. "Conifer Trees"). Wird beim Download als
    // Name des Unterordners benutzt - aber NUR, wenn es wirklich ein eigener
    // Text ist: hat der Creator die nackte URL gepostet, ist der "Linktext"
    // die URL selbst und als Ordnername unbrauchbar.
    const rawLabel = (label || "").trim();
    const linkLabel = rawLabel && !/^https?:\/\//i.test(rawLabel) ? rawLabel.slice(0, 80) : null;

    let cleanName = (label || "").trim();
    if (!cleanName || cleanName.startsWith("http://") || cleanName.startsWith("https://")) {
      if (provider) cleanName = `${provider.label} Link`;
      else if (isGithubDownload) cleanName = "GitHub Release File";
      else if (isGithubGeneral) cleanName = "GitHub Page";
      else if (hasFileExt) {
        try {
          const u = new URL(linkUrl);
          const parts = u.pathname.split("/");
          cleanName = decodeURIComponent(parts[parts.length - 1]) || "File Download";
        } catch (e) {
          cleanName = "File Download";
        }
      } else {
        try {
          const u = new URL(linkUrl);
          cleanName = u.hostname.replace(/^www\./, "");
        } catch (e) {
          cleanName = "External Link";
        }
      }
    }
    
    const filename = `${cleanName} [${tag}]`;
    
    return {
      url: linkUrl,
      filename,
      mimetype: isCloudOrDownload ? "application/octet-stream" : "text/plain",
      sizeBytes: null,
      kind: "attachment",
      // Sichtbarer Linktext des Creators - Grundlage fuer den Ordnernamen beim
      // Download (siehe cloudLinkFolderName() in lib/downloader.js).
      linkLabel,
      // Anbieter erkannt, aber (noch) nicht automatisch ladbar (iCloud,
      // Sync.com, ...). isCloudLink bleibt bewusst true, damit der Link
      // weiterhin in _download_links.txt landet - downloader.js bricht anhand
      // dieses Feldes VOR dem eigentlichen Download-Versuch mit einer klaren
      // Meldung ab, statt die HTML-Freigabeseite herunterzuladen.
      unsupportedProvider: provider && provider.supported === false ? provider.label : null,
      isCloudLink: isCloudOrDownload,
      isExternalLink: true,
      isWebsite: !isCloudOrDownload,
      tag,
      downloaded: false
    };
  }

  function resolveRelationshipItems(post, includedMap, relName) {
    const rel = post.relationships?.[relName];
    if (!rel || !rel.data) return [];
    const refs = Array.isArray(rel.data) ? rel.data : [rel.data];
    return refs.map((ref) => includedMap.get(`${ref.type}:${ref.id}`)).filter(Boolean);
  }

  const KNOWN_VIDEO_THUMBNAIL_HOSTS = ["ytimg.com", "vimeocdn.com", "i.vimeocdn.com", "youtube.com"];

  function isExternalVideoThumbnail(url) {
    try {
      const host = new URL(url).hostname;
      return KNOWN_VIDEO_THUMBNAIL_HOSTS.some(h => host.endsWith(h) || host.includes(h));
    } catch { return false; }
  }

  function isSameImage(url1, url2) {
    if (!url1 || !url2) return false;
    if (url1 === url2) return true;
    try {
      const u1 = new URL(url1);
      const u2 = new URL(url2);
      if (u1.pathname === u2.pathname) return true;
      
      const getMediaId = (url) => {
        const match = /\/v3\/(\d+)/.exec(url) || /\/patreon-media\/p\/post\/\d+\/([a-f0-9-]+)/i.exec(url);
        return match ? match[1] : null;
      };
      const id1 = getMediaId(url1);
      const id2 = getMediaId(url2);
      if (id1 && id2 && id1 === id2) return true;
    } catch { /* noop */ }
    return false;
  }

  // Zerlegt einen Post in: thumbnail, video (nativ ODER embed), audio[], attachments[], gallery-images[]
  // ANPASSEN: falls Patreon neue Relationship-/Attribut-Namen einführt, hier ergänzen.
  function extractMedia(post, includedMap) {
    const attrs = post.attributes || {};
    // embedLinks: Link-Vorschau-Embeds, die KEIN Video sind (z.B. ein
    // Google-Drive-Downloadlink) - werden vom Aufrufer wie ein im Posttext
    // gefundener Link behandelt (classifyAndFormatLink), NICHT als Video.
    const result = { thumbnail: null, video: null, audio: [], attachments: [], images: [], embedLinks: [] };

    // Thumbnail: mehrere mögliche Felder, je nach Post-Typ
    const thumbUrl =
      attrs.thumbnail_url ||
      attrs.image?.large_url ||
      attrs.image?.url ||
      attrs.post_metadata?.image?.url ||
      null;
    if (thumbUrl) result.thumbnail = { url: thumbUrl, filename: "thumbnail.jpg" };

    // Externes Embed (YouTube/Vimeo/...): KEINE Datei, nur Link merken.
    // ANPASSEN: Patreon setzt `attrs.embed` auch fuer reine Link-Vorschau-Karten
    // (Google Drive, Dropbox, beliebige Webseiten). Frueher wurde JEDES embed
    // ungeprueft zu `result.video` -> ein Drive-Downloadlink erschien als
    // "External video", bekam das Drive-Logo als Vorschaubild und scheiterte
    // dann zwangslaeufig an yt-dlp. Klassifizierung siehe classifyEmbedUrl().
    if (attrs.embed && attrs.embed.url) {
      const embedUrl = attrs.embed.url;
      const embedProvider = attrs.embed.provider || "";
      const embedClass = classifyEmbedUrl(embedUrl, embedProvider);
      if (embedClass === "cloud") {
        // Nur `subject` als Label (der Titel der Vorschaukarte, meist der echte
        // Dateiname) - `description` ist bei Patreon oft ein ganzer Absatz und
        // wuerde als Dateiname durchschlagen. Zusaetzlich gekappt.
        result.embedLinks.push({
          url: embedUrl,
          label: String(attrs.embed.subject || "").trim().slice(0, 100),
        });
      } else {
        result.video = {
          type: "embed",
          url: embedUrl,
          provider: embedProvider || "external",
        };
      }
    }

    // Media-Relationship durchsuchen: native Videos und Audio.
    // WICHTIG: Galerie-/Zusatzbilder werden bewusst NICHT als eigene Dateien
    // gesammelt - das Vorschaubild deckt den Post-Inhalt ab, und alles andere
    // führte nur zu doppelten "Untitled"-Einträgen. Echte Downloads sind
    // ausschließlich Attachments (siehe unten).
    const mediaItems = resolveRelationshipItems(post, includedMap, "media");
    mediaItems.forEach((item) => {
      const a = item.attributes || {};
      const url = a.download_url || a.url;
      if (!url) return;
      const mimetype = a.mimetype || "";
      const filename = a.file_name || a.display?.default?.file_name || `media_${item.id}`;
      if (!result.video && mimetype.startsWith("video/")) {
        result.video = { type: "native", url, filename, mimetype, sizeBytes: a.size_bytes || a.size || a.file_size || null };
      } else if (mimetype.startsWith("audio/")) {
        result.audio.push({ url, filename, mimetype, sizeBytes: a.size_bytes || a.size || a.file_size || null });
      } else if (a.owner_relationship === "attachment") {
        // Manche Anhänge (z.B. reine .txt-Dateien) liefert Patreon nicht über die
        // "attachments"-Relationship, sondern über "media" mit diesem Attribut als
        // einziger Kennzeichnung - ohne diesen Zweig wurden sie stillschweigend verworfen.
        result.attachments.push({ url, filename, mimetype, sizeBytes: a.size_bytes || a.size || a.file_size || null });
      }
    });

    // Falls kein natives Video über "media" gefunden wurde, versuchsweise post_file
    // prüfen - aber NUR übernehmen, wenn es klar wie eine Videodatei aussieht,
    // damit wir nicht versehentlich ein Vorschaubild als "Video" abspeichern.
    if (!result.video && attrs.post_file) {
      const pf = attrs.post_file;
      const url = pf.download_url || pf.url;
      const looksLikeVideo =
        /\.(mp4|mov|webm|m4v)(\?|$)/i.test(url || "") || (pf.mimetype || "").startsWith("video/");
      if (url && looksLikeVideo) {
        result.video = {
          type: "native",
          url,
          filename: pf.name || "video.mp4",
          mimetype: pf.mimetype || null,
          sizeBytes: pf.size_bytes || pf.size || null
        };
      }
    }

    // Anhänge (echte Downloads: PDF, ZIP, Projektdateien, ...) - NUR diese landen
    // im "Download Files"-Ordner.
    const attachmentItems = resolveRelationshipItems(post, includedMap, "attachments");
    attachmentItems.forEach((item) => {
      const a = item.attributes || {};
      const url = a.url || a.download_url;
      if (!url) return;
      result.attachments.push({
        url,
        filename: a.name || a.file_name || `attachment_${item.id}`,
        mimetype: a.mimetype || null,
        sizeBytes: a.size_bytes || a.size || null,
      });
    });

    // Galerie- / Post-Bilder aus der "images"-Relationship auslesen
    const imageItems = resolveRelationshipItems(post, includedMap, "images");
    imageItems.forEach((item) => {
      const a = item.attributes || {};
      const url = a.url || a.download_url;
      if (!url) return;
      if (isExternalVideoThumbnail(url)) return;
      if (thumbUrl && isSameImage(url, thumbUrl)) return;
      result.images.push({
        url,
        filename: a.file_name || a.name || a.display?.default?.file_name || `image_${item.id}`,
        mimetype: a.mimetype || "image/jpeg",
        sizeBytes: a.size_bytes || a.size || null,
      });
    });

    return result;
  }

  // ---------- Hauptablauf ----------

  async function resolveCampaign() {
    const seedPostId = findAnyPostId();
    if (!seedPostId) {
      throw new Error(
        lang === "en"
          ? "Could not find any post on this page. Please scroll the creator's 'Posts' page until at least one post is visible, then try again."
          : "Konnte keinen Post auf dieser Seite finden. Bitte auf der 'Beiträge'-Seite des Creators scrollen, bis mindestens ein Post sichtbar ist, und erneut versuchen."
      );
    }
    const url =
      `${API_BASE}/posts/${seedPostId}` +
      `?include=campaign` +
      `&fields[campaign]=name,vanity,url,creation_name,avatar_photo_url,summary` +
      `&fields[post]=url`;
    const data = await fetchJson(url);
    const included = buildIncludedMap(data.included);
    const campaignEntry = [...included.values()].find((i) => i.type === "campaign");
    if (!campaignEntry) throw new Error("Konnte die Campaign-ID nicht aus der API-Antwort lesen (Struktur evtl. geändert).");
    const a = campaignEntry.attributes || {};
    return {
      id: campaignEntry.id,
      name: a.name || a.creation_name || a.vanity || `Creator ${campaignEntry.id}`,
      vanity: a.vanity || null,
      url: a.url || location.origin,
      avatarUrl: a.avatar_photo_url || null,
    };
  }

  // Holt die eigene Mitgliedschaft + die Tier-Liste der Kampagne.
  // WICHTIG: Patreons Membership-API ist nicht offiziell dokumentiert, deshalb
  // loggen wir die rohe Antwort zur Diagnose (F12-Konsole). Bei fehlenden
  // Feldern wird defensiv auf null/"free" zurückgefallen, statt zu brechen.
  async function fetchMembership(campaignId) {
    // ANPASSEN: Endpunkt/Felder ggf. nachjustieren, sobald wir das Diagnose-Log
    // gesehen haben. Wir fragen die Kampagne inkl. ihrer Tiers UND der aktuellen
    // Nutzer-Mitgliedschaft ab.
    const url =
      `${API_BASE}/campaigns/${campaignId}` +
      `?include=rewards,pledges_to_current_user,current_user_membership` +
      `&fields[campaign]=name,pledge_sum` +
      `&fields[reward]=title,amount_cents,patron_count` +
      `&fields[member]=patron_status,currently_entitled_amount_cents,next_charge_date,last_charge_date,pledge_relationship_start` +
      `&json-api-use-default-includes=false`;

    let data;
    try {
      data = await fetchJson(url);
    } catch (err) {
      console.warn("[Patreon Archiv-Manager] Membership-Abruf fehlgeschlagen:", err.message);
      return { isMember: false };
    }

    const includedMap = buildIncludedMap(data.included);
    const includedArr = [...includedMap.values()];

    // Alle Tiers (rewards) der Kampagne, nach Preis sortiert (ohne den
    // Gratis-"$0"-Standard-Reward, den Patreon oft als ID -1 mitschickt).
    const tiers = includedArr
      .filter((i) => i.type === "reward")
      .map((i) => ({
        id: i.id,
        title: i.attributes?.title || "",
        amount: i.attributes?.amount_cents ?? null,
      }))
      .filter((t) => t.amount !== null && t.amount > 0)
      .sort((a, b) => a.amount - b.amount);

    // Die eigene Mitgliedschaft (member-Objekt)
    const member = includedArr.find((i) => i.type === "member");
    const mAttr = member?.attributes || {};
    const patronStatus = mAttr.patron_status || null; // z.B. "active_patron", "declined_patron", null
    const entitledCents = mAttr.currently_entitled_amount_cents ?? 0;
    const nextChargeDate = mAttr.next_charge_date || null;

    const isPaying = patronStatus === "active_patron" && entitledCents > 0;
    if (!isPaying) {
      return {
        isMember: false,
        patronStatus: patronStatus || "none",
        tierName: null,
        entitledCents: 0,
        nextChargeDate,
        lastChargeDate: mAttr.last_charge_date || null,
        pledgeStart: mAttr.pledge_relationship_start || null,
        tiersTotal: tiers.length,
        checkedAt: Date.now()
      };
    }

    // Aktuelles Tier über den berechtigten Betrag zuordnen; Position bestimmen.
    let currentTier = null;
    for (let i = tiers.length - 1; i >= 0; i--) {
      if (entitledCents >= tiers[i].amount) {
        currentTier = tiers[i];
        currentTier.position = i + 1;
        break;
      }
    }

    return {
      isMember: true,
      patronStatus: "active_patron",
      tierName: currentTier?.title || null,
      tierPosition: currentTier?.position || null,
      tiersTotal: tiers.length,
      entitledCents,
      nextChargeDate, // ab wann die Mitgliedschaft theoretisch neu geprüft werden sollte
      lastChargeDate: mAttr.last_charge_date || null,
      pledgeStart: mAttr.pledge_relationship_start || null,
      cadence: mAttr.cadence || (mAttr.pledge_cadence ?? 1),
      checkedAt: Date.now(),
    };
  }

  async function* iteratePosts(campaignId, fetchSizes, onTotalKnown) {
    const fieldsPost = [
      "title",
      "content",
      "content_teaser_text",
      "teaser_text",
      "cleaned_teaser_text",
      "published_at",
      "url",
      "post_type",
      "current_user_can_view",
      "post_file",
      "embed",
      "image",
      "thumbnail_url",
      "comment_count",
    ].join(",");
    const fieldsMedia = "download_url,url,mimetype,size_bytes,file_name,display,image_urls";
    const includeList = "media,images,audio,attachments,user";

    let url =
      `${API_BASE}/posts?filter[campaign_id]=${campaignId}` +
      `&filter[is_draft]=false&sort=-published_at&page[count]=20` +
      `&fields[post]=${fieldsPost}&fields[media]=${fieldsMedia}` +
      `&include=${includeList}` +
      `&json-api-use-default-includes=false`;

    let safety = 0;
    let reportedTotal = false;
    while (url && safety < 500) {
      safety += 1;
      try {
        data = await fetchJson(url);
      } catch (err) {
        console.warn("[PatreonArchiver Debug] Primary API request failed with error:", err.message);
        const fallbackUrl = url.replace(`include=${includeList}`, "include=media,user");
        if (fallbackUrl !== url) {
          data = await fetchJson(fallbackUrl);
        } else {
          throw err;
        }
      }

      if (!reportedTotal) {
        // ANPASSEN: falls Patreon das Total-Feld umbenennt/entfernt, bleibt der
        // Fallback (Balken ohne feste Zielgröße) automatisch aktiv.
        const total = data.meta?.pagination?.total ?? data.meta?.count ?? data.meta?.total ?? null;
        if (typeof total === "number") onTotalKnown(total);
        reportedTotal = true;
      }

      const includedMap = buildIncludedMap(data.included);
      if (data.data && data.data.length > 0) {
        const firstPost = data.data[0];
      }

      const rawPostsList = data.data || [];
      const CONCURRENCY = 5;
      const fetchedFullPosts = [];

      for (let i = 0; i < rawPostsList.length; i += CONCURRENCY) {
        const chunk = rawPostsList.slice(i, i + CONCURRENCY);
        const chunkResults = await Promise.all(
          chunk.map(async (rawPost) => {
            const attrs = rawPost.attributes || {};
            const canView = attrs.current_user_can_view !== false;

            let post = rawPost;
            let postIncludedMap = includedMap;

            if (canView) {
              try {
                const singlePostUrl = `${API_BASE}/posts/${rawPost.id}?include=media,images,audio,attachments,user&json-api-use-default-includes=false`;
                const singlePostData = await fetchJson(singlePostUrl);
                if (singlePostData && singlePostData.data) {
                  post = singlePostData.data;
                  postIncludedMap = buildIncludedMap(singlePostData.included);
                }
              } catch (err) {
                console.warn(`[PatreonArchiver Debug] [Post ID: ${rawPost.id}] Failed to fetch full post details:`, err.message);
              }
            }
            return { post, postIncludedMap };
          })
        );
        fetchedFullPosts.push(...chunkResults);
      }

      const posts = fetchedFullPosts.map(({ post, postIncludedMap }) => {
        const finalAttrs = post.attributes || {};
        const media = extractMedia(post, postIncludedMap);

        const rawContent = finalAttrs.content || extractTextFromJsonDoc(finalAttrs.content_json_string) || "";
        const teaserText = finalAttrs.content_teaser_text || finalAttrs.teaser_text || finalAttrs.cleaned_teaser_text || "";
        const combinedText = rawContent + "\n" + teaserText;

        const extractedLinks = extractStructuredLinks(finalAttrs.content_json_string, finalAttrs.content);
        // Nicht-Video-Embeds (Cloud-Link-Vorschaukarten, siehe extractMedia())
        // wie einen im Text gefundenen Link behandeln. Dedupe ueber einen
        // NORMALISIERTEN Schluessel statt ueber die rohe URL: derselbe
        // Drive-Link steht in der Vorschaukarte und im Fliesstext praktisch nie
        // zeichengleich da (mal mit `?usp=sharing`, mal `/view`, mal mit
        // Tracking-Parametern). Ein reiner Stringvergleich haette denselben
        // Download dadurch als ZWEI Zeilen erzeugt.
        (media.embedLinks || []).forEach((l) => {
          const key = normalizedLinkKey(l.url);
          if (!extractedLinks.some((e) => normalizedLinkKey(e.url) === key)) extractedLinks.push(l);
        });
        const externalFiles = extractedLinks.map(({ url, label }) => classifyAndFormatLink(url, label));

        const postFiles = [
          ...[...media.attachments, ...media.audio, ...media.images].map((f) => ({
            ...f,
            kind: media.audio.includes(f) ? "audio" : (media.images.includes(f) ? "image" : "attachment"),
            downloaded: false,
          })),
          ...externalFiles
        ];

        return {
          id: `post_${post.id}`,
          creatorId: `campaign_${campaignId}`,
          title: finalAttrs.title || "(ohne Titel)",
          text: stripHtml(finalAttrs.content) || extractTextFromJsonDoc(finalAttrs.content_json_string) || finalAttrs.content_teaser_text || finalAttrs.teaser_text || finalAttrs.cleaned_teaser_text || "",
          publishedAt: finalAttrs.published_at || null,
          url: finalAttrs.url || `https://www.patreon.com/posts/${post.id}`,
          postType: finalAttrs.post_type || "unbekannt",
          locked: finalAttrs.current_user_can_view === false,
          commentCount: finalAttrs.comment_count || 0,
          thumbnail: media.thumbnail,
          video: media.video,
          files: postFiles
        };
      });

      if (fetchSizes) {
        const urlsToFetch = [];
        for (const post of posts) {
          if (post.locked) continue;
          for (const file of post.files) {
            if (!file.sizeBytes && file.url) {
              urlsToFetch.push(file.url);
            }
          }
          if (post.video && post.video.type === "native" && !post.video.sizeBytes && post.video.url) {
            urlsToFetch.push(post.video.url);
          }
          if (post.thumbnail && !post.thumbnail.sizeBytes && post.thumbnail.url) {
            urlsToFetch.push(post.thumbnail.url);
          }
        }

        if (urlsToFetch.length > 0) {
          try {
            const response = await new Promise((resolve) => {
              chrome.runtime.sendMessage(
                { type: "FETCH_FILE_SIZES", urls: urlsToFetch },
                (res) => resolve(res || {})
              );
            });
            if (response && response.ok && response.sizes) {
              for (const post of posts) {
                if (post.locked) continue;
                for (const file of post.files) {
                  if (response.sizes[file.url]) {
                    file.sizeBytes = response.sizes[file.url];
                  }
                }
                if (post.video && post.video.type === "native" && post.video.url) {
                  if (response.sizes[post.video.url]) {
                    post.video.sizeBytes = response.sizes[post.video.url];
                  }
                }
                if (post.thumbnail && post.thumbnail.url && response.sizes[post.thumbnail.url]) {
                  post.thumbnail.sizeBytes = response.sizes[post.thumbnail.url];
                }
              }
            }
          } catch (err) {
            console.warn("[Patreon Archiv-Manager] Fehler beim Abrufen der Dateigrößen über Background-Worker", err);
          }
        }
      }

      yield posts;
      url = data.links?.next || null;
    }
  }

  async function startScan() {
    if (scanning) return;
    scanning = true;
    scanCancelRequested = false;
    resetPseudoProgress();
    const btn = container.querySelector("#pa-scan-btn");
    if (btn) {
      btn.disabled = false;
      btn.textContent = "Cancel scan";
      btn.classList.add("pa-cancel");
    }

    let campaign = null;
    let creatorExistedBefore = false;
    const scannedPostsBuffer = [];
    paLog("info", `Scan started on ${location.href}`);

    try {
      setStatus(L("panelSearching"), { indeterminate: true });
      campaign = await resolveCampaign();
      if (scanCancelRequested) throw new Error("scan_cancelled");

      const creatorId = `campaign_${campaign.id}`;
      const existingCreatorsRes = await new Promise((resolve) => {
        chrome.runtime.sendMessage({ type: "GET_CREATORS" }, (res) => resolve(res || {}));
      });
      creatorExistedBefore = (existingCreatorsRes.creators || []).some((c) => c.id === creatorId);

      let membership = null;
      try {
        membership = await fetchMembership(campaign.id);
      } catch (err) {
        console.warn("[Patreon Archiv-Manager]", err);
      }
      if (scanCancelRequested) throw new Error("scan_cancelled");

      const settingsResult = await new Promise((resolve) => {
        chrome.runtime.sendMessage({ type: "GET_SETTINGS" }, (res) => resolve(res || {}));
      });
      const fetchSizes = settingsResult.settings?.fetchSizesDuringScan === true;

      setStatus(L("panelScanning", campaign.name), { indeterminate: true });
      let total = 0;
      let lockedCount = 0;
      let knownTotal = null;

      for await (const batch of iteratePosts(campaign.id, fetchSizes, (t) => (knownTotal = t))) {
        if (scanCancelRequested) throw new Error("scan_cancelled");
        total += batch.length;
        lockedCount += batch.filter((p) => p.locked).length;
        scannedPostsBuffer.push(...batch);

        if (scanCancelRequested) throw new Error("scan_cancelled");

        if (knownTotal) {
          const pct = Math.min(98, Math.round((total / knownTotal) * 100));
          setStatus(L("panelScanningCount", total, knownTotal) + ` (${pct}%)`, {
            progress: pct,
          });
        } else {
          setStatus(L("panelScanningCount", total, null), { indeterminate: true });
        }
      }

      if (scanCancelRequested) {
        throw new Error("scan_cancelled");
      }

      // Erst nach 100% erfolgreichem Scan in die Datenbank schreiben (Transaktions-Buffer)
      await new Promise((resolve) => {
        chrome.runtime.sendMessage(
          {
            type: "UPSERT_CREATOR",
            creator: {
              id: creatorId,
              name: campaign.name,
              url: campaign.url,
              avatarUrl: campaign.avatarUrl,
              membership,
            },
          },
          () => resolve()
        );
      });

      if (scannedPostsBuffer.length > 0) {
        await new Promise((resolve) => {
          chrome.runtime.sendMessage({ type: "UPSERT_POSTS", posts: scannedPostsBuffer }, () => resolve());
        });
      }

      if (total === 0) setStatus(L("panelDoneNoPosts"), { progress: 0 });
      else if (lockedCount === total) setStatus(L("panelDoneNoMember", total), { progress: 100 });
      else if (lockedCount > 0) setStatus(L("panelDonePartial", total, lockedCount), { progress: 100 });
      else setStatus(L("panelDoneAll", total), { progress: 100 });
    } catch (err) {
      if (err.message === "scan_cancelled") {
        if (campaign && !creatorExistedBefore) {
          try {
            await new Promise((resolve) => {
              chrome.runtime.sendMessage(
                { type: "DELETE_CREATOR", creatorId: `campaign_${campaign.id}` },
                () => resolve()
              );
            });
          } catch { /* best-effort */ }
        }
        resetPseudoProgress();
        setStatus("Scan cancelled.", { progress: 0 });
      } else {
        console.error("[Patreon Archiv-Manager]", err);
        paLog("error", `Scan failed: ${err?.message || err}`);
        setStatus(L("panelError", err.message), { progress: 0 });
      }
    } finally {
      const wasCancelled = scanCancelRequested;
      paLog("info", `Scan finished: ${scannedPostsBuffer.length} post(s)${wasCancelled ? " (cancelled by user)" : ""}${campaign ? ` for campaign ${campaign.id}` : ""}`);
      scanning = false;
      scanCancelRequested = false;

      const scanBtn = container.querySelector("#pa-scan-btn");
      const openDashLink = container.querySelector("#pa-open-dash");
      if (scanBtn) {
        scanBtn.classList.remove("pa-cancel");
        scanBtn.disabled = false;
        if (!wasCancelled) {
          scanBtn.textContent = L("panelOpenDashboard");
          scanBtn.onclick = (e) => {
            e.preventDefault();
            try {
              chrome.runtime.sendMessage({
                type: "OPEN_DASHBOARD",
                creatorId: campaign ? `campaign_${campaign.id}` : undefined,
              });
            } catch (err) {
              console.warn("[PatreonArchiver] Extension context updated. Please refresh page.", err);
              alert("The extension was updated in Chrome. Please refresh this page (F5) to continue.");
            }
          };
          if (openDashLink) {
            openDashLink.textContent = L("panelScanAgain");
            openDashLink.onclick = (e) => {
              e.preventDefault();
              renderPanelContents();
              startScan();
            };
          }
        } else {
          scanBtn.textContent = L("panelScanBtn");
          scanBtn.onclick = () => {
            if (scanning) cancelScan();
            else startScan();
          };
        }
      }
    }
  }

  // ---------- Sichtbarkeit steuern ----------

  let extEnabled = true; // wird beim Start aus dem Storage geladen

  const BLOCKLIST = [/^\/login/, /^\/signup/, /^\/settings/, /^\/checkout/, /^\/payment/, /^\/join/];
  function maybeShowPanel() {
    if (!extEnabled) {
      if (container) setPanelState("closed");
      return;
    }
    if (BLOCKLIST.some((re) => re.test(location.pathname))) {
      if (container) setPanelState("closed");
      return;
    }
    // Standardmäßig eingeklappt (nur das kleine Symbol unten rechts) - der
    // Nutzer klickt sich bei Bedarf selbst zum vollen Panel hoch.
    if (panelState === "closed" && closeCount === 0) {
      setPanelState("minimized");
    }
  }

  // Live-Umschaltung aus dem Popup empfangen.
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === "PA_SET_ENABLED") {
      extEnabled = msg.enabled;
      if (!extEnabled) {
        setPanelState("closed");
      } else {
        closeCount = 0; // Zähler zurücksetzen, damit es wieder als Bubble erscheint
        maybeShowPanel();
      }
    }
  });

  (async () => {
    await loadI18n();
    const { paEnabled } = await chrome.storage.local.get("paEnabled");
    extEnabled = paEnabled !== false; // Standard: an
    ensureContainer();
    maybeShowPanel();
    let lastPath = location.pathname;
    setInterval(() => {
      if (location.pathname !== lastPath) {
        lastPath = location.pathname;
        maybeShowPanel();
        renderPanelContents(); // Resets panel buttons and scan state back to original setup
      }
    }, 1000);
    window.addEventListener("beforeunload", (e) => {
      if (scanning) {
        e.preventDefault();
        e.returnValue = "A scan is currently active. If you leave or reload this page, the current progress will be lost. Do you want to proceed?";
      }
    });
  })();
})();
