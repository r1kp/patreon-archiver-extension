import { getLanguage, t } from "../lib/i18n.js";

async function main() {
  const lang = await getLanguage();
  const L = (key, ...args) => t(lang, key, ...args);

  document.title = "Patreon Archiver";
  document.getElementById("appTitle").textContent = "Patreon Archiver";
  document.getElementById("sidebarSub").textContent = "Your Patreon profiles";
  document.getElementById("creatorLabel").textContent = "Profiles";
  document.getElementById("postLabel").textContent = "Posts";
  document.getElementById("fileLabel").textContent = "Files";
  // No hint text here anymore - help lives in the dashboard "?" panel.
  document.getElementById("hint").style.display = "none";
  document.getElementById("openDashboard").textContent = "Open dashboard";

  // On/off toggle for the panel on patreon.com
  const { paEnabled } = await chrome.storage.local.get("paEnabled");
  const enabled = paEnabled !== false; // default: on
  const toggle = document.getElementById("enabledToggle");
  const toggleLabel = document.getElementById("toggleLabel");
  toggle.checked = enabled;
  const setToggleLabel = (on) => {
    toggleLabel.textContent = on ? "Active on Patreon" : "Inactive";
  };
  setToggleLabel(enabled);
  toggle.addEventListener("change", async () => {
    const on = toggle.checked;
    await chrome.storage.local.set({ paEnabled: on });
    setToggleLabel(on);
    // Alle offenen Patreon-Tabs benachrichtigen, damit das Panel sofort
    // erscheint/verschwindet (ohne Neuladen).
    const tabs = await chrome.tabs.query({ url: "https://*.patreon.com/*" });
    tabs.forEach((tab) => {
      chrome.tabs.sendMessage(tab.id, { type: "PA_SET_ENABLED", enabled: on }).catch(() => {});
    });
  });

  const { creators } = await chrome.runtime.sendMessage({ type: "GET_CREATORS" });
  document.getElementById("creatorCount").textContent = creators?.length || 0;

  let postTotal = 0;
  let fileTotal = 0;
  for (const c of creators || []) {
    const { posts } = await chrome.runtime.sendMessage({ type: "GET_POSTS", creatorId: c.id });
    postTotal += posts?.length || 0;
    fileTotal += (posts || []).reduce((sum, p) => sum + (p.files?.length || 0), 0);
  }
  document.getElementById("postCount").textContent = postTotal;
  document.getElementById("fileCount").textContent = fileTotal;

  // Check for bridge updates
  const { latestBridgeVersion, dismissedBridgeVersion, installedBridgeVersion } = await chrome.storage.local.get([
    "latestBridgeVersion",
    "dismissedBridgeVersion",
    "installedBridgeVersion",
  ]);

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

  if (
    latestBridgeVersion &&
    installedBridgeVersion &&
    latestBridgeVersion !== dismissedBridgeVersion &&
    isVersionOlder(installedBridgeVersion, latestBridgeVersion)
  ) {
    const warning = document.getElementById("updateWarning");
    if (warning) {
      warning.style.display = "flex";
      const link = document.getElementById("updateWarningLink");
      if (link) {
        link.addEventListener("click", (e) => {
          e.preventDefault();
          chrome.runtime.sendMessage({ type: "OPEN_DASHBOARD" });
          window.close();
        });
      }
    }
  }

  document.getElementById("openDashboard").addEventListener("click", () => {
    chrome.runtime.sendMessage({ type: "OPEN_DASHBOARD" });
    window.close();
  });
}

main();
