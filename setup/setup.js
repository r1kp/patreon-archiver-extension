import { getLanguage, setLanguage } from "../lib/i18n.js";
import { pingYtDlpHost } from "../lib/nativeHost.js";

const STR = {
  en: {
    heroTitle: "Set up the bridge",
    heroSub: "A quick one-time setup lets the extension save files to any folder and download external videos. After this, everything just works.",
    recheck: "Re-check",
    step1Title: "Download the installer",
    step1Text: "Click the button below to download the setup executable. Save it somewhere convenient.",
    step2Title: "Run the installer",
    step2Text: "Double-click \"PatreonArchiverBridge_Setup.exe\". A wizard opens; select the installation path and click \"Install\". Optionally check \"Download yt-dlp\" to get the video engine. Then fully restart Chrome (close all windows).",
    step2Btn: "Download bridge installer (.exe)",
    step2Note: "Note: If Windows Defender SmartScreen appears, click \"More info\" and then \"Run anyway\" to proceed.",
    step3Title: "Done!",
    step3Text: 'Once the status banner at the top turns green, everything works automatically. Choose a download folder in Settings, then click "Download" on any post. The extension picks the right method on its own.',
    step3Btn: "Back to dashboard",
    stCheck: "Checking...",
    stBad: "Bridge not connected",
    stBadD: "Follow the steps below, then fully restart Chrome.",
    stWarn: "Bridge connected, yt-dlp missing",
    stWarnD: "Open the Bridge Control Center (shortcut on Desktop/Start Menu) and click \"Update yt-dlp\", or install it manually.",
    stOk: "All set, ready to download",
    stOkD: "Nothing else to do. Downloads use this automatically.",
    copied: "Copied!",
  },
  de: {
    heroTitle: "Video-Downloads einrichten",
    heroSub: "Eine kurze einmalige Einrichtung erlaubt der Extension, externe Videos (YouTube/Vimeo) herunterzuladen und in jeden Ordner zu speichern.",
    recheck: "Erneut prüfen",
    step1Title: "Installer herunterladen",
    step1Text: "Klicke auf den Button unten, um die Setup-Datei herunterzuladen. Speichere sie an einem beliebigen Ort.",
    step2Title: "Installer ausführen",
    step2Text: "Doppelklicke auf \"PatreonArchiverBridge_Setup.exe\". Ein Assistent öffnet sich; wähle den Installationspfad und klicke auf \"Install\". Hake optional \"Download yt-dlp\" an. Starte danach Chrome komplett neu (alle Fenster schließen).",
    step2Btn: "Brücken-Installer herunterladen (.exe)",
    step2Note: "Hinweis: Falls Windows Defender (SmartScreen) warnt, klicke einfach auf \"Weitere Informationen\" und dann auf \"Trotzdem ausführen\".",
    step3Title: "Fertig!",
    step3Text: 'Sobald das Status-Banner oben grün wird, läuft alles automatisch. Wähle einen Ordner in den Einstellungen und klicke bei einem Post auf "Download". Die Extension wählt selbst die richtige Methode.',
    step3Btn: "Zurück zum Dashboard",
    stCheck: "Prüfe...",
    stBad: "Brücke nicht verbunden",
    stBadD: "Folge Schritt 1 und 2 unten, dann Chrome neu starten.",
    stWarn: "Brücke verbunden, yt-dlp fehlt",
    stWarnD: "Öffne das Brücken-Kontrollzentrum (Verknüpfung auf Desktop/Startmenü) und klicke auf \"Update yt-dlp\".",
    stOk: "Alles bereit, Videos können geladen werden",
    stOkD: "Nichts weiter zu tun. Downloads nutzen das automatisch.",
    copied: "Kopiert!",
  },
};

let lang = "en";
const $ = (id) => document.getElementById(id);

function applyLang() {
  const s = STR[lang];
  document.querySelectorAll("[data-i18n]").forEach((el) => {
    const key = el.getAttribute("data-i18n");
    if (s[key]) el.textContent = s[key];
  });
}

let firstCheck = true;
async function checkStatus() {
  const s = STR[lang];
  if (firstCheck) {
    $("statusTitle").textContent = s.stCheck;
    $("statusDetail").textContent = "";
    $("statusDot").className = "status-dot";
    $("connectionViz").className = "connection-viz status-bad";
  }

  const ping = await pingYtDlpHost().catch(() => ({ ok: false }));
  firstCheck = false;
  $("statusDot").className = "status-dot";
  const viz = $("connectionViz");
  viz.className = "connection-viz";

  if (!ping.ok) {
    $("statusDot").classList.add("bad");
    $("statusTitle").textContent = s.stBad;
    $("statusDetail").textContent = s.stBadD;
    viz.classList.add("status-bad");
  } else if (!ping.ytdlpFound) {
    $("statusDot").classList.add("warn");
    $("statusTitle").textContent = s.stWarn;
    $("statusDetail").textContent = s.stWarnD;
    viz.classList.add("status-warn");
  } else {
    $("statusDot").classList.add("ok");
    $("statusTitle").textContent = s.stOk;
    $("statusDetail").textContent = s.stOkD;
    viz.classList.add("status-ok");
  }
}

const GITHUB_RELEASE_DOWNLOAD_URL = "https://github.com/r1kp/patreon-archiver-bridge/releases/latest/download/PatreonArchiverBridge_setup.exe";

$("dlBridgeBtn").addEventListener("click", () => {
  chrome.tabs.create({ url: GITHUB_RELEASE_DOWNLOAD_URL });
});

$("recheckBtn").addEventListener("click", checkStatus);
$("backBtn").addEventListener("click", () => {
  // Reuses background.js's openDashboard(), which focuses an already-open
  // dashboard tab instead of always creating a new one.
  chrome.runtime.sendMessage({ type: "OPEN_DASHBOARD" });
  window.close();
});

(async () => {
  lang = "en";
  applyLang();
  checkStatus();
  setInterval(checkStatus, 6000);
})();
